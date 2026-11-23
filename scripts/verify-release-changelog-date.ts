/**
 * Proves an untagged release's changelog heading comes from the calendar
 * version rather than from the clock, and that every generator invocation in
 * this package asks for that.
 *
 * Why this exists separately from `npm run changelog:check`: that script only
 * exercises the `package.json` invocation. `.github/workflows/release.yml`
 * calls the generator directly. If either side lost `--date-from-version` the
 * two would disagree during a release -- one heading derived from the clock,
 * the other from the version -- and the release would fail on the divergence
 * rather than on the stale date the flag exists to remove.
 *
 * When the version day differs from the expected squash commit day, the
 * release commit pins `--date-fallback <ISO day>` in place of
 * `--date-from-version` while the version is pending. The pinned day is as clock-free as the flag it
 * replaces -- it stays fixed in the committed script -- so the scan accepts
 * either spelling, and rejects `--date-fallback` without an explicit day
 * because that would silently fall back to the clock, and rejects a pinned
 * day that does not exist on the calendar because a heading dated
 * `2026-02-30` proves the pin was never checked against one.
 *
 * The analysis is separated from the I/O so the rules below are executed by the
 * test suite against fixtures rather than only against this repository, which
 * happens to satisfy them.
 *
 * @packageDocumentation
 */
import { readRegularText } from "../regular-input.ts";
import { execFileSync } from "../subprocess.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isMap, isScalar, LineCounter, parseDocument, type YAMLMap } from "yaml";
import {
  type ShellCommand,
  type ShellToken,
  type SourceFile,
  type VerifierResult,
} from "./shell-command-scan.ts";
import { isMainInvocation } from "./main-invocation.ts";
import { tallyFlaggedInvocations } from "../invocation-audit.ts";
import { executableShellBodies } from "../attestation.ts";
import { assertAllTagsCutoff, canReachGenerator, hasVersionInput, generatedWriterProblem, changelogArguments, DATE_FLAG, FALLBACK_DATE_FLAG, readReleaseDateOptions, needsReleaseProject, npmLifecycle, visitChangelogScriptCommands, type WorkflowReleaseStep } from "../release-changelog-options.ts";

import { describeReleaseContextChange, parseReleaseHook, refuseHook } from "../release-hook-grammar.ts";
import { releaseHookConstructProblem } from "../shell-scan.ts";
import { describeUnsupportedReleaseHook } from "../release-shell-constructs.ts";

export { DATE_FLAG, VERSION_INPUTS, isRealCalendarDay } from "../release-changelog-options.ts";

/** One generator invocation found in a tracked file. */
export interface Invocation {
  /** File the invocation was found in. */
  file: string;
  /** The starting line in the source file, when available. */
  line?: number;
  /** The package script that supplies this command. */
  script?: string;
  /** The source command, with arrays expanded. */
  command: string;
  /** The generator's shell arguments, with quoting removed. */
  args: ShellToken[];
  /** The command or its option words could not be resolved. */
  problem?: string;
  /** The parsed heading-date policies on the invocation. */
  options: ReturnType<typeof readReleaseDateOptions>;
}

/**
 * Drop an unquoted trailing comment from one command.
 *
 * A `#` inside quotes is an argument -- these invocations pass URLs containing
 * one -- while an unquoted `#` starts a comment the shell never runs. Without
 * this, a comment is part of the command as far as a substring check is
 * concerned, and `... --release-version-from-package  # --date-from-version`
 * satisfies the very check it is complaining about.
 *
 * @param command - One logical command.
 * @returns The command with any unquoted trailing comment removed.
 */
export function stripComment(command: string): string {
  let single = false;
  let double = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "\\") { index += 1; continue; }
    if (character === "'" && !double) single = !single;
    else if (character === '"' && !single) double = !double;
    else if (character === "#" && !single && !double && (index === 0 || /\s/.test(command[index - 1]))) {
      return command.slice(0, index);
    }
  }
  return command;
}

/**
 * Find every generator invocation in one file's contents.
 *
 * An invocation is a logical command that runs the generator -- by binary name,
 * or as the built `dist/cli.js` in pm-changelog's own repository -- and carries
 * at least one version input. Comment lines are excluded: a file may describe
 * these flags without running anything, and holding prose to the rule is a
 * false positive that trains people to weaken the gate.
 *
 * @param source - The file's path and contents.
 * @returns The invocations found, in file order.
 */
export function invocationsIn(source: SourceFile): Invocation[] {
  return invocationsAcross([source]);
}

/** Decode script bodies before shell parsing, retaining the owning file for diagnostics. */
function manifestScripts(source: SourceFile): Map<string, { text: string; line?: number }> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(source.text);
  } catch (error) {
    throw new Error(`${source.file}: invalid JSON`, { cause: error });
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${source.file}: manifest must be an object`);
  }
  const { scripts = {} } = manifest as { scripts?: unknown };
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new Error(`${source.file}: scripts must be an object`);
  }
  const lines = new LineCounter();
  const { contents } = parseDocument<YAMLMap>(source.text, { schema: "json", uniqueKeys: false, lineCounter: lines });
  // JSON.parse already proved the root is a map and retains the last duplicate key.
  const scriptMap = contents!.items.slice().reverse().find(({ key }) => isScalar(key) && key.value === "scripts")?.value;
  const locations = new Map<string, number>();
  if (isMap(scriptMap)) {
    for (const { key } of scriptMap.items) {
      if (isScalar(key) && typeof key.value === "string" && key.range) locations.set(key.value, lines.linePos(key.range[0]).line);
    }
  }
  return new Map(Object.entries(scripts).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string" && entry[1].trim() !== "")
    .map(([name, text]) => [name, { text, line: locations.get(name) }]));
}

/** Reusable release hook inputs and their standalone root-manifest defaults. */
const HOOK_INPUTS = [
  ["changelog-script", "changelog:full"],
  ["changelog-check-script", "changelog:check"],
  ["notes-script", "release:notes"],
] as const;

/** A root project can be omitted or spelled with only current-directory components. */
function isRootProject(directory: unknown): boolean {
  return directory === undefined || (typeof directory === "string" && /^(?:\.\/+)*\.?$/.test(directory));
}

/** A named path component stays nested because the workflow rejects parent-directory components. */
function maySelectRootProject(directory: unknown): boolean {
  if (typeof directory !== "string") return isRootProject(directory);
  const [prefix, ...remaining] = directory.split(/\$\{\{(?:'[^']*'|[^'}])*\}\}/);
  return isRootProject(prefix) && remaining.every(part => !/[^./]|\.\./.test(part));
}

/** Include literal root hooks and report unresolved selectors at their workflow input. */
function addConfiguredHooks(
  source: SourceFile, entries: Set<string>, explicit: Array<{ name: string; input: string; source: Invocation }>, found: Invocation[],
): void {
  const lines = new LineCounter();
  const document = parseDocument(source.text, { lineCounter: lines });
  if (document.errors[0]) throw document.errors[0];
  const workflow = document.toJS() as { jobs?: Record<string, { if?: unknown; uses?: string; with?: Record<string, unknown> } | null> } | null;
  for (const [id, job] of Object.entries(workflow?.jobs ?? {})) {
    if (job?.if === false) continue;
    if (typeof job?.uses !== "string" || !/(?:^|\/)\.github\/workflows\/daily-release\.ya?ml(?:@[^\s]+)?$/.test(job.uses)) continue;
    if (job.with?.rust === true || job.with?.["release-enabled"] === false) continue;
    if (!maySelectRootProject(job.with?.["npm-project-dir"])) continue;
    for (const [input, defaultName] of HOOK_INPUTS) {
      if (!job.with || !Object.hasOwn(job.with, input)) {
        entries.add(defaultName);
        continue;
      }
      const name = job.with[input];
      const inputNode = document.getIn(["jobs", id, "with", input], true);
      const selector: Invocation = {
        file: source.file,
        line: isScalar(inputNode) && inputNode.range ? lines.linePos(inputNode.range[0]).line : undefined,
        command: JSON.stringify(name), args: [], options: [],
      };
      if (typeof name === "string" && /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/.test(name)) {
        explicit.push({ name, input, source: selector });
      } else found.push({
        ...selector, problem: describeUnsupportedReleaseHook("unresolved selector (use a literal script name)", input),
      });
    }
  }
}

/** Flag a nested workflow command without following its forwards into the root manifest. */
function inspectProjectStep(file: string, text: string, line: number, directory: unknown): Invocation[] {
  const { commands, spans, heredocBodies } = parseReleaseHook(text, "workflow");
  const construct = releaseHookConstructProblem(commands, text, spans, file + ":" + line, "workflow", words => canReachGenerator(words));
  if (construct) {
    return inspectCommand(construct.words, { file, line, command: text }, new Set(), construct.problem);
  }
  const written = new Set<string>();
  const words = commands.find(command => generatedWriterProblem(command, written, heredocBodies.get(command)) || needsReleaseProject(command));
  if (!words) return [];
  return inspectCommand(words, {
    file, line, command: text.slice(spans.get(words[0])!.start, spans.get(words.at(-1)!)!.end),
  }, new Set(), describeReleaseContextChange(`working-directory ${JSON.stringify(directory)}`));
}

/** Workflow forwards and manifest forwards share the same effective argument graph. */
function invocationsAcross(sources: SourceFile[]): Invocation[] {
  const scripts = new Map<string, string>();
  const origins = new Map<string, Pick<Invocation, "file" | "line" | "script">>();
  const projectConfig = sources.find(source => source.file === ".npmrc")?.text;
  const workflowSteps = new Map<string, WorkflowReleaseStep>();
  const found: Invocation[] = [];
  const projectEntryPoints = new Set<string>();
  const explicit: Array<{ name: string; input: string; source: Invocation }> = [];
  for (const source of sources) {
    if (source.file === ".npmrc") continue;
    if (source.file === "package.json") {
      for (const [name, { text, line }] of manifestScripts(source)) {
        scripts.set(name, text);
        origins.set(name, { file: source.file, line, script: name });
      }
    } else {
      if (/^\.github\/workflows\/.*\.ya?ml$/.test(source.file)) addConfiguredHooks(source, projectEntryPoints, explicit, found);
      for (const { text, line, workingDirectory, environment, disabled, containerJob } of executableShellBodies(source)) {
        if (disabled) continue;
        if (!isRootProject(workingDirectory) && containerJob === undefined) {
          found.push(...inspectProjectStep(source.file, text, line, workingDirectory));
          continue;
        }
        const key = "\0run" + origins.size;
        origins.set(key, { file: source.file, line });
        scripts.set(key, text);
        workflowSteps.set(key, {
          label: source.file + ":" + line,
          containerJob,
          lifecycle: {
            active: npmLifecycle(projectConfig, environment),
            configured: npmLifecycle(projectConfig, { ...environment, npm_config_ignore_scripts: "" }),
          },
        });
      }
    }
  }
  for (const selector of explicit) {
    const { name, input, source } = selector;
    if (scripts.has(name)) projectEntryPoints.add(name);
    else found.push({ ...source, problem: describeUnsupportedReleaseHook(`missing or blank root script ${JSON.stringify(name)} selected by ${input}`, name) });
  }
  const entryPoints = new Set([...HOOK_INPUTS.map(([, name]) => name), ...projectEntryPoints]);
  visitChangelogScriptCommands(scripts, ({ name, names, text, words, effective, spans, contextProblem, configuredHook }) => {
    const first = spans.get(words[0])!.start;
    const last = spans.get(words.at(-1)!)!.end;
    found.push(...inspectCommand(effective, { ...origins.get(name)!, command: text.slice(first, last) }, names, contextProblem, configuredHook));
  }, undefined, undefined, entryPoints, { lifecycle: npmLifecycle(projectConfig), workflowSteps, projectEntryPoints });
  return found;
}

/** Extract the date policy and retain any diagnostic for this command. */
function inspectCommand(words: ShellCommand, source: Pick<Invocation, "file" | "line" | "script" | "command">, scriptNames: ReadonlySet<string>, contextProblem?: string, configuredHook = false): Invocation[] {
  try {
    if (contextProblem) refuseHook(contextProblem);
    const args = changelogArguments(words, scriptNames, source.script ?? source.file);
    if (args === undefined) return [];
    if (configuredHook) assertAllTagsCutoff(args);
    if (!hasVersionInput(args)) return [];
    const options = readReleaseDateOptions(args);
    return [{ ...source, args, options }];
  } catch (error) {
    return [{ ...source, args: [], options: [], problem: (error as Error).message }];
  }
}

/**
 * Audit every generator invocation across the given files.
 *
 * Judged per invocation rather than by counting: counting matching lines misses
 * a line holding several invocations where only one is flagged, and counting
 * occurrences file-wide lets an unflagged invocation hide behind a mention of
 * the flag on a line that invokes nothing at all.
 *
 * @param sources - The tracked files to scan.
 * @returns Failures and per-file notes.
 */
export function auditInvocations(sources: SourceFile[]): VerifierResult {
  const invocations = invocationsAcross(sources);
  return tallyFlaggedInvocations(
    invocations,
    ({ file, line, script, command, options, problem }) => {
      let location = [file, line].filter(part => part !== undefined).join(":");
      if (script !== undefined) location += ` (script ${JSON.stringify(script)})`;
      const excerpt = command.trim().slice(0, 160);
      if (problem !== undefined) return `${location}: ${problem}: ${excerpt}`;
      let hasPolicy = false;
      for (const option of options) {
        if (option.kind === "missing-day") {
          return `${location}: every ${FALLBACK_DATE_FLAG} must pin an explicit YYYY-MM-DD day: ${excerpt}`;
        }
        if (option.kind === "invalid-day") {
          return `${location}: a pinned ${FALLBACK_DATE_FLAG} day does not exist on the calendar (${option.day}): ${excerpt}`;
        }
        hasPolicy = true;
      }
      if (hasPolicy) return null;
      return `${location}: a generator invocation carries a version input but neither ${DATE_FLAG} nor a pinned ${FALLBACK_DATE_FLAG} day: ${excerpt}`;
    },
    {
      noun: "generator",
      flag: `a release date policy (${DATE_FLAG} or a pinned ${FALLBACK_DATE_FLAG} day)`,
      emptyScan: "no generator invocation was found in any tracked file - the scan is looking in the wrong place",
    },
  );
}

/** A generator run's first `## ` heading, or why there was none. */
export interface HeadingResult {
  /** Whether the run produced a heading at all. */
  ok: boolean;
  /** The heading, or a description of the failure. */
  text: string;
}

/**
 * Compare the flagged and unflagged headings for one probe version.
 *
 * The unflagged run is the control: it is what proves the flag is doing the
 * work rather than the heading happening to be right for another reason. A
 * control that failed to run leaves the comparison unmade, so its failure is a
 * failure here -- it was previously suppressed with `|| true` and downgraded to
 * a note, letting the script exit zero having proved nothing.
 *
 * @param probe - Probe version, deliberately not today's date.
 * @param today - Today's date as `YYYY-MM-DD`.
 * @param generate - Runs the generator; `flagged` selects `--date-from-version`.
 * @returns Failures and notes for the behavioural half.
 */
export function auditHeadings(
  probe: string,
  today: string,
  generate: (flagged: boolean) => HeadingResult,
): VerifierResult {
  const expected = `## ${probe} - ${probe.replace(/^(\d{4})\.(\d{1,2})\.(\d{1,2}).*$/, (_all, y: string, m: string, d: string) =>
    `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`)}`;
  const todayHeading = `## ${probe} - ${today}`;
  const failures: string[] = [];
  const notes: string[] = [];

  const flagged = generate(true);
  if (!flagged.ok) failures.push(`with ${DATE_FLAG}, ${flagged.text}`);
  else if (flagged.text !== expected) failures.push(`with ${DATE_FLAG} expected '${expected}', got '${flagged.text}'`);
  else notes.push(`ok - with the flag the heading is version-derived: ${flagged.text}`);

  const control = generate(false);
  if (!control.ok) failures.push(`without ${DATE_FLAG}, ${control.text}, so the comparison proves nothing`);
  else if (control.text === flagged.text) {
    failures.push(
      `the heading is '${control.text}' with and without ${DATE_FLAG} - the flag is changing nothing, so`
      + " nothing here proves the date is version-derived",
    );
  } else {
    // What must hold is that the flag CHANGES the outcome. Asserting the
    // control equals today's date instead would pin the generator's current
    // default, so a compatible dependency update that changed it would fail
    // this gate for no defect; and today's date is sampled once for two
    // subprocess runs, so a run crossing UTC midnight would fail for no defect
    // either. Whether the control happens to be the clock is reported, not
    // required.
    const derivation = control.text === todayHeading ? "clock-derived" : "derived some other way";
    notes.push(`ok - the flag changes the heading: '${flagged.text}' with it, '${control.text}' without (${derivation})`);
  }

  return { failures, notes };
}

/**
 * Resolve the generator this repository should run.
 *
 * In pm-changelog's own repository the generator is the build output rather
 * than a dependency, so resolve in that order instead of assuming node_modules.
 *
 * @param root - Repository root.
 * @returns The executable and any leading arguments.
 */
export function resolveGenerator(root: string): { bin: string; lead: string[] } {
  const local = resolve(root, "node_modules/.bin/pm-changelog");
  if (existsSync(local)) return { bin: local, lead: [] };
  const built = resolve(root, "dist/cli.js");
  if (existsSync(built)) return { bin: process.execPath, lead: [built] };
  return { bin: "npx", lead: ["pm-changelog"] };
}

/**
 * Run the generator once and return its first `## ` heading.
 *
 * A run that fails is reported as a failed run rather than as an absent
 * heading, because the two have different remedies and conflating them is how
 * a broken generator reads as a passing gate.
 *
 * @param bin - Executable to run.
 * @param args - Arguments to pass.
 * @param cwd - Directory to run in.
 * @returns The heading, or why there was none.
 */
export function generateHeading(bin: string, args: string[], cwd: string): HeadingResult {
  try {
    const out = execFileSync(bin, args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
    const line = out.split("\n").find((candidate) => candidate.startsWith("## "));
    return line === undefined ? { ok: false, text: "the run produced no '## ' heading" } : { ok: true, text: line };
  } catch (error) {
    return { ok: false, text: `the run failed: ${(error as Error).message.split("\n")[0]}` };
  }
}

/**
 * Run both halves of the verifier against a real checkout.
 *
 * @param root - Repository root to verify.
 * @param today - Today's date as `YYYY-MM-DD`.
 * @returns Failures and notes from both halves.
 */
export function verify(root: string, today: string): VerifierResult {
  const tracked = execFileSync(
    "git",
    ["ls-files", "--", "package.json", ".npmrc", ".github/workflows/*.yml", ".github/workflows/*.yaml"],
    { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  )
    .trimEnd()
    .split("\n")
    .filter((file) => file.length > 0 && existsSync(resolve(root, file)));
  const sources = tracked.map((file) => ({ file, text: readRegularText(resolve(root, file)) }));
  const statics = auditInvocations(sources);

  const probe = "2026.1.2";
  const { bin, lead } = resolveGenerator(root);
  // The generator refuses a truncated workspace read rather than silently
  // omitting entries, so the unbounded controls the real scripts pass are
  // required here too.
  const common = [
    ...lead,
    "--pm-root", ".agents/pm",
    "--stdout",
    "--pm-bin", "./node_modules/.bin/pm",
    "--pm-arg=--output-budget", "--pm-arg=unbounded",
    "--pm-arg=--output-limit", "--pm-arg=unbounded",
    "--release-version", probe,
  ];
  const behavioural = auditHeadings(probe, today, (flagged) =>
    generateHeading(bin, flagged ? [...common, DATE_FLAG] : common, root));

  return {
    failures: [...statics.failures, ...behavioural.failures],
    notes: [...statics.notes, ...behavioural.notes],
  };
}

/**
 * Report a verifier result on the process streams and set the exit code.
 *
 * @param result - The result to report.
 */
export function report(result: VerifierResult): void {
  for (const note of result.notes) process.stdout.write(`${note}\n`);
  for (const failure of result.failures) process.stderr.write(`FAIL: ${failure}\n`);
  process.exitCode = result.failures.length === 0 ? 0 : 1;
}

/**
 * Verify this repository and report the result.
 *
 * @param root - Repository root to verify.
 * @param today - Today's date as `YYYY-MM-DD`.
 */
export function main(root: string, today: string): void {
  report(verify(root, today));
}

/**
 * Verify and report, but only when this module is the process entry point.
 *
 * The guard is a function rather than a bare `if` at module scope so the suite
 * can execute both answers. A bare `if` leaves its own body unreachable from
 * any in-process test, which is how an entry point quietly stops running.
 *
 * @param argv - The process argv to judge.
 * @param moduleUrl - This module's `import.meta.url`.
 * @param root - Repository root to verify.
 * @param today - Today's date as `YYYY-MM-DD`.
 * @returns True when the verifier ran.
 */
export function runIfMain(argv: string[], moduleUrl: string, root: string, today: string): boolean {
  if (!isMainInvocation(argv, moduleUrl)) return false;
  main(root, today);
  return true;
}

// Run only as main, so the suite can import the rules above and execute them
// against fixtures rather than only against this repository.
runIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."), new Date().toISOString().slice(0, 10));

/**
 * Proves this package has no publish path that omits `--provenance`.
 *
 * The release step used to fall back to `npm publish` without the flag after
 * three failed provenance attempts, reporting success and leaving only a
 * warning annotation. That makes a transient registry failure downgrade the
 * published artifact's supply-chain attestation permanently for that version,
 * and consumers cannot tell such a publish apart from one that never had
 * provenance at all. An unattested publish is not a degraded success; it is a
 * different artifact.
 *
 * A workflow edit is easy to make and easy to lose, so the contract is executed
 * rather than assumed: every `npm publish` this repository can run is found and
 * required to carry the flag. The analysis is separated from the I/O so the
 * rules are driven by the suite against fixtures rather than only against this
 * repository, which happens to satisfy them.
 *
 * @packageDocumentation
 */
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { resolve } from "node:path";

import {
  bashArrays,
  blockDepthChange,
  caseDepthChange,
  commandArguments,
  commandCandidates,
  commandName,
  expandArrays,
  expandScalars,
  heredocBodyLines,
  heredocExpansionLines,
  joinContinuations,
  literalScalarAssignments,
  segmentShellLine,
  type ShellCommand,
  type SourceFile,
  startsCaseArm,
  tokenizeCommands,
  unsetNames,
  type VerifierResult,
} from "./shell-scan.ts";

/** The flag that attaches a build attestation to the published tarball. */
export const ATTESTATION_FLAG = "--provenance";

/** Whether the auditor recognized any publish command at all. */
export type PublishRecognition =
  | { readonly kind: "none" }
  | { readonly kind: "recognized"; readonly count: number };

/** Publish-attestation outcome with non-vacuity preserved as structured data. */
export interface PublishAttestationResult extends VerifierResult {
  /** Recognition cannot be inferred from an empty failure list. */
  readonly recognition: PublishRecognition;
}

/** One publish invocation found in a tracked file. */
export interface PublishInvocation {
  /** File the invocation was found in. */
  file: string;
  /** The program the invocation runs, reduced to its basename. */
  program: string;
  /** The invocation's tokens, quoting resolved. */
  command: ShellCommand;
}

/** Publishers other than npm, which this repository has no attested path for. */
export const FOREIGN_PUBLISHERS = new Set(["yarn", "pnpm", "bun"]);

/** Repository subtrees whose contents are build output rather than a publish path. */
const GENERATED_PREFIXES = ["dist/", "coverage/", "node_modules/", ".agents/pm/runtime/"];

/** Tracked paths that can execute a command, matched against the repository-relative path. */
const EXECUTABLE_PATHS = [
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /(^|\/)package\.json$/,
  /\.(sh|bash|zsh|ksh)$/,
  /(^|\/)(Makefile|makefile|GNUmakefile)$/,
  /\.mk$/,
  /(^|\/)Dockerfile([.-][^/]*)?$/,
  /(^|\/)docker-compose([.-][^/]*)?\.ya?ml$/,
];

/**
 * Yield the command text held inside a package manifest.
 *
 * A manifest is JSON, so its script bodies are string values rather than lines
 * of shell. Handing the raw file to a shell tokeniser would read the JSON
 * punctuation as commands and the script bodies as quoted words. Parsing the
 * manifest and returning the bodies restores them to the shape the scanner
 * expects, which matters because a publish moved into an npm script is entirely
 * real and would otherwise be invisible to this gate.
 *
 * A manifest that will not parse yields nothing rather than throwing, so a
 * malformed sibling file cannot take the gate down; the manifest's own tooling
 * reports that far better than a publish audit can.
 *
 * @param text - The manifest's contents.
 * @returns Each script body in manifest order.
 */
function manifestCommandBodies(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return [];
  return Object.values(scripts as Record<string, unknown>)
    .filter((value): value is string => typeof value === "string");
}

/**
 * Join manifest script bodies for legacy text consumers without continuations.
 *
 * The auditor itself analyzes each returned body in a fresh scope; this text
 * form remains for callers that need the earlier newline-joined contract.
 *
 * @param text - The manifest's contents.
 * @returns One sanitized line per script body, newline joined.
 */
export function manifestCommandLines(text: string): string {
  // Preserve the text-returning compatibility contract while ensuring a body
  // cannot continue into the next one when callers tokenize the joined result.
  return manifestCommandBodies(text)
    .map((value) => value.replace(/\\+$/, ""))
    .join("\n");
}

/** Subcommands that run something else, so a later `publish` word is its argument. */
// npm's runner subcommands, which take a script or package name rather than
// publishing. `workspace` is deliberately absent: it is not a subcommand at all
// -- npm selects a workspace with the `-w`/`--workspace` FLAG -- and listing it
// here only meant that a `publish` written after the word was never audited.
const RUNNER_SUBCOMMANDS = new Set(["run", "run-script", "exec", "explore", "x"]);

/**
 * npm flags that consume the word after them.
 *
 * Their values sit where a subcommand would, so a value that happens to spell a
 * runner word (`npm --tag run publish`) otherwise reads as `npm run` and the
 * publish beside it is discarded. Joined forms (`--tag=run`) need no entry,
 * because they are one word.
 */
const VALUE_TAKING_FLAGS = new Set([
  "--tag", "--access", "--registry", "--otp", "--workspace", "-w",
  "--userconfig", "--globalconfig", "--cache", "--prefix", "--loglevel",
  "--provenance-file", "--auth-type", "--before", "--omit", "--include",
]);

/**
 * Decide whether one command is a direct `npm publish`.
 *
 * `publish` does not have to follow `npm` immediately: npm accepts its
 * configuration flags anywhere on the line, so `npm --access public publish` is
 * a real publish that an adjacency test discards silently, leaving an attested
 * sibling elsewhere in the file to carry the audit to a pass.
 *
 * Reading the first non-flag word as the subcommand does not work either,
 * because npm has flags that take a separate value (`--access public`) and
 * flags that do not (`--ignore-scripts`), and telling them apart needs npm's
 * own option table. So the word is looked for anywhere in the arguments, and
 * only a preceding runner subcommand rules it out -- `npm run publish` runs a
 * package script whose body is scanned from the manifest, and requiring the
 * flag on the runner would report a defect that is not there.
 *
 * The residual imprecision is `npm --tag publish ...`, a dist-tag named after
 * the subcommand, which this reads as a publish. That direction is deliberate:
 * a false positive is a report line to argue with, a false negative is an
 * unattested artifact on the registry.
 *
 * The program is checked in command position by the caller, so `echo npm
 * publish` and `notnpm publish` never reach here.
 *
 * @param command - One simple command's tokens.
 * @returns True when the command publishes.
 */
export function isPublishCommand(command: ShellCommand): boolean {
  const args = commandArguments(command);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    // A flag's separate value is not the subcommand. `npm --tag run publish`
    // configures the tag as "run" and publishes; reading `run` as a runner
    // subcommand discarded a real publish and let an attested sibling carry the
    // audit. Only npm's own value-taking flags are skipped, so an unknown flag
    // still leaves its value in subcommand position rather than being ignored.
    if (VALUE_TAKING_FLAGS.has(token.value)) { index += 1; continue; }
    if (token.value.startsWith("-")) continue;
    if (RUNNER_SUBCOMMANDS.has(token.value)) return false;
    if (token.value === "publish") return true;
  }
  return false;
}

/**
 * Decide whether one publish command actually enables the attestation.
 *
 * A substring test is not enough. `--provenance=false`, `--provenance false` and
 * `--no-provenance` all contain the flag's spelling and all turn the
 * attestation off, so a containment check accepts precisely the regression this
 * gate exists to catch -- while reporting the file as attested. `--provenance-file`
 * is a different flag entirely and must not be read as this one.
 *
 * Tokens are judged in order and the last one wins, which is how npm resolves a
 * flag given more than once: `--provenance --no-provenance` publishes without an
 * attestation, so this must answer false for it.
 *
 * Quoting is irrelevant to the shell and so is irrelevant here: `npm publish
 * "--provenance"` is attested, and the scan this replaces read it as bare.
 *
 * @param command - One simple command's tokens.
 * @returns True when the command publishes with an attestation.
 */
export function attestationEnabled(command: ShellCommand): boolean {
  const args = commandArguments(command);
  let enabled = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!.value;
    if (token === `--no-${ATTESTATION_FLAG.slice(2)}`) {
      enabled = false;
      continue;
    }
    if (token === ATTESTATION_FLAG) {
      const next = args[index + 1]?.value;
      if (next === "true" || next === "false") {
        enabled = next === "true";
        index += 1;
        continue;
      }
      enabled = true;
      continue;
    }
    if (token.startsWith(`${ATTESTATION_FLAG}=`)) {
      enabled = token.slice(ATTESTATION_FLAG.length + 1) === "true";
    }
  }
  return enabled;
}

/** Decide whether a segment enters an `else` or `elif` sibling arm. */
function startsIfSiblingArm(segment: string): boolean {
  const first = tokenizeCommands(segment)[0]?.[0]?.value;
  return first === "else" || first === "elif";
}

/**
 * Find every publish invocation in one file's contents.
 *
 * Continuations are joined and shared arrays expanded before tokenising, for
 * the same reason the changelog-date scan does it: a multi-line invocation
 * otherwise looks like fragments, none of which carries the flag.
 *
 * @param source - The file's path and contents.
 * @returns The publish invocations found, in file order.
 */
function publishInvocationsInShell(source: SourceFile, raw: string): PublishInvocation[] {
  const text = joinContinuations(raw);
  const arrays = bashArrays(text);
  const lines = text.split("\n");
  const bodies = heredocBodyLines(lines);
  const bodyExpansion = heredocExpansionLines(lines);
  const scopes: Array<Map<string, string | undefined>> = [new Map()];
  let caseDepth = 0;
  const visibleScalars = (): Map<string, string> => {
    const visible = new Map<string, string>();
    for (const scope of scopes) {
      for (const [name, binding] of scope) {
        if (binding === undefined) visible.delete(name);
        else visible.set(name, binding);
      }
    }
    return visible;
  };
  const expanded = lines.map((line, lineIndex) => {
    // Heredoc bodies cannot mutate the parent binding state. Unquoted bodies
    // expand variables before being written; quoted bodies retain references,
    // which fail closed if a generated script later executes them.
    if (bodies[lineIndex]!) {
      return bodyExpansion[lineIndex]!
        ? expandScalars(expandArrays(line, arrays), visibleScalars())
        : line;
    }
    const segments = segmentShellLine(line);

    let assignmentEligible = true;
    let pendingAssignments = new Map<string, string>();
    let pendingAssignmentEligible = false;
    const rendered = segments.map((segment) => {
      if (/^(?:;|&&?|\|\|?)$/.test(segment)) {
        const currentScope = scopes[scopes.length - 1]!;
        for (const [name, binding] of pendingAssignments) {
          // Only a sequential separator persists the assignment in the current
          // scope. Ambiguous execution shadows prior evidence fail-closed.
          currentScope.set(name, pendingAssignmentEligible && segment === ";" ? binding : undefined);
        }
        pendingAssignments = new Map();
        assignmentEligible = segment === ";";
        return segment;
      }

      // Scope transitions are applied per segment, not per physical line. A
      // one-line compound command can open, assign, publish, and close without
      // any net line-level depth change, yet each command still needs the
      // binding state at the point where it runs.
      const caseChange = caseDepthChange(segment);
      const insideCase = caseDepth > 0 || caseChange > 0;
      const change = blockDepthChange(segment, insideCase);
      if (change < 0) {
        for (let count = 0; count > change && scopes.length > 1; count -= 1) {
          const closed = scopes.pop()!;
          const parent = scopes[scopes.length - 1]!;
          // Assignments inside a conditional remain arm-local and are dropped,
          // but an unset is destructive evidence. Forgetting it could restore
          // an attesting outer value that the real shell discarded.
          for (const [name, binding] of closed) {
            if (binding === undefined) parent.set(name, undefined);
          }
        }
      }
      caseDepth = Math.max(0, caseDepth + caseChange);

      // A sibling arm receives a fresh map at the same numeric depth. Clearing
      // it is the branch identity: evidence from a mutually exclusive arm can
      // never be visible to this path. Outer scopes remain visible.
      //
      // Skipped only when this segment is itself the `case` opener. Such a
      // segment both opens the block and starts its first arm, and the push
      // below has not happened yet — so clearing here would erase the OUTER
      // scope and refuse a publish whose flag was bound before the block. There
      // is no earlier sibling arm at that point, and the scope pushed below is
      // empty, so the branch identity holds by construction.
      //
      // It must NOT be skipped merely because the segment opens some block: a
      // later arm that begins by opening a nested block (`b) if true; then …`)
      // is still a sibling, and skipping the reset there leaves the previous
      // arm's binding visible and attests a publish from a mutually exclusive
      // arm.
      if (caseChange <= 0 && (startsIfSiblingArm(segment) || (insideCase && startsCaseArm(segment)))) {
        const currentScope = scopes[scopes.length - 1]!;
        const discarded = [...currentScope].filter((entry) => entry[1] === undefined);
        currentScope.clear();
        // A destructive operation in either possible arm makes the later value
        // unprovable. Retain only unsets when moving to a sibling arm; retaining
        // assignments here would re-open the sibling-evidence defect.
        for (const [name] of discarded) currentScope.set(name, undefined);
      }
      if (change > 0) {
        for (let count = 0; count < change; count += 1) scopes.push(new Map());
      }

      const resolved = expandScalars(expandArrays(segment, arrays), visibleScalars());
      pendingAssignments = literalScalarAssignments(segment);
      pendingAssignmentEligible = assignmentEligible;
      const currentScope = scopes[scopes.length - 1]!;
      for (const command of tokenizeCommands(segment)) {
        for (const name of unsetNames(command)) currentScope.set(name, undefined);
      }
      assignmentEligible = false;
      return resolved;
    });
    const currentScope = scopes[scopes.length - 1]!;
    for (const [name, binding] of pendingAssignments) {
      currentScope.set(name, pendingAssignmentEligible ? binding : undefined);
    }
    return rendered.join("");
  }).join("\n");
  const found: PublishInvocation[] = [];
  for (const command of tokenizeCommands(expanded)) {
    // Every reading, not just the command's own: a wrapper option that takes a
    // value (`sudo -u root npm publish`) moves the program past where naming it
    // once would look. Missing a publish is a failed audit; offering one that no
    // shell would run is noise an operator dismisses.
    for (const candidate of commandCandidates(command)) {
      const program = commandName(candidate);
      if (program === undefined) continue;
      const unresolvedProgram = program.startsWith("$");
      if (program !== "npm" && !FOREIGN_PUBLISHERS.has(program) && !unresolvedProgram) continue;
      if (!isPublishCommand(candidate)) continue;
      // Not de-duplicated: two identical publish lines are two invocations, and
      // collapsing them would report one of them as if the other did not exist.
      found.push({ file: source.file, program, command: candidate });
    }
  }
  return found;
}

/** A path whose final segment is exactly `package.json`.
 *
 * Anchored at a segment boundary rather than matched as a suffix: a tracked
 * executable named `fake-package.json` ends with the same characters, and
 * routing it to the manifest reader parses it as JSON, fails, and yields no
 * bodies — hiding every publish it contains from the audit. Because the
 * non-vacuity guard is repository-wide, one attested publish elsewhere then
 * satisfies it and the whole run passes clean. */
const MANIFEST_PATH = /(?:^|\/)package\.json$/;

/**
 * Find every publish invocation in one source, isolating package scripts.
 *
 * npm launches every manifest script in a fresh shell, so scalar evidence from
 * one body can never attest a publish in another body.
 *
 * @param source - The file's path and contents.
 * @returns The publish invocations found, in file and script order.
 */
export function publishInvocationsIn(source: SourceFile): PublishInvocation[] {
  const bodies = MANIFEST_PATH.test(source.file)
    ? manifestCommandBodies(source.text)
    : [source.text];
  return bodies.flatMap((body) => publishInvocationsInShell(source, body));
}

/**
 * Render an invocation back to a readable command for a report line.
 *
 * @param command - The invocation's tokens.
 * @returns The command as a single space-separated string.
 */
export function renderCommand(command: ShellCommand): string {
  return command.map((token) => token.value).join(" ").slice(0, 160);
}

/**
 * Audit every publish invocation across the given files.
 *
 * An absent invocation is a failure rather than a pass: a scan that finds
 * nothing has either been pointed at the wrong files or outlived the workflow
 * it guards, and both look identical to a clean result unless said out loud.
 *
 * A publisher other than npm fails outright rather than being checked for a
 * flag. This repository's attested path is npm's `--provenance`; no equivalent
 * is configured for yarn, pnpm or bun, so such an invocation is an unattested
 * publish path regardless of the flags it carries, and guessing at another
 * tool's spelling would be a gate that only looked strict.
 *
 * @param sources - The tracked files to scan.
 * @returns Failures and per-file notes.
 */
export function auditPublishAttestation(sources: SourceFile[]): PublishAttestationResult {
  const invocations = sources.flatMap(publishInvocationsIn);
  const failures: string[] = [];
  const counted = new Map<string, { total: number; unflagged: number }>();
  for (const invocation of invocations) {
    const tally = counted.get(invocation.file) ?? { total: 0, unflagged: 0 };
    tally.total += 1;
    if (invocation.program !== "npm") {
      tally.unflagged += 1;
      failures.push(
        `${invocation.file}: \`${invocation.program} publish\` is a publish path with no attested`
        + ` equivalent configured in this repository: ${renderCommand(invocation.command)}`,
      );
    } else if (!attestationEnabled(invocation.command)) {
      tally.unflagged += 1;
      failures.push(
        `${invocation.file}: a publish invocation does not enable ${ATTESTATION_FLAG}, so it would`
        + ` publish an unattested artifact: ${renderCommand(invocation.command)}`,
      );
    }
    counted.set(invocation.file, tally);
  }
  if (invocations.length === 0) {
    failures.push("no npm publish invocation was found in any tracked file - the scan is looking in the wrong place");
  }
  const notes: string[] = [];
  for (const [file, tally] of counted) {
    if (tally.unflagged > 0) continue;
    notes.push(`ok - ${file}: ${tally.total} publish invocation(s), each carrying ${ATTESTATION_FLAG}`);
  }
  return {
    failures,
    notes,
    recognition: invocations.length === 0
      ? { kind: "none" }
      : { kind: "recognized", count: invocations.length },
  };
}

/**
 * Decide whether a tracked path can run a command.
 *
 * The previous enumeration named two paths -- `.github/workflows` and
 * `package.json` -- which meant a publish added to any tracked script was never
 * audited, and because the workflow's own attested publish satisfied the
 * non-vacuity check the gate still reported that every invocation was attested.
 * Auditing every shape that can execute closes that, and a shebang is honoured
 * so an extensionless tracked script is not a blind spot either.
 *
 * Build output is excluded. `dist/` is generated from sources this scan already
 * reads, it is regenerated and compared byte-for-byte on the release path, and
 * including it would audit a bundled copy of a command rather than the command.
 *
 * @param path - Repository-relative path.
 * @param firstLine - The file's first line, for shebang detection.
 * @returns True when the file should be scanned.
 */
export function isExecutableSource(path: string, firstLine: string): boolean {
  if (GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (firstLine.startsWith("#!")) return true;
  return EXECUTABLE_PATHS.some((pattern) => pattern.test(path));
}

/**
 * Read the first two bytes of a file, or nothing when it cannot be read.
 *
 * Only a shebang is being looked for, so the whole file is never loaded --
 * `git ls-files` can name a large tracked asset, and this runs once per
 * candidate. A tracked path that cannot be opened at all (a dangling symlink,
 * a file removed from the working tree but still in the index) is not a
 * publish path and must not take the gate down; it reads as empty.
 *
 * The handle is closed by an inner `finally` rather than one wrapping the
 * catch, so there is no unreachable fall-through for the coverage gate to
 * report as an untested branch.
 *
 * @param file - Absolute path to read.
 * @returns The first two bytes as text, or an empty string.
 */
function firstBytes(file: string): string {
  try {
    const handle = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(2);
      readSync(handle, buffer, 0, 2, 0);
      return buffer.toString("utf8");
    } finally {
      closeSync(handle);
    }
  } catch {
    return "";
  }
}

/**
 * List the tracked files that can run a publish.
 *
 * Git is asked rather than the filesystem walked, so an untracked scratch copy
 * of a workflow cannot satisfy or fail the gate. `-z` is used because a tracked
 * path may legally contain a newline, and splitting such a listing on newlines
 * invents two paths that do not exist and drops the one that does.
 *
 * @param root - Repository root.
 * @returns Repository-relative paths of every tracked file that can execute.
 */
export function trackedPublishSources(root: string): string[] {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .split("\0")
    .filter((path) => path.length > 0)
    .filter((path) => isExecutableSource(path, firstBytes(resolve(root, path))));
}

/**
 * Read the tracked sources and audit them.
 *
 * @param root - Repository root to verify.
 * @returns Failures and notes for the whole repository.
 */
export function verify(root: string): PublishAttestationResult {
  const sources: SourceFile[] = trackedPublishSources(root).map((file) => ({
    file,
    text: readFileSync(resolve(root, file), "utf8"),
  }));
  return auditPublishAttestation(sources);
}

/**
 * Print a result and set a failing exit code when it failed.
 *
 * @param result - The audit outcome.
 * @param write - Sink for the report lines.
 * @param exit - Called with the process exit code when there were failures.
 */
export function report(
  result: VerifierResult,
  write: (line: string) => void,
  exit: (code: number) => void,
): void {
  for (const note of result.notes) write(note);
  for (const failure of result.failures) write(`FAIL - ${failure}`);
  if (result.failures.length > 0) {
    write(`verify-release-publish-attestation: ${result.failures.length} failure(s).`);
    exit(1);
    return;
  }
  write("verify-release-publish-attestation: every publish invocation is attested.");
}

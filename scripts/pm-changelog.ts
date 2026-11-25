/** Repository changelog policy over the pinned generator's release windows. */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve, sep } from "node:path";
import { parseBootstrapGlobalOptions, resolveImplicitPmRoot, resolvePmRoot } from "@unbrained/pm-cli/sdk";
import { buildPmListArgs, checkItemLinks, mergeChangelog } from "pm-changelog";
import { changelogOutputTarget } from "../release-changelog-options.ts";
import { execFileSync, spawnSync } from "../subprocess.ts";
import { isMainInvocation } from "./main-invocation.ts";
import { appendReleaseReceipts, assertDistinctReleaseReceipt, plainReleasePath, writeFileWithReceipts } from "./release-file-receipts.ts";

/** Retain empty releases without adding an empty Unreleased window after tagging. */
export function describeEmptyReleases(markdown: string): string {
  return markdown
    .replace(/^## Unreleased\n\nNo changes\.\n\n(?=## \d)/m, "")
    .replace(/(^## [^\n]+\n\n)No changes\.\n(?=\n## |$)/gm, "$1No tracked changes.\n");
}

/** Validate the merged bytes using the same tracker selection as pm-changelog. */
function checkMergedLinks(markdown: string, args: readonly string[], positions: readonly number[], cwd: string, env: NodeJS.ProcessEnv): void {
  const options: Record<string, string> = {};
  const pmArgs: string[] = [];
  for (const index of positions) {
    const arg = args[index]!;
    const flag = arg.split("=", 1)[0]!;
    const value = arg === flag ? args[index + 1] : arg.slice(flag.length + 1);
    if (value === undefined) continue;
    if (flag === "--pm-arg") pmArgs.push(value);
    else if (flag === "--pm-root" || flag === "--pm-cwd" || flag === "--item-url-base") options[flag] = value;
  }
  const selectedPath = parseBootstrapGlobalOptions(buildPmListArgs({ pmRoot: options["--pm-root"], pmArgs })).path?.trim()
    || env.PM_PATH?.trim();
  const trackerCwd = resolve(cwd, options["--pm-cwd"] ?? ".");
  const trackerRoot = selectedPath ? resolvePmRoot(trackerCwd, selectedPath) : resolveImplicitPmRoot(trackerCwd);
  if (!options["--item-url-base"]?.trim()) throw new Error("--check-links requires --item-url-base");
  checkItemLinks(markdown, trackerRoot, options["--item-url-base"]);
}

/** Generate once, then use identical normalized bytes for writes, checks and notes. */
export function runChangelog(args: readonly string[], cwd = process.cwd(), env = process.env): number {
  const { output: { value: output }, invalidOption, check, stdout, consumed, positions } = changelogOutputTarget(args.map(value => ({ value })));
  if (invalidOption) throw new Error(`${invalidOption} requires a value`);
  let mode = "replace";
  let format: string | undefined;
  let title: string | undefined;
  let summary = false;
  let json = false;
  const githubOutputPositions: number[] = [];
  for (const index of positions) {
    const arg = args[index]!;
    if (arg === "--mode" || arg.startsWith("--mode=")) {
      const separate = arg === "--mode";
      const value = separate ? args[index + 1] : arg.slice("--mode=".length);
      if (!value || value.startsWith("--")) throw new Error("--mode requires a value");
      if (value !== "replace" && value !== "prepend") throw new Error("--mode must be replace or prepend");
      mode = value;
      consumed.add(index);
      if (separate) consumed.add(index + 1);
    } else if (arg === "--github-step-summary") {
      summary = true;
      consumed.add(index);
    } else if (arg === "--github-output" || arg === "--set-output") githubOutputPositions.push(index);
    else if (arg === "--json") json = true;
    else if (arg === "--format") format = args[index + 1];
    else if (arg.startsWith("--format=")) format = arg.slice("--format=".length);
    else if (arg === "--title") title = args[index + 1];
    else if (arg.startsWith("--title=")) title = arg.slice("--title=".length);
  }
  const jsonFormat = format?.trim().toLowerCase() === "json";
  const compactReport = positions.some(index => args[index] === "--summary");
  const auditReport = args[0] === "audit" || positions.some(index => args[index] === "--audit-evidence");
  const separateReport = jsonFormat || compactReport || auditReport
    || positions.some(index => ["--changelog-json", "--suggest-semver"].includes(args[index]!));
  const stepOutput = (!stdout || json) && !separateReport && githubOutputPositions.length > 0;
  if (stepOutput && !env.GITHUB_OUTPUT) throw new Error("--github-output requires GITHUB_OUTPUT");
  if (stepOutput) for (const index of githubOutputPositions) consumed.add(index);
  const report = stdout && (separateReport || json);
  const checkMerged = mode === "prepend" && !report && !separateReport && positions.some(index => args[index] === "--check-links");
  if (checkMerged) for (const index of positions) if (args[index] === "--check-links") consumed.add(index);
  const forwarded = args.filter((_, index) => !consumed.has(index));
  if (forwarded.some(arg => ["--all-release-tags", "--since-previous-tag", "--until-release-tag"].includes(arg))
    && spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, env, encoding: "utf8" }).status !== 0) {
    throw new Error("Changelog release windows need a git repository; the current directory is not inside one. Generate from tracker items without tag flags instead.");
  }
  if (summary && !env.GITHUB_STEP_SUMMARY) throw new Error("--github-step-summary requires GITHUB_STEP_SUMMARY");
  const generator = createRequire(import.meta.url).resolve("pm-changelog/cli");
  // Keep raw path components until the receipt preflight has inspected them.
  const inProject = (path: string) => isAbsolute(path) ? path : cwd + sep + path;
  const requested = inProject(output);
  const destination = resolve(cwd, output);
  const textSummary = stdout && compactReport && !jsonFormat && !auditReport;
  const summaryPath = summary && (!separateReport || textSummary) ? inProject(env.GITHUB_STEP_SUMMARY!) : undefined;
  const outputPath = stepOutput ? inProject(env.GITHUB_OUTPUT!) : undefined;
  if (summaryPath) assertDistinctReleaseReceipt(requested, summaryPath);
  if (outputPath) assertDistinctReleaseReceipt(requested, outputPath);
  if (summaryPath && outputPath) assertDistinctReleaseReceipt(summaryPath, outputPath);
  if (!stdout && !check && !summaryPath && !outputPath) plainReleasePath(requested);
  if (report) forwarded.push("--mode", mode);
  const fileReport = !stdout && !separateReport && (stepOutput || json);
  if (fileReport && !json) forwarded.push("--json");
  const rendered = execFileSync(process.execPath, [generator, ...forwarded, "--output", destination, "--stdout"], { cwd, env, encoding: "utf8" });
  // Read the generator's item counts once and report the adapter's final bytes.
  const generation = fileReport ? JSON.parse(rendered) as {
    markdown: string; itemCount: number; excluded_non_change_count: number;
  } : undefined;
  const existing = !report && existsSync(destination) ? readFileSync(destination, "utf8") : "";
  const markdown = report ? rendered : describeEmptyReleases(generation?.markdown ?? rendered);
  const merged = !report && mode === "prepend" ? mergeChangelog(existing, markdown, { title }) : undefined;
  const result = merged?.markdown ?? markdown;
  if (checkMerged) {
    checkMergedLinks(result, args, positions, cwd, env);
  }
  const changed = existing !== result;
  const mergeAction = merged?.action;
  const action = !changed ? "unchanged"
    : mergeAction === "unchanged" ? "replaced"
    : mergeAction ?? (existing.trimEnd() ? "replaced" : "created");
  const receipt = generation && { mode, action, changed, bytes: Buffer.byteLength(result), check };
  const stdoutRecord = stdout && json && !separateReport ? JSON.parse(rendered) as {
      markdown: string;
      mode: string; action: string; changed: boolean; bytes: number; itemCount: number; excluded_non_change_count: number;
    } : undefined;
  const outputRecord = generation && receipt ? { ...generation, ...receipt } : stdoutRecord;
  const summaryMarkdown = stdoutRecord?.markdown ?? result;
  /** Append only receipts for a changelog whose bytes have been written or checked. */
  function writeReceipts(): void {
    const receipts = [];
    if (summaryPath) receipts.push({ path: summaryPath, text: summaryMarkdown });
    if (outputPath && outputRecord) receipts.push({
      path: outputPath, records: true,
      text: `output=${destination}\nmode=${outputRecord.mode}\naction=${outputRecord.action}\nchanged=${outputRecord.changed}\nitem_count=${outputRecord.itemCount}\nexcluded_non_change_count=${outputRecord.excluded_non_change_count}\nbytes=${outputRecord.bytes}\n`,
    });
    appendReleaseReceipts(receipts);
  }
  if (!stdout && !check) {
    writeFileWithReceipts(requested, result, summaryPath || stepOutput ? writeReceipts : undefined);
  } else {
    if (summaryPath && !outputPath) writeFileWithReceipts(summaryPath, summaryMarkdown, "append");
    else writeReceipts();
    if (stdout) process.stdout.write(result);
    else console.error(`Changelog is ${changed ? "out of date" : "up to date"}: ${output}`);
  }
  if (generation && json) {
    const { markdown: _markdown, ...generated } = generation;
    process.stdout.write(JSON.stringify({ ...generated, ...receipt }) + "\n");
  }
  return !stdout && check && changed ? 1 : 0;
}

if (isMainInvocation(process.argv, import.meta.url)) process.exitCode = runChangelog(process.argv.slice(2));

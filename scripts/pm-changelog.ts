/** Repository changelog policy over the pinned generator's release windows. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseBootstrapGlobalOptions, resolveImplicitPmRoot, resolvePmRoot } from "@unbrained/pm-cli/sdk";
import { buildPmListArgs, checkItemLinks, mergeChangelog } from "pm-changelog";
import { changelogOutputTarget } from "../release-changelog-options.ts";
import { execFileSync, spawnSync } from "../subprocess.ts";
import { isMainInvocation } from "./main-invocation.ts";

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
  // The child validates that --item-url-base is present and nonempty.
  checkItemLinks(markdown, trackerRoot, options["--item-url-base"]!);
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
  const separateReport = format?.trim().toLowerCase() === "json"
    || positions.some(index => ["--summary", "--changelog-json", "--suggest-semver", "--audit-evidence"].includes(args[index]!))
    || args[0] === "audit";
  const stepOutput = !stdout && !separateReport && githubOutputPositions.length > 0;
  if (stepOutput && !env.GITHUB_OUTPUT) throw new Error("--github-output requires GITHUB_OUTPUT");
  if (stepOutput) for (const index of githubOutputPositions) consumed.add(index);
  const forwarded = args.filter((_, index) => !consumed.has(index));
  if (forwarded.some(arg => ["--all-release-tags", "--since-previous-tag", "--until-release-tag"].includes(arg))
    && spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, env, encoding: "utf8" }).status !== 0) {
    throw new Error("Changelog release windows need a git repository; the current directory is not inside one. Generate from tracker items without tag flags instead.");
  }
  if (summary && !env.GITHUB_STEP_SUMMARY) throw new Error("--github-step-summary requires GITHUB_STEP_SUMMARY");
  const generator = createRequire(import.meta.url).resolve("pm-changelog/cli");
  const destination = resolve(cwd, output);
  const report = stdout && (separateReport || json);
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
  if (!report && mode === "prepend" && positions.some(index => args[index] === "--check-links")) {
    checkMergedLinks(result, args, positions, cwd, env);
  }
  const changed = existing !== result;
  const receipt = generation && {
    mode, action: changed ? merged?.action ?? (existing.trimEnd() ? "replaced" : "created") : "unchanged",
    changed, bytes: Buffer.byteLength(result), check,
  };
  if (summary) appendFileSync(resolve(cwd, env.GITHUB_STEP_SUMMARY!), result);
  // A failed output append must leave the existing changelog intact.
  if (stepOutput && generation && receipt) appendFileSync(resolve(cwd, env.GITHUB_OUTPUT!),
    `output=${destination}\nmode=${mode}\naction=${receipt.action}\nchanged=${changed}\nitem_count=${generation.itemCount}\nexcluded_non_change_count=${generation.excluded_non_change_count}\nbytes=${receipt.bytes}\n`);
  if (stdout) process.stdout.write(result);
  else if (check) console.error(`Changelog is ${changed ? "out of date" : "up to date"}: ${output}`);
  else writeFileSync(destination, result);
  if (generation && json) {
    const { markdown: _markdown, ...generated } = generation;
    process.stdout.write(JSON.stringify({ ...generated, ...receipt }) + "\n");
  }
  return !stdout && check && changed ? 1 : 0;
}

if (isMainInvocation(process.argv, import.meta.url)) process.exitCode = runChangelog(process.argv.slice(2));

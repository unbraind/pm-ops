import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { resolve, basename, dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

// ---------------------------------------------------------------------------
// Error contract — mirror pm-cli SDK EXIT_CODE so the host treats thrown
// CommandError as a clean non-zero exit instead of re-invoking the handler.
// ---------------------------------------------------------------------------

const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
} as const;

class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Rendered-result marker + renderer override
// ---------------------------------------------------------------------------
// The pm host always renders a command's return value to stdout (TOON by
// default, JSON under the global --json). To emit a fully-controlled string
// (markdown / json / a rendered report) we return a tagged object and register
// a renderer override for both "toon" and "json" that unwraps it. For the
// default TOON case we return the raw structured object so the host renders it.

interface RenderedCommandResult {
  pmOpsRendered: true;
  output: string;
}

function renderedCommandResult(output: string): RenderedCommandResult {
  return { pmOpsRendered: true, output: output.endsWith("\n") ? output : `${output}\n` };
}

function renderCommandResult(context: { result?: unknown }): string | null {
  const result = context.result as Partial<RenderedCommandResult> | null | undefined;
  return result?.pmOpsRendered === true && typeof result.output === "string" ? result.output : null;
}

// ---------------------------------------------------------------------------
// Option helpers
// ---------------------------------------------------------------------------

function readBool(options: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => options[key] === true || options[key] === "true" || options[key] === "1");
}

function readString(options: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = options[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(asArray);
  if (typeof value !== "string") return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

// Expand a leading `~` to the user's home directory so agent- or user-provided
// paths like `~/container/pm-csv` resolve correctly instead of failing ENOENT
// relative to the current working directory.
function resolvePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(join(homedir(), p.slice(2)));
  return resolve(p);
}

// Expand glob patterns (e.g. `~/container/pm-*`) so they work when the CLI is
// invoked without a shell (agents, npx). Uses Node's fs.globSync when available
// (Node 22+); falls back to the literal path on older Node or no matches.
function expandGlob(pattern: string): string[] {
  const resolved = resolvePath(pattern);
  if (!resolved.includes("*") && !resolved.includes("?")) return [resolved];
  const globSyncFn = (fs as unknown as { globSync?: (p: string) => string[] }).globSync;
  if (typeof globSyncFn === "function") {
    try {
      const matches = globSyncFn(resolved);
      if (matches.length > 0) return matches.map((m) => resolve(m));
    } catch {
      /* fall through to literal */
    }
  }
  return [resolved];
}

function resolveRepos(options: Record<string, unknown>): string[] {
  const repos = asArray(options["repos"]);
  if (repos.length > 0) return repos.flatMap((r) => expandGlob(r));
  return [process.cwd()];
}

type OutputFormat = "toon" | "json" | "markdown";

function resolveFormat(options: Record<string, unknown>): OutputFormat {
  if (readBool(options, "json")) return "json";
  const raw = readString(options, "format")?.toLowerCase();
  if (raw === "json" || raw === "markdown" || raw === "toon") return raw;
  return "toon";
}

// ---------------------------------------------------------------------------
// Subprocess helpers (no shell — args passed as arrays)
// ---------------------------------------------------------------------------

interface SyncResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function runSync(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): SyncResult {
  // On Windows, npm/pm (and other globally-installed CLIs) are .cmd shims; spawning
  // them with shell:false fails with ENOENT. Append .cmd for those well-known
  // commands so the extension works cross-platform without forcing shell:true.
  const isWin = process.platform === "win32";
  const spawnCmd = isWin && (cmd === "npm" || cmd === "pm" || cmd === "npx") ? `${cmd}.cmd` : cmd;
  const r = spawnSync(spawnCmd, args, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readJsonFile<T = unknown>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

// Strip JSONC (// line comments and /* */ block comments) and trailing commas
// so tsconfig.json files — which TypeScript permits to contain comments — parse
// cleanly. Naive but sufficient for tsconfig: it does not strip comments inside
// string literals, but tsconfig values do not contain "//" or "/*" literals.
function stripJsonc(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n\r]*/g, "")
    .replace(/,\s*([}\]])/g, "$1");
}

function readJsoncFile<T = unknown>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(stripJsonc(readFileSync(path, "utf-8"))) as T;
  } catch {
    return undefined;
  }
}

interface PkgJson {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(repoPath: string): PkgJson | undefined {
  return readJsonFile<PkgJson>(join(repoPath, "package.json"));
}

// pm-changelog is most often a devDependency, but some setups declare build
// tooling under `dependencies`. Check both so we don't false-fail policy/scan.
function hasPmChangelogDep(pkg: PkgJson | undefined): boolean {
  return Boolean(
    (pkg?.devDependencies && "pm-changelog" in pkg.devDependencies) ||
      (pkg?.dependencies && "pm-changelog" in pkg.dependencies),
  );
}

interface TsConfigJson {
  extends?: string;
  compilerOptions?: { strict?: boolean };
}

// Resolve a tsconfig `extends` value to an absolute file path. The value may
// be a relative path (./base.json, ../shared/tsconfig.json) or an npm package
// specifier (@tsconfig/node20, @org/tsconfig/base.json). Relative values are
// resolved against the current file's directory; package specifiers are
// resolved via Node module resolution from the current file's directory.
function resolveTsConfigExtends(fromPath: string, extendsValue: string): string | undefined {
  // Relative/absolute path: resolve directly.
  if (extendsValue.startsWith("./") || extendsValue.startsWith("../") || extendsValue.startsWith("/")) {
    return resolve(dirname(fromPath), extendsValue);
  }
  // Package specifier (e.g. "@tsconfig/node20" or "@tsconfig/node20/tsconfig.json"):
  // use Node module resolution relative to the current config file. Some packages
  // expose the config at the package root (exportless), some via "exports"; try
  // the bare specifier first, then with /tsconfig.json appended.
  try {
    const req = createRequire(fromPath);
    try {
      return req.resolve(extendsValue);
    } catch {
      if (!extendsValue.endsWith(".json")) {
        try {
          return req.resolve(`${extendsValue}/tsconfig.json`);
        } catch {
          /* fall through */
        }
      }
    }
  } catch {
    /* createRequire needs a file URL; ignore on failure */
  }
  return undefined;
}

// Follow `extends` chains so a repo that inherits `strict: true` from a shared
// base tsconfig (common in monorepos, or via npm packages like @tsconfig/node20)
// is correctly detected as strict.
function readTsConfigStrict(repoPath: string): boolean {
  let currentPath = join(repoPath, "tsconfig.json");
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(currentPath)) break;
    visited.add(currentPath);
    const cfg: TsConfigJson | undefined = readJsoncFile<TsConfigJson>(currentPath);
    if (!cfg) break;
    if (cfg.compilerOptions?.strict === true) return true;
    if (cfg.compilerOptions?.strict === false) return false;
    if (typeof cfg.extends !== "string") break;
    const next = resolveTsConfigExtends(currentPath, cfg.extends);
    if (!next) break;
    currentPath = next;
  }
  return false;
}

// ---------------------------------------------------------------------------
// pm / npm / gh probes
// ---------------------------------------------------------------------------

interface PmItem {
  id: string;
  title?: string;
  status?: string;
}

// Resolve the pm CLI invocation. We prefer spawning the `pm` executable by name
// (the common case), but fall back to the current Node + script path when `pm`
// is not on PATH (npx, local monorepo bin, relative invocation). A quick
// `spawnSync` probe avoids falling back unnecessarily and keeps the happy path
// zero-config. Memoised: the probe result cannot change during a single process,
// and runPm is called per-repo (2N times in report), so caching avoids 2N probes.
let pmTargetCache: { cmd: string; leadArgs: string[] } | undefined;
function pmSpawnTarget(): { cmd: string; leadArgs: string[] } {
  if (pmTargetCache) return pmTargetCache;
  const probe = spawnSync("pm", ["--version"], { encoding: "utf-8", shell: false, timeout: 10_000 });
  let target: { cmd: string; leadArgs: string[] };
  if (!probe.error && probe.status === 0) {
    target = { cmd: "pm", leadArgs: [] };
  } else if (process.argv[0] && process.argv[1]) {
    // process.argv[0] = node binary, process.argv[1] = pm CLI script path.
    target = { cmd: process.argv[0], leadArgs: [process.argv[1]] };
  } else {
    target = { cmd: "pm", leadArgs: [] };
  }
  pmTargetCache = target;
  return target;
}

function runPm(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): SyncResult {
  const target = pmSpawnTarget();
  return runSync(target.cmd, [...target.leadArgs, ...args], opts);
}

// Per-process memo of readPmItems by repo path. scanRepos and runPolicy both
// call this for the same repo, and ops report runs both, so without memoisation
// a fleet of N repos spawns pm list 2N times. Cached for the lifetime of the
// process (a single CLI invocation).
const pmItemsCache = new Map<string, PmItem[] | null>();

function readPmItems(repoPath: string): PmItem[] | null {
  if (pmItemsCache.has(repoPath)) return pmItemsCache.get(repoPath)!;
  const result = readPmItemsUncached(repoPath);
  pmItemsCache.set(repoPath, result);
  return result;
}

function readPmItemsUncached(repoPath: string): PmItem[] | null {
  const pmRoot = join(repoPath, ".agents", "pm");
  if (!existsSync(pmRoot)) return null;
  // Timeout so a single hung pm process can't block the whole fleet run.
  const r = runPm(["list", "--json", "--pm-path", pmRoot], { timeoutMs: 30_000 });
  if (r.status !== 0) return null;
  const parsed = parseJsonSafe(r.stdout);
  if (!parsed) return null;
  const items = Array.isArray(parsed) ? parsed : (parsed as any).items ?? (parsed as any).results ?? [];
  if (!Array.isArray(items)) return null;
  return items.filter((it: unknown): it is PmItem => Boolean(it) && typeof it === "object" && typeof (it as PmItem).id === "string");
}

interface NpmOutdated {
  [name: string]: unknown;
}

function isOffline(): boolean {
  return process.env.PM_OPS_OFFLINE === "1" || process.env.PM_OPS_OFFLINE === "true";
}

function countOutdated(repoPath: string): number | null {
  if (isOffline()) return null;
  const r = runSync("npm", ["outdated", "--json"], { cwd: repoPath, timeoutMs: 60_000 });
  if (r.error) return null;
  // `npm outdated --json` exits 0 with empty stdout when nothing is outdated.
  // That is the "0 outdated" case, not an error — return 0 instead of null.
  if (r.status === 0 && r.stdout.trim() === "") return 0;
  const parsed = parseJsonSafe(r.stdout) as NpmOutdated | undefined;
  if (!parsed || typeof parsed !== "object") return null;
  return Object.keys(parsed).length;
}

interface NpmAudit {
  metadata?: {
    vulnerabilities?: { critical?: number; high?: number; total?: number };
  };
}

function readAudit(repoPath: string): { critical: number | null; high: number | null } {
  if (isOffline()) return { critical: null, high: null };
  const r = runSync("npm", ["audit", "--omit=dev", "--json"], { cwd: repoPath, timeoutMs: 60_000 });
  if (r.error) return { critical: null, high: null };
  const parsed = parseJsonSafe(r.stdout) as NpmAudit | undefined;
  const v = parsed?.metadata?.vulnerabilities;
  if (!v) return { critical: null, high: null };
  return { critical: v.critical ?? 0, high: v.high ?? 0 };
}

function ghRepoIsPrivate(repoPath: string): boolean | null {
  if (isOffline()) return null;
  const r = runSync("gh", ["repo", "view", "--json", "isPrivate", "--jq", ".isPrivate"], { cwd: repoPath, timeoutMs: 30_000 });
  if (r.status !== 0) return null;
  const raw = r.stdout.trim();
  if (raw !== "true" && raw !== "false") return null;
  return raw === "true";
}

function ghOpenCount(repoPath: string, kind: "pr" | "issue"): number | null {
  if (isOffline()) return null;
  const args = kind === "pr"
    ? ["pr", "list", "--state", "open", "--json", "number"]
    : ["issue", "list", "--state", "open", "--json", "number"];
  const r = runSync("gh", args, { cwd: repoPath, timeoutMs: 30_000 });
  if (r.status !== 0) return null;
  const parsed = parseJsonSafe(r.stdout);
  return Array.isArray(parsed) ? parsed.length : null;
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

interface RepoScan {
  path: string;
  name: string | null;
  version: string | null;
  strict_ts: boolean;
  has_changelog: boolean;
  has_release_workflow: boolean;
  has_ci: boolean;
  pm_workspace: boolean;
  pm_open_items: number | null;
  pm_inprogress_items: number | null;
  has_pm_changelog: boolean;
  outdated_count: number | null;
  audit_critical: number | null;
  audit_high: number | null;
  open_prs: number | null;
  open_issues: number | null;
  ready: boolean;
  errors: string[];
}

interface ScanResult {
  repos: RepoScan[];
  summary: { total: number; ready: number; not_ready: number };
}

function scanRepo(repoPath: string): RepoScan {
  const errors: string[] = [];
  // Guard against a non-existent directory so we don't spawn a flurry of
  // failing subprocesses (npm/gh) against it; report a clean not-ready result.
  if (!existsSync(repoPath)) {
    errors.push("repository directory does not exist");
    return {
      path: repoPath,
      name: null,
      version: null,
      strict_ts: false,
      has_changelog: false,
      has_release_workflow: false,
      has_ci: false,
      pm_workspace: false,
      pm_open_items: null,
      pm_inprogress_items: null,
      has_pm_changelog: false,
      outdated_count: null,
      audit_critical: null,
      audit_high: null,
      open_prs: null,
      open_issues: null,
      ready: false,
      errors,
    };
  }
  const pkg = readPackageJson(repoPath);
  const name = pkg?.name ?? null;
  const version = pkg?.version ?? null;
  const strict_ts = readTsConfigStrict(repoPath);
  const has_changelog = existsSync(join(repoPath, "CHANGELOG.md"));
  const has_release_workflow = existsSync(join(repoPath, ".github", "workflows", "release.yml"));
  const has_ci = existsSync(join(repoPath, ".github", "workflows", "ci.yml"));
  const has_pm_changelog = hasPmChangelogDep(pkg);

  const items = readPmItems(repoPath);
  const pm_workspace = items !== null;
  const pm_open_items = items ? items.filter((i) => (i.status ?? "").toLowerCase() === "open").length : null;
  const pm_inprogress_items = items ? items.filter((i) => (i.status ?? "").toLowerCase() === "in_progress").length : null;

  let outdated_count: number | null = null;
  try {
    outdated_count = countOutdated(repoPath);
  } catch (err) {
    errors.push(`outdated: ${err instanceof Error ? err.message : String(err)}`);
  }

  let audit_critical: number | null = null;
  let audit_high: number | null = null;
  try {
    const a = readAudit(repoPath);
    audit_critical = a.critical;
    audit_high = a.high;
  } catch (err) {
    errors.push(`audit: ${err instanceof Error ? err.message : String(err)}`);
  }

  const open_prs = ghOpenCount(repoPath, "pr");
  const open_issues = ghOpenCount(repoPath, "issue");

  const has_pkg = Boolean(pkg);
  const criticalGate = audit_critical === null ? true : audit_critical === 0;
  const ready = has_pkg && strict_ts && has_changelog && has_release_workflow && has_ci && has_pm_changelog && criticalGate;

  return {
    path: repoPath,
    name,
    version,
    strict_ts,
    has_changelog,
    has_release_workflow,
    has_ci,
    pm_workspace,
    pm_open_items,
    pm_inprogress_items,
    has_pm_changelog,
    outdated_count,
    audit_critical,
    audit_high,
    open_prs,
    open_issues,
    ready,
    errors,
  };
}

function scanRepos(repos: string[], progress: (msg: string) => void): ScanResult {
  const results = repos.map((repo) => {
    progress(`scanning ${repo}`);
    return scanRepo(repo);
  });
  const ready = results.filter((r) => r.ready).length;
  return { repos: results, summary: { total: results.length, ready, not_ready: results.length - ready } };
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

type Severity = "error" | "warning" | "info";

interface PolicyCheckDef {
  id: string;
  severity: Severity;
  repo_filter?: string;
  params?: Record<string, unknown>;
}

interface PolicyBundle {
  checks: PolicyCheckDef[];
}

interface PolicyCheckResult {
  id: string;
  severity: Severity;
  pass: boolean;
  message: string;
  details?: string[];
}

interface RepoPolicy {
  path: string;
  name: string | null;
  checks: PolicyCheckResult[];
  passed: number;
  failed: number;
}

interface PolicyResult {
  repos: RepoPolicy[];
  summary: { total: number; passed: number; failed: number; by_severity: Record<Severity, number> };
}

// Named defaults referenced when a policy check omits `params`. Declared before
// DEFAULT_POLICY so the bundle references the same single source of truth (no
// duplicated literals that could silently diverge), and used directly by
// runPolicyCheck so reordering/inserting checks can never grab the wrong entry.
const DEFAULT_REQUIRED_SCRIPTS = ["typecheck", "test", "build", "release:check", "changelog", "changelog:check"];
const DEFAULT_REQUIRED_WORKFLOWS = ["ci.yml", "release.yml"];

const DEFAULT_POLICY: PolicyBundle = {
  checks: [
    { id: "naming", severity: "error" },
    { id: "required-scripts", severity: "error", params: { scripts: DEFAULT_REQUIRED_SCRIPTS } },
    { id: "required-workflows", severity: "error", params: { workflows: DEFAULT_REQUIRED_WORKFLOWS } },
    { id: "private-no-runners", severity: "error" },
    { id: "pm-duplicate-titles", severity: "warning" },
    { id: "pm-changelog-wired", severity: "error" },
  ],
};

const NAME_PATTERN = /^pm-[a-z][a-z0-9-]*$/;
const FORBIDDEN_PREFIXES = ["pm-ext-", "pm-preset-"];
const RUNNER_PATTERN = /(github-hosted|macos-|windows-|ubuntu-)/;

function checkNaming(name: string | null): PolicyCheckResult {
  if (!name) return { id: "naming", severity: "error", pass: false, message: "package.json has no name" };
  if (FORBIDDEN_PREFIXES.some((p) => name.startsWith(p))) {
    return { id: "naming", severity: "error", pass: false, message: `name "${name}" uses a forbidden prefix (pm-ext- / pm-preset-)` };
  }
  const pass = NAME_PATTERN.test(name);
  return { id: "naming", severity: "error", pass, message: pass ? `name "${name}" matches ^pm-[a-z][a-z0-9-]*$` : `name "${name}" does not match ^pm-[a-z][a-z0-9-]*$` };
}

function checkRequiredScripts(pkg: PkgJson | undefined, required: string[]): PolicyCheckResult {
  const scripts = pkg?.scripts ?? {};
  const missing = required.filter((s) => typeof scripts[s] !== "string");
  return {
    id: "required-scripts",
    severity: "error",
    pass: missing.length === 0,
    message: missing.length === 0 ? "all required scripts present" : `missing scripts: ${missing.join(", ")}`,
    details: missing.length > 0 ? missing : undefined,
  };
}

function checkRequiredWorkflows(repoPath: string, required: string[]): PolicyCheckResult {
  const missing = required.filter((w) => !existsSync(join(repoPath, ".github", "workflows", w)));
  return {
    id: "required-workflows",
    severity: "error",
    pass: missing.length === 0,
    message: missing.length === 0 ? "all required workflows present" : `missing workflows: ${missing.join(", ")}`,
    details: missing.length > 0 ? missing : undefined,
  };
}

function checkPrivateNoRunners(repoPath: string): PolicyCheckResult {
  const isPrivate = ghRepoIsPrivate(repoPath);
  if (isPrivate === null || isPrivate === false) {
    return { id: "private-no-runners", severity: "error", pass: true, message: "repo is public or unknown — check skipped" };
  }
  const wfDir = join(repoPath, ".github", "workflows");
  const violations: string[] = [];
  if (existsSync(wfDir)) {
    for (const file of readdirSync(wfDir)) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
      // Guard the read so a broken symlink, permission error, or a file removed
      // between readdirSync/readFileSync records a per-file violation instead
      // of crashing the entire policy run.
      let content: string;
      try {
        content = readFileSync(join(wfDir, file), "utf-8");
      } catch (err) {
        violations.push(`${file}: could not read file (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      // Detect GitHub-hosted runners across the YAML forms GitHub Actions supports:
      //   runs-on: ubuntu-latest              (single line)
      //   runs-on:                            (multi-line list)
      //     - ubuntu-latest
      //   runs-on:                            (multi-line object: group/labels)
      //     group: ...
      //     labels:
      //       - ubuntu-latest
      // Skip blank lines and #-comments when scanning the following block, and
      // stop at the first line indented no deeper than the runs-on key.
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(/^(\s*)runs-on:\s*(.*)$/);
        if (!m) continue;
        const indentLen = m[1].length;
        let value = m[2].trim();
        if (!value) {
          const items: string[] = [];
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j];
            if (nextLine.trim() === "" || nextLine.trim().startsWith("#")) continue;
            const indentMatch = nextLine.match(/^(\s*)(.*)$/);
            if (!indentMatch || indentMatch[1].length <= indentLen) break;
            const body = indentMatch[2];
            const itemMatch = body.match(/^-\s+(.*)$/);
            if (itemMatch) {
              items.push(itemMatch[1].trim());
            } else {
              // Object key form. Only `labels:` values correspond to actual
              // runner assignments; `group:` names are arbitrary identifiers for
              // runner groups and must NOT be tested against RUNNER_PATTERN
              // (a group named "ubuntu-pool" would otherwise false-positive).
              const kvMatch = body.match(/^labels:\s*(.*)$/);
              if (kvMatch && kvMatch[2]) items.push(kvMatch[2].trim());
            }
          }
          value = items.join(" ");
        }
        if (RUNNER_PATTERN.test(value)) violations.push(`${file}: runs-on ${value}`);
      }
    }
  }
  return {
    id: "private-no-runners",
    severity: "error",
    pass: violations.length === 0,
    message: violations.length === 0 ? "private repo uses no GitHub-hosted runners" : `private repo uses GitHub-hosted runners in ${violations.length} workflow(s)`,
    details: violations.length > 0 ? violations : undefined,
  };
}

function checkPmDuplicateTitles(items: PmItem[] | null): PolicyCheckResult {
  if (items === null) return { id: "pm-duplicate-titles", severity: "warning", pass: true, message: "no pm workspace — check skipped" };
  const open = items.filter((i) => (i.status ?? "").toLowerCase() === "open");
  const seen = new Map<string, number>();
  for (const it of open) {
    const title = (it.title ?? "").trim();
    if (!title) continue;
    seen.set(title, (seen.get(title) ?? 0) + 1);
  }
  const dups = [...seen.entries()].filter(([, n]) => n > 1);
  return {
    id: "pm-duplicate-titles",
    severity: "warning",
    pass: dups.length === 0,
    message: dups.length === 0 ? "no duplicate open titles" : `${dups.length} duplicate open title(s)`,
    details: dups.length > 0 ? dups.map(([t, n]) => `${t} (${n})`) : undefined,
  };
}

function checkPmChangelogWired(pkg: PkgJson | undefined): PolicyCheckResult {
  const hasDep = hasPmChangelogDep(pkg);
  const hasScript = Boolean(pkg?.scripts && typeof pkg.scripts["changelog"] === "string");
  const pass = hasDep && hasScript;
  return {
    id: "pm-changelog-wired",
    severity: "error",
    pass,
    message: pass ? "pm-changelog wired (dep + script)" : `pm-changelog not wired (dep: ${hasDep}, script: ${hasScript})`,
  };
}

function runPolicyCheck(def: PolicyCheckDef, ctx: { repoPath: string; pkg: PkgJson | undefined; items: PmItem[] | null }): PolicyCheckResult {
  let res: PolicyCheckResult;
  switch (def.id) {
    case "naming":
      res = checkNaming(ctx.pkg?.name ?? null);
      break;
    case "required-scripts":
      res = checkRequiredScripts(ctx.pkg, (def.params?.scripts as string[]) ?? DEFAULT_REQUIRED_SCRIPTS);
      break;
    case "required-workflows":
      res = checkRequiredWorkflows(ctx.repoPath, (def.params?.workflows as string[]) ?? DEFAULT_REQUIRED_WORKFLOWS);
      break;
    case "private-no-runners":
      res = checkPrivateNoRunners(ctx.repoPath);
      break;
    case "pm-duplicate-titles":
      res = checkPmDuplicateTitles(ctx.items);
      break;
    case "pm-changelog-wired":
      res = checkPmChangelogWired(ctx.pkg);
      break;
    default:
      res = { id: def.id, severity: def.severity, pass: false, message: `unknown check id "${def.id}"` };
  }
  // Preserve any custom severity override declared in the policy bundle so
  // per-check output is consistent with the policy definition (a check the
  // user downgraded to "warning" should not be reported as "error").
  if (def.severity && res.severity !== def.severity) {
    return { ...res, severity: def.severity };
  }
  return res;
}

function matchesFilter(repoPath: string, name: string | null, filter: string | undefined): boolean {
  if (!filter) return true;
  if (filter === "*") return true;
  if (name && name === filter) return true;
  return basename(repoPath) === filter;
}

function runPolicy(repos: string[], bundle: PolicyBundle, progress: (msg: string) => void): PolicyResult {
  const by_severity: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  let totalPassed = 0;
  let totalFailed = 0;
  const repoResults = repos.map((repoPath) => {
    progress(`policy ${repoPath}`);
    const pkg = readPackageJson(repoPath);
    const items = readPmItems(repoPath);
    const checks = bundle.checks
      .filter((def) => matchesFilter(repoPath, pkg?.name ?? null, def.repo_filter))
      .map((def) => {
        const res = runPolicyCheck(def, { repoPath, pkg, items });
        if (!res.pass) by_severity[def.severity] += 1;
        return res;
      });
    const passed = checks.filter((c) => c.pass).length;
    const failed = checks.filter((c) => !c.pass).length;
    totalPassed += passed;
    totalFailed += failed;
    return { path: repoPath, name: pkg?.name ?? null, checks, passed, failed };
  });
  return { repos: repoResults, summary: { total: repos.length, passed: totalPassed, failed: totalFailed, by_severity } };
}

// ---------------------------------------------------------------------------
// verify-release
// ---------------------------------------------------------------------------

interface ReleaseCheck {
  name: string;
  pass: boolean;
  duration_ms: number;
  error?: string;
}

interface RepoRelease {
  path: string;
  name: string | null;
  checks: ReleaseCheck[];
  passed: number;
  failed: number;
}

interface VerifyReleaseResult {
  repos: RepoRelease[];
  summary: { total: number; passed: number; failed: number };
}

const FALLBACK_STEPS = ["typecheck", "build", "test", "audit:prod", "pack:dry-run", "changelog:check"];

function runReleaseCheck(repoPath: string, name: string, args: string[], progress: (msg: string) => void): ReleaseCheck {
  progress(`verify ${relative(process.cwd(), repoPath) || repoPath}: ${name}`);
  const start = Date.now();
  const r = runSync("npm", args, { cwd: repoPath, timeoutMs: 5 * 60_000 });
  const duration_ms = Date.now() - start;
  // Treat a spawn/timeout error (r.error, e.g. ETIMEDOUT/ENOENT) as a failure
  // and surface its message so agents get a clear reason, not just an exit code.
  const pass = r.status === 0 && !r.error;
  const error = pass
    ? undefined
    : (r.error?.message || r.stderr.trim() || r.stdout.trim() || `npm ${args.join(" ")} exited ${r.status}`).slice(-2000);
  return { name, pass, duration_ms, error };
}

function verifyReleaseRepo(repoPath: string, progress: (msg: string) => void): RepoRelease {
  const pkg = readPackageJson(repoPath);
  const scripts = pkg?.scripts ?? {};
  let checks: ReleaseCheck[];
  if (typeof scripts["release:check"] === "string") {
    checks = [runReleaseCheck(repoPath, "release:check", ["run", "release:check"], progress)];
  } else {
    checks = FALLBACK_STEPS
      .filter((s) => typeof scripts[s] === "string")
      .map((s) => runReleaseCheck(repoPath, s, ["run", s], progress));
  }
  // A missing repo directory should be reported as a path error, not mislabeled
  // as "no release gate found". Check existence first for accurate diagnostics.
  if (!existsSync(repoPath)) {
    checks = [
      {
        name: "release:check",
        pass: false,
        duration_ms: 0,
        error: `repository directory does not exist: ${repoPath}`,
      },
    ];
  } else if (checks.length === 0) {
    // A repo with no runnable release scripts would otherwise be a false green.
    // Surface it as a single failed check so verify-release never reports a
    // release-ready state for a repo that has no gate defined.
    checks = [
      {
        name: "release:check",
        pass: false,
        duration_ms: 0,
        error:
          "no release gate found: define a `release:check` script (or at least one of typecheck/build/test/audit:prod/pack:dry-run/changelog:check)",
      },
    ];
  }
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.filter((c) => !c.pass).length;
  return { path: repoPath, name: pkg?.name ?? null, checks, passed, failed };
}

function verifyRelease(repos: string[], progress: (msg: string) => void): VerifyReleaseResult {
  const results = repos.map((r) => verifyReleaseRepo(r, progress));
  return {
    repos: results,
    summary: { total: results.length, passed: results.filter((r) => r.failed === 0).length, failed: results.filter((r) => r.failed > 0).length },
  };
}

function renderVerifyReleaseMarkdown(result: VerifyReleaseResult): string {
  const lines: string[] = [
    "# pm-ops verify-release",
    "",
    `Verified **${result.summary.total}** repo(s): **${result.summary.passed}** passed, **${result.summary.failed}** failed.`,
    "",
    renderMarkdownRow(["repo", "check", "pass", "duration_ms", "error"]),
    renderMarkdownRow(["---", "---", "---", "---", "---"]),
  ];
  for (const repo of result.repos) {
    for (const c of repo.checks) {
      lines.push(renderMarkdownRow([
        repo.name ?? basename(repo.path),
        c.name,
        c.pass ? "yes" : "no",
        String(c.duration_ms),
        // Escape pipes AND collapse newlines so a multi-line build/test error
        // can't split this cell across rows and corrupt the markdown table.
        (c.error ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ⏎ ").slice(0, 200),
      ]));
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

interface ReportResult {
  generated_at: string;
  scan: ScanResult;
  policy: PolicyResult;
}

function buildReport(repos: string[], progress: (msg: string) => void): ReportResult {
  return { generated_at: new Date().toISOString(), scan: scanRepos(repos, progress), policy: runPolicy(repos, DEFAULT_POLICY, progress) };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatBool(v: boolean): string {
  return v ? "yes" : "no";
}

function formatCount(v: number | null): string {
  return v === null ? "?" : String(v);
}

function renderMarkdownRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function renderScanMarkdown(result: ScanResult): string {
  const lines: string[] = [];
  lines.push("# pm-ops scan");
  lines.push("");
  lines.push(`Scanned **${result.summary.total}** repo(s): **${result.summary.ready}** ready, **${result.summary.not_ready}** not ready.`);
  lines.push("");
  lines.push(renderMarkdownRow(["repo", "version", "strict", "changelog", "release", "ci", "pm-changelog", "open items", "outdated", "critical", "high", "prs", "issues", "ready"]));
  lines.push(renderMarkdownRow(["---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---"]));
  for (const r of result.repos) {
    const openItems = r.pm_open_items === null ? "?" : `${r.pm_open_items}/${r.pm_inprogress_items ?? 0}`;
    lines.push(renderMarkdownRow([
      r.name ?? basename(r.path),
      r.version ?? "-",
      formatBool(r.strict_ts),
      formatBool(r.has_changelog),
      formatBool(r.has_release_workflow),
      formatBool(r.has_ci),
      formatBool(r.has_pm_changelog),
      openItems,
      formatCount(r.outdated_count),
      formatCount(r.audit_critical),
      formatCount(r.audit_high),
      formatCount(r.open_prs),
      formatCount(r.open_issues),
      r.ready ? "yes" : "no",
    ]));
  }
  lines.push("");
  return lines.join("\n");
}

function renderPolicyMarkdown(result: PolicyResult): string {
  const lines: string[] = [];
  lines.push("# pm-ops policy");
  lines.push("");
  lines.push(`Checked **${result.summary.total}** repo(s): **${result.summary.passed}** checks passed, **${result.summary.failed}** failed.`);
  lines.push("");
  lines.push(renderMarkdownRow(["repo", "check", "severity", "pass", "message"]));
  lines.push(renderMarkdownRow(["---", "---", "---", "---", "---"]));
  for (const repo of result.repos) {
    for (const c of repo.checks) {
      lines.push(renderMarkdownRow([
        repo.name ?? basename(repo.path),
        c.id,
        c.severity,
        c.pass ? "yes" : "no",
        c.message.replace(/\|/g, "\\|"),
      ]));
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderReportMarkdown(result: ReportResult): string {
  return [renderScanMarkdown(result.scan), "", renderPolicyMarkdown(result.policy)].join("\n");
}

// Serialize the structured result as JSON. Branching JSON separately from the
// markdown formatter ensures `--format json` / `--json` and `--output <file>`
// write real serialized JSON, not markdown.
function jsonOf(structured: unknown): string {
  return `${JSON.stringify(structured, null, 2)}\n`;
}

function emitResult(structured: unknown, format: OutputFormat, outputPath: string | undefined, formatter: () => string): unknown {
  if (outputPath) {
    // Create parent directories so --output ./reports/fleet.md works on a fresh
    // checkout instead of crashing with a raw ENOENT.
    const parent = dirname(resolvePath(outputPath));
    try {
      mkdirSync(parent, { recursive: true });
    } catch {
      /* ignore — writeFileSync will surface a clean error if the dir is unusable */
    }
    const body = format === "markdown" ? formatter() : jsonOf(structured);
    writeFileSync(outputPath, body, "utf-8");
    console.error(`pm-ops: wrote ${format} output to ${outputPath}`);
    return { written_to: outputPath, format };
  }
  if (format === "toon") return structured;
  if (format === "json") return renderedCommandResult(jsonOf(structured));
  return renderedCommandResult(formatter());
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default defineExtension({
  name: "pm-ops",
  version: "2026.7.5",

  activate(api: any) {
    if (typeof api.registerRenderer === "function") {
      api.registerRenderer("toon", renderCommandResult);
      api.registerRenderer("json", renderCommandResult);
    }

    api.registerCommand({
      name: "ops scan",
      description:
        "Scan a set of pm repositories and produce a per-repo release-readiness snapshot " +
        "(strict TS, changelog, CI/release workflows, pm items, pm-changelog wiring, npm outdated, " +
        "npm audit critical/high, open PRs/issues). Use --repos to pass multiple paths " +
        "(comma-separated or repeatable). --json emits clean JSON; --format markdown emits a table.",
      intent: "audit release readiness across many pm repositories",
      examples: [
        "pm ops scan",
        "pm ops scan --repos ./pm-csv ./pm-github",
        "pm ops scan --repos ./pm-csv,./pm-github --json",
        "pm ops scan --format markdown",
        "pm ops scan --repos ~/container/pm-* --format markdown --output FLEET.md",
      ],
      flags: [
        { long: "--repos", value_name: "paths", description: "Repo paths to scan (comma-separated or repeatable; default: current dir)", list: true },
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options);
        const format = resolveFormat(options);
        const outputPath = readString(options, "output");
        console.error(`pm-ops scan: ${repos.length} repo(s)`);
        const result = scanRepos(repos, (m) => console.error(`  ${m}`));
        console.error(`scan: ${result.summary.ready}/${result.summary.total} ready`);
        return emitResult(result, format, outputPath, () => renderScanMarkdown(result));
      },
    });

    api.registerCommand({
      name: "ops policy",
      description:
        "Validate a policy bundle against repos. Default policy checks: naming " +
        "(^pm-[a-z][a-z0-9-]*$, no pm-ext-/pm-preset- prefixes), required-scripts, required-workflows, " +
        "private-no-runners (private repos must not use GitHub-hosted runners), pm-duplicate-titles " +
        "(no two open items share a title), pm-changelog-wired. --policy <file> loads a JSON bundle " +
        "({ checks: [{ id, severity, repo_filter?, params? }] }). --strict exits non-zero on any failure.",
      intent: "enforce naming/workflow/pm policies across many pm repositories",
      examples: [
        "pm ops policy",
        "pm ops policy --repos ./pm-csv ./pm-github",
        "pm ops policy --policy ./fleet-policy.json --strict",
        "pm ops policy --format markdown",
      ],
      flags: [
        { long: "--repos", value_name: "paths", description: "Repo paths to check (comma-separated or repeatable; default: current dir)", list: true },
        { long: "--policy", value_name: "file", description: "JSON policy bundle overriding the default checks" },
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--strict", description: "Exit non-zero on any failed check (any severity)" },
        { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options);
        const format = resolveFormat(options);
        const strict = readBool(options, "strict");
        const outputPath = readString(options, "output");
        let bundle = DEFAULT_POLICY;
        const policyFile = readString(options, "policy");
        if (policyFile) {
          const loaded = readJsonFile<PolicyBundle>(resolvePath(policyFile));
          if (!loaded || !Array.isArray(loaded.checks)) {
            throw new CommandError(`--policy file "${policyFile}" is not a valid policy bundle (expected { checks: [...] })`, EXIT_CODE.USAGE);
          }
          bundle = loaded;
        }
        console.error(`pm-ops policy: ${repos.length} repo(s), ${bundle.checks.length} check(s)`);
        const result = runPolicy(repos, bundle, (m) => console.error(`  ${m}`));
        console.error(`policy: ${result.summary.passed} passed, ${result.summary.failed} failed`);
        const failed = result.summary.failed > 0;
        // In strict mode with failures, ensure the formatted result is produced
        // (to the --output file if set, else to stdout) BEFORE throwing so
        // users/agents still see which checks failed. The throw itself must
        // happen regardless of --output so CI exit-code gating is never bypassed.
        if (strict && failed) {
          if (outputPath) {
            // emitResult writes the file and returns a summary; discard return.
            emitResult(result, format, outputPath, () => renderPolicyMarkdown(result));
          } else if (format === "markdown") {
            process.stdout.write(`${renderPolicyMarkdown(result)}\n`);
          } else {
            process.stdout.write(jsonOf(result));
          }
          throw new CommandError(`policy: ${result.summary.failed} check(s) failed (strict mode)`, EXIT_CODE.GENERIC_FAILURE);
        }
        return emitResult(result, format, outputPath, () => renderPolicyMarkdown(result));
      },
    });

    api.registerCommand({
      name: "ops verify-release",
      description:
        "Run the release gate matrix per repo: executes `npm run release:check` (or the individual " +
        "typecheck/build/test/audit:prod/pack:dry-run/changelog:check steps when release:check is missing) " +
        "and reports pass/fail with per-step timing. Does NOT publish. Exits non-zero if any repo fails.",
      intent: "run a release gate matrix across many pm repositories",
      examples: [
        "pm ops verify-release",
        "pm ops verify-release --repos ./pm-csv ./pm-github",
        "pm ops verify-release --json",
      ],
      flags: [
        { long: "--repos", value_name: "paths", description: "Repo paths to verify (comma-separated or repeatable; default: current dir)", list: true },
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options);
        const format = resolveFormat(options);
        console.error(`pm-ops verify-release: ${repos.length} repo(s)`);
        const result = verifyRelease(repos, (m) => console.error(`  ${m}`));
        console.error(`verify-release: ${result.summary.passed}/${result.summary.total} repos passed`);
        const failed = result.summary.failed > 0;
        if (format === "json") {
          if (failed) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            throw new CommandError(`verify-release: ${result.summary.failed} repo(s) failed`, EXIT_CODE.GENERIC_FAILURE);
          }
          return renderedCommandResult(`${JSON.stringify(result, null, 2)}\n`);
        }
        if (format === "markdown") {
          const md = renderVerifyReleaseMarkdown(result);
          if (failed) {
            process.stdout.write(md.endsWith("\n") ? md : `${md}\n`);
            throw new CommandError(`verify-release: ${result.summary.failed} repo(s) failed`, EXIT_CODE.GENERIC_FAILURE);
          }
          return renderedCommandResult(md);
        }
        if (failed) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          throw new CommandError(`verify-release: ${result.summary.failed} repo(s) failed`, EXIT_CODE.GENERIC_FAILURE);
        }
        return result;
      },
    });

    api.registerCommand({
      name: "ops report",
      description:
        "Emit a concise fleet report combining scan + policy results. --format markdown produces " +
        "a PR/issue-ready summary table. --output writes the report to a file. Default stdout TOON.",
      intent: "produce a concise fleet report across many pm repositories",
      examples: [
        "pm ops report",
        "pm ops report --repos ./pm-csv ./pm-github --format markdown",
        "pm ops report --format markdown --output FLEET.md",
        "pm ops report --json",
      ],
      flags: [
        { long: "--repos", value_name: "paths", description: "Repo paths to report on (comma-separated or repeatable; default: current dir)", list: true },
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--output", value_name: "file", description: "Write the rendered report to a file instead of stdout" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options);
        const format = resolveFormat(options);
        const outputPath = readString(options, "output");
        console.error(`pm-ops report: ${repos.length} repo(s)`);
        const result = buildReport(repos, (m) => console.error(`  ${m}`));
        console.error(`report: scan ${result.scan.summary.ready}/${result.scan.summary.total} ready; policy ${result.policy.summary.failed} failed`);
        return emitResult(result, format, outputPath, () => renderReportMarkdown(result));
      },
    });
  },
});

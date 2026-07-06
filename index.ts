import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, basename, join, relative } from "node:path";
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

function resolveRepos(options: Record<string, unknown>): string[] {
  const repos = asArray(options["repos"]);
  if (repos.length > 0) return repos.map((r) => resolve(r));
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

/**
 * Spawn a subprocess without a shell.
 *
 * When the command is `npm` or `npx` we set `npm_config_userconfig=/dev/null`
 * in the child environment.  This prevents npm 11+ from reading the user-level
 * `.npmrc` (which may contain `allow-scripts=…`) and forwarding that config to
 * nested `npm` invocations as an env var.  When a script like `release:check`
 * itself calls `npm audit`, the nested npm sees the inherited
 * `npm_config_allow_scripts` env var, treats it as a CLI-level override, and
 * rejects it with EALLOWSCRIPTS ("--allow-scripts is not allowed in
 * project-scoped installs").  Pointing userconfig at /dev/null breaks the
 * chain: the parent npm never loads the `allow-scripts` line, so it never
 * injects the env var into child scripts.
 *
 * The auth token that typically lives in `~/.npmrc` is NOT needed for the
 * operations pm-ops runs (typecheck, build, test, audit, pack:dry-run,
 * changelog:check, outdated) — all of which operate on local or public-registry
 * data.
 */
function runSync(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string | undefined> } = {}): SyncResult {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env };
  if (cmd === "npm" || cmd === "npx") {
    // Prevent npm from reading the user-level .npmrc (which may contain
    // allow-scripts=…) so it never injects that config into child scripts.
    env.npm_config_userconfig = "/dev/null";
    // Also strip any inherited npm_config_allow_scripts env var that a parent
    // `npm run` may have set — without this the child npm sees it as a
    // CLI-level override and rejects it with EALLOWSCRIPTS.
    delete env.npm_config_allow_scripts;
  }
  const r = spawnSync(cmd, args, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    env,
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

interface PkgJson {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(repoPath: string): PkgJson | undefined {
  return readJsonFile<PkgJson>(join(repoPath, "package.json"));
}

interface TsConfigJson {
  compilerOptions?: { strict?: boolean };
}

function readTsConfigStrict(repoPath: string): boolean {
  const cfg = readJsonFile<TsConfigJson>(join(repoPath, "tsconfig.json"));
  return cfg?.compilerOptions?.strict === true;
}

// ---------------------------------------------------------------------------
// pm / npm / gh probes
// ---------------------------------------------------------------------------

interface PmItem {
  id: string;
  title?: string;
  status?: string;
}

function readPmItems(repoPath: string): PmItem[] | null {
  const pmRoot = join(repoPath, ".agents", "pm");
  if (!existsSync(pmRoot)) return null;
  const r = runSync("pm", ["list", "--json", "--pm-path", pmRoot]);
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
  const pkg = readPackageJson(repoPath);
  const name = pkg?.name ?? null;
  const version = pkg?.version ?? null;
  const strict_ts = readTsConfigStrict(repoPath);
  const has_changelog = existsSync(join(repoPath, "CHANGELOG.md"));
  const has_release_workflow = existsSync(join(repoPath, ".github", "workflows", "release.yml"));
  const has_ci = existsSync(join(repoPath, ".github", "workflows", "ci.yml"));
  const has_pm_changelog = Boolean(pkg?.devDependencies && "pm-changelog" in pkg.devDependencies);

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

const DEFAULT_POLICY: PolicyBundle = {
  checks: [
    { id: "naming", severity: "error" },
    { id: "required-scripts", severity: "error", params: { scripts: ["typecheck", "test", "build", "release:check", "changelog", "changelog:check"] } },
    { id: "required-workflows", severity: "error", params: { workflows: ["ci.yml", "release.yml"] } },
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
      const content = readFileSync(join(wfDir, file), "utf-8");
      for (const line of content.split("\n")) {
        const m = line.match(/^\s*runs-on:\s*(.+?)\s*$/);
        if (m && RUNNER_PATTERN.test(m[1])) violations.push(`${file}: ${m[0].trim()}`);
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
  const hasDep = Boolean(pkg?.devDependencies && "pm-changelog" in pkg.devDependencies);
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
  switch (def.id) {
    case "naming":
      return checkNaming(ctx.pkg?.name ?? null);
    case "required-scripts":
      return checkRequiredScripts(ctx.pkg, (def.params?.scripts as string[]) ?? DEFAULT_POLICY.checks[1]!.params!.scripts as string[]);
    case "required-workflows":
      return checkRequiredWorkflows(ctx.repoPath, (def.params?.workflows as string[]) ?? ["ci.yml", "release.yml"]);
    case "private-no-runners":
      return checkPrivateNoRunners(ctx.repoPath);
    case "pm-duplicate-titles":
      return checkPmDuplicateTitles(ctx.items);
    case "pm-changelog-wired":
      return checkPmChangelogWired(ctx.pkg);
    default:
      return { id: def.id, severity: def.severity, pass: false, message: `unknown check id "${def.id}"` };
  }
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

/**
 * Extract a concise, human-readable error reason from npm stdout/stderr.
 * npm errors typically include `npm error code XXX` and a message line;
 * we surface the code + message so the user sees *why* a check failed
 * without having to scroll through full build output.
 */
function summarizeNpmError(stdout: string, stderr: string, args: string[]): string {
  const combined = `${stderr}\n${stdout}`.trim();
  if (!combined) return `npm ${args.join(" ")} exited non-zero (no output)`;
  // Extract npm error code and message
  const codeMatch = combined.match(/npm error code (\S+)/);
  const msgMatch = combined.match(/npm error\n(.+)/);
  if (codeMatch && msgMatch) {
    return `[${codeMatch[1]}] ${msgMatch[1].trim()}`;
  }
  if (codeMatch) {
    return `npm error code ${codeMatch[1]}`;
  }
  // Fall back to last non-trivial lines of stderr
  const lines = combined.split("\n").filter((l) => l.trim() && !l.startsWith(">"));
  return lines.slice(-3).join(" | ").slice(-2000);
}

function runReleaseCheck(repoPath: string, name: string, args: string[], progress: (msg: string) => void): ReleaseCheck {
  progress(`verify ${relative(process.cwd(), repoPath) || repoPath}: ${name}`);
  const start = Date.now();
  const r = runSync("npm", args, { cwd: repoPath, timeoutMs: 5 * 60_000 });
  const duration_ms = Date.now() - start;
  const pass = r.status === 0;
  const error = pass ? undefined : summarizeNpmError(r.stdout, r.stderr, args);
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
        (c.error ?? "").replace(/\|/g, "\\|").slice(0, 200),
      ]));
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// status — quick fleet overview
// ---------------------------------------------------------------------------

interface RepoStatus {
  path: string;
  name: string | null;
  version: string | null;
  ready: boolean;
  issues: string[];
  pm_open_items: number | null;
  audit_critical: number | null;
  audit_high: number | null;
  outdated_count: number | null;
}

interface StatusResult {
  repos: RepoStatus[];
  summary: { total: number; ready: number; not_ready: number; total_issues: number };
}

function collectStatus(repoPath: string): RepoStatus {
  const pkg = readPackageJson(repoPath);
  const name = pkg?.name ?? null;
  const version = pkg?.version ?? null;
  const issues: string[] = [];

  const strict_ts = readTsConfigStrict(repoPath);
  if (!strict_ts) issues.push("strict TS not enabled");

  const has_changelog = existsSync(join(repoPath, "CHANGELOG.md"));
  if (!has_changelog) issues.push("no CHANGELOG.md");

  const has_release_workflow = existsSync(join(repoPath, ".github", "workflows", "release.yml"));
  if (!has_release_workflow) issues.push("no release workflow");

  const has_ci = existsSync(join(repoPath, ".github", "workflows", "ci.yml"));
  if (!has_ci) issues.push("no CI workflow");

  const has_pm_changelog = Boolean(pkg?.devDependencies && "pm-changelog" in pkg.devDependencies);
  if (!has_pm_changelog) issues.push("pm-changelog not wired");

  let outdated_count: number | null = null;
  try { outdated_count = countOutdated(repoPath); } catch { /* ignore */ }

  let audit_critical: number | null = null;
  let audit_high: number | null = null;
  try {
    const a = readAudit(repoPath);
    audit_critical = a.critical;
    audit_high = a.high;
  } catch { /* ignore */ }

  if (audit_critical !== null && audit_critical > 0) issues.push(`${audit_critical} critical vuln(s)`);
  if (audit_high !== null && audit_high > 0) issues.push(`${audit_high} high vuln(s)`);

  const items = readPmItems(repoPath);
  const pm_open_items = items ? items.filter((i) => (i.status ?? "").toLowerCase() === "open").length : null;

  const ready = issues.length === 0;

  return { path: repoPath, name, version, ready, issues, pm_open_items, audit_critical, audit_high, outdated_count };
}

function collectStatusAll(repos: string[], progress: (msg: string) => void): StatusResult {
  const results = repos.map((repo) => {
    progress(`status ${repo}`);
    return collectStatus(repo);
  });
  const ready = results.filter((r) => r.ready).length;
  const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);
  return { repos: results, summary: { total: results.length, ready, not_ready: results.length - ready, total_issues: totalIssues } };
}

function renderStatusMarkdown(result: StatusResult): string {
  const lines: string[] = [];
  lines.push("# pm-ops status");
  lines.push("");
  lines.push(`Fleet: **${result.summary.total}** repo(s) — **${result.summary.ready}** ready, **${result.summary.not_ready}** not ready, **${result.summary.total_issues}** issue(s).`);
  lines.push("");
  lines.push(renderMarkdownRow(["repo", "version", "ready", "open items", "outdated", "critical", "high", "issues"]));
  lines.push(renderMarkdownRow(["---", "---", "---", "---", "---", "---", "---", "---"]));
  for (const r of result.repos) {
    lines.push(renderMarkdownRow([
      r.name ?? basename(r.path),
      r.version ?? "-",
      r.ready ? "yes" : "no",
      formatCount(r.pm_open_items),
      formatCount(r.outdated_count),
      formatCount(r.audit_critical),
      formatCount(r.audit_high),
      r.issues.length === 0 ? "-" : r.issues.join("; ").replace(/\|/g, "\\|").slice(0, 200),
    ]));
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// outdated — dependency freshness across repos
// ---------------------------------------------------------------------------

interface OutdatedEntry {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  type: string;
}

interface RepoOutdated {
  path: string;
  name: string | null;
  outdated: OutdatedEntry[];
  count: number;
}

interface OutdatedResult {
  repos: RepoOutdated[];
  summary: { total: number; repos_with_outdated: number; total_outdated: number };
}

function collectOutdatedRepo(repoPath: string): RepoOutdated {
  const pkg = readPackageJson(repoPath);
  const r = runSync("npm", ["outdated", "--json"], { cwd: repoPath, timeoutMs: 60_000 });
  const entries: OutdatedEntry[] = [];
  if (r.status !== 0 && r.status !== 1) {
    // npm outdated exits 0 if no outdated, 1 if some outdated
    return { path: repoPath, name: pkg?.name ?? null, outdated: [], count: 0 };
  }
  const parsed = parseJsonSafe(r.stdout) as Record<string, any> | undefined;
  if (parsed && typeof parsed === "object") {
    for (const [name, info] of Object.entries(parsed)) {
      if (info && typeof info === "object") {
        entries.push({
          name,
          current: String(info.current ?? "-"),
          wanted: String(info.wanted ?? "-"),
          latest: String(info.latest ?? "-"),
          type: String(info.type ?? "-"),
        });
      }
    }
  }
  return { path: repoPath, name: pkg?.name ?? null, outdated: entries, count: entries.length };
}

function collectOutdatedAll(repos: string[], progress: (msg: string) => void): OutdatedResult {
  const results = repos.map((repo) => {
    progress(`outdated ${repo}`);
    return collectOutdatedRepo(repo);
  });
  const withOutdated = results.filter((r) => r.count > 0).length;
  const totalOutdated = results.reduce((sum, r) => sum + r.count, 0);
  return { repos: results, summary: { total: results.length, repos_with_outdated: withOutdated, total_outdated: totalOutdated } };
}

function renderOutdatedMarkdown(result: OutdatedResult): string {
  const lines: string[] = [];
  lines.push("# pm-ops outdated");
  lines.push("");
  lines.push(`Checked **${result.summary.total}** repo(s): **${result.summary.repos_with_outdated}** have outdated deps, **${result.summary.total_outdated}** total outdated package(s).`);
  lines.push("");
  for (const repo of result.repos) {
    if (repo.count === 0) continue;
    lines.push(`## ${repo.name ?? basename(repo.path)}`);
    lines.push("");
    lines.push(renderMarkdownRow(["package", "current", "wanted", "latest", "type"]));
    lines.push(renderMarkdownRow(["---", "---", "---", "---", "---"]));
    for (const e of repo.outdated) {
      lines.push(renderMarkdownRow([e.name, e.current, e.wanted, e.latest, e.type]));
    }
    lines.push("");
  }
  if (result.summary.total_outdated === 0) {
    lines.push("All dependencies are up to date.");
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// audit — security vulnerability summary across repos
// ---------------------------------------------------------------------------

interface RepoAudit {
  path: string;
  name: string | null;
  critical: number | null;
  high: number | null;
  moderate: number | null;
  low: number | null;
  total: number | null;
  ok: boolean;
}

interface AuditResult {
  repos: RepoAudit[];
  summary: { total: number; clean: number; with_vulns: number; total_critical: number; total_high: number };
}

function collectAuditRepo(repoPath: string): RepoAudit {
  const pkg = readPackageJson(repoPath);
  const r = runSync("npm", ["audit", "--omit=dev", "--json"], { cwd: repoPath, timeoutMs: 60_000 });
  if (r.error) {
    return { path: repoPath, name: pkg?.name ?? null, critical: null, high: null, moderate: null, low: null, total: null, ok: false };
  }
  const parsed = parseJsonSafe(r.stdout) as any;
  const v = parsed?.metadata?.vulnerabilities;
  if (!v) {
    return { path: repoPath, name: pkg?.name ?? null, critical: null, high: null, moderate: null, low: null, total: null, ok: false };
  }
  const critical = v.critical ?? 0;
  const high = v.high ?? 0;
  const moderate = v.moderate ?? 0;
  const low = v.low ?? 0;
  const total = v.total ?? 0;
  return { path: repoPath, name: pkg?.name ?? null, critical, high, moderate, low, total, ok: total === 0 };
}

function collectAuditAll(repos: string[], progress: (msg: string) => void): AuditResult {
  const results = repos.map((repo) => {
    progress(`audit ${repo}`);
    return collectAuditRepo(repo);
  });
  const clean = results.filter((r) => r.ok).length;
  const withVulns = results.filter((r) => r.total !== null && r.total > 0).length;
  const totalCritical = results.reduce((s, r) => s + (r.critical ?? 0), 0);
  const totalHigh = results.reduce((s, r) => s + (r.high ?? 0), 0);
  return { repos: results, summary: { total: results.length, clean, with_vulns: withVulns, total_critical: totalCritical, total_high: totalHigh } };
}

function renderAuditMarkdown(result: AuditResult): string {
  const lines: string[] = [];
  lines.push("# pm-ops audit");
  lines.push("");
  lines.push(`Audited **${result.summary.total}** repo(s): **${result.summary.clean}** clean, **${result.summary.with_vulns}** with vulnerabilities.`);
  lines.push(`Total: **${result.summary.total_critical}** critical, **${result.summary.total_high}** high.`);
  lines.push("");
  lines.push(renderMarkdownRow(["repo", "critical", "high", "moderate", "low", "total", "status"]));
  lines.push(renderMarkdownRow(["---", "---", "---", "---", "---", "---", "---"]));
  for (const r of result.repos) {
    lines.push(renderMarkdownRow([
      r.name ?? basename(r.path),
      formatCount(r.critical),
      formatCount(r.high),
      formatCount(r.moderate),
      formatCount(r.low),
      formatCount(r.total),
      r.total === null ? "?" : r.ok ? "clean" : "vulns",
    ]));
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
  release?: VerifyReleaseResult;
}

function buildReport(repos: string[], progress: (msg: string) => void, includeRelease: boolean = false): ReportResult {
  const scan = scanRepos(repos, progress);
  const policy = runPolicy(repos, DEFAULT_POLICY, progress);
  const release = includeRelease ? verifyRelease(repos, progress) : undefined;
  return { generated_at: new Date().toISOString(), scan, policy, release };
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
  const sections: string[] = [];
  // Header with timestamp
  sections.push(`# pm-ops Fleet Report`);
  sections.push("");
  sections.push(`_Generated: ${result.generated_at}_`);
  sections.push("");
  sections.push("");
  // Scan section
  sections.push(renderScanMarkdown(result.scan));
  sections.push("");
  // Policy section
  sections.push(renderPolicyMarkdown(result.policy));
  if (result.release) {
    sections.push("");
    sections.push(renderVerifyReleaseMarkdown(result.release));
  }
  return sections.join("\n");
}

function emitResult(structured: unknown, format: OutputFormat, outputPath: string | undefined, formatter: () => string): unknown {
  if (outputPath) {
    const body = format === "toon" ? `${JSON.stringify(structured, null, 2)}\n` : formatter();
    writeFileSync(outputPath, body, "utf-8");
    console.error(`pm-ops: wrote ${format} output to ${outputPath}`);
    return { written_to: outputPath, format };
  }
  if (format === "toon") return structured;
  if (format === "json") return renderedCommandResult(`${JSON.stringify(structured, null, 2)}\n`);
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
          const loaded = readJsonFile<PolicyBundle>(resolve(policyFile));
          if (!loaded || !Array.isArray(loaded.checks)) {
            throw new CommandError(`--policy file "${policyFile}" is not a valid policy bundle (expected { checks: [...] })`, EXIT_CODE.USAGE);
          }
          bundle = loaded;
        }
        console.error(`pm-ops policy: ${repos.length} repo(s), ${bundle.checks.length} check(s)`);
        const result = runPolicy(repos, bundle, (m) => console.error(`  ${m}`));
        console.error(`policy: ${result.summary.passed} passed, ${result.summary.failed} failed`);
        const out = emitResult(result, format, outputPath, () => renderPolicyMarkdown(result));
        if (strict && result.summary.failed > 0) {
          throw new CommandError(`policy: ${result.summary.failed} check(s) failed (strict mode)`, EXIT_CODE.GENERIC_FAILURE);
        }
        return out;
      },
    });

    api.registerCommand({
      name: "ops verify-release",
      description:
        "Run the release gate matrix per repo: executes `npm run release:check` (or the individual " +
        "typecheck/build/test/audit:prod/pack:dry-run/changelog:check steps when release:check is missing) " +
        "and reports pass/fail with per-step timing and concise error summaries. Does NOT publish. " +
        "Exits non-zero if any repo fails. --output writes the report to a file.",
      intent: "run a release gate matrix across many pm repositories",
      examples: [
        "pm ops verify-release",
        "pm ops verify-release --repos ./pm-csv ./pm-github",
        "pm ops verify-release --json",
        "pm ops verify-release --format markdown --output RELEASE.md",
      ],
      flags: [
        { long: "--repos", value_name: "paths", description: "Repo paths to verify (comma-separated or repeatable; default: current dir)", list: true },
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options);
        const format = resolveFormat(options);
        const outputPath = readString(options, "output");
        console.error(`pm-ops verify-release: ${repos.length} repo(s)`);
        const result = verifyRelease(repos, (m) => console.error(`  ${m}`));
        console.error(`verify-release: ${result.summary.passed}/${result.summary.total} repos passed`);
        const failed = result.summary.failed > 0;
        if (failed) {
          // Log a concise summary of which repos failed and why
          for (const repo of result.repos) {
            if (repo.failed > 0) {
              const failedChecks = repo.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${(c.error ?? "unknown").slice(0, 120)}`);
              console.error(`  FAIL ${repo.name ?? basename(repo.path)}: ${failedChecks.join("; ")}`);
            }
          }
        }
        if (outputPath) {
          const body = format === "toon" ? `${JSON.stringify(result, null, 2)}\n` : renderVerifyReleaseMarkdown(result);
          writeFileSync(outputPath, body, "utf-8");
          console.error(`pm-ops: wrote ${format} output to ${outputPath}`);
          if (failed) throw new CommandError(`verify-release: ${result.summary.failed} repo(s) failed`, EXIT_CODE.GENERIC_FAILURE);
          return { written_to: outputPath, format };
        }
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
        "Emit a concise fleet report combining scan + policy results (and optionally verify-release). " +
        "--format markdown produces a PR/issue-ready summary table with timestamp header. " +
        "--include-release also runs the release gate matrix and appends results. " +
        "--output writes the report to a file. Default stdout TOON.",
      intent: "produce a concise fleet report across many pm repositories",
      examples: [
        "pm ops report",
        "pm ops report --repos ./pm-csv ./pm-github --format markdown",
        "pm ops report --format markdown --output FLEET.md",
        "pm ops report --format markdown --include-release --output FLEET.md",
        "pm ops report --json",
      ],
      flags: [
        { long: "--repos", value_name: "paths", description: "Repo paths to report on (comma-separated or repeatable; default: current dir)", list: true },
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--output", value_name: "file", description: "Write the rendered report to a file instead of stdout" },
        { long: "--include-release", description: "Also run verify-release and include results in the report" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options);
        const format = resolveFormat(options);
        const outputPath = readString(options, "output");
        const includeRelease = readBool(options, "include-release");
        console.error(`pm-ops report: ${repos.length} repo(s)${includeRelease ? " (+release)" : ""}`);
        const result = buildReport(repos, (m) => console.error(`  ${m}`), includeRelease);
        console.error(`report: scan ${result.scan.summary.ready}/${result.scan.summary.total} ready; policy ${result.policy.summary.failed} failed${result.release ? `; release ${result.release.summary.passed}/${result.release.summary.total} passed` : ""}`);
        return emitResult(result, format, outputPath, () => renderReportMarkdown(result));
      },
    });

    // --- New fleet operations commands ---

    api.registerCommand({
      name: "ops status",
      description:
        "Quick fleet status overview: for each repo shows name, version, ready/not-ready, " +
        "open pm items, outdated deps, and critical/high vulnerabilities. Faster than scan " +
        "because it skips GitHub PR/issue probes and pm workspace detail. --format markdown " +
        "emits a compact table.",
      intent: "get a quick fleet health overview across many pm repositories",
      examples: [
        "pm ops status",
        "pm ops status --repos ./pm-csv ./pm-github",
        "pm ops status --format markdown",
      ],
      flags: [
        { long: "--repos", value_name: "paths", description: "Repo paths (comma-separated or repeatable; default: current dir)", list: true },
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options);
        const format = resolveFormat(options);
        const outputPath = readString(options, "output");
        console.error(`pm-ops status: ${repos.length} repo(s)`);
        const result = collectStatusAll(repos, (m) => console.error(`  ${m}`));
        console.error(`status: ${result.summary.ready}/${result.summary.total} ready, ${result.summary.total_issues} issue(s)`);
        return emitResult(result, format, outputPath, () => renderStatusMarkdown(result));
      },
    });

    api.registerCommand({
      name: "ops outdated",
      description:
        "Check outdated dependencies across repos. Runs `npm outdated --json` per repo and " +
        "summarizes packages that have newer versions available. --format markdown groups " +
        "by repo with per-package current/wanted/latest columns.",
      intent: "check dependency freshness across many pm repositories",
      examples: [
        "pm ops outdated",
        "pm ops outdated --repos ./pm-csv ./pm-github",
        "pm ops outdated --format markdown",
      ],
      flags: [
        { long: "--repos", value_name: "paths", description: "Repo paths (comma-separated or repeatable; default: current dir)", list: true },
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options);
        const format = resolveFormat(options);
        const outputPath = readString(options, "output");
        console.error(`pm-ops outdated: ${repos.length} repo(s)`);
        const result = collectOutdatedAll(repos, (m) => console.error(`  ${m}`));
        console.error(`outdated: ${result.summary.repos_with_outdated}/${result.summary.total} repos with outdated, ${result.summary.total_outdated} total`);
        return emitResult(result, format, outputPath, () => renderOutdatedMarkdown(result));
      },
    });

    api.registerCommand({
      name: "ops audit",
      description:
        "Security vulnerability audit across repos. Runs `npm audit --omit=dev --json` per repo " +
        "and summarizes critical/high/moderate/low counts. --format markdown emits a compact " +
        "fleet-wide vulnerability table.",
      intent: "audit security vulnerabilities across many pm repositories",
      examples: [
        "pm ops audit",
        "pm ops audit --repos ./pm-csv ./pm-github",
        "pm ops audit --format markdown",
      ],
      flags: [
        { long: "--repos", value_name: "paths", description: "Repo paths (comma-separated or repeatable; default: current dir)", list: true },
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options);
        const format = resolveFormat(options);
        const outputPath = readString(options, "output");
        console.error(`pm-ops audit: ${repos.length} repo(s)`);
        const result = collectAuditAll(repos, (m) => console.error(`  ${m}`));
        console.error(`audit: ${result.summary.clean}/${result.summary.total} clean, ${result.summary.total_critical} critical, ${result.summary.total_high} high`);
        return emitResult(result, format, outputPath, () => renderAuditMarkdown(result));
      },
    });
  },
});

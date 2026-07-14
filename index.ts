import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull, homedir } from "node:os";
import { resolve, basename, dirname, join, relative } from "node:path";
import type {
  defineExtension as defineExtensionType,
  ParserOverrideContext,
  ParserOverrideDelta,
} from "@unbrained/pm-cli/sdk";

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

const OPS_COMMAND_PATHS = [
  "ops scan",
  "ops policy",
  "ops verify-release",
  "ops report",
  "ops status",
  "ops outdated",
  "ops audit",
  "ops metrics",
] as const;

function additionalRepoArguments() {
  return [{
    name: "additional-repos",
    required: false,
    variadic: true,
    description: "Additional repository paths after --repos (optional).",
  }];
}

function reposFlag(description: string) {
  return {
    long: "--repos",
    value_name: "paths",
    value_type: "string" as const,
    description,
    list: true,
  };
}

function cliRepoFlagValues(commandPath: string, argv: readonly string[] = process.argv.slice(2)): string[] {
  const commandTokens = commandPath.split(" ");
  let commandEnd = -1;
  for (let index = 0; index <= argv.length - commandTokens.length; index += 1) {
    if (commandTokens.every((token, offset) => argv[index + offset] === token)) {
      commandEnd = index + commandTokens.length;
      break;
    }
  }
  if (commandEnd < 0) return [];

  const values: string[] = [];
  for (let index = commandEnd; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") break;
    if (token.startsWith("--repos=")) {
      const value = token.slice("--repos=".length).trim();
      if (value) values.push(value);
      continue;
    }
    if (token !== "--repos") continue;
    const value = argv[index + 1];
    if (value && value !== "--" && !value.startsWith("--")) {
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function restoreCliRepoFlag(commandPath: string, context: ParserOverrideContext): ParserOverrideDelta {
  const cliValues = cliRepoFlagValues(commandPath);
  if (cliValues.length === 0) return {};
  // argv is authoritative for a CLI invocation's --repos flag: it captures the
  // complete repeated / `=`-joined set. Commander (pm-cli 2026.7.x) either
  // erases registered list values entirely (#550) or collapses repeated flags
  // to the last value, so `context.options.repos` may be empty OR a truncated
  // tail. Restore the full argv-derived set whenever it differs from what
  // Commander retained. Structured SDK/MCP callers never populate process.argv,
  // so cliValues stays empty for them and their supplied options are untouched.
  const restored = cliValues.flatMap((value) => asArray(value));
  const current = asArray(context.options.repos);
  if (current.length === restored.length && restored.every((value, index) => current[index] === value)) return {};
  return { options: { ...context.options, repos: restored } };
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path;
}

function hasGlob(path: string): boolean {
  return /[*?\[]/.test(path);
}

function escapeRegexChar(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

function globSegmentToRegex(segment: string): RegExp {
  let pattern = "";
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]!;
    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }
    if (char === "?") {
      pattern += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = segment.indexOf("]", i + 1);
      const content = end > i + 1 ? segment.slice(i + 1, end) : "";
      if (content && !content.includes("/")) {
        pattern += `[${content.replace(/\\/g, "\\\\").replace(/\^/g, "\\^")}]`;
        i = end;
        continue;
      }
    }
    pattern += escapeRegexChar(char);
  }
  return new RegExp(`^${pattern}$`);
}

function expandSimpleGlob(pattern: string): string[] {
  const expanded = expandHome(pattern);
  const absolute = /^[A-Za-z]:[\\/]/.test(expanded) ? expanded : resolve(expanded);
  if (!hasGlob(absolute)) return [absolute];
  const driveRoot = /^[A-Za-z]:[\\/]/.exec(absolute)?.[0];
  const root = absolute.startsWith("/") ? "/" : driveRoot ? driveRoot.slice(0, 3) : process.cwd();
  let segments = absolute.split(/[\\/]+/).filter(Boolean);
  if (driveRoot && segments[0]?.toLowerCase() === driveRoot.slice(0, 2).toLowerCase()) {
    segments = segments.slice(1);
  }
  let candidates = [root];
  for (const segment of segments) {
    const next: string[] = [];
    const segmentHasGlob = hasGlob(segment);
    const matcher = segmentHasGlob ? globSegmentToRegex(segment) : null;
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      if (!segmentHasGlob) {
        next.push(join(candidate, segment));
        continue;
      }
      for (const entry of readdirSync(candidate, { withFileTypes: true })) {
        if (matcher?.test(entry.name)) next.push(join(candidate, entry.name));
      }
    }
    candidates = next;
  }
  // Sort matches so glob-expanded repo lists (and any fleet report built from
  // them) are deterministic across filesystems whose readdir order is not
  // guaranteed — important for stable, diff-friendly agent output.
  return candidates.length > 0 ? [...candidates].sort() : [absolute];
}

function resolveRepos(options: Record<string, unknown>, args: unknown[] = []): string[] {
  const repos = [...asArray(options["repos"]), ...asArray(args)];
  if (repos.length > 0) return repos.flatMap((r) => expandSimpleGlob(r));
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

interface CommandInvocation {
  cmd: string;
  args: string[];
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
  const command = process.platform === "win32" && ["npm", "npx", "pm"].includes(cmd) ? `${cmd}.cmd` : cmd;
  if (cmd === "npm" || cmd === "npx") {
    // Prevent npm from reading the user-level .npmrc (which may contain
    // allow-scripts=…) so it never injects that config into child scripts.
    env.npm_config_userconfig = devNull;
    env.NPM_CONFIG_USERCONFIG = devNull;
    // Also strip any inherited npm_config_allow_scripts env var that a parent
    // `npm run` may have set — without this the child npm sees it as a
    // CLI-level override and rejects it with EALLOWSCRIPTS.
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "npm_config_allow_scripts") delete env[key];
    }
  }
  const r = spawnSync(command, args, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    env,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

let pmInvocationCache: CommandInvocation | null = null;

function resolvePmInvocation(): CommandInvocation {
  if (pmInvocationCache) return pmInvocationCache;
  const command = process.platform === "win32" ? "pm.cmd" : "pm";
  const probe = spawnSync(command, ["--version"], { encoding: "utf-8", timeout: 5_000 });
  if (!probe.error && probe.status === 0) {
    pmInvocationCache = { cmd: "pm", args: [] };
    return pmInvocationCache;
  }
  const script = process.argv[1];
  pmInvocationCache = script ? { cmd: process.execPath, args: [script] } : { cmd: "pm", args: [] };
  return pmInvocationCache;
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

function stripJsonc(input: string): string {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    const next = input[i + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      i += 1;
      output += " ";
      continue;
    }
    output += char;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
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

function hasPmChangelogDep(pkg: PkgJson | undefined): boolean {
  return Boolean((pkg?.devDependencies && "pm-changelog" in pkg.devDependencies) || (pkg?.dependencies && "pm-changelog" in pkg.dependencies));
}

interface TsConfigJson {
  extends?: string | string[];
  compilerOptions?: { strict?: boolean };
}

function resolveExtendsPath(currentFile: string, value: string): string {
  const withExtension = value.endsWith(".json") ? value : `${value}.json`;
  if (value.startsWith(".") || value.startsWith("/") || value.startsWith("~")) {
    return resolve(dirname(currentFile), expandHome(withExtension));
  }
  const requireFromConfig = createRequire(currentFile);
  try {
    return requireFromConfig.resolve(value);
  } catch {
    try {
      return requireFromConfig.resolve(withExtension);
    } catch {
      return resolve(dirname(currentFile), "node_modules", withExtension);
    }
  }
}

function readTsConfigStrictSetting(path: string, seen = new Set<string>()): boolean | null {
  const resolved = resolve(path);
  if (seen.has(resolved)) return null;
  seen.add(resolved);
  const cfg = readJsoncFile<TsConfigJson>(resolved);
  if (!cfg) return null;
  if (cfg.compilerOptions?.strict === true) return true;
  if (cfg.compilerOptions?.strict === false) return false;
  if (Array.isArray(cfg.extends)) {
    for (const entry of [...cfg.extends].reverse()) {
      if (typeof entry !== "string") continue;
      const inherited = readTsConfigStrictSetting(resolveExtendsPath(resolved, entry), seen);
      if (inherited !== null) return inherited;
    }
    return null;
  }
  if (typeof cfg.extends === "string") return readTsConfigStrictSetting(resolveExtendsPath(resolved, cfg.extends), seen);
  return null;
}

function readTsConfigStrict(repoPath: string): boolean {
  return readTsConfigStrictSetting(join(repoPath, "tsconfig.json")) === true;
}

// ---------------------------------------------------------------------------
// pm / npm / gh probes
// ---------------------------------------------------------------------------

interface PmItem {
  id: string;
  title?: string;
  status?: string;
}

/** Superset of PmItem carrying the lifecycle fields metrics needs. */
interface FullPmItem extends PmItem {
  type?: string;
  priority?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  tags?: unknown;
}

const pmItemsCache = new Map<string, PmItem[] | null>();
const pmAllItemsCache = new Map<string, FullPmItem[] | null>();
const pmBlockedCache = new Map<string, PmItem[] | null>();

/** Per-scrape read caches. Cleared together so a fresh scrape re-reads pm. */
const PM_READ_CACHES: Map<string, unknown>[] = [pmItemsCache, pmAllItemsCache, pmBlockedCache];

/**
 * Read pm items for a repo via one `pm <subcommand> --json` invocation, extract
 * the item array, and memoize the result per repo in the supplied cache. Single
 * implementation shared by the active-list, full-list, and blocked-list readers
 * so their guard / invocation / JSON-extraction / caching logic can't drift
 * (e.g. the cross-scrape cache-clear must cover all of them). Returns null when
 * the workspace is absent or the CLI call fails.
 */
function readPmItemList<T extends PmItem>(repoPath: string, subcommand: string, cache: Map<string, T[] | null>): T[] | null {
  if (cache.has(repoPath)) return cache.get(repoPath) ?? null;
  const set = (value: T[] | null): T[] | null => {
    cache.set(repoPath, value);
    return value;
  };
  const pmRoot = join(repoPath, ".agents", "pm");
  if (!existsSync(pmRoot)) return set(null);
  const pm = resolvePmInvocation();
  const r = runSync(pm.cmd, [...pm.args, subcommand, "--json", "--pm-path", pmRoot], { timeoutMs: 30_000 });
  if (r.status !== 0) return set(null);
  const parsed = parseJsonSafe(r.stdout);
  if (!parsed) return set(null);
  const items = Array.isArray(parsed) ? parsed : (parsed as any).items ?? (parsed as any).results ?? [];
  if (!Array.isArray(items)) return set(null);
  return set(items.filter((it: unknown): it is T => Boolean(it) && typeof it === "object" && typeof (it as PmItem).id === "string"));
}

/** Active pm items via `pm list --json`. */
function readPmItems(repoPath: string): PmItem[] | null {
  return readPmItemList<PmItem>(repoPath, "list", pmItemsCache);
}

/**
 * Every pm item (including closed/canceled) via `pm list-all --json`. Metrics
 * need the closed items for throughput and cycle-time, so this is distinct from
 * readPmItems, which only returns active items.
 */
function readAllPmItems(repoPath: string): FullPmItem[] | null {
  return readPmItemList<FullPmItem>(repoPath, "list-all", pmAllItemsCache);
}

/**
 * Count items the pm CLI itself considers blocked (open with unresolved
 * blocked_by edges). Delegating to `pm list-blocked` reuses the CLI's own
 * dependency-resolution logic rather than re-deriving it from the flat list.
 */
function readBlockedCount(repoPath: string): number | null {
  const items = readPmItemList<PmItem>(repoPath, "list-blocked", pmBlockedCache);
  return items === null ? null : items.length;
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
  if (!parsed || typeof parsed !== "object") return r.status === 0 ? 0 : null;
  return Object.keys(parsed).length;
}

interface NpmAudit {
  error?: string | { code?: string; summary?: string };
  metadata?: {
    vulnerabilities?: { critical?: number; high?: number; total?: number };
  };
}

function readAudit(repoPath: string): { critical: number | null; high: number | null } {
  if (isOffline()) return { critical: null, high: null };
  const r = runSync("npm", ["audit", "--omit=dev", "--json"], { cwd: repoPath, timeoutMs: 60_000 });
  if (r.error) {
    const detail = summarizeNpmError(r.stdout, r.stderr, ["audit", "--omit=dev", "--json"]);
    throw new Error(`npm audit failed: ${r.error.message}; ${detail}`);
  }
  const parsed = parseJsonSafe(r.stdout) as NpmAudit | undefined;
  if (parsed?.error) {
    if (typeof parsed.error === "string") throw new Error(`npm audit failed: ${parsed.error}`);
    const code = parsed.error.code ?? "unknown";
    const summary = parsed.error.summary ?? "unknown error";
    throw new Error(`npm audit failed: [${code}] ${summary}`);
  }
  const v = parsed?.metadata?.vulnerabilities;
  if (!v) throw new Error(summarizeNpmError(r.stdout, r.stderr, ["audit", "--omit=dev", "--json"]));
  return { critical: v.critical ?? 0, high: v.high ?? 0 };
}

const AUDIT_UNAVAILABLE_PREFIX = "audit unavailable:";

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; summary?: unknown; message?: unknown };
    const code = typeof value.code === "string" ? `[${value.code}] ` : "";
    const message = typeof value.summary === "string" ? value.summary : typeof value.message === "string" ? value.message : "unknown error object";
    return `${code}${message}`;
  }
  return String(error);
}

function auditUnavailable(error: unknown): string {
  return `${AUDIT_UNAVAILABLE_PREFIX} ${describeUnknownError(error)}`;
}

function passesAuditGate(critical: number | null, diagnostics: string[]): boolean {
  return isOffline() || (critical === 0 && !diagnostics.some((entry) => entry.startsWith(AUDIT_UNAVAILABLE_PREFIX)));
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
  if (!existsSync(repoPath)) {
    errors.push("repository directory does not exist");
    return {
      path: repoPath,
      name: basename(repoPath),
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
    errors.push(auditUnavailable(err));
  }

  const open_prs = ghOpenCount(repoPath, "pr");
  const open_issues = ghOpenCount(repoPath, "issue");

  const has_pkg = Boolean(pkg);
  const auditGate = passesAuditGate(audit_critical, errors);
  const ready = has_pkg && strict_ts && has_changelog && has_release_workflow && has_ci && has_pm_changelog && auditGate;

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
const GITHUB_HOSTED_RUNNER_PATTERN = /^(?:github-hosted|macos-[A-Za-z0-9._-]+|windows-[A-Za-z0-9._-]+|ubuntu-[A-Za-z0-9._-]+)$/;

function leadingSpaces(value: string): number {
  return value.match(/^\s*/)?.[0].length ?? 0;
}

function normalizeYamlScalar(value: string): string {
  return value
    .replace(/\s+#.*$/, "")
    .replace(/,$/, "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function hasGithubHostedRunnerScalar(value: string): boolean {
  const normalized = normalizeYamlScalar(value);
  if (!normalized || normalized.includes("${{")) return false;
  if (normalized.startsWith("{") && normalized.endsWith("}")) {
    const labels = normalized.match(/\blabels\s*:\s*(\[[^\]]*\]|[^,}]+)/);
    return labels ? hasGithubHostedRunnerScalar(labels[1]) : false;
  }
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return hasGithubHostedRunnerEntries(normalized.slice(1, -1).split(","));
  }
  return GITHUB_HOSTED_RUNNER_PATTERN.test(normalized);
}

function hasGithubHostedRunnerEntries(values: string[]): boolean {
  const entries = values.map(normalizeYamlScalar).filter(Boolean);
  if (entries.includes("self-hosted")) return false;
  return entries.some((entry) => GITHUB_HOSTED_RUNNER_PATTERN.test(entry));
}

function hasGithubHostedRunsOnValue(inlineValue: string, blockLines: string[]): boolean {
  if (hasGithubHostedRunnerScalar(inlineValue)) return true;
  const directItems: string[] = [];
  const labelItems: string[] = [];
  let inLabels = false;
  for (const line of blockLines) {
    const trimmed = line.trim();
    const item = trimmed.match(/^-\s+(.+)$/);
    const labels = trimmed.match(/^labels:\s*(.*)$/);
    if (labels) {
      if (labels[1].trim() && hasGithubHostedRunnerScalar(labels[1])) return true;
      inLabels = true;
      continue;
    }
    if (item) {
      (inLabels ? labelItems : directItems).push(item[1]);
      continue;
    }
    inLabels = false;
  }
  return directItems.some(hasGithubHostedRunnerScalar) || hasGithubHostedRunnerEntries(labelItems);
}

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
      let content: string;
      try {
        content = readFileSync(join(wfDir, file), "utf-8");
      } catch (err) {
        violations.push(`${file}: unable to read workflow (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      const lines = content.split("\n");
      for (const [index, line] of lines.entries()) {
        const m = line.match(/^\s*runs-on:\s*(.*?)\s*$/);
        if (!m) continue;
        if (hasGithubHostedRunsOnValue(m[1], [])) {
          violations.push(`${file}: ${m[0].trim()}`);
          continue;
        }
        const baseIndent = leadingSpaces(line);
        const valueLines: string[] = [];
        for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
          const nextLine = lines[nextIndex]!;
          if (!nextLine.trim()) continue;
          if (leadingSpaces(nextLine) <= baseIndent) break;
          valueLines.push(nextLine.trim());
        }
        if (hasGithubHostedRunsOnValue("", valueLines)) violations.push(`${file}: runs-on uses a GitHub-hosted runner`);
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
  let result: PolicyCheckResult;
  switch (def.id) {
    case "naming":
      result = checkNaming(ctx.pkg?.name ?? null);
      break;
    case "required-scripts":
      result = checkRequiredScripts(ctx.pkg, (def.params?.scripts as string[]) ?? DEFAULT_REQUIRED_SCRIPTS);
      break;
    case "required-workflows":
      result = checkRequiredWorkflows(ctx.repoPath, (def.params?.workflows as string[]) ?? DEFAULT_REQUIRED_WORKFLOWS);
      break;
    case "private-no-runners":
      result = checkPrivateNoRunners(ctx.repoPath);
      break;
    case "pm-duplicate-titles":
      result = checkPmDuplicateTitles(ctx.items);
      break;
    case "pm-changelog-wired":
      result = checkPmChangelogWired(ctx.pkg);
      break;
    default:
      result = { id: def.id, severity: def.severity, pass: false, message: `unknown check id "${def.id}"` };
  }
  return { ...result, severity: def.severity };
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
  const msgMatch = combined.match(/^npm error (?!code\b|A complete log\b)(.+)$/m);
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
  const error = pass ? undefined : r.error?.message ?? summarizeNpmError(r.stdout, r.stderr, args);
  return { name, pass, duration_ms, error };
}

function verifyReleaseRepo(repoPath: string, progress: (msg: string) => void): RepoRelease {
  if (!existsSync(repoPath)) {
    return {
      path: repoPath,
      name: basename(repoPath),
      checks: [{ name: "release:check", pass: false, duration_ms: 0, error: `repository directory does not exist: ${repoPath}` }],
      passed: 0,
      failed: 1,
    };
  }
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
  if (checks.length === 0) {
    checks = [{ name: "release:check", pass: false, duration_ms: 0, error: "no release gate script found" }];
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
        (c.error ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 200),
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
  if (!existsSync(repoPath)) {
    return {
      path: repoPath,
      name: basename(repoPath),
      version: null,
      ready: false,
      issues: ["repository directory does not exist"],
      pm_open_items: null,
      audit_critical: null,
      audit_high: null,
      outdated_count: null,
    };
  }
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

  const has_pm_changelog = hasPmChangelogDep(pkg);
  if (!has_pm_changelog) issues.push("pm-changelog not wired");

  let outdated_count: number | null = null;
  try { outdated_count = countOutdated(repoPath); } catch { /* ignore */ }

  let audit_critical: number | null = null;
  let audit_high: number | null = null;
  try {
    const a = readAudit(repoPath);
    audit_critical = a.critical;
    audit_high = a.high;
  } catch (err) {
    issues.push(auditUnavailable(err));
  }

  // Critical vulnerabilities gate readiness (matching scanRepo's
  // audit gate). High-severity findings are still pushed to issues for
  // textual visibility but do not block ready, so fleet-health reports
  // from ops status and ops scan stay consistent.
  if (audit_critical !== null && audit_critical > 0) issues.push(`${audit_critical} critical vuln(s)`);
  if (audit_high !== null && audit_high > 0) issues.push(`${audit_high} high vuln(s)`);

  const items = readPmItems(repoPath);
  const pm_open_items = items ? items.filter((i) => (i.status ?? "").toLowerCase() === "open").length : null;

  // ready gates only on critical vulns, not high — aligned with scanRepo.
  const auditGate = passesAuditGate(audit_critical, issues);
  const ready = issues.filter((i) => !i.includes("high vuln")).length === 0 && auditGate;

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
  count: number | null;
  error?: string;
}

interface OutdatedResult {
  repos: RepoOutdated[];
  summary: { total: number; repos_with_outdated: number; total_outdated: number };
}

function collectOutdatedRepo(repoPath: string): RepoOutdated {
  const pkg = readPackageJson(repoPath);
  if (isOffline()) {
    return { path: repoPath, name: pkg?.name ?? null, outdated: [], count: null, error: "offline mode enabled" };
  }
  const r = runSync("npm", ["outdated", "--json"], { cwd: repoPath, timeoutMs: 60_000 });
  if (r.error) {
    return { path: repoPath, name: pkg?.name ?? null, outdated: [], count: null, error: r.error.message };
  }
  const entries: OutdatedEntry[] = [];
  if (r.status !== 0 && r.status !== 1) {
    // npm outdated exits 0 if no outdated, 1 if some outdated
    return { path: repoPath, name: pkg?.name ?? null, outdated: [], count: null, error: summarizeNpmError(r.stdout, r.stderr, ["outdated", "--json"]) };
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
  const withOutdated = results.filter((r) => (r.count ?? 0) > 0).length;
  const totalOutdated = results.reduce((sum, r) => sum + (r.count ?? 0), 0);
  return { repos: results, summary: { total: results.length, repos_with_outdated: withOutdated, total_outdated: totalOutdated } };
}

function renderOutdatedMarkdown(result: OutdatedResult): string {
  const lines: string[] = [];
  lines.push("# pm-ops outdated");
  lines.push("");
  lines.push(`Checked **${result.summary.total}** repo(s): **${result.summary.repos_with_outdated}** have outdated deps, **${result.summary.total_outdated}** total outdated package(s).`);
  lines.push("");
  for (const repo of result.repos) {
    if (repo.count === null) {
      lines.push(`## ${repo.name ?? basename(repo.path)}`);
      lines.push("");
      lines.push(repo.error ? `Unable to check outdated dependencies: ${repo.error}` : "Unable to check outdated dependencies.");
      lines.push("");
      continue;
    }
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
  const unknownCount = result.repos.filter((r) => r.count === null).length;
  if (result.summary.total_outdated === 0 && unknownCount === 0) {
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
  summary: { total: number; clean: number; with_vulns: number; unknown: number; total_critical: number; total_high: number };
}

function collectAuditRepo(repoPath: string): RepoAudit {
  const pkg = readPackageJson(repoPath);
  if (isOffline()) {
    return { path: repoPath, name: pkg?.name ?? null, critical: null, high: null, moderate: null, low: null, total: null, ok: false };
  }
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
  const unknown = results.filter((r) => r.total === null).length;
  const totalCritical = results.reduce((s, r) => s + (r.critical ?? 0), 0);
  const totalHigh = results.reduce((s, r) => s + (r.high ?? 0), 0);
  return { repos: results, summary: { total: results.length, clean, with_vulns: withVulns, unknown, total_critical: totalCritical, total_high: totalHigh } };
}

function renderAuditMarkdown(result: AuditResult): string {
  const lines: string[] = [];
  lines.push("# pm-ops audit");
  lines.push("");
  lines.push(`Audited **${result.summary.total}** repo(s): **${result.summary.clean}** clean, **${result.summary.with_vulns}** with vulnerabilities, **${result.summary.unknown}** unknown.`);
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
  lines.push(renderMarkdownRow(["repo", "version", "strict", "changelog", "release", "ci", "pm-changelog", "open items", "outdated", "critical", "high", "prs", "issues", "ready", "diagnostics"]));
  lines.push(renderMarkdownRow(["---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---"]));
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
      r.errors.length === 0 ? "-" : r.errors.join("; ").replace(/\|/g, "\\|").slice(0, 300),
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

// ---------------------------------------------------------------------------
// ops metrics — Prometheus exposition of pm workspace health
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

const CLOSED_STATUSES = new Set(["closed", "done", "completed", "resolved"]);
const CANCELED_STATUSES = new Set(["canceled", "cancelled", "wontfix", "rejected"]);

interface RepoMetrics {
  path: string;
  repo: string;
  available: boolean;
  status_counts: Record<string, number>;
  type_counts: Record<string, number>;
  priority_counts: Record<string, number>;
  blocked: number | null;
  stale: number;
  throughput_7d: number;
  throughput_30d: number;
  cycle_time_p50_seconds: number | null;
  cycle_time_p90_seconds: number | null;
  backlog_age_p50_seconds: number | null;
  backlog_age_p90_seconds: number | null;
}

interface MetricsResult {
  generated_at: string;
  stale_threshold_days: number;
  repos_scanned: number;
  scrape_duration_seconds: number;
  repos: RepoMetrics[];
}

function normalizeStatus(raw: string | undefined): string {
  const s = (raw ?? "").toLowerCase().trim();
  if (!s) return "unknown";
  if (CLOSED_STATUSES.has(s)) return "closed";
  if (CANCELED_STATUSES.has(s)) return "canceled";
  return s.replace(/[\s-]+/g, "_");
}

/** Nearest-rank percentile over an unsorted numeric array. */
function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = Math.ceil(q * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function computeRepoMetrics(repo: string, nowMs: number, staleThresholdDays: number): RepoMetrics {
  const items = readAllPmItems(repo);
  const name = repoLabel(repo);
  const path = resolve(repo);
  if (items === null) {
    return {
      path,
      repo: name,
      available: false,
      status_counts: {},
      type_counts: {},
      priority_counts: {},
      blocked: null,
      stale: 0,
      throughput_7d: 0,
      throughput_30d: 0,
      cycle_time_p50_seconds: null,
      cycle_time_p90_seconds: null,
      backlog_age_p50_seconds: null,
      backlog_age_p90_seconds: null,
    };
  }

  const status_counts: Record<string, number> = {};
  const type_counts: Record<string, number> = {};
  const priority_counts: Record<string, number> = {};
  const staleThresholdMs = staleThresholdDays * DAY_MS;
  const cycleTimes: number[] = [];
  const backlogAges: number[] = [];
  let stale = 0;
  let throughput_7d = 0;
  let throughput_30d = 0;

  for (const item of items) {
    const status = normalizeStatus(item.status);
    status_counts[status] = (status_counts[status] ?? 0) + 1;

    const active = status !== "closed" && status !== "canceled" && status !== "draft";
    if (active) {
      const type = (item.type ?? "unknown").toLowerCase();
      type_counts[type] = (type_counts[type] ?? 0) + 1;
      const priority = typeof item.priority === "number" ? String(item.priority) : "none";
      priority_counts[priority] = (priority_counts[priority] ?? 0) + 1;

      const updated = parseTime(item.updated_at) ?? parseTime(item.created_at);
      if (updated !== null && nowMs - updated > staleThresholdMs) stale += 1;

      const created = parseTime(item.created_at);
      if (created !== null) backlogAges.push((nowMs - created) / 1000);
    }

    if (status === "closed") {
      const closed = parseTime(item.closed_at);
      if (closed !== null) {
        if (nowMs - closed <= 7 * DAY_MS) throughput_7d += 1;
        if (nowMs - closed <= 30 * DAY_MS) throughput_30d += 1;
        const created = parseTime(item.created_at);
        if (created !== null && closed >= created) cycleTimes.push((closed - created) / 1000);
      }
    }
  }

  return {
    path,
    repo: name,
    available: true,
    status_counts,
    type_counts,
    priority_counts,
    blocked: readBlockedCount(repo),
    stale,
    throughput_7d,
    throughput_30d,
    cycle_time_p50_seconds: percentile(cycleTimes, 0.5),
    cycle_time_p90_seconds: percentile(cycleTimes, 0.9),
    backlog_age_p50_seconds: percentile(backlogAges, 0.5),
    backlog_age_p90_seconds: percentile(backlogAges, 0.9),
  };
}

function collectMetricsAll(repos: string[], staleThresholdDays: number, progress: (msg: string) => void): MetricsResult {
  // A Prometheus exporter is scraped repeatedly. The module-level read caches
  // dedupe pm invocations *within one scrape*, but must not survive across
  // scrapes — otherwise a long-lived host re-invoking this handler would serve
  // the first scrape's items forever. Clear them so every scrape reads fresh.
  for (const cache of PM_READ_CACHES) cache.clear();
  const start = Date.now();
  const nowMs = start;
  const repoMetrics: RepoMetrics[] = [];
  for (const repo of repos) {
    progress(`metrics: ${repoLabel(repo)}`);
    repoMetrics.push(computeRepoMetrics(repo, nowMs, staleThresholdDays));
  }
  disambiguateRepoLabels(repoMetrics);
  return {
    generated_at: new Date(nowMs).toISOString(),
    stale_threshold_days: staleThresholdDays,
    repos_scanned: repoMetrics.filter((r) => r.available).length,
    scrape_duration_seconds: (Date.now() - start) / 1000,
    repos: repoMetrics,
  };
}

/** Escape a Prometheus label value per the exposition format spec. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function metricLine(name: string, labels: Record<string, string>, value: number): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return `${name} ${value}`;
  const labelStr = entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",");
  return `${name}{${labelStr}} ${value}`;
}

/** Stable Prometheus repo label: package name, else directory basename. */
function repoLabel(repoPath: string): string {
  const pkg = readPackageJson(repoPath);
  const name = typeof pkg?.name === "string" && pkg.name.trim() ? pkg.name.trim() : basename(resolve(repoPath));
  return name;
}

/**
 * Guarantee unique `repo` labels within a single scrape. Two checkouts can share
 * a package.json name (e.g. a fork and its upstream, or the same repo passed
 * twice), which would emit duplicate Prometheus series and make the scrape
 * ambiguous or rejected. On collision, disambiguate with the directory basename,
 * then the full path, then a numeric suffix as a last resort.
 */
export function disambiguateRepoLabels(repoMetrics: RepoMetrics[]): void {
  const labelCounts = new Map<string, number>();
  for (const r of repoMetrics) labelCounts.set(r.repo, (labelCounts.get(r.repo) ?? 0) + 1);
  // Reserve every label a non-colliding repo keeps verbatim BEFORE generating
  // any disambiguated label. Otherwise a generated `foo (bar)` could collide
  // with a distinct repo genuinely labeled `foo (bar)` that stays untouched,
  // re-emitting duplicate Prometheus series.
  const used = new Set<string>();
  for (const r of repoMetrics) {
    if ((labelCounts.get(r.repo) ?? 0) <= 1) used.add(r.repo);
  }
  for (const r of repoMetrics) {
    if ((labelCounts.get(r.repo) ?? 0) <= 1) continue;
    // Prefer the directory basename, then the full path; both are checked
    // against every already-claimed label (reserved originals + prior
    // generations), with a numeric suffix as a guaranteed-unique last resort.
    let label = [`${r.repo} (${basename(r.path)})`, `${r.repo} (${r.path})`].find((c) => !used.has(c));
    if (!label) {
      const base = `${r.repo} (${r.path})`;
      label = base;
      let n = 2;
      while (used.has(label)) label = `${base} #${n++}`;
    }
    r.repo = label;
    used.add(label);
  }
}

function renderMetricsPrometheus(result: MetricsResult): string {
  const lines: string[] = [];
  const push = (name: string, help: string, type: string, samples: string[]) => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(...samples);
  };

  const itemSamples: string[] = [];
  const typeSamples: string[] = [];
  const prioritySamples: string[] = [];
  const blockedSamples: string[] = [];
  const staleSamples: string[] = [];
  const throughputSamples: string[] = [];
  const cycleSamples: string[] = [];
  const backlogSamples: string[] = [];
  const availableSamples: string[] = [];

  for (const repo of result.repos) {
    availableSamples.push(metricLine("pm_workspace_available", { repo: repo.repo }, repo.available ? 1 : 0));
    if (!repo.available) continue;
    for (const [status, count] of Object.entries(repo.status_counts)) {
      itemSamples.push(metricLine("pm_items", { repo: repo.repo, status }, count));
    }
    for (const [type, count] of Object.entries(repo.type_counts)) {
      typeSamples.push(metricLine("pm_active_items_by_type", { repo: repo.repo, type }, count));
    }
    for (const [priority, count] of Object.entries(repo.priority_counts)) {
      prioritySamples.push(metricLine("pm_active_items_by_priority", { repo: repo.repo, priority }, count));
    }
    if (repo.blocked !== null) blockedSamples.push(metricLine("pm_blocked_items", { repo: repo.repo }, repo.blocked));
    staleSamples.push(metricLine("pm_stale_items", { repo: repo.repo }, repo.stale));
    throughputSamples.push(metricLine("pm_throughput_items", { repo: repo.repo, window: "7d" }, repo.throughput_7d));
    throughputSamples.push(metricLine("pm_throughput_items", { repo: repo.repo, window: "30d" }, repo.throughput_30d));
    if (repo.cycle_time_p50_seconds !== null) cycleSamples.push(metricLine("pm_cycle_time_seconds", { repo: repo.repo, quantile: "0.5" }, repo.cycle_time_p50_seconds));
    if (repo.cycle_time_p90_seconds !== null) cycleSamples.push(metricLine("pm_cycle_time_seconds", { repo: repo.repo, quantile: "0.9" }, repo.cycle_time_p90_seconds));
    if (repo.backlog_age_p50_seconds !== null) backlogSamples.push(metricLine("pm_backlog_age_seconds", { repo: repo.repo, quantile: "0.5" }, repo.backlog_age_p50_seconds));
    if (repo.backlog_age_p90_seconds !== null) backlogSamples.push(metricLine("pm_backlog_age_seconds", { repo: repo.repo, quantile: "0.9" }, repo.backlog_age_p90_seconds));
  }

  push("pm_items", "Number of pm items by lifecycle status.", "gauge", itemSamples);
  push("pm_active_items_by_type", "Active (non-closed/canceled/draft) pm items by item type.", "gauge", typeSamples);
  push("pm_active_items_by_priority", "Active pm items by priority (0..4, or none).", "gauge", prioritySamples);
  push("pm_blocked_items", "Open pm items blocked by unresolved dependencies (per pm list-blocked).", "gauge", blockedSamples);
  push("pm_stale_items", `Active pm items not updated within the stale threshold (${result.stale_threshold_days}d).`, "gauge", staleSamples);
  push("pm_throughput_items", "Items closed within the trailing window.", "gauge", throughputSamples);
  push("pm_cycle_time_seconds", "Cycle time (closed_at - created_at) of closed items, by quantile.", "gauge", cycleSamples);
  push("pm_backlog_age_seconds", "Age (now - created_at) of active items, by quantile.", "gauge", backlogSamples);
  push("pm_workspace_available", "1 if the repo exposed a readable pm workspace, else 0.", "gauge", availableSamples);
  push("pm_repos_scanned", "Number of repos with a readable pm workspace.", "gauge", [metricLine("pm_repos_scanned", {}, result.repos_scanned)]);
  push("pm_scrape_duration_seconds", "Time spent collecting pm metrics for this scrape.", "gauge", [metricLine("pm_scrape_duration_seconds", {}, result.scrape_duration_seconds)]);

  return lines.join("\n") + "\n";
}

function emitResult(structured: unknown, format: OutputFormat, outputPath: string | undefined, formatter: () => string): unknown {
  if (outputPath) {
    mkdirSync(dirname(resolve(outputPath)), { recursive: true });
    const body = format === "markdown" ? formatter() : `${JSON.stringify(structured, null, 2)}\n`;
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
  version: "2026.7.14",

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
      arguments: additionalRepoArguments(),
      examples: [
        "pm ops scan",
        "pm ops scan --repos ./pm-csv ./pm-github",
        "pm ops scan --repos ./pm-csv,./pm-github --json",
        "pm ops scan --format markdown",
        "pm ops scan --repos ~/container/pm-* --format markdown --output FLEET.md",
      ],
      flags: [
        reposFlag("Repo paths to scan (comma-separated or repeatable; default: current dir)"),
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options, ctx.args);
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
      arguments: additionalRepoArguments(),
      examples: [
        "pm ops policy",
        "pm ops policy --repos ./pm-csv ./pm-github",
        "pm ops policy --policy ./fleet-policy.json --strict",
        "pm ops policy --format markdown",
      ],
      flags: [
        reposFlag("Repo paths to check (comma-separated or repeatable; default: current dir)"),
        { long: "--policy", value_name: "file", description: "JSON policy bundle overriding the default checks" },
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--strict", description: "Exit non-zero on any failed check (any severity)" },
        { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options, ctx.args);
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
        if (strict && result.summary.failed > 0) {
          if (outputPath) {
            emitResult(result, format, outputPath, () => renderPolicyMarkdown(result));
          } else if (format === "markdown") {
            const md = renderPolicyMarkdown(result);
            process.stdout.write(md.endsWith("\n") ? md : `${md}\n`);
          } else {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
        "and reports pass/fail with per-step timing and concise error summaries. Does NOT publish. " +
        "Exits non-zero if any repo fails. --output writes the report to a file.",
      intent: "run a release gate matrix across many pm repositories",
      arguments: additionalRepoArguments(),
      examples: [
        "pm ops verify-release",
        "pm ops verify-release --repos ./pm-csv ./pm-github",
        "pm ops verify-release --json",
        "pm ops verify-release --format markdown --output RELEASE.md",
      ],
      flags: [
        reposFlag("Repo paths to verify (comma-separated or repeatable; default: current dir)"),
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options, ctx.args);
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
          mkdirSync(dirname(resolve(outputPath)), { recursive: true });
          const body = format === "markdown" ? renderVerifyReleaseMarkdown(result) : `${JSON.stringify(result, null, 2)}\n`;
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
      arguments: additionalRepoArguments(),
      examples: [
        "pm ops report",
        "pm ops report --repos ./pm-csv ./pm-github --format markdown",
        "pm ops report --format markdown --output FLEET.md",
        "pm ops report --format markdown --include-release --output FLEET.md",
        "pm ops report --json",
      ],
      flags: [
        reposFlag("Repo paths to report on (comma-separated or repeatable; default: current dir)"),
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--output", value_name: "file", description: "Write the rendered report to a file instead of stdout" },
        { long: "--include-release", description: "Also run verify-release and include results in the report" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options, ctx.args);
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
      arguments: additionalRepoArguments(),
      examples: [
        "pm ops status",
        "pm ops status --repos ./pm-csv ./pm-github",
        "pm ops status --format markdown",
      ],
      flags: [
        reposFlag("Repo paths (comma-separated or repeatable; default: current dir)"),
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options, ctx.args);
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
      arguments: additionalRepoArguments(),
      examples: [
        "pm ops outdated",
        "pm ops outdated --repos ./pm-csv ./pm-github",
        "pm ops outdated --format markdown",
      ],
      flags: [
        reposFlag("Repo paths (comma-separated or repeatable; default: current dir)"),
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options, ctx.args);
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
      arguments: additionalRepoArguments(),
      examples: [
        "pm ops audit",
        "pm ops audit --repos ./pm-csv ./pm-github",
        "pm ops audit --format markdown",
      ],
      flags: [
        reposFlag("Repo paths (comma-separated or repeatable; default: current dir)"),
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr)" },
        { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
        { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options, ctx.args);
        const format = resolveFormat(options);
        const outputPath = readString(options, "output");
        console.error(`pm-ops audit: ${repos.length} repo(s)`);
        const result = collectAuditAll(repos, (m) => console.error(`  ${m}`));
        console.error(`audit: ${result.summary.clean}/${result.summary.total} clean, ${result.summary.total_critical} critical, ${result.summary.total_high} high`);
        return emitResult(result, format, outputPath, () => renderAuditMarkdown(result));
      },
    });

    api.registerCommand({
      name: "ops metrics",
      description:
        "Export pm workspace health as Prometheus text-format gauges so a Prometheus/Grafana " +
        "stack can scrape fleet project-management signals. Emits per-repo item counts by " +
        "status/type/priority, blocked and stale counts, closed-item throughput (7d/30d), and " +
        "cycle-time / backlog-age quantiles derived from created_at/closed_at — the same " +
        "closed_at methodology pm-brief momentum uses. Default output is the Prometheus " +
        "exposition format; --output writes a .prom file for the node_exporter textfile collector.",
      intent: "expose pm workspace metrics to Prometheus/Grafana across many pm repositories",
      arguments: additionalRepoArguments(),
      examples: [
        "pm ops metrics",
        "pm ops metrics --repos ./pm-csv ./pm-github",
        "pm ops metrics --output /var/lib/node_exporter/pm.prom",
        "pm ops metrics --stale-days 7 --format json",
      ],
      flags: [
        reposFlag("Repo paths (comma-separated or repeatable; default: current dir)"),
        { long: "--stale-days", value_name: "days", description: "Age (days) after which an active item counts as stale (default: 14)" },
        { long: "--json", description: "Emit clean JSON to stdout (progress on stderr); overrides the default Prometheus output" },
        { long: "--format", value_name: "prometheus|json|toon", description: "Output format (default: prometheus)" },
        { long: "--output", value_name: "file", description: "Write output to a file instead of stdout (e.g. a node_exporter .prom textfile)" },
      ],
      async run(ctx: any) {
        const options = ctx.options as Record<string, unknown>;
        const repos = resolveRepos(options, ctx.args);
        const staleDaysRaw = Number(readString(options, "staleDays", "stale-days"));
        const staleThresholdDays = Number.isFinite(staleDaysRaw) && staleDaysRaw > 0 ? staleDaysRaw : 14;
        const outputPath = readString(options, "output");
        const rawFormat = readString(options, "format")?.toLowerCase();
        // The global --json flag forces clean JSON to stdout, matching the other
        // ops commands (and the fleet routing contract that scrapes payload.repos).
        // The installed CLI consumes global --json into ctx.global (not
        // ctx.options), so — unlike the other commands whose default returns a
        // bare object the JSON renderer can serialize — the metrics default is a
        // pre-rendered Prometheus string and must consult ctx.global explicitly.
        const global = (ctx.global ?? {}) as { json?: boolean; defaultOutputFormat?: string };
        const wantsJson = readBool(options, "json") || global.json === true || global.defaultOutputFormat === "json";
        const format: "prometheus" | "json" | "toon" = wantsJson
          ? "json"
          : rawFormat === "json" || rawFormat === "toon"
            ? rawFormat
            : "prometheus";
        console.error(`pm-ops metrics: ${repos.length} repo(s), stale threshold ${staleThresholdDays}d`);
        const result = collectMetricsAll(repos, staleThresholdDays, (m) => console.error(`  ${m}`));
        console.error(`metrics: ${result.repos_scanned}/${repos.length} workspace(s) readable`);
        if (format === "prometheus") {
          const body = renderMetricsPrometheus(result);
          if (outputPath) {
            mkdirSync(dirname(resolve(outputPath)), { recursive: true });
            writeFileSync(outputPath, body, "utf-8");
            console.error(`pm-ops: wrote prometheus output to ${outputPath}`);
            return { written_to: outputPath, format };
          }
          return renderedCommandResult(body);
        }
        // Structured (json/toon) output. When writing to a file we serialize
        // ourselves. To stdout we return the BARE result object and let the
        // CLI's global renderer emit it — exactly like the sibling ops
        // commands. The per-command renderer override that would let us force a
        // format is a no-op on command results in the shipped CLI, so wrapping
        // in renderedCommandResult here would double-wrap the payload as
        // { pmOpsRendered, output } and hide `repos` from `pm ops metrics
        // --json | jq .repos`. Deferring to the global format keeps the fleet
        // routing contract (payload.repos[].path) directly scrapeable.
        if (outputPath) {
          return emitResult(result, format === "json" ? "json" : "toon", outputPath, () => renderMetricsPrometheus(result));
        }
        return result;
      },
    });

    for (const commandPath of OPS_COMMAND_PATHS) {
      api.registerParser(commandPath, (context: ParserOverrideContext) => restoreCliRepoFlag(commandPath, context));
    }
  },
});

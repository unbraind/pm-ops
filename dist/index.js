import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull, homedir } from "node:os";
import { resolve, basename, dirname, isAbsolute, join, parse, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "@toon-format/toon";
import { listMergeReceipts, auditMergeDriverConfiguration, auditMergeAttributeFence, findGitWorkspaceRoot, } from "@unbrained/pm-cli/sdk/merge";
import { analyzeDocstringCoverage } from "./docstrings.js";
import { qualityMeasurementProvider } from "./assurance.js";
// ---------------------------------------------------------------------------
// Error contract — mirror pm-cli SDK EXIT_CODE so the host treats thrown
// CommandError as a clean non-zero exit instead of re-invoking the handler.
// ---------------------------------------------------------------------------
const EXIT_CODE = {
    GENERIC_FAILURE: 1,
    USAGE: 2,
    NOT_FOUND: 3,
};
class CommandError extends Error {
    exitCode;
    constructor(message, exitCode = EXIT_CODE.GENERIC_FAILURE) {
        super(message);
        this.name = "CommandError";
        this.exitCode = exitCode;
    }
}
function renderedCommandResult(output) {
    return { pmOpsRendered: true, output };
}
/** Determine whether an unknown command result carries valid pre-rendered pm-ops output. */
function isRenderedCommandResult(value) {
    return (typeof value === "object" &&
        value !== null &&
        "pmOpsRendered" in value &&
        value.pmOpsRendered === true &&
        "output" in value &&
        typeof value.output === "string");
}
/** Unwrap output after the host-owned discriminator accepted the marker. */
function renderCommandResult(context) {
    // The host invokes this renderer only after the registered discriminator has
    // accepted the same result. Keeping that ownership check in one place avoids
    // a second, unreachable rejection path inside the renderer itself.
    return context.result.output;
}
// ---------------------------------------------------------------------------
// Option helpers
// ---------------------------------------------------------------------------
function readBool(options, ...keys) {
    return keys.some((key) => options[key] === true || options[key] === "true" || options[key] === "1");
}
/** Read the first non-empty string option among alternative key spellings. */
function readString(options, ...keys) {
    for (const key of keys) {
        const value = options[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return undefined;
}
function asArray(value) {
    if (Array.isArray(value))
        return value.flatMap(asArray);
    if (typeof value !== "string")
        return [];
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
    "ops merge-receipts",
    "ops docstrings",
];
/** Build the variadic additional-repos argument definition shared by every command. */
function additionalRepoArguments() {
    return [{
            name: "additional-repos",
            required: false,
            variadic: true,
            description: "Additional repository paths after --repos (optional).",
        }];
}
/** Construct the repeatable --repos flag definition with a per-command description. */
function reposFlag(description) {
    return {
        long: "--repos",
        value_name: "paths",
        value_type: "string",
        description,
        list: true,
    };
}
/** Extract every --repos value that follows a command path in the raw argv array. */
function cliRepoFlagValues(commandPath, argv = process.argv.slice(2)) {
    const commandTokens = commandPath.split(" ");
    let commandEnd = -1;
    for (let index = 0; index <= argv.length - commandTokens.length; index += 1) {
        if (commandTokens.every((token, offset) => argv[index + offset] === token)) {
            commandEnd = index + commandTokens.length;
            break;
        }
    }
    if (commandEnd < 0)
        return [];
    const values = [];
    for (let index = commandEnd; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === "--")
            break;
        if (token.startsWith("--repos=")) {
            const value = token.slice("--repos=".length).trim();
            if (value)
                values.push(value);
            continue;
        }
        if (token !== "--repos")
            continue;
        const value = argv[index + 1];
        if (value && value !== "--" && !value.startsWith("--")) {
            values.push(value);
            index += 1;
        }
    }
    return values;
}
/** Re-insert the argv --repos values Commander dropped or truncated for a command. */
function restoreCliRepoFlag(commandPath, context) {
    const cliValues = cliRepoFlagValues(commandPath);
    if (cliValues.length === 0)
        return {};
    // argv is authoritative for a CLI invocation's --repos flag: it captures the
    // complete repeated / `=`-joined set. Commander (pm-cli 2026.7.x) either
    // erases registered list values entirely (#550) or collapses repeated flags
    // to the last value, so `context.options.repos` may be empty OR a truncated
    // tail. Restore the full argv-derived set whenever it differs from what
    // Commander retained. Structured SDK/MCP callers never populate process.argv,
    // so cliValues stays empty for them and their supplied options are untouched.
    const restored = cliValues.flatMap((value) => asArray(value));
    const current = asArray(context.options.repos);
    if (current.length === restored.length && restored.every((value, index) => current[index] === value))
        return {};
    return { options: { ...context.options, repos: restored } };
}
function expandHome(path) {
    if (path === "~")
        return homedir();
    return path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path;
}
function hasGlob(path) {
    return /[*?\[]/.test(path);
}
function escapeRegexChar(char) {
    return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}
/** Compile one path segment with glob metacharacters into an anchored RegExp. */
function globSegmentToRegex(segment) {
    let pattern = "";
    for (let i = 0; i < segment.length; i += 1) {
        const char = segment[i];
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
/** Expand a glob pattern against the filesystem into a sorted list of paths. */
function expandSimpleGlob(pattern) {
    const expanded = expandHome(pattern);
    const absolute = isAbsolute(expanded) || win32.isAbsolute(expanded) ? expanded : resolve(expanded);
    if (!hasGlob(absolute))
        return [absolute];
    const root = isAbsolute(absolute) ? parse(absolute).root : win32.parse(absolute).root;
    const segments = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
    let candidates = [root];
    for (const segment of segments) {
        const next = [];
        const segmentHasGlob = hasGlob(segment);
        const matcher = segmentHasGlob ? globSegmentToRegex(segment) : null;
        for (const candidate of candidates) {
            if (!existsSync(candidate))
                continue;
            if (!segmentHasGlob) {
                next.push(join(candidate, segment));
                continue;
            }
            for (const entry of readdirSync(candidate, { withFileTypes: true })) {
                if (matcher?.test(entry.name))
                    next.push(join(candidate, entry.name));
            }
        }
        candidates = next;
    }
    // Sort matches so glob-expanded repo lists (and any fleet report built from
    // them) are deterministic across filesystems whose readdir order is not
    // guaranteed — important for stable, diff-friendly agent output.
    return candidates.length > 0 ? [...candidates].sort() : [absolute];
}
function resolveRepos(options, args = []) {
    const repos = [...asArray(options["repos"]), ...asArray(args)];
    if (repos.length > 0)
        return repos.flatMap((r) => expandSimpleGlob(r));
    return [process.cwd()];
}
/** Resolve the output format from --format and the host-owned --json global. */
function resolveFormat(options, global) {
    // `--json` is a host-owned global flag: extensions must not redeclare it
    // (the host rejects the registration) and must read it from ctx.global.
    if (global.json === true)
        return "json";
    const raw = readString(options, "format")?.toLowerCase();
    if (raw === "json" || raw === "markdown" || raw === "toon")
        return raw;
    return "toon";
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
 *
 * Callers may explicitly unset inherited variables by assigning `undefined`
 * in `opts.env`; those entries are removed before spawning the child.
 */
function runSync(cmd, args, opts = {}) {
    const env = { ...process.env, ...opts.env };
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined)
            delete env[key];
    }
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
            if (key.toLowerCase() === "npm_config_allow_scripts")
                delete env[key];
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
const PM_CLI_FALLBACK = {
    cmd: process.execPath,
    args: [resolve(dirname(fileURLToPath(import.meta.resolve("@unbrained/pm-cli/package.json"))), "dist", "cli.js")],
};
const pmInvocationCache = new Map();
/** Prefer a PATH override while retaining the installed host CLI as a reliable fallback. */
function resolvePmInvocation() {
    const command = process.platform === "win32" ? "pm.cmd" : "pm";
    const key = `${process.platform}\0${String(process.env.PATH)}`;
    const cached = pmInvocationCache.get(key);
    if (cached)
        return cached;
    const probe = spawnSync(command, ["--version"], { encoding: "utf-8", timeout: 5_000 });
    // Absence uses the installed host CLI; a present-but-broken PATH command is
    // retained so its failure remains visible instead of being silently masked.
    const errorCode = probe.error?.code;
    const invocation = errorCode === "ENOENT" ? PM_CLI_FALLBACK : { cmd: command, args: [] };
    pmInvocationCache.set(key, invocation);
    return invocation;
}
/** Parse JSON, returning undefined on any syntax error instead of throwing. */
function parseJsonSafe(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/** Read and JSON-parse a file, returning undefined when missing or invalid. */
function readJsonFile(path) {
    if (!existsSync(path))
        return undefined;
    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    }
    catch {
        return undefined;
    }
}
/** Strip comments and trailing commas from JSONC text to yield plain JSON. */
function stripJsonc(input) {
    let output = "";
    let inString = false;
    let quote = "";
    let escaped = false;
    for (let i = 0; i < input.length; i += 1) {
        const char = input[i];
        const next = input[i + 1];
        if (inString) {
            output += char;
            if (escaped) {
                escaped = false;
            }
            else if (char === "\\") {
                escaped = true;
            }
            else if (char === quote) {
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
            while (i < input.length && input[i] !== "\n")
                i += 1;
            output += "\n";
            continue;
        }
        if (char === "/" && next === "*") {
            i += 2;
            while (i < input.length && !(input[i] === "*" && input[i + 1] === "/"))
                i += 1;
            i += 1;
            output += " ";
            continue;
        }
        output += char;
    }
    return output.replace(/,\s*([}\]])/g, "$1");
}
/** Read and parse a JSONC file by stripping comments before JSON.parse. */
function readJsoncFile(path) {
    if (!existsSync(path))
        return undefined;
    try {
        return JSON.parse(stripJsonc(readFileSync(path, "utf-8")));
    }
    catch {
        return undefined;
    }
}
function readPackageJson(repoPath) {
    return readJsonFile(join(repoPath, "package.json"));
}
function hasPmChangelogDep(pkg) {
    return Boolean((pkg?.devDependencies && "pm-changelog" in pkg.devDependencies) || (pkg?.dependencies && "pm-changelog" in pkg.dependencies));
}
/** Resolve a tsconfig extends value to an absolute config file path. */
function resolveExtendsPath(currentFile, value) {
    const withExtension = value.endsWith(".json") ? value : `${value}.json`;
    if (value.startsWith(".") || value.startsWith("/") || value.startsWith("~")) {
        return resolve(dirname(currentFile), expandHome(withExtension));
    }
    const requireFromConfig = createRequire(currentFile);
    try {
        return requireFromConfig.resolve(value);
    }
    catch {
        try {
            return requireFromConfig.resolve(withExtension);
        }
        catch {
            return resolve(dirname(currentFile), "node_modules", withExtension);
        }
    }
}
/** Walk a tsconfig extends chain to find the inherited strict compiler setting. */
function readTsConfigStrictSetting(path, seen = new Set()) {
    const resolved = resolve(path);
    if (seen.has(resolved))
        return null;
    seen.add(resolved);
    const cfg = readJsoncFile(resolved);
    if (!cfg)
        return null;
    if (cfg.compilerOptions?.strict === true)
        return true;
    if (cfg.compilerOptions?.strict === false)
        return false;
    if (Array.isArray(cfg.extends)) {
        for (const entry of [...cfg.extends].reverse()) {
            if (typeof entry !== "string")
                continue;
            const inherited = readTsConfigStrictSetting(resolveExtendsPath(resolved, entry), seen);
            if (inherited !== null)
                return inherited;
        }
        return null;
    }
    if (typeof cfg.extends === "string")
        return readTsConfigStrictSetting(resolveExtendsPath(resolved, cfg.extends), seen);
    return null;
}
function readTsConfigStrict(repoPath) {
    return readTsConfigStrictSetting(join(repoPath, "tsconfig.json")) === true;
}
const pmItemsCache = new Map();
const pmAllItemsCache = new Map();
const pmBlockedCache = new Map();
/** Per-scrape read caches. Cleared together so a fresh scrape re-reads pm. */
const PM_READ_CACHES = [pmItemsCache, pmAllItemsCache, pmBlockedCache];
/**
 * Narrow the `pm <subcommand> --json` payload to its item array without an `any`
 * cast. The current CLI returns an envelope object (`{ items: [...] }`);
 * everything else falls back to an empty array so a malformed or stale
 * contract never reaches the item filter.
 */
function extractPmListBody(parsed) {
    if (parsed && typeof parsed === "object") {
        const obj = parsed;
        if (Array.isArray(obj.items))
            return obj.items;
    }
    return null;
}
/**
 * Prove that one canonical `pm list` envelope is complete.
 *
 * The returned rows are authoritative input to throughput, cycle-time, and
 * backlog metrics, so absence of a negative signal is not sufficient: both
 * completeness receipts must be present and affirmative, pagination must be
 * exhausted, and the two declared counts must agree with the physical row
 * count. Every row must also carry a usable id; filtering malformed rows would
 * turn a complete envelope into a shorter data set while preserving a green
 * availability gauge.
 *
 * @param envelope - The decoded CLI response envelope.
 * @param items - The exact `items` array extracted from that envelope.
 * @returns `true` only when every independent completeness signal agrees.
 */
function isCompletePmListEnvelope(envelope, items) {
    const completeness = envelope.completeness;
    const omissionReceipt = envelope.omission_receipt;
    if (!completeness || typeof completeness !== "object")
        return false;
    if (!omissionReceipt || typeof omissionReceipt !== "object")
        return false;
    if (completeness.status !== "complete")
        return false;
    if (omissionReceipt.has_omissions !== false)
        return false;
    if (envelope.truncated !== false || envelope.has_more !== false || envelope.next_cursor !== null)
        return false;
    if (typeof envelope.count !== "number" || !Number.isSafeInteger(envelope.count) || envelope.count !== items.length)
        return false;
    if (typeof envelope.total !== "number" || !Number.isSafeInteger(envelope.total) || envelope.total !== items.length)
        return false;
    return items.every((item) => item !== null && typeof item === "object" && typeof item.id === "string");
}
/**
 * Read pm items for a repo via one canonical `pm list` invocation, extract
 * the item array, and memoize the result per repo in the supplied cache. Single
 * implementation shared by the active-list, full-list, and blocked-list readers
 * so their guard / invocation / JSON-extraction / caching logic can't drift
 * (e.g. the cross-scrape cache-clear must cover all of them). Returns null when
 * the workspace is absent or the CLI call fails.
 */
function readPmItemList(repoPath, queryArgs, cache) {
    if (cache.has(repoPath))
        return cache.get(repoPath) ?? null;
    const set = (value) => {
        cache.set(repoPath, value);
        return value;
    };
    const pmRoot = join(repoPath, ".agents", "pm");
    if (!existsSync(pmRoot))
        return set(null);
    const pm = resolvePmInvocation();
    const r = runSync(pm.cmd, [
        ...pm.args,
        ...queryArgs,
        "--json",
        "--pm-path",
        pmRoot,
        "--output-budget",
        "unbounded",
        "--output-limit",
        "unbounded",
        "--output-include",
        "full",
    ], {
        timeoutMs: 30_000,
        // The package source is already instrumented in the host process. Do not
        // merge coverage from the compiled extension loaded by a nested CLI read,
        // which would count a second generated branch graph for the same source.
        env: { NODE_V8_COVERAGE: undefined },
    });
    if (r.status !== 0)
        return set(null);
    const parsed = parseJsonSafe(r.stdout);
    if (!parsed)
        return set(null);
    const items = extractPmListBody(parsed);
    if (!items)
        return set(null);
    if (!isCompletePmListEnvelope(parsed, items))
        return set(null);
    return set(items);
}
/** Active pm items via `pm list --json`. */
function readPmItems(repoPath) {
    return readPmItemList(repoPath, ["list"], pmItemsCache);
}
/**
 * Every pm item (including closed/canceled) via `pm list --all --json`. Metrics
 * need the closed items for throughput and cycle-time, so this is distinct from
 * readPmItems, which only returns active items.
 */
function readAllPmItems(repoPath) {
    return readPmItemList(repoPath, ["list", "--all"], pmAllItemsCache);
}
/**
 * Count items the pm CLI itself considers blocked (open with unresolved
 * blocked_by edges). Delegating to `pm list --status blocked` reuses the CLI's own
 * dependency-resolution logic rather than re-deriving it from the flat list.
 */
function readBlockedCount(repoPath) {
    const items = readPmItemList(repoPath, ["list", "--status", "blocked"], pmBlockedCache);
    return items === null ? null : items.length;
}
function isOffline() {
    return process.env.PM_OPS_OFFLINE === "1" || process.env.PM_OPS_OFFLINE === "true";
}
/** Count outdated dependencies via npm outdated --json, null when offline or failing. */
function countOutdated(repoPath) {
    if (isOffline())
        return null;
    const r = runSync("npm", ["outdated", "--json"], { cwd: repoPath, timeoutMs: 60_000 });
    if (r.error)
        return null;
    const parsed = parseJsonSafe(r.stdout);
    if (!parsed || typeof parsed !== "object")
        return r.status === 0 ? 0 : null;
    return Object.keys(parsed).length;
}
/** Read production vulnerability counts from npm audit, throwing on failure. */
function readAudit(repoPath) {
    if (isOffline())
        return { critical: null, high: null };
    const r = runSync("npm", ["audit", "--omit=dev", "--json"], { cwd: repoPath, timeoutMs: 60_000 });
    if (r.error) {
        const detail = summarizeNpmError(r.stdout, r.stderr, ["audit", "--omit=dev", "--json"]);
        throw new Error(`npm audit failed: ${r.error.message}; ${detail}`);
    }
    const parsed = parseJsonSafe(r.stdout);
    if (parsed?.error) {
        if (typeof parsed.error === "string")
            throw new Error(`npm audit failed: ${parsed.error}`);
        const code = parsed.error.code ?? "unknown";
        const summary = parsed.error.summary ?? "unknown error";
        throw new Error(`npm audit failed: [${code}] ${summary}`);
    }
    const v = parsed?.metadata?.vulnerabilities;
    if (!v)
        throw new Error(summarizeNpmError(r.stdout, r.stderr, ["audit", "--omit=dev", "--json"]));
    return { critical: v.critical ?? 0, high: v.high ?? 0 };
}
const AUDIT_UNAVAILABLE_PREFIX = "audit unavailable:";
/** Normalize unknown thrown values without allowing diagnostics to become undefined. */
function errorMessage(error) {
    return String(error).replace(/^[A-Za-z]*Error:\s*/, "");
}
/** Reduce an unknown thrown value to a single human-readable diagnostic string. */
function auditUnavailable(error) {
    return `${AUDIT_UNAVAILABLE_PREFIX} ${errorMessage(error)}`;
}
function passesAuditGate(critical, diagnostics) {
    return isOffline() || (critical === 0 && !diagnostics.some((entry) => entry.startsWith(AUDIT_UNAVAILABLE_PREFIX)));
}
/** Ask gh whether a repo is private, returning null when the query fails. */
function ghRepoIsPrivate(repoPath) {
    if (isOffline())
        return null;
    const r = runSync("gh", ["repo", "view", "--json", "isPrivate", "--jq", ".isPrivate"], { cwd: repoPath, timeoutMs: 30_000 });
    if (r.status !== 0)
        return null;
    const raw = r.stdout.trim();
    if (raw !== "true" && raw !== "false")
        return null;
    return raw === "true";
}
/** Count open pull requests or issues for a repo via the gh CLI. */
function ghOpenCount(repoPath, kind) {
    if (isOffline())
        return null;
    const args = kind === "pr"
        ? ["pr", "list", "--state", "open", "--json", "number"]
        : ["issue", "list", "--state", "open", "--json", "number"];
    const r = runSync("gh", args, { cwd: repoPath, timeoutMs: 30_000 });
    if (r.status !== 0)
        return null;
    const parsed = parseJsonSafe(r.stdout);
    return Array.isArray(parsed) ? parsed.length : null;
}
/** Gather the full release-readiness snapshot for a single repository path. */
function scanRepo(repoPath) {
    const errors = [];
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
    const outdated_count = countOutdated(repoPath);
    let audit_critical = null;
    let audit_high = null;
    try {
        const a = readAudit(repoPath);
        audit_critical = a.critical;
        audit_high = a.high;
    }
    catch (err) {
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
/** Scan every repo in parallel and roll the snapshots into an aggregate result. */
function scanRepos(repos, progress) {
    const results = repos.map((repo) => {
        progress(`scanning ${repo}`);
        return scanRepo(repo);
    });
    const ready = results.filter((r) => r.ready).length;
    return { repos: results, summary: { total: results.length, ready, not_ready: results.length - ready } };
}
const DEFAULT_REQUIRED_SCRIPTS = ["typecheck", "test", "build", "release:check", "changelog", "changelog:check"];
const DEFAULT_REQUIRED_WORKFLOWS = ["ci.yml", "release.yml"];
const DEFAULT_POLICY = {
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
function leadingSpaces(value) {
    return value.length - value.trimStart().length;
}
/** Strip comments, quotes, and trailing commas from a YAML scalar value. */
function normalizeYamlScalar(value) {
    return value
        .replace(/\s+#.*$/, "")
        .replace(/,$/, "")
        .trim()
        .replace(/^['"]|['"]$/g, "");
}
/** Test whether a runs-on scalar names a GitHub-hosted runner label. */
function hasGithubHostedRunnerScalar(value) {
    const normalized = normalizeYamlScalar(value);
    if (!normalized || normalized.includes("${{"))
        return false;
    if (normalized.startsWith("{") && normalized.endsWith("}")) {
        const labels = normalized.match(/\blabels\s*:\s*(\[[^\]]*\]|[^,}]+)/);
        return labels ? hasGithubHostedRunnerScalar(labels[1]) : false;
    }
    if (normalized.startsWith("[") && normalized.endsWith("]")) {
        return hasGithubHostedRunnerEntries(normalized.slice(1, -1).split(","));
    }
    return GITHUB_HOSTED_RUNNER_PATTERN.test(normalized);
}
function hasGithubHostedRunnerEntries(values) {
    const entries = values.map(normalizeYamlScalar).filter(Boolean);
    if (entries.includes("self-hosted"))
        return false;
    return entries.some((entry) => GITHUB_HOSTED_RUNNER_PATTERN.test(entry));
}
/** Detect a GitHub-hosted runner in an inline or block runs-on workflow value. */
function hasGithubHostedRunsOnValue(inlineValue, blockLines) {
    if (hasGithubHostedRunnerScalar(inlineValue))
        return true;
    const directItems = [];
    const labelItems = [];
    let inLabels = false;
    for (const line of blockLines) {
        const trimmed = line.trim();
        const item = trimmed.match(/^-\s+(.+)$/);
        const labels = trimmed.match(/^labels:\s*(.*)$/);
        if (labels) {
            if (labels[1].trim() && hasGithubHostedRunnerScalar(labels[1]))
                return true;
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
/** Validate the package name against the fleet naming convention. */
function checkNaming(name) {
    if (!name)
        return { id: "naming", severity: "error", pass: false, message: "package.json has no name" };
    if (FORBIDDEN_PREFIXES.some((p) => name.startsWith(p))) {
        return { id: "naming", severity: "error", pass: false, message: `name "${name}" uses a forbidden prefix (pm-ext- / pm-preset-)` };
    }
    const pass = NAME_PATTERN.test(name);
    return { id: "naming", severity: "error", pass, message: pass ? `name "${name}" matches ^pm-[a-z][a-z0-9-]*$` : `name "${name}" does not match ^pm-[a-z][a-z0-9-]*$` };
}
/** Verify that every required npm script is defined in package.json. */
function checkRequiredScripts(pkg, required) {
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
/** Verify that every required workflow file exists under .github/workflows. */
function checkRequiredWorkflows(repoPath, required) {
    const missing = required.filter((w) => !existsSync(join(repoPath, ".github", "workflows", w)));
    return {
        id: "required-workflows",
        severity: "error",
        pass: missing.length === 0,
        message: missing.length === 0 ? "all required workflows present" : `missing workflows: ${missing.join(", ")}`,
        details: missing.length > 0 ? missing : undefined,
    };
}
/** Forbid GitHub-hosted runners in the workflows of a private repository. */
function checkPrivateNoRunners(repoPath) {
    const isPrivate = ghRepoIsPrivate(repoPath);
    if (isPrivate === null || isPrivate === false) {
        return { id: "private-no-runners", severity: "error", pass: true, message: "repo is public or unknown — check skipped" };
    }
    const wfDir = join(repoPath, ".github", "workflows");
    const violations = [];
    if (existsSync(wfDir)) {
        for (const file of readdirSync(wfDir)) {
            if (!file.endsWith(".yml") && !file.endsWith(".yaml"))
                continue;
            let content;
            try {
                content = readFileSync(join(wfDir, file), "utf-8");
            }
            catch (err) {
                violations.push(`${file}: unable to read workflow (${String(err)})`);
                continue;
            }
            const lines = content.split("\n");
            for (const [index, line] of lines.entries()) {
                const m = line.match(/^\s*runs-on:\s*(.*?)\s*$/);
                if (!m)
                    continue;
                if (hasGithubHostedRunsOnValue(m[1], [])) {
                    violations.push(`${file}: ${m[0].trim()}`);
                    continue;
                }
                const baseIndent = leadingSpaces(line);
                const valueLines = [];
                for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
                    const nextLine = lines[nextIndex];
                    if (!nextLine.trim())
                        continue;
                    if (leadingSpaces(nextLine) <= baseIndent)
                        break;
                    valueLines.push(nextLine.trim());
                }
                if (hasGithubHostedRunsOnValue("", valueLines))
                    violations.push(`${file}: runs-on uses a GitHub-hosted runner`);
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
/** Flag any two open pm items that share an identical title. */
function checkPmDuplicateTitles(items) {
    if (items === null)
        return { id: "pm-duplicate-titles", severity: "warning", pass: true, message: "no pm workspace — check skipped" };
    const open = items.filter((i) => (i.status ?? "").toLowerCase() === "open");
    const seen = new Map();
    for (const it of open) {
        const title = (it.title ?? "").trim();
        if (!title)
            continue;
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
/** Confirm pm-changelog is present as a dependency and a changelog script. */
function checkPmChangelogWired(pkg) {
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
/** Dispatch one policy check definition to its implementation and attach severity. */
function runPolicyCheck(def, ctx) {
    let result;
    switch (def.id) {
        case "naming":
            result = checkNaming(ctx.pkg?.name ?? null);
            break;
        case "required-scripts":
            result = checkRequiredScripts(ctx.pkg, def.params?.scripts ?? DEFAULT_REQUIRED_SCRIPTS);
            break;
        case "required-workflows":
            result = checkRequiredWorkflows(ctx.repoPath, def.params?.workflows ?? DEFAULT_REQUIRED_WORKFLOWS);
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
/** Decide whether a repo matches a policy check repo_filter expression. */
function matchesFilter(repoPath, name, filter) {
    if (!filter)
        return true;
    if (filter === "*")
        return true;
    if (name && name === filter)
        return true;
    return basename(repoPath) === filter;
}
/** Run a policy bundle across every repo and tally results by severity. */
function runPolicy(repos, bundle, progress) {
    const by_severity = { error: 0, warning: 0, info: 0 };
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
            if (!res.pass)
                by_severity[def.severity] += 1;
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
const FALLBACK_STEPS = ["typecheck", "build", "test", "audit:prod", "pack:dry-run", "changelog:check"];
/**
 * Extract a concise, human-readable error reason from npm stdout/stderr.
 * npm errors typically include `npm error code XXX` and a message line;
 * we surface the code + message so the user sees *why* a check failed
 * without having to scroll through full build output.
 */
function summarizeNpmError(stdout, stderr, args) {
    const combined = `${stderr}\n${stdout}`.trim();
    if (!combined)
        return `npm ${args.join(" ")} exited non-zero (no output)`;
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
/** Execute one npm release step in a repo and time its pass or failure. */
function runReleaseCheck(repoPath, name, args, progress) {
    progress(`verify ${repoLabel(repoPath)}: ${name}`);
    const start = Date.now();
    const r = runSync("npm", args, {
        cwd: repoPath,
        timeoutMs: 5 * 60_000,
        // node:test marks its process with NODE_TEST_CONTEXT. Inheriting that
        // marker makes nested `node --test` commands treat the run as recursive
        // and skip the repository's test files.
        env: { NODE_TEST_CONTEXT: undefined },
    });
    const duration_ms = Date.now() - start;
    const pass = r.status === 0;
    const error = pass ? undefined : r.error?.message ?? summarizeNpmError(r.stdout, r.stderr, args);
    return { name, pass, duration_ms, error };
}
/** Return a stable release-check diagnostic, including for externally supplied sparse results. */
function releaseCheckError(check) {
    return String(check.error).replace(/^undefined$/, check.pass ? "" : "check failed without an error message");
}
/** Run the release gate steps for one repo, falling back to individual scripts. */
function verifyReleaseRepo(repoPath, progress) {
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
    let checks;
    if (typeof scripts["release:check"] === "string") {
        checks = [runReleaseCheck(repoPath, "release:check", ["run", "release:check"], progress)];
    }
    else {
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
/** Verify the release gate across every repo and summarize pass and fail counts. */
function verifyRelease(repos, progress) {
    const results = repos.map((r) => verifyReleaseRepo(r, progress));
    return {
        repos: results,
        summary: { total: results.length, passed: results.filter((r) => r.failed === 0).length, failed: results.filter((r) => r.failed > 0).length },
    };
}
/** Render the verify-release result as a markdown table of checks per repo. */
function renderVerifyReleaseMarkdown(result) {
    const lines = [
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
                markdownCell(releaseCheckError(c), 200),
            ]));
        }
    }
    lines.push("");
    return lines.join("\n");
}
/** Assemble the ready-or-not status verdict and metrics for one repository. */
async function collectStatus(repoPath) {
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
            pending_receipts: null,
        };
    }
    const pkg = readPackageJson(repoPath);
    const name = pkg?.name ?? null;
    const version = pkg?.version ?? null;
    const issues = [];
    const strict_ts = readTsConfigStrict(repoPath);
    if (!strict_ts)
        issues.push("strict TS not enabled");
    const has_changelog = existsSync(join(repoPath, "CHANGELOG.md"));
    if (!has_changelog)
        issues.push("no CHANGELOG.md");
    const has_release_workflow = existsSync(join(repoPath, ".github", "workflows", "release.yml"));
    if (!has_release_workflow)
        issues.push("no release workflow");
    const has_ci = existsSync(join(repoPath, ".github", "workflows", "ci.yml"));
    if (!has_ci)
        issues.push("no CI workflow");
    const has_pm_changelog = hasPmChangelogDep(pkg);
    if (!has_pm_changelog)
        issues.push("pm-changelog not wired");
    const outdated_count = countOutdated(repoPath);
    let audit_critical = null;
    let audit_high = null;
    try {
        const a = readAudit(repoPath);
        audit_critical = a.critical;
        audit_high = a.high;
    }
    catch (err) {
        issues.push(auditUnavailable(err));
    }
    // Critical vulnerabilities gate readiness (matching scanRepo's
    // audit gate). High-severity findings are still pushed to issues for
    // textual visibility but do not block ready, so fleet-health reports
    // from ops status and ops scan stay consistent.
    if (audit_critical !== null && audit_critical > 0)
        issues.push(`${audit_critical} critical vuln(s)`);
    if (audit_high !== null && audit_high > 0)
        issues.push(`${audit_high} high vuln(s)`);
    const items = readPmItems(repoPath);
    const pm_open_items = items ? items.filter((i) => (i.status ?? "").toLowerCase() === "open").length : null;
    // Surface clone-local pending merge receipts so the default health view shows
    // unreconciled merge decisions (a peer's scalar edit silently dropped by the
    // field-aware driver). Pending receipts do not gate `ready` here — `ops
    // merge-receipts` is the dedicated gate — but the count is pushed to issues so
    // the compact view surfaces it without a separate command.
    const pendingReceipts = await listMergeReceipts(repoPath, { includeReconciled: false });
    const pending_receipts = pendingReceipts.length;
    if (pending_receipts > 0)
        issues.push(`${pending_receipts} pending merge receipt(s)`);
    // ready gates only on critical vulns, not high — aligned with scanRepo.
    const auditGate = passesAuditGate(audit_critical, issues);
    const ready = issues.filter((i) => !i.includes("high vuln") && !i.includes("pending merge receipt")).length === 0 && auditGate;
    return { path: repoPath, name, version, ready, issues, pm_open_items, audit_critical, audit_high, outdated_count, pending_receipts };
}
/** Collect readiness status across every repo in parallel into one result. */
async function collectStatusAll(repos, progress) {
    const results = [];
    for (const repo of repos) {
        progress(`status ${repo}`);
        results.push(await collectStatus(repo));
    }
    const ready = results.filter((r) => r.ready).length;
    const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);
    const totalPendingReceipts = results.reduce((sum, r) => sum + (r.pending_receipts ?? 0), 0);
    return { repos: results, summary: { total: results.length, ready, not_ready: results.length - ready, total_issues: totalIssues, total_pending_receipts: totalPendingReceipts } };
}
/** Render the fleet readiness status as a markdown summary table. */
function renderStatusMarkdown(result) {
    const lines = [];
    lines.push("# pm-ops status");
    lines.push("");
    lines.push(`Fleet: **${result.summary.total}** repo(s) — **${result.summary.ready}** ready, **${result.summary.not_ready}** not ready, **${result.summary.total_issues}** issue(s), **${result.summary.total_pending_receipts}** pending merge receipt(s).`);
    lines.push("");
    lines.push(renderMarkdownRow(["repo", "version", "ready", "open items", "outdated", "critical", "high", "pending receipts", "issues"]));
    lines.push(renderMarkdownRow(["---", "---", "---", "---", "---", "---", "---", "---", "---"]));
    for (const r of result.repos) {
        lines.push(renderMarkdownRow([
            r.name ?? basename(r.path),
            r.version ?? "-",
            r.ready ? "yes" : "no",
            formatCount(r.pm_open_items),
            formatCount(r.outdated_count),
            formatCount(r.audit_critical),
            formatCount(r.audit_high),
            formatCount(r.pending_receipts),
            r.issues.length === 0 ? "-" : markdownCell(r.issues.join("; "), 200),
        ]));
    }
    lines.push("");
    return lines.join("\n");
}
/** Gather the outdated-dependency report for a single repository path. */
function collectOutdatedRepo(repoPath) {
    const pkg = readPackageJson(repoPath);
    if (isOffline()) {
        return { path: repoPath, name: pkg?.name ?? null, outdated: [], count: null, error: "offline mode enabled" };
    }
    const r = runSync("npm", ["outdated", "--json"], { cwd: repoPath, timeoutMs: 60_000 });
    if (r.error) {
        return { path: repoPath, name: pkg?.name ?? null, outdated: [], count: null, error: r.error.message };
    }
    const entries = [];
    if (r.status !== 0 && r.status !== 1) {
        // npm outdated exits 0 if no outdated, 1 if some outdated
        return { path: repoPath, name: pkg?.name ?? null, outdated: [], count: null, error: summarizeNpmError(r.stdout, r.stderr, ["outdated", "--json"]) };
    }
    const parsed = parseJsonSafe(r.stdout);
    if (parsed && typeof parsed === "object") {
        for (const [name, info] of Object.entries(parsed)) {
            if (info && typeof info === "object") {
                const fields = info;
                entries.push({
                    name,
                    current: String(fields.current ?? "-"),
                    wanted: String(fields.wanted ?? "-"),
                    latest: String(fields.latest ?? "-"),
                    type: String(fields.type ?? "-"),
                });
            }
        }
    }
    return { path: repoPath, name: pkg?.name ?? null, outdated: entries, count: entries.length };
}
/** Collect outdated-dependency reports across every repo in parallel. */
function collectOutdatedAll(repos, progress) {
    const results = repos.map((repo) => {
        progress(`outdated ${repo}`);
        return collectOutdatedRepo(repo);
    });
    const withOutdated = results.filter((r) => (r.count ?? 0) > 0).length;
    const totalOutdated = results.reduce((sum, r) => sum + (r.count ?? 0), 0);
    return { repos: results, summary: { total: results.length, repos_with_outdated: withOutdated, total_outdated: totalOutdated } };
}
/** Render the outdated-dependency report as a markdown table per repo. */
function renderOutdatedMarkdown(result) {
    const lines = [];
    lines.push("# pm-ops outdated");
    lines.push("");
    lines.push(`Checked **${result.summary.total}** repo(s): **${result.summary.repos_with_outdated}** have outdated deps, **${result.summary.total_outdated}** total outdated package(s).`);
    lines.push("");
    for (const repo of result.repos) {
        if (repo.count === null) {
            lines.push(`## ${repo.name ?? basename(repo.path)}`);
            lines.push("");
            lines.push(`Unable to check outdated dependencies: ${repo.error}`);
            lines.push("");
            continue;
        }
        if (repo.count === 0)
            continue;
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
/** Gather the production vulnerability audit for a single repository path. */
function collectAuditRepo(repoPath) {
    const pkg = readPackageJson(repoPath);
    if (isOffline()) {
        return { path: repoPath, name: pkg?.name ?? null, critical: null, high: null, moderate: null, low: null, total: null, ok: false };
    }
    const r = runSync("npm", ["audit", "--omit=dev", "--json"], { cwd: repoPath, timeoutMs: 60_000 });
    if (r.error) {
        return { path: repoPath, name: pkg?.name ?? null, critical: null, high: null, moderate: null, low: null, total: null, ok: false };
    }
    const parsed = parseJsonSafe(r.stdout);
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
/** Collect production audit reports across every repo in parallel. */
function collectAuditAll(repos, progress) {
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
/** Render the fleet vulnerability audit as a compact markdown table. */
function renderAuditMarkdown(result) {
    const lines = [];
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
// merge-receipts — gate on clone-local field-aware merge decision receipts
// ---------------------------------------------------------------------------
/** Tracker infrastructure directories that are not item-type folders.
 * `history`, `schema`, `settings.json`, and the relationship JSONL glob are
 * fenced by `buildMergeAttributePatterns` regardless of the type-folder list,
 * so excluding `history`/`schema` here does not lose their coverage. `runtime`
 * and `locks` are scratch/state directories. `extensions` and `search` are
 * infrastructure directories `pm init` creates (extension-installed item
 * storage and the search index) that `pm merge install` deliberately does NOT
 * fence, so leaving them in would make the fence audit report perpetual
 * `drift` on every healthy `pm init` + `pm merge install` clone. `merge-receipts`
 * is clone-local merge provenance the field-aware driver writes into the
 * tracker after a conflicted merge; it is not an item type, and `pm merge
 * install` does not fence it, so treating it as a type folder would flip a
 * freshly-installed fence to `drift` the moment any real merge records a
 * receipt. */
const MERGE_FENCE_EXCLUDED_DIRS = new Set(["schema", "history", "runtime", "locks", "extensions", "search", "merge-receipts"]);
/**
 * Enumerate the tracker item-type folders under a pm root so the merge-fence
 * audit compares the committed `.gitattributes` block against the types the
 * workspace actually uses. Type folders are the directories that hold item
 * documents; `schema`, `history`, `runtime`, and `locks` are tracker
 * infrastructure rather than item types and are excluded.
 */
function discoverTypeFolders(pmRoot) {
    return readdirSync(pmRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !MERGE_FENCE_EXCLUDED_DIRS.has(entry.name))
        .map((entry) => entry.name)
        .sort();
}
/**
 * Project a receipt's requested preference side for the fleet view.
 *
 * The SDK's receipt reader normalizes every receipt it returns to carry
 * `requested_preference`, folding the legacy schema-v1 `preferred` key and
 * defaulting to `"ours"` when a receipt records neither — the exact chain
 * `summarizeMergeReceipt` applies for committed-history summaries. Centralizing
 * it here keeps the fleet view's field consistent with those summaries and
 * gives the legacy/default arms a directly testable home.
 */
export function receiptPreferredSide(receipt) {
    return receipt.requested_preference ?? receipt.preferred ?? "ours";
}
/**
 * Project a clone-local {@link MergeDecisionReceipt} into the fleet report view,
 * preserving the current SDK path as both the display and raw audit value.
 */
function toReceiptView(receipt) {
    return {
        id: receipt.id,
        item_id: receipt.item_id,
        item_path: receipt.item_path,
        item_path_raw: receipt.item_path,
        state: receipt.state,
        preferred: receiptPreferredSide(receipt),
        fields_from_theirs: receipt.fields_from_theirs,
        union_fields: receipt.union_fields,
        decisions: receipt.decisions.map((d) => ({
            field: d.field,
            base: d.base,
            ours: d.ours,
            theirs: d.theirs,
            retained: d.retained,
            discarded: d.discarded,
        })),
        created_at: receipt.created_at,
        reconciled_at: receipt.reconciled_at,
    };
}
/**
 * Collect the merge-receipt report for one repo: resolves the git workspace
 * root, audits the clone-local merge-driver configuration and the committed
 * `.gitattributes` fence, and reads every (pending, or all) receipt the
 * field-aware driver wrote under `.git/pm-merge-receipts/`. Repos outside git
 * are reported with `available: false` and empty receipts — the gate treats
 * them as not-installed only when a pm workspace expects the driver.
 */
async function collectMergeReceiptsRepo(repoPath, includeReconciled) {
    const pkg = readPackageJson(repoPath);
    const name = pkg?.name ?? null;
    const gitRoot = await findGitWorkspaceRoot(repoPath);
    if (gitRoot === null) {
        return { path: repoPath, name, available: false, driver: null, fence: null, receipts: [], pending_count: 0, reconciled_count: 0 };
    }
    // Discover the tracker root instead of assuming one. `.agents/pm` is the fleet
    // convention, but `.pm` is equally valid and a relocated tracker is legal, so a
    // hardcoded path made every non-conventional repo report a missing fence and
    // spuriously fail the gate. The SDK exposes no public tracker-root discovery
    // helper (only findGitWorkspaceRoot / ensureTrackerInitialized), so the
    // conventional roots are probed in order.
    //
    // The GIT ROOT is probed as well as the supplied path: `--repos <subdir>` must
    // still audit the enclosing repository's tracker. Probing only the supplied
    // path meant a path below the git root found no tracker, reported driver and
    // fence as not-applicable, and silently exited 0 — a false NEGATIVE that
    // disabled the gate entirely (caught in review by Greptile's T-Rex run).
    const trackerCandidates = [repoPath, gitRoot].flatMap((base) => [
        join(base, ".agents", "pm"),
        join(base, ".pm"),
    ]);
    const pmRoot = trackerCandidates.find((candidate) => existsSync(join(candidate, "settings.json")));
    // A git repo with NO pm workspace has no merge-safety obligation at all: there
    // are no tracker artifacts for the field-aware driver to protect and no fence to
    // audit. Reporting either as missing would fail the gate over a repo that is
    // correctly configured for what it is, so both are reported as `null`
    // (not-applicable) and both summary counts exclude `null` by design.
    const driver = pmRoot === undefined
        ? null
        : await auditMergeDriverConfiguration(gitRoot);
    // The fence audit compares the committed block against the active schema's
    // type folders.
    const fence = pmRoot === undefined
        ? null
        : await auditMergeAttributeFence(pmRoot, discoverTypeFolders(pmRoot));
    const receipts = await listMergeReceipts(repoPath, { includeReconciled });
    const views = receipts.map(toReceiptView);
    const pending_count = views.filter((r) => r.state === "pending").length;
    const reconciled_count = views.filter((r) => r.state === "reconciled").length;
    return { path: repoPath, name, available: true, driver, fence, receipts: views, pending_count, reconciled_count };
}
/**
 * Collect merge-receipt reports across many repos in the order passed on
 * `--repos`, rolling per-repo counts into fleet-wide gate signals. A receipt is
 * `pending` until `pm merge reconcile` embeds it into committed history; the
 * gate fails when any pending receipt or any missing driver/fence is found.
 */
async function collectMergeReceiptsAll(repos, includeReconciled, progress) {
    const repoReports = [];
    for (const repo of repos) {
        progress(`merge-receipts ${repoLabel(repo)}`);
        repoReports.push(await collectMergeReceiptsRepo(repo, includeReconciled));
    }
    const total = repoReports.length;
    const with_pending = repoReports.filter((r) => r.pending_count > 0).length;
    const total_pending = repoReports.reduce((sum, r) => sum + r.pending_count, 0);
    const total_reconciled = repoReports.reduce((sum, r) => sum + r.reconciled_count, 0);
    const missing_driver = repoReports.filter((r) => r.driver?.status === "missing").length;
    // Driver `drift` means "the configured command does not match THIS installation",
    // which is a false positive whenever the driver was installed by an equally valid
    // pm (e.g. a repo's own devDependency vs a global install) — filed upstream as
    // unbraind/pm-cli#773. It is reported but deliberately does NOT fail the gate,
    // because "repair" flips the config to a machine-global path, the next
    // `npm install` prepare hook flips it back, and the loop never converges.
    const drifted_driver = repoReports.filter((r) => r.driver?.status === "drift").length;
    // Fence `drift` is different: `missing_patterns` means some item type folder (or
    // a tracker JSONL store) is NOT covered by the committed fence, so those paths
    // fall back to git's line-based merge — the exact data-loss the field-aware
    // driver exists to prevent. That fails the gate. Purely `stale_patterns` drift
    // is over-coverage and harmless, so it is reported without failing.
    const unprotected_fence = repoReports.filter((r) => r.fence?.status === "drift" && r.fence.missing_patterns.length > 0).length;
    const drifted_fence = repoReports.filter((r) => r.fence?.status === "drift").length;
    const missing_fence = repoReports.filter((r) => r.fence?.status === "not_installed").length;
    return {
        generated_at: new Date().toISOString(),
        repos: repoReports,
        summary: { total, with_pending, total_pending, total_reconciled, missing_driver, missing_fence, drifted_driver, drifted_fence, unprotected_fence },
    };
}
/**
 * Render arbitrary text as one markdown table cell.
 *
 * Escaping the pipe alone is incomplete in both directions. A backslash already
 * in the text consumes the escape that follows it, so a value ending in one
 * turns the next cell boundary back into a separator and shifts every remaining
 * column; and an embedded newline ends the row outright, so the rest of the
 * value is read as a new row with the wrong number of cells. Backslashes are
 * therefore escaped before pipes, and all whitespace is collapsed to spaces,
 * before the value is truncated to keep a report line readable.
 *
 * @param text - The value to place in a cell.
 * @param limit - Maximum rendered length; longer values are truncated.
 * @returns A single-line, pipe-safe cell value.
 */
function markdownCell(text, limit) {
    const escaped = text
        .replace(/\\/g, "\\\\")
        .replace(/\|/g, "\\|")
        .replace(/\s+/g, " ");
    const truncated = escaped.slice(0, limit);
    return truncated.replace(/\\+$/, (slashes) => slashes.length % 2 === 0 ? slashes : slashes.slice(0, -1));
}
/**
 * Render an unknown retained/discarded value as a short, single-line markdown cell.
 *
 * `retained` and `discarded` are typed `unknown`, and a receipt written by an
 * older pm merge driver can omit either one. pm 2026.8.31 always populates both
 * for the conflict shapes the test lab produces, so this `undefined` arm is no
 * longer reachable through a live merge — it is covered directly instead. Do not
 * delete it: it is what keeps an older or partial receipt rendering as `-`
 * rather than the string `"undefined"`.
 */
function describeDecisionValue(value) {
    if (value === undefined)
        return "-";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return markdownCell(text, 120);
}
/**
 * Render the merge-receipt report as a GitHub-flavoured markdown document: a
 * fleet summary table, a per-repo driver/fence status line, and one row per
 * receipt with its state, item id, repository-relative path, preferred side, and the
 * retained/discarded values for every scalar conflict decision.
 */
export function renderMergeReceiptsMarkdown(result) {
    const lines = [];
    lines.push("# pm-ops merge-receipts");
    lines.push("");
    lines.push(`Scanned **${result.summary.total}** repo(s): **${result.summary.total_pending}** pending receipt(s), ` +
        `**${result.summary.total_reconciled}** reconciled, **${result.summary.missing_driver}** missing driver(s), ` +
        `**${result.summary.missing_fence}** missing fence(s).`);
    lines.push("");
    lines.push(renderMarkdownRow(["repo", "available", "driver", "fence", "pending", "reconciled"]));
    lines.push(renderMarkdownRow(["---", "---", "---", "---", "---", "---"]));
    for (const repo of result.repos) {
        lines.push(renderMarkdownRow([
            repo.name ?? basename(repo.path),
            repo.available ? "yes" : "no",
            repo.driver ? repo.driver.status : "-",
            repo.fence ? repo.fence.status : "-",
            String(repo.pending_count),
            String(repo.reconciled_count),
        ]));
    }
    lines.push("");
    for (const repo of result.repos) {
        if (repo.receipts.length === 0)
            continue;
        lines.push(`## ${repo.name ?? basename(repo.path)}`);
        lines.push("");
        lines.push(renderMarkdownRow(["receipt", "item_id", "state", "item_path", "preferred", "field", "retained", "discarded"]));
        lines.push(renderMarkdownRow(["---", "---", "---", "---", "---", "---", "---", "---"]));
        for (const receipt of repo.receipts) {
            // A receipt with no recoverable scalar decisions still deserves a row, so the
            // report never silently omits a pending receipt. pm 2026.8.31 records at least
            // one decision for every conflict the lab can produce, so this fallback is
            // covered directly rather than through a live merge.
            const decisions = receipt.decisions.length > 0 ? receipt.decisions : [{ field: "-", retained: "-", discarded: "-" }];
            for (const decision of decisions) {
                lines.push(renderMarkdownRow([
                    receipt.id,
                    receipt.item_id,
                    receipt.state,
                    receipt.item_path,
                    receipt.preferred,
                    decision.field,
                    describeDecisionValue(decision.retained),
                    describeDecisionValue(decision.discarded),
                ]));
            }
        }
        lines.push("");
    }
    return lines.join("\n");
}
/** Compose the combined scan, policy, and optional release report for the fleet. */
function buildReport(repos, progress, includeRelease = false) {
    const scan = scanRepos(repos, progress);
    const policy = runPolicy(repos, DEFAULT_POLICY, progress);
    const release = includeRelease ? verifyRelease(repos, progress) : undefined;
    return { generated_at: new Date().toISOString(), scan, policy, release };
}
// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
function formatBool(v) {
    return v ? "yes" : "no";
}
function formatCount(v) {
    return v === null ? "?" : String(v);
}
function renderMarkdownRow(cells) {
    return `| ${cells.join(" | ")} |`;
}
/** Render the per-repo scan snapshot as a wide markdown readiness table. */
function renderScanMarkdown(result) {
    const lines = [];
    lines.push("# pm-ops scan");
    lines.push("");
    lines.push(`Scanned **${result.summary.total}** repo(s): **${result.summary.ready}** ready, **${result.summary.not_ready}** not ready.`);
    lines.push("");
    lines.push(renderMarkdownRow(["repo", "version", "strict", "changelog", "release", "ci", "pm-changelog", "open items", "outdated", "critical", "high", "prs", "issues", "ready", "diagnostics"]));
    lines.push(renderMarkdownRow(["---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---"]));
    for (const r of result.repos) {
        const openItems = r.pm_open_items === null ? "?" : `${r.pm_open_items}/${r.pm_inprogress_items}`;
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
            r.errors.length === 0 ? "-" : markdownCell(r.errors.join("; "), 300),
        ]));
    }
    lines.push("");
    return lines.join("\n");
}
/** Render the policy result as a markdown table of checks per repo. */
function renderPolicyMarkdown(result) {
    const lines = [];
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
                markdownCell(c.message, 2000),
            ]));
        }
    }
    lines.push("");
    return lines.join("\n");
}
/** Render the combined report as scan, policy, and release markdown sections. */
function renderReportMarkdown(result) {
    const sections = [];
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
/** Canonicalize a raw pm status string into a stable lowercase token. */
function normalizeStatus(raw) {
    const s = (raw ?? "").toLowerCase().trim();
    if (!s)
        return "unknown";
    if (CLOSED_STATUSES.has(s))
        return "closed";
    if (CANCELED_STATUSES.has(s))
        return "canceled";
    return s.replace(/[\s-]+/g, "_");
}
/** Nearest-rank percentile over an unsorted numeric array. */
function percentile(values, q) {
    if (values.length === 0)
        return null;
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1)
        return sorted[0];
    const rank = Math.ceil(q * sorted.length);
    const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
    return sorted[idx];
}
function parseTime(value) {
    if (!value)
        return null;
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
}
/** Compute the item-status and freshness metrics for one repository asynchronously. */
async function computeRepoMetrics(repo, nowMs, staleThresholdDays) {
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
            merge_receipts_pending: 0,
            merge_receipts_reconciled: 0,
            merge_driver_installed: 0,
            merge_fence_installed: 0,
        };
    }
    const status_counts = {};
    const type_counts = {};
    const priority_counts = {};
    const staleThresholdMs = staleThresholdDays * DAY_MS;
    const cycleTimes = [];
    const backlogAges = [];
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
            if (updated !== null && nowMs - updated > staleThresholdMs)
                stale += 1;
            const created = parseTime(item.created_at);
            if (created !== null)
                backlogAges.push((nowMs - created) / 1000);
        }
        if (status === "closed") {
            const closed = parseTime(item.closed_at);
            if (closed !== null) {
                if (nowMs - closed <= 7 * DAY_MS)
                    throughput_7d += 1;
                if (nowMs - closed <= 30 * DAY_MS)
                    throughput_30d += 1;
                const created = parseTime(item.created_at);
                if (created !== null && closed >= created)
                    cycleTimes.push((closed - created) / 1000);
            }
        }
    }
    // Merge-receipt / driver / fence audit (clone-local, git-level). Computed
    // for every repo with a pm workspace so Prometheus can alarm on silent merge
    // drops and missing merge-safety configuration. Reuses the merge-receipts
    // collector so the two surfaces never drift on what "installed" means.
    const merge = await collectMergeReceiptsRepo(repo, true);
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
        merge_receipts_pending: merge.pending_count,
        merge_receipts_reconciled: merge.reconciled_count,
        merge_driver_installed: merge.driver ? (merge.driver.status === "missing" ? 0 : 1) : 0,
        merge_fence_installed: merge.fence ? (merge.fence.status === "not_installed" ? 0 : 1) : 0,
    };
}
/** Compute metrics across every repo in parallel and time the full scrape. */
async function collectMetricsAll(repos, staleThresholdDays, progress) {
    // A Prometheus exporter is scraped repeatedly. The module-level read caches
    // dedupe pm invocations *within one scrape*, but must not survive across
    // scrapes — otherwise a long-lived host re-invoking this handler would serve
    // the first scrape's items forever. Clear them so every scrape reads fresh.
    for (const cache of PM_READ_CACHES)
        cache.clear();
    const start = Date.now();
    const nowMs = start;
    const repoMetrics = [];
    for (const repo of repos) {
        progress(`metrics: ${repoLabel(repo)}`);
        repoMetrics.push(await computeRepoMetrics(repo, nowMs, staleThresholdDays));
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
function escapeLabel(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
/** Format one Prometheus metric sample line with sorted labels and a value. */
function metricLine(name, labels, value) {
    const entries = Object.entries(labels);
    if (entries.length === 0)
        return `${name} ${value}`;
    const labelStr = entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",");
    return `${name}{${labelStr}} ${value}`;
}
/** Stable Prometheus repo label: package name, else directory basename. */
function repoLabel(repoPath) {
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
export function disambiguateRepoLabels(repoMetrics) {
    const labelCounts = new Map();
    for (const r of repoMetrics)
        labelCounts.set(r.repo, (labelCounts.get(r.repo) ?? 0) + 1);
    // Reserve every label a non-colliding repo keeps verbatim BEFORE generating
    // any disambiguated label. Otherwise a generated `foo (bar)` could collide
    // with a distinct repo genuinely labeled `foo (bar)` that stays untouched,
    // re-emitting duplicate Prometheus series.
    const used = new Set();
    for (const r of repoMetrics) {
        if (labelCounts.get(r.repo) <= 1)
            used.add(r.repo);
    }
    for (const r of repoMetrics) {
        if (labelCounts.get(r.repo) <= 1)
            continue;
        // Prefer the directory basename, then the full path; both are checked
        // against every already-claimed label (reserved originals + prior
        // generations), with a numeric suffix as a guaranteed-unique last resort.
        let label = [`${r.repo} (${basename(r.path)})`, `${r.repo} (${r.path})`].find((c) => !used.has(c));
        if (!label) {
            const base = `${r.repo} (${r.path})`;
            label = base;
            let n = 2;
            while (used.has(label))
                label = `${base} #${n++}`;
        }
        r.repo = label;
        used.add(label);
    }
}
/** Render the fleet metrics as a Prometheus text exposition with help and type. */
function renderMetricsPrometheus(result) {
    const lines = [];
    const push = (name, help, type, samples) => {
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} ${type}`);
        lines.push(...samples);
    };
    const itemSamples = [];
    const typeSamples = [];
    const prioritySamples = [];
    const blockedSamples = [];
    const staleSamples = [];
    const throughputSamples = [];
    const cycleSamples = [];
    const backlogSamples = [];
    const availableSamples = [];
    const mergePendingSamples = [];
    const mergeReconciledSamples = [];
    const mergeDriverSamples = [];
    const mergeFenceSamples = [];
    for (const repo of result.repos) {
        availableSamples.push(metricLine("pm_workspace_available", { repo: repo.repo }, repo.available ? 1 : 0));
        // Merge-receipt / driver / fence gauges are git-level (clone-local), so
        // they are emitted for every repo — including those without a pm workspace.
        mergePendingSamples.push(metricLine("pm_merge_receipts_pending", { repo: repo.repo }, repo.merge_receipts_pending));
        mergeReconciledSamples.push(metricLine("pm_merge_receipts_reconciled", { repo: repo.repo }, repo.merge_receipts_reconciled));
        mergeDriverSamples.push(metricLine("pm_merge_driver_installed", { repo: repo.repo }, repo.merge_driver_installed));
        mergeFenceSamples.push(metricLine("pm_merge_fence_installed", { repo: repo.repo }, repo.merge_fence_installed));
        if (!repo.available)
            continue;
        for (const [status, count] of Object.entries(repo.status_counts)) {
            itemSamples.push(metricLine("pm_items", { repo: repo.repo, status }, count));
        }
        for (const [type, count] of Object.entries(repo.type_counts)) {
            typeSamples.push(metricLine("pm_active_items_by_type", { repo: repo.repo, type }, count));
        }
        for (const [priority, count] of Object.entries(repo.priority_counts)) {
            prioritySamples.push(metricLine("pm_active_items_by_priority", { repo: repo.repo, priority }, count));
        }
        if (repo.blocked !== null)
            blockedSamples.push(metricLine("pm_blocked_items", { repo: repo.repo }, repo.blocked));
        staleSamples.push(metricLine("pm_stale_items", { repo: repo.repo }, repo.stale));
        throughputSamples.push(metricLine("pm_throughput_items", { repo: repo.repo, window: "7d" }, repo.throughput_7d));
        throughputSamples.push(metricLine("pm_throughput_items", { repo: repo.repo, window: "30d" }, repo.throughput_30d));
        if (repo.cycle_time_p50_seconds !== null)
            cycleSamples.push(metricLine("pm_cycle_time_seconds", { repo: repo.repo, quantile: "0.5" }, repo.cycle_time_p50_seconds));
        if (repo.cycle_time_p90_seconds !== null)
            cycleSamples.push(metricLine("pm_cycle_time_seconds", { repo: repo.repo, quantile: "0.9" }, repo.cycle_time_p90_seconds));
        if (repo.backlog_age_p50_seconds !== null)
            backlogSamples.push(metricLine("pm_backlog_age_seconds", { repo: repo.repo, quantile: "0.5" }, repo.backlog_age_p50_seconds));
        if (repo.backlog_age_p90_seconds !== null)
            backlogSamples.push(metricLine("pm_backlog_age_seconds", { repo: repo.repo, quantile: "0.9" }, repo.backlog_age_p90_seconds));
    }
    push("pm_items", "Number of pm items by lifecycle status.", "gauge", itemSamples);
    push("pm_active_items_by_type", "Active (non-closed/canceled/draft) pm items by item type.", "gauge", typeSamples);
    push("pm_active_items_by_priority", "Active pm items by priority (0..4, or none).", "gauge", prioritySamples);
    push("pm_blocked_items", "Open pm items blocked by unresolved dependencies (per pm list --status blocked).", "gauge", blockedSamples);
    push("pm_stale_items", `Active pm items not updated within the stale threshold (${result.stale_threshold_days}d).`, "gauge", staleSamples);
    push("pm_throughput_items", "Items closed within the trailing window.", "gauge", throughputSamples);
    push("pm_cycle_time_seconds", "Cycle time (closed_at - created_at) of closed items, by quantile.", "gauge", cycleSamples);
    push("pm_backlog_age_seconds", "Age (now - created_at) of active items, by quantile.", "gauge", backlogSamples);
    push("pm_workspace_available", "1 if the repo exposed a readable pm workspace, else 0.", "gauge", availableSamples);
    push("pm_merge_receipts_pending", "Clone-local merge decision receipts not yet represented in committed history (state: pending).", "gauge", mergePendingSamples);
    push("pm_merge_receipts_reconciled", "Clone-local merge decision receipts already embedded in committed history (state: reconciled).", "gauge", mergeReconciledSamples);
    push("pm_merge_driver_installed", "1 if the pm field-aware merge driver is installed in clone-local git config (not missing), else 0.", "gauge", mergeDriverSamples);
    push("pm_merge_fence_installed", "1 if a committed .gitattributes merge-driver fence is present (not missing), else 0.", "gauge", mergeFenceSamples);
    push("pm_repos_scanned", "Number of repos with a readable pm workspace.", "gauge", [metricLine("pm_repos_scanned", {}, result.repos_scanned)]);
    push("pm_scrape_duration_seconds", "Time spent collecting pm metrics for this scrape.", "gauge", [metricLine("pm_scrape_duration_seconds", {}, result.scrape_duration_seconds)]);
    return lines.join("\n") + "\n";
}
/** Serialize a result in the requested transport format with one trailing newline. */
function serializeResult(structured, format, formatter) {
    const body = format === "markdown"
        ? formatter()
        : format === "toon"
            ? encode(structured)
            : JSON.stringify(structured, null, 2);
    return body.endsWith("\n") ? body : `${body}\n`;
}
/** Emit a structured result honoring format and output, returning the host-rendered payload. */
function emitResult(structured, format, outputPath, formatter) {
    if (outputPath) {
        mkdirSync(dirname(resolve(outputPath)), { recursive: true });
        writeFileSync(outputPath, serializeResult(structured, format, formatter), "utf-8");
        console.error(`pm-ops: wrote ${format} output to ${outputPath}`);
        return { written_to: outputPath, format };
    }
    if (format === "toon")
        return structured;
    if (format === "json")
        return renderedCommandResult(`${JSON.stringify(structured, null, 2)}\n`);
    return renderedCommandResult(formatter());
}
/** Cap on violations retained per repo so structured output stays readable for noisy repos. */
const DOCSTRING_VIOLATIONS_PER_REPO = 50;
/**
 * Run the docstring analyzer across every repo and roll the per-repo reports
 * into one aggregate result. A repo with no TypeScript source is recorded as
 * an error rather than crashing the whole fleet scan.
 */
function collectDocstringsAll(repos, progress) {
    const repoResults = repos.map((repoPath) => {
        progress(`docstrings ${repoLabel(repoPath)}`);
        try {
            const report = analyzeDocstringCoverage({ root: repoPath });
            return {
                repo: repoPath,
                name: readPackageJson(repoPath)?.name ?? basename(repoPath),
                files_scanned: report.files_scanned,
                declarations_checked: report.declarations_checked,
                violation_count: report.violations.length,
                violations: report.violations.slice(0, DOCSTRING_VIOLATIONS_PER_REPO),
            };
        }
        catch (err) {
            return {
                repo: repoPath,
                name: basename(repoPath),
                files_scanned: 0,
                declarations_checked: 0,
                violation_count: 0,
                violations: [],
                error: errorMessage(err),
            };
        }
    });
    const totalViolations = repoResults.reduce((sum, repo) => sum + repo.violation_count, 0);
    return {
        repos: repoResults,
        summary: {
            total: repoResults.length,
            with_violations: repoResults.filter((repo) => repo.violation_count > 0 || repo.error).length,
            total_violations: totalViolations,
        },
    };
}
/** Render the docstring coverage result as a markdown table with a per-repo violation breakdown. */
function renderDocstringsMarkdown(result) {
    const lines = [
        "# pm-ops docstrings",
        "",
        `Scanned **${result.summary.total}** repo(s): **${result.summary.with_violations}** with violations, **${result.summary.total_violations}** total violation(s).`,
        "",
        renderMarkdownRow(["repo", "files", "declarations", "violations", "sample"]),
        renderMarkdownRow(["---", "---", "---", "---", "---"]),
    ];
    for (const repo of result.repos) {
        const sample = repo.violations[0]
            ? `${repo.violations[0].symbol} (${repo.violations[0].reason})`
            : repo.error ?? "clean";
        lines.push(renderMarkdownRow([
            repo.name,
            String(repo.files_scanned),
            String(repo.declarations_checked),
            repo.error ? "error" : String(repo.violation_count),
            markdownCell(sample, 120),
        ]));
    }
    lines.push("");
    return lines.join("\n");
}
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
/**
 * Local stand-in for the SDK's `defineExtension` identity helper.
 *
 * Declared here rather than imported so this package keeps a type-only
 * dependency on `@unbrained/pm-cli` and adds no runtime module edge. The
 * generic constraint is the SDK's own, so the extension object is contract-
 * checked against {@link ExtensionModule} exactly as the imported helper would.
 */
const defineExtension = (module) => module;
export default defineExtension({
    name: "pm-ops",
    version: "2026.9.2",
    activate(api) {
        if (typeof api.registerRenderer === "function") {
            // Derived from OPS_COMMAND_PATHS rather than restated. A literal copy is
            // right the day it is written and wrong the day a command is added: the
            // new command registers, returns a pmOpsRendered result, and silently
            // falls back to native rendering because the host declines it. Nothing
            // fails — not the build, not the types, not a test whose expected list
            // carries the same omission. Pointing at the one list every ops command
            // already registers through makes the drift impossible instead of merely
            // unlikely.
            const rendererOwnership = {
                commands: [...OPS_COMMAND_PATHS],
                resultDiscriminator: isRenderedCommandResult,
            };
            api.registerRenderer("toon", renderCommandResult, rendererOwnership);
            api.registerRenderer("json", renderCommandResult, rendererOwnership);
        }
        // Expose the fleet's pinned code-quality thresholds as audited assurance
        // measurements so a bound can no longer move in an ordinary diff. The
        // provider reads a local lcov report and the canonical docstring analyzer;
        // it refuses a stale report, so weakening a coverage floor now requires the
        // same `authorization_decision` as any other bound regression. See
        // `./assurance.ts` for the key contract and the staleness refusal.
        api.registerAssuranceMeasurementProvider(qualityMeasurementProvider);
        api.registerCommand({
            name: "ops scan",
            description: "Scan a set of pm repositories and produce a per-repo release-readiness snapshot " +
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
                { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
                { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
            ],
            async run(ctx) {
                const options = ctx.options;
                const repos = resolveRepos(options, ctx.args);
                const format = resolveFormat(options, ctx.global);
                const outputPath = readString(options, "output");
                console.error(`pm-ops scan: ${repos.length} repo(s)`);
                const result = scanRepos(repos, (m) => console.error(`  ${m}`));
                console.error(`scan: ${result.summary.ready}/${result.summary.total} ready`);
                return emitResult(result, format, outputPath, () => renderScanMarkdown(result));
            },
        });
        api.registerCommand({
            name: "ops policy",
            description: "Validate a policy bundle against repos. Default policy checks: naming " +
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
                { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
                { long: "--strict", description: "Exit non-zero on any failed check (any severity)" },
                { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
            ],
            async run(ctx) {
                const options = ctx.options;
                const repos = resolveRepos(options, ctx.args);
                const format = resolveFormat(options, ctx.global);
                const strict = readBool(options, "strict");
                const outputPath = readString(options, "output");
                let bundle = DEFAULT_POLICY;
                const policyFile = readString(options, "policy");
                if (policyFile) {
                    const loaded = readJsonFile(resolve(policyFile));
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
                    }
                    else if (format === "markdown") {
                        const md = renderPolicyMarkdown(result);
                        process.stdout.write(md);
                    }
                    else {
                        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
                    }
                    throw new CommandError(`policy: ${result.summary.failed} check(s) failed (strict mode)`, EXIT_CODE.GENERIC_FAILURE);
                }
                return emitResult(result, format, outputPath, () => renderPolicyMarkdown(result));
            },
        });
        api.registerCommand({
            name: "ops verify-release",
            description: "Run the release gate matrix per repo: executes `npm run release:check` (or the individual " +
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
                { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
                { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
            ],
            async run(ctx) {
                const options = ctx.options;
                const repos = resolveRepos(options, ctx.args);
                const format = resolveFormat(options, ctx.global);
                const outputPath = readString(options, "output");
                console.error(`pm-ops verify-release: ${repos.length} repo(s)`);
                const result = verifyRelease(repos, (m) => console.error(`  ${m}`));
                console.error(`verify-release: ${result.summary.passed}/${result.summary.total} repos passed`);
                const failed = result.summary.failed > 0;
                if (failed) {
                    // Log a concise summary of which repos failed and why
                    for (const repo of result.repos) {
                        if (repo.failed > 0) {
                            const failedChecks = repo.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${releaseCheckError(c).slice(0, 120)}`);
                            console.error(`  FAIL ${repo.name ?? basename(repo.path)}: ${failedChecks.join("; ")}`);
                        }
                    }
                }
                if (outputPath) {
                    mkdirSync(dirname(resolve(outputPath)), { recursive: true });
                    const body = format === "markdown" ? renderVerifyReleaseMarkdown(result) : `${JSON.stringify(result, null, 2)}\n`;
                    writeFileSync(outputPath, body, "utf-8");
                    console.error(`pm-ops: wrote ${format} output to ${outputPath}`);
                    if (failed)
                        throw new CommandError(`verify-release: ${result.summary.failed} repo(s) failed`, EXIT_CODE.GENERIC_FAILURE);
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
                        process.stdout.write(md);
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
            description: "Emit a concise fleet report combining scan + policy results (and optionally verify-release). " +
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
                { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
                { long: "--output", value_name: "file", description: "Write the rendered report to a file instead of stdout" },
                { long: "--include-release", description: "Also run verify-release and include results in the report" },
            ],
            async run(ctx) {
                const options = ctx.options;
                const repos = resolveRepos(options, ctx.args);
                const format = resolveFormat(options, ctx.global);
                const outputPath = readString(options, "output");
                const includeRelease = readBool(options, "includeRelease", "include-release");
                console.error(`pm-ops report: ${repos.length} repo(s)${includeRelease ? " (+release)" : ""}`);
                const result = buildReport(repos, (m) => console.error(`  ${m}`), includeRelease);
                console.error(`report: scan ${result.scan.summary.ready}/${result.scan.summary.total} ready; policy ${result.policy.summary.failed} failed${result.release ? `; release ${result.release.summary.passed}/${result.release.summary.total} passed` : ""}`);
                return emitResult(result, format, outputPath, () => renderReportMarkdown(result));
            },
        });
        // --- New fleet operations commands ---
        api.registerCommand({
            name: "ops status",
            description: "Quick fleet status overview: for each repo shows name, version, ready/not-ready, " +
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
                { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
                { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
            ],
            async run(ctx) {
                const options = ctx.options;
                const repos = resolveRepos(options, ctx.args);
                const format = resolveFormat(options, ctx.global);
                const outputPath = readString(options, "output");
                console.error(`pm-ops status: ${repos.length} repo(s)`);
                const result = await collectStatusAll(repos, (m) => console.error(`  ${m}`));
                console.error(`status: ${result.summary.ready}/${result.summary.total} ready, ${result.summary.total_issues} issue(s)`);
                return emitResult(result, format, outputPath, () => renderStatusMarkdown(result));
            },
        });
        api.registerCommand({
            name: "ops outdated",
            description: "Check outdated dependencies across repos. Runs `npm outdated --json` per repo and " +
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
                { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
                { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
            ],
            async run(ctx) {
                const options = ctx.options;
                const repos = resolveRepos(options, ctx.args);
                const format = resolveFormat(options, ctx.global);
                const outputPath = readString(options, "output");
                console.error(`pm-ops outdated: ${repos.length} repo(s)`);
                const result = collectOutdatedAll(repos, (m) => console.error(`  ${m}`));
                console.error(`outdated: ${result.summary.repos_with_outdated}/${result.summary.total} repos with outdated, ${result.summary.total_outdated} total`);
                return emitResult(result, format, outputPath, () => renderOutdatedMarkdown(result));
            },
        });
        api.registerCommand({
            name: "ops audit",
            description: "Security vulnerability audit across repos. Runs `npm audit --omit=dev --json` per repo " +
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
                { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
                { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
            ],
            async run(ctx) {
                const options = ctx.options;
                const repos = resolveRepos(options, ctx.args);
                const format = resolveFormat(options, ctx.global);
                const outputPath = readString(options, "output");
                console.error(`pm-ops audit: ${repos.length} repo(s)`);
                const result = collectAuditAll(repos, (m) => console.error(`  ${m}`));
                console.error(`audit: ${result.summary.clean}/${result.summary.total} clean, ${result.summary.total_critical} critical, ${result.summary.total_high} high`);
                return emitResult(result, format, outputPath, () => renderAuditMarkdown(result));
            },
        });
        api.registerCommand({
            name: "ops metrics",
            description: "Export pm workspace health as Prometheus text-format gauges so a Prometheus/Grafana " +
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
                { long: "--format", value_name: "prometheus|json|toon", description: "Output format (default: prometheus)" },
                { long: "--output", value_name: "file", description: "Write output to a file instead of stdout (e.g. a node_exporter .prom textfile)" },
            ],
            async run(ctx) {
                const options = ctx.options;
                const repos = resolveRepos(options, ctx.args);
                const staleDaysRaw = Number(readString(options, "staleDays", "stale-days"));
                const staleThresholdDays = Number.isFinite(staleDaysRaw) && staleDaysRaw > 0 ? staleDaysRaw : 14;
                const outputPath = readString(options, "output");
                const rawFormat = readString(options, "format")?.toLowerCase();
                // The global --json flag forces clean JSON to stdout, matching the other
                // ops commands (and the fleet routing contract that scrapes payload.repos).
                // The installed CLI consumes global --json into ctx.global (not
                // ctx.options), so — unlike the other commands whose default returns a
                // `--json` is a host-owned global flag: extensions must not redeclare it
                // (the host rejects the registration) and must read it from ctx.global.
                // The metrics default is a pre-rendered Prometheus string, so — unlike
                // the other commands whose default returns a bare object the JSON
                // renderer can serialize — it must consult ctx.global explicitly.
                const global = ctx.global;
                const wantsJson = global.json === true || global.defaultOutputFormat === "json";
                const format = wantsJson
                    ? "json"
                    : rawFormat === "json" || rawFormat === "toon"
                        ? rawFormat
                        : "prometheus";
                console.error(`pm-ops metrics: ${repos.length} repo(s), stale threshold ${staleThresholdDays}d`);
                const result = await collectMetricsAll(repos, staleThresholdDays, (m) => console.error(`  ${m}`));
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
        api.registerCommand({
            name: "ops merge-receipts",
            description: "Audit clone-local merge decision receipts and merge-safety configuration across repos. " +
                "For each repo reports the field-aware merge-driver configuration audit, the committed " +
                ".gitattributes merge-fence audit, and every receipt the driver wrote under " +
                ".git/pm-merge-receipts/ with its state, item_id, conflicting fields, and the retained/" +
                "discarded values. Preserves the current pm SDK item_path as an auditable raw value. " +
                "Exits non-zero when any receipt is still pending (a peer scalar edit was " +
                "silently dropped and exists nowhere in committed history) or when the merge driver / fence " +
                "is missing in a scanned repo — the gate pm validate cannot (unbraind/pm-cli#770). " +
                "--warn-only reports identically but always exits 0.",
            intent: "gate fleet merges on clone-local decision receipts and merge-driver safety",
            arguments: additionalRepoArguments(),
            examples: [
                "pm ops merge-receipts",
                "pm ops merge-receipts --repos ./pm-csv ./pm-github",
                "pm ops merge-receipts --json",
                "pm ops merge-receipts --warn-only",
                "pm ops merge-receipts --include-reconciled --format markdown",
                "pm ops merge-receipts --repos ~/container/pm-* --format markdown --output MERGE.md",
            ],
            flags: [
                reposFlag("Repo paths to audit (comma-separated or repeatable; default: current dir)"),
                { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
                { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
                { long: "--warn-only", description: "Report identically but always exit 0 (never fail the gate)" },
                { long: "--include-reconciled", description: "Include receipts already represented in committed history (default: pending only)" },
            ],
            async run(ctx) {
                const options = ctx.options;
                const repos = resolveRepos(options, ctx.args);
                const format = resolveFormat(options, ctx.global);
                const outputPath = readString(options, "output");
                const warnOnly = readBool(options, "warnOnly", "warn-only");
                const includeReconciled = readBool(options, "includeReconciled", "include-reconciled");
                console.error(`pm-ops merge-receipts: ${repos.length} repo(s)${includeReconciled ? " (+reconciled)" : ""}${warnOnly ? " [warn-only]" : ""}`);
                const result = await collectMergeReceiptsAll(repos, includeReconciled, (m) => console.error(`  ${m}`));
                console.error(`merge-receipts: ${result.summary.total_pending} pending, ${result.summary.total_reconciled} reconciled, ` +
                    `${result.summary.missing_driver} missing driver(s), ${result.summary.missing_fence} missing fence(s), ` +
                    `${result.summary.unprotected_fence} uncovered fence(s); reported-not-gated: ` +
                    `${result.summary.drifted_driver} driver drift (upstream #773), ${result.summary.drifted_fence} fence drift`);
                const shouldFail = !warnOnly && (result.summary.total_pending > 0 || result.summary.missing_driver > 0 || result.summary.missing_fence > 0 || result.summary.unprotected_fence > 0);
                if (shouldFail) {
                    // Emit the report before throwing so agents get the full diagnostics AND
                    // the non-zero exit, matching how `ops verify-release` behaves on failure.
                    //
                    // Throwing bypasses the host's renderer, so the report has to be written
                    // to stdout here. That means the default `toon` format cannot be honored
                    // on the failure path — the host is what serializes TOON. JSON is used
                    // instead, and the substitution is announced on stderr rather than being
                    // a silent format change an agent would have to discover by parsing.
                    if (outputPath) {
                        emitResult(result, format, outputPath, () => renderMergeReceiptsMarkdown(result));
                    }
                    else if (format === "markdown") {
                        const md = renderMergeReceiptsMarkdown(result);
                        process.stdout.write(md);
                    }
                    else {
                        if (format === "toon") {
                            console.error("merge-receipts: gate failed — emitting JSON (the host TOON renderer is bypassed by the non-zero exit)");
                        }
                        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
                    }
                    const reasons = [];
                    if (result.summary.total_pending > 0)
                        reasons.push(`${result.summary.total_pending} pending receipt(s)`);
                    if (result.summary.missing_driver > 0)
                        reasons.push(`${result.summary.missing_driver} missing driver(s)`);
                    if (result.summary.missing_fence > 0)
                        reasons.push(`${result.summary.missing_fence} missing fence(s)`);
                    if (result.summary.unprotected_fence > 0)
                        reasons.push(`${result.summary.unprotected_fence} fence(s) leaving item paths uncovered`);
                    throw new CommandError(`merge-receipts: ${reasons.join(", ")} (reconcile with 'pm merge reconcile', or rerun with --warn-only)`, EXIT_CODE.GENERIC_FAILURE);
                }
                return emitResult(result, format, outputPath, () => renderMergeReceiptsMarkdown(result));
            },
        });
        api.registerCommand({
            name: "ops docstrings",
            description: "Audit docstring coverage across repos with a lexer-backed, fail-closed analyzer. " +
                "Every exported declaration, every public member of an exported class, and every " +
                "non-exported function with a long body must carry a real JSDoc block comment that " +
                "adds information the identifier does not. JSDoc inside strings, templates, or " +
                "commented-out lines cannot satisfy it. Exits non-zero when any repo has violations.",
            intent: "enforce docstring coverage across many pm repositories",
            arguments: additionalRepoArguments(),
            examples: [
                "pm ops docstrings",
                "pm ops docstrings --repos ./pm-csv ./pm-github",
                "pm ops docstrings --format markdown",
                "pm ops docstrings --repos ./pm-csv --json",
            ],
            flags: [
                reposFlag("Repo paths to audit (comma-separated or repeatable; default: current dir)"),
                { long: "--format", value_name: "toon|json|markdown", description: "Output format (default: toon)" },
                { long: "--output", value_name: "file", description: "Write the rendered output to a file instead of stdout" },
            ],
            async run(ctx) {
                const options = ctx.options;
                const repos = resolveRepos(options, ctx.args);
                const format = resolveFormat(options, ctx.global);
                const outputPath = readString(options, "output");
                console.error(`pm-ops docstrings: ${repos.length} repo(s)`);
                const result = collectDocstringsAll(repos, (m) => console.error(`  ${m}`));
                console.error(`docstrings: ${result.summary.total_violations} violation(s) across ${result.summary.with_violations}/${result.summary.total} repo(s)`);
                const failed = result.summary.with_violations;
                if (failed > 0) {
                    if (outputPath) {
                        emitResult(result, format, outputPath, () => renderDocstringsMarkdown(result));
                    }
                    else {
                        process.stdout.write(serializeResult(result, format, () => renderDocstringsMarkdown(result)));
                    }
                    throw new CommandError(`docstrings: ${failed} repo(s) with violations (${result.summary.total_violations} total)`, EXIT_CODE.GENERIC_FAILURE);
                }
                return emitResult(result, format, outputPath, () => renderDocstringsMarkdown(result));
            },
        });
        for (const commandPath of OPS_COMMAND_PATHS) {
            api.registerParser(commandPath, (context) => restoreCliRepoFlag(commandPath, context));
        }
    },
});
//# sourceMappingURL=index.js.map
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, chmodSync, symlinkSync } from "node:fs";
import { devNull, homedir, tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { GlobalOptions } from "@unbrained/pm-cli/sdk";
import { listMergeReceipts, markMergeReceiptReconciled } from "@unbrained/pm-cli/sdk/merge";
import { decode, encode } from "@toon-format/toon";

import extension, { disambiguateRepoLabels } from "../index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirror of the SDK's ExtensionCapability union, defined locally so the
 * manifest can be typed without importing a non-exported internal type. */
type ExtensionCapability = "commands" | "renderers" | "hooks" | "schema" | "importers" | "search" | "parser" | "preflight" | "services";

/** Rendered output marker (json/markdown format without --output). */
interface RenderedResult {
  pmOpsRendered: true;
  output: string;
}

/** Written-to-file result (when --output is used). */
interface WrittenResult {
  written_to: string;
  format: string;
}

// --- Scan ---
interface ScanRepo {
  name: string;
  path: string;
  strict_ts: boolean;
  has_changelog: boolean;
  has_release_workflow: boolean;
  has_ci: boolean;
  has_pm_changelog: boolean;
  pm_workspace: boolean;
  audit_critical: number | null;
  outdated_count: number | null;
  ready: boolean;
  errors: string[];
  open_prs: number | null;
  open_issues: number | null;
}
interface ScanResult {
  repos: ScanRepo[];
  summary: { total: number; ready: number; not_ready: number };
}

// --- Policy ---
interface PolicyCheck {
  id: string;
  pass: boolean;
  message: string;
  details?: string[];
}
interface PolicyRepo {
  name: string;
  path: string;
  checks: PolicyCheck[];
}
interface PolicyResult {
  repos: PolicyRepo[];
  summary: { total: number; passed: number; failed: number; by_severity: { error: number; warning: number; info: number } };
}

// --- Verify-release ---
interface VerifyCheck {
  name: string;
  pass: boolean;
  duration_ms: number;
  error?: string;
}
interface VerifyRepo {
  name?: string;
  path: string;
  checks: VerifyCheck[];
  failed: number;
}
interface VerifyResult {
  repos: VerifyRepo[];
  summary: { passed: number; failed: number; total: number };
}

// --- Report ---
interface ReportResult {
  scan: ScanResult;
  policy: PolicyResult;
  release?: VerifyResult;
}

// --- Status ---
interface StatusRepo {
  name: string | null;
  ready: boolean;
  issues: string[];
}
interface StatusResult {
  repos: StatusRepo[];
  summary: { total: number; ready: number; not_ready: number; total_issues: number };
}

// --- Outdated ---
interface OutdatedResult {
  repos: Array<{ name: string | null; count: number | null; error?: string; outdated: Array<{ name: string; current: string; wanted: string; latest: string; type: string }> }>;
  summary: { total: number; total_outdated: number; repos_with_outdated: number };
}

// --- Audit ---
interface AuditResult {
  repos: Array<{ path: string; name: string | null; critical: number | null; high: number | null; moderate: number | null; low: number | null; total: number | null; ok: boolean }>;
  summary: { total: number; clean: number; unknown: number; total_critical: number; total_high: number };
}

// --- Metrics ---
interface MetricsRepo {
  path: string;
  available: boolean;
  repo: string;
  status_counts: Record<string, number>;
  cycle_time_p50_seconds: number | null;
  cycle_time_p90_seconds: number | null;
}
interface MetricsResult {
  repos: MetricsRepo[];
  repos_scanned: number;
  generated_at: string;
}

// --- Merge-receipts ---
interface MergeReceiptDecision {
  field: string;
  retained: unknown;
  discarded: unknown;
}
interface MergeReceiptView {
  id: string;
  item_id: string;
  item_path: string;
  item_path_raw: string;
  state: string;
  preferred: string;
  decisions: MergeReceiptDecision[];
}
interface RepoMergeReceipts {
  path: string;
  name: string | null;
  available: boolean;
  driver: { status: string; missing_keys: string[]; drifted_keys: string[] } | null;
  fence: { status: string; missing_patterns: string[]; stale_patterns: string[] } | null;
  receipts: MergeReceiptView[];
  pending_count: number;
  reconciled_count: number;
}
interface MergeReceiptsResult {
  repos: RepoMergeReceipts[];
  summary: {
    total: number;
    with_pending: number;
    total_pending: number;
    total_reconciled: number;
    missing_driver: number;
    missing_fence: number;
    drifted_driver: number;
    drifted_fence: number;
    unprotected_fence: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf-8")) as {
  capabilities: readonly ExtensionCapability[];
};
const OPS_COMMANDS = ["ops scan", "ops policy", "ops verify-release", "ops report", "ops status", "ops outdated", "ops audit", "ops metrics", "ops merge-receipts", "ops docstrings"] as const;

// Real fleet paths used for local real-data testing. CI and other developers
// can set PM_OPS_TEST_REPOS to opt into the same checks with their own paths.
const REAL_REPOS = (process.env.PM_OPS_TEST_REPOS ?? "")
  .split(/[,:]/)
  .map((entry) => entry.trim())
  .filter(Boolean);
const REAL_REPOS_AVAILABLE = REAL_REPOS.length >= 2 && REAL_REPOS.every((p) => existsSync(join(p, "package.json")));

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function createAuditFailureBin(name: string, includeGh = false, mode: "json" | "stderr" | "success" = "json"): string {
  const bin = join(tmpRoot, name);
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    const auditFailure = mode === "json" ? 'echo {"error":{"code":"EAI_AGAIN","summary":"registry unavailable"}}' : "echo non-JSON audit failure 1>&2";
    const npmBody = mode === "success"
      ? `@echo off
if "%~1"=="outdated" (
  if "%PM_OPS_FAKE_SCENARIO%"=="outdated" (echo {"example":{"current":"1.0.0","wanted":"1.1.0","latest":"2.0.0","type":"dependencies"}} & exit /b 1)
  if "%PM_OPS_FAKE_SCENARIO%"=="outdated-defaults" (echo {"example":{}} & exit /b 1)
  if "%PM_OPS_FAKE_SCENARIO%"=="outdated-error" (echo npm error code EFAIL 1>&2 & echo npm error fleet unavailable 1>&2 & exit /b 2)
  if "%PM_OPS_FAKE_SCENARIO%"=="outdated-code" (echo npm error code ECODE 1>&2 & exit /b 2)
  if "%PM_OPS_FAKE_SCENARIO%"=="outdated-invalid-fail" (echo not-json & exit /b 1)
  echo not-json & exit /b 0
)
  if "%~1"=="audit" (
  if "%PM_OPS_FAKE_SCENARIO%"=="audit-vulns" (echo {"metadata":{"vulnerabilities":{"critical":1,"high":2,"moderate":3,"low":4,"total":10}}} & exit /b 1)
  if "%PM_OPS_FAKE_SCENARIO%"=="audit-empty" (echo {"metadata":{"vulnerabilities":{}}} & exit /b 0)
  if "%PM_OPS_FAKE_SCENARIO%"=="audit-string" (echo {"error":"registry unavailable"} & exit /b 1)
  if "%PM_OPS_FAKE_SCENARIO%"=="audit-object-empty" (echo {"error":{}} & exit /b 1)
  echo {} & exit /b 1
)
exit /b 1
`
      : `@echo off\nif "%~1"=="outdated" (echo {} & exit /b 0)\nif "%~1"=="audit" (${auditFailure} & exit /b 1)\nexit /b 1\n`;
    writeFileSync(join(bin, "npm.cmd"), npmBody);
    if (includeGh) writeFileSync(join(bin, "gh.cmd"), mode === "success"
      ? `@echo off
if "%~1"=="repo" (if "%PM_OPS_FAKE_SCENARIO%"=="gh-fail" exit /b 1)
if "%~1"=="repo" (if "%PM_OPS_FAKE_SCENARIO%"=="gh-invalid" (echo maybe) else (if "%PM_OPS_FAKE_SCENARIO%"=="private" (echo true) else (echo false)))
if "%~1"=="pr" (if "%PM_OPS_FAKE_SCENARIO%"=="gh-fail" (exit /b 1) else (if "%PM_OPS_FAKE_SCENARIO%"=="gh-lists-invalid" (echo {}) else (echo [{"number":1}])))
if "%~1"=="issue" (if "%PM_OPS_FAKE_SCENARIO%"=="gh-fail" (exit /b 1) else (if "%PM_OPS_FAKE_SCENARIO%"=="gh-lists-invalid" (echo {}) else (echo [{"number":1},{"number":2}])))
`
      : "@echo off\necho []\n");
  } else {
    writeFileSync(join(bin, "npm"), mode === "success" ? `#!/usr/bin/env sh
case "$1:$PM_OPS_FAKE_SCENARIO" in
  outdated:outdated) printf '{"example":{"current":"1.0.0","wanted":"1.1.0","latest":"2.0.0","type":"dependencies"}}\\n'; exit 1 ;;
  outdated:outdated-defaults) printf '{"example":{}}\\n'; exit 1 ;;
  outdated:outdated-error) printf 'npm error code EFAIL\\nnpm error fleet unavailable\\n' >&2; exit 2 ;;
  outdated:outdated-code) printf 'npm error code ECODE\\n' >&2; exit 2 ;;
  outdated:outdated-invalid-fail) printf 'not-json\\n'; exit 1 ;;
  outdated:*) printf 'not-json\\n'; exit 0 ;;
  audit:audit-vulns) printf '{"metadata":{"vulnerabilities":{"critical":1,"high":2,"moderate":3,"low":4,"total":10}}}\\n'; exit 1 ;;
  audit:audit-empty) printf '{"metadata":{"vulnerabilities":{}}}\\n'; exit 0 ;;
  audit:audit-string) printf '{"error":"registry unavailable"}\\n'; exit 1 ;;
  audit:audit-object-empty) printf '{"error":{}}\\n'; exit 1 ;;
  audit:*) printf '{}\\n'; exit 1 ;;
esac
exit 1
` : `#!/usr/bin/env sh
case "$1" in
  outdated) printf '{}\\n'; exit 0 ;;
  audit) ${mode === "json" ? `printf '{"error":{"code":"EAI_AGAIN","summary":"registry unavailable"}}\\n'` : `printf 'non-JSON audit failure\\n' >&2`}; exit 1 ;;
esac
exit 1
`);
    chmodSync(join(bin, "npm"), 0o755);
    if (includeGh) {
      writeFileSync(join(bin, "gh"), mode === "success" ? `#!/usr/bin/env sh
case "$1:$PM_OPS_FAKE_SCENARIO" in
  repo:gh-fail) exit 1 ;;
  repo:gh-invalid) printf 'maybe\\n' ;;
  pr:gh-fail|issue:gh-fail) exit 1 ;;
  pr:gh-lists-invalid|issue:gh-lists-invalid) printf '{}\\n' ;;
  repo:private) printf 'true\\n' ;;
  repo:*) printf 'false\\n' ;;
  pr:*) printf '[{"number":1}]\\n' ;;
  issue:*) printf '[{"number":1},{"number":2}]\\n' ;;
esac
` : "#!/usr/bin/env sh\nprintf '[]\\n'\n");
      chmodSync(join(bin, "gh"), 0o755);
    }
  }
  return bin;
}

// Build a deterministic, self-contained pm repo fixture so the integration
// tests run anywhere (CI included) without depending on absolute host paths.
// The fixture's release:check is a trivial no-op so verify-release passes
// without installing toolchain dependencies.
function buildFixture(root: string): string {
  const repo = join(root, "pm-fixture");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-fixture",
    version: "2026.7.5",
    description: "fixture repo for pm-ops tests",
    type: "module",
    main: "dist/index.js",
    scripts: {
      typecheck: "node -e \"console.log('typecheck')\"",
      build: "node -e \"console.log('build')\"",
      test: "node -e \"console.log('test')\"",
      "release:check": "node -e \"console.log('release:check ok')\"",
      changelog: "node -e \"console.log('changelog')\"",
      "changelog:check": "node -e \"console.log('changelog:check')\"",
    },
    devDependencies: { "pm-changelog": "^2026.6.13" },
  }, null, 2) + "\n");
  writeFileSync(join(repo, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" } }, null, 2) + "\n");
  writeFileSync(join(repo, "tsconfig.json"), `{
  // JSONC is valid for tsconfig files and must not disable strict detection.
  /* Block comments and escaped string content must survive normalization. */
  "extends": ["./tsconfig.base.json"],
  "compilerOptions": {
  },
  "fixtureLabel": "quoted \\\"value\\\"",
}
`);
  writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## 2026.7.5\n\n- fixture\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Daily Release\non: [schedule]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
  const pmCmd = process.platform === "win32" ? "pm.cmd" : "pm";
  const pmInit = spawnSync(pmCmd, ["init", "fixture", "--pm-path", join(repo, ".agents", "pm")], { encoding: "utf-8", timeout: 30_000 });
  if (pmInit.status !== 0) {
    throw new Error(`pm init fixture failed: ${pmInit.stderr}`);
  }
  const pmCreate = spawnSync(pmCmd, ["create", "--title", "Fixture task", "--type", "Task", "--pm-path", join(repo, ".agents", "pm")], { encoding: "utf-8", timeout: 30_000 });
  if (pmCreate.status !== 0) {
    throw new Error(`pm create failed: ${pmCreate.stderr}`);
  }
  const importedItems = [
    { title: "Stale fixture task", type: "Task", status: "open", priority: 1, created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-02T00:00:00.000Z", tags: ["fixture", "stale"] },
    { title: "Recently closed fixture", type: "Task", status: "closed", priority: 2, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-08-03T00:00:00.000Z", closed_at: "2026-08-03T00:00:00.000Z", completed_at: "2026-08-03T00:00:00.000Z", close_reason: "Fixture completed" },
    { title: "Older closed fixture", type: "Issue", status: "closed", priority: 3, created_at: "2026-05-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z", closed_at: "2026-07-01T00:00:00.000Z", completed_at: "2026-07-01T00:00:00.000Z", close_reason: "Fixture resolved" },
  ];
  for (const item of importedItems) {
    const createArgs = ["create", "--stdin-json", "--status", item.status, "--json", "--pm-path", join(repo, ".agents", "pm")];
    if (item.status === "closed" || item.status === "canceled") {
      createArgs.push("--completed-at", item.completed_at!, "--close-reason", item.close_reason!);
    }
    const imported = spawnSync(pmCmd, createArgs, {
      encoding: "utf-8",
      input: JSON.stringify(item),
      timeout: 30_000,
    });
    if (imported.status !== 0) throw new Error(`pm fixture import failed: ${imported.stderr}`);
    const itemId = parseJson<{ id: string }>(imported.stdout).id;
    const itemPath = join(repo, ".agents", "pm", `${item.type.toLowerCase()}s`, `${itemId}.toon`);
    const stored = decode(readFileSync(itemPath, "utf8")) as Record<string, unknown>;
    stored.created_at = item.created_at;
    stored.updated_at = item.updated_at;
    if ("closed_at" in item) stored.closed_at = item.closed_at;
    writeFileSync(itemPath, `${encode(stored)}\n`);
  }
  return repo;
}

/** A built merge-receipt lab fixture: a real git repo with a pm tracker at
 *  `.agents/pm`, the field-aware merge driver installed in `.git/config`, the
 *  committed `.gitattributes` fence, and (when `withConflict`) a divergent
 *  two-branch merge that records one real pending decision receipt. */
interface MergeReceiptLab {
  path: string;
  itemId: string;
}

// Build a real, self-contained git repo with a pm tracker at `.agents/pm` and
// the field-aware merge driver + committed `.gitattributes` fence installed
// — the exact configuration `ops merge-receipts` audits. When `withConflict`
// is set, diverges the item `description` across two branches and performs a
// merge so the item merge-driver records a real clone-local pending receipt
// under `.git/pm-merge-receipts/`, exactly the shape the gate fails on. Unlike
// mocked receipts, this exercises the real driver, receipt writer, git-config
// audit, and committed-fence audit end-to-end.
function buildMergeReceiptLab(root: string, name: string, withConflict: boolean, trackerDir = ".agents/pm"): MergeReceiptLab {
  const repo = join(root, name);
  const pmRoot = join(repo, ...trackerDir.split("/"));
  // Use the LOCAL pm-cli (the devDependency the test process links against) for
  // every pm call, so the installed merge-driver command references the same
  // `dist/cli.js` the in-process `auditMergeDriverConfiguration` expects —
  // otherwise install (global pm) and audit (local pm) resolve different cli.js
  // paths and the driver audit spuriously reports `drift`. `--pm-path` is the
  // host-owned global that scopes every pm subcommand to the lab's tracker, so
  // the labs never depend on the ambient repo or env PM_PATH.
  // Resolved ABSOLUTELY from this test file: every pm call below runs with
  // `cwd` set to the temp lab repo, so a relative "./node_modules/.bin/pm"
  // would resolve inside the lab (which has no node_modules) and spawn would
  // fail with status null and undefined stdio.
  const pmCmd = fileURLToPath(
    new URL(process.platform === "win32" ? "../node_modules/.bin/pm.cmd" : "../node_modules/.bin/pm", import.meta.url),
  );
  const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf-8", timeout: 30_000 });
  const pm = (args: string[]) => spawnSync(pmCmd, [...args, "--pm-path", pmRoot], { cwd: repo, encoding: "utf-8", timeout: 30_000 });
  const assertOk = (r: { status: number | null; stdout: string; stderr: string }, op: string) => {
    if (r.status !== 0) throw new Error(`${op} failed (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
  };

  mkdirSync(repo, { recursive: true });
  assertOk(git(["init", "-q"]), "git init");
  assertOk(git(["config", "user.email", "test@pm-ops.local"]), "git config email");
  assertOk(git(["config", "user.name", "pm-ops tests"]), "git config name");
  assertOk(pm(["init", name]), "pm init");
  assertOk(pm(["merge", "install"]), "pm merge install");
  const createOut = pm(["create", "--title", "Shared item", "--type", "Task", "--json"]);
  assertOk(createOut, "pm create");
  const itemId = (JSON.parse(createOut.stdout) as { id: string }).id;

  assertOk(git(["add", "-A"]), "git add base");
  assertOk(git(["commit", "-qm", "base"]), "git commit base");
  const baseHead = git(["rev-parse", "HEAD"]);
  assertOk(baseHead, "git rev-parse HEAD");
  const baseSha = baseHead.stdout.trim();

  if (withConflict) {
    assertOk(git(["checkout", "-q", "-b", "agent-a"]), "git branch agent-a");
    assertOk(pm(["update", itemId, "--description", "Agent A description"]), "pm update agent-a");
    assertOk(git(["add", "-A"]), "git add agent-a");
    assertOk(git(["commit", "-qm", "a"]), "git commit agent-a");

    assertOk(git(["checkout", "-q", "-b", "agent-b", baseSha]), "git branch agent-b");
    assertOk(pm(["update", itemId, "--description", "Agent B description"]), "pm update agent-b");
    assertOk(git(["add", "-A"]), "git add agent-b");
    assertOk(git(["commit", "-qm", "b"]), "git commit agent-b");

    const merge = git(["merge", "agent-a", "-m", "merge"]);
    // The field-aware driver resolves the scalar conflict toward `preferred`
    // (ours), records a pending receipt, and reports `ok: false` — so git marks
    // the item path unmerged and exits 1. A different exit means the fixture no
    // longer reproduces the conflict the gate is built around.
    if (merge.status !== 1) {
      throw new Error(`conflicting merge expected exit 1 but got ${merge.status}: ${merge.stdout}\n${merge.stderr}`);
    }
    if (!existsSync(join(repo, ".git", "pm-merge-receipts"))) {
      throw new Error("conflicting merge did not write a receipt under .git/pm-merge-receipts/");
    }
  }

  return { path: repo, itemId };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/**
 * Activate pm-ops through pm's real host engine with the manifest's declared
 * capabilities.
 *
 * This replaces the hand-rolled `api` doubles these tests used to build. A
 * double accepts every registration unconditionally, so it cannot observe
 * host-side rejection — which is how `--json` flags that shadow a host-owned
 * global stayed green in CI while every ops command failed to register
 * against a real pm host. The harness runs the same validation the CLI runs,
 * so an invalid registration fails the suite here.
 */
async function harness(): Promise<ExtensionTestHarness> {
  const created = await createExtensionTestHarness(extension, {
    name: "pm-ops",
    capabilities: manifest.capabilities,
  });
  assert.deepEqual(created.activation.failed, [], "activation must not fail");
  return created;
}

/**
 * Run a command through the real dispatch engine. Defaults to no-JSON global
 * (matching the old hand-rolled helper which passed `global: {}`) so tests
 * that want structured (toon) output or --format markdown get the right
 * format. Pass `globalOverride: { json: true }` for JSON output.
 */
async function runCmd<T>(
  ext: ExtensionTestHarness,
  command: string,
  options: Record<string, unknown> = {},
  args: readonly string[] = [],
  globalOverride: Partial<GlobalOptions> = {},
): Promise<T> {
  const { result } = await ext.runCommand({
    command,
    options,
    args,
    global: { json: false, quiet: true, noPager: true, ...globalOverride },
  });
  return result as T;
}

/** Typed JSON parse for spawn-based tests. */
function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

let tmpRoot: string;
let fixtureRepo: string;
let cleanMergeLab: MergeReceiptLab;
let conflictingMergeLab: MergeReceiptLab;
let reconciledLab: MergeReceiptLab;
let driverMissingLab: MergeReceiptLab;
let fenceMissingLab: MergeReceiptLab;

before(() => {
  process.env.PM_OPS_OFFLINE = "1";
  tmpRoot = mkdtempSync(join(tmpdir(), "pm-ops-test-"));
  fixtureRepo = buildFixture(tmpRoot);
  // Real git + real driver merges are heavier than the package-less scan
  // fixture, so build them once and share across the merge-receipts tests.
  cleanMergeLab = buildMergeReceiptLab(tmpRoot, "pm-merge-clean", false);
  conflictingMergeLab = buildMergeReceiptLab(tmpRoot, "pm-merge-conflict", true);
  reconciledLab = buildMergeReceiptLab(tmpRoot, "pm-merge-reconcile", true);
  driverMissingLab = buildMergeReceiptLab(tmpRoot, "pm-merge-no-driver", false);
  fenceMissingLab = buildMergeReceiptLab(tmpRoot, "pm-merge-no-fence", false);
  rmSync(join(fenceMissingLab.path, ".gitattributes"));
});

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Shape and registration tests
// ---------------------------------------------------------------------------

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object");
  assert.ok("name" in extension);
  assert.ok("activate" in extension);
  assert.strictEqual(typeof extension.activate, "function");
  assert.strictEqual(extension.name, "pm-ops");
  assert.match(extension.version, /^2026\./, "extension version should be a calendar version");
});

test("manifest declares capabilities required by registered command metadata", () => {
  assert.ok(manifest.capabilities.includes("commands"), "commands capability is required");
  assert.ok(manifest.capabilities.includes("renderers"), "renderers capability is required");
  assert.ok(manifest.capabilities.includes("schema"), "schema capability is required for command flags metadata");
});

test("registers the ops commands and renderers", async () => {
  const ext = await harness();

  for (const name of OPS_COMMANDS) {
    ext.assertCommandContract({ command: name });
  }
  ext.assertRendererOverride({ format: "toon" });
  ext.assertRendererOverride({ format: "json" });

  await ext.deactivate();
});

test("pm SDK preserves the typed repeatable --repos contract on every command", async () => {
  const ext = await harness();

  assert.deepStrictEqual(
    ext.assertCapabilityUsage({ declared: manifest.capabilities, extensionName: "pm-ops" }).unused,
    [],
    "manifest capabilities should match the SDK surfaces pm-ops actually uses",
  );

  for (const command of OPS_COMMANDS) {
    const contract = ext.assertCommandContract({ command, flags: ["--repos"], arguments: ["additional-repos"] });
    const reposFlag = contract.flags.find((flag) => flag.long === "--repos");
    assert.ok(reposFlag, `${command} should expose --repos through the real SDK registry`);
    assert.strictEqual(reposFlag.value_type, "string", `${command} --repos should consume string values`);
    assert.strictEqual(reposFlag.list, true, `${command} --repos should accumulate repeated and comma-list values`);
    ext.assertParserOverride({ command, extensionName: "pm-ops" });
  }

  const structured = await ext.runParserOverride({
    command: "ops status",
    args: [],
    options: { repos: ["sdk-one", "sdk-two"] },
    global: { json: true, quiet: true, noPager: true },
    pm_root: "",
  });
  assert.deepStrictEqual(
    structured.context.options.repos,
    ["sdk-one", "sdk-two"],
    "the CLI compatibility parser must leave structured SDK and MCP inputs unchanged",
  );

  const originalArgv = process.argv;
  try {
    process.argv = ["node", "pm", "ops", "status", "--repos", "first", "--repos=second", "--repos=", "--", "--repos", "ignored"];
    const restored = await ext.runParserOverride({
      command: "ops status",
      args: [],
      options: { repos: ["second"] },
      global: { json: true, quiet: true, noPager: true },
      pm_root: "",
    });
    assert.deepStrictEqual(restored.context.options.repos, ["first", "second"]);

    process.argv = ["node", "pm", "ops", "status", "--repos", "first", "--repos", "--json"];
    const missingValue = await ext.runParserOverride({
      command: "ops status",
      args: [],
      options: {},
      global: { json: true, quiet: true, noPager: true },
      pm_root: "",
    });
    assert.deepStrictEqual(missingValue.context.options.repos, ["first"]);

    process.argv = ["node", "pm", "ops", "status", "--repos", "first"];
    const alreadyComplete = await ext.runParserOverride({
      command: "ops status",
      args: [],
      options: { repos: ["first"] },
      global: { json: true, quiet: true, noPager: true },
      pm_root: "",
    });
    assert.deepStrictEqual(alreadyComplete.context.options.repos, ["first"]);

    process.argv = ["node", "pm", "ops", "scan", "--repos", "other"];
    const differentCommand = await ext.runParserOverride({
      command: "ops status",
      args: [],
      options: { repos: ["sdk-only"] },
      global: { json: true, quiet: true, noPager: true },
      pm_root: "",
    });
    assert.deepStrictEqual(differentCommand.context.options.repos, ["sdk-only"]);
  } finally {
    process.argv = originalArgv;
  }

  await ext.deactivate();
});

test("installed pm CLI routes --repos values to every fleet command", { timeout: 120_000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "pm-ops-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const project = join(root, "project");
  const home = join(root, "home");
  const appData = join(root, "app-data");
  const localAppData = join(root, "local-app-data");
  const xdgConfigHome = join(root, "xdg-config");
  const xdgDataHome = join(root, "xdg-data");
  for (const directory of [project, home, appData, localAppData, xdgConfigHome, xdgDataHome]) {
    mkdirSync(directory, { recursive: true });
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "ComSpec", "WINDIR", "LANG", "LC_ALL", "LC_CTYPE"] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    APPDATA: appData,
    HOME: home,
    LOCALAPPDATA: localAppData,
    NPM_CONFIG_USERCONFIG: devNull,
    PM_GLOBAL_PATH: join(root, "global-pm"),
    PM_OPS_OFFLINE: "1",
    PM_PATH: join(project, ".agents", "pm"),
    PM_TELEMETRY_DISABLED: "1",
    TEMP: root,
    TMP: root,
    TMPDIR: root,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
  });

  const pmBin = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "pm.cmd" : "pm");
  const runPm = (args: string[]) => spawnSync(pmBin, args, {
    cwd: project,
    encoding: "utf-8",
    env,
    timeout: 30_000,
  });
  const assertClean = (result: ReturnType<typeof runPm>, operation: string) => {
    assert.strictEqual(result.error, undefined, `${operation} should launch: ${result.error?.message ?? ""}`);
    assert.strictEqual(result.status, 0, `${operation} should pass: ${result.stderr}`);
  };

  assertClean(runPm(["init", "--json"]), "pm init");
  assertClean(runPm(["install", process.cwd(), "--project", "--json"]), "pm install pm-ops");
  const doctor = runPm(["package", "doctor", "--project", "--json", "--detail", "deep"]);
  assertClean(doctor, "pm package doctor");
  interface DoctorPayload {
    details?: { deep?: { installed_extensions?: { name?: string; activation_status?: string; runtime_active?: boolean }[] } };
  }
  const doctorPayload = parseJson<DoctorPayload>(doctor.stdout);
  const installed = doctorPayload.details?.deep?.installed_extensions?.find((entry) => entry.name === "pm-ops");
  assert.ok(installed, "pm-ops should appear in deep package diagnostics");
  assert.strictEqual(installed.activation_status, "ok");
  assert.strictEqual(installed.runtime_active, true);

  writeFileSync(join(project, "undocumented.ts"), "export function undocumented() {}\n");
  const toonFailure = runPm(["ops", "docstrings", "--repos", project]);
  assert.strictEqual(toonFailure.error, undefined, "pm ops docstrings should launch");
  assert.strictEqual(toonFailure.status, 1, `pm ops docstrings should fail the dirty project: ${toonFailure.stderr}`);
  interface DocstringFailurePayload {
    repos?: Array<{ violations?: Array<{ file?: string }> }>;
    summary?: { total_violations?: number };
  }
  const toonPayload = decode(toonFailure.stdout) as DocstringFailurePayload;
  assert.ok((toonPayload.summary?.total_violations ?? 0) >= 1, "default failure output must remain valid TOON");
  assert.ok(toonPayload.repos?.[0]?.violations?.some(({ file }) => file === "undocumented.ts"), "the routed repo must report its undocumented source");

  const jsonFailure = runPm(["ops", "docstrings", "--repos", project, "--json"]);
  assert.strictEqual(jsonFailure.status, 1, `pm ops docstrings --json should fail the dirty project: ${jsonFailure.stderr}`);
  const jsonPayload = parseJson<DocstringFailurePayload>(jsonFailure.stdout);
  assert.ok((jsonPayload.summary?.total_violations ?? 0) >= 1);
  assert.ok(jsonPayload.repos?.[0]?.violations?.some(({ file }) => file === "undocumented.ts"));

  interface RepoEntry { path?: string; repo?: string }
  interface CmdPayload { repos?: RepoEntry[]; scan?: { repos?: RepoEntry[] } }
  const missing = join(root, "definitely-missing");
  for (const command of OPS_COMMANDS) {
    const result = runPm([...command.split(" "), "--repos", missing, "--json"]);
    const expectsFailure = command === "ops verify-release" || command === "ops docstrings";
    assert.strictEqual(result.error, undefined, `${command} should launch`);
    assert.strictEqual(result.status, expectsFailure ? 1 : 0, `${command} exit status: ${result.stderr}`);
    const payload = parseJson<CmdPayload>(result.stdout);
    const repos = command === "ops report" ? payload.scan?.repos : payload.repos;
    assert.deepStrictEqual(
      repos?.map((entry) => entry.path ?? entry.repo),
      [resolve(missing)],
      `${command} must use --repos instead of silently scanning cwd`,
    );
  }

  const first = join(root, "missing-one");
  const second = join(root, "missing-two");
  for (const reposArgs of [
    ["--repos", first, "--repos", second],
    [`--repos=${first}`, `--repos=${second}`],
    ["--repos", `${first},${second}`],
    ["--repos", first, second],
  ]) {
    const result = runPm(["ops", "status", ...reposArgs, "--json"]);
    assertClean(result, `pm ops status ${reposArgs.join(" ")}`);
    const payload = parseJson<CmdPayload>(result.stdout);
    assert.deepStrictEqual(payload.repos?.map((entry) => entry.path), [resolve(first), resolve(second)]);
  }

  const dashPrefixed = "-missing-repo";
  const dashResult = runPm(["ops", "status", "--repos", dashPrefixed, "--json"]);
  assertClean(dashResult, `pm ops status --repos ${dashPrefixed}`);
  const dashPayload = parseJson<CmdPayload>(dashResult.stdout);
  assert.deepStrictEqual(dashPayload.repos?.map((entry) => entry.path), [resolve(project, dashPrefixed)]);

  const doubleDashPrefixed = "--missing-repo";
  const doubleDashResult = runPm(["ops", "status", `--repos=${doubleDashPrefixed}`, "--json"]);
  assertClean(doubleDashResult, `pm ops status --repos=${doubleDashPrefixed}`);
  const doubleDashPayload = parseJson<CmdPayload>(doubleDashResult.stdout);
  assert.deepStrictEqual(doubleDashPayload.repos?.map((entry) => entry.path), [resolve(project, doubleDashPrefixed)]);

  const missingValueResult = runPm(["ops", "status", "--repos", "--json"]);
  assert.strictEqual(missingValueResult.error, undefined, "pm ops status with a missing --repos value should launch");
  assert.notStrictEqual(missingValueResult.status, 0, "pm ops status with a missing --repos value should fail");
  assert.match(missingValueResult.stderr, /option ['"]--repos <paths>['"] argument missing/);
  assert.doesNotMatch(missingValueResult.stderr, new RegExp(`${resolve(project, "--json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

// ---------------------------------------------------------------------------
// ops scan
// ---------------------------------------------------------------------------

test("ops scan produces a structured readiness snapshot for the fixture", async () => {
  const ext = await harness();
  const result = await runCmd<ScanResult>(ext, "ops scan", { repos: [fixtureRepo] });
  assert.ok(result, "scan should return a result");
  assert.ok(Array.isArray(result.repos), "result.repos should be an array");
  assert.strictEqual(result.repos.length, 1);
  assert.strictEqual(result.summary.total, 1);
  assert.strictEqual(result.summary.ready + result.summary.not_ready, 1);
  const repo = result.repos[0];
  assert.strictEqual(repo.name, "pm-fixture");
  assert.strictEqual(repo.strict_ts, true, "fixture should have strict TS");
  assert.strictEqual(repo.has_changelog, true);
  assert.strictEqual(repo.has_release_workflow, true);
  assert.strictEqual(repo.has_ci, true);
  assert.strictEqual(repo.has_pm_changelog, true);
  assert.strictEqual(repo.pm_workspace, true);
  assert.strictEqual(repo.ready, true, "fixture should be ready");
  await ext.deactivate();
});

test("ops scan honors the host-owned global JSON format", async () => {
  const ext = await harness();
  const rendered = await runCmd<RenderedResult>(ext, "ops scan", { repos: [fixtureRepo] }, [], { json: true });
  const result = parseJson<ScanResult>(rendered.output);
  assert.strictEqual(result.repos[0].path, fixtureRepo);
  await ext.deactivate();
});

test("ops scan --format markdown emits a well-formed table", async () => {
  const ext = await harness();
  const result = await runCmd<RenderedResult>(ext, "ops scan", { repos: [fixtureRepo], format: "markdown" });
  assert.ok(result?.pmOpsRendered === true, "markdown result should be a rendered marker");
  for (const line of result.output.split("\n")) {
    if (line.startsWith("|") && line.includes("---")) continue;
    if (line.startsWith("| repo |")) continue;
    if (line.startsWith("| pm-fixture |")) {
      assert.ok(line.endsWith("|"), "data row should be wrapped in pipes");
    }
  }
  assert.match(result.output, /\| pm-fixture \|/);
  await ext.deactivate();
});

test("ops scan reports a clear error for missing repo paths", async () => {
  const ext = await harness();
  const missingRepo = join(tmpRoot, "pm-missing");
  const result = await runCmd<ScanResult>(ext, "ops scan", { repos: [missingRepo] });
  assert.strictEqual(result.repos.length, 1);
  assert.strictEqual(result.repos[0].ready, false);
  assert.deepStrictEqual(result.repos[0].errors, ["repository directory does not exist"]);
  await ext.deactivate();
});

test("ops scan does not report ready when an online security audit is unavailable", async () => {
  const ext = await harness();
  const bin = createAuditFailureBin("bin-audit-unavailable", true);
  const stderrBin = createAuditFailureBin("bin-audit-unavailable-stderr", true, "stderr");

  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  try {
    const result = await runCmd<ScanResult>(ext, "ops scan", { repos: [fixtureRepo] });
    assert.strictEqual(result.repos[0].ready, false);
    assert.match(result.repos[0].errors.join("\n"), /audit unavailable:.*registry unavailable/);
    const markdown = await runCmd<RenderedResult>(ext, "ops scan", { repos: [fixtureRepo], format: "markdown" });
    assert.match(markdown.output, /audit unavailable:.*registry unavailable/);
    process.env.PM_OPS_OFFLINE = "1";
    const offline = await runCmd<ScanResult>(ext, "ops scan", { repos: [fixtureRepo] });
    assert.strictEqual(offline.repos[0].ready, true);
    assert.strictEqual(offline.repos[0].errors.length, 0);
    delete process.env.PM_OPS_OFFLINE;
    process.env.PATH = `${stderrBin}${delimiter}${previousPath ?? ""}`;
    const stderrOnly = await runCmd<ScanResult>(ext, "ops scan", { repos: [fixtureRepo] });
    assert.strictEqual(stderrOnly.repos[0].ready, false);
    assert.match(stderrOnly.repos[0].errors.join("\n"), /audit unavailable:.*non-JSON audit failure/i);
  } finally {
    process.env.PM_OPS_OFFLINE = previousOffline;
    process.env.PATH = previousPath;
  }
  await ext.deactivate();
});

test("ops scan respects later tsconfig array extends overrides", async () => {
  const ext = await harness();
  const repo = join(tmpRoot, "pm-tsconfig-override");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-tsconfig-override",
    version: "2026.7.6",
    scripts: {
      typecheck: "true",
      test: "true",
      build: "true",
      "release:check": "true",
      changelog: "true",
      "changelog:check": "true",
    },
    devDependencies: { "pm-changelog": "^2026.7.6" },
  }) + "\n");
  writeFileSync(join(repo, "tsconfig.strict.json"), JSON.stringify({ compilerOptions: { strict: true } }) + "\n");
  writeFileSync(join(repo, "tsconfig.loose.json"), JSON.stringify({ compilerOptions: { strict: false } }) + "\n");
  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ extends: ["./tsconfig.strict.json", "./tsconfig.loose.json"] }) + "\n");
  writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: CI\n");
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Release\n");

  const result = await runCmd<ScanResult>(ext, "ops scan", { repos: [repo] });
  assert.strictEqual(result.repos[0].strict_ts, false);
  assert.strictEqual(result.repos[0].ready, false);
  await ext.deactivate();
});

test("ops scan fails closed across malformed, cyclic, and package-style tsconfig inheritance", async () => {
  const ext = await harness();
  const repo = join(tmpRoot, "pm-tsconfig-errors");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "pm-tsconfig-errors" }) + "\n");

  writeFileSync(join(repo, "tsconfig.json"), "{ invalid jsonc\n");
  assert.strictEqual((await runCmd<ScanResult>(ext, "ops scan", { repos: [repo] })).repos[0].strict_ts, false);

  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ extends: "./tsconfig" }) + "\n");
  assert.strictEqual((await runCmd<ScanResult>(ext, "ops scan", { repos: [repo] })).repos[0].strict_ts, false);

  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ extends: "missing-package-config" }) + "\n");
  assert.strictEqual((await runCmd<ScanResult>(ext, "ops scan", { repos: [repo] })).repos[0].strict_ts, false);

  writeFileSync(join(repo, "tsconfig.json"), "{}\n");
  assert.strictEqual((await runCmd<ScanResult>(ext, "ops scan", { repos: [repo] })).repos[0].strict_ts, false);

  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ extends: ["missing-package-config", 42] }) + "\n");
  assert.strictEqual((await runCmd<ScanResult>(ext, "ops scan", { repos: [repo] })).repos[0].strict_ts, false);

  writeFileSync(join(repo, "strict.json"), JSON.stringify({ compilerOptions: { strict: true } }) + "\n");
  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ extends: ["./strict", "missing-package-config", 42] }) + "\n");
  assert.strictEqual((await runCmd<ScanResult>(ext, "ops scan", { repos: [repo] })).repos[0].strict_ts, true);
  await ext.deactivate();
});

test("ops scan expands simple repo globs", async () => {
  const ext = await harness();
  const result = await runCmd<ScanResult>(ext, "ops scan", { repos: [join(tmpRoot, "pm-*")] });
  assert.ok(result.repos.some((repo) => repo.name === "pm-fixture"));
  await ext.deactivate();
});

test("ops scan expands bracket character-class globs", async () => {
  const ext = await harness();
  const repoA = join(tmpRoot, "pm-a");
  const repoB = join(tmpRoot, "pm-b");
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  writeFileSync(join(repoA, "package.json"), JSON.stringify({ name: "pm-a", version: "2026.7.6" }) + "\n");
  writeFileSync(join(repoB, "package.json"), JSON.stringify({ name: "pm-b", version: "2026.7.6" }) + "\n");
  const result = await runCmd<ScanResult>(ext, "ops scan", { repos: [join(tmpRoot, "pm-[ab]")] });
  assert.deepStrictEqual(result.repos.map((repo) => repo.name).sort(), ["pm-a", "pm-b"]);
  await ext.deactivate();
});

test("ops scan expands wildcard, home, default, and platform-absolute paths deterministically", async () => {
  const ext = await harness();
  const single = join(tmpRoot, "pm-c");
  const punctuation = join(tmpRoot, "pm-(x)");
  mkdirSync(single, { recursive: true });
  mkdirSync(punctuation, { recursive: true });
  writeFileSync(join(single, "package.json"), JSON.stringify({ name: "pm-c" }) + "\n");
  writeFileSync(join(punctuation, "package.json"), JSON.stringify({ name: "pm-(x)" }) + "\n");

  const question = await runCmd<ScanResult>(ext, "ops scan", { repos: [join(tmpRoot, "pm-?")] });
  assert.ok(question.repos.some((repo) => repo.name === "pm-c"));
  const escaped = await runCmd<ScanResult>(ext, "ops scan", { repos: [join(tmpRoot, "pm-(?)")] });
  assert.deepStrictEqual(escaped.repos.map(({ name }) => name), ["pm-(x)"]);

  const homePaths = await runCmd<ScanResult>(ext, "ops scan", { repos: ["~", "~\\definitely-missing"] });
  assert.deepStrictEqual(homePaths.repos.map(({ path }) => path), [homedir(), join(homedir(), "definitely-missing")]);
  const current = await runCmd<ScanResult>(ext, "ops scan");
  assert.deepStrictEqual(current.repos.map(({ path }) => path), [process.cwd()]);
  const windowsAbsolute = await runCmd<ScanResult>(ext, "ops scan", { repos: ["C:\\definitely-missing"] });
  assert.deepStrictEqual(windowsAbsolute.repos.map(({ path }) => path), ["C:\\definitely-missing"]);
  const windowsGlob = await runCmd<ScanResult>(ext, "ops scan", { repos: ["C:\\definitely-missing\\*"] });
  assert.deepStrictEqual(windowsGlob.repos.map(({ path }) => path), ["C:\\definitely-missing\\*"]);
  const relativeMissing = await runCmd<ScanResult>(ext, "ops scan", { repos: ["definitely-missing-relative"] });
  assert.deepStrictEqual(relativeMissing.repos.map(({ path }) => path), [resolve("definitely-missing-relative")]);
  await ext.deactivate();
});

test("ops scan handles malformed bracket globs without crashing", async () => {
  const ext = await harness();
  const result = await runCmd<ScanResult>(ext, "ops scan", { repos: [join(tmpRoot, "pm-[")] });
  assert.strictEqual(result.repos.length, 1);
  assert.strictEqual(result.repos[0].ready, false);
  assert.deepStrictEqual(result.repos[0].errors, ["repository directory does not exist"]);
  await ext.deactivate();
});

test("ops scan selects Windows command shims when the host platform is win32", async () => {
  const ext = await harness();
  const bin = join(tmpRoot, "bin-win32-command-selection");
  const pmMarker = join(tmpRoot, "win32-pm-invoked");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "pm.cmd"), `#!/usr/bin/env sh
: > '${pmMarker}'
printf '{"items":[]}\\n'
`);
  writeFileSync(join(bin, "npm.cmd"), `#!/usr/bin/env sh
if [ "$1" = audit ]; then
  printf '{"metadata":{"vulnerabilities":{}}}\\n'
else
  printf '{}\\n'
fi
`);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env sh
case "$1" in
  repo) printf 'false\\n' ;;
  *) printf '[]\\n' ;;
esac
`);
  for (const command of ["pm.cmd", "npm.cmd", "gh"]) chmodSync(join(bin, command), 0o755);
  const repo = join(tmpRoot, "pm-win32-command-selection");
  mkdirSync(join(repo, ".agents", "pm"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "pm-win32-command-selection" }) + "\n");

  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  try {
    const result = await runCmd<ScanResult>(ext, "ops scan", { repos: [repo] });
    assert.strictEqual(existsSync(pmMarker), true);
    assert.strictEqual(result.repos[0].audit_critical, 0);
    assert.strictEqual(result.repos[0].outdated_count, 0);
  } finally {
    Object.defineProperty(process, "platform", platform!);
    if (previousOffline === undefined) delete process.env.PM_OPS_OFFLINE;
    else process.env.PM_OPS_OFFLINE = previousOffline;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await ext.deactivate();
  }
});

// ---------------------------------------------------------------------------
// ops policy
// ---------------------------------------------------------------------------

test("ops policy: naming passes for a valid pm-* repo and fails for pm-ext-foo", async () => {
  const ext = await harness();
  const fakeDir = join(tmpRoot, "pm-ext-foo");
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(join(fakeDir, "package.json"), JSON.stringify({
    name: "pm-ext-foo", version: "0.0.1",
    scripts: { typecheck: "true", test: "true", build: "true", "release:check": "true", changelog: "true", "changelog:check": "true" },
    devDependencies: { "pm-changelog": "1.0.0" },
  }) + "\n");
  const result = await runCmd<PolicyResult>(ext, "ops policy", { repos: [fixtureRepo, fakeDir] });
  assert.ok(Array.isArray(result.repos));
  const fixturePolicy = result.repos.find((r) => r.name === "pm-fixture");
  assert.ok(fixturePolicy, "fixture policy result should exist");
  const naming = fixturePolicy.checks.find((c) => c.id === "naming");
  assert.ok(naming, "naming check should exist");
  assert.strictEqual(naming.pass, true, "pm-fixture naming should pass");

  const fakePolicy = result.repos.find((r) => r.path === fakeDir);
  assert.ok(fakePolicy, "fake dir policy result should exist");
  const fakeNaming = fakePolicy.checks.find((c) => c.id === "naming");
  assert.ok(fakeNaming, "fake naming check should exist");
  assert.strictEqual(fakeNaming.pass, false, "pm-ext-foo naming should fail");
  assert.match(fakeNaming.message, /pm-ext-/);

  const invalidNameDir = join(tmpRoot, "invalid-package-name");
  mkdirSync(invalidNameDir, { recursive: true });
  writeFileSync(join(invalidNameDir, "package.json"), JSON.stringify({ name: "not-a-pm-package" }) + "\n");
  const invalidName = await runCmd<PolicyResult>(ext, "ops policy", { repos: [invalidNameDir] });
  const invalidNaming = invalidName.repos[0].checks.find((check) => check.id === "naming");
  assert.strictEqual(invalidNaming?.pass, false);
  assert.match(invalidNaming?.message ?? "", /does not match/);
  assert.ok(result.summary.by_severity.error >= 1, "should record at least one error-severity failure");
  await ext.deactivate();
});

test("ops policy accepts pm-changelog in dependencies", async () => {
  const ext = await harness();
  const repo = join(tmpRoot, "pm-changelog-runtime");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-changelog-runtime",
    version: "2026.7.6",
    scripts: {
      typecheck: "true",
      test: "true",
      build: "true",
      "release:check": "true",
      changelog: "true",
      "changelog:check": "true",
    },
    dependencies: { "pm-changelog": "^2026.7.6" },
  }) + "\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: CI\n");
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Release\n");
  const result = await runCmd<PolicyResult>(ext, "ops policy", { repos: [repo] });
  const wired = result.repos[0].checks.find((check) => check.id === "pm-changelog-wired");
  assert.ok(wired, "pm-changelog-wired check should exist");
  assert.strictEqual(wired.pass, true);

  const scan = await runCmd<ScanResult>(ext, "ops scan", { repos: [repo] });
  assert.strictEqual(scan.repos[0].has_pm_changelog, true);
  await ext.deactivate();
});

test("ops policy private runner check only scans the runs-on value block", async () => {
  const ext = await harness();
  const repo = join(tmpRoot, "pm-private-self-hosted");
  const bin = join(tmpRoot, "bin");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-private-self-hosted",
    version: "2026.7.6",
    scripts: {
      typecheck: "true",
      test: "true",
      build: "true",
      "release:check": "true",
      changelog: "true",
      "changelog:check": "true",
    },
    devDependencies: { "pm-changelog": "^2026.7.6" },
  }) + "\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), `name: CI
on: [push]
jobs:
  test:
    runs-on:
      group: ubuntu-self-hosted
      labels:
        - self-hosted
        - ubuntu-latest
    strategy:
      matrix:
        os: [ubuntu-latest]
    steps:
      - run: echo hi
`);
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Release\n");
  writeFileSync(join(bin, "gh"), "#!/usr/bin/env sh\nprintf 'true\\n'\n");
  chmodSync(join(bin, "gh"), 0o755);

  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const result = await runCmd<PolicyResult>(ext, "ops policy", { repos: [repo] });
    const check = result.repos[0].checks.find((entry) => entry.id === "private-no-runners");
    assert.ok(check, "private-no-runners check should exist");
    assert.strictEqual(check.pass, true);
  } finally {
    process.env.PM_OPS_OFFLINE = previousOffline;
    process.env.PATH = previousPath;
  }
  await ext.deactivate();
});

test("ops policy private runner check flags direct GitHub-hosted runners", async () => {
  const ext = await harness();
  const repo = join(tmpRoot, "pm-private-github-hosted");
  const bin = join(tmpRoot, "bin-gh-hosted");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-private-github-hosted",
    version: "2026.7.6",
    scripts: {
      typecheck: "true",
      test: "true",
      build: "true",
      "release:check": "true",
      changelog: "true",
      "changelog:check": "true",
    },
    devDependencies: { "pm-changelog": "^2026.7.6" },
  }) + "\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), `name: CI
on: [push]
jobs:
  test:
    runs-on:
      - ubuntu-latest
    steps:
      - run: echo hi
`);
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Release\n");
  writeFileSync(join(bin, "gh"), "#!/usr/bin/env sh\nprintf 'true\\n'\n");
  chmodSync(join(bin, "gh"), 0o755);

  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const result = await runCmd<PolicyResult>(ext, "ops policy", { repos: [repo] });
    const check = result.repos[0].checks.find((entry) => entry.id === "private-no-runners");
    assert.ok(check, "private-no-runners check should exist");
    assert.strictEqual(check.pass, false);
    assert.match(check.message, /GitHub-hosted/);
  } finally {
    process.env.PM_OPS_OFFLINE = previousOffline;
    process.env.PATH = previousPath;
  }
  await ext.deactivate();
});

test("ops policy private runner check flags object labels using GitHub-hosted runners", async () => {
  const ext = await harness();
  const repo = join(tmpRoot, "pm-private-github-hosted-labels");
  const bin = join(tmpRoot, "bin-gh-hosted-labels");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-private-github-hosted-labels",
    version: "2026.7.6",
    scripts: {
      typecheck: "true",
      test: "true",
      build: "true",
      "release:check": "true",
      changelog: "true",
      "changelog:check": "true",
    },
    devDependencies: { "pm-changelog": "^2026.7.6" },
  }) + "\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), `name: CI
on: [push]
jobs:
  test:
    runs-on: { labels: [ubuntu-latest] }
    steps:
      - run: echo hi
  grouped:
    runs-on: { group: private-runners }
    steps:
      - run: echo grouped
  scalar-label:
    runs-on:

      labels: ubuntu-latest
    steps:
      - run: echo scalar
`);
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Release\n");
  writeFileSync(join(repo, ".github", "workflows", "README.txt"), "not a workflow\n");
  writeFileSync(join(bin, "gh"), "#!/usr/bin/env sh\nprintf 'true\\n'\n");
  chmodSync(join(bin, "gh"), 0o755);

  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const result = await runCmd<PolicyResult>(ext, "ops policy", { repos: [repo] });
    const check = result.repos[0].checks.find((entry) => entry.id === "private-no-runners");
    assert.ok(check, "private-no-runners check should exist");
    assert.strictEqual(check.pass, false);
    assert.match(check.message, /GitHub-hosted/);
  } finally {
    process.env.PM_OPS_OFFLINE = previousOffline;
    process.env.PATH = previousPath;
  }
  await ext.deactivate();
});

test("ops policy private runner check accepts flow labels with self-hosted", async () => {
  const ext = await harness();
  const repo = join(tmpRoot, "pm-private-flow-self-hosted");
  const bin = join(tmpRoot, "bin-flow-self-hosted");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-private-flow-self-hosted",
    version: "2026.7.6",
    scripts: {
      typecheck: "true",
      test: "true",
      build: "true",
      "release:check": "true",
      changelog: "true",
      "changelog:check": "true",
    },
    devDependencies: { "pm-changelog": "^2026.7.6" },
  }) + "\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), `name: CI
on: [push]
jobs:
  test:
    runs-on: { labels: [self-hosted, ubuntu-latest] }
    steps:
      - run: echo hi
`);
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Release\n");
  writeFileSync(join(bin, "gh"), "#!/usr/bin/env sh\nprintf 'true\\n'\n");
  chmodSync(join(bin, "gh"), 0o755);

  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const result = await runCmd<PolicyResult>(ext, "ops policy", { repos: [repo] });
    const check = result.repos[0].checks.find((entry) => entry.id === "private-no-runners");
    assert.ok(check, "private-no-runners check should exist");
    assert.strictEqual(check.pass, true);
  } finally {
    process.env.PM_OPS_OFFLINE = previousOffline;
    process.env.PATH = previousPath;
  }
  await ext.deactivate();
});

test("ops policy reports unreadable private workflow entries", async () => {
  const ext = await harness();
  const repo = join(tmpRoot, "pm-private-broken-workflow");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "pm-private-broken-workflow" }) + "\n");
  symlinkSync(join(repo, "missing-workflow-target"), join(repo, ".github", "workflows", "broken.yml"));
  const bin = createAuditFailureBin("bin-private-broken-workflow", true, "success");
  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  const previousScenario = process.env.PM_OPS_FAKE_SCENARIO;
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  process.env.PM_OPS_FAKE_SCENARIO = "private";
  try {
    const result = await runCmd<PolicyResult>(ext, "ops policy", { repos: [repo] });
    const runner = result.repos[0].checks.find(({ id }) => id === "private-no-runners");
    assert.strictEqual(runner?.pass, false);
    assert.match(runner?.message ?? "", /private repo uses GitHub-hosted runners/);
    assert.match(runner?.details?.join("\n") ?? "", /broken\.yml: unable to read workflow/);
  } finally {
    if (previousOffline === undefined) delete process.env.PM_OPS_OFFLINE;
    else process.env.PM_OPS_OFFLINE = previousOffline;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousScenario === undefined) delete process.env.PM_OPS_FAKE_SCENARIO;
    else process.env.PM_OPS_FAKE_SCENARIO = previousScenario;
    await ext.deactivate();
  }
});

test("ops policy accepts additional repo paths after --repos", async () => {
  const ext = await harness();
  const otherRepo = join(tmpRoot, "pm-other");
  mkdirSync(join(otherRepo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(otherRepo, "package.json"), JSON.stringify({
    name: "pm-other",
    version: "2026.7.6",
    type: "module",
    scripts: {
      typecheck: "true",
      test: "true",
      build: "true",
      "release:check": "true",
      changelog: "true",
      "changelog:check": "true",
    },
    devDependencies: { "pm-changelog": "^2026.7.6" },
  }) + "\n");
  const result = await runCmd<PolicyResult>(ext, "ops policy", { repos: [fixtureRepo] }, [otherRepo]);
  assert.strictEqual(result.summary.total, 2);
  assert.deepStrictEqual(result.repos.map((r) => r.name), ["pm-fixture", "pm-other"]);
  await ext.deactivate();
});

test("ops policy --strict exits non-zero on failures", async () => {
  const ext = await harness();
  const badDir = join(tmpRoot, "pm-bad");
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, "package.json"), JSON.stringify({ name: "pm-bad", version: "0.0.1" }) + "\n");
  await assert.rejects(
    runCmd(ext, "ops policy", { repos: [badDir], strict: true }),
    /strict mode|check\(s\) failed/,
    "strict mode should throw on failures",
  );
  await ext.deactivate();
});

test("ops policy validates custom bundles, filters, and strict output routes", async () => {
  const ext = await harness();
  const policyFile = join(tmpRoot, "custom-policy.json");
  writeFileSync(policyFile, JSON.stringify({ checks: [
    { id: "naming", severity: "error", repo_filter: "*" },
    { id: "naming", severity: "warning", repo_filter: "pm-fixture" },
    { id: "required-scripts", severity: "error", params: { scripts: ["release:check"] } },
    { id: "required-workflows", severity: "error", params: { workflows: ["ci.yml"] } },
    { id: "required-scripts", severity: "error" },
    { id: "required-workflows", severity: "error" },
    { id: "future-check", severity: "info", repo_filter: basename(fixtureRepo) },
    { id: "naming", severity: "error", repo_filter: "different-repo" },
  ] }) + "\n");
  const result = await runCmd<PolicyResult>(ext, "ops policy", { repos: [fixtureRepo], policy: policyFile });
  assert.strictEqual(result.repos[0].checks.length, 7);
  assert.strictEqual(result.summary.failed, 1);
  assert.strictEqual(result.summary.by_severity.info, 1);

  const invalid = join(tmpRoot, "invalid-policy.json");
  writeFileSync(invalid, "{not json}\n");
  await assert.rejects(runCmd(ext, "ops policy", { repos: [fixtureRepo], policy: invalid }), /not a valid policy bundle/);

  const outFile = join(tmpRoot, "strict-policy.md");
  await assert.rejects(
    runCmd(ext, "ops policy", { repos: [fixtureRepo], policy: policyFile, strict: true, format: "markdown", output: outFile }),
    /strict mode/,
  );
  assert.match(readFileSync(outFile, "utf8"), /future-check/);
  await assert.rejects(
    runCmd(ext, "ops policy", { repos: [fixtureRepo], policy: policyFile, strict: true, format: "markdown" }),
    /strict mode/,
  );
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// ops verify-release
// ---------------------------------------------------------------------------

test("ops verify-release runs the release gate matrix on the fixture", async () => {
  const ext = await harness();
  const result = await runCmd<VerifyResult>(ext, "ops verify-release", { repos: [fixtureRepo] });
  assert.ok(result, "verify-release should return a result");
  assert.ok(Array.isArray(result.repos));
  assert.strictEqual(result.repos.length, 1);
  const repo = result.repos[0];
  assert.ok(Array.isArray(repo.checks), "checks should be an array");
  assert.ok(repo.checks.length >= 1, "at least one release check should run");
  for (const c of repo.checks) {
    assert.ok(typeof c.name === "string");
    assert.ok(typeof c.pass === "boolean");
    assert.ok(typeof c.duration_ms === "number");
  }
  assert.strictEqual(repo.failed, 0, "fixture release:check should pass");
  assert.strictEqual(result.summary.passed, 1);
  assert.strictEqual(result.summary.failed, 0);
  await ext.deactivate();
});

test("ops verify-release strips NODE_TEST_CONTEXT from release gates", async () => {
  const ext = await harness();
  const repo = join(tmpRoot, "pm-node-test-context");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-node-test-context",
    version: "2026.7.31",
    scripts: {
      "release:check": "node -e \"if (process.env.NODE_TEST_CONTEXT) process.exit(9)\"",
    },
  }) + "\n");
  const originalContext = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = "child-v8";
  try {
    const result = await runCmd<VerifyResult>(ext, "ops verify-release", { repos: [repo] });
    assert.strictEqual(result.repos[0].failed, 0);
    assert.strictEqual(result.summary.failed, 0);
  } finally {
    if (originalContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = originalContext;
    await ext.deactivate();
  }
});

test("ops verify-release fails when no release gate scripts exist", async () => {
  const ext = await harness();
  const repo = join(tmpRoot, "pm-no-release");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "pm-no-release", version: "2026.7.6", scripts: {} }) + "\n");
  await assert.rejects(
    runCmd(ext, "ops verify-release", { repos: [repo] }),
    /verify-release: 1 repo\(s\) failed/,
  );
  await ext.deactivate();
});

test("ops verify-release reports missing repo paths clearly", async () => {
  const ext = await harness();
  const missingRepo = join(tmpRoot, "pm-missing-release");
  await assert.rejects(
    runCmd(ext, "ops verify-release", { repos: [missingRepo] }),
    /verify-release: 1 repo\(s\) failed/,
  );
  await ext.deactivate();
});

test("ops verify-release --output writes to a file", async () => {
  const ext = await harness();
  const outFile = join(tmpRoot, "verify-release.md");
  const result = await runCmd<WrittenResult>(ext, "ops verify-release", { repos: [fixtureRepo], format: "markdown", output: outFile });
  assert.ok(result?.written_to, "should return a written_to summary");
  assert.strictEqual(result.written_to, outFile);
  const body = readFileSync(outFile, "utf-8");
  assert.match(body, /pm-ops verify-release/);
  assert.match(body, /\| pm-fixture \|/);
  await ext.deactivate();
});

test("ops verify-release --format json --output writes JSON and creates parent directories", async () => {
  const ext = await harness();
  const outFile = join(tmpRoot, "reports", "verify-release.json");
  const result = await runCmd<WrittenResult>(ext, "ops verify-release", { repos: [fixtureRepo], format: "json", output: outFile });
  assert.strictEqual(result.written_to, outFile);
  const body = readFileSync(outFile, "utf-8");
  assert.doesNotThrow(() => JSON.parse(body));
  assert.match(body, /"summary"/);
  await ext.deactivate();
});

test("ops verify-release exercises fallback checks and every stdout failure format", async () => {
  const ext = await harness();
  const repo = join(tmpRoot, "pm-fallback-release");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-fallback-release",
    scripts: {
      typecheck: "node -e \"process.exit(0)\"",
      build: "node -e \"process.stderr.write('build failed\\n'); process.exit(1)\"",
    },
  }) + "\n");

  for (const format of ["json", "markdown", "toon"] as const) {
    await assert.rejects(
      runCmd(ext, "ops verify-release", { repos: [repo], format }),
      /verify-release: 1 repo\(s\) failed/,
    );
  }
  const outFile = join(tmpRoot, "failed-release.md");
  await assert.rejects(
    runCmd(ext, "ops verify-release", { repos: [repo], format: "markdown", output: outFile }),
    /verify-release: 1 repo\(s\) failed/,
  );
  assert.match(readFileSync(outFile, "utf8"), /build failed/);

  const json = await runCmd<RenderedResult>(ext, "ops verify-release", { repos: [fixtureRepo], format: "json" });
  assert.strictEqual(parseJson<{ summary: { passed: number } }>(json.output).summary.passed, 1);
  const markdown = await runCmd<RenderedResult>(ext, "ops verify-release", { repos: [fixtureRepo], format: "markdown" });
  assert.match(markdown.output, /pm-ops verify-release/);
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// ops report
// ---------------------------------------------------------------------------

test("ops report --format markdown combines scan + policy into a table", async () => {
  const ext = await harness();
  const result = await runCmd<RenderedResult>(ext, "ops report", { repos: [fixtureRepo], format: "markdown" });
  assert.ok(result?.pmOpsRendered === true, "report markdown should be a rendered marker");
  assert.match(result.output, /pm-ops scan/);
  assert.match(result.output, /pm-ops policy/);
  assert.match(result.output, /\| repo \|/);
  assert.match(result.output, /\| pm-fixture \|/);
  // Enhanced report should include a timestamp header
  assert.match(result.output, /Generated:/);
  assert.match(result.output, /Fleet Report/);
  await ext.deactivate();
});

test("ops report --include-release adds verify-release section", async () => {
  const ext = await harness();
  const result = await runCmd<RenderedResult>(ext, "ops report", { repos: [fixtureRepo], format: "markdown", "include-release": true });
  assert.ok(result?.pmOpsRendered === true);
  assert.match(result.output, /pm-ops scan/);
  assert.match(result.output, /pm-ops policy/);
  assert.match(result.output, /pm-ops verify-release/);
  await ext.deactivate();
});

test("ops report --output writes to a file and returns a summary", async () => {
  const ext = await harness();
  const outFile = join(tmpRoot, "fleet-report.md");
  const result = await runCmd<WrittenResult>(ext, "ops report", { repos: [fixtureRepo], format: "markdown", output: outFile });
  assert.ok(result?.written_to, "should return a written_to summary");
  assert.strictEqual(result.written_to, outFile);
  const body = readFileSync(outFile, "utf-8");
  assert.match(body, /pm-ops scan/);
  assert.match(body, /pm-ops policy/);
  await ext.deactivate();
});

test("ops report --format json --output writes JSON and creates parent directories", async () => {
  const ext = await harness();
  const outFile = join(tmpRoot, "reports", "fleet-report.json");
  const result = await runCmd<WrittenResult>(ext, "ops report", { repos: [fixtureRepo], format: "json", output: outFile });
  assert.strictEqual(result.written_to, outFile);
  const body = readFileSync(outFile, "utf-8");
  const parsed = JSON.parse(body) as ReportResult;
  assert.ok(parsed.scan, "json report should include scan section");
  assert.ok(parsed.policy, "json report should include policy section");
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// ops status
// ---------------------------------------------------------------------------

test("ops status produces a quick fleet overview", async () => {
  const ext = await harness();
  const result = await runCmd<StatusResult>(ext, "ops status", { repos: [fixtureRepo] });
  assert.ok(result, "status should return a result");
  assert.ok(Array.isArray(result.repos));
  assert.strictEqual(result.repos.length, 1);
  assert.strictEqual(result.repos[0].name, "pm-fixture");
  assert.strictEqual(result.repos[0].ready, true, "fixture should be ready");
  assert.strictEqual(result.repos[0].issues.length, 0, "fixture should have no issues");
  assert.strictEqual(result.summary.total, 1);
  assert.strictEqual(result.summary.ready, 1);
  assert.strictEqual(result.summary.not_ready, 0);
  await ext.deactivate();
});

test("ops status reports a clear error for missing repo paths", async () => {
  const ext = await harness();
  const missingRepo = join(tmpRoot, "pm-missing-status");
  const result = await runCmd<StatusResult>(ext, "ops status", { repos: [missingRepo] });
  assert.strictEqual(result.repos.length, 1);
  assert.strictEqual(result.repos[0].name, "pm-missing-status");
  assert.strictEqual(result.repos[0].ready, false);
  assert.deepStrictEqual(result.repos[0].issues, ["repository directory does not exist"]);
  assert.strictEqual(result.summary.not_ready, 1);
  await ext.deactivate();
});

test("ops status does not report ready when an online security audit is unavailable", async () => {
  const ext = await harness();
  const bin = createAuditFailureBin("bin-status-audit-unavailable");

  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  try {
    const result = await runCmd<StatusResult>(ext, "ops status", { repos: [fixtureRepo] });
    assert.strictEqual(result.repos[0].ready, false);
    assert.match(result.repos[0].issues.join("\n"), /audit unavailable: npm audit failed: \[EAI_AGAIN\] registry unavailable/);
    process.env.PM_OPS_OFFLINE = "1";
    const offline = await runCmd<StatusResult>(ext, "ops status", { repos: [fixtureRepo] });
    assert.strictEqual(offline.repos[0].ready, true);
    assert.strictEqual(offline.repos[0].issues.length, 0);
  } finally {
    process.env.PM_OPS_OFFLINE = previousOffline;
    process.env.PATH = previousPath;
  }
  await ext.deactivate();
});

test("ops status --format markdown emits a compact table", async () => {
  const ext = await harness();
  const result = await runCmd<RenderedResult>(ext, "ops status", { repos: [fixtureRepo], format: "markdown" });
  assert.ok(result?.pmOpsRendered === true);
  assert.match(result.output, /pm-ops status/);
  assert.match(result.output, /\| repo \|/);
  assert.match(result.output, /\| pm-fixture \|/);
  await ext.deactivate();
});

test("existing sparse repos retain explicit unknowns across status, policy, audit, and outdated reports", async () => {
  const ext = await harness();
  const repo = join(tmpRoot, "pm-sparse");
  mkdirSync(repo, { recursive: true });

  const status = await runCmd<StatusResult>(ext, "ops status", { repos: [repo] });
  assert.strictEqual(status.repos[0].name, null);
  assert.strictEqual(status.repos[0].ready, false);
  assert.deepStrictEqual(status.repos[0].issues, [
    "strict TS not enabled",
    "no CHANGELOG.md",
    "no release workflow",
    "no CI workflow",
    "pm-changelog not wired",
  ]);
  const statusMarkdown = await runCmd<RenderedResult>(ext, "ops status", { repos: [repo], format: "markdown" });
  assert.match(statusMarkdown.output, /\| pm-sparse \| - \| no \| \? \|/);

  const policy = await runCmd<PolicyResult>(ext, "ops policy", { repos: [repo] });
  assert.match(policy.repos[0].checks.find(({ id }) => id === "naming")?.message ?? "", /has no name/);
  assert.match(policy.repos[0].checks.find(({ id }) => id === "pm-duplicate-titles")?.message ?? "", /no pm workspace/);

  const outdated = await runCmd<RenderedResult>(ext, "ops outdated", { repos: [repo], format: "markdown" });
  assert.match(outdated.output, /## pm-sparse/);
  const audit = await runCmd<RenderedResult>(ext, "ops audit", { repos: [repo], format: "markdown" });
  assert.match(audit.output, /\| pm-sparse \| \? \| \? \| \? \| \? \| \? \| \? \|/);

  await assert.rejects(runCmd(ext, "ops verify-release", { repos: [repo], format: "markdown" }), /1 repo\(s\) failed/);
  await ext.deactivate();
});

test("markdown reports label an existing repo without package metadata by directory name", async () => {
  const ext = await harness();
  const repo = join(tmpRoot, "pm-unnamed");
  mkdirSync(repo, { recursive: true });

  const scan = await runCmd<RenderedResult>(ext, "ops scan", { repos: [repo], format: "markdown" });
  assert.match(scan.output, /\| pm-unnamed \| - \|/);
  const policy = await runCmd<RenderedResult>(ext, "ops policy", { repos: [repo], format: "markdown" });
  assert.match(policy.output, /\| pm-unnamed \| naming \|/);
  const outdated = await runCmd<RenderedResult>(ext, "ops outdated", { repos: [repo], format: "markdown" });
  assert.match(outdated.output, /## pm-unnamed/);
  const audit = await runCmd<RenderedResult>(ext, "ops audit", { repos: [repo], format: "markdown" });
  assert.match(audit.output, /\| pm-unnamed \| \? \|/);
  await ext.deactivate();
});

test("ops status surfaces pending merge receipts without making them the readiness gate", async () => {
  const ext = await harness();
  const result = await runCmd<StatusResult>(ext, "ops status", { repos: [conflictingMergeLab.path] });
  assert.match(result.repos[0].issues.join("\n"), /1 pending merge receipt/);
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// ops audit
// ---------------------------------------------------------------------------

test("ops audit produces a vulnerability summary", async () => {
  const ext = await harness();
  const result = await runCmd<AuditResult>(ext, "ops audit", { repos: [fixtureRepo] });
  assert.ok(result, "audit should return a result");
  assert.ok(Array.isArray(result.repos));
  assert.strictEqual(result.repos.length, 1);
  assert.ok(typeof result.summary.total === "number");
  assert.ok(typeof result.summary.clean === "number");
  assert.ok(typeof result.summary.unknown === "number");
  await ext.deactivate();
});

test("ops audit --format markdown emits a vulnerability table", async () => {
  const ext = await harness();
  const result = await runCmd<RenderedResult>(ext, "ops audit", { repos: [fixtureRepo], format: "markdown" });
  assert.ok(result?.pmOpsRendered === true);
  assert.match(result.output, /pm-ops audit/);
  assert.match(result.output, /unknown/);
  assert.match(result.output, /\| repo \|/);
  assert.match(result.output, /\| pm-fixture \|/);
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// ops outdated
// ---------------------------------------------------------------------------

test("ops outdated produces a dependency freshness report", async () => {
  const ext = await harness();
  const result = await runCmd<OutdatedResult>(ext, "ops outdated", { repos: [fixtureRepo] });
  assert.ok(result, "outdated should return a result");
  assert.ok(Array.isArray(result.repos));
  assert.strictEqual(result.repos.length, 1);
  assert.ok(typeof result.summary.total === "number");
  assert.ok(typeof result.summary.total_outdated === "number");
  await ext.deactivate();
});

test("ops outdated --format markdown emits a well-formed report", async () => {
  const ext = await harness();
  const result = await runCmd<RenderedResult>(ext, "ops outdated", { repos: [fixtureRepo], format: "markdown" });
  assert.ok(result?.pmOpsRendered === true);
  assert.match(result.output, /pm-ops outdated/);
  assert.match(result.output, /Unable to check outdated dependencies: offline mode enabled/);
  assert.doesNotMatch(result.output, /All dependencies are up to date/);
  await ext.deactivate();
});

test("online audit and outdated reports preserve actionable npm and GitHub data", async () => {
  const ext = await harness();
  const bin = createAuditFailureBin("bin-fleet-success", true, "success");
  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  const previousScenario = process.env.PM_OPS_FAKE_SCENARIO;
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  try {
    process.env.PM_OPS_FAKE_SCENARIO = "outdated";
    const outdated = await runCmd<OutdatedResult>(ext, "ops outdated", { repos: [fixtureRepo] });
    assert.strictEqual(outdated.summary.total_outdated, 1);
    assert.deepStrictEqual(outdated.repos[0].outdated[0], {
      name: "example",
      current: "1.0.0",
      wanted: "1.1.0",
      latest: "2.0.0",
      type: "dependencies",
    });
    const outdatedMarkdown = await runCmd<RenderedResult>(ext, "ops outdated", { repos: [fixtureRepo], format: "markdown" });
    assert.match(outdatedMarkdown.output, /\| example \| 1\.0\.0 \| 1\.1\.0 \| 2\.0\.0 \| dependencies \|/);

    process.env.PM_OPS_FAKE_SCENARIO = "outdated-error";
    const failedOutdated = await runCmd<OutdatedResult>(ext, "ops outdated", { repos: [fixtureRepo] });
    assert.strictEqual(failedOutdated.repos[0].count, null);
    assert.match(failedOutdated.repos[0].error ?? "", /EFAIL.*fleet unavailable/);

    process.env.PM_OPS_FAKE_SCENARIO = "outdated-code";
    const codeOnly = await runCmd<OutdatedResult>(ext, "ops outdated", { repos: [fixtureRepo] });
    assert.match(codeOnly.repos[0].error ?? "", /npm error code ECODE/);

    process.env.PM_OPS_FAKE_SCENARIO = "outdated-invalid-fail";
    const invalidFailure = await runCmd<ScanResult>(ext, "ops scan", { repos: [fixtureRepo] });
    assert.strictEqual(invalidFailure.repos[0].outdated_count, null);

    process.env.PM_OPS_FAKE_SCENARIO = "outdated-defaults";
    const defaults = await runCmd<OutdatedResult>(ext, "ops outdated", { repos: [fixtureRepo] });
    assert.deepStrictEqual(defaults.repos[0].outdated[0], { name: "example", current: "-", wanted: "-", latest: "-", type: "-" });

    process.env.PM_OPS_FAKE_SCENARIO = "up-to-date";
    const upToDate = await runCmd<RenderedResult>(ext, "ops outdated", { repos: [fixtureRepo], format: "markdown" });
    assert.match(upToDate.output, /All dependencies are up to date/);

    process.env.PM_OPS_FAKE_SCENARIO = "audit-vulns";
    const audit = await runCmd<AuditResult>(ext, "ops audit", { repos: [fixtureRepo] });
    assert.deepStrictEqual(audit.repos[0], {
      path: fixtureRepo,
      name: "pm-fixture",
      critical: 1,
      high: 2,
      moderate: 3,
      low: 4,
      total: 10,
      ok: false,
    });
    assert.strictEqual(audit.summary.total_critical, 1);
    assert.strictEqual(audit.summary.total_high, 2);
    const auditMarkdown = await runCmd<RenderedResult>(ext, "ops audit", { repos: [fixtureRepo], format: "markdown" });
    assert.match(auditMarkdown.output, /\| vulns \|/);
    const status = await runCmd<StatusResult>(ext, "ops status", { repos: [fixtureRepo] });
    assert.match(status.repos[0].issues.join("\n"), /1 critical vuln\(s\).*2 high vuln\(s\)/s);
    assert.strictEqual(status.repos[0].ready, false);
    const scan = await runCmd<ScanResult>(ext, "ops scan", { repos: [fixtureRepo] });
    assert.strictEqual(scan.repos[0].open_prs, 1);
    assert.strictEqual(scan.repos[0].open_issues, 2);
    assert.strictEqual(scan.repos[0].ready, false);

    process.env.PM_OPS_FAKE_SCENARIO = "audit-empty";
    const clean = await runCmd<AuditResult>(ext, "ops audit", { repos: [fixtureRepo] });
    assert.deepStrictEqual(clean.repos[0], {
      path: fixtureRepo,
      name: "pm-fixture",
      critical: 0,
      high: 0,
      moderate: 0,
      low: 0,
      total: 0,
      ok: true,
    });

    const unnamed = join(tmpRoot, "pm-online-unnamed");
    mkdirSync(unnamed, { recursive: true });
    const unnamedAudit = await runCmd<AuditResult>(ext, "ops audit", { repos: [unnamed] });
    assert.strictEqual(unnamedAudit.repos[0].name, null);
    const cleanMarkdown = await runCmd<RenderedResult>(ext, "ops audit", { repos: [unnamed], format: "markdown" });
    assert.match(cleanMarkdown.output, /\| clean \|/);
    process.env.PM_OPS_FAKE_SCENARIO = "outdated-defaults";
    const unnamedOutdated = await runCmd<OutdatedResult>(ext, "ops outdated", { repos: [unnamed] });
    assert.strictEqual(unnamedOutdated.repos[0].name, null);
    const unnamedOutdatedMarkdown = await runCmd<RenderedResult>(ext, "ops outdated", { repos: [unnamed], format: "markdown" });
    assert.match(unnamedOutdatedMarkdown.output, /## pm-online-unnamed/);

    process.env.PM_OPS_FAKE_SCENARIO = "audit-string";
    assert.match((await runCmd<ScanResult>(ext, "ops scan", { repos: [fixtureRepo] })).repos[0].errors.join("\n"), /registry unavailable/);
    process.env.PM_OPS_FAKE_SCENARIO = "audit-object-empty";
    assert.match((await runCmd<ScanResult>(ext, "ops scan", { repos: [fixtureRepo] })).repos[0].errors.join("\n"), /\[unknown\] unknown error/);

    for (const scenario of ["gh-fail", "gh-invalid"] as const) {
      process.env.PM_OPS_FAKE_SCENARIO = scenario;
      const ghUnavailable = await runCmd<ScanResult>(ext, "ops scan", { repos: [fixtureRepo] });
      assert.strictEqual(ghUnavailable.repos[0].open_prs, scenario === "gh-fail" ? null : 1);
      const policy = await runCmd<PolicyResult>(ext, "ops policy", { repos: [fixtureRepo] });
      assert.strictEqual(policy.repos[0].checks.find(({ id }) => id === "private-no-runners")?.pass, true);
    }

    process.env.PM_OPS_FAKE_SCENARIO = "up-to-date";
    const publicPolicy = await runCmd<PolicyResult>(ext, "ops policy", { repos: [fixtureRepo] });
    assert.strictEqual(publicPolicy.repos[0].checks.find(({ id }) => id === "private-no-runners")?.pass, true);

    process.env.PM_OPS_FAKE_SCENARIO = "gh-lists-invalid";
    const invalidLists = await runCmd<ScanResult>(ext, "ops scan", { repos: [fixtureRepo] });
    assert.strictEqual(invalidLists.repos[0].open_prs, null);
    assert.strictEqual(invalidLists.repos[0].open_issues, null);

    process.env.PM_OPS_FAKE_SCENARIO = "audit-missing";
    const unknown = await runCmd<RenderedResult>(ext, "ops audit", { repos: [fixtureRepo], format: "markdown" });
    assert.strictEqual(unknown.pmOpsRendered, true);
    const unavailable = await runCmd<ScanResult>(ext, "ops scan", { repos: [fixtureRepo] });
    assert.match(unavailable.repos[0].errors.join("\n"), /audit unavailable/);
    const unnamedUnknownAudit = await runCmd<AuditResult>(ext, "ops audit", { repos: [unnamed] });
    assert.strictEqual(unnamedUnknownAudit.repos[0].name, null);

    process.env.PM_OPS_FAKE_SCENARIO = "outdated-error";
    const unnamedFailedOutdated = await runCmd<RenderedResult>(ext, "ops outdated", { repos: [unnamed], format: "markdown" });
    assert.match(unnamedFailedOutdated.output, /## pm-online-unnamed/);

    if (process.platform !== "win32") {
      const brokenBin = join(tmpRoot, "bin-broken-npm");
      mkdirSync(brokenBin, { recursive: true });
      writeFileSync(join(brokenBin, "npm"), "#!/definitely/missing/interpreter\n");
      chmodSync(join(brokenBin, "npm"), 0o755);
      process.env.PATH = brokenBin;
      const spawnFailure = await runCmd<OutdatedResult>(ext, "ops outdated", { repos: [fixtureRepo] });
      assert.match(spawnFailure.repos[0].error ?? "", /ENOENT/);
      assert.strictEqual((await runCmd<OutdatedResult>(ext, "ops outdated", { repos: [unnamed] })).repos[0].name, null);
      const auditSpawnFailure = await runCmd<AuditResult>(ext, "ops audit", { repos: [fixtureRepo] });
      assert.strictEqual(auditSpawnFailure.repos[0].total, null);
      assert.strictEqual((await runCmd<AuditResult>(ext, "ops audit", { repos: [unnamed] })).repos[0].name, null);
      const scanSpawnFailure = await runCmd<ScanResult>(ext, "ops scan", { repos: [fixtureRepo] });
      assert.match(scanSpawnFailure.repos[0].errors.join("\n"), /npm audit failed:.*ENOENT/);
      await assert.rejects(runCmd(ext, "ops verify-release", { repos: [fixtureRepo] }), /failed/);
    }
  } finally {
    if (previousOffline === undefined) delete process.env.PM_OPS_OFFLINE;
    else process.env.PM_OPS_OFFLINE = previousOffline;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousScenario === undefined) delete process.env.PM_OPS_FAKE_SCENARIO;
    else process.env.PM_OPS_FAKE_SCENARIO = previousScenario;
    await ext.deactivate();
  }
});

// ---------------------------------------------------------------------------
// ops metrics
// ---------------------------------------------------------------------------

test("ops metrics emits Prometheus exposition for the fixture pm workspace", async () => {
  const ext = await harness();
  const result = await runCmd<RenderedResult>(ext, "ops metrics", { repos: [fixtureRepo] });
  assert.strictEqual(result?.pmOpsRendered, true, "default output should be rendered Prometheus text");
  const body = result.output;
  // Every metric family must carry its HELP/TYPE header exactly once.
  for (const family of ["pm_items", "pm_active_items_by_type", "pm_stale_items", "pm_throughput_items", "pm_workspace_available", "pm_repos_scanned", "pm_scrape_duration_seconds"]) {
    assert.strictEqual((body.match(new RegExp(`^# TYPE ${family} `, "gm")) ?? []).length, 1, `${family} should declare TYPE once`);
  }
  // The fixture has two active Tasks: one current and one deliberately stale.
  assert.match(body, /pm_items\{repo="pm-fixture",status="open"\} 2/);
  assert.match(body, /pm_active_items_by_type\{repo="pm-fixture",type="task"\} 2/);
  assert.match(body, /pm_stale_items\{repo="pm-fixture"\} 1/);
  assert.match(body, /pm_throughput_items\{repo="pm-fixture",window="7d"\} 1/);
  assert.match(body, /pm_cycle_time_seconds\{repo="pm-fixture",quantile="0\.5"\}/);
  assert.match(body, /pm_workspace_available\{repo="pm-fixture"\} 1/);
  assert.match(body, /^pm_repos_scanned 1$/m);
  // Sample lines must be valid exposition format (no NaN, well-formed labels).
  assert.doesNotMatch(body, /\bNaN\b/);
  await ext.deactivate();
});

test("ops metrics --json exposes the structured routing contract", async () => {
  const ext = await harness();
  // `--json` is a host-owned global read from ctx.global, so pass it via the
  // global override. Structured stdout returns the bare result object (no
  // renderedCommandResult wrapper) so `pm ops metrics --json | jq .repos`
  // works under the CLI's global renderer.
  const payload = await runCmd<MetricsResult>(ext, "ops metrics", { repos: [fixtureRepo] }, [], { json: true });
  assert.deepStrictEqual(payload.repos.map((r) => r.path), [fixtureRepo]);
  assert.strictEqual(payload.repos[0].available, true);
  assert.strictEqual(payload.repos[0].repo, "pm-fixture");
  assert.strictEqual(payload.repos[0].status_counts.open, 2);
  assert.strictEqual(payload.repos_scanned, 1);
  assert.strictEqual(typeof payload.generated_at, "string");
  await ext.deactivate();
});

test("ops metrics writes Prometheus and structured reports", async () => {
  const ext = await harness();
  const prometheusFile = join(tmpRoot, "reports", "pm.prom");
  const prometheus = await runCmd<WrittenResult>(ext, "ops metrics", { repos: [fixtureRepo], output: prometheusFile, staleDays: "7" });
  assert.strictEqual(prometheus.format, "prometheus");
  assert.match(readFileSync(prometheusFile, "utf8"), /pm_repos_scanned 1/);

  const jsonFile = join(tmpRoot, "reports", "metrics.json");
  const json = await runCmd<WrittenResult>(ext, "ops metrics", { repos: [fixtureRepo], format: "json", output: jsonFile, "stale-days": "invalid" });
  assert.strictEqual(json.format, "json");
  assert.strictEqual(parseJson<{ repos_scanned: number }>(readFileSync(jsonFile, "utf8")).repos_scanned, 1);

  const toonFile = join(tmpRoot, "reports", "metrics.toon");
  const toon = await runCmd<WrittenResult>(ext, "ops metrics", { repos: [fixtureRepo], format: "toon", output: toonFile });
  assert.strictEqual(toon.format, "toon");
  assert.ok(readFileSync(toonFile, "utf8").length > 0);
  await ext.deactivate();
});

test("ops metrics marks a missing workspace unavailable without failing", async () => {
  const ext = await harness();
  const missingRepo = join(tmpRoot, "pm-metrics-missing");
  const payload = await runCmd<MetricsResult>(ext, "ops metrics", { repos: [missingRepo] }, [], { json: true });
  assert.deepStrictEqual(payload.repos.map((r) => r.path), [resolve(missingRepo)]);
  assert.strictEqual(payload.repos[0].available, false);
  assert.strictEqual(payload.repos_scanned, 0);
  const prometheus = await runCmd<RenderedResult>(ext, "ops metrics", { repos: [missingRepo] });
  assert.match(prometheus.output, /pm_workspace_available\{repo="pm-metrics-missing"\} 0/);

  const nongit = join(tmpRoot, "pm-metrics-nongit");
  mkdirSync(nongit, { recursive: true });
  const pmCommand = process.platform === "win32" ? "pm.cmd" : "pm";
  const initialized = spawnSync(pmCommand, ["init", "metrics nongit", "--pm-path", join(nongit, ".agents", "pm")], { cwd: nongit, encoding: "utf8" });
  assert.strictEqual(initialized.status, 0, initialized.stderr);
  rmSync(join(nongit, ".git"), { recursive: true, force: true });
  const nongitMetrics = await runCmd<RenderedResult>(ext, "ops metrics", { repos: [nongit] });
  assert.match(nongitMetrics.output, /pm_workspace_available\{repo="pm-metrics-nongit"\} 1/);
  assert.match(nongitMetrics.output, /pm_merge_driver_installed\{repo="pm-metrics-nongit"\} 0/);
  await ext.deactivate();
});

test("ops metrics rejects a stale pm list envelope instead of treating it as item data", async () => {
  const ext = await harness();
  const bin = join(tmpRoot, "bin-stale-pm-envelope");
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(join(bin, "pm.cmd"), "@echo off\necho {\"results\":[]}\n");
  } else {
    writeFileSync(join(bin, "pm"), "#!/usr/bin/env sh\nprintf '{\"results\":[]}\\n'\n");
    chmodSync(join(bin, "pm"), 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  try {
    const payload = await runCmd<MetricsResult>(ext, "ops metrics", { repos: [fixtureRepo] }, [], { json: true });
    assert.strictEqual(payload.repos[0].available, false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await ext.deactivate();
  }
});

test("pm workspace readers fail closed on malformed CLI contracts and preserve sparse item semantics", async () => {
  const ext = await harness();
  const bin = join(tmpRoot, "bin-pm-contracts");
  mkdirSync(bin, { recursive: true });
  const richItems = JSON.stringify({ items: [
    { id: "canceled", title: "Canceled", status: "cancelled", type: "Task", priority: 4 },
    { id: "unknown", title: "Unknown", status: "", updated_at: "not-a-date", created_at: "not-a-date" },
    { id: "closed", title: "Closed", status: "closed", closed_at: "not-a-date" },
    { id: "draft", title: "Draft", status: "draft", type: "Idea" },
    { id: "missing-status", title: "Missing status" },
  ] });
  const duplicateItems = JSON.stringify({ items: [
    { id: "one", title: "Repeated title", status: "open" },
    { id: "two", title: "Repeated title", status: "open" },
    { id: "blank", status: "open" },
  ] });
  const singleLifecycleItem = JSON.stringify({ items: [
    { id: "one-cycle", title: "One cycle", status: "closed", type: "Task", created_at: "2026-08-01T00:00:00.000Z", closed_at: "2026-08-02T00:00:00.000Z" },
  ] });
  if (process.platform === "win32") {
    writeFileSync(join(bin, "pm.cmd"), `@echo off
if "%PM_OPS_FAKE_SCENARIO%"=="pm-status-fail" exit /b 1
if "%PM_OPS_FAKE_SCENARIO%"=="pm-invalid" (echo not-json & exit /b 0)
if "%PM_OPS_FAKE_SCENARIO%"=="pm-scalar" (echo {"items":"invalid"} & exit /b 0)
if "%PM_OPS_FAKE_SCENARIO%"=="pm-stale" (echo {"results":[]} & exit /b 0)
if "%PM_OPS_FAKE_SCENARIO%"=="pm-duplicates" (echo ${duplicateItems} & exit /b 0)
if "%PM_OPS_FAKE_SCENARIO%"=="pm-blocked-invalid" (if "%~1"=="list-blocked" (echo not-json & exit /b 0) else (echo ${richItems} & exit /b 0))
if "%PM_OPS_FAKE_SCENARIO%"=="pm-single" (echo ${singleLifecycleItem} & exit /b 0)
echo ${richItems}
`);
  } else {
    writeFileSync(join(bin, "pm"), `#!/usr/bin/env sh
case "$PM_OPS_FAKE_SCENARIO" in
  pm-status-fail) exit 1 ;;
  pm-invalid) printf 'not-json\\n' ;;
  pm-scalar) printf '%s\\n' '{"items":"invalid"}' ;;
  pm-stale) printf '%s\\n' '{"results":[]}' ;;
  pm-duplicates) printf '%s\\n' '${duplicateItems}' ;;
  pm-blocked-invalid) if [ "$1" = list-blocked ]; then printf 'not-json\\n'; else printf '%s\\n' '${richItems}'; fi ;;
  pm-single) printf '%s\\n' '${singleLifecycleItem}' ;;
  *) printf '%s\\n' '${richItems}' ;;
esac
`);
    chmodSync(join(bin, "pm"), 0o755);
  }
  const previousPath = process.env.PATH;
  const previousScenario = process.env.PM_OPS_FAKE_SCENARIO;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  try {
    for (const scenario of ["pm-status-fail", "pm-invalid", "pm-scalar"] as const) {
      process.env.PM_OPS_FAKE_SCENARIO = scenario;
      const payload = await runCmd<MetricsResult>(ext, "ops metrics", { repos: [fixtureRepo] }, [], { json: true });
      assert.strictEqual(payload.repos[0].available, false, `${scenario} must fail closed`);
    }

    process.env.PM_OPS_FAKE_SCENARIO = "pm-invalid";
    const scan = await runCmd<RenderedResult>(ext, "ops scan", { repos: [fixtureRepo], format: "markdown" });
    assert.match(scan.output, /\? \|/);
    const status = await runCmd<RenderedResult>(ext, "ops status", { repos: [fixtureRepo], format: "markdown" });
    assert.match(status.output, /\? \|/);

    process.env.PM_OPS_FAKE_SCENARIO = "pm-stale";
    const stale = await runCmd<MetricsResult>(ext, "ops metrics", { repos: [fixtureRepo] }, [], { json: true });
    assert.strictEqual(stale.repos[0].available, false);

    process.env.PM_OPS_FAKE_SCENARIO = "pm-duplicates";
    const policy = await runCmd<PolicyResult>(ext, "ops policy", { repos: [fixtureRepo] });
    const duplicateCheck = policy.repos[0].checks.find(({ id }) => id === "pm-duplicate-titles");
    assert.strictEqual(duplicateCheck?.pass, false);
    assert.deepStrictEqual(duplicateCheck?.details, ["Repeated title (2)"]);

    process.env.PM_OPS_FAKE_SCENARIO = "pm-rich";
    const metrics = await runCmd<MetricsResult>(ext, "ops metrics", { repos: [fixtureRepo] }, [], { json: true });
    assert.strictEqual(metrics.repos[0].status_counts.canceled, 1);
    assert.strictEqual(metrics.repos[0].status_counts.unknown, 2);
    assert.strictEqual(metrics.repos[0].status_counts.closed, 1);
    const richScan = await runCmd<ScanResult>(ext, "ops scan", { repos: [fixtureRepo] });
    assert.strictEqual(richScan.repos[0].pm_workspace, true);
    const richStatus = await runCmd<StatusResult>(ext, "ops status", { repos: [fixtureRepo] });
    assert.strictEqual(richStatus.repos[0].name, "pm-fixture");
    const richPolicy = await runCmd<PolicyResult>(ext, "ops policy", { repos: [fixtureRepo] });
    assert.strictEqual(richPolicy.repos[0].checks.find(({ id }) => id === "pm-duplicate-titles")?.pass, true);

    process.env.PM_OPS_FAKE_SCENARIO = "pm-blocked-invalid";
    const unknownBlocked = await runCmd<MetricsResult>(ext, "ops metrics", { repos: [fixtureRepo] }, [], { json: true });
    assert.strictEqual(unknownBlocked.repos[0].available, true);

    process.env.PM_OPS_FAKE_SCENARIO = "pm-single";
    const single = await runCmd<MetricsResult>(ext, "ops metrics", { repos: [fixtureRepo] }, [], { json: true });
    assert.strictEqual(single.repos[0].cycle_time_p50_seconds, 86_400);
    assert.strictEqual(single.repos[0].cycle_time_p90_seconds, 86_400);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousScenario === undefined) delete process.env.PM_OPS_FAKE_SCENARIO;
    else process.env.PM_OPS_FAKE_SCENARIO = previousScenario;
    await ext.deactivate();
  }
});

test("ops metrics disambiguates repo labels when package names collide", async () => {
  const ext = await harness();
  // Two distinct checkouts that both declare the same package.json name must
  // not emit duplicate Prometheus series — each needs a unique `repo` label.
  const twin = join(tmpRoot, "pm-fixture-twin");
  mkdirSync(join(twin, ".agents", "pm"), { recursive: true });
  writeFileSync(join(twin, "package.json"), JSON.stringify({ name: "pm-fixture", version: "1.0.0" }));
  const pmCmd = process.platform === "win32" ? "pm.cmd" : "pm";
  const pmInit = spawnSync(pmCmd, ["init", "twin", "--pm-path", join(twin, ".agents", "pm")], { encoding: "utf-8", timeout: 30_000 });
  assert.strictEqual(pmInit.status, 0, `twin pm init failed: ${pmInit.stderr}`);
  const payload = await runCmd<MetricsResult>(ext, "ops metrics", { repos: [fixtureRepo, twin] }, [], { json: true });
  const labels = payload.repos.map((r) => r.repo);
  assert.strictEqual(new Set(labels).size, labels.length, `repo labels must be unique, got ${JSON.stringify(labels)}`);
  // Every colliding repo keeps the package name as a prefix so dashboards can
  // still group by it, but each carries a distinguishing suffix.
  assert.ok(labels.every((l) => l === "pm-fixture" || l.startsWith("pm-fixture (")), `labels should be name-prefixed, got ${JSON.stringify(labels)}`);
  assert.ok(labels.some((l) => l.startsWith("pm-fixture (")), "colliding repos are disambiguated with a suffix");
  await ext.deactivate();
});

test("disambiguateRepoLabels never generates a label that collides with an untouched original", () => {
  // Greptile P1 repro: two `foo` repos disambiguate by basename, but a third
  // repo is *genuinely* labeled `foo (bar)` (e.g. a directory basename with
  // parens). The generated label must not steal the third repo's real label.
  const metrics = [
    { repo: "foo", path: "/repos/bar" }, // → wants "foo (bar)"
    { repo: "foo", path: "/repos/baz" }, // → wants "foo (baz)"
    { repo: "foo (bar)", path: "/repos/qux" }, // untouched original that must stay unique
  ] as unknown as Parameters<typeof disambiguateRepoLabels>[0];
  disambiguateRepoLabels(metrics);
  const labels = metrics.map((m) => m.repo);
  assert.strictEqual(new Set(labels).size, labels.length, `labels must be unique, got ${JSON.stringify(labels)}`);
  // The repo genuinely named "foo (bar)" keeps its label; the colliding "foo"
  // repo that wanted it falls back to its full path.
  assert.ok(labels.includes("foo (bar)"), "the real 'foo (bar)' repo keeps its label");
  assert.ok(labels.includes("foo (/repos/bar)"), "the colliding repo falls back to its path");

  // Identical paths (same repo passed twice) still get distinct labels.
  const dup = [
    { repo: "x", path: "/r/x" },
    { repo: "x", path: "/r/x" },
    { repo: "x", path: "/r/x" },
  ] as unknown as Parameters<typeof disambiguateRepoLabels>[0];
  disambiguateRepoLabels(dup);
  assert.strictEqual(new Set(dup.map(({ repo }) => repo)).size, 3, "identical-path duplicates are still distinct series");
  assert.ok(dup.some(({ repo }) => repo.endsWith("#2")), "a numeric suffix resolves the final collision");
});

// ---------------------------------------------------------------------------
// ops merge-receipts
// ---------------------------------------------------------------------------
// These tests build REAL git fixtures with a REAL conflicting two-branch
// merge that drives the field-aware merge driver end-to-end — no receipts are
// mocked. Git's item merge-driver records the clone-local pending receipt
// under `.git/pm-merge-receipts/` and `pm ops merge-receipts` gates on it.
// ---------------------------------------------------------------------------

test("ops merge-receipts fails the gate when a pending receipt exists (non-zero)", async () => {
  const ext = await harness();
  await assert.rejects(
    runCmd(ext, "ops merge-receipts", { repos: [conflictingMergeLab.path] }),
    /merge-receipts: 1 pending receipt\(s\)/,
    "an unreconciled pending receipt must fail the gate (unbraind/pm-cli#770)",
  );
  await ext.deactivate();
});

test("ops merge-receipts --warn-only returns the pending receipt and exits 0", async () => {
  const ext = await harness();
  const result = await runCmd<MergeReceiptsResult>(ext, "ops merge-receipts", { repos: [conflictingMergeLab.path], "warn-only": true });
  assert.strictEqual(result.summary.total, 1);
  assert.strictEqual(result.summary.with_pending, 1);
  assert.strictEqual(result.summary.total_pending, 1, "the conflicting-merge lab produced exactly one pending receipt");
  assert.strictEqual(result.summary.total_reconciled, 0);
  assert.strictEqual(result.summary.missing_driver, 0, "the driver is installed in the lab");
  assert.strictEqual(result.summary.missing_fence, 0, "the fence is committed in the lab");
  const repo = result.repos[0];
  assert.strictEqual(repo.available, true);
  assert.strictEqual(repo.driver?.status, "ok");
  assert.strictEqual(repo.fence?.status, "ok");
  assert.strictEqual(repo.pending_count, 1);
  assert.strictEqual(repo.receipts.length, 1);
  const receipt = repo.receipts[0];
  assert.strictEqual(receipt.state, "pending");
  assert.strictEqual(receipt.item_id, conflictingMergeLab.itemId);
  assert.strictEqual(receipt.preferred, "ours");
  // #771 was fixed in pm-cli 2026.7.28: the raw item_path no longer carries
  // the extra single-quote layer Git used to wrap around %P paths.
  const expectedPath = `.agents/pm/tasks/${conflictingMergeLab.itemId}.toon`;
  assert.strictEqual(receipt.item_path, expectedPath, "item_path should be the normalized path");
  assert.strictEqual(receipt.item_path_raw, expectedPath, "item_path_raw matches the normalized path after the #771 fix");
  assert.strictEqual(receipt.decisions.length, 1);
  assert.strictEqual(receipt.decisions[0].field, "description");
  assert.strictEqual(receipt.decisions[0].retained, "Agent B description", "ours=branch-b won the preferred-side scalar conflict");
  assert.strictEqual(receipt.decisions[0].discarded, "Agent A description");
  await ext.deactivate();
});

test("ops merge-receipts --format markdown renders the current SDK receipt path", async () => {
  const ext = await harness();
  const result = await runCmd<RenderedResult>(ext, "ops merge-receipts", { repos: [conflictingMergeLab.path], "warn-only": true, format: "markdown" });
  assert.ok(result?.pmOpsRendered === true, "markdown result should be a rendered marker");
  const expectedPath = `.agents/pm/tasks/${conflictingMergeLab.itemId}.toon`;
  const escapedPath = expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(result.output, /# pm-ops merge-receipts/);
  // The summary line bolds counts with `**N**` markdown, so match the bolded form.
  assert.match(result.output, /Scanned \*\*1\*\* repo\(s\): \*\*1\*\* pending receipt\(s\)/);
  assert.match(result.output, new RegExp(`\\| ${conflictingMergeLab.itemId} \\|`), "the item_id column should appear");
  assert.match(result.output, new RegExp(`\\| ${escapedPath} \\|`), "the SDK item_path should appear in the table");
  assert.match(result.output, /Agent B description/, "the retained decision value is rendered for review");
  // The raw quoted path from #771 must never reach a committed-history-safe report.
  assert.doesNotMatch(result.output, /'\.agents\/pm\/tasks\//, "the quoted raw item_path must not appear in markdown");
  await ext.deactivate();
});

test("ops merge-receipts renders sparse and structured decision values without losing the receipt", async () => {
  const lab = buildMergeReceiptLab(tmpRoot, "pm-merge-decision-rendering", true);
  const receiptDirectory = join(lab.path, ".git", "pm-merge-receipts");
  const receiptPath = join(receiptDirectory, readdirSync(receiptDirectory).find((file) => file.endsWith(".json"))!);
  const receipt = parseJson<Record<string, unknown>>(readFileSync(receiptPath, "utf8"));
  receipt.decisions = [{ field: "metadata", base: null, ours: null, theirs: { source: "peer" }, discarded: { source: "peer" } }];
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  const ext = await harness();
  const sparse = await runCmd<RenderedResult>(ext, "ops merge-receipts", { repos: [lab.path], warnOnly: true, format: "markdown" });
  assert.match(sparse.output, /\| metadata \| - \| \{"source":"peer"\} \|/);

  receipt.decisions = [];
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  const empty = await runCmd<RenderedResult>(ext, "ops merge-receipts", { repos: [lab.path], warnOnly: true, format: "markdown" });
  assert.match(empty.output, /\| - \| - \| - \|/);
  await ext.deactivate();
});

test("ops merge-receipts passes the gate when there are no receipts (exit 0)", async () => {
  const ext = await harness();
  const result = await runCmd<MergeReceiptsResult>(ext, "ops merge-receipts", { repos: [cleanMergeLab.path] });
  assert.strictEqual(result.summary.total, 1);
  assert.strictEqual(result.summary.total_pending, 0);
  assert.strictEqual(result.summary.missing_driver, 0);
  assert.strictEqual(result.summary.missing_fence, 0);
  assert.strictEqual(result.repos[0].receipts.length, 0);
  assert.strictEqual(result.repos[0].driver?.status, "ok");
  assert.strictEqual(result.repos[0].fence?.status, "ok");
  await ext.deactivate();
});

test("ops merge-receipts fails the gate when the clone-local merge driver is missing (non-zero)", async () => {
  const ext = await harness();
  // Remove only the clone-local driver definitions so the driver audit reports
  // `missing` while the committed fence stays `ok` and no receipts exist.
  for (const driver of ["pm-item-toon", "pm-item-markdown", "pm-history", "pm-relationship", "pm-json"]) {
    spawnSync("git", ["config", "--local", "--unset", `merge.${driver}.driver`], { cwd: driverMissingLab.path, encoding: "utf-8" });
  }
  await assert.rejects(
    runCmd(ext, "ops merge-receipts", { repos: [driverMissingLab.path] }),
    /merge-receipts: 1 missing driver\(s\)/,
    "a missing clone-local driver must fail the gate (unbraind/pm-cli#770)",
  );
  const metrics = await runCmd<RenderedResult>(ext, "ops metrics", { repos: [driverMissingLab.path] });
  assert.match(metrics.output, /pm_merge_driver_installed\{repo="pm-merge-no-driver"\} 0/);
  await ext.deactivate();
});

test("ops merge-receipts emits failing markdown and file reports before throwing", async () => {
  const ext = await harness();
  await assert.rejects(
    runCmd(ext, "ops merge-receipts", { repos: [conflictingMergeLab.path], format: "markdown" }),
    /pending receipt/,
  );
  const outFile = join(tmpRoot, "failed-merge-receipts.md");
  await assert.rejects(
    runCmd(ext, "ops merge-receipts", { repos: [fenceMissingLab.path], format: "markdown", output: outFile }),
    /missing fence/,
  );
  assert.match(readFileSync(outFile, "utf8"), /missing/);
  const metrics = await runCmd<RenderedResult>(ext, "ops metrics", { repos: [fenceMissingLab.path] });
  assert.match(metrics.output, /pm_merge_fence_installed\{repo="pm-merge-no-fence"\} 0/);
  await ext.deactivate();
});

test("ops merge-receipts --include-reconciled surfaces reconciled receipts while the default excludes them", async () => {
  const ext = await harness();
  // The reconcile lab currently holds a pending receipt; consume it into history
  // via the SDK so the default listing excludes it (--include-reconciled keeps it).
  const receipts = await listMergeReceipts(reconciledLab.path, { includeReconciled: true });
  assert.strictEqual(receipts.length, 1, "reconcile lab should start with one pending receipt");
  await markMergeReceiptReconciled(reconciledLab.path, receipts[0]);

  const defaulted = await runCmd<MergeReceiptsResult>(ext, "ops merge-receipts", { repos: [reconciledLab.path] });
  assert.strictEqual(defaulted.summary.total_pending, 0, "a reconciled receipt no longer counts as pending");
  assert.strictEqual(defaulted.repos[0].receipts.length, 0, "the default listing excludes reconciled receipts");

  const including = await runCmd<MergeReceiptsResult>(ext, "ops merge-receipts", { repos: [reconciledLab.path], "include-reconciled": true });
  assert.strictEqual(including.summary.total_pending, 0);
  assert.strictEqual(including.summary.total_reconciled, 1, "--include-reconciled counts reconciled receipts");
  assert.strictEqual(including.repos[0].receipts.length, 1);
  assert.strictEqual(including.repos[0].receipts[0].state, "reconciled");
  assert.strictEqual(including.repos[0].reconciled_count, 1);
  await ext.deactivate();
});

test("ops merge-receipts --format json --output writes structured JSON to a file", async () => {
  const ext = await harness();
  const outFile = join(tmpRoot, "merge-receipts.json");
  const result = await runCmd<WrittenResult>(ext, "ops merge-receipts", { repos: [cleanMergeLab.path], format: "json", output: outFile });
  assert.strictEqual(result.written_to, outFile);
  assert.strictEqual(result.format, "json");
  const body = readFileSync(outFile, "utf-8");
  const parsed = JSON.parse(body) as MergeReceiptsResult;
  assert.strictEqual(parsed.summary.total, 1);
  assert.strictEqual(parsed.summary.total_pending, 0);
  assert.strictEqual(parsed.summary.missing_driver, 0);
  assert.deepStrictEqual(parsed.repos.map((r) => r.path), [cleanMergeLab.path]);
  await ext.deactivate();
});

test("ops merge-receipts --format json returns a rendered structured payload to stdout", async () => {
  const ext = await harness();
  const result = await runCmd<RenderedResult>(ext, "ops merge-receipts", { repos: [cleanMergeLab.path], format: "json" });
  assert.ok(result?.pmOpsRendered === true, "structured stdout should be a rendered marker");
  const parsed = JSON.parse(result.output) as MergeReceiptsResult;
  assert.strictEqual(parsed.summary.total, 1);
  assert.strictEqual(parsed.repos[0].pending_count, 0);
  assert.strictEqual(parsed.repos[0].fence?.status, "ok");
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// Real-data tests against the live pm fleet. These run only when the real
// repos are present (local dev on Steve's machine); they skip on CI where the
// absolute host paths do not exist. The fixture tests above cover CI.
// ---------------------------------------------------------------------------

test("real-data: scan on configured pm repos reports all ready", { skip: !REAL_REPOS_AVAILABLE }, async () => {
  const ext = await harness();
  const result = await runCmd<ScanResult>(ext, "ops scan", { repos: REAL_REPOS });
  assert.strictEqual(result.repos.length, REAL_REPOS.length);
  for (const repo of result.repos) {
    assert.strictEqual(repo.strict_ts, true, `${repo.path} should have strict TS`);
    assert.strictEqual(repo.has_release_workflow, true, `${repo.path} should have a release workflow`);
    assert.strictEqual(repo.has_pm_changelog, true, `${repo.path} should have pm-changelog wired`);
    assert.strictEqual(repo.ready, true, `${repo.path} should be ready`);
  }
  await ext.deactivate();
});

test("real-data: verify-release on second configured pm repo passes", { skip: !REAL_REPOS_AVAILABLE }, async () => {
  const ext = await harness();
  const result = await runCmd<VerifyResult>(ext, "ops verify-release", { repos: [REAL_REPOS[1]] });
  assert.strictEqual(result.repos.length, 1);
  assert.strictEqual(result.repos[0].failed, 0, `${REAL_REPOS[1]} release:check should pass`);
  assert.strictEqual(result.summary.failed, 0);
  await ext.deactivate();
});

// ---------------------------------------------------------------------------
// Suite-wide guard: no command redeclares a host-owned global flag
// ---------------------------------------------------------------------------

test("no command redeclares a host-owned global flag", async () => {
  // Guards the whole surface, not just the commands that regressed:
  // registering any of these makes the host reject the command outright, and
  // the value must be read from ctx.global instead.
  const hostOwned = new Set([
    "--json",
    "--quiet",
    "--path",
    "--lean",
    "--id-only",
    "--author",
    "--no-changed-fields",
    "--full-changed-fields",
    "--pm-path",
  ]);
  const ext = await harness();

  for (const registration of ext.activation.registrations.flags) {
    for (const flag of registration.flags) {
      assert.ok(
        flag.long === undefined || !hostOwned.has(flag.long),
        `${registration.target_command} must not redeclare host-owned global flag ${flag.long}`,
      );
    }
  }

  await ext.deactivate();
});
// ---------------------------------------------------------------------------
// Regression: multi-word flags arrive from the host CAMEL-CASED.
//
// Commander converts `--warn-only` to `warnOnly` and `--include-reconciled` to
// `includeReconciled` before handing options to the extension. The sibling tests
// above pass the hyphenated keys, which the handler also accepts — so they
// passed while the real CLI was broken: `pm ops merge-receipts --warn-only`
// still exited non-zero because the flag was never read.
//
// These cases pin the shape the HOST actually delivers.
// ---------------------------------------------------------------------------

test("ops merge-receipts reads --warn-only under the host's camelCase key", async () => {
  const ext = await harness();
  const result = await runCmd<MergeReceiptsResult>(ext, "ops merge-receipts", {
    repos: [conflictingMergeLab.path],
    warnOnly: true,
  });
  // Reaching a resolved result at all proves the gate did not throw: the lab has
  // a pending receipt, so without --warn-only this command exits non-zero.
  assert.strictEqual(result.summary.total_pending, 1, "the pending receipt is still reported under warn-only");
});

test("ops merge-receipts reads --include-reconciled under the host's camelCase key", async () => {
  const ext = await harness();
  const withFlag = await runCmd<MergeReceiptsResult>(ext, "ops merge-receipts", {
    repos: [conflictingMergeLab.path],
    warnOnly: true,
    includeReconciled: true,
  });
  const withoutFlag = await runCmd<MergeReceiptsResult>(ext, "ops merge-receipts", {
    repos: [conflictingMergeLab.path],
    warnOnly: true,
  });
  assert.ok(
    withFlag.repos[0].receipts.length >= withoutFlag.repos[0].receipts.length,
    "camelCase includeReconciled must widen (never narrow) the receipt set",
  );
});

// ---------------------------------------------------------------------------
// Regression: a repo with NO pm tracker must not fail the merge-safety gate.
//
// The fence audit used to assume the `.agents/pm` fleet layout, so a git repo
// with no pm workspace — or a tracker at `.pm` — reported `not_installed` and
// counted toward `missing_fence`, failing the gate over a repo that has nothing
// for the driver to protect.
// ---------------------------------------------------------------------------

test("ops merge-receipts does not count a repo without a pm tracker as a missing fence", async () => {
  const bare = join(tmpRoot, "pm-no-tracker");
  mkdirSync(bare, { recursive: true });
  const init = spawnSync("git", ["init", "-q"], { cwd: bare, encoding: "utf-8", timeout: 30_000 });
  assert.strictEqual(init.status, 0, `git init failed: ${init.stderr}`);

  const ext = await harness();
  const result = await runCmd<MergeReceiptsResult>(ext, "ops merge-receipts", { repos: [bare] });
  assert.strictEqual(result.summary.missing_fence, 0, "a repo with no pm workspace has no fence to be missing");
  assert.strictEqual(result.summary.total_pending, 0);
  assert.strictEqual(result.summary.missing_driver, 0, "a repo with no pm workspace has no driver obligation either");
  assert.strictEqual(result.repos[0].fence, null, "fence must be null (not-applicable), not a not_installed verdict");
  assert.strictEqual(result.repos[0].driver, null, "driver must be null (not-applicable) for a repo with no tracker");
  const markdown = await runCmd<RenderedResult>(ext, "ops merge-receipts", { repos: [bare], format: "markdown" });
  assert.match(markdown.output, /\| pm-no-tracker \| yes \| - \| - \|/);

  const missing = join(tmpRoot, "pm-merge-unavailable");
  const unavailable = await runCmd<RenderedResult>(ext, "ops merge-receipts", { repos: [missing], format: "markdown" });
  assert.match(unavailable.output, /\| pm-merge-unavailable \| no \| - \| - \|/);
  const metrics = await runCmd<RenderedResult>(ext, "ops metrics", { repos: [bare] });
  assert.match(metrics.output, /pm_merge_driver_installed\{repo="pm-no-tracker"\} 0/);
  assert.match(metrics.output, /pm_merge_fence_installed\{repo="pm-no-tracker"\} 0/);
});

test("ops merge-receipts discovers a tracker rooted at .pm, not just .agents/pm", async () => {
  const alt = buildMergeReceiptLab(tmpRoot, "pm-alt-root", false, ".pm");
  const ext = await harness();
  const result = await runCmd<MergeReceiptsResult>(ext, "ops merge-receipts", { repos: [alt.path] });
  assert.strictEqual(result.repos[0].fence?.status, "ok", "a .pm tracker's committed fence must be audited, not reported missing");
  assert.strictEqual(result.summary.missing_fence, 0);
});

// ---------------------------------------------------------------------------
// Regression: two defects Greptile's review found by running the real CLI.
//
// 1. Tracker discovery probed only the supplied path, so `--repos <subdir>` (a
//    path BELOW the git root) found no tracker, reported driver/fence as
//    not-applicable and exited 0 — a false NEGATIVE that silently disabled the
//    gate. Discovery now probes the git root too.
// 2. The summary counted only `missing`/`not_installed`, so a DRIFTED
//    configuration passed the gate. Driver drift is reported but deliberately not
//    gated (it is the upstream unbraind/pm-cli#773 false positive), while a fence
//    whose drift leaves item paths UNCOVERED does fail — those paths fall back to
//    git's line-based merge, the exact loss the driver prevents.
// ---------------------------------------------------------------------------

test("ops merge-receipts audits the enclosing repo when --repos points below the git root", async () => {
  const nested = join(conflictingMergeLab.path, "nested", "deeper");
  mkdirSync(nested, { recursive: true });
  const ext = await harness();
  const result = await runCmd<MergeReceiptsResult>(ext, "ops merge-receipts", { repos: [nested], warnOnly: true });
  const repo = result.repos[0];
  assert.strictEqual(result.summary.total_pending, 1, "a subdirectory must still surface the repository's pending receipt");
  assert.strictEqual(repo.driver?.status, "ok", "the driver audit must run, not report not-applicable");
  assert.strictEqual(repo.fence?.status, "ok", "the fence audit must run against the repo's tracker");
});

test("ops merge-receipts reports driver drift without failing the gate (upstream #773)", async () => {
  const drifted = buildMergeReceiptLab(tmpRoot, "pm-driver-drift", false);
  const set = spawnSync(
    "git",
    ["config", "merge.pm-item-toon.driver", "not-the-installed-cli merge driver item %O %A %B --item-path %P"],
    { cwd: drifted.path, encoding: "utf-8", timeout: 30_000 },
  );
  assert.strictEqual(set.status, 0, `git config failed: ${set.stderr}`);

  const ext = await harness();
  const result = await runCmd<MergeReceiptsResult>(ext, "ops merge-receipts", { repos: [drifted.path] });
  assert.strictEqual(result.repos[0].driver?.status, "drift", "the drift must be detected and reported");
  assert.strictEqual(result.summary.drifted_driver, 1, "drift is surfaced in its own counter");
  assert.strictEqual(result.summary.missing_driver, 0, "drift is not conflated with a missing driver");
  // Reaching a resolved result without --warn-only proves the gate did not fail:
  // repairing this 'drift' loops (see unbraind/pm-cli#773), so it must not gate.
  assert.ok(result.summary.total >= 1);
});

test("ops merge-receipts fails the gate when fence drift leaves item paths uncovered", async () => {
  const uncovered = buildMergeReceiptLab(tmpRoot, "pm-fence-uncovered", false);
  const attrs = join(uncovered.path, ".gitattributes");
  const kept = readFileSync(attrs, "utf-8").split("\n").filter((line) => !line.includes("/tasks/"));
  writeFileSync(attrs, `${kept.join("\n")}\n`, "utf-8");

  const ext = await harness();
  const reported = await runCmd<MergeReceiptsResult>(ext, "ops merge-receipts", { repos: [uncovered.path], warnOnly: true });
  assert.strictEqual(reported.repos[0].fence?.status, "drift");
  assert.ok(
    (reported.repos[0].fence?.missing_patterns.length ?? 0) > 0,
    "dropping the tasks coverage must surface missing fence patterns",
  );
  assert.strictEqual(reported.summary.unprotected_fence, 1, "uncovered item paths are counted separately from stale drift");

  await assert.rejects(
    () => runCmd<MergeReceiptsResult>(ext, "ops merge-receipts", { repos: [uncovered.path] }),
    /uncovered/i,
    "a fence leaving item paths uncovered must fail the gate",
  );
});

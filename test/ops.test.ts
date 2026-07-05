import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";

import extension from "../dist/index.js";

// Optional real-fleet paths for local real-data testing. Configurable via the
// PM_OPS_TEST_REPOS env var (comma-separated). The fixture tests above cover
// CI; these real-data tests only run when the repos are present. No absolute
// host paths are hardcoded so the suite is fully portable.
const ENV_REPOS = (process.env.PM_OPS_TEST_REPOS ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const REAL_REPOS = ENV_REPOS.length > 0 ? ENV_REPOS : [];
const REAL_REPOS_AVAILABLE = REAL_REPOS.length > 0 && REAL_REPOS.every((p) => existsSync(join(p, "package.json")));
const PM_TS_STARTER = REAL_REPOS.find((p) => basename(p) === "pm-ts-starter") ?? REAL_REPOS[0] ?? "";

interface CapturedCommand {
  name: string;
  run: (ctx: any) => Promise<unknown> | unknown;
  flags: any[];
}

function activateAndCapture(): { commands: Map<string, CapturedCommand>; renderers: Map<string, (ctx: any) => string | null> } {
  const commands = new Map<string, CapturedCommand>();
  const renderers = new Map<string, (ctx: any) => string | null>();
  const api = {
    registerCommand: (def: any) => { commands.set(def.name, { name: def.name, run: def.run, flags: def.flags ?? [] }); },
    registerRenderer: (format: string, fn: (ctx: any) => string | null) => { renderers.set(format, fn); },
    registerParser: () => {}, registerPreflight: () => {}, registerService: () => {}, registerFlags: () => {},
    registerItemFields: () => {}, registerItemTypes: () => {}, registerMigration: () => {},
    registerImporter: () => {}, registerExporter: () => {},
    registerSearchProvider: () => {}, registerVectorStoreAdapter: () => {},
    hooks: { beforeCommand: () => {}, afterCommand: () => {}, onWrite: () => {}, onRead: () => {}, onIndex: () => {} },
  };
  (extension as any).activate(api);
  return { commands, renderers };
}

async function runCommand(commands: Map<string, CapturedCommand>, name: string, options: Record<string, unknown> = {}): Promise<unknown> {
  const cmd = commands.get(name);
  assert.ok(cmd, `command ${name} should be registered`);
  return Promise.resolve(cmd.run({ args: [], options, global: {}, pm_root: process.cwd() }));
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
  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" } }, null, 2) + "\n");
  writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## 2026.7.5\n\n- fixture\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Daily Release\non: [schedule]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
  const pmInit = spawnSync("pm", ["init", "fixture", "--pm-path", join(repo, ".agents", "pm")], { encoding: "utf-8" });
  if (pmInit.status !== 0) {
    throw new Error(`pm init fixture failed: ${pmInit.stderr}`);
  }
  const pmCreate = spawnSync("pm", ["create", "--title", "Fixture task", "--type", "Task", "--pm-path", join(repo, ".agents", "pm")], { encoding: "utf-8" });
  if (pmCreate.status !== 0) {
    throw new Error(`pm create failed: ${pmCreate.stderr}`);
  }
  return repo;
}

let tmpRoot: string;
let fixtureRepo: string;

before(() => {
  process.env.PM_OPS_OFFLINE = "1";
  tmpRoot = mkdtempSync(join(tmpdir(), "pm-ops-test-"));
  fixtureRepo = buildFixture(tmpRoot);
});

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object");
  assert.ok("name" in extension);
  assert.ok("activate" in extension);
  assert.strictEqual(typeof (extension as any).activate, "function");
  assert.strictEqual((extension as any).name, "pm-ops");
  assert.match((extension as any).version, /^2026\./, "extension version should be a calendar version");
});

test("registers the four ops commands and renderers", () => {
  const { commands, renderers } = activateAndCapture();
  for (const name of ["ops scan", "ops policy", "ops verify-release", "ops report"]) {
    assert.ok(commands.has(name), `should register ${name}`);
  }
  assert.ok(renderers.has("toon"), "should register a toon renderer");
  assert.ok(renderers.has("json"), "should register a json renderer");
});

test("ops scan produces a structured readiness snapshot for the fixture", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops scan", { repos: [fixtureRepo] })) as any;
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
});

test("ops scan --format markdown emits a well-formed table", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops scan", { repos: [fixtureRepo], format: "markdown" })) as any;
  assert.ok(result?.pmOpsRendered === true, "markdown result should be a rendered marker");
  for (const line of (result.output as string).split("\n")) {
    if (line.startsWith("|") && line.includes("---")) continue;
    if (line.startsWith("| repo |")) continue;
    if (line.startsWith("| pm-fixture |")) {
      assert.ok(line.endsWith("|"), "data row should be wrapped in pipes");
    }
  }
  assert.match(result.output, /\| pm-fixture \|/);
});

test("ops policy: naming passes for a valid pm-* repo and fails for pm-ext-foo", async () => {
  const { commands } = activateAndCapture();
  const fakeDir = join(tmpRoot, "pm-ext-foo");
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(join(fakeDir, "package.json"), JSON.stringify({
    name: "pm-ext-foo", version: "0.0.1",
    scripts: { typecheck: "true", test: "true", build: "true", "release:check": "true", changelog: "true", "changelog:check": "true" },
    devDependencies: { "pm-changelog": "1.0.0" },
  }) + "\n");
  const result = (await runCommand(commands, "ops policy", { repos: [fixtureRepo, fakeDir] })) as any;
  assert.ok(Array.isArray(result.repos));
  const fixturePolicy = result.repos.find((r: any) => r.name === "pm-fixture");
  assert.ok(fixturePolicy, "fixture policy result should exist");
  const naming = fixturePolicy.checks.find((c: any) => c.id === "naming");
  assert.strictEqual(naming.pass, true, "pm-fixture naming should pass");

  const fakePolicy = result.repos.find((r: any) => r.path === fakeDir);
  assert.ok(fakePolicy, "fake dir policy result should exist");
  const fakeNaming = fakePolicy.checks.find((c: any) => c.id === "naming");
  assert.strictEqual(fakeNaming.pass, false, "pm-ext-foo naming should fail");
  assert.match(fakeNaming.message, /pm-ext-/);
  assert.ok(result.summary.by_severity.error >= 1, "should record at least one error-severity failure");
});

test("ops policy --strict exits non-zero on failures", async () => {
  const { commands } = activateAndCapture();
  const badDir = join(tmpRoot, "pm-bad");
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, "package.json"), JSON.stringify({ name: "pm-bad", version: "0.0.1" }) + "\n");
  await assert.rejects(
    runCommand(commands, "ops policy", { repos: [badDir], strict: true }),
    /strict mode|check\(s\) failed/,
    "strict mode should throw on failures",
  );
});

test("ops policy --strict --output still throws (exit-code gating not bypassed)", async () => {
  const { commands } = activateAndCapture();
  const badDir = join(tmpRoot, "pm-strict-output");
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, "package.json"), JSON.stringify({ name: "pm-bad-no-scripts", version: "0.0.1" }) + "\n");
  const outFile = join(tmpRoot, "strict-policy-report.json");
  // --output must NOT bypass the strict-mode throw: CI relies on the exit code.
  await assert.rejects(
    runCommand(commands, "ops policy", { repos: [badDir], strict: true, output: outFile, format: "json" }),
    /strict mode|check\(s\) failed/,
    "strict mode must throw even when --output is set",
  );
  // The report file should still have been written so the failures are visible.
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(outFile, "utf-8");
  const parsed = JSON.parse(body);
  assert.ok(Array.isArray(parsed.repos), "output file should contain the serialized JSON policy result");
});

test("ops scan detects strict:true inherited via a relative tsconfig extends chain", async () => {
  const { commands } = activateAndCapture();
  const baseDir = join(tmpRoot, "ts-base");
  const repoDir = join(tmpRoot, "pm-extends");
  mkdirSync(baseDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(baseDir, "base.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" } }, null, 2) + "\n");
  writeFileSync(join(repoDir, "tsconfig.json"), JSON.stringify({ extends: "../ts-base/base.json", compilerOptions: { module: "NodeNext" } }, null, 2) + "\n");
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "pm-extends", version: "0.0.1" }, null, 2) + "\n");
  const result = (await runCommand(commands, "ops scan", { repos: [repoDir] })) as any;
  const repo = result.repos[0];
  assert.strictEqual(repo.strict_ts, true, "strict:true inherited via relative extends should be detected");
});

test("ops verify-release runs the release gate matrix on the fixture", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops verify-release", { repos: [fixtureRepo] })) as any;
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
});

test("ops report --format markdown combines scan + policy into a table", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops report", { repos: [fixtureRepo], format: "markdown" })) as any;
  assert.ok(result?.pmOpsRendered === true, "report markdown should be a rendered marker");
  assert.match(result.output, /pm-ops scan/);
  assert.match(result.output, /pm-ops policy/);
  assert.match(result.output, /\| repo \|/);
  assert.match(result.output, /\| pm-fixture \|/);
});

test("ops report --output writes to a file and returns a summary", async () => {
  const { commands } = activateAndCapture();
  const outFile = join(tmpRoot, "fleet-report.md");
  const result = (await runCommand(commands, "ops report", { repos: [fixtureRepo], format: "markdown", output: outFile })) as any;
  assert.ok(result?.written_to, "should return a written_to summary");
  assert.strictEqual(result.written_to, outFile);
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(outFile, "utf-8");
  assert.match(body, /pm-ops scan/);
  assert.match(body, /pm-ops policy/);
});

// ---------------------------------------------------------------------------
// Real-data tests against a live pm fleet. These run only when the
// PM_OPS_TEST_REPOS env var points at real repos that are present (e.g. local
// dev); they skip on CI where those repos do not exist. The fixture tests
// above cover CI. Set e.g. PM_OPS_TEST_REPOS=/path/to/pm-csv,/path/to/pm-ts-starter
// ---------------------------------------------------------------------------

test("real-data: scan on the configured fleet reports all ready", { skip: !REAL_REPOS_AVAILABLE }, async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops scan", { repos: REAL_REPOS })) as any;
  assert.strictEqual(result.repos.length, REAL_REPOS.length);
  for (const repo of result.repos) {
    assert.strictEqual(repo.strict_ts, true, `${repo.name} should have strict TS`);
    assert.strictEqual(repo.has_release_workflow, true, `${repo.name} should have a release workflow`);
    assert.strictEqual(repo.has_pm_changelog, true, `${repo.name} should have pm-changelog wired`);
    assert.strictEqual(repo.ready, true, `${repo.name} should be ready`);
  }
});

test("real-data: verify-release on the configured starter repo passes", { skip: !REAL_REPOS_AVAILABLE || !PM_TS_STARTER }, async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops verify-release", { repos: [PM_TS_STARTER] })) as any;
  assert.strictEqual(result.repos.length, 1);
  assert.strictEqual(result.repos[0].failed, 0, `${PM_TS_STARTER} release:check should pass`);
  assert.strictEqual(result.summary.failed, 0);
});

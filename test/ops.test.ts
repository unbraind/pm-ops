import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension from "../dist/index.js";

const PM_CSV = "/home/steve/container/pm-csv";
const PM_TS_STARTER = "/home/steve/container/pm-ts-starter";

const REAL_REPOS = [PM_CSV, PM_TS_STARTER];

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

before(() => {
  process.env.PM_OPS_OFFLINE = "1";
});

let tmpRoot: string;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pm-ops-test-"));
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
});

test("registers the four ops commands and renderers", () => {
  const { commands, renderers } = activateAndCapture();
  for (const name of ["ops scan", "ops policy", "ops verify-release", "ops report"]) {
    assert.ok(commands.has(name), `should register ${name}`);
  }
  assert.ok(renderers.has("toon"), "should register a toon renderer");
  assert.ok(renderers.has("json"), "should register a json renderer");
});

test("ops scan produces a structured readiness snapshot for real repos", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops scan", { repos: REAL_REPOS })) as any;
  assert.ok(result, "scan should return a result");
  assert.ok(Array.isArray(result.repos), "result.repos should be an array");
  assert.strictEqual(result.repos.length, 2, "should scan both repos");
  assert.strictEqual(result.summary.total, 2);
  assert.strictEqual(result.summary.ready + result.summary.not_ready, 2);

  const csv = result.repos.find((r: any) => r.name === "pm-csv");
  assert.ok(csv, "pm-csv should be in the scan");
  assert.strictEqual(csv.name, "pm-csv");
  assert.strictEqual(csv.strict_ts, true, "pm-csv should have strict TS");
  assert.strictEqual(csv.has_changelog, true, "pm-csv should have a changelog");
  assert.strictEqual(csv.has_release_workflow, true, "pm-csv should have a release workflow");
  assert.strictEqual(csv.has_ci, true, "pm-csv should have CI");
  assert.strictEqual(csv.has_pm_changelog, true, "pm-csv should wire pm-changelog");
  assert.strictEqual(csv.pm_workspace, true, "pm-csv should have a pm workspace");
  assert.strictEqual(csv.ready, true, "pm-csv should be ready");
});

test("ops scan --format markdown emits a table", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops scan", { repos: REAL_REPOS, format: "markdown" })) as any;
  assert.ok(result?.pmOpsRendered === true, "markdown result should be a rendered marker");
  assert.match(result.output, /\| repo \||---/);
  assert.match(result.output, /pm-csv/);
});

test("ops policy: naming passes for pm-csv and fails for a fake pm-ext-foo dir", async () => {
  const { commands } = activateAndCapture();
  const fakeDir = join(tmpRoot, "pm-ext-foo");
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(join(fakeDir, "package.json"), JSON.stringify({ name: "pm-ext-foo", version: "0.0.1", scripts: { typecheck: "tsc", test: "node --test", build: "tsc", "release:check": "true", changelog: "true", "changelog:check": "true" }, devDependencies: { "pm-changelog": "1.0.0" } }) + "\n");

  const result = (await runCommand(commands, "ops policy", { repos: [PM_CSV, fakeDir] })) as any;
  assert.ok(Array.isArray(result.repos));
  const csvPolicy = result.repos.find((r: any) => r.name === "pm-csv");
  assert.ok(csvPolicy, "pm-csv policy result should exist");
  const naming = csvPolicy.checks.find((c: any) => c.id === "naming");
  assert.ok(naming, "naming check should run");
  assert.strictEqual(naming.pass, true, "pm-csv naming should pass");

  const fakePolicy = result.repos.find((r: any) => r.path === fakeDir);
  assert.ok(fakePolicy, "fake dir policy result should exist");
  const fakeNaming = fakePolicy.checks.find((c: any) => c.id === "naming");
  assert.ok(fakeNaming, "naming check should run on fake dir");
  assert.strictEqual(fakeNaming.pass, false, "pm-ext-foo naming should fail");
  assert.match(fakeNaming.message, /pm-ext-/);

  assert.ok(result.summary.by_severity.error >= 1, "should record at least one error-severity failure");
});

test("ops policy --strict exits non-zero on failures", async () => {
  const { commands } = activateAndCapture();
  const fakeDir = join(tmpRoot, "pm-bad");
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(join(fakeDir, "package.json"), JSON.stringify({ name: "pm-bad", version: "0.0.1" }) + "\n");
  await assert.rejects(
    runCommand(commands, "ops policy", { repos: [fakeDir], strict: true }),
    /strict mode|check\(s\) failed/,
    "strict mode should throw on failures",
  );
});

test("ops verify-release runs the release gate matrix on a real repo", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops verify-release", { repos: [PM_TS_STARTER] })) as any;
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
  assert.strictEqual(repo.failed, 0, "pm-ts-starter release:check should pass");
  assert.strictEqual(result.summary.passed, 1);
  assert.strictEqual(result.summary.failed, 0);
});

test("ops report --format markdown combines scan + policy into a table", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops report", { repos: REAL_REPOS, format: "markdown" })) as any;
  assert.ok(result?.pmOpsRendered === true, "report markdown should be a rendered marker");
  assert.match(result.output, /pm-ops scan/);
  assert.match(result.output, /pm-ops policy/);
  assert.match(result.output, /\| repo \|/);
  assert.match(result.output, /pm-csv/);
});

test("ops report --output writes to a file and returns a summary", async () => {
  const { commands } = activateAndCapture();
  const outFile = join(tmpRoot, "fleet-report.md");
  const result = (await runCommand(commands, "ops report", { repos: REAL_REPOS, format: "markdown", output: outFile })) as any;
  assert.ok(result?.written_to, "should return a written_to summary");
  assert.strictEqual(result.written_to, outFile);
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(outFile, "utf-8");
  assert.match(body, /pm-ops scan/);
  assert.match(body, /pm-ops policy/);
});

/** Bootstrap exact source tools without relying on publication of their declared package version. */
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "../subprocess.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureReleaseRuntime, installReleaseTools, workflowToolsRoot } from "../scripts/release-runtime.ts";
import { runReleaseContinuation } from "../scripts/release-continuation.ts";

/** A source checkout whose intentionally unpublished version must never be requested from npm. */
function sourceFixture(root: string, name = "pm-ops", version = "9999.1.1"): string {
  const source = join(root, "source"); mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({ name, version, type: "module" }));
  symlinkSync(join(workflowToolsRoot, "node_modules"), join(source, "node_modules"), "junction");
  symlinkSync(join(workflowToolsRoot, "dist"), join(source, "dist"), "junction");
  return source;
}

test("unpublished trusted source version bootstraps from exact committed planner bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "release-source-tools-"));
  const keys = ["RUNNER_TEMP", "PM_OPS_VERSION", "RELEASE_TOOLS_ROOT", "GITHUB_ENV", "PATH"];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" > "$PWD/unpublished-lookup"\nexit 7\n'); chmodSync(join(bin, "npm"), 0o755);
    process.env.PATH = bin + ":" + process.env.PATH;
    const source = sourceFixture(root);
    const module = installReleaseTools(source, join(root, "prefix"), "9999.1.1");
    assert.equal(existsSync(join(source, "unpublished-lookup")), false);
    assert.equal(readFileSync(module, "utf8"), readFileSync(join(workflowToolsRoot, "dist/daily-release.js"), "utf8"));
    assert.throws(() => installReleaseTools(source, join(root, "wrong"), "9999.1.2"), /identity/);
    writeFileSync(join(source, "package.json"), '{"name":"foreign","version":"9999.1.1","type":"module"}');
    assert.throws(() => installReleaseTools(source, join(root, "foreign"), "9999.1.1"), /identity/);
    writeFileSync(join(source, "package.json"), '{"name":"pm-ops","version":"9999.1.1","type":"module"}');
    Object.assign(process.env, { RUNNER_TEMP: root, PM_OPS_VERSION: "9999.1.1", RELEASE_TOOLS_ROOT: source, GITHUB_ENV: join(root, "env") });
    await runReleaseContinuation("tools");
    assert.match(readFileSync(join(root, "env"), "utf8"), /PM_OPS_MODULE=.*daily-release.js\nPM_OPS_TOOLS=/);
    delete process.env.RELEASE_TOOLS_ROOT; process.env.PM_OPS_VERSION = JSON.parse(readFileSync(join(workflowToolsRoot, "package.json"), "utf8")).version;
    await runReleaseContinuation("tools");
    const incompatible = join(root, "incompatible"); mkdirSync(join(incompatible, "dist"), { recursive: true });
    writeFileSync(join(incompatible, "package.json"), '{"name":"pm-ops","version":"9999.1.1","type":"module"}');
    writeFileSync(join(incompatible, "dist/daily-release.js"), 'export const decideDailyRelease = 1;\n');
    symlinkSync(join(workflowToolsRoot, "node_modules"), join(incompatible, "node_modules"), "junction");
    assert.throws(() => installReleaseTools(incompatible, join(root, "bad"), "9999.1.1"), /incompatible/);
    const uninstalled = join(root, "uninstalled"); mkdirSync(join(uninstalled, "dist"), { recursive: true });
    writeFileSync(join(uninstalled, "package.json"), '{"name":"pm-ops","version":"9999.1.1","type":"module"}');
    cpSync(join(workflowToolsRoot, "dist/daily-release.js"), join(uninstalled, "dist/daily-release.js"));
    assert.throws(() => installReleaseTools(uninstalled, join(root, "missing"), "9999.1.1"), /Command failed/);
    assert.match(readFileSync(join(uninstalled, "unpublished-lookup"), "utf8"), /^ci --omit=dev --ignore-scripts/);
  } finally {
    for (const key of keys) { const prior = saved.get(key); if (prior === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = prior; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime installs only locked production dependencies without lifecycle scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "release-runtime-")); const savedPath = process.env.PATH;
  try {
    let calls = 0;
    const privateRoot = join(root, ".github/release-runtime"); mkdirSync(privateRoot, { recursive: true });
    ensureReleaseRuntime(root, (args, cwd) => { calls++; assert.equal(cwd, privateRoot); assert.deepEqual(args, ["ci", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"]); });
    assert.equal(calls, 1);
    ensureReleaseRuntime();
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" > "$PWD/install-args"\n'); chmodSync(join(bin, "npm"), 0o755);
    process.env.PATH = bin + ":" + savedPath;
    ensureReleaseRuntime(root);
    assert.match(readFileSync(join(privateRoot, "install-args"), "utf8"), /^ci --omit=dev --ignore-scripts/);
    assert.doesNotMatch(readFileSync(join(privateRoot, "install-args"), "utf8"), /pm-ops@/);
    mkdirSync(join(privateRoot, "node_modules/sigstore"), { recursive: true }); writeFileSync(join(privateRoot, "node_modules/sigstore/package.json"), "{}");
    ensureReleaseRuntime(root, () => { throw new Error("already installed"); });
    assert.equal(existsSync(join(root, "node_modules")), false);
  } finally { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; rmSync(root, { recursive: true, force: true }); }
});

test("an empty native probe works with no installed runtime dependencies and never invokes npm", () => {
  const root = mkdtempSync(join(tmpdir(), "release-empty-source-"));
  try {
    mkdirSync(join(root, "scripts"));
    for (const path of ["release-continuation.ts", "release-provenance.ts", "subprocess.ts", "scripts/release-continuation.ts", "scripts/release-runtime.ts", "scripts/main-invocation.ts"]) {
      cpSync(new URL("../" + path, import.meta.url), join(root, path));
    }
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "read-only-fixture.mjs"), 'globalThis.fetch = async () => new Response("[]");\n');
    writeFileSync(join(root, "npm"), '#!/bin/sh\necho unexpected > "$PWD/npm-invoked"\nexit 7\n'); chmodSync(join(root, "npm"), 0o755);
    const result = spawnSync(process.execPath, ["--import", join(root, "read-only-fixture.mjs"), join(root, "scripts/release-continuation.ts"), "probe"], { cwd: root, encoding: "utf8", timeout: 30_000, env: {
      PATH: root + ":" + process.env.PATH, GITHUB_REPOSITORY: "example/package", GH_TOKEN: "synthetic-token", RELEASE_CONFIG: "{}",
      CALLER_WORKFLOW: "example/package/.github/workflows/release.yml@refs/heads/main", RUNNER_TEMP: root, GITHUB_OUTPUT: join(root, "output"),
      TRIGGER_SHA: "a".repeat(40), RELEASE_TIMEZONE: "UTC",
    } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, "output"), "utf8"), "pending=false\n");
    assert.equal(existsSync(join(root, "npm-invoked")), false);
    assert.equal(existsSync(join(root, "node_modules")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Behavioral input-boundary regressions; never leave a blocking read in the test process. */
import assert from "node:assert/strict";
import test from "node:test";
import fs, { mkdtempSync, writeFileSync, rmSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readRegularInput, readRegularText, InputRefusal } from "../regular-input.ts";
import { createDiagnosticPlan, executeDiagnosticPlan } from "../diagnostic-plans.ts";
import { readGithubRelease } from "../release-completeness.ts";

/** Run isolated real input consumers without Git or a possibility of hanging the parent. */
function refuseInChild(root: string, path: string): void {
  const module = (file: string) => JSON.stringify(new URL(`../${file}.ts`, import.meta.url).href);
  const script = `import assert from 'node:assert/strict';
    import {readDiagnosticPlan} from ${module("diagnostic-plans")};
    import {auditBackendConfigFile} from ${module("backend-capabilities")};
    import {auditEvidenceExpiryFiles} from ${module("evidence-expiry")};
    import extension from ${module("index")};
    import {createExtensionTestHarness} from ${JSON.stringify(import.meta.resolve("@unbrained/pm-cli/sdk/testing"))};
    import {qualityMeasurementProvider} from ${module("assurance")};
    import {runReleaseCaller} from ${module("scripts/release-caller")};
    import {readRegularInput} from ${module("regular-input")};
    const path=process.argv[1];
    for (const [read,code] of [[()=>readDiagnosticPlan(path),'invalid_plan'],[()=>auditBackendConfigFile(path),'invalid_backend_config'],[()=>auditEvidenceExpiryFiles('.',path,path),'invalid_policy'],[()=>auditEvidenceExpiryFiles('.',process.argv[2],path),'invalid_versions']]) {
      await assert.rejects(read(),e=>e.code===code && /regular/.test(e.remedy));
    }
    assert.throws(()=>readRegularInput(path),e=>e.code==='invalid_input' && /regular/.test(e.remedy));
    assert.throws(()=>runReleaseCaller(path,()=>{}),e=>e.code==='invalid_input');
    assert.throws(()=>qualityMeasurementProvider.resolve({provider:'pm-ops-quality',key:'coverage-percent',parameters:{dimension:'lines',report:path},trigger:'ci',pm_root:process.cwd()+'/.agents/pm',repo_root:process.cwd()}),e=>e.code==='invalid_input');
    const harness=await createExtensionTestHarness(extension,{name:'pm-ops',capabilities:['commands','renderers','schema','parser','services']});
    try { await assert.rejects(harness.runCommand({command:'ops policy',pmRoot:process.cwd()+'/.agents/pm',options:{policy:path,repos:process.cwd()}}),e=>e.code==='invalid_input'); }
    finally {await harness.deactivate();}
    console.log('8 typed refusals');`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, path, join(root, "policy.json")], {
    cwd: root, timeout: 5000, killSignal: "SIGKILL", encoding: "utf8",
    env: { ...process.env, PATH: "", GIT_CEILING_DIRECTORIES: dirname(root) },
  });
  assert.equal(result.error, undefined, "input reader exceeded the external subprocess timeout");
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /8 typed refusals/);
}

test("all artifact readers refuse a writerless FIFO, socket, device, directory and over-limit input within a subprocess timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-input-"));
  const socket = createServer();
  try {
    const init = spawnSync(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "init", "--defaults", "--agent-guidance", "skip", "--prefix", "bounded"], {
      cwd: root, encoding: "utf8", env: { ...process.env, PM_PATH: join(root, ".agents/pm"), GIT_CEILING_DIRECTORIES: dirname(root) },
    });
    assert.equal(init.status, 0, init.stderr);
    writeFileSync(join(root, "policy.json"), JSON.stringify({ version: 1, claims: [{ id: "health", kind: "health", receipt: { gate_id: "gate", assertion_id: "health", tree_id: "tree", evaluated_at: "2026-10-24T00:00:00.000Z" }, scope: { kind: "all" }, max_age_seconds: 1, versions: { package: "1" } }] }));
    if (process.platform !== "win32") {
      const fifo = join(root, "plan.fifo"); assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
      refuseInChild(root, fifo);
      for (const path of ["/dev/null", "/dev/zero"]) refuseInChild(root, path);
      const path = join(root, "plan.sock");
      await new Promise<void>((done) => { socket.listen(path, done); }); refuseInChild(root, path);
    }
    refuseInChild(root, root);
    const big = join(root, "big.json"); writeFileSync(big, " ".repeat(16 * 1024 * 1024 + 1)); refuseInChild(root, big);
  } finally { if (socket.listening) await new Promise<void>((done, reject) => { socket.close((error) => error ? reject(error) : done()); }); rmSync(root, { recursive: true, force: true }); }
});

test("regular reads retain valid empty/text input and refuse missing input without echoing its path", () => {
  const root = mkdtempSync(join(tmpdir(), "regular-input-"));
  try {
    const path = join(root, "text"); writeFileSync(path, "hello");
    assert.equal(readRegularText(path, 5), "hello");
    assert.throws(() => readRegularInput(path, 4), InputRefusal);
    writeFileSync(path, ""); assert.equal(readRegularText(path), "");
    assert.throws(() => readRegularText(join(root, "missing")), (error: unknown) => error instanceof InputRefusal && error.reason === "unreadable" && !error.message.includes(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("descriptor validation refuses a swapped special file, larger file, device or inode before reading and always closes", (t) => {
  let closes = 0;
  t.mock.method(fs, "statSync", () => ({ isFile: () => true, size: 1, dev: 1, ino: 1 }));
  t.mock.method(fs, "openSync", (_path: string, flags: number) => { assert.equal(flags & constants.O_NONBLOCK, constants.O_NONBLOCK); return 123; });
  t.mock.method(fs, "closeSync", () => { closes++; });
  t.mock.method(fs, "readSync", () => { assert.fail("unsafe descriptor must not be read"); });
  try {
    for (const opened of [{ size: 1, dev: 1, ino: 1, isFile: () => false }, { size: 3, dev: 1, ino: 1, isFile: () => true }, { size: 1, dev: 2, ino: 1, isFile: () => true }, { size: 1, dev: 1, ino: 2, isFile: () => true }]) {
      t.mock.method(fs, "fstatSync", () => opened); syncBuiltinESMExports();
      assert.throws(() => readRegularInput("synthetic", 2), InputRefusal);
    }
    assert.equal(closes, 4);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("bounded descriptor reads detect file growth and tolerate short reads", (t) => {
  let remaining = 0; let reads = 0;
  t.mock.method(fs, "statSync", () => ({ isFile: () => true, size: 2, dev: 1, ino: 1 }));
  t.mock.method(fs, "fstatSync", fs.statSync);
  t.mock.method(fs, "openSync", () => 123); t.mock.method(fs, "closeSync", () => {});
  t.mock.method(fs, "readSync", (_fd: number, buffer: Buffer, offset: number) => { reads++; if (!remaining) return 0; remaining--; buffer[offset] = 65; return 1; });
  syncBuiltinESMExports();
  try {
    remaining = 2; assert.equal(readRegularText("synthetic"), "AA"); assert.equal(reads, 3);
    remaining = 3; assert.throws(() => readRegularInput("synthetic"), InputRefusal);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("diagnostic input elapsed time exhausts the shared budget before launching a probe", async () => {
  const plan = await createDiagnosticPlan(".", ["schema_unreadable"], { processes: 1, network: 0, time_ms: 1 });
  const run = await executeDiagnosticPlan(".", plan, plan.id, performance.now() - 20);
  assert.equal(run.used.processes, 0); assert.equal(run.rows[0]!.code, "time_budget"); assert.ok(run.used.time_ms >= 20);
});

test("GitHub 404 becomes a typed explained absence and default executor captures handled stderr", () => {
  const result = readGithubRelease(() => { throw new Error("gh: Not Found (HTTP 404)"); }, "example/package", "v2026.10.23");
  assert.equal(result.code, "github_release_absent"); assert.match(result.remedy, /HTTP 404.*verify repository access/);
});

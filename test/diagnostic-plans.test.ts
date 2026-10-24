import assert from "node:assert/strict";
import test, { before, after, type TestContext } from "node:test";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { assertDiagnosticIdentity, fingerprint } from "./tracker-read-helpers.ts";
import fs, { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { decode } from "@toon-format/toon";
import { readLocatedItem, serializeItemDocument } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { createDiagnosticPlan, executeDiagnosticPlan, parseDiagnosticPlan, readDiagnosticPlan, DiagnosticRefusal, DIAGNOSTIC_FAILURES, type DiagnosticBudget, type DiagnosticPlan, type DiagnosticCommand } from "../diagnostic-plans.ts";
import { runDiagnosticProbe as rawProbe } from "../diagnostic-probes.ts";
import extension from "../index.ts";

let root: string;
let tracker: string;
const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
const allLocal = DIAGNOSTIC_FAILURES.slice(0, 3);
const budget: DiagnosticBudget = { processes: 4, network: 1, time_ms: 60000 };

/** Dispose isolated settings even when an internal catalog probe refuses. */
async function runDiagnosticProbe(command: DiagnosticCommand, tracker: string): Promise<number> {
  const scratch = mkdtempSync(join(tmpdir(), "diagnostic-config-test-"));
  try { return await rawProbe(command, tracker, scratch); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
/** Run the pinned host with a non-Git ceiling and an explicit tracker. */
function pm(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, PM_PATH: tracker, PM_AUTHOR: "diagnostic-test", GIT_CEILING_DIRECTORIES: dirname(root) }, encoding: "utf8" });
}
/** Keep spawn mocks confined to process transport; every tracker uses the real SDK. */
function restore(t: TestContext) { t.mock.restoreAll(); syncBuiltinESMExports(); }

before(() => {
  root = mkdtempSync(join(tmpdir(), "diagnostic-plans-"));
  tracker = join(root, ".agents", "pm");
  for (const args of [["init", "--defaults", "--agent-guidance", "skip", "--prefix", "diag"], ["create", "task", "Synthetic private text token=secret-value", "--id", "diag-first"]]) {
    const result = pm(args); assert.equal(result.status, 0, result.stderr);
  }
});
after(() => rmSync(root, { recursive: true, force: true }));

test("plans retain ordered command identity and scope across repeats without running any probes", async (t) => {
  const before = fingerprint(tracker);
  t.mock.method(childProcess, "spawnSync", () => { throw new Error("generation must not execute"); }); syncBuiltinESMExports();
  try {
    const first = await createDiagnosticPlan(tracker, ["history_invalid", "items_unreadable", "schema_unreadable", "items_unreadable"]);
    assert.deepEqual(first, await createDiagnosticPlan(tracker, allLocal));
    assert.deepEqual(first.steps.map((step) => step.command), ["sdk:schema:v1", "sdk:items:v1", "sdk:history:v1"]);
    assert.deepEqual(parseDiagnosticPlan(JSON.parse(JSON.stringify(first))), first);
    assert.deepEqual(parseDiagnosticPlan({ steps: first.steps, budget: first.budget, scope: first.scope, id: first.id, version: 1 }), first);
    assert.ok(!JSON.stringify(first).includes(root));
    assert.equal(fingerprint(tracker), before);
  } finally { restore(t); }
});

test("real SDK reads succeed outside Git, without Git in PATH, and preserve every tracker byte", async () => {
  const before = fingerprint(tracker);
  assert.ok(await runDiagnosticProbe("sdk:schema:v1", tracker) > 0);
  assert.equal(await runDiagnosticProbe("sdk:items:v1", tracker), 1);
  assert.ok(await runDiagnosticProbe("sdk:history:v1", tracker) > 0);
  const plan = await createDiagnosticPlan(tracker, allLocal, budget);
  const first = await executeDiagnosticPlan(tracker, plan, plan.id);
  assert.ok(first.rows.every((row) => row.code === "verified" || row.code === "time_budget"), JSON.stringify(first));
  const second = await executeDiagnosticPlan(tracker, plan, plan.id);
  assertDiagnosticIdentity(first, second);
  assert.ok(first.used.processes <= 3); assert.equal(first.used.network, 0);
  assert.ok(first.used.time_ms > 0);
  assert.equal(first.rows[1]!.checked, first.rows[1]!.code === "verified" ? 1 : 0);
  assert.ok(!JSON.stringify(first).includes("secret-value"));
  assert.equal(fingerprint(tracker), before); assert.equal(existsSync(join(root, ".git")), false);
});

test("all ceilings stop further dispatch and retain skipped command identities", async (t) => {
  const launches: string[][] = [];
  t.mock.method(childProcess, "spawnSync", (_file: string, args: string[], options: { env: Record<string, string>; timeout: number; shell: boolean; maxBuffer: number }) => {
    launches.push(args);
    assert.equal(options.env.PATH, ""); assert.equal(options.shell, false); assert.equal(options.maxBuffer, 4096);
    assert.ok(options.timeout > 0); assert.ok(!("NODE_OPTIONS" in options.env));
    return { status: 0, stdout: '{"checked":17}', stderr: "private data" };
  }); syncBuiltinESMExports();
  try {
    for (const [limits, expected, count] of [
      [{ ...budget, processes: 0 }, "process_budget", 0],
      [{ ...budget, processes: 1 }, "process_budget", 1],
      [{ ...budget, network: 0 }, "network_budget", 3],
      [budget, "verified", 4],
    ] as const) {
      launches.length = 0;
      const plan = await createDiagnosticPlan(tracker, DIAGNOSTIC_FAILURES, limits);
      const run = await executeDiagnosticPlan(tracker, plan, plan.id);
      assert.equal(launches.length, count); assert.equal(run.rows.at(-1)!.code, expected);
      assert.equal(run.rows.length, 4); assert.equal(run.used.processes, count);
      assert.equal(run.used.network, count === 4 ? 1 : 0);
      assert.equal(run.ok, expected === "verified");
      assert.ok(!JSON.stringify(run).includes("private"));
    }
    // Both remaining commands stay skipped after the first exhausted reservation.
    const plan = await createDiagnosticPlan(tracker, DIAGNOSTIC_FAILURES, { ...budget, processes: 1 });
    const run = await executeDiagnosticPlan(tracker, plan, plan.id);
    assert.deepEqual(run.rows.slice(1).map((row) => row.code), ["process_budget", "process_budget", "process_budget"]);
  } finally { restore(t); }
});

test("deadline exhaustion before dispatch, on timeout, and after a slow launch stops every later probe", async (t) => {
  const plan = await createDiagnosticPlan(tracker, allLocal, { ...budget, time_ms: 10 });
  for (const mode of ["before", "timeout", "after"] as const) {
    let ticks = 0; let launches = 0;
    t.mock.method(performance, "now", () => mode === "before" ? ticks++ * 20 : mode === "after" ? ticks++ * 6 : 0);
    t.mock.method(childProcess, "spawnSync", () => { launches++; return mode === "timeout"
      ? { status: null, error: Object.assign(new Error("private timeout"), { code: "ETIMEDOUT" }) }
      : { status: 0, stdout: '{"checked":1}' }; }); syncBuiltinESMExports();
    try {
      const run = await executeDiagnosticPlan(tracker, plan, plan.id);
      assert.equal(launches, mode === "before" ? 0 : 1);
      assert.ok(run.rows.every((row) => row.code === "time_budget"));
    } finally { restore(t); }
  }
});

test("raw child output and failures never leak and invalid transport output never verifies", async (t) => {
  const plan = await createDiagnosticPlan(tracker, ["schema_unreadable"], budget);
  for (const result of [
    new Error("secret-value"),
    { status: 1, stdout: "secret-value", stderr: root },
    { status: null, error: new Error("token=secret-value") },
    { status: 0, stdout: "secret-value" },
    ...[null, {}, { checked: "private" }, { checked: -1 }, { checked: 1.5 }, []].map((value) => ({ status: 0, stdout: JSON.stringify(value) })),
  ]) {
    t.mock.method(childProcess, "spawnSync", () => { if (result instanceof Error) throw result; return result; }); syncBuiltinESMExports();
    try { const run = await executeDiagnosticPlan(tracker, plan, plan.id); assert.equal(run.rows[0]!.code, "probe_failed"); assert.ok(!JSON.stringify(run).includes("secret-value")); }
    finally { restore(t); }
  }
});

test("invalid observations and ceilings refuse before executing or resolving supplied paths", async () => {
  for (const limits of [null, { ...budget, processes: -1 }, { ...budget, processes: 5 }, { ...budget, processes: 0.5 }, { ...budget, network: -1 }, { ...budget, network: 2 }, { ...budget, network: 0.5 }, { ...budget, time_ms: 0 }, { ...budget, time_ms: 60001 }, { ...budget, time_ms: 1.5 }]) {
    await assert.rejects(createDiagnosticPlan("missing", allLocal, limits as DiagnosticBudget), /invalid_options/);
  }
  for (const failures of [null, [], Array(33).fill("schema_unreadable"), ["private-code"]]) {
    await assert.rejects(createDiagnosticPlan("missing", failures as typeof allLocal), /invalid_options/);
  }
  await assert.rejects(createDiagnosticPlan("missing", allLocal), /scope_unavailable/);
});

test("tampered plans, selections and different tracker scopes refuse without dispatch", async (t) => {
  const plan = await createDiagnosticPlan(tracker, allLocal);
  for (const value of [null, {}, { ...plan, version: 2 }, { ...plan, scope: "private" }, { ...plan, id: "0".repeat(64) }, { ...plan, steps: [...plan.steps].reverse() }, { ...plan, steps: [...plan.steps, plan.steps[0]] }, { ...plan, private: "data" }, { ...plan, steps: [{ ...plan.steps[0], command: "shell:unsafe" }] }, { ...plan, steps: [] }, { ...plan, budget: { ...plan.budget, processes: 4 } }]) {
    assert.throws(() => parseDiagnosticPlan(value), DiagnosticRefusal);
  }
  t.mock.method(childProcess, "spawnSync", () => { throw new Error("must not execute"); }); syncBuiltinESMExports();
  try {
    await assert.rejects(executeDiagnosticPlan(tracker, plan, "other"), /selection_required/);
    await assert.rejects(executeDiagnosticPlan(root, plan, plan.id), /scope_mismatch/);
    await assert.rejects(executeDiagnosticPlan("missing", plan, plan.id), /scope_unavailable/);
  } finally { restore(t); }
  const input = join(root, "plan.json"); writeFileSync(input, JSON.stringify(plan));
  assert.deepEqual(await readDiagnosticPlan(input), plan);
  for (const text of ["private", "{}", " ".repeat(16385)]) { writeFileSync(input, text); await assert.rejects(readDiagnosticPlan(input), /invalid_plan/); }
  await assert.rejects(readDiagnosticPlan(join(root, "absent")), /invalid_plan/);
});

test("source probes fail closed on malformed data, links, duplicate identity and broken history", async () => {
  const scratch = join(root, "corrupt"); cpSync(tracker, scratch, { recursive: true });
  const task = join(scratch, "tasks", "diag-first.toon");
  rmSync(join(scratch, "issues"), { recursive: true, force: true });
  const original = readFileSync(task, "utf8");
  const { document } = await readLocatedItem({ id: "diag-first", type: "Task", itemPath: task, item_format: "toon" });
  const markdown = serializeItemDocument(document, { format: "json_markdown" });
  rmSync(task); writeFileSync(join(scratch, "tasks", "diag-first.md"), markdown);
  assert.equal(await runDiagnosticProbe("sdk:items:v1", scratch), 1);
  rmSync(join(scratch, "tasks", "diag-first.md")); writeFileSync(task, original);
  writeFileSync(join(scratch, "tasks", "ignored.txt"), "ignored");
  assert.equal(await runDiagnosticProbe("sdk:items:v1", scratch), 1);
  cpSync(task, join(scratch, "tasks", "duplicate.toon"));
  await assert.rejects(runDiagnosticProbe("sdk:items:v1", scratch), /duplicate_item/);
  rmSync(join(scratch, "tasks", "duplicate.toon"));
  writeFileSync(task, "invalid private content"); await assert.rejects(runDiagnosticProbe("sdk:items:v1", scratch)); writeFileSync(task, original);
  const history = join(scratch, "history", "diag-first.jsonl"); const raw = readFileSync(history, "utf8");
  for (const text of ["", "{}", raw.replace(/"after_hash":"[^"]+"/, '"after_hash":"bad"')]) {
    writeFileSync(history, text); await assert.rejects(runDiagnosticProbe("sdk:history:v1", scratch));
  }
  writeFileSync(history, raw);
  if (process.platform !== "win32") {
    for (const path of [task, join(scratch, "settings.json"), join(scratch, "tasks"), join(scratch, "history")]) {
      renameSync(path, path + ".saved"); symlinkSync(path + ".saved", path);
      try { await assert.rejects(runDiagnosticProbe(path.endsWith("history") ? "sdk:history:v1" : "sdk:items:v1", scratch), /unsafe_scope/); }
      finally { rmSync(path); renameSync(path + ".saved", path); }
    }
  }
  await assert.rejects(runDiagnosticProbe("sdk:items:v1", join(root, "absent")));
  await assert.rejects(runDiagnosticProbe("unknown" as "sdk:schema:v1", scratch), /unknown_command/);
});

test("settings and optional schema diagnostics never scaffold the source or silently accept invalid defaults", async () => {
  const scratch = join(root, "settings-cases"); cpSync(tracker, scratch, { recursive: true });
  const settingsFile = join(scratch, "settings.json");
  const original = readFileSync(settingsFile, "utf8");
  for (const raw of ["{private", "{}", '{"version":"invalid"}']) {
    writeFileSync(settingsFile, raw);
    const before = fingerprint(scratch);
    await assert.rejects(runDiagnosticProbe("sdk:schema:v1", scratch), /settings_invalid/);
    assert.equal(fingerprint(scratch), before);
  }
  writeFileSync(settingsFile, original);
  const types = join(scratch, "schema", "types.json");
  const typesRaw = readFileSync(types, "utf8");
  writeFileSync(types, "{private"); await assert.rejects(runDiagnosticProbe("sdk:schema:v1", scratch), /schema_invalid/);
  rmSync(types); const before = fingerprint(scratch);
  assert.ok(await runDiagnosticProbe("sdk:schema:v1", scratch) > 0); assert.equal(fingerprint(scratch), before);
  writeFileSync(types, typesRaw);
  for (const path of ["/outside.json", "C:\\outside.json", "../outside.json", "schema/./types.json", "schema//types.json"]) {
    const settings = JSON.parse(original); settings.schema.files.types = path; writeFileSync(settingsFile, JSON.stringify(settings));
    await assert.rejects(runDiagnosticProbe("sdk:schema:v1", scratch), /unsafe_scope/);
  }
  writeFileSync(settingsFile, original);
  writeFileSync(types, JSON.stringify({ definitions: [{ name: "Task", folder: "custom/nested" }] }));
  mkdirSync(join(scratch, "custom", "nested"), { recursive: true });
  renameSync(join(scratch, "tasks", "diag-first.toon"), join(scratch, "custom", "nested", "diag-first.toon"));
  assert.equal(await runDiagnosticProbe("sdk:items:v1", scratch), 1);
  if (process.platform !== "win32") {
    renameSync(types, types + ".saved"); symlinkSync(types + ".saved", types);
    try { await assert.rejects(runDiagnosticProbe("sdk:schema:v1", scratch), /unsafe_scope/); }
    finally { rmSync(types); renameSync(types + ".saved", types); }
  }
});

test("registry uses one fixed read-only HEAD without redirects and refuses unsuccessful responses", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => { assert.equal(url, "https://registry.npmjs.org/"); assert.equal(options.method, "HEAD"); assert.equal(options.redirect, "error"); return new Response(null, { status: 200 }); });
  assert.equal(await runDiagnosticProbe("http:registry-head:v1", tracker), 1);
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  await assert.rejects(runDiagnosticProbe("http:registry-head:v1", tracker), /registry_unavailable/);
});

test("CLI generation and execution flags preserve review boundaries and defaults", async () => {
  const harness = await createExtensionTestHarness(extension, { name: "pm-ops", capabilities: ["commands", "renderers", "schema", "parser", "services"] });
  try {
    const run = (options: Record<string, unknown> = {}) => harness.runCommand({ command: "ops diagnose", pmRoot: tracker, options });
    const plan = (await run({ failures: "items_unreadable" })).result as DiagnosticPlan;
    assert.deepEqual(plan.budget, { processes: 3, network: 0, time_ms: 10000 });
    assert.deepEqual((await run({ failures: "items_unreadable", processes: "0", network: "0", timeMs: "60000" })).result,
      await createDiagnosticPlan(tracker, ["items_unreadable"], { processes: 0, network: 0, time_ms: 60000 }));
    const selectedPlan = await createDiagnosticPlan(tracker, ["items_unreadable"], budget);
    const input = join(root, "selected.json"); writeFileSync(input, JSON.stringify(selectedPlan));
    assert.equal(((await run({ plan: input, select: selectedPlan.id })).result as { ok: boolean }).ok, true);
    for (const options of [{}, { select: plan.id }, { failures: "items_unreadable", select: plan.id }, { plan: input }, { plan: input, select: plan.id, failures: "items_unreadable" }, { plan: input, select: plan.id, processes: "0" }, { plan: input, select: plan.id, network: "0" }, { plan: input, select: plan.id, "time-ms": "1" }]) await assert.rejects(run(options), DiagnosticRefusal);
  } finally { await harness.deactivate(); }
});

test("installed pinned CLI renders compact native TOON and JSON in a non-Git tracker", () => {
  const shim = join(root, "extension"); mkdirSync(shim);
  writeFileSync(join(shim, "manifest.json"), JSON.stringify({ name: "pm-ops", version: "2026.10.23", entry: "./index.mjs", capabilities: ["commands", "renderers", "schema", "parser", "services"] }));
  writeFileSync(join(shim, "index.mjs"), `export { default } from ${JSON.stringify(pathToFileURL(resolve("dist/index.js")).href)};`);
  const installed = pm(["package", "install", shim, "--project", "--json"]); assert.equal(installed.status, 0, installed.stderr);
  for (const json of [true, false]) {
    const result = spawnSync(process.execPath, [cli, "ops", "diagnose", "--failures", "items_unreadable,history_invalid", "--processes", "2", "--time-ms", "60000", ...(json ? ["--json"] : [])], { cwd: root, env: { ...process.env, PATH: "", PM_PATH: tracker, GIT_CEILING_DIRECTORIES: dirname(root) }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const plan = parseDiagnosticPlan(json ? JSON.parse(result.stdout) : decode(result.stdout));
    assert.equal(plan.steps.length, 2); assert.equal(plan.budget.time_ms, 60000);
    assert.ok(Buffer.byteLength(result.stdout) < 1500);
    const input = join(root, "installed-plan.json"); writeFileSync(input, JSON.stringify(plan));
    const before = fingerprint(tracker);
    const executed = pm(["ops", "diagnose", "--plan", input, "--select", plan.id, "--json"]);
    assert.equal(executed.status, 0, executed.stderr); assert.equal(JSON.parse(executed.stdout).ok, true);
    assert.equal(fingerprint(tracker), before);
  }
});

test("CLI charges plan file input time to the shared execution deadline", async (t) => {
  const harness = await createExtensionTestHarness(extension, { name: "pm-ops", capabilities: ["commands", "renderers", "schema", "parser", "services"] });
  const plan = await createDiagnosticPlan(tracker, ["schema_unreadable"], { processes: 1, network: 0, time_ms: 10 });
  const input = join(root, "timed-plan.json"); writeFileSync(input, JSON.stringify(plan));
  const stat = fs.statSync;
  let clock = 0; let launches = 0;
  t.mock.method(performance, "now", () => clock);
  t.mock.method(fs, "statSync", (...args: Parameters<typeof stat>) => { if (String(args[0]) === input) clock += 20; return stat(...args); });
  t.mock.method(childProcess, "spawnSync", () => { launches++; return { status: 0, stdout: '{"checked":1}' }; }); syncBuiltinESMExports();
  try {
    const result = (await harness.runCommand({ command: "ops diagnose", pmRoot: tracker, options: { plan: input, select: plan.id } })).result as { used: DiagnosticBudget; rows: { code: string }[] };
    assert.equal(launches, 0); assert.equal(result.used.time_ms, 20); assert.equal(result.rows[0]!.code, "time_budget");
  } finally { restore(t); await harness.deactivate(); }
});

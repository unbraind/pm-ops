/** Exact optimization, strict boundaries, replay, native-state preservation and real command integration. */
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import * as disk from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { encode, decode } from "@toon-format/toon";
import { PmClient, createAssuranceWorkspaceContext, evaluateAssuranceGate, putAssuranceDeclarationBundle, recordAssuranceVerdict, type AssuranceDocument } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { compileReverificationPlan, parseReverificationInput, parseReverificationPlan, readReverificationInput, auditReverificationFiles, validateReverificationCosts, ReverificationRefusal, type ReverificationInput } from "../reverification-plans.ts";
import { createDiagnosticPlan, executeDiagnosticPlan } from "../diagnostic-plans.ts";
import { spawnSync } from "../subprocess.ts";
import { repairFixture, minimumCost } from "./reverification-fixtures.ts";
import { fingerprint } from "./tracker-read-helpers.ts";
import extension from "../index.ts";

let root: string;
let tracker: string;
let reader: PmClient;
let policyFile: string;
let versionsFile: string;
const captured = "2026-10-22T10:00:00.000Z";
const expired = "2026-10-22T12:00:00.000Z";

/** Seed a real plain-directory tracker and native accepted assurance receipts. */
before(async () => {
  root = disk.mkdtempSync(join(tmpdir(), "reverification-test-")); tracker = join(root, ".agents", "pm");
  reader = new PmClient({ pmRoot: tracker, noExtensions: true, author: "codex-agent" });
  await reader.init("repair", { defaults: true, agentGuidance: "skip" });
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const environment = { ...process.env, PM_PATH: tracker, PM_AUTHOR: "codex-agent", GIT_CEILING_DIRECTORIES: dirname(root), PATH: "" };
  const seed = spawnSync(process.execPath, [cli, "create", "task", "  native\r\nfields  ", "--id", "repair-owner", "--parent", "none", "--goal", "none", "--objective", "none", "--description", " spaced\r\nbody ", "--tags", "synthetic,model"], { cwd: root, env: environment, encoding: "utf8" });
  assert.equal(seed.status, 0, seed.stderr);
  const second = spawnSync(process.execPath, [cli, "create", "task", "Relationship", "--id", "repair-child", "--parent", "repair-owner", "--goal", "none", "--objective", "none", "--dep", "type=depends_on,id=repair-owner"], { cwd: root, env: environment, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  const contract: AssuranceDocument = { measurements: [{ source: { kind: "items" }, id: "population" }], version: 1,
    assertions: ["health", "coverage", "recovery"].map((id) => ({ enforcement: "block", floor: 1, id, owner_item_id: "repair-owner", negative_control: { cases: [{ expected: "pass", observed: 1 }, { expected: "fail", observed: 0 }] }, measurement_id: "population", scope: { kind: "all" } })),
    gates: [{ id: "operational", assertion_ids: ["health", "coverage", "recovery"], triggers: ["ci"] }] };
  await putAssuranceDeclarationBundle(tracker, contract, { author: "codex-agent" });
  const context = await createAssuranceWorkspaceContext(tracker, { tree_id: "snapshot-v1", resolve_tree: false, strict_read: true });
  const receipt = { ...await evaluateAssuranceGate("operational", contract, context, { trigger: "ci" }), evaluated_at: captured };
  assert.equal(receipt.verdict, "pass"); await recordAssuranceVerdict(tracker, receipt, { author: "codex-agent" });
  policyFile = join(root, "policy.json"); versionsFile = join(root, "versions.json");
  disk.writeFileSync(versionsFile, JSON.stringify({ backend: "v1" }));
  disk.writeFileSync(policyFile, JSON.stringify({ version: 1, claims: ["health", "coverage", "recovery"].map((id) => ({ id, kind: id,
    receipt: { gate_id: "operational", tree_id: "snapshot-v1", evaluated_at: captured, assertion_id: id }, scope: { kind: "all" }, max_age_seconds: 3600, versions: { backend: "v1" } })) }));
});
after(() => disk.rmSync(root, { recursive: true, force: true }));

test("exact closure beats every check, deduplicates shared prerequisites and preserves conditional evidence", () => {
  const input = repairFixture(); const plan = compileReverificationPlan(input);
  assert.equal(plan.ok, true); assert.equal(plan.cost, 6); assert.equal(plan.all_cost, 16); assert.equal(plan.saved, 10);
  assert.deepEqual(plan.steps.map((step) => step.id), ["schema", "combined"]);
  assert.deepEqual(plan.rows.map((row) => row.code), ["rerun_required", "rerun_required", "fresh"]);
  assert.equal(BigInt(plan.cost), minimumCost(input));
  assert.deepEqual(parseReverificationPlan(JSON.parse(JSON.stringify(plan)), input), plan);
  assert.deepEqual(parseReverificationPlan(decode(encode(plan)), input), plan);
  assert.ok(Buffer.byteLength(encode(plan)) < 3000);
  const independent = structuredClone(input); independent.checks.splice(1, 1);
  assert.deepEqual(compileReverificationPlan(independent).steps.map((step) => step.id), ["schema", "coverage-only", "health-only"]);
  assert.equal(compileReverificationPlan(independent).cost, 12);
  const fresh = structuredClone(input); fresh.claims.forEach((claim) => { claim.status = "fresh"; });
  assert.equal(compileReverificationPlan(fresh).cost, 0); assert.deepEqual(compileReverificationPlan(fresh).steps, []);
});

test("missing supporters, approvals, missing prerequisites, transitive refusals and cycles are per-target gaps", () => {
  const input = repairFixture(); input.claims.forEach((claim) => { claim.status = "unavailable"; });
  input.checks = [{ id: "root", approved: false, cost: 0, requires: [], supports: ["health"] },
    { id: "cycle-a", approved: true, cost: 1, requires: ["cycle-b"], supports: ["coverage"] },
    { id: "cycle-b", approved: true, cost: 1, requires: ["cycle-a"], supports: [] }];
  assert.deepEqual(compileReverificationPlan(input).rows.map((row) => row.code), ["dependency_unavailable", "approval_required", "no_supporting_check"]);
  input.checks[1]!.requires = ["absent"];
  assert.equal(compileReverificationPlan(input).rows[0]!.code, "dependency_unavailable");
  input.checks[1]!.requires = ["root"];
  const plan = compileReverificationPlan(input); assert.equal(plan.ok, false); assert.deepEqual(plan.steps, []); assert.equal(plan.cost, 0);
  input.checks.push({ id: "available", approved: true, cost: 1, requires: [], supports: ["recovery"] });
  assert.deepEqual(compileReverificationPlan(input).steps.map((step) => step.id), ["available"]);
  input.checks = [];
  assert.ok(compileReverificationPlan(input).rows.every((row) => row.code === "no_supporting_check"));
});

test("zero costs, exact one-unit boundaries, maximum domain and deterministic canonical ties", () => {
  const input = repairFixture(); input.checks = [
    { id: "constructor", approved: true, cost: 1_000_000_000, requires: [], supports: ["health", "coverage"] },
    { id: "toString", approved: true, cost: 999_999_999, requires: [], supports: ["health", "coverage"] },
    { id: "zero", approved: true, cost: 0, requires: [], supports: [] }];
  assert.equal(compileReverificationPlan(input).cost, 999_999_999);
  input.checks[0]!.cost = 999_999_999;
  assert.deepEqual(compileReverificationPlan(input).steps.map((step) => step.id), ["constructor"]);
  const first = compileReverificationPlan(input); input.checks.reverse(); input.claims.reverse(); input.targets.reverse();
  assert.deepEqual(compileReverificationPlan(input), first);
  input.checks[0]!.cost = -0;
  const zero = compileReverificationPlan(input);
  assert.equal(Object.is(zero.steps[0]!.cost, -0), false);
  assert.deepEqual(parseReverificationPlan(JSON.parse(JSON.stringify(zero)), input), zero);
  const wide: ReverificationInput = { version: 1, claims: Array.from({ length: 32 }, (_, i) => ({ id: `claim-${i}`, status: "revalidate" })),
    targets: Array.from({ length: 16 }, (_, i) => `claim-${i}`), checks: Array.from({ length: 18 }, (_, i) => ({ id: `check-${i}`, approved: true, cost: 1_000_000_000, requires: i ? [`check-${i - 1}`] : [], supports: i === 17 ? Array.from({ length: 32 }, (_, j) => `claim-${j}`) : [] })) };
  const maximal = compileReverificationPlan(wide);
  assert.equal(maximal.cost, 18_000_000_000); assert.equal(maximal.steps.length, 18); assert.equal(maximal.rows.length, 16);
  for (const number of [maximal.cost, maximal.all_cost, maximal.saved, ...maximal.steps.map((step) => step.cost)]) assert.ok(Number.isSafeInteger(number) && number >= 0 && number <= 18_000_000_000);
});

test("one strict schema refuses sparse arrays, unknown fields, duplicate identities and numerical extremes before I/O", async () => {
  const input = repairFixture();
  const refused: unknown[] = [null, [], {}, Object.create(input), { ...input, version: 2 }, { ...input, extra: 1 }];
  refused.push({ version: 1, claims: input.claims, targets: input.targets, typo: input.checks });
  for (const [key, limit] of [["claims", 32], ["targets", 16], ["checks", 18]] as const) {
    for (const value of [null, Array(1), Object.assign([input[key][0]], { extra: true }), Array(limit + 1).fill(input[key][0])]) refused.push({ ...input, [key]: value });
  }
  refused.push({ ...input, claims: [] }, { ...input, targets: [] }, { ...input, targets: ["absent"] }, { ...input, targets: ["health", "health"] },
    { ...input, claims: [...input.claims, input.claims[0]] }, { ...input, checks: [...input.checks, input.checks[0]] });
  for (const patch of [{ id: "" }, { id: "a".repeat(49) }, { status: "open" }, { status: null }, { extra: 1 }]) refused.push({ ...input, claims: [{ ...input.claims[0], ...patch }] });
  for (const patch of [{ id: false }, { approved: 1 }, { supports: ["missing"] }, { requires: Array(1) }, { requires: ["x", "x"] }, { supports: ["health", "health"] }, { requires: ["../private"] }, { extra: 1 },
    ...[NaN, Infinity, -Infinity, -1, 0.5, Number.MIN_VALUE, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1, 1_000_000_001, "1"].map((cost) => ({ cost }))]) refused.push({ ...input, checks: [{ ...input.checks[0], ...patch }] });
  for (const value of refused) assert.throws(() => compileReverificationPlan(value), ReverificationRefusal);
  // Must-allow corpus: released native evidence classifications are not custom item status names.
  assert.deepEqual(parseReverificationInput(Object.assign(Object.create(null), input)), parseReverificationInput(input));
  const unsafe = structuredClone(input); unsafe.claims[0]!.id = "constructor"; unsafe.targets[0] = "constructor";
  unsafe.checks.forEach((check) => { check.supports = check.supports.map((id) => id === "health" ? "constructor" : id); });
  assert.equal(compileReverificationPlan(unsafe).ok, true);
  for (const value of [null, { ...compileReverificationPlan(input), cost: Infinity }, { ...compileReverificationPlan(input), extra: true }, { cost: 1n }]) assert.throws(() => parseReverificationPlan(value, input), /invalid_reverification_plan/);
  const refusal = new ReverificationRefusal("invalid_reverification_input", "Supply checks."); assert.equal(refusal.exitCode, 2); assert.equal(refusal.remedy, "Supply checks.");
  for (const key of ["cost", "all_cost", "saved"]) for (const number of [NaN, Infinity, -Infinity, -1, 0.1, Number.MAX_VALUE, Number.MIN_VALUE, 18_000_000_001]) assert.throws(() => validateReverificationCosts({ cost: 6, all_cost: 16, saved: 10, [key]: number }), ReverificationRefusal);
  for (const value of [null, { cost: 2, all_cost: 1, saved: 0 }, { cost: 1, all_cost: 2, saved: 2 }, { cost: 0, all_cost: 0, saved: 0, extra: 0 }]) assert.throws(() => validateReverificationCosts(value), ReverificationRefusal);
  const file = join(root, "bad.json");
  for (const raw of ["{", " ".repeat(65537), Buffer.from([0xff])]) { disk.writeFileSync(file, raw); assert.throws(() => readReverificationInput(file), ReverificationRefusal); }
  assert.throws(() => readReverificationInput(root), ReverificationRefusal); assert.throws(() => readReverificationInput(join(root, "absent")), ReverificationRefusal);
  await assert.rejects(auditReverificationFiles("missing", "missing", "missing", file), ReverificationRefusal);
});

test("500 seeded model sequences replay old contracts, relationships, JSON/TOON and CRLF while preserving SDK-read native state", async () => {
  const corpus = await reader.listAllComplete();
  const nativeModel = new Map(await Promise.all(corpus.items.map(async ({ id }) => [id, await reader.get(id)] as const)));
  let seed = 0x51ac0ffe;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const past: ReverificationInput[] = [];
  const file = join(root, "random.json");
  for (let sequence = 0; sequence < 500; sequence++) {
    const bytes = fingerprint(tracker);
    let current = repairFixture();
    for (let operation = 0; operation < 6; operation++) {
      const action = Math.floor(random() * 6); const index = Math.floor(random() * current.checks.length);
      if (action === 0 && past.length) current = structuredClone(past[Math.floor(random() * past.length)]!);
      if (action === 1) current.checks[index]!.cost = Math.floor(random() * 10);
      if (action === 2) current.checks[index]!.approved = random() > 0.3;
      if (action === 3) current.checks[index]!.requires = random() > 0.5 ? [current.checks[Math.floor(random() * current.checks.length)]!.id] : [];
      if (action === 4) current.claims[Math.floor(random() * current.claims.length)]!.status = random() > 0.5 ? "fresh" : "unavailable";
      if (action === 5) current = parseReverificationInput(decode(encode(current)));
      const plan = compileReverificationPlan(current); assert.equal(BigInt(plan.cost), minimumCost(current));
      disk.writeFileSync(file, ` \r\n${JSON.stringify(current, null, 2).replace(/\n/g, "\r\n")} \r\n`);
      assert.deepEqual(compileReverificationPlan(readReverificationInput(file)), plan);
      for (const transported of [JSON.parse(JSON.stringify(plan)), decode(encode(plan))]) assert.deepEqual(parseReverificationPlan(transported, current), plan);
      assert.equal(plan.rows.length, current.targets.length); assert.equal(new Set(plan.steps.map((step) => step.id)).size, plan.steps.length);
      const seen = new Set<string>(); for (const step of plan.steps) { assert.ok(step.requires.every((id) => seen.has(id))); seen.add(step.id); }
      for (const number of [plan.cost, plan.all_cost, plan.saved]) assert.ok(Number.isSafeInteger(number) && number >= 0);
    }
    past.push(structuredClone(current));
    assert.equal(fingerprint(tracker), bytes, "planning preserves all bytes before SDK readback refreshes its own read caches");
    for (const [id, expected] of nativeModel) assert.deepEqual(await reader.get(id), expected);
  }
  assert.equal(disk.existsSync(join(root, ".git")), false);
});

test("CLI uses current SDK expiry instead of caller freshness, formats agree and invalid guards refuse without git", async () => {
  const harness = await createExtensionTestHarness(extension, { name: "pm-ops", capabilities: ["commands", "renderers", "schema", "parser", "services"] });
  const input = join(root, "input.json"); const packet = repairFixture(); packet.claims.forEach((claim) => { claim.status = "fresh"; });
  disk.writeFileSync(input, JSON.stringify(packet)); const beforeBytes = fingerprint(tracker);
  try {
    const options = { input, policy: policyFile, versions: versionsFile, now: expired };
    const expected = await auditReverificationFiles(tracker, policyFile, versionsFile, input, { now: expired });
    assert.equal(expected.cost, 6); assert.equal(expected.ok, false); assert.equal(expected.rows[2]!.code, "no_supporting_check");
    for (const json of [true, false]) assert.deepEqual((await harness.runCommand({ command: "ops reverify", options, global: { json }, pmRoot: tracker })).result, { pmOpsRendered: true, output: json ? JSON.stringify(expected) : encode(expected) });
    assert.deepEqual((await harness.runCommand({ command: "ops reverify", options: { input, policy: policyFile, versions: versionsFile }, global: { json: true }, pmRoot: tracker })).result, { pmOpsRendered: true, output: JSON.stringify(expected) });
    for (const omitted of ["input", "policy", "versions"]) { const incomplete: Record<string, unknown> = { ...options }; delete incomplete[omitted]; await assert.rejects(harness.runCommand({ command: "ops reverify", options: incomplete, pmRoot: tracker }), ReverificationRefusal); }
    await assert.rejects(harness.runCommand({ command: "ops reverify", options: { ...options, now: " " }, pmRoot: tracker }), ReverificationRefusal);
    const fresh = await auditReverificationFiles(tracker, policyFile, versionsFile, input, { now: captured });
    assert.equal(fresh.cost, 0); assert.ok(fresh.rows.every((row) => row.code === "fresh"));
    assert.ok((await auditReverificationFiles(tracker, policyFile, versionsFile, input)).rows.every((row) => row.code !== "fresh"));
    assert.equal(fingerprint(tracker), beforeBytes);
    const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
    const shim = join(root, "shim"); disk.mkdirSync(shim);
    disk.writeFileSync(join(shim, "extension.mjs"), `export {default} from ${JSON.stringify(pathToFileURL(resolve("dist/index.js")).href)};`);
    disk.writeFileSync(join(shim, "manifest.json"), JSON.stringify({ entry: "./extension.mjs", capabilities: ["services", "parser", "commands", "renderers", "schema"], version: "2026.10.28", name: "pm-ops" }));
    const restrictedEnvironment = { PATH: "", PM_PATH: tracker, GIT_CEILING_DIRECTORIES: dirname(root), ...process.env };
    restrictedEnvironment.PATH = ""; restrictedEnvironment.PM_PATH = tracker;
    const invoke = (args: string[]) => spawnSync(process.execPath, [cli].concat(args), { env: restrictedEnvironment, encoding: "utf8", cwd: root });
    const installation = invoke(["package", "install", shim, "--project", "--json"]);
    assert.equal(installation.status, 0, installation.stderr);
    const argumentsForPlan = ["ops", "reverify", "--input", input, "--policy", policyFile, "--versions", versionsFile, "--now", expired];
    for (const format of ["json", "toon"]) {
      const rendered = invoke(format === "json" ? [...argumentsForPlan, "--json"] : argumentsForPlan);
      assert.equal(rendered.status, 0, rendered.stderr);
      assert.deepEqual(format === "json" ? JSON.parse(rendered.stdout) : decode(rendered.stdout), expected);
    }
    const defaultClock = invoke(argumentsForPlan.slice(0, -2).concat("--json"));
    assert.equal(defaultClock.status, 0, defaultClock.stderr); assert.deepEqual(JSON.parse(defaultClock.stdout), expected);
    assert.equal(invoke(["ops", "reverify"]).status, 2);
  } finally { await harness.deactivate(); }
});

test("missing attachments cannot reuse declared freshness and every observed history-read boundary tolerates peer changes", async (t) => {
  const input = join(root, "interleaving.json"); const packet = repairFixture();
  packet.claims.push({ id: "unknown", status: "fresh" }); packet.targets.push("unknown");
  disk.writeFileSync(input, JSON.stringify(packet));
  const observed = await auditReverificationFiles(tracker, policyFile, versionsFile, input, { now: captured });
  assert.equal(observed.rows.find((row) => row.claim === "unknown")!.code, "no_supporting_check");
  const stream = join(tracker, "history", "_workspace.jsonl"); const original = disk.readFileSync(stream);
  const readFile = promises.readFile; let boundaries = 0;
  t.mock.method(promises, "readFile", async (...args: Parameters<typeof readFile>) => {
    const result = await readFile(...args); if (String(args[0]) === stream) boundaries++; return result;
  }); syncBuiltinESMExports();
  try { await auditReverificationFiles(tracker, policyFile, versionsFile, input, { now: captured }); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.ok(boundaries >= 2);
  for (let boundary = 1; boundary <= boundaries; boundary++) {
    let seen = 0;
    t.mock.method(promises, "readFile", async (...args: Parameters<typeof readFile>) => {
      if (String(args[0]) === stream && ++seen === boundary) disk.appendFileSync(stream, "\n");
      return readFile(...args);
    }); syncBuiltinESMExports();
    try {
      const result = await auditReverificationFiles(tracker, policyFile, versionsFile, input, { now: captured });
      // A peer before the first read is a stable snapshot; all later mutations are refused by expiry.
      if (boundary > 1) assert.ok(result.rows.every((row) => row.code !== "fresh"));
      assert.equal(result.rows.length, packet.targets.length);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); disk.writeFileSync(stream, original); }
  }
});

test("selected shared prerequisites dispatch exactly once using the existing diagnostic runner", async () => {
  const input: ReverificationInput = { version: 1, claims: [{ id: "health", status: "revalidate" }, { id: "recovery", status: "revalidate" }], targets: ["health", "recovery"], checks: [
    { id: "sdk:schema:v1", approved: true, cost: 1, requires: [], supports: [] },
    { id: "sdk:items:v1", approved: true, cost: 1, requires: ["sdk:schema:v1"], supports: ["health"] },
    { id: "sdk:history:v1", approved: true, cost: 1, requires: ["sdk:schema:v1"], supports: ["recovery"] } ] };
  const plan = compileReverificationPlan(input); const ids = new Set(plan.steps.map((step) => step.id));
  const failures = ([ ["sdk:schema:v1", "schema_unreadable"], ["sdk:items:v1", "items_unreadable"], ["sdk:history:v1", "history_invalid"] ] as const).filter(([id]) => ids.has(id)).map(([, failure]) => failure);
  const diagnostic = await createDiagnosticPlan(tracker, failures, { processes: 3, network: 0, time_ms: 60000 });
  const result = await executeDiagnosticPlan(tracker, diagnostic, diagnostic.id);
  assert.equal(result.ok, true); assert.equal(result.used.processes, 3); assert.equal(result.rows.length, 3);
  assert.equal(new Set(result.rows.map((row) => row.command)).size, 3);
  assert.equal(result.rows.find((row) => row.command === "sdk:items:v1")!.checked, 2);
});

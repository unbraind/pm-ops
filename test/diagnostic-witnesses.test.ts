import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { encode, decode } from "@toon-format/toon";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { spawnSync } from "../subprocess.ts";
import { parseDiagnosticWitnessInput, reduceDiagnosticWitnesses, readDiagnosticWitnesses, validateDiagnosticWitnessCounts, WitnessRefusal, type DiagnosticWitnessInput, type DiagnosticWitnessReport } from "../diagnostic-witnesses.ts";
import extension from "../index.ts";
import { DIAGNOSTIC_COMMANDS } from "../diagnostic-plans.ts";
import { fingerprint } from "./tracker-read-helpers.ts";

/** Explicit incompatible SDK evidence, plus removable noise. */
function selection(): DiagnosticWitnessInput {
  return { version: 1, facts: [
    { id: "actual", scope: "snapshot-a", key: "sdk.actual", value: "2026.10.19" },
    { id: "required", scope: "snapshot-a", key: "sdk.required", value: ">=2026.10.20" },
    { id: "noise", scope: "snapshot-a", key: "irrelevant", value: "  preserve\r\nexactly  " },
  ], checks: Array.from({ length: 5 }, (_, index) => ({ id: `check-${index}`, failure: "sdk_incompatible", scope: "snapshot-a", command: DIAGNOSTIC_COMMANDS[index % 3]!, diagnosis: "unverified", sufficient: [["actual", "required"]] })) };
}
/** Independent exhaustive set model; no production normalization or bitmasks. */
function minimum(input: DiagnosticWitnessInput): number {
  let subsets: string[][] = [[]];
  for (const fact of input.facts) subsets = subsets.concat(subsets.map((subset) => [...subset, fact.id]));
  return Math.min(...subsets.filter((subset) => input.checks.every((check) => check.sufficient.some((clause) => clause.every((ref) => subset.includes(ref)))))
    .map((subset) => subset.length));
}
/** Check completeness, sufficiency, grouping and finite output against the reference model. */
function verify(input: DiagnosticWitnessInput, report: DiagnosticWitnessReport): void {
  assert.equal(report.facts.length, minimum(input));
  assert.equal(report.omitted_facts, input.facts.length - report.facts.length);
  assert.equal(report.affected_checks, input.checks.length);
  assert.deepEqual(report.witnesses.flatMap((witness) => witness.checks.map((check) => check.id)).sort(), input.checks.map((check) => check.id).sort());
  for (const fact of report.facts) assert.deepEqual(fact, input.facts.find((entry) => entry.id === fact.id));
  for (const witness of report.witnesses) for (const affected of witness.checks) {
    const check = input.checks.find((entry) => entry.id === affected.id)!;
    assert.equal(witness.failure, check.failure); assert.equal(witness.scope, check.scope);
    assert.equal(affected.command, check.command); assert.equal(witness.diagnosis, check.diagnosis);
    assert.ok(check.sufficient.some((clause) => clause.length === witness.facts.length && clause.every((ref) => witness.facts.includes(ref))));
    assert.ok(witness.facts.every((ref) => report.facts.some((fact) => fact.id === ref)));
  }
  validateDiagnosticWitnessCounts(report);
  assert.deepEqual(decode(encode(report)), report);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
}

test("five incompatible SDK failures share one witness, unrelated classes/scopes/diagnoses stay separate", () => {
  const input = selection();
  const first = reduceDiagnosticWitnesses(input);
  assert.equal(first.witnesses.length, 1); assert.equal(first.witnesses[0]!.checks.length, 5);
  assert.equal(first.witnesses[0]!.diagnosis, "unverified"); assert.equal(first.basis, "declared_sufficiency");
  assert.equal(first.facts.length, 2);
  assert.deepEqual(first.witnesses[0]!.checks.map((check) => check.command), input.checks.map((check) => check.command));
  verify(input, first);
  for (const patch of [{ failure: "other_failure" }, { diagnosis: "observed" as const }, { sufficient: [["noise"]] }]) {
    const separate = { ...input, checks: [...input.checks, { ...input.checks[0]!, id: "unrelated", ...patch }] };
    assert.equal(reduceDiagnosticWitnesses(separate).witnesses.length, 2); verify(separate, reduceDiagnosticWitnesses(separate));
  }
  input.facts.push({ id: "foreign", scope: "snapshot-b", key: "sdk.actual", value: "2026.10.19" });
  input.checks.push({ ...input.checks[0]!, id: "foreign-check", scope: "snapshot-b", sufficient: [["foreign"]] });
  assert.equal(reduceDiagnosticWitnesses(input).witnesses.length, 2);
  assert.throws(() => parseDiagnosticWitnessInput({ ...input, checks: [{ ...input.checks[0], scope: "snapshot-b" }] }), WitnessRefusal);
});

test("exact global minimization beats locally shortest clauses and is deterministic under permutations", () => {
  const input = selection();
  input.checks = [{ ...input.checks[0]!, id: "a", sufficient: [["actual"], ["required", "noise"]] },
    { ...input.checks[0]!, id: "b", sufficient: [["required", "noise"]] }];
  const report = reduceDiagnosticWitnesses(input);
  assert.deepEqual(report.facts.map((fact) => fact.id), ["noise", "required"]);
  assert.equal(report.witnesses.length, 1); verify(input, report);
  const shuffled = { ...input, facts: [...input.facts].reverse(), checks: [...input.checks].reverse().map((check) => ({ ...check, sufficient: check.sufficient.map((clause) => [...clause].reverse()).reverse() })) };
  assert.deepEqual(reduceDiagnosticWitnesses(shuffled), report);
  const single = { version: 1 as const, facts: [input.facts[0]!], checks: [{ ...input.checks[0]!, sufficient: [["actual"]] }] };
  assert.equal(reduceDiagnosticWitnesses(single).omitted_facts, 0);
  assert.equal(reduceDiagnosticWitnesses({ ...input, checks: [{ ...input.checks[0]!, sufficient: [["actual"], ["noise"]] }] }).facts[0]!.id, "actual");
});

test("one strict schema refuses sparse arrays, unknown keys, invalid domains and causal upgrades", () => {
  const base = selection();
  for (const value of [null, [], {}, { ...base, extra: true }, { ...base, version: Infinity }, { ...base, version: 2 },
    ...[null, [], Array(1), Array(17).fill(base.facts[0])].map((facts) => ({ ...base, facts })),
    ...[null, [], Array(1), Array(65).fill(base.checks[0])].map((checks) => ({ ...base, checks })),
  ]) assert.throws(() => parseDiagnosticWitnessInput(value), WitnessRefusal);
  for (const patch of [{ id: "" }, { id: "/private" }, { scope: 2 }, { key: " " }, { value: 1 }, { value: "" }, { value: "x".repeat(257) }, { extra: 1 }]) {
    assert.throws(() => parseDiagnosticWitnessInput({ ...base, facts: [{ ...base.facts[0], ...patch }] }), WitnessRefusal);
  }
  assert.throws(() => parseDiagnosticWitnessInput({ ...base, facts: [base.facts[0], base.facts[0]] }), WitnessRefusal);
  assert.throws(() => parseDiagnosticWitnessInput({ ...base, facts: [base.facts[0], { ...base.facts[0], id: "alias" }] }), WitnessRefusal);
  for (const patch of [{ id: " " }, { failure: false }, { scope: " " }, { command: "shell:arbitrary" }, { command: {} }, { diagnosis: "proven" },
    { sufficient: [] }, { sufficient: Array(1) }, { sufficient: Array(9).fill(["actual"]) }, { sufficient: [null] }, { sufficient: [[]] },
    { sufficient: [Array(1)] }, { sufficient: [["unknown"]] }, { sufficient: [[1]] }, { sufficient: [["actual", "actual"]] }, { extra: true }]) {
    assert.throws(() => parseDiagnosticWitnessInput({ ...base, checks: [{ ...base.checks[0], ...patch }] }), WitnessRefusal);
  }
  assert.throws(() => parseDiagnosticWitnessInput({ ...base, checks: [base.checks[0], base.checks[0]] }), WitnessRefusal);
  const refusal = new WitnessRefusal("invalid_witness_input", "Supply explicit facts.");
  assert.equal(refusal.exitCode, 2); assert.equal(refusal.remedy, "Supply explicit facts.");
});

test("extreme input and output numbers never produce successful invalid packets", () => {
  for (const value of [NaN, Infinity, -Infinity, -1, -0.5, 0, 0.5, 17, 65, Number.MAX_VALUE, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => reduceDiagnosticWitnesses({ ...selection(), version: value }), WitnessRefusal);
    for (const key of ["input_facts", "affected_checks", "omitted_facts"] as const) {
      const counts = { version: 1 as const, input_facts: 3, affected_checks: 5, omitted_facts: 1, [key]: value };
      const valid = Number.isSafeInteger(value) && (key === "input_facts" ? value >= 1 && value <= 16 && counts.omitted_facts < value : key === "affected_checks" ? value >= 1 && value <= 64 : value >= 0 && value < counts.input_facts);
      if (valid) validateDiagnosticWitnessCounts(counts); else assert.throws(() => validateDiagnosticWitnessCounts(counts), /invalid_witness_output/);
    }
  }
  assert.throws(() => validateDiagnosticWitnessCounts({ version: 2 as 1, input_facts: 3, affected_checks: 5, omitted_facts: 1 }), WitnessRefusal);
  validateDiagnosticWitnessCounts({ version: 1, input_facts: 16, affected_checks: 64, omitted_facts: 15 });
});

test("500 seeded model-based sequences replay old inputs and exact CRLF/whitespace without changing SDK state", async () => {
  const root = mkdtempSync(join(tmpdir(), "witness-model-"));
  const tracker = join(root, ".agents", "pm");
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const env = { ...process.env, PM_PATH: tracker, GIT_CEILING_DIRECTORIES: dirname(root) };
  try {
    for (const args of [["init", "--defaults", "--agent-guidance", "skip", "--prefix", "witness"], ["create", "task", "Read-only relation target", "--id", "witness-a"],
      ["create", "task", "Exact  whitespace\r\nbody", "--id", "witness-b", "--parent", "witness-a", "--description", "  exact\r\ntext  ", "--tags", "synthetic,model"]]) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr);
    }
    const client = new PmClient({ pmRoot: tracker, noExtensions: true });
    const initial = await client.listAllComplete();
    const state = await Promise.all(initial.items.map((item) => client.get(item.id)));
    let seed = 0x5eeda;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const past: DiagnosticWitnessInput[] = [];
    for (let sequence = 0; sequence < 500; sequence++) {
      const before = fingerprint(tracker);
      let current = selection();
      for (let operation = 0; operation < 8; operation++) {
        const action = Math.floor(random() * 6);
        if (action === 0 && past.length) current = structuredClone(past[Math.floor(random() * past.length)]!);
        if (action === 1) current.facts[2]!.value = ` ${sequence}\r\n${operation} `;
        if (action === 2) current.checks[Math.floor(random() * current.checks.length)]!.sufficient = random() < 0.5 ? [["actual"], ["noise", "required"]] : [["actual", "required"]];
        if (action === 3) current.checks[0]!.diagnosis = random() < 0.5 ? "observed" : "unverified";
        if (action === 4) current.checks[0]!.failure = random() < 0.5 ? "sdk_incompatible" : "items_unreadable";
        if (action === 5) current = decode(encode(current)) as unknown as DiagnosticWitnessInput;
        const input = join(root, "input.json");
        writeFileSync(input, JSON.stringify(current, null, 2).replace(/\n/g, "\r\n"));
        const report = readDiagnosticWitnesses(input); verify(current, report);
        assert.deepEqual(report, reduceDiagnosticWitnesses(JSON.parse(JSON.stringify(current))));
      }
      past.push(structuredClone(current));
      assert.equal(fingerprint(tracker), before);
      assert.deepEqual(await Promise.all(initial.items.map((item) => client.get(item.id))), state);
    }
    assert.equal(existsSync(join(root, ".git")), false);
    for (const raw of ["{", " ".repeat(65537), Buffer.from([0xff])]) { writeFileSync(join(root, "input.json"), raw); assert.throws(() => readDiagnosticWitnesses(join(root, "input.json")), /witness_input_unreadable/); }
    assert.throws(() => readDiagnosticWitnesses(root), WitnessRefusal);
    assert.throws(() => readDiagnosticWitnesses(join(root, "missing")), WitnessRefusal);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI and SDK agree in a non-git tracker with no git executable, including typed refusals", async () => {
  const harness = await createExtensionTestHarness(extension, { name: "pm-ops", capabilities: ["commands", "renderers", "schema", "parser", "services"] });
  const root = mkdtempSync(join(tmpdir(), "witness-cli-"));
  try {
    const input = join(root, "failures.json"); writeFileSync(input, JSON.stringify(selection()));
    assert.deepEqual((await harness.runCommand({ command: "ops witnesses", options: { input }, pmRoot: root })).result, reduceDiagnosticWitnesses(selection()));
    await assert.rejects(harness.runCommand({ command: "ops witnesses", options: {}, pmRoot: root }), /Supply --input/);
    const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
    const tracker = join(root, ".agents", "pm");
    const env = { ...process.env, PM_PATH: tracker, GIT_CEILING_DIRECTORIES: dirname(root) };
    const invoke = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...env, PATH: "" }, encoding: "utf8" });
    const init = invoke(["init", "--defaults", "--agent-guidance", "skip"]); assert.equal(init.status, 0, init.stderr);
    const shim = join(root, "extension"); mkdirSync(shim);
    const metadata = { name: "pm-ops", version: "2026.10.25", entry: "./witness-extension.mjs", capabilities: ["commands", "renderers", "schema", "parser", "services"] };
    const entrypoint = pathToFileURL(resolve("dist/index.js")).href;
    const contents = { "manifest.json": JSON.stringify(metadata), "witness-extension.mjs": `export { default } from ${JSON.stringify(entrypoint)};` };
    for (const [name, content] of Object.entries(contents)) writeFileSync(join(shim, name), content);
    const installed = invoke(["package", "install", shim, "--project", "--json"]); assert.equal(installed.status, 0, installed.stderr);
    for (const json of [true, false]) {
      const result = invoke(["ops", "witnesses", "--input", input, ...(json ? ["--json"] : [])]);
      assert.equal(result.status, 0, result.stderr); assert.deepEqual(json ? JSON.parse(result.stdout) : decode(result.stdout), reduceDiagnosticWitnesses(selection()));
      assert.ok(Buffer.byteLength(result.stdout) < 1600);
    }
  } finally { await harness.deactivate(); rmSync(root, { recursive: true, force: true }); }
});


test("documented maximum selection remains complete with finite counts", () => {
  const facts = Array.from({ length: 16 }, (_, index) => ({ id: `fact-${index}`, scope: "max", key: `key-${index}`, value: String(index) }));
  const check = { ...selection().checks[0]!, scope: "max", sufficient: [facts.map((fact) => fact.id)] };
  const report = reduceDiagnosticWitnesses({ version: 1, facts, checks: Array.from({ length: 64 }, (_, index) => ({ ...check, id: `check-${index}` })) });
  assert.equal(report.facts.length, 16); assert.equal(report.affected_checks, 64);
  assert.equal(report.omitted_facts, 0); assert.equal(report.witnesses.length, 1);
  validateDiagnosticWitnessCounts(report);
});

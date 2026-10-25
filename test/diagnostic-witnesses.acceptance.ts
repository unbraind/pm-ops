/** Measure controlled canonical failures and witness size on a read-only public tracker copy. */
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { encode } from "@toon-format/toon";
import { createDiagnosticPlan, executeDiagnosticPlan } from "../diagnostic-plans.ts";
import { reduceDiagnosticWitnesses, type DiagnosticWitnessInput } from "../diagnostic-witnesses.ts";
import { fingerprint } from "./tracker-read-helpers.ts";

/** Change only the owned scratch copy's permissions, including before cleanup. */
function permissions(root: string, readonly: boolean): void {
  chmodSync(root, readonly ? 0o555 : 0o755);
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    chmodSync(join(entry.parentPath, entry.name), readonly ? entry.isDirectory() ? 0o555 : 0o444 : entry.isDirectory() ? 0o755 : 0o644);
  }
}

const source = process.argv.at(2);
assert.ok(source, "Supply a public tracker snapshot directory.");
const scratch = mkdtempSync(join(tmpdir(), "witness-public-"));
const tracker = join(scratch, "tracker");
try {
  process.env.GIT_CEILING_DIRECTORIES = dirname(scratch);
  cpSync(resolve(source), tracker, { recursive: true });
  permissions(tracker, true);
  const before = fingerprint(tracker);
  const local = await createDiagnosticPlan(tracker, ["schema_unreadable", "items_unreadable", "history_invalid"], { processes: 3, network: 0, time_ms: 60000 });
  const verified = await executeDiagnosticPlan(tracker, local, local.id);
  assert.equal(verified.ok, true, JSON.stringify(verified));
  const input: DiagnosticWitnessInput = { version: 1, facts: [
    { id: "ceiling", scope: "public-snapshot", key: "budget.processes", value: "0" },
    { id: "deadline", scope: "public-snapshot", key: "budget.time_ms", value: "60000" },
    { id: "network", scope: "public-snapshot", key: "budget.network", value: "0" },
  ], checks: [] };
  for (let index = 0; index < 6; index++) {
    const plan = await createDiagnosticPlan(tracker, [index < 5 ? "items_unreadable" : "registry_unavailable"], { processes: index < 5 ? 0 : 1, network: 0, time_ms: 60000 });
    const run = await executeDiagnosticPlan(tracker, plan, plan.id);
    assert.equal(run.ok, false); assert.equal(run.rows[0]!.code, index < 5 ? "process_budget" : "network_budget");
    input.checks.push({ id: `public-check-${index + 1}`, scope: "public-snapshot", failure: run.rows[0]!.code,
      command: run.rows[0]!.command, diagnosis: "observed", sufficient: [[index < 5 ? "ceiling" : "network", "deadline"]] });
  }
  const report = reduceDiagnosticWitnesses(input);
  assert.equal(report.witnesses.length, 2); assert.equal(report.witnesses[0]!.checks.length, 5);
  assert.deepEqual(report, reduceDiagnosticWitnesses(JSON.parse(JSON.stringify(input))));
  assert.equal(fingerprint(tracker), before); assert.equal(existsSync(join(scratch, ".git")), false);
  const expanded = input.checks.map((check) => ({ ...check, facts: input.facts.filter((fact) => check.sufficient[0]!.includes(fact.id)) }));
  console.log(JSON.stringify({ source: "public tracker snapshot", files: readdirSync(tracker, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length,
    verified_rows: verified.rows.map(({ command, checked }) => ({ command, checked })), controlled_runs: 6,
    input_facts: report.input_facts, retained_facts: report.facts.length, witnesses: report.witnesses.length,
    affected_checks: report.affected_checks, common_checks: report.witnesses[0]!.checks.length,
    expanded_json_bytes: Buffer.byteLength(JSON.stringify(expanded)), input_json_bytes: Buffer.byteLength(JSON.stringify(input)),
    output_json_bytes: Buffer.byteLength(JSON.stringify(report)), output_toon_bytes: Buffer.byteLength(encode(report)),
    tracker_bytes_unchanged: true, repeated_output_identical: true, non_git: true }));
} finally {
  if (existsSync(tracker)) permissions(tracker, false);
  rmSync(scratch, { recursive: true, force: true });
}

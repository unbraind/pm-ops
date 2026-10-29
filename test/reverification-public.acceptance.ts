/** Aggregate-only validation of a public tracker copy without Git or tracker writes. */
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { encode } from "@toon-format/toon";
import { auditReverificationFiles, compileReverificationPlan, type ReverificationInput } from "../reverification-plans.ts";
import { createDiagnosticPlan, executeDiagnosticPlan } from "../diagnostic-plans.ts";
import { fingerprint } from "./tracker-read-helpers.ts";

/** Change permissions only inside this script's disposable copy, restoring them in finally. */
function readonlyCopy(root: string, readonly: boolean): void {
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    chmodSync(join(entry.parentPath, entry.name), readonly ? (entry.isDirectory() ? 0o555 : 0o444) : (entry.isDirectory() ? 0o755 : 0o644));
  }
  chmodSync(root, readonly ? 0o555 : 0o755);
}

const source = process.argv[2];
if (source === undefined) throw new Error("Supply a public fleet tracker snapshot; this validates only an owned copy.");
const scratch = mkdtempSync(join(tmpdir(), "reverification-public-"));
const tracker = join(scratch, "tracker");
cpSync(resolve(source), tracker, { recursive: true });
process.env.GIT_CEILING_DIRECTORIES = dirname(scratch);
const input: ReverificationInput = { version: 1, claims: [{ id: "health", status: "fresh" }, { id: "recovery", status: "fresh" }], targets: ["health", "recovery"], checks: [
  { id: "sdk:schema:v1", approved: true, cost: 1, requires: [], supports: [] },
  { id: "sdk:items:v1", approved: true, cost: 2, requires: ["sdk:schema:v1"], supports: ["health"] },
  { id: "sdk:history:v1", approved: true, cost: 3, requires: ["sdk:schema:v1"], supports: ["recovery"] },
  { id: "full-pipeline", approved: true, cost: 20, requires: [], supports: ["health", "recovery"] },
] };
const contractFile = join(scratch, "checks.json"); writeFileSync(contractFile, JSON.stringify(input));
const policy = join(scratch, "policy.json"); const versions = join(scratch, "versions.json");
const example = JSON.parse(readFileSync("docs/examples/reverification-policy.json", "utf8")) as { claims: { id: string }[] };
example.claims = example.claims.filter((claim) => input.targets.includes(claim.id));
writeFileSync(policy, JSON.stringify(example)); writeFileSync(versions, readFileSync("docs/examples/evidence-versions.json"));
try {
  readonlyCopy(tracker, true);
  const before = fingerprint(tracker);
  const client = new PmClient({ pmRoot: tracker, noExtensions: true });
  const population = await client.listAllComplete();
  const plan = await auditReverificationFiles(tracker, policy, versions, contractFile, { now: "2026-10-29T00:00:00.000Z" });
  const replay = await auditReverificationFiles(tracker, policy, versions, contractFile, { now: "2026-10-29T00:00:00.000Z" });
  assert.deepEqual(replay, plan);
  input.claims.forEach((claim) => { claim.status = "unavailable"; });
  assert.deepEqual(compileReverificationPlan(input), plan);
  assert.equal(plan.cost, 6); assert.equal(plan.all_cost, 26); assert.equal(plan.saved, 20);
  assert.equal(plan.steps.length, 3); assert.equal(plan.ok, true);
  const probes = await createDiagnosticPlan(tracker, ["schema_unreadable", "items_unreadable", "history_invalid"], { processes: 3, network: 0, time_ms: 60000 });
  const run = await executeDiagnosticPlan(tracker, probes, probes.id);
  assert.equal(run.ok, true); assert.equal(run.used.processes, 3);
  assert.equal(run.rows.find((row) => row.command === "sdk:items:v1")!.checked, population.items.length);
  assert.equal(fingerprint(tracker), before); assert.equal(existsSync(join(scratch, ".git")), false);
  console.log(JSON.stringify({ source: "public pm-ops main tracker snapshot", items: population.items.length,
    files: readdirSync(tracker, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile()).length,
    checked: run.rows.map(({ command, checked }) => ({ command, checked })),
    targets: plan.rows.length, selected_checks: plan.steps.length, shared_prerequisite_occurrences: plan.steps.filter((step) => step.id === "sdk:schema:v1").length,
    declared_cost: plan.cost, all_approved_cost: plan.all_cost, saved: plan.saved,
    gap_count: plan.rows.filter((row) => row.check === null && row.code !== "fresh").length,
    conditional_claims: plan.rows.filter((row) => row.code === "rerun_required").length,
    json_bytes: Buffer.byteLength(JSON.stringify(plan)), toon_bytes: Buffer.byteLength(encode(plan)),
    repeated_plan_identical: true, tracker_bytes_unchanged: true, git_required: false,
    note: "Caller-declared check costs; missing accepted receipts remain conditional even after successful diagnostic reads." }));
} finally { readonlyCopy(tracker, false); rmSync(scratch, { force: true, recursive: true }); }

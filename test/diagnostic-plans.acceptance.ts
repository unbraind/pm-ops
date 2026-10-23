/** Validate a public tracker copy with real SDK probes, reporting only sanitized measurements. */
import assert from "node:assert/strict";
import { assertDiagnosticIdentity, fingerprint } from "./tracker-read-helpers.ts";
import { chmodSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createDiagnosticPlan, executeDiagnosticPlan } from "../diagnostic-plans.ts";

/** Set permissions only on this script's owned disposable tracker. */
function permissions(root: string, readonly: boolean): void {
  chmodSync(root, readonly ? 0o555 : 0o755);
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) chmodSync(join(entry.parentPath, entry.name), readonly ? entry.isDirectory() ? 0o555 : 0o444 : entry.isDirectory() ? 0o755 : 0o644);
}

const source = process.argv[2];
if (!source) throw new Error("Supply a directory containing a public tracker snapshot.");
const scratch = mkdtempSync(join(tmpdir(), "diagnostic-validation-"));
const tracker = join(scratch, "tracker");
cpSync(resolve(source), tracker, { recursive: true });
process.env.GIT_CEILING_DIRECTORIES = dirname(scratch);
try {
  permissions(tracker, true);
  const before = fingerprint(tracker);
  const failures = ["schema_unreadable", "items_unreadable", "history_invalid"] as const;
  const budget = { processes: 3, network: 0, time_ms: 60000 };
  const plan = await createDiagnosticPlan(tracker, failures, budget);
  const first = await executeDiagnosticPlan(tracker, plan, plan.id);
  const second = await executeDiagnosticPlan(tracker, plan, plan.id);
  assertDiagnosticIdentity(first, second);
  const limited = await createDiagnosticPlan(tracker, failures, { ...budget, processes: 1 });
  const stopped = await executeDiagnosticPlan(tracker, limited, limited.id);
  assert.equal(stopped.used.processes, 1); assert.equal(stopped.rows[1]!.code, "process_budget");
  assert.equal(fingerprint(tracker), before);
  console.log(JSON.stringify({ source: "public tracker snapshot", runs: 2, repeat_identity: true, tracker_bytes_unchanged: true,
    files: readdirSync(tracker, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length,
    first, second, stopped, output_bytes: Buffer.byteLength(JSON.stringify(first)) }));
} finally { permissions(tracker, false); rmSync(scratch, { recursive: true, force: true }); }

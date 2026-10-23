import assert from "node:assert/strict";
import type { DiagnosticRun } from "../diagnostic-plans.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

/** Fingerprint every byte, including hidden caches, without relying on Git. */
export function fingerprint(path: string): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(path, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name)).sort()) {
    hash.update(entry.slice(path.length)); hash.update(readFileSync(entry));
  }
  return hash.digest("hex");
}


/** Assert the replay retains the selected artifact, directory binding and ordered catalog. */
export function assertDiagnosticIdentity(first: DiagnosticRun, second: DiagnosticRun): void {
  const identity = (run: DiagnosticRun) => ({ plan: run.plan, scope: run.scope, commands: run.rows.map((row) => row.command) });
  assert.deepEqual(identity(first), identity(second));
}

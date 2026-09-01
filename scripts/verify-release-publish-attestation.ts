/**
 * Command-line launcher and compatibility shim for the canonical
 * publish-attestation auditor.
 *
 * The canonical API exposes structured `recognition`. This retained script
 * keeps the legacy enumerable `{ failures, notes }` result shape so consumers
 * using deep equality, snapshots, or `Object.keys` do not break. Recognition is
 * attached non-enumerably as a transition aid for callers that already read it.
 *
 * @packageDocumentation
 */
import { resolve } from "node:path";

import {
  auditPublishAttestation as canonicalAuditPublishAttestation,
  report,
  type PublishAttestationResult,
  verify as canonicalVerify,
} from "../attestation.ts";
import type { SourceFile } from "../shell-scan.ts";
import { isMainInvocation } from "./main-invocation.ts";

export * from "../attestation.ts";

function legacyResultShape(result: PublishAttestationResult): PublishAttestationResult {
  const legacy = { failures: result.failures, notes: result.notes } as PublishAttestationResult;
  Object.defineProperty(legacy, "recognition", { value: result.recognition, enumerable: false });
  return legacy;
}

/** Audit sources while preserving this shim's legacy enumerable result shape. */
export function auditPublishAttestation(sources: SourceFile[]): PublishAttestationResult {
  return legacyResultShape(canonicalAuditPublishAttestation(sources));
}

/** Verify a repository while preserving this shim's legacy enumerable result shape. */
export function verify(root: string): PublishAttestationResult {
  return legacyResultShape(canonicalVerify(root));
}

/**
 * Verify and report only when this launcher is the process entry point.
 *
 * @param argv - Process arguments to judge.
 * @param moduleUrl - URL of this launcher module.
 * @param root - Repository root to verify.
 * @returns True when verification ran.
 */
export function runIfMain(argv: string[], moduleUrl: string, root: string): boolean {
  if (!isMainInvocation(argv, moduleUrl)) return false;
  report(verify(root), (line) => process.stdout.write(`${line}\n`), (code) => { process.exitCode = code; });
  return true;
}

runIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."));

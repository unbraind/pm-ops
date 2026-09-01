/**
 * Command-line launcher for the canonical publish-attestation auditor.
 *
 * @packageDocumentation
 */
import { resolve } from "node:path";

import { report, verify } from "../attestation.ts";
import { isMainInvocation } from "./main-invocation.ts";

export * from "../attestation.ts";

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

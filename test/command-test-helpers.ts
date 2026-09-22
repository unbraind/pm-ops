import assert from "node:assert/strict";
import type { GlobalOptions } from "@unbrained/pm-cli/sdk";
import type { ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { VerifierResult } from "../shell-scan.ts";

/** Run a command through the real dispatch engine with quiet default globals. */
export async function runCmd<T>(
  ext: ExtensionTestHarness,
  command: string,
  options: Record<string, unknown> = {},
  args: readonly string[] = [],
  globalOverride: Partial<GlobalOptions> = {},
): Promise<T> {
  const { result } = await ext.runCommand({
    command,
    options,
    args,
    global: { json: false, quiet: true, noPager: true, ...globalOverride },
  });
  return result as T;
}

/** Assert a verifier report() prints notes then failures and requests exit code 1. */
export function assertFailingReport(
  report: (result: VerifierResult, write: (line: string) => void, exit: (code: number) => void) => void,
  failingSummary: string,
): void {
  assertReport(report, { failures: ["bad"], notes: ["fine"] }, { lines: ["fine", "FAIL - bad", failingSummary], codes: [1] });
}

/** Assert a verifier report() on a clean result prints its summary and requests no exit code. */
export function assertCleanReport(
  report: (result: VerifierResult, write: (line: string) => void, exit: (code: number) => void) => void,
  cleanNotes: readonly string[],
  cleanSummary: string,
): void {
  assertReport(report, { failures: [], notes: [...cleanNotes] }, { lines: [...cleanNotes, cleanSummary], codes: [] });
}

/** Assert one report() result prints the expected lines and requests the expected exit codes. */
export function assertReport(
  report: (result: VerifierResult, write: (line: string) => void, exit: (code: number) => void) => void,
  result: VerifierResult,
  expected: { lines: readonly string[]; codes: readonly number[] },
): void {
  const lines: string[] = [];
  const codes: number[] = [];
  report(result, (line) => lines.push(line), (code) => codes.push(code));
  assert.deepEqual(lines, expected.lines);
  assert.deepEqual(codes, expected.codes);
}

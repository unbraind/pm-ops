/** Report release completeness, or explicitly repair verifiable missing parts. */
import { resolve } from "node:path";
import { runVerifierIfMain } from "./main-invocation.ts";
import { realFetcher, report, verify, type CompletenessFetcher } from "../release-completeness.ts";
import { makeRepairClient, repairReleaseCompleteness, type RepairClient } from "../release-repair.ts";
export * from "../release-completeness.ts";

/** Run the audit entry point; only the exact --repair option enables writes. */
export function runIfMain(
  argv: string[],
  moduleUrl: string,
  root: string,
  fetcher: CompletenessFetcher = realFetcher,
  client?: RepairClient,
): boolean {
  return runVerifierIfMain(argv, moduleUrl, () => {
    const flags = argv.slice(2);
    if (flags.length > 1 || flags.some((flag) => flag !== "--repair")) {
      return { failures: ["usage: verify-release-completeness [--repair]"], notes: [] };
    }
    return flags.includes("--repair")
      ? repairReleaseCompleteness(root, fetcher, client ?? makeRepairClient())
      : verify(root, fetcher);
  }, report);
}

runIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."));

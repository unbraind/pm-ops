/** Command-line entry for checking a consumer release.yml without running it. */
import { readRegularText } from "../regular-input.ts";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectReleaseCaller, fetchCanonicalReleaseTags } from "../release-caller.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** Report structural drift; file errors propagate and make the command fail closed.
 *
 * The default resolver applies PM_OPS_OFFLINE, so the CLI shares the checker's offline rule.
 */
export function runReleaseCaller(path: string, write: (message: string) => void): boolean | undefined {
  const result = inspectReleaseCaller(readRegularText(path));
  for (const error of result.errors) write(`release-caller: ${error}`);
  return result.status === "unverified-offline" ? undefined : result.status === "verified";
}

/** Execute only for the process entry point so the suite can exercise both paths. */
export function releaseCallerMain(argv: string[], moduleUrl: string): void {
  if (!isMainInvocation(argv, moduleUrl)) return;
  if (argv[2] === "--write-metadata") {
    writeFileSync(resolve(argv[3]), JSON.stringify({ repository: "unbraind/pm-ops", tags: fetchCanonicalReleaseTags() }, null, 2) + "\n");
    return;
  }
  const path = resolve(argv[2] ?? ".github/workflows/release.yml");
  if (runReleaseCaller(path, console.error) === false) process.exitCode = 1;
}
releaseCallerMain(process.argv, import.meta.url);

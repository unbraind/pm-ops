/** Command-line entry for checking a consumer release.yml without running it. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectReleaseCaller, fetchCanonicalReleaseTags } from "../release-caller.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** Report structural drift; file errors propagate and make the command fail closed. */
export function runReleaseCaller(path: string, write: (message: string) => void, online = false): boolean | undefined {
  const result = inspectReleaseCaller(readFileSync(path, "utf8"), online ? () => fetchCanonicalReleaseTags() : undefined);
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
  const online = argv.includes("--online");
  const path = resolve(argv.slice(2).filter(arg => arg !== "--online")[0] ?? ".github/workflows/release.yml");
  if (runReleaseCaller(path, console.error, online) === false) process.exitCode = 1;
}
releaseCallerMain(process.argv, import.meta.url);

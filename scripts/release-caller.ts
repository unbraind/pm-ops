/** Command-line entry for checking a consumer release.yml without running it. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkReleaseCaller } from "../release-caller.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** Report structural drift; file errors propagate and make the command fail closed. */
export function runReleaseCaller(path: string, write: (message: string) => void): boolean {
  const errors = checkReleaseCaller(readFileSync(path, "utf8"));
  for (const error of errors) write(`release-caller: ${error}`);
  return errors.length === 0;
}

/** Execute only for the process entry point so the suite can exercise both paths. */
export function releaseCallerMain(argv: string[], moduleUrl: string): void {
  if (!isMainInvocation(argv, moduleUrl)) return;
  const path = resolve(argv[2] ?? ".github/workflows/release.yml");
  if (!runReleaseCaller(path, console.error)) process.exitCode = 1;
}
releaseCallerMain(process.argv, import.meta.url);

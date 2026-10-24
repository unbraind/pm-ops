/** Run owned Bash fixtures as files, keeping script text out of shared executable arguments. */
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "../subprocess.ts";

/** Preserve real Bash execution and bounded capture without a command-string argument. */
export function runBashFixture(script: string, options: SpawnSyncOptionsWithStringEncoding, flags: readonly string[] = []): SpawnSyncReturns<string> {
  const root = mkdtempSync(join(tmpdir(), "bash-fixture-"));
  try {
    const path = join(root, "fixture.sh");
    writeFileSync(path, script, { mode: 0o600, flag: "wx" });
    return spawnSync("bash", ["--noprofile", "--norc", ...flags, path], options);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/**
 * npm `prepare` hook that registers pm's field-aware Git merge drivers.
 *
 * Git never clones `.git/config`, so every clone must register the drivers
 * `.gitattributes` declares. The installer lives in the devDependency pm-ops,
 * which an `npm install --omit=dev` checkout does not have. This launcher
 * therefore imports nothing from pm-ops: it resolves the installer entry from
 * the package root and runs it in a child process. Only a missing pm-ops package skips, with one
 * notice; any other resolution failure (for example a pm-ops too old to export
 * the entry) and any installer failure fail the install.
 *
 * Canonical copy: `pm-ops/templates/prepare-merge-driver.ts`. Copy it
 * unchanged to `scripts/prepare-merge-driver.ts`.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

// npm runs `prepare` from the package root, so pm-ops is resolved from there.
// A missing package names the specifier; a pm-ops whose entry file is missing
// names the absolute path instead, and must fail rather than skip.
const specifier = "pm-ops/merge-driver/prepare";
let installer: string | undefined;
try {
  installer = createRequire(join(process.cwd(), "package.json")).resolve(specifier);
} catch (error) {
  const packageMissing = error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND" &&
    error.message.startsWith(`Cannot find module '${specifier}'`);
  if (!packageMissing) throw error;
}
if (installer === undefined) {
  console.error("pm-ops is not installed (omit-dev install); skipping merge-driver install");
} else {
  process.exitCode = spawnSync(process.execPath, [installer], { stdio: "inherit" }).status ?? 1;
}

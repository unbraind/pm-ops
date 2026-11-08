/** Inspect every command in bootstrap steps rather than exempting the whole script. */
import assert from "node:assert/strict";
import { tokenizeCommands } from "../shell-scan.ts";

/** Enumerate npm installation commands across shell separators and install aliases. */
function npmInstalls(script: string): string[][] {
  return tokenizeCommands(script).map(command => command.map(token => token.value))
    .filter(words => words[0] === "npm" && words.some(word => ["install", "ci", "i", "add"].includes(word)));
}

/** Keep every metadata-only reconciliation step free of dependency installation. */
export function assertNoNpmInstalls(script: string): void {
  assert.deepEqual(npmInstalls(script), [], "reconciliation must not install npm packages");
}

/** Permit exactly the pinned npm bootstrap, including the Windows Node prefix. */
export function assertPinnedNpmBootstrap(script: string): void {
  const installs = npmInstalls(script);
  assert.equal(installs.length, 1, "only the pinned npm install is allowed");
  const words = installs[0];
  const prefix = words[3] === "--prefix" ? ["--prefix", "$node_prefix"] : [];
  assert.deepEqual(words, ["npm", "install", words[2] === "--global" ? "--global" : "-g", ...prefix, "npm@11.21.0", "--ignore-scripts", "--no-audit", "--no-fund"], "only the pinned npm install is allowed");
}

/** Inspect every command in bootstrap steps rather than exempting the whole script. */
import assert from "node:assert/strict";
import { commandArguments, commandCandidates, commandName, tokenizeCommands } from "../shell-scan.ts";

/** Enumerate npm installation commands across shell separators and install aliases. */
export function npmInstalls(script: string): string[][] {
  return tokenizeCommands(script).flatMap(command => commandCandidates(command))
    .filter(command => /^(?:npm|npm\.cmd)$/.test(commandName(command) ?? ""))
    .map(command => ["npm", ...commandArguments(command).map(token => token.value)])
    .filter(words => words[0] === "npm" && words.some(word => ["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add", "ci", "ic", "clean-install", "install-clean", "isntall-clean", "install-test", "installt", "it", "install-ci-test", "cit", "sit", "clean-install-test"].includes(word.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase()))));
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

/** Source-only controls execute the existing inert Bash corpus against accepted code, then restore every byte. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** Accepted resource repair before the nested semantic candidate. */
const accepted = "158450e07cc5ac3357c5d97fe3bf1281bd57c324";
/** Only production source is replaced; corpus and assertions remain current. */
const files = ["shell-scan.ts", "attestation.ts"];
/** Exact candidate bytes restored even if a negative assertion fails. */
const candidate = files.map(/** Snapshot each source before its independent control. */ (file) => readFileSync(file));
/** Require actual historical source rather than substituting a missing baseline. */
const original = files.map(/** Read each immutable accepted module from Git. */ (file) => {
  const result = spawnSync("git", ["show", `${accepted}:${file}`], { encoding: "utf8" });
  assert.equal(result.status, 0, "source controls require the accepted Git objects and full history");
  return result.stdout;
});

/** Execute genuine corpus assertions, distinguishing semantic failure from setup or resource failure. */
function corpus(pattern: string | undefined, refusal: boolean): void {
  const args = ["--test", ...(pattern === undefined ? [] : [`--test-name-pattern=${pattern}`]), "test/publish-indirection.test.ts"];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, refusal ? 1 : 0, output);
  if (refusal) {
    assert.match(output, /ERR_ASSERTION/, "a loaded auditor must fail the actual verdict assertion");
    assert.match(output, /scope verdict disagrees/, "the inert Bash execution must reach the audit assertion");
    assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|SyntaxError|ETIMEDOUT|fixture did not execute/, "setup and execution errors are not negative evidence");
  }
  console.log(refusal ? "accepted source ASSERTION FAILURE confirmed" : "restored candidate PASS", output.match(/(?:ℹ |# )fail \d+/)?.[0]);
}

try {
  for (const [index, file] of files.entries()) writeFileSync(file, original[index]!);
  corpus("real indirect publish (28|29|30|31|32|33|34|35|36|37|55|56|57) ", true);
  // Retain the repaired scanner, restoring only accepted parent preprocessing.
  // New recursion reaches the child unset that this preprocessing mis-scopes.
  writeFileSync(files[0]!, candidate[0]!);
  corpus("real Bash scope control (1|2|3|4|7) ", true);
} finally {
  for (const [index, file] of files.entries()) writeFileSync(file, candidate[index]!);
  for (const [index, file] of files.entries()) assert.deepEqual(readFileSync(file), candidate[index]);
}
corpus(undefined, false);

/** Function-only Compose extraction revert retains all candidate classifiers and regression tests. */
import assert from "node:assert/strict";
import { spawnSync } from "../subprocess.ts";
import { readFileSync, writeFileSync } from "node:fs";

/** This is the sole implementation file mutated temporarily by the proof. */
const file = "attestation.ts";
const candidate = readFileSync(file, "utf8");
const start = candidate.indexOf("function composeExecutableBodies(");
const end = candidate.indexOf("\n}\n", start) + 3;
const brace = candidate.indexOf("{\n", start);
assert.ok(start >= 0 && brace > start && end > brace);
/** Restore precisely the previous whole-document shell behavior at the new extraction boundary. */
const reverted = candidate.slice(0, brace) + "{\n  return [{ text: source.text, raw: source.text, line: 1 }];\n}\n" + candidate.slice(end);

/** Only assertion failures count as negative evidence; setup or loader errors abort the proof. */
function run(label: string, expectFailure: boolean): void {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/compose-attestation.test.ts"], { encoding: "utf8" });
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, expectFailure ? 1 : 0, output);
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|SyntaxError|ETIMEDOUT/u);
  if (expectFailure) {
    assert.match(output, /not ok 1 - compose acceptance: an apostrophe/u);
    assert.match(output, /ERR_ASSERTION/u);
  } else assert.match(output, /# fail 0\b/u);
  console.log(`${label}: ${output.match(/# pass \d+/u)?.[0]}, ${output.match(/# fail \d+/u)?.[0]}`);
}

try {
  run("CANDIDATE", false);
  writeFileSync(file, reverted);
  run("REVERT composeExecutableBodies ONLY", true);
} finally {
  writeFileSync(file, candidate);
  assert.equal(readFileSync(file, "utf8"), candidate);
}
run("RESTORED CANDIDATE", false);

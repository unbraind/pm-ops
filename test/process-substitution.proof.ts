/** Remove only process-child discovery per word context, then restore candidate bytes. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** Source imports let each mutation exercise the scanner without stale build artifacts. */
const file = "shell-scan.ts", candidate = readFileSync(file, "utf8");
/** Exact new discovery branch; other substitution behavior remains unchanged. */
const marker = '((character === "$" || character === "<" || character === ">") && text[index + 1] === "(")';
assert.equal(candidate.split(marker).length, 2);

/** Require assertion failures and exact counts, rejecting setup or syntax failures. */
function check(label: string, pattern: string, passes: number, failures: number): void {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=${pattern}`, "test/regex-array.test.ts"], { encoding: "utf8" });
  const transcript = result.stdout + result.stderr;
  assert.equal(result.error, undefined);
  assert.equal(result.status, failures === 0 ? 0 : 1, transcript);
  for (const [key, count] of [["pass", passes], ["fail", failures]] as const) {
    assert.match(transcript, new RegExp(`# ${key} ${count}\\b`), transcript);
  }
  assert.doesNotMatch(transcript, /ERR_MODULE_NOT_FOUND|SyntaxError|ETIMEDOUT/u);
  if (failures > 0) assert.match(transcript, /ERR_ASSERTION/u);
  console.log(`${label}: ${passes} pass; ${failures} assertion failures`);
}

try {
  check("candidate refusal and child controls", "^process substitution (refusal|child):", 30, 0);
  for (const [context, disabled] of [
    ["array", "arrayAssignment"],
    ["conditional", "conditional"],
    ["case", 'cases.at(-1) === "pattern"'],
  ]) {
    const replacement = `((character === "$" || ((character === "<" || character === ">") && !(${disabled}))) && text[index + 1] === "(")`;
    writeFileSync(file, candidate.replace(marker, replacement));
    check(`${context} discovery reverted: direct refusals`, `^process substitution refusal: ${context} [<>] nested=false$`, 0, 2);
    check(`${context} discovery reverted: child extents`, `^process substitution child: ${context} `, 0, 2);
  }
  writeFileSync(file, candidate.replace(marker, '(character === "$" && text[index + 1] === "(")'));
  check("ordinary context discovery reverted: child extents", "^process substitution child: (argument|command) ", 0, 4);
} finally {
  writeFileSync(file, candidate);
  assert.equal(readFileSync(file, "utf8"), candidate);
}
check("restored candidate", "^process substitution|^a process substitution|^fleet acceptance", 40, 0);

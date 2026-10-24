/** Scoped behavioral reverts retain current tests and restore all candidate source. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "../subprocess.ts";
import { readFileSync, writeFileSync } from "node:fs";

/** Scanner control bytes come from the stable parent containing #171. */
const file = "shell-scan.ts", candidate = readFileSync(file, "utf8");
const oldSource = execFileSync("git", ["show", "84221c8:shell-scan.ts"], { encoding: "utf8" });

/** Restore one complete baseline function while retaining the other candidate functions. */
function oldFunction(name: string): string {
  const marker = `function ${name}(`;
  const first = candidate.indexOf(marker);
  const last = candidate.indexOf("\n}\n", first) + 3;
  const oldFirst = oldSource.indexOf(marker);
  const oldLast = oldSource.indexOf("\n}\n", oldFirst) + 3;
  assert.ok(first >= 0 && last > first && oldFirst >= 0 && oldLast > oldFirst);
  return candidate.slice(0, first) + oldSource.slice(oldFirst, oldLast) + candidate.slice(last);
}

/** Verify actual assertion counts so setup failures cannot count as revert evidence. */
function check(label: string, pattern: string, passes: number, failures: number): void {
  const processResult = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=${pattern}`, "test/regex-array.test.ts"], { encoding: "utf8" });
  const transcript = processResult.stdout + processResult.stderr;
  assert.equal(processResult.error, undefined);
  assert.equal(processResult.status, failures === 0 ? 0 : 1, transcript);
  for (const [key, expected] of [["pass", passes], ["fail", failures]] as const) {
    assert.match(transcript, new RegExp(`# ${key} ${expected}\\b`), transcript);
  }
  assert.doesNotMatch(transcript, /ERR_MODULE_NOT_FOUND|SyntaxError|ETIMEDOUT/u);
  if (failures !== 0) assert.match(transcript, /ERR_ASSERTION/u);
  console.log(`${label}: ${passes} pass; ${failures} assertion failures`);
}

try {
  check("candidate", "fleet acceptance", 3, 0);
  writeFileSync(file, oldFunction("scanShellCommands"));
  check("scanner reverted: exact regex lines", "fleet acceptance [12]:", 0, 2);
  check("scanner reverted: exact quoted array", "fleet acceptance 3:", 0, 1);
  check("scanner reverted: variable case patterns", '^case pattern acceptance: case "\\$x" in "\\$\\{PM_SYNC_TRACKER', 0, 2);
  writeFileSync(file, oldFunction("scanCommandPrefix"));
  check("prefix reverted: append with unresolved elements", "word acceptance: values\\+=", 0, 1);
} finally {
  writeFileSync(file, candidate);
  assert.equal(readFileSync(file, "utf8"), candidate);
}
check("restored candidate", "fleet acceptance", 3, 0);

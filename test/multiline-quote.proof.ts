/** Function-only revert controls retain current Bash fixtures and restore candidate bytes. */
import assert from "node:assert/strict";
import { spawnSync } from "../subprocess.ts";
import { readFileSync, writeFileSync } from "node:fs";

/** Immutable main revision from which the candidate was created. */
const baseline = "6ec0512";
/** Only the scanner's two modified functions are replaced by the controls. */
const file = "shell-scan.ts";
const candidate = readFileSync(file, "utf8");
const accepted = spawnSync("git", ["show", `${baseline}:${file}`], { encoding: "utf8" });
assert.equal(accepted.status, 0, accepted.stderr);

/** Replace exactly one top-level function, preserving all other candidate source. */
function revert(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  const end = source.indexOf("\n}\n", start) + 3;
  const oldStart = accepted.stdout.indexOf(marker);
  const oldEnd = accepted.stdout.indexOf("\n}\n", oldStart) + 3;
  assert.ok(start >= 0 && end > start && oldStart >= 0 && oldEnd > oldStart);
  return source.slice(0, start) + accepted.stdout.slice(oldStart, oldEnd) + source.slice(end);
}

/** Require assertion failures, never loader or Bash setup errors, for negative evidence. */
function run(pattern: string, pass: number, fail: number): void {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=${pattern}`, "test/multiline-quote.test.ts"], { encoding: "utf8" });
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, fail > 0 ? 1 : 0, output);
  assert.match(output, new RegExp(`# pass ${pass}\\b`), output);
  assert.match(output, new RegExp(`# fail ${fail}\\b`), output);
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|SyntaxError|ETIMEDOUT/u);
  if (fail > 0) assert.match(output, /ERR_ASSERTION/u);
  console.log(`${pattern}: ${pass} pass, ${fail} assertion failures`);
}

try {
  console.log("CANDIDATE");
  run("multiline", 24, 0);
  console.log("REVERT readSubstitution ONLY");
  writeFileSync(file, revert(candidate, "readSubstitution"));
  run("multiline acceptance:", 0, 4);
  run("multiline refusal:", 11, 0);
  run("multiline unterminated refusal:", 5, 0);
  console.log("REVERT BOTH CHANGED FUNCTIONS");
  writeFileSync(file, revert(revert(candidate, "readSubstitution"), "scanShellCommands"));
  run("multiline acceptance:", 0, 4);
  run("multiline refusal:", 11, 0);
  run("multiline unterminated refusal:", 0, 5);
} finally {
  writeFileSync(file, candidate);
  assert.equal(readFileSync(file, "utf8"), candidate);
}
console.log("RESTORED CANDIDATE");
run("multiline", 24, 0);

/** Missing historical Git evidence must stop native consumer proofs with a useful diagnostic. */
import assert from "node:assert/strict";
import { spawnSync } from "../subprocess.ts";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { historicalExecute, historicalProof, historicalRun } from "./fixtures/historical-windows-proof.ts";
import { replaceFunction } from "./function-control.ts";

test("Windows source-only proof refuses an actually absent historical commit", () => {
  const objects = mkdtempSync(join(tmpdir(), "pm-ops-history-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" };
    const missing = spawnSync("git", ["cat-file", "-e", "3fca1f2561719bdbf062160b652be1cbe907c51b^{commit}"], { env });
    assert.equal(missing.error, undefined);
    assert.notEqual(missing.status, 0, "historical commit must really be absent from the selected object store");
    const previousFile = join(objects, "previous-proof.ts");
    writeFileSync(previousFile, historicalProof);
    writeFileSync(join(objects, "npm-launcher.ts"), readFileSync("test/npm-launcher.ts", "utf8").replace('"../subprocess.ts"', '"./subprocess.ts"'));
    copyFileSync("subprocess.ts", join(objects, "subprocess.ts"));
    const previous = spawnSync(process.execPath, [previousFile], { env, encoding: "utf8", timeout: 30_000 });
    assert.equal(previous.error, undefined);
    assert.notEqual(previous.status, 0);
    assert.match(previous.stderr, process.platform === "win32"
      ? /Command failed: git show ea29cb425a72b6729d24b00df4573e8c092c7cfa:test\/pack-prepare.test.ts/
      : /These controls require native Windows/);
    assert.doesNotMatch(previous.stderr, /Historical source-only proof commit .* is unavailable/);
    console.log("previous source lacks missing-history diagnostic", process.platform);
    const result = spawnSync(process.execPath, ["test/windows-consumers.proof.ts"], { env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Historical source-only proof commit 3fca1f2561719bdbf062160b652be1cbe907c51b is unavailable; fetch full branch history \(fetch-depth: 0\) before rerunning; no historical proof was skipped/);
    assert.doesNotMatch(result.stdout, /source-only revert rejected|rejected before packing/);
    console.log("repaired source refuses missing history explicitly");
  } finally {
    rmSync(objects, { recursive: true, force: true });
  }
});

/** Frozen launcher functions must replace only their own behavior, retaining current assertions. */
test("Windows historical launcher controls retain the current consumer assertions", () => {
  for (const [file, name, previous] of [
    ["test/pack-prepare.test.ts", "execute", historicalExecute],
    ["test/packed-consumer.acceptance.ts", "run", historicalRun],
  ] as const) {
    const current = readFileSync(file, "utf8");
    const reverted = replaceFunction(current, name, previous);
    assert.notEqual(reverted, current);
    assert.ok(reverted.includes(previous));
    assert.ok(reverted.includes(file.endsWith(".test.ts") ? "real npm pack never mutates" : "packed nested auditor and actual SDK activation PASS"));
  }
  assert.throws(() => replaceFunction("", "run", historicalRun), /exactly one function/);
  assert.throws(() => replaceFunction("function run() {}\nfunction run() {}", "run", historicalRun), /already been declared|exactly one function/);
});

/** Missing historical Git evidence must stop native consumer proofs with a useful diagnostic. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Windows source-only proof refuses an actually absent historical commit", () => {
  const objects = mkdtempSync(join(tmpdir(), "pm-ops-history-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" };
    const missing = spawnSync("git", ["cat-file", "-e", "ea29cb425a72b6729d24b00df4573e8c092c7cfa^{commit}"], { env });
    assert.equal(missing.error, undefined);
    assert.notEqual(missing.status, 0, "historical commit must really be absent from the selected object store");
    const previousFile = join(objects, "previous-proof.ts");
    writeFileSync(previousFile, execFileSync("git", ["show", "b89fd6f36adf91c9bfc784c7ab643d9ce9cb7eae:test/windows-consumers.proof.ts"]));
    copyFileSync("test/npm-launcher.ts", join(objects, "npm-launcher.ts"));
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
    assert.match(result.stderr, /Historical source-only proof commit ea29cb425a72b6729d24b00df4573e8c092c7cfa is unavailable; fetch full branch history \(fetch-depth: 0\) before rerunning; no historical proof was skipped/);
    assert.doesNotMatch(result.stdout, /source-only revert rejected|rejected before packing/);
    console.log("repaired source refuses missing history explicitly");
  } finally {
    rmSync(objects, { recursive: true, force: true });
  }
});

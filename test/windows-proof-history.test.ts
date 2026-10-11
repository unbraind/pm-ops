/** Frozen function controls remain available when the original PR commits are absent. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { historicalExecute, historicalRun } from "./historical-launchers.ts";
import { replaceFunction } from "./function-control.ts";

test("Windows function controls survive an absent original Git object store", /** Retain only the intended old functions and keep the current surrounding assertions without historical Git availability. */ () => {
  const objects = mkdtempSync(join(tmpdir(), "pm-ops-history-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" };
    const missing = spawnSync("git", ["cat-file", "-e", "ea29cb425a72b6729d24b00df4573e8c092c7cfa^{commit}"], { env });
    assert.equal(missing.error, undefined);
    assert.notEqual(missing.status, 0, "original commit must really be absent");
    for (const [file, name, previous] of [
      ["test/pack-prepare.test.ts", "execute", historicalExecute],
      ["test/packed-consumer.acceptance.ts", "run", historicalRun],
    ]) {
      const current = readFileSync(file!, "utf8");
      const reverted = replaceFunction(current, name!, previous!);
      assert.notEqual(reverted, current);
      assert.ok(reverted.includes(previous!));
      assert.ok(reverted.includes(file!.endsWith(".test.ts") ? "real npm pack never mutates" : "developmentCliVersion(source)"),
        "surrounding fixed assertions and dependency contract remain present");
    }
    assert.throws(() => replaceFunction("", "run", historicalRun), /exactly one function/);
    assert.throws(() => replaceFunction("function run() {}\nfunction run() {}", "run", historicalRun), /already been declared|exactly one function/);
    if (process.platform !== "win32") {
      const result = spawnSync(process.execPath, ["test/windows-consumers.proof.ts"], { env, encoding: "utf8", timeout: 30_000 });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /These controls require native Windows/);
      assert.doesNotMatch(result.stderr, /Historical source-only proof commit/);
    }
  } finally {
    rmSync(objects, { recursive: true, force: true });
  }
});

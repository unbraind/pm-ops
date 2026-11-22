/** Exercise acceptance cleanup without rerunning the nested release gate. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { spawnSync } from "../subprocess.ts";

test("release heading acceptance removes its checkout on command failure and interruption", { skip: process.platform === "win32" }, t => {
  const root = mkdtempSync(join(tmpdir(), "release-heading-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const scratch = join(root, "scratch");
  mkdirSync(bin);
  mkdirSync(scratch);
  const acceptance = resolve("test/release-heading-full-gate.acceptance.ts");
  for (const [signal, code] of [[undefined, 1], ["TERM", 143], ["INT", 130]] as const) {
    const interrupt = signal ? `kill -${signal} "$PPID"\nsleep 1\n` : "";
    writeFileSync(join(bin, "git"), "#!/bin/sh\necho clone-started >&2\n" + interrupt + "exit 79\n", { mode: 0o755 });
    const result = spawnSync(process.execPath, [acceptance], {
      env: { NODE_OPTIONS: process.env.NODE_OPTIONS, PATH: [bin, process.env.PATH].join(delimiter), TMPDIR: scratch },
      encoding: "utf8", timeout: 10_000,
    });
    assert.match(result.stderr, /clone-started/);
    assert.deepEqual(readdirSync(scratch), [], String(signal));
    assert.equal(result.status, code, result.stderr);
  }
});

/** Prove the runtime guard executes as plain committed JavaScript before native TypeScript. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../subprocess.ts";
import { assertContinuationRuntime, assertContinuationSelection } from "../continuation-runtime.ts";
import { assertContinuationSelection as compiledSelection } from "../dist/continuation-runtime.js";

test("continuation runtime and caller selectors enforce the native TypeScript floor", () => {
  for (const value of ["20.19.0", "22.17.9", "23.5.0", "invalid"]) assert.throws(() => assertContinuationRuntime(value), /22.18.0/);
  for (const value of ["22.18.0", "23.6.0", "24.0.0", "26.0.0"]) assertContinuationRuntime(value);
  for (const value of ["20", "22.17", "23.5", 22]) assert.throws(() => assertContinuationSelection(value), /22.18.0/);
  for (const value of ["22", "22.x", "22.18.0", "23", "23.6", "24", "lts/*"]) assertContinuationSelection(value);
  compiledSelection("24"); assert.throws(() => compiledSelection("20"), /22.18.0/);
});

test("committed JavaScript refuses an unsupported runtime before invoking TypeScript", () => {
  const root = mkdtempSync(join(tmpdir(), "continuation-floor-"));
  try {
    const preload = join(root, "version.mjs");
    writeFileSync(preload, 'Object.defineProperty(process.versions,"node",{value:"20.19.0"});\n');
    const result = spawnSync(process.execPath, ["--import", preload, fileURLToPath(new URL("../dist/continuation-runtime.js", import.meta.url))], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /requires Node.js 22.18.0/);
    const native = spawnSync(process.execPath, ["--import", preload, fileURLToPath(new URL("../continuation-runtime.ts", import.meta.url))], { encoding: "utf8" });
    assert.equal(native.status, 1); assert.match(native.stderr, /requires Node.js 22.18.0/);
    const valid = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/continuation-runtime.js", import.meta.url))], { encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);
    const imported = spawnSync(process.execPath, ["--import", preload, "--import", new URL("../continuation-runtime.ts", import.meta.url).href, "-e", ""], { encoding: "utf8" });
    assert.equal(imported.status, 0, imported.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

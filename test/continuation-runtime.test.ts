/** Prove the runtime guard executes as plain committed JavaScript before native TypeScript. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../subprocess.ts";
import { assertContinuationRuntime, assertContinuationSelection } from "../continuation-runtime.ts";
import { assertContinuationRuntime as compiledRuntime, assertContinuationSelection as compiledSelection } from "../dist/continuation-runtime.js";

test("runtime and selector diagnostics name every supported runtime band", () => {
  for (const runtime of [assertContinuationRuntime, compiledRuntime]) for (const value of ["20.19.0", "22.17.9", "23.0.0", "23.5.0", "invalid"]) {
    assert.throws(() => runtime(value), /22\.18\.0.*major 22.*23\.6\.0/);
  }
  for (const select of [assertContinuationSelection, compiledSelection]) for (const value of [">=20 <21", ">=23 <23.6", "lts/iron", 22]) {
    assert.throws(() => select(value), /22\.18\.0.*major 22.*23\.6\.0/);
  }
});

test("continuation runtime and caller selectors enforce the native TypeScript floor", () => {
  for (const value of ["20.19.0", "22.17.9", "23.5.0", "invalid"]) assert.throws(() => assertContinuationRuntime(value), /22.18.0/);
  for (const value of ["22.18.0", "23.6.0", "24.0.0", "26.0.0"]) assertContinuationRuntime(value);
  for (const value of ["20", "22.17", "23.5", 22]) assert.throws(() => assertContinuationSelection(value), /22.18.0/);
  for (const value of ["22", "22.x", "22.18.0", "23", "23.6", "24", "lts/*"]) assertContinuationSelection(value);
  compiledSelection("24"); assert.throws(() => compiledSelection("20"), /22.18.0/);
});

test("named LTS selectors reject obsolete runtimes and retain current and future names", () => {
  for (const name of ["argon", "boron", "carbon", "dubnium", "erbium", "fermium", "gallium", "hydrogen", "iron", "IRON"]) {
    assert.throws(() => assertContinuationSelection("lts/" + name), /22.18.0/);
  }
  for (const value of [" lts/iron ", " 20 "]) assert.throws(() => assertContinuationSelection(value), /22.18.0/);
  for (const value of ["lts/jod", "lts/krypton", "lts/*", "node", "24", "26"]) assertContinuationSelection(value);
});

test("committed JavaScript refuses an unsupported runtime before invoking TypeScript", () => {
  const root = mkdtempSync(join(tmpdir(), "continuation-floor-"));
  try {
    const preload = join(root, "version.mjs");
    for (const version of ["20.19.0", "23.5.0"]) {
      writeFileSync(preload, `Object.defineProperty(process.versions,"node",{value:${JSON.stringify(version)}});\n`);
      const result = spawnSync(process.execPath, ["--import", preload, fileURLToPath(new URL("../dist/continuation-runtime.js", import.meta.url))], { encoding: "utf8" });
      assert.equal(result.status, 1); assert.match(result.stderr, /requires Node.js 22.18.0/); assert.match(result.stderr, /23\.6\.0/);
      const native = spawnSync(process.execPath, ["--import", preload, fileURLToPath(new URL("../continuation-runtime.ts", import.meta.url))], { encoding: "utf8" });
      assert.equal(native.status, 1); assert.match(native.stderr, /requires Node.js 22.18.0/); assert.match(native.stderr, /23\.6\.0/);
    }
    const valid = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/continuation-runtime.js", import.meta.url))], { encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);
    const imported = spawnSync(process.execPath, ["--import", preload, "--import", new URL("../continuation-runtime.ts", import.meta.url).href, "-e", ""], { encoding: "utf8" });
    assert.equal(imported.status, 0, imported.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

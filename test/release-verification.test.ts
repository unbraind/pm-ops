/** Verify the Bun adapter against real npm scripts, without simulating process success. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyBunScript } from "../release-verification.ts";

test("Bun verification executes one named gate and propagates missing or failing scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "release-bun-"));
  const before = process.cwd();
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "verify:release": "node verify.cjs", "verify:failure": "node -e \"process.exit(7)\"" } }));
    writeFileSync(join(root, "verify.cjs"), "require('node:fs').writeFileSync('verified.txt', 'passed');\n");
    process.chdir(root);
    verifyBunScript("verify:release");
    assert.equal(readFileSync("verified.txt", "utf8"), "passed");
    assert.throws(() => verifyBunScript("verify:failure"), /Command failed/);
    assert.throws(() => verifyBunScript("missing:script"), /Command failed/);
    for (const invalid of ["", "--eval", "../file", "verify;echo", "verify:release\n", "verify\r"]) {
      assert.throws(() => verifyBunScript(invalid), /one npm script name/);
    }
  } finally {
    process.chdir(before);
    rmSync(root, { recursive: true, force: true });
  }
});

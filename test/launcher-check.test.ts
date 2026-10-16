/** Frozen bootstrap and released-copy compatibility are independent contracts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertCanonicalLauncher, FROZEN_LAUNCHER_SHA256 } from "../launcher-check.ts";
import { assertCanonicalLauncher as publishedAssertion } from "pm-ops/launcher-check";

const template = join(import.meta.dirname, "../templates/prepare-merge-driver.ts");

test("frozen v1 launcher bytes cannot change without a versioned hash decision", () => {
  assert.equal(createHash("sha256").update(readFileSync(template)).digest("hex"), FROZEN_LAUNCHER_SHA256);
  assertCanonicalLauncher(template);
  publishedAssertion(template);
});

test("every released launcher revision remains accepted by source and published exports", () => {
  const fixtures = join(import.meta.dirname, "fixtures/launchers");
  const revisions = readdirSync(fixtures).filter((file) => file.endsWith(".txt"));
  assert.equal(revisions.length, 5);
  for (const file of revisions) {
    assertCanonicalLauncher(join(fixtures, file));
    publishedAssertion(join(fixtures, file));
  }
});

test("canonical assertion rejects altered or empty content and propagates read errors", () => {
  const root = mkdtempSync(join(tmpdir(), "launcher-check-"));
  try {
    const file = join(root, "launcher.ts");
    for (const content of ["", readFileSync(template, "utf8") + "\n", "process.exit(0);\n"]) {
      writeFileSync(file, content);
      for (const check of [assertCanonicalLauncher, publishedAssertion]) {
        assert.throws(() => check(file), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Unrecognized pm-ops prepare launcher \(SHA-256 [a-f0-9]{64}\)/);
          assert.ok(!error.message.includes(root));
          return true;
        });
      }
    }
    assert.throws(() => assertCanonicalLauncher(join(root, "absent")), { code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A migrated consumer keeps the canonical attestation gate without a private publisher copy. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditPublishAttestation, verify } from "../attestation.ts";

const releasedSha = "c3af218f2f052cc4fddb3e84ef87974c58283be7";
const caller = readFileSync(new URL("../templates/release-caller.yml", import.meta.url), "utf8").replaceAll("0".repeat(40), releasedSha);
const file = ".github/workflows/release.yml";

test("a canonical pinned caller is explicit delegated evidence, while empty or foreign scans still fail", () => {
  const result = auditPublishAttestation([{ file, text: caller }]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.recognition, { kind: "recognized", count: 1 });
  assert.match(result.notes[0], /canonical release delegation to unbraind\/pm-ops/);
  assert.match(result.notes[0], /publisher enforcement belongs to that pinned pm-ops workflow/);
  const fork = auditPublishAttestation([{ file, text: caller.replace(releasedSha, "f".repeat(40)) }]);
  assert.ok(fork.failures.length > 0);
  assert.deepEqual(fork.recognition, { kind: "none" });
  for (const text of [caller.replace(releasedSha, "main"), caller.replace(releasedSha, "0".repeat(40)), caller.replace("unbraind/pm-ops", "foreign/pm-ops"), caller.replace("daily-release.yml", "other.yml"), caller.replace(" # v2026.10.19", ""), caller.replace("  release:", "  release:\n    steps: []")]) {
    const rejected = auditPublishAttestation([{ file, text }]);
    assert.ok(rejected.failures.length > 0, text);
    assert.deepEqual(rejected.recognition, { kind: "none" });
  }
  assert.deepEqual(auditPublishAttestation([]).recognition, { kind: "none" });
  assert.ok(auditPublishAttestation([{ file: ".github/workflows/other.yml", text: caller }]).failures.length > 0);
});

test("delegation never hides a local, foreign, unresolved, or malformed publish path", () => {
  for (const text of ["npm publish", "bun publish", '"$PUBLISHER" publish', "FLAGS=(--no-provenance)\nnpm publish \"${FLAGS[@]}\""]) {
    const result = auditPublishAttestation([{ file, text: caller }, { file: "scripts/publish.sh", text }]);
    assert.ok(result.failures.some(failure => failure.includes("scripts/publish.sh")), text);
    assert.deepEqual(result.recognition, { kind: "recognized", count: 2 });
  }
  const mixed = auditPublishAttestation([{ file, text: caller }, { file: "scripts/publish.sh", text: "npm publish --provenance" }]);
  assert.deepEqual(mixed.failures, []);
  assert.deepEqual(mixed.recognition, { kind: "recognized", count: 2 });
  const malformed = auditPublishAttestation([{ file, text: caller }, { file: ".github/workflows/bad.yml", text: "jobs: [" }]);
  assert.ok(malformed.failures.length > 0);
  assert.deepEqual(malformed.notes, []);
});

test("the real tracked-source verifier accepts a consumer migration and catches an added unguarded publisher", () => {
  const root = mkdtempSync(join(tmpdir(), "release-caller-audit-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, file), caller);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "release:check": "node check.cjs" } }));
    execFileSync("git", ["add", file, "package.json"], { cwd: root });
    assert.deepEqual(verify(root).failures, []);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "release:check": "node check.cjs", unsafe: "npm publish" } }));
    assert.ok(verify(root).failures.some(failure => failure.includes("package.json")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

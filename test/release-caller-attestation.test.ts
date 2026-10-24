/** A migrated consumer keeps the canonical attestation gate without a private publisher copy. */
import assert from "node:assert/strict";
import { execFileSync } from "../subprocess.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditPublishAttestation, verify, report } from "../attestation.ts";

import { releaseCallerFixture } from "./canonical-tags-fixture.ts";

const { releasedSha, canonical, caller, api } = releaseCallerFixture();
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


test("attestation verifies newest release pins online and explicitly defers offline without certifying or hiding publishers", () => {
  const sha = "e".repeat(40), tag = "v2099.10.19";
  const newest = caller.replace(releasedSha, sha).replace("v2026.10.19", tag);
  api.setTags({ [tag]: sha });
  try {
    const online = auditPublishAttestation([{ file, text: newest }]);
    assert.deepEqual(online.failures, []);
    assert.deepEqual(online.recognition, { kind: "recognized", count: 1 });
    assert.match(online.notes[0], /canonical release delegation/);
    const fork = auditPublishAttestation([{ file, text: newest.replace(sha, "f".repeat(40)) }]);
    assert.ok(fork.failures.length > 0);
    assert.deepEqual(fork.recognition, { kind: "none" });
    api.setTags(null);
    const offline = auditPublishAttestation([{ file, text: newest }]);
    assert.deepEqual(offline.failures, []);
    assert.deepEqual(offline.recognition, { kind: "unverified-offline" });
    assert.match(offline.notes[0], /SHA provenance.*not verified; attestation deferred/);
    const lines: string[] = [];
    report(offline, line => lines.push(line), () => assert.fail("offline deferral must not fail the gate"));
    assert.match(lines.at(-1)!, /unverified-offline; attestation deferred/);
    assert.ok(lines.every(line => !line.includes("every publish invocation is attested")));
    const adjacent = auditPublishAttestation([{ file, text: newest }, { file: "scripts/publish.sh", text: "npm publish" }]);
    assert.ok(adjacent.failures.some(failure => failure.includes("scripts/publish.sh")));
  } finally { api.setTags(canonical); }
});

test("PM_OPS_OFFLINE defers the attestation audit's default resolver instead of verifying against the network", () => {
  const sha = "d".repeat(40), tag = "v2099.12.25";
  const newest = caller.replace(releasedSha, sha).replace("v2026.10.19", tag);
  const previous = process.env.PM_OPS_OFFLINE;
  api.setTags({ [tag]: sha });
  try {
    process.env.PM_OPS_OFFLINE = "1";
    const deferred = auditPublishAttestation([{ file, text: newest }]);
    assert.deepEqual(deferred.failures, []);
    assert.equal(deferred.recognition.kind, "unverified-offline", "offline mode must defer a newest pin the network would verify");
  } finally {
    if (previous === undefined) delete process.env.PM_OPS_OFFLINE;
    else process.env.PM_OPS_OFFLINE = previous;
    api.setTags(canonical);
  }
});

/** State-machine fixtures for durable intent, late CI and hostile continuation inputs. */
import assert from "node:assert/strict";
import test from "node:test";
import { decideReleaseContinuation, ownsContinuationPr, releaseConfigDigest, releaseDigest, validateReleaseCandidate,
  type ReleaseCandidate, type ContinuationEvidence } from "../release-continuation.ts";

import { candidateFixture, evidenceFixture } from "./release-continuation-fixture.ts";

test("CI pending beyond 30 minutes releases preparation; suppressed bot push is recovered by a later hourly pass exactly once", () => {
  const c = candidateFixture(), e = evidenceFixture();
  let publications = 0;
  e.pr.merged = false;
  e.pr.state = "open";
  e.mainSha = c.baseSha;
  e.requiredChecks = ["PENDING"];
  // No elapsed-time deadline or push notification is an input to the real decision path.
  for (const elapsed of [0, 1801, 7200]) {
    assert.equal(decideReleaseContinuation(c, e), "pending", String(elapsed));
    assert.equal(publications, 0);
  }
  e.pr.merged = true; e.pr.state = "closed"; e.requiredChecks = ["SUCCESS"]; e.mainSha = e.pr.mergedSha!;
  assert.equal(decideReleaseContinuation(c, e), "publish");
  publications++;
  e.attempted = true; e.registry = "verified";
  assert.equal(decideReleaseContinuation(c, e), "recover", "crash after npm success must not publish again");
  e.tagSha = e.pr.mergedSha; e.releaseSha = e.pr.mergedSha;
  for (let duplicate = 0; duplicate < 3; duplicate++) assert.equal(decideReleaseContinuation(c, e), "complete");
  assert.equal(publications, 1);
});

test("a pending PR whose base advanced requests one daily refresh instead of waiting behind forever", () => {
  const c = candidateFixture(), e = evidenceFixture(); e.pr.merged = false;
  assert.equal(decideReleaseContinuation(c, e), "refresh");
});

for (const [name, change] of [
  ["fork PR", (e: ContinuationEvidence) => { e.pr.headRepository = "foreign/package"; }],
  ["foreign branch", (e: ContinuationEvidence) => { e.pr.branch = "feature/release"; }],
  ["changed head", (e: ContinuationEvidence) => { e.pr.head = "9".repeat(40); }],
  ["stale artifact", (e: ContinuationEvidence) => { e.artifactSha256 = "0".repeat(64); }],
] as const) test(`${name} is refused by the publication decision`, () => {
  const e = evidenceFixture(); change(e);
  assert.throws(() => decideReleaseContinuation(candidateFixture(), e));
});

test("continuation revalidates repository, default branch, workflow, config, ownership and prepared source", () => {
  const changes: ((e: ContinuationEvidence) => void)[] = [
    e => { e.repository = "other/package"; }, e => { e.defaultBranch = "develop"; }, e => { e.workflow = ".github/workflows/other.yml"; },
    e => { e.configDigest = "0".repeat(64); }, e => { e.pr.author = "human"; }, e => { e.pr.repository = "other/package"; }, e => { e.pr.base = "other"; },
    e => { e.pr.state = "open"; }, e => { e.pr.mergedSha = null; }, e => { e.mergedTree = "0".repeat(40); },
    e => { e.mergedParents = []; }, e => { e.mergedParents = ["0".repeat(40)]; }, e => { e.version = "2026.11.7"; },
  ];
  for (const change of changes) { const e = evidenceFixture(); change(e); assert.throws(() => decideReleaseContinuation(candidateFixture(), e)); }
  assert.equal(ownsContinuationPr(evidenceFixture().pr, "example/package", "main"), true);
});

test("only the successful trusted main preparation run and an unexpired artifact are eligible", () => {
  const fields = ["repository", "branch", "sha", "workflow", "event", "conclusion"] as const;
  for (const field of fields) {
    const e = evidenceFixture(); e.run[field] = "untrusted";
    assert.throws(() => decideReleaseContinuation(candidateFixture(), e), /Untrusted/);
  }
  for (const change of [(e: ContinuationEvidence) => { e.run.attempt = 2; }, (e: ContinuationEvidence) => { e.artifactAvailable = false; }]) {
    const e = evidenceFixture(); change(e); assert.throws(() => decideReleaseContinuation(candidateFixture(), e), /Untrusted/);
  }
  const e = evidenceFixture(); e.run.event = "workflow_dispatch"; assert.equal(decideReleaseContinuation(candidateFixture(), e), "publish");
});

test("missing, failed, skipped and unreadable protection proof refuses publication", () => {
  for (const checks of [[], ["PENDING"], ["FAILURE"], ["SKIPPED"], ["NEUTRAL"], ["CANCELLED"]]) {
    const e = evidenceFixture(); e.requiredChecks = checks;
    assert.throws(() => decideReleaseContinuation(candidateFixture(), e), /protection proof/);
  }
  const e = evidenceFixture(); e.reviewDecision = "CHANGES_REQUESTED";
  assert.throws(() => decideReleaseContinuation(candidateFixture(), e), /protection proof/);
  e.reviewDecision = ""; assert.equal(decideReleaseContinuation(candidateFixture(), e), "publish", "merged protected PR may have no required reviews");
});

test("crash boundaries, delayed registry visibility, daily cap and mismatched remote identities converge or refuse", () => {
  const c = candidateFixture(), e = evidenceFixture();
  e.attempted = true;
  assert.throws(() => decideReleaseContinuation(c, e), /ambiguous/);
  e.registry = "unverified";
  assert.throws(() => decideReleaseContinuation(c, e), /identity disagrees/);
  e.registry = "verified"; e.publishedToday = true;
  assert.equal(decideReleaseContinuation(c, e), "recover");
  c.npmPublish = false;
  assert.throws(() => decideReleaseContinuation(c, e), /Daily/, "a tag alone is not a completed GitHub-only publication");
  c.npmPublish = true;
  e.tagSha = "0".repeat(40); assert.throws(() => decideReleaseContinuation(c, e), /identity disagrees/);
  e.tagSha = null; e.releaseSha = e.pr.mergedSha; assert.throws(() => decideReleaseContinuation(c, e), /identity disagrees/);
  e.tagSha = e.pr.mergedSha; e.releaseSha = "0".repeat(40); assert.throws(() => decideReleaseContinuation(c, e), /identity disagrees/);
  e.releaseSha = e.pr.mergedSha; e.mainSha = "0".repeat(40);
  assert.equal(decideReleaseContinuation(c, e), "complete", "already verified publication reconciles after main advances");
  e.registry = "absent"; e.attempted = false;
  assert.throws(() => decideReleaseContinuation(c, e), /Daily/);
});

test("candidate validation refuses malformed persisted intent before effects and preserves valid numeric suffixes", () => {
  const changes: Partial<ReleaseCandidate>[] = [
    { schema: 2 as 1 }, { repository: "../package" }, { defaultBranch: "other" }, { headSha: "wrong" }, { version: "latest" }, { tag: "v2026.11.07" },
    { packageName: "../" }, { packageSha256: "wrong" }, { notesSha256: "wrong" }, { configDigest: "wrong" }, { packageIntegrity: "sha256-wrong" },
    { runId: 0 }, { runId: 1.5 }, { runAttempt: 0 }, { runAttempt: 1.5 }, { workflow: "../other.yml" },
    { npmPublish: "yes" as unknown as boolean }, { cliVersion: 1 as unknown as string }, { cliVersion: "latest" }, { opsVersion: "latest" },
  ];
  for (const change of changes) assert.throws(() => validateReleaseCandidate({ ...candidateFixture(), ...change }), /Malformed/);
  assert.throws(() => validateReleaseCandidate({ ...candidateFixture(), unexpected: "output\ninjection" } as ReleaseCandidate), /Malformed/);
  validateReleaseCandidate({ ...candidateFixture(), version: "2026.11.6-2", tag: "v2026.11.06-2", packageName: "@fixture/package", npmPublish: false, cliVersion: "" });
  const c = candidateFixture(); c.packageSha256 = "0".repeat(64);
  assert.notEqual(releaseDigest("changed ignored shipped bytes"), c.packageSha256);
  assert.equal(releaseConfigDigest({ b: 2, a: 1, "reconcile-only": true }), releaseConfigDigest({ a: 1, b: 2, "reconcile-only": false }));
  assert.notEqual(releaseConfigDigest({ a: 2 }), releaseConfigDigest({ a: 1 }));
});


test("advanced main strands unpublished bytes but permits already-attested repair without republishing", () => {
  const c = candidateFixture(), e = evidenceFixture();
  for (const change of [(e: ContinuationEvidence) => { e.mainSha = "9".repeat(40); }, (e: ContinuationEvidence) => { e.triggerSha = "9".repeat(40); }]) {
    change(e); assert.equal(decideReleaseContinuation(c, e), "stranded");
  }
  e.registry = "verified"; assert.equal(decideReleaseContinuation(c, e), "recover");
  e.registry = "absent"; e.tagSha = e.pr.mergedSha;
  assert.throws(() => decideReleaseContinuation(c, e), /operator reconciliation/);
  e.tagSha = null; e.attempted = true;
  assert.throws(() => decideReleaseContinuation(c, e), /ambiguous/);
});

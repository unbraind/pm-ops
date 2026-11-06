/** Reusable deterministic release identities, independent of transports. */
import type { ReleaseCandidate, ContinuationEvidence } from "../release-continuation.ts";

/** One immutable artifact identity from the trusted preparation run. */
export function candidateFixture(): ReleaseCandidate {
  return { schema: 1, repository: "example/package", defaultBranch: "main", baseSha: "a".repeat(40), headSha: "b".repeat(40), tree: "c".repeat(40),
    version: "2026.11.6", tag: "v2026.11.06", packageName: "fixture-package", packageSha256: "d".repeat(64), packageIntegrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    notesSha256: "e".repeat(64), cliVersion: "2026.11.2", opsVersion: "2026.11.5", runId: 10, runAttempt: 1, workflow: ".github/workflows/release.yml", configDigest: "f".repeat(64), npmPublish: true };
}

/** Complete fresh evidence for the protected squash-merged candidate. */
export function evidenceFixture(): ContinuationEvidence {
  const c = candidateFixture(), merged = "1".repeat(40);
  return { repository: c.repository, defaultBranch: "main", mainSha: merged, triggerSha: merged, workflow: c.workflow, configDigest: c.configDigest,
    pr: { number: 42, author: "github-actions[bot]", repository: c.repository, headRepository: c.repository, base: "main", branch: "release/2026.11.06", head: c.headSha, state: "closed", merged: true, mergedSha: merged },
    run: { repository: c.repository, branch: "main", sha: c.baseSha, workflow: c.workflow, event: "schedule", conclusion: "success", attempt: 1 },
    artifactAvailable: true, mergedTree: c.tree, mergedParents: [c.baseSha], requiredChecks: ["SUCCESS", "SUCCESS"], reviewDecision: "APPROVED", version: c.version,
    artifactSha256: c.packageSha256, tagSha: null, releaseSha: null, registry: "absent", attempted: false, publishedToday: false };
}

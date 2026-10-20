/** Behavioral regressions for the decisions executed by the shared workflow. */
import assert from "node:assert/strict";
import test from "node:test";
import { decideDailyRelease, ownsReleasePullRequest, selectReleasePullRequests, latestReleaseTag, stampCargoVersion, releaseVersion, stampExtensionVersion, verifyPublishedProvenance, type DailyReleaseInput, type ReleasePullRequest } from "../daily-release.ts";

/** Make a GitHub-shaped owned PR, overriding individual security facts per case. */
function pr(number: number, headRefName = "release/2026.10.18", extra: Partial<ReleasePullRequest> = {}): ReleasePullRequest {
  return { number, headRefName, author: { login: "app/github-actions" }, isCrossRepository: false, ...extra };
}

/** Independent release facts, with main advanced since yesterday's published tag. */
function facts(extra: Partial<DailyReleaseInput> = {}): DailyReleaseInput {
  return { today: "2026.10.19", mainSha: "new-main", lastRelease: { tag: "v2026.10.18", sha: "old-main" }, existingPrs: [], hasChanges: true, releaseTags: ["v2026.10.18"], ...extra };
}

test("ownership refuses forks, missing authors, humans, lookalike bots, and non-date release branches", () => {
  assert.equal(ownsReleasePullRequest(pr(1)), true);
  for (const candidate of [pr(2, undefined, { isCrossRepository: true }), pr(3, undefined, { author: null }), pr(4, undefined, { author: { login: "github-actions[bot]" } }), pr(5, undefined, { author: { login: "human" } }), pr(6, "release/2026.10.19/payload"), pr(7, "release/latest"), pr(8, "release/2026.10.19\n"), pr(9, "release/2026.10.19-2")]) {
    assert.equal(ownsReleasePullRequest(candidate), false, JSON.stringify(candidate));
  }
});

test("selection finds eligible PRs beyond 30 and orders numeric dates then PR numbers without mutating input", () => {
  const input = [...Array.from({ length: 35 }, (_, n) => pr(n + 1, "feature/unrelated")), pr(200, "release/2026.9.30"), pr(50), pr(70), pr(80, "release/2026.11.1"), pr(60, "release/2027.1.1")];
  const copy = JSON.stringify(input);
  assert.deepEqual(selectReleasePullRequests(input).map(p => p.number), [60, 80, 70, 50, 200]);
  assert.equal(JSON.stringify(input), copy);
  assert.deepEqual(selectReleasePullRequests([...input].reverse()).map(p => p.number), [60, 80, 70, 50, 200]);
});

test("stale release PRs are rebuilt from current main; superseded cleanup lists only owned PRs", () => {
  const plan = decideDailyRelease(facts({ existingPrs: [pr(30, "release/2026.10.17"), pr(99, "release/2026.10.19", { isCrossRepository: true }), pr(50), pr(51, undefined, { author: { login: "human" } })] }));
  assert.deepEqual(plan, { should_release: true, recovery_tag: "", action: "refresh", tag: "v2026.10.19", npm_version: "2026.10.19", base_sha: "new-main", release_branch: "release/2026.10.18", pr_number: 50, superseded_pr_numbers: "30" });
});

test("daily decisions skip same-day spelling variants and suffixes, unchanged trees and unchanged heads", () => {
  for (const extra of [
    { releaseTags: ["v2026.010.19"] }, { releaseTags: ["v2026.10.19-1"] },
    { hasChanges: false }, { mainSha: "old-main" },
  ]) {
    assert.equal(decideDailyRelease(facts(extra)).should_release, false);
    assert.equal(decideDailyRelease(facts(extra)).action, "skip");
  }
  assert.equal(releaseVersion("v2026.08.09-2"), "2026.8.9");
  assert.equal(decideDailyRelease(facts({ lastRelease: null, releaseTags: [] })).action, "create");
  assert.equal(decideDailyRelease(facts()).release_branch, "release/2026.10.19");
  assert.equal(decideDailyRelease(facts()).pr_number, "");
});

test("extension stamping changes the descriptor and preserves unrelated version data", () => {
  const source = `const unrelated = { version: "leave" };\nexport default defineExtension({ name: "x", version: 'old', other: { version: "nested" } });\ndefineExtension(); defineExtension(variable); defineExtension({ version: variable, ...rest, other: "x" });\ndefineExtension({ "version": "another" });`;
  const result = stampExtensionVersion(source, "2026.10.19");
  assert.match(result, /unrelated = \{ version: "leave" \}/);
  assert.match(result, /name: "x", version: "2026.10.19", other: \{ version: "nested" \}/);
  assert.match(result, /"version": "2026.10.19"/);
  assert.equal(stampExtensionVersion(result, "2026.10.19"), result);
  assert.equal(stampExtensionVersion("export default {};", "x"), "export default {};");
});

test("extension stamping ignores a version token outside a property-key position", () => {
  const ternary = `defineExtension({ name: "x", channel: isDev ? version : "stable", version: "old" });`;
  const stamped = stampExtensionVersion(ternary, "2026.10.19");
  assert.match(stamped, /channel: isDev \? version : "stable"/);
  assert.match(stamped, /version: "2026.10.19" \}\);$/);
  const parenthesized = `defineExtension({ channel: (isDev ? version : "stable"), list: [version, "x"] });`;
  assert.equal(stampExtensionVersion(parenthesized, "2026.10.19"), parenthesized);
});

/** Wrap a synthetic SLSA payload in the registry attestation response format. */
function provenance(statement: unknown): unknown {
  return { attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } }] };
}

test("registry provenance must name both the expected commit and the published digest", () => {
  const valid = { subject: [{ digest: { sha512: "abcd" } }], predicate: { buildDefinition: { resolvedDependencies: [{ digest: { gitCommit: "merged" } }] } } };
  assert.equal(verifyPublishedProvenance(provenance(valid), "merged", "sha512-q80="), true);
  assert.equal(verifyPublishedProvenance(provenance(valid), "trigger", "sha512-q80="), false);
  assert.equal(verifyPublishedProvenance(provenance(valid), "merged", "sha512-AAAA"), false);
  for (const bad of [null, [], {}, { attestations: [] }, { attestations: [null, { predicateType: "other" }, { predicateType: "https://slsa.dev/provenance/v1" }, { predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: "invalid JSON" } } }] }, provenance(null), provenance({ subject: [], predicate: valid.predicate }), provenance({ subject: valid.subject }), provenance({ subject: valid.subject, predicate: { buildDefinition: { resolvedDependencies: [] } } })]) {
    assert.equal(verifyPublishedProvenance(bad, "merged", "sha512-q80="), false);
  }
  for (const integrity of ["sha256-q80=", "sha512-"]) assert.equal(verifyPublishedProvenance(provenance(valid), "merged", integrity), false);
});

test("reviewed version policy waits for a new approved version and still caps actual publication dates", () => {
  const plan = decideDailyRelease(facts({ packageVersion: "2026.10.12" }));
  assert.equal(plan.npm_version, "2026.10.12");
  assert.equal(plan.tag, "v2026.10.12");
  assert.equal(plan.should_release, true);
  assert.equal(decideDailyRelease(facts({ packageVersion: "2026.10.18" })).should_release, false);
  assert.equal(decideDailyRelease(facts({ packageVersion: "2026.10.12", publishedToday: true })).should_release, false);
});


test("a tagged unchanged head can repair its missing GitHub Release without another publish", () => {
  assert.equal(decideDailyRelease(facts({ mainSha: "old-main", hasChanges: false })).recovery_tag, "v2026.10.18");
  assert.equal(decideDailyRelease(facts({ hasChanges: false })).recovery_tag, "");
});


test("last release selection compares padded and unpadded dates numerically", () => {
  const tags = ["v2026.09.30", "v2026.8.31", "v2026.9.30-2", "v2026.9.30-1", "v2025.12.31"];
  assert.equal(latestReleaseTag(tags), "v2026.9.30-2");
  assert.equal(latestReleaseTag([...tags].reverse()), "v2026.9.30-2");
  assert.equal(latestReleaseTag([]), "");
  assert.equal(latestReleaseTag(["v2026.08.01"]), "v2026.08.01");
});

test("Cargo stamping preserves dependency and metadata versions and refuses inherited or absent versions", () => {
  const source = '[package]\nname = "fixture"\nversion = "2026.8.1" # release\n[package.metadata]\nversion = "keep"\n[dependencies]\nother = { version = "1.0.0" }\n';
  const stamped = stampCargoVersion(source, "2026.10.19");
  assert.equal(stamped, source.replace('version = "2026.8.1"', 'version = "2026.10.19"'));
  assert.equal(stampCargoVersion(stamped, "2026.10.19"), stamped);
  assert.equal(stampCargoVersion("[package]\nversion = 'old'\n", "2026.10.19"), '[package]\nversion = "2026.10.19"\n');
  assert.throws(() => stampCargoVersion('[workspace]\nversion = "x"\n', "x"), /no package table/);
  assert.throws(() => stampCargoVersion('[package]\nversion.workspace = true\n[dependencies]\nversion = "wrong table"\n', "x"), /no literal version/);
});

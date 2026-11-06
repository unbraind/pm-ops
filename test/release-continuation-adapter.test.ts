/** Execute the workflow adapter against synthetic, authoritative REST and registry boundaries. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { candidateFixture, evidenceFixture } from "./release-continuation-fixture.ts";
import { releaseDigest } from "../release-continuation.ts";
import { candidateBody, parseCandidateReceipt, inspectCandidate, closeSuperseded, requiredProtection, type ReleaseApi } from "../scripts/release-continuation.ts";

const previousProject = process.env.NPM_PROJECT_DIR;
process.env.NPM_PROJECT_DIR = ".";
after(() => { if (previousProject === undefined) delete process.env.NPM_PROJECT_DIR; else process.env.NPM_PROJECT_DIR = previousProject; });

/** Stateful remote fixture: no release workflow or registry write escapes this object. */
function remoteFixture() {
  const c = candidateFixture(), e = evidenceFixture(), receipt = { candidate: c, artifactId: 20 };
  const pr = { number: 42, body: candidateBody(receipt), state: "closed", merged: true, merge_commit_sha: e.pr.mergedSha,
    user: { login: "github-actions[bot]" }, head: { ref: e.pr.branch, sha: c.headSha, repo: { full_name: c.repository } }, base: { ref: "main", repo: { full_name: c.repository } } };
  const run = { repository: { full_name: c.repository }, head_branch: "main", head_sha: c.baseSha, path: c.workflow, event: "schedule", conclusion: "success", run_attempt: 1 };
  const artifact = { expired: false, workflow_run: { id: c.runId }, name: `verified-daily-release-${c.headSha}` };
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const state = { tag: null as string | null, release: false, registry: false, registryUnavailable: false, checks: ["SUCCESS"], comments: [] as { user: { login: string }; body: string }[], publishedAt: "", npmPublishedAt: "2026-11-05T12:00:00Z", main: e.mainSha, pkgVersion: c.version, pkgName: c.packageName };
  const api: ReleaseApi = async (path, method = "GET", body) => {
    calls.push({ path, method, body });
    if (method !== "GET") return {};
    if (path === `repos/${c.repository}`) return { default_branch: "main" };
    if (path.includes("/pulls?")) return [pr];
    if (path.endsWith("/pulls/42")) return pr;
    if (path.includes("/actions/runs/")) return run;
    if (path.includes("/actions/artifacts/")) return artifact;
    if (path.includes("/git/ref/heads/")) return { object: { sha: state.main } };
    if (path.includes("/git/commits/")) return { tree: { sha: c.tree }, parents: [{ sha: c.baseSha }] };
    if (path.includes("/contents/package.json?")) return { content: Buffer.from(JSON.stringify({ name: state.pkgName, version: state.pkgVersion })).toString("base64") };
    if (path.includes("/git/ref/tags/")) return state.tag ? { object: { type: "commit", sha: state.tag } } : null;
    if (path.includes("/releases/tags/")) return state.release ? { tag_name: c.tag, draft: false } : null;
    if (path.includes("/comments?")) return state.comments;
    if (path.includes("/releases?")) return state.publishedAt ? [{ published_at: state.publishedAt }] : [];
    throw new Error(`Unexpected synthetic read: ${path}`);
  };
  const registry = async (path: string): Promise<unknown> => {
    if (state.registryUnavailable) throw new Error("Synthetic registry outage");
    if (path === c.packageName) return { time: { "2026.11.5": state.npmPublishedAt } };
    if (path === `${c.packageName}/${c.version}`) return state.registry ? { dist: { integrity: c.packageIntegrity, attestations: { url: "https://registry.npmjs.org/-/fixture-proof" } } } : null;
    const payload = Buffer.from(JSON.stringify({ subject: [{ digest: { sha512: Buffer.from(c.packageIntegrity.slice(7), "base64").toString("hex") } }], predicate: { buildDefinition: { resolvedDependencies: [{ digest: { gitCommit: e.pr.mergedSha } }] } } })).toString("base64");
    return { attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload } } }] };
  };
  const options = { repository: c.repository, triggerSha: e.triggerSha, workflow: c.workflow, configDigest: c.configDigest, timezone: "Europe/Vienna", now: "2026-11-06T05:00:00Z" };
  return { c, e, receipt, pr, run, artifact, calls, state, api, options, inspect: () => inspectCandidate(receipt, options, api, registry, () => ({ states: state.checks, review: "APPROVED" })) };
}

test("trusted API fixture holds a pending PR past the old deadline, then recovers a token-suppressed merge and one publication", async () => {
  const f = remoteFixture();
  f.pr.merged = false; f.pr.state = "open"; f.state.checks = ["PENDING"];
  f.state.main = f.c.baseSha;
  for (const time of ["2026-11-06T05:00:00Z", "2026-11-06T06:00:00Z"]) {
    f.options.now = time;
    assert.equal((await f.inspect()).action, "pending");
  }
  assert.ok(f.calls.every(call => call.method === "GET"));
  f.pr.merged = true; f.pr.state = "closed"; f.state.checks = ["SUCCESS"]; f.state.main = f.e.mainSha;
  assert.equal((await f.inspect()).action, "publish");
  f.state.registry = true;
  assert.equal((await f.inspect()).action, "recover");
  f.state.tag = f.e.pr.mergedSha; f.state.release = true;
  for (let delivery = 0; delivery < 3; delivery++) assert.equal((await f.inspect()).action, "complete");
});

test("adapter refuses forks, foreign branches, changed heads, stale run artifacts and unavailable live evidence", async () => {
  for (const mutate of [
    (f: ReturnType<typeof remoteFixture>) => { f.pr.head.repo.full_name = "foreign/package"; },
    (f: ReturnType<typeof remoteFixture>) => { f.pr.head.ref = "feature/test"; },
    (f: ReturnType<typeof remoteFixture>) => { f.pr.head.sha = "0".repeat(40); },
    (f: ReturnType<typeof remoteFixture>) => { f.artifact.expired = true; },
    (f: ReturnType<typeof remoteFixture>) => { f.artifact.workflow_run.id = 99; },
    (f: ReturnType<typeof remoteFixture>) => { f.run.event = "pull_request"; },
    (f: ReturnType<typeof remoteFixture>) => { f.state.registryUnavailable = true; },
    (f: ReturnType<typeof remoteFixture>) => { f.state.checks = ["SKIPPED"]; },
    (f: ReturnType<typeof remoteFixture>) => { f.state.pkgVersion = "2026.11.7"; },
    (f: ReturnType<typeof remoteFixture>) => { f.state.pkgName = "foreign-package"; },
  ]) { const f = remoteFixture(); mutate(f); await assert.rejects(f.inspect()); assert.ok(f.calls.every(call => call.method === "GET")); }
});

test("receipt parser binds one valid artifact and refuses malformed, ambiguous or absent records", () => {
  const f = remoteFixture();
  assert.deepEqual(parseCandidateReceipt(candidateBody(f.receipt)), f.receipt);
  assert.equal(parseCandidateReceipt("ordinary release PR"), null);
  for (const body of [candidateBody(f.receipt) + "extra", candidateBody(f.receipt) + candidateBody(f.receipt), candidateBody({ ...f.receipt, artifactId: 0 })]) assert.throws(() => parseCandidateReceipt(body));
});

test("native protection reader requires every context and issuer at the exact head and refuses truncated policy evidence", () => {
  const previous = process.env.GITHUB_REPOSITORY; process.env.GITHUB_REPOSITORY = "example/package";
  try {
    const head = "b".repeat(40);
    const rule = { requiresApprovingReviews: true, requiredStatusChecks: [{ context: "CI", app: { id: "trusted-app" } }, { context: "legacy", app: null }] };
    const nodes = [
      { __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true, checkSuite: { app: { id: "trusted-app" } } },
      { __typename: "StatusContext", context: "legacy", state: "SUCCESS", isRequired: true },
    ];
    const pr = { headRefOid: head, reviewDecision: "APPROVED", baseRef: { branchProtectionRule: rule }, commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: { totalCount: 2, pageInfo: { hasNextPage: false }, nodes } } } }] } };
    const read = () => requiredProtection(42, head, args => {
      assert.ok(args.includes("graphql")); assert.ok(args.some(arg => arg.includes("requiredStatusChecks")));
      return JSON.stringify({ data: { repository: { pullRequest: pr } } });
    });
    assert.deepEqual(read(), { states: ["SUCCESS", "SUCCESS"], review: "APPROVED" });
    nodes[0].checkSuite!.app.id = "foreign-app"; assert.deepEqual(read().states, ["MISSING", "SUCCESS"]);
    nodes[0].checkSuite!.app.id = "trusted-app"; nodes[0].status = "QUEUED"; assert.equal(read().states[0], "PENDING");
    nodes[0].status = "COMPLETED"; nodes[0].conclusion = "SKIPPED"; assert.equal(read().states[0], "SKIPPED");
    pr.reviewDecision = ""; assert.equal(read().review, "REVIEW_REQUIRED");
    rule.requiresApprovingReviews = false; assert.equal(read().review, "");
    const contexts = pr.commits.nodes[0].commit.statusCheckRollup.contexts;
    contexts.pageInfo.hasNextPage = true; assert.throws(read, /incomplete/);
    contexts.pageInfo.hasNextPage = false; contexts.totalCount = 3; assert.throws(read, /incomplete/);
    contexts.totalCount = 2; pr.headRefOid = "0".repeat(40); assert.throws(read, /incomplete/);
  } finally { if (previous === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = previous; }
});

test("live daily publication cap blocks an old candidate even when its version date is earlier", async () => {
  const f = remoteFixture(); f.state.publishedAt = "2026-11-06T02:00:00Z";
  await assert.rejects(f.inspect(), /Daily/);
  Object.assign(f.state, { publishedAt: "", npmPublishedAt: "2026-11-06T02:00:00Z" });
  await assert.rejects(f.inspect(), /Daily/);
});

test("a durable bot publication attempt refuses an absent registry result until live visibility reconciles", async () => {
  const f = remoteFixture();
  const body = `<!-- pm-ops-publication-v1\n${JSON.stringify({ candidate: releaseDigest(JSON.stringify(f.c)) })}\n-->`;
  f.state.comments.push({ user: { login: "human" }, body });
  assert.equal((await f.inspect()).action, "publish");
  f.state.comments.push({ user: { login: "github-actions[bot]" }, body });
  await assert.rejects(f.inspect(), /ambiguous/);
  Object.assign(f.state, { registry: true });
  assert.equal((await f.inspect()).action, "recover");
});

test("actual protected-PR request shell exits while CI is pending and never reads or sleeps on checks", () => {
  const root = mkdtempSync(join(tmpdir(), "release-request-"));
  try {
    const c = candidateFixture();
    const scripts = {
      git: `#!/bin/sh\ncase "$1" in\nrev-parse) if [ "$2" = HEAD ]; then echo '${c.headSha}'; else echo '${c.baseSha}'; fi ;;\npush) echo pushed >> "$REQUEST_FIXTURE/pushes" ;;\nesac\n`,
      gh: '#!/bin/sh\nif [ "$1 $2" = "pr create" ]; then echo https://example.invalid/pull/42; fi\nif [ "$1 $2" = "pr view" ] || [ "$1 $2" = "pr checks" ]; then echo pending >> "$REQUEST_FIXTURE/check-reads"; exit 1; fi\n',
      node: '#!/bin/sh\necho "$*" >> "$REQUEST_FIXTURE/transitions"\n',
      sleep: '#!/bin/sh\necho sleep >> "$REQUEST_FIXTURE/sleeps"\nexit 9\n',
    };
    for (const [name, source] of Object.entries(scripts)) { writeFileSync(join(root, name), source); chmodSync(join(root, name), 0o755); }
    const shared = parse(readFileSync(new URL("../.github/workflows/daily-release.yml", import.meta.url), "utf8")) as {
      jobs: { request?: { steps: { name: string; run: string }[] }; release: { steps: { name: string; run: string }[] } };
    };
    const request = (shared.jobs.request ?? shared.jobs.release).steps.find(step => step.name === "Merge release metadata through protected PR")!.run;
    const requestFile = join(root, "request.sh"); writeFileSync(requestFile, request);
    const result = spawnSync("bash", ["--noprofile", "--norc", requestFile], { encoding: "utf8", timeout: 2000, env: {
      PATH: `${root}:/usr/bin:/bin`, REQUEST_FIXTURE: root, RELEASE_BASE_SHA: c.baseSha, RELEASE_BRANCH: "release/2026.11.06", RELEASE_PR_NUMBER: "",
      RELEASE_TAG: c.tag, REPO_NAME: "package", GITHUB_REPOSITORY: c.repository, GITHUB_OUTPUT: join(root, "output"), CONTINUATION_SCRIPT: "continuation.ts",
    } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(readFileSync(join(root, "transitions"), "utf8"), /continuation.ts request/);
    assert.match(readFileSync(join(root, "output"), "utf8"), /pr_number=42/);
    for (const path of ["check-reads", "sleeps"]) assert.equal(existsSync(join(root, path)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publication CLI refuses stale candidate, notes and changed ignored shipped bytes before any remote action", () => {
  const root = mkdtempSync(join(tmpdir(), "release-bytes-"));
  const handoff = join(root, "release-artifact"); mkdirSync(handoff);
  try {
    const c = candidateFixture(); c.packageSha256 = releaseDigest("original shipped bytes"); c.notesSha256 = releaseDigest("verified notes");
    const receipt = { candidate: c, artifactId: 20 };
    for (const scenario of ["candidate", "notes", "package"]) {
      writeFileSync(join(handoff, "candidate.json"), scenario === "candidate" ? "{}" : JSON.stringify(c));
      writeFileSync(join(handoff, "RELEASE_NOTES.md"), scenario === "notes" ? "changed notes" : "verified notes");
      writeFileSync(join(handoff, "package.tgz"), "changed ignored shipped bytes");
      const result = spawnSync(process.execPath, [new URL("../scripts/release-continuation.ts", import.meta.url).pathname, "verify"], { encoding: "utf8", env: {
        GITHUB_REPOSITORY: c.repository, RELEASE_CONFIG: "{}", CALLER_WORKFLOW: `${c.repository}/${c.workflow}@refs/heads/main`, RUNNER_TEMP: root,
        TRIGGER_SHA: "1".repeat(40), RELEASE_TIMEZONE: "Europe/Vienna", CANDIDATE_RECEIPT: JSON.stringify(receipt), GITHUB_OUTPUT: join(root, "output"),
      } });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, new RegExp(`Stale ${scenario === "notes" ? "release notes" : scenario === "package" ? "package artifact" : "candidate artifact"}`));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("superseded closure re-reads both PR identities and names the successor while refusing foreign ownership", async () => {
  const f = remoteFixture(); f.pr.state = "open";
  const old = structuredClone(f.pr); old.number = 41; old.head.ref = "release/2026.11.05";
  const effects: { path: string; method: string; body: unknown }[] = [];
  const api: ReleaseApi = async (path, method = "GET", body) => {
    if (method !== "GET") { effects.push({ path, method, body }); return {}; }
    return path.endsWith("/42") ? f.pr : old;
  };
  await closeSuperseded([42, 41], 42, f.c.repository, api);
  assert.deepEqual(effects.map(effect => effect.body), [{ body: "Superseded by release PR #42." }, { state: "closed" }]);
  for (const mutate of [() => { old.head.repo.full_name = "foreign/package"; }, () => { old.head.ref = "feature/old"; }, () => { old.user.login = "human"; }]) {
    mutate(); effects.length = 0; await closeSuperseded([41], 42, f.c.repository, api); assert.equal(effects.length, 0);
  }
  const untrustedApi: ReleaseApi = async () => ({ ...f.pr, user: { login: "human" } });
  await assert.rejects(closeSuperseded([41], 42, f.c.repository, untrustedApi), /successor/);
});

test("pilot schedules the shared workflow hourly and daily; empty reconciliation installs no packages and no PR wait survives", () => {
  const file = (name: string) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
  const pilot = parse(file("release.yml")) as { on: { schedule: { cron: string }[] }; jobs: { release: { uses: string; with: Record<string, string> } } };
  assert.equal(pilot.jobs.release.uses, "./.github/workflows/daily-release.yml");
  assert.deepEqual(pilot.on.schedule.map(s => s.cron), ["23 3 * * *", "41 * * * *"]);
  assert.ok(pilot.jobs.release.with["reconcile-only"].includes("github.event.schedule"));
  const shared = parse(file("daily-release.yml")) as { jobs: Record<string, { if: string; steps: { name: string; run?: string }[] }> };
  assert.ok(shared.jobs.prepare.if.includes("needs.reconcile.outputs.pending == 'false'"));
  assert.ok(shared.jobs.prepare.if.includes("!inputs.reconcile-only"));
  assert.ok(shared.jobs.audit.if.includes("!inputs.reconcile-only"));
  assert.doesNotMatch(JSON.stringify(shared.jobs.reconcile.steps), /npm (ci|install)/);
  assert.doesNotMatch(JSON.stringify(shared.jobs.request.steps), /sleep |1800|did not merge within 30 minutes|awaiting_approval/);
  const adapter = readFileSync(new URL("../scripts/release-continuation.ts", import.meta.url), "utf8");
  assert.ok(adapter.indexOf('"PATCH", { body: candidateBody(receipt) }') < adapter.indexOf('"--auto", "--squash"'));
  assert.ok(adapter.includes('"--match-head-commit", candidate.headSha'));
});

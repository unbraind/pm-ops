/** Execute the workflow adapter against synthetic, authoritative REST and registry boundaries. */
import "./provenance-trust-fixture.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "../subprocess.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { candidateFixture, evidenceFixture } from "./release-continuation-fixture.ts";
import { releaseConfigDigest, releaseDigest } from "../release-continuation.ts";
import { candidateBody, retiredCandidateBody, parseCandidateReceipt, inspectCandidate as inspectProductionCandidate, closeSuperseded, requiredProtection, approveRequiredWorkflowRuns, githubApi, registryJson, runReleaseContinuation as runProductionContinuation, normalizeWorkflowPath, type ReleaseApi } from "../scripts/release-continuation.ts";

/** Isolate the cryptographic network boundary in transport fixtures; real signed bundles have separate tests. */
async function syntheticSignature(): Promise<void> {}

/** Exercise the production adapter with native HTTP data and an explicit signature boundary. */
function inspectCandidate(...args: Parameters<typeof inspectProductionCandidate>) {
  args[5] ??= syntheticSignature;
  return inspectProductionCandidate(...args);
}

/** Exercise the production entry point without treating unsigned transport fixtures as real signatures. */
function runReleaseContinuation(mode: string | undefined) { return runProductionContinuation(mode, syntheticSignature); }

const previousProject = process.env.NPM_PROJECT_DIR;
process.env.NPM_PROJECT_DIR = ".";
after(() => { if (previousProject === undefined) delete process.env.NPM_PROJECT_DIR; else process.env.NPM_PROJECT_DIR = previousProject; });

/** Stateful remote fixture: no release workflow or registry write escapes this object. */
function remoteFixture() {
  const c = candidateFixture(), e = evidenceFixture(), receipt = { candidate: c, artifactId: 20 };
  const pr = { number: 42, body: candidateBody(receipt), state: "closed", merged: true, merged_at: "2026-11-06T04:00:00Z" as string | null, merge_commit_sha: e.pr.mergedSha,
    user: { login: "github-actions[bot]" }, head: { ref: e.pr.branch, sha: c.headSha, repo: { full_name: c.repository } }, base: { ref: "main", repo: { full_name: c.repository } } };
  const run = { repository: { full_name: c.repository }, head_branch: "main", head_sha: c.baseSha, path: c.workflow, event: "schedule", conclusion: "success", run_attempt: 1, referenced_workflows: [{ path: "unbraind/pm-ops/.github/workflows/daily-release.yml@main", sha: c.toolsSha! }] };
  const artifact = { expired: false, workflow_run: { id: c.runId }, name: `verified-daily-release-${c.headSha}` };
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const state = { tag: null as string | null, release: false, registry: false, registryUnavailable: false, checks: ["SUCCESS"], comments: [] as { user: { login: string }; body: string }[], publishedAt: "", npmPublishedAt: "2026-11-05T12:00:00Z", main: e.mainSha, tree: c.tree, parents: [c.baseSha], pkgVersion: c.version, pkgName: c.packageName };
  const api: ReleaseApi = async (path, method = "GET", body) => {
    calls.push({ path, method, body });
    if (method !== "GET") return {};
    if (path === `repos/${c.repository}`) return { default_branch: "main" };
    if (path.includes("/pulls?")) return [pr];
    if (path.endsWith("/pulls/42")) return pr;
    if (path.includes("/jobs?")) return { total_count: 1, jobs: [{ name: "release / prepare", status: "completed", conclusion: "success", run_id: c.runId, head_sha: c.baseSha }] };
    if (path.includes("/actions/runs/")) return run;
    if (path.includes("/actions/artifacts/")) return artifact;
    if (path.includes("/git/ref/heads/")) return { object: { sha: state.main } };
    if (path.includes("/git/commits/")) return { tree: { sha: state.tree }, parents: state.parents.map(sha => ({ sha })) };
    if (path.startsWith("repos/unbraind/pm-ops/contents/package.json?")) return { content: Buffer.from(JSON.stringify({ name: "pm-ops", version: c.opsVersion })).toString("base64") };
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
    const payload = Buffer.from(JSON.stringify({ subject: [{ digest: { sha512: Buffer.from(c.packageIntegrity.slice(7), "base64").toString("hex") } }], predicate: { buildDefinition: { externalParameters: { workflow: { repository: "https://github.com/" + c.repository, path: c.workflow, ref: "refs/heads/main" } }, resolvedDependencies: [{ digest: { gitCommit: e.pr.mergedSha } }] } } })).toString("base64");
    return { attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload } } }] };
  };
  const options = { repository: c.repository, triggerSha: e.triggerSha, workflow: c.workflow, configDigest: c.configDigest, timezone: "Europe/Vienna", now: "2026-11-06T05:00:00Z" };
  return { c, e, receipt, pr, run, artifact, calls, state, api, options, registry, inspect: () => inspectCandidate(receipt, options, api, registry, () => ({ states: state.checks, review: "APPROVED" })) };
}

/** Job response variants retain native adapter and exact-head protection checks. */
function inspectJobProof(f: ReturnType<typeof remoteFixture>, response: { total_count: number; jobs: unknown } | ((path: string) => { total_count: number; jobs: unknown })) {
  const api: ReleaseApi = async (path, method, body) => path.includes("/jobs?") ? typeof response === "function" ? response(path) : response : f.api(path, method, body);
  return inspectCandidate(f.receipt, f.options, api, f.registry, () => ({ states: f.state.checks, review: "APPROVED" }));
}

/** Execute the production entry point with isolated artifacts, native transport fixtures and no real credentials. */
async function withAdapter(callback: (f: ReturnType<typeof remoteFixture> & { root: string; handoff: string; refresh: () => void; control: { ignorePersistence: boolean; write404: boolean; writes: number; failWriteAt: number } }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "release-adapter-")), handoff = join(root, "release-artifact"); mkdirSync(handoff);
  const f = remoteFixture(), originalFetch = globalThis.fetch;
  const values: Record<string, string> = { GITHUB_REPOSITORY: f.c.repository, GH_TOKEN: "synthetic-token", RELEASE_CONFIG: "{}", CALLER_WORKFLOW: `${f.c.repository}/${f.c.workflow}@refs/heads/main`,
    RUNNER_TEMP: root, GITHUB_WORKSPACE: root, GITHUB_OUTPUT: join(root, "output"), NPM_PROJECT_DIR: ".", TRIGGER_SHA: f.e.triggerSha, RELEASE_TIMEZONE: "Europe/Vienna", RELEASE_PR_NUMBER: "42", RELEASE_BRANCH: f.pr.head.ref,
    REMOTE_BRANCH_SHA: f.c.headSha, ARTIFACT_ID: "20", RELEASE_BASE_SHA: f.c.baseSha, VERIFIED_COMMIT: f.c.headSha, VERIFIED_TREE: f.c.tree, NPM_VERSION: f.c.version, RELEASE_TAG: f.c.tag,
    PACKAGE_NAME: f.c.packageName, CLI_VERSION: f.c.cliVersion, PM_OPS_VERSION: f.c.opsVersion, WORKFLOW_TOOLS_SHA: f.c.toolsSha!, GITHUB_ENV: join(root, "env"), GITHUB_RUN_ID: "10", GITHUB_RUN_ATTEMPT: "1", NPM_PUBLISH: "true", IS_RUST: "false", RELEASE_FIXTURE: root,
    PATH: `${root}:${process.env.PATH}` };
  const saved = new Map([...Object.keys(values), "CANDIDATE_RECEIPT", "SUPERSEDED_PR_NUMBERS", "POST_RELEASE_SCRIPT", "NPM_PROJECT_PATH", "RETIRE_UNPUBLISHED", "RELEASE_COMMIT"].map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const refresh = () => {
    f.c.configDigest = releaseConfigDigest({}); f.c.packageSha256 = releaseDigest("verified bytes"); f.c.notesSha256 = releaseDigest("verified notes");
    f.c.packageIntegrity = `sha512-${createHash("sha512").update("verified bytes").digest("base64")}`;
    f.pr.body = candidateBody(f.receipt); process.env.CANDIDATE_RECEIPT = JSON.stringify(f.receipt);
    writeFileSync(join(handoff, "candidate.json"), JSON.stringify(f.c)); writeFileSync(join(handoff, "package.tgz"), "verified bytes"); writeFileSync(join(handoff, "RELEASE_NOTES.md"), "verified notes");
    writeFileSync(join(root, "output"), "");
    writeFileSync(join(root, "branch-policy.json"), JSON.stringify({ name: "main", protected: true, protection: { enabled: true, required_status_checks: { enforcement_level: "everyone", contexts: ["CI"], checks: [{ context: "CI", app_id: null }] } } }));
    writeFileSync(join(root, "protection.json"), JSON.stringify({ data: { repository: { pullRequest: { headRefOid: f.c.headSha, baseRefName: "main", reviewDecision: "APPROVED",
      baseRef: { branchProtectionRule: { requiresApprovingReviews: true, requiredStatusChecks: [{ context: "CI", app: null }] } },
      commits: { nodes: [{ commit: { oid: f.c.headSha, statusCheckRollup: { contexts: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true }] } } } }] },
    } } } }));
  };
  refresh();
  const control = { ignorePersistence: false, write404: false, writes: 0, failWriteAt: 0 };
  delete process.env.POST_RELEASE_SCRIPT;
  writeFileSync(join(root, "npm"), '#!/bin/sh\necho "$*" >> "$RELEASE_FIXTURE/hooks"\n'); chmodSync(join(root, "npm"), 0o755);
  writeFileSync(join(root, "gh"), '#!/bin/sh\ncase "$1 $2" in\n"api graphql") cat "$RELEASE_FIXTURE/protection.json" ;;\napi\\ repos/*/rules/branches/main) printf "[]" ;;\napi\\ repos/*/branches/main) cat "$RELEASE_FIXTURE/branch-policy.json" ;;\n"pr merge") echo merge >> "$RELEASE_FIXTURE/merges"; echo "$*" >> "$RELEASE_FIXTURE/merge-args" ;;\n*) exit 9 ;;\nesac\n'); chmodSync(join(root, "gh"), 0o755);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    let data: unknown;
    if (url.startsWith("https://api.github.com/")) {
      const path = url.slice("https://api.github.com/".length), body = init?.body ? JSON.parse(String(init.body)) as { body?: string } : undefined;
      if (init?.method !== "GET") {
        control.writes++;
        if (control.write404 || control.writes === control.failWriteAt) return new Response("{}", { status: 404 });
      }
      data = await f.api(path, init?.method, body);
      if (init?.method === "POST" && path.endsWith("/comments") && body?.body) f.state.comments.push({ user: { login: "github-actions[bot]" }, body: body.body });
      if (init?.method === "PATCH" && body?.body && !control.ignorePersistence) Object.assign(f.pr, { body: body.body });
    } else if (url.startsWith("https://registry.npmjs.org/")) data = await f.registry(url.slice("https://registry.npmjs.org/".length));
    else throw new Error("Unexpected fixture host");
    return new Response(JSON.stringify(data), { status: data === null ? 404 : 200 });
  };
  try { await callback({ ...f, root, handoff, refresh, control }); }
  finally { Object.assign(globalThis, { fetch: originalFetch }); for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); }
}

/** Assert that a refusal retained the exact durable receipt without a remote mutation. */
function assertIntentRetained(f: ReturnType<typeof remoteFixture>): void {
  assert.deepEqual(parseCandidateReceipt(f.pr.body), f.receipt);
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
}

test("merged package version lookup must not substitute receipt data for a missing live file", async () => {
  const f = remoteFixture();
  const api: ReleaseApi = async (path, method, body) => path.includes(`/contents/package.json?ref=${f.pr.merge_commit_sha}`) ? null : f.api(path, method, body);
  await assert.rejects(inspectCandidate(f.receipt, f.options, api, f.registry, () => ({ states: f.state.checks, review: "APPROVED" })), /version proof is unreadable/);
  assertIntentRetained(f);
});

test("approval selects exact-head protected workflow runs across pages without a CI name assumption", async () => {
  const f = remoteFixture(); f.pr.state = "open"; f.pr.merged = false;
  const approved: string[] = [];
  const data = [Array.from({ length: 100 }, (_, id) => ({ id, name: "Different name", head_sha: f.c.headSha, event: "pull_request", status: "completed", conclusion: "success" })),
    [{ id: 201, name: "Build package", head_sha: f.c.headSha, event: "pull_request", status: "waiting", conclusion: null },
      { id: 202, name: "Build package", head_sha: "foreign", event: "pull_request", status: "waiting", conclusion: null },
      { id: 203, name: "CI", head_sha: f.c.headSha, event: "pull_request", status: "waiting", conclusion: null },
      { id: 204, name: "Build package", head_sha: f.c.headSha, event: "workflow_dispatch", status: "waiting", conclusion: null },
      { id: 205, name: "Build package", head_sha: f.c.headSha, event: "pull_request", status: "completed", conclusion: "success" },
      { id: 206, name: "Build package", head_sha: f.c.headSha, event: "pull_request", status: "completed", conclusion: "action_required" }]];
  const api: ReleaseApi = async (path, method) => {
    if (method === "POST") { approved.push(path); return {}; }
    if (path.includes("/actions/runs?")) return { workflow_runs: data[path.endsWith("page=1") ? 0 : 1] };
    return f.pr;
  };
  await approveRequiredWorkflowRuns(42, f.c.headSha, f.c.repository, api, () => ({ runs: ["201", "202", "204", "205", "206"] }));
  assert.deepEqual(approved, [201, 206].map(id => `repos/${f.c.repository}/actions/runs/${id}/approve`));
  Object.assign(f.pr.user, { login: "human" }); await assert.rejects(approveRequiredWorkflowRuns(42, f.c.headSha, f.c.repository, api), /Untrusted approval/);
});

test("required workflow URLs are bound to the exact repository and required issuer", () => {
  const saved = process.env.GITHUB_REPOSITORY; process.env.GITHUB_REPOSITORY = "example/package";
  try {
    const f = protectionFixture();
    f.nodes[0].checkSuite!.workflowRun = { url: "https://github.com/example/package/actions/runs/42223979312" };
    assert.deepEqual(requiredProtection(42, f.head, f.run, true).runs, ["42223979312"]);
    f.nodes[0].checkSuite!.app!.databaseId = 99; assert.deepEqual(requiredProtection(42, f.head, f.run, true).runs, []);
    f.nodes[0].checkSuite!.app!.databaseId = 7;
    for (const url of ["https://github.com/other/package/actions/runs/1", "https://github.com/example/package/actions/runs/NaN", "https://github.com/example/package/actions/runs/99999999999999999999999"]) {
      f.nodes[0].checkSuite!.workflowRun.url = url; assert.throws(() => requiredProtection(42, f.head, f.run, true), /Untrusted required workflow/);
    }
  } finally { if (saved === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = saved; }
});

test("native operator retirement preserves evidence and approval mode uses protected run discovery", async () => {
  await withAdapter(async f => {
    process.env.RETIRE_UNPUBLISHED = "true";
    const data = JSON.parse(readFileSync(join(f.root, "protection.json"), "utf8"));
    data.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].conclusion = "SKIPPED";
    writeFileSync(join(f.root, "protection.json"), JSON.stringify(data));
    await assert.rejects(runReleaseContinuation("verify"), /Publication requires/);
    f.state.comments.push({ user: { login: "github-actions[bot]" }, body: '<!-- pm-ops-post-hook-v1\n{}\n-->' });
    await assert.rejects(runReleaseContinuation("probe"), /retirement refused/);
    f.state.comments.splice(0);
    await runReleaseContinuation("probe");
    assert.equal(parseCandidateReceipt(f.pr.body), null);
    assert.match(readFileSync(join(f.root, "output"), "utf8"), /pending=false\naction=retire/);
    f.refresh(); delete process.env.RETIRE_UNPUBLISHED; f.pr.state = "open"; f.pr.merged = false;
    process.env.RELEASE_COMMIT = f.c.headSha;
    const transport = globalThis.fetch;
    globalThis.fetch = async (url, init) => String(url).includes("/actions/runs?head_sha=") ? new Response('{"workflow_runs":[]}') : transport(url, init);
    await runReleaseContinuation("approve");
  });
});

/** Configure authoritative open or squash-merged PR metadata consistently. */
function setMergeState(f: ReturnType<typeof remoteFixture>, merged: boolean): void {
  f.pr.merged = merged; f.pr.state = merged ? "closed" : "open";
  f.pr.merged_at = merged ? "2026-11-06T04:00:00Z" : null;
  f.pr.merge_commit_sha = merged ? f.e.pr.mergedSha : null;
}

/** Prove a retired receipt stays absent and permits a fresh verified-run stamp. */
async function freshPreparation(f: ReturnType<typeof remoteFixture> & { root: string }): Promise<{ version: string; configDigest: string }> {
  writeFileSync(join(f.root, "output"), ""); await runReleaseContinuation("probe");
  assert.equal(readFileSync(join(f.root, "output"), "utf8"), "pending=false\n");
  await runReleaseContinuation("stamp");
  return JSON.parse(readFileSync(join(f.root, ".github/pm-release-candidate.json"), "utf8")) as { version: string; configDigest: string };
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
    (f: ReturnType<typeof remoteFixture>) => { f.state.pkgName = "foreign-package"; },
  ]) { const f = remoteFixture(); mutate(f); await assert.rejects(f.inspect()); assert.ok(f.calls.every(call => call.method === "GET")); }
});

test("receipt parser binds one valid artifact and refuses malformed, ambiguous or absent records", () => {
  const f = remoteFixture();
  assert.deepEqual(parseCandidateReceipt(candidateBody(f.receipt)), f.receipt);
  assert.equal(parseCandidateReceipt("ordinary release PR"), null);
  for (const body of [candidateBody(f.receipt) + "extra", candidateBody(f.receipt) + candidateBody(f.receipt), candidateBody({ ...f.receipt, artifactId: 0 })]) assert.throws(() => parseCandidateReceipt(body));
});

/** Native contents-read policy and GraphQL rollup fixture, with no administration endpoint available. */
function protectionFixture() {
  const head = "b".repeat(40);
  const branch = { name: "main", protected: true, protection: { enabled: true, required_status_checks: {
    enforcement_level: "everyone", contexts: ["CI", "legacy"], checks: [{ context: "CI", app_id: 7 as number | null }, { context: "legacy", app_id: null as number | null }],
  } } };
  const nodes: { __typename: string; name?: string; context?: string; status?: string; conclusion?: string | null; state?: string | null; isRequired: boolean; checkSuite?: { app: { databaseId: number } | null; workflowRun?: { url: string } | null } }[] = [
    { __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true, checkSuite: { app: { databaseId: 7 } } },
    { __typename: "StatusContext", context: "legacy", state: "SUCCESS", isRequired: true },
  ];
  const pr = { headRefOid: head, baseRefName: "main", reviewDecision: "APPROVED" as string | null, commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: { totalCount: 2, pageInfo: { hasNextPage: false }, nodes } } } }] } };
  const response = { errors: undefined as unknown[] | undefined, data: { repository: { pullRequest: pr } } };
  const state = { rules: [] as unknown }, calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[1] === "repos/example/package/branches/main") return JSON.stringify(branch);
    if (args[1] === "repos/example/package/rules/branches/main") return JSON.stringify(state.rules);
    assert.equal(args[1], "graphql"); assert.ok(!args.some(arg => /branchProtectionRule|requiredStatusChecks/.test(arg)));
    assert.ok(args.some(arg => arg.includes("databaseId"))); return JSON.stringify(response);
  };
  return { head, branch, nodes, pr, response, state, calls, run, read: () => requiredProtection(42, head, run) };
}

test("native protection reader requires every context and issuer at the exact head and refuses truncated policy evidence", () => {
  const previous = process.env.GITHUB_REPOSITORY; process.env.GITHUB_REPOSITORY = "example/package";
  try {
    const f = protectionFixture();
    assert.deepEqual(f.read(), { states: ["SUCCESS", "SUCCESS"], review: "APPROVED" });
    f.nodes[0].checkSuite!.app!.databaseId = 99; assert.deepEqual(f.read().states, ["MISSING", "SUCCESS"]);
    f.nodes[0].checkSuite!.app!.databaseId = 7; f.nodes[0].status = "QUEUED"; assert.equal(f.read().states[0], "PENDING");
    f.nodes[0].status = "COMPLETED"; f.nodes[0].conclusion = "SKIPPED"; assert.equal(f.read().states[0], "SKIPPED");
    f.pr.reviewDecision = "REVIEW_REQUIRED"; assert.equal(f.read().review, "REVIEW_REQUIRED");
    f.pr.reviewDecision = null; assert.equal(f.read().review, "");
    const contexts = f.pr.commits.nodes[0].commit.statusCheckRollup.contexts;
    contexts.pageInfo.hasNextPage = true; assert.throws(f.read, /incomplete/);
    contexts.pageInfo.hasNextPage = false; contexts.totalCount = 3; assert.throws(f.read, /incomplete/);
    contexts.totalCount = 2; f.pr.headRefOid = "0".repeat(40); assert.throws(f.read, /incomplete/);
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
      git: `#!/bin/sh\ncase "$1" in\nrev-parse) if [ "$2" = HEAD ]; then echo '${c.headSha}'; else echo '${c.baseSha}'; fi ;;\nls-remote) [ -z "\${REMOTE_BRANCH_HEAD:-}" ] || printf '%s\\trefs/heads/release/2026.11.06\\n' "$REMOTE_BRANCH_HEAD" ;;\n      push) echo pushed >> "$REQUEST_FIXTURE/pushes" ;;\nesac\n`,
      gh: '#!/bin/sh\nif [ "$1 $2" = "pr create" ]; then echo https://example.invalid/pull/42; fi\nif [ "$1 $2" = "pr view" ] || [ "$1 $2" = "pr checks" ]; then echo pending >> "$REQUEST_FIXTURE/check-reads"; exit 1; fi\n',
      node: '#!/bin/sh\necho "$*" >> "$REQUEST_FIXTURE/transitions"\nif [ "$2" = retired-branch ] && [ "$RETIRED_BRANCH_VALID" != true ]; then exit 7; fi\n',
      sleep: '#!/bin/sh\necho sleep >> "$REQUEST_FIXTURE/sleeps"\nexit 9\n',
    };
    for (const [name, source] of Object.entries(scripts)) { writeFileSync(join(root, name), source); chmodSync(join(root, name), 0o755); }
    const shared = parse(readFileSync(new URL("../.github/workflows/daily-release.yml", import.meta.url), "utf8")) as {
      jobs: { request?: { steps: { name: string; run: string }[] }; release: { steps: { name: string; run: string }[] } };
    };
    const request = (shared.jobs.request ?? shared.jobs.release).steps.find(step => step.name === "Merge release metadata through protected PR")!.run;
    const requestFile = join(root, "request.sh"); writeFileSync(requestFile, request);
    const requestEnv = {
      PATH: `${root}:/usr/bin:/bin`, REQUEST_FIXTURE: root, RELEASE_BASE_SHA: c.baseSha, RELEASE_BRANCH: "release/2026.11.06", RELEASE_PR_NUMBER: "",
      RELEASE_TAG: c.tag, REPO_NAME: "package", GITHUB_REPOSITORY: c.repository, GITHUB_OUTPUT: join(root, "output"), CONTINUATION_SCRIPT: "continuation.ts",
    };
    const result = spawnSync("bash", ["--noprofile", "--norc", requestFile], { encoding: "utf8", timeout: 2000, env: requestEnv });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(readFileSync(join(root, "transitions"), "utf8"), /continuation.ts request/);
    assert.match(readFileSync(join(root, "output"), "utf8"), /pr_number=42/);
    for (const path of ["check-reads", "sleeps"]) assert.equal(existsSync(join(root, path)), false);
    for (const trusted of [true, false]) {
      writeFileSync(join(root, "pushes"), "");
      const retry = spawnSync("bash", ["--noprofile", "--norc", requestFile], { encoding: "utf8", timeout: 2000, env: { ...requestEnv, REMOTE_BRANCH_HEAD: c.headSha, RETIRED_BRANCH_VALID: String(trusted) } });
      assert.equal(retry.status, trusted ? 0 : 7, retry.stdout + retry.stderr);
      assert.equal(readFileSync(join(root, "pushes"), "utf8"), trusted ? "pushed\n" : "");
      assert.match(readFileSync(join(root, "transitions"), "utf8"), /retired-branch/);
    }

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
        ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
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
    if (method !== "GET") { effects.push({ path, method, body }); if (method === "PATCH") Object.assign(old, body); return {}; }
    return path.endsWith("/42") ? f.pr : old;
  };
  await closeSuperseded([42, 41], 42, f.c.repository, api);
  assert.deepEqual(effects.map(effect => effect.body), [{ body: "Superseded by release PR #42." }, { body: retiredCandidateBody(f.receipt, "Superseded by release PR #42.") }, { state: "closed" }]);
  for (const mutate of [() => { old.head.repo.full_name = "foreign/package"; }, () => { old.head.ref = "feature/old"; }, () => { old.user.login = "human"; }]) {
    mutate(); effects.length = 0; await closeSuperseded([41], 42, f.c.repository, api); assert.equal(effects.length, 0);
  }
  const currentBody = f.pr.body;
  for (const body of ["owned but unverified", null]) {
    Object.assign(f.pr, { body });
    await assert.rejects(closeSuperseded([41], 42, f.c.repository, api), /successor receipt/);
  }
  Object.assign(f.pr, { body: currentBody });
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

test("entry point captures npm and GitHub-only manifests without executing package bytes", async () => {
  await withAdapter(async f => {
    await runReleaseContinuation("manifest");
    assert.equal(JSON.parse(readFileSync(join(f.handoff, "candidate.json"), "utf8")).packageSha256, f.c.packageSha256);
    process.env.IS_RUST = "true"; process.env.NPM_PUBLISH = "false"; process.env.PACKAGE_NAME = ""; delete process.env.CLI_VERSION;
    await runReleaseContinuation("manifest");
    const rust = JSON.parse(readFileSync(join(f.handoff, "candidate.json"), "utf8")) as { packageName: string; cliVersion: string; npmPublish: boolean; packageSha256: string };
    assert.equal(rust.packageName, "github-only"); assert.equal(rust.cliVersion, ""); assert.equal(rust.npmPublish, false); assert.equal(rust.packageSha256, releaseDigest(""));
  });
});

test("entry point confirms durable receipt before enabling exact-head protected squash auto-merge", async () => {
  await withAdapter(async f => {
    f.pr.state = "open"; f.pr.merged = false; f.pr.body = "ordinary bot PR";
    await runReleaseContinuation("ownership"); await runReleaseContinuation("request");
    assert.deepEqual(parseCandidateReceipt(f.pr.body), f.receipt);
    assert.equal(readFileSync(join(f.root, "merges"), "utf8"), "merge\n");
    assert.ok(f.calls.findIndex(call => call.method === "PATCH") < f.calls.length - 1);
    process.env.SUPERSEDED_PR_NUMBERS = "42"; await runReleaseContinuation("supersede");
    delete process.env.SUPERSEDED_PR_NUMBERS; await runReleaseContinuation("supersede");
  });
  await withAdapter(async f => {
    f.pr.state = "open"; Object.assign(f.pr, { body: null }); f.control.ignorePersistence = true;
    await assert.rejects(runReleaseContinuation("request"), /persistence/); assert.equal(existsSync(join(f.root, "merges")), false);
  });
  for (const defect of ["author", "head", "state", "branch"]) await withAdapter(async f => {
    f.pr.state = "open";
    if (defect === "author") f.pr.user.login = "human";
    if (defect === "head") f.pr.head.sha = "0".repeat(40);
    if (defect === "state") f.pr.state = "closed";
    if (defect === "branch") process.env.RELEASE_BRANCH = "release/2026.11.05";
    await assert.rejects(runReleaseContinuation("ownership"), /ownership or head/);
    if (defect !== "branch") await assert.rejects(runReleaseContinuation("request"), /identity changed/);
    assert.equal(existsSync(join(f.root, "merges")), false);
  });
});

test("entry point probes empty, pending, stale-base and merged intent without inventing new work", async () => {
  for (const mode of ["empty", "closed", "human", "pending", "refresh", "merged"]) await withAdapter(async f => {
    if (mode === "empty") f.pr.body = "ordinary PR";
    if (mode === "closed") { f.pr.merged_at = null; f.pr.merged = false; }
    if (mode === "human") f.pr.user.login = "human";
    if (mode === "pending" || mode === "refresh") { f.pr.state = "open"; f.pr.merged = false; f.pr.merged_at = null; }
    if (mode === "pending") { f.state.main = f.c.baseSha; f.pr.merge_commit_sha = null; }
    await runReleaseContinuation("probe");
    const output = readFileSync(join(f.root, "output"), "utf8");
    if (["empty", "closed", "human"].includes(mode)) assert.equal(output, "pending=false\n");
    else assert.match(output, new RegExp(`action=${mode === "merged" ? "publish" : mode}`));
    assert.ok(f.calls.every(call => call.method === "GET"));
  });
  await withAdapter(async f => {
    const fetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => String(input).includes("/pulls?") ? new Response(JSON.stringify([f.pr, { ...f.pr, number: 43 }])) : fetch(input, init);
    await assert.rejects(runReleaseContinuation("probe"), /Multiple pending/);
  });
});

test("entry point journals an admitted attempt and clears intent only after complete live reconciliation", async () => {
  await withAdapter(async f => {
    await runReleaseContinuation("verify");
    await assert.rejects(runReleaseContinuation("complete"), /not completely/);
    await runReleaseContinuation("attempt");
    const journal = f.calls.find(call => call.method === "POST")?.body as { body: string };
    assert.ok(journal.body.includes(releaseDigest(JSON.stringify(f.c))));
    await assert.rejects(runReleaseContinuation("complete"), /not completely|ambiguous/);
    Object.assign(f.state, { registry: true });
    await assert.rejects(runReleaseContinuation("attempt"), /not admitted/);
    Object.assign(f.state, { tag: f.e.pr.mergedSha, release: true });
    await runReleaseContinuation("complete"); assert.ok(!f.pr.body.includes("pm-ops-candidate"));
  });
  for (const mode of [undefined, "foreign-mode"]) await withAdapter(async () => { await assert.rejects(runReleaseContinuation(mode), /Unknown continuation/); });
  await withAdapter(async () => { delete process.env.GITHUB_REPOSITORY; await assert.rejects(runReleaseContinuation("probe"), /Missing workflow input/); });
  await withAdapter(async () => { process.env.CALLER_WORKFLOW = "foreign/workflow"; await assert.rejects(runReleaseContinuation("probe"), /Unexpected caller/); });
});

test("native HTTP transport treats only 404 as absence and preserves definitive and unreadable failures", async () => {
  await withAdapter(async () => {
    for (const status of [200, 204, 404, 403, 429, 500]) {
      globalThis.fetch = async (_input, init) => {
        if (init?.method === "POST") assert.equal(init.body, '{"intent":true}');
        return new Response(status === 204 ? null : '{"proof":true}', { status });
      };
      if (status >= 400 && status !== 404) { await assert.rejects(githubApi("fixture"), /refused/); await assert.rejects(registryJson("fixture"), /unavailable/); }
      else {
        if (status === 404) { assert.equal(await githubApi("fixture"), null); await assert.rejects(githubApi("fixture", "POST", { intent: true }), /refused/); }
        else assert.deepEqual(await githubApi("fixture", "POST", { intent: true }), status === 204 ? {} : { proof: true });
        if (status !== 204) assert.deepEqual(await registryJson("fixture"), status === 404 ? null : { proof: true });
      }
    }
  });
});

test("reconciliation refuses incomplete pagination, duplicate receipts and a receipt changed after discovery", async () => {
  const f = remoteFixture();
  for (const response of [null, [], [f.pr, f.pr], Array.from({ length: 100 }, () => f.pr)]) {
    const api: ReleaseApi = async (path, method, body) => path.includes("/pulls?") ? response : f.api(path, method, body);
    await assert.rejects(inspectCandidate(f.receipt, f.options, api, f.registry), /paginated|bounded|missing or duplicated/);
  }
  const changed: ReleaseApi = async (path, method, body) => path.endsWith("/pulls/42") ? { ...f.pr, body: null } : f.api(path, method, body);
  await assert.rejects(inspectCandidate(f.receipt, f.options, changed, f.registry), /receipt changed/);
  Object.assign(f.pr.head, { repo: null });
  await assert.rejects(f.inspect(), /missing or duplicated/);
});

test("tag proof peels annotated refs and refuses missing, cyclic and non-commit targets", async () => {
  const f = remoteFixture(); f.state.registry = true;
  for (const kind of ["peeled", "missing", "cycle", "blob"]) {
    const api: ReleaseApi = async (path, method, body) => {
      if (path.includes("/git/ref/tags/")) return { object: { type: kind === "blob" ? "blob" : "tag", sha: "9".repeat(40) } };
      if (path.includes("/git/tags/")) return kind === "missing" ? null : { object: { type: kind === "peeled" ? "commit" : "tag", sha: f.e.pr.mergedSha } };
      return f.api(path, method, body);
    };
    if (kind === "peeled") assert.equal((await inspectCandidate(f.receipt, f.options, api, f.registry, () => ({ states: ["SUCCESS"], review: "APPROVED" }))).action, "recover");
    else await assert.rejects(inspectCandidate(f.receipt, f.options, api, f.registry, () => ({ states: ["SUCCESS"], review: "APPROVED" })), /tag target/);
  }
});

test("registry proof refuses missing attestations, foreign endpoints, wrong subjects, predicates and source commits", async () => {
  const f = remoteFixture(); f.state.registry = true;
  for (const defect of ["integrity", "missing", "foreign", "predicate", "subject", "commit"]) {
    const registry = async (path: string): Promise<unknown> => {
      if (path === `${f.c.packageName}/${f.c.version}`) return { dist: { integrity: defect === "integrity" ? "wrong" : f.c.packageIntegrity,
        ...(defect === "missing" ? {} : { attestations: { url: defect === "foreign" ? "https://example.invalid/attestation" : "https://registry.npmjs.org/-/proof" } }) } };
      const payload = Buffer.from(JSON.stringify({ subject: [{ digest: { sha512: defect === "subject" ? "wrong" : Buffer.from(f.c.packageIntegrity.slice(7), "base64").toString("hex") } }],
        predicate: { buildDefinition: { resolvedDependencies: [{ digest: { gitCommit: defect === "commit" ? "wrong" : f.e.pr.mergedSha } }] } } })).toString("base64");
      return { attestations: [{ predicateType: defect === "predicate" ? "other" : "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload } } }] };
    };
    await assert.rejects(inspectCandidate(f.receipt, f.options, f.api, registry, () => ({ states: ["SUCCESS"], review: "APPROVED" })), /identity disagrees/);
  }
});

test("publication history and workspace paths refuse unreadable or escaping inputs while a new package remains eligible", async () => {
  const f = remoteFixture();
  const check = () => ({ states: ["SUCCESS"], review: "APPROVED" });
  for (const data of [null, {}, { time: "wrong" }, { time: [] }, { time: { created: f.options.now, modified: f.options.now, [f.c.version]: f.options.now } }]) {
    const registry = async () => data;
    if (data === null || (typeof data.time === "object" && data.time !== null && !Array.isArray(data.time))) {
      const registry = async (path: string) => path === f.c.packageName ? data : null;
      assert.equal((await inspectCandidate(f.receipt, f.options, f.api, registry, check)).action, "publish");
    } else await assert.rejects(inspectCandidate(f.receipt, f.options, f.api, async (path: string) => path === f.c.packageName ? await registry() : null, check), /publication history/);
  }
  for (const path of ["/outside", "../outside", "nested?query", "nested#fragment"]) {
    process.env.NPM_PROJECT_DIR = path; await assert.rejects(inspectCandidate(f.receipt, f.options, f.api, f.registry, check), /Unsafe project/);
  }
  process.env.NPM_PROJECT_DIR = "nested/package";
  const nested: ReleaseApi = async (path, method, body) => f.api(path.replace("contents/nested/package/", "contents/"), method, body);
  assert.equal((await inspectCandidate(f.receipt, f.options, nested, f.registry, check)).action, "publish");
  process.env.NPM_PROJECT_DIR = ".";
});

test("GitHub-only recovery retains Cargo identity and the daily cap until the Release exists", async () => {
  const f = remoteFixture(); f.c.npmPublish = false; f.pr.body = candidateBody(f.receipt); process.env.IS_RUST = "true";
  let cargo = `[package]\nversion = "${f.c.version}"\n`;
  const api: ReleaseApi = async (path, method, body) => path.includes("contents/Cargo.toml?") ? { content: Buffer.from(cargo).toString("base64") } : f.api(path, method, body);
  const check = () => ({ states: ["SUCCESS"], review: "" });
  try {
    assert.equal((await inspectCandidate(f.receipt, f.options, api, f.registry, check)).action, "publish");
    f.state.tag = f.e.pr.mergedSha; assert.equal((await inspectCandidate(f.receipt, f.options, api, f.registry, check)).action, "recover");
    f.state.publishedAt = f.options.now; await assert.rejects(inspectCandidate(f.receipt, f.options, api, f.registry, check), /Daily/);
    Object.assign(f.state, { release: true }); assert.equal((await inspectCandidate(f.receipt, f.options, api, f.registry, check)).action, "complete");
    cargo = "[package]\n"; await assert.rejects(inspectCandidate(f.receipt, f.options, api, f.registry, check), /Merged source/);
  } finally { delete process.env.IS_RUST; }
});

test("inconsistent GitHub Releases and cleanup failures retain intent without touching foreign PRs", async () => {
  const f = remoteFixture(); const check = () => ({ states: ["SUCCESS"], review: "APPROVED" });
  for (const defect of ["tag", "draft", "missing-tag"]) {
    f.state.tag = defect === "missing-tag" ? null : f.e.pr.mergedSha;
    const api: ReleaseApi = async (path, method, body) => path.includes("/releases/tags/") ? { tag_name: defect === "tag" ? "foreign" : f.c.tag, draft: defect === "draft" } : f.api(path, method, body);
    await assert.rejects(inspectCandidate(f.receipt, f.options, api, f.registry, check), /Release identity/);
  }
  const api: ReleaseApi = async path => { if (path.endsWith("/42")) return f.pr; throw new Error("synthetic cleanup failure"); };
  await assert.rejects(closeSuperseded([41], 42, f.c.repository, api), /Could not retire or close/);
  Object.assign(f.pr, { merged: false }); await assert.rejects(closeSuperseded([41], 42, f.c.repository, api), /successor/);
});

test("native protection refuses API errors and absent policy while nullable states stay missing", () => {
  const previous = process.env.GITHUB_REPOSITORY; process.env.GITHUB_REPOSITORY = "example/package";
  try {
    const f = protectionFixture(); f.pr.reviewDecision = null;
    f.nodes[0].conclusion = null; f.nodes[1].state = null;
    assert.deepEqual(f.read(), { states: ["MISSING", "MISSING"], review: "" });
    f.response.errors = [{}]; assert.throws(f.read, /incomplete/); f.response.errors = undefined;
    const commit = f.pr.commits.nodes[0].commit;
    commit.oid = "wrong"; assert.throws(f.read, /incomplete/); commit.oid = f.head;
    Object.assign(f.branch, { protection: null }); assert.throws(f.read, /incomplete/);
  } finally { if (previous === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = previous; }
});

test("importing the adapter without a main argv never starts a release transition", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import ${JSON.stringify(new URL("../scripts/release-continuation.ts", import.meta.url).href)};`], {
    encoding: "utf8", env: { ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) },
  });
  assert.equal(result.status, 0, result.stderr);
});


test("workflow path normalization accepts qualified same-repository main refs and refuses foreign identities", async () => {
  const f = remoteFixture();
  for (const prefix of ["", f.c.repository + "/"]) {
    for (const suffix of ["", "@main", "@refs/heads/main", "@" + f.c.baseSha]) {
      f.run.path = prefix + f.c.workflow + suffix;
      assert.equal((await f.inspect()).action, "publish");
    }
  }
  for (const path of ["foreign/package/" + f.c.workflow + "@main", f.c.workflow + "@feature", f.c.workflow + "@main@main", ".github/workflows/other.yml@main"]) {
    f.run.path = path;
    await assert.rejects(f.inspect());
  }
  assert.throws(() => normalizeWorkflowPath("invalid", f.c.repository, "main", f.c.baseSha));
});

test("unrelated malformed candidate bodies cannot block owned release discovery", async () => {
  const f = remoteFixture();
  const foreign = { ...f.pr, number: 99, body: "<!-- pm-ops-candidate-v1\nbroken", user: { login: "human" } };
  const api: ReleaseApi = (path, method, body) => path.includes("/pulls?") ? Promise.resolve([foreign, f.pr]) : f.api(path, method, body);
  assert.equal((await inspectCandidate(f.receipt, f.options, api, f.registry, () => ({ states: ["SUCCESS"], review: "APPROVED" }))).action, "publish");
  foreign.user.login = "github-actions[bot]";
  await assert.rejects(inspectCandidate(f.receipt, f.options, api, f.registry), /Malformed/);
});

test("GitHub write 404 refuses publication and receipt completion while GET 404 remains absence", async () => {
  await withAdapter(async f => {
    Object.assign(f.control, { write404: true });
    await assert.rejects(runReleaseContinuation("attempt"), /GitHub API refused POST.*404/);
    assert.ok(f.pr.body.includes("pm-ops-candidate-v1"));
    Object.assign(f.state, { registry: true, tag: f.e.pr.mergedSha, release: true });
    await assert.rejects(runReleaseContinuation("complete"), /GitHub API refused PATCH.*404/);
    assert.ok(f.pr.body.includes("pm-ops-candidate-v1"));
  });
});

test("post-release recovery journals one hook and retains intent until durable completion", async () => {
  await withAdapter(async f => {
    Object.assign(f.state, { registry: true, tag: f.e.pr.mergedSha, release: true });
    process.env.POST_RELEASE_SCRIPT = "release:bundle.v1";
    process.env.NPM_PROJECT_PATH = f.root;
    await assert.rejects(runReleaseContinuation("complete"), /Post-release hook/);
    assert.ok(f.pr.body.includes("pm-ops-candidate-v1"));
    f.state.comments.push({ user: { login: "human" }, body: "<!-- pm-ops-post-hook-v1\nbroken" }, { user: { login: "github-actions[bot]" }, body: "unrelated bot comment" }, { user: { login: "github-actions[bot]" }, body: '<!-- pm-ops-post-hook-v1\n{"fingerprint":"foreign","state":"complete"}\n-->' });
    await runReleaseContinuation("post-hook");
    await runReleaseContinuation("post-hook");
    assert.equal(readFileSync(join(f.root, "hooks"), "utf8"), "run release:bundle.v1\n");
    await runReleaseContinuation("complete");
    assert.ok(!f.pr.body.includes("pm-ops-candidate-v1"));
  });
});

test("post-release recovery refuses failed journal writes and ambiguous hook attempts without replay", async () => {
  await withAdapter(async f => {
    process.env.POST_RELEASE_SCRIPT = "release:bundle";
    await assert.rejects(runReleaseContinuation("post-hook"), /requires reconciled/);
    Object.assign(f.state, { registry: true, tag: f.e.pr.mergedSha, release: true });
    process.env.POST_RELEASE_SCRIPT = "unsafe script";
    await assert.rejects(runReleaseContinuation("post-hook"), /Unsafe/);
    process.env.POST_RELEASE_SCRIPT = "release:bundle";
    Object.assign(f.control, { write404: true });
    await assert.rejects(runReleaseContinuation("post-hook"), /GitHub API refused POST/);
    assert.equal(existsSync(join(f.root, "hooks")), false);
    Object.assign(f.control, { write404: false });
    writeFileSync(join(f.root, "npm"), "#!/bin/sh\nexit 1\n");
    await assert.rejects(runReleaseContinuation("post-hook"));
    await assert.rejects(runReleaseContinuation("post-hook"), /incomplete or ambiguous/);
    await assert.rejects(runReleaseContinuation("complete"), /incomplete or ambiguous/);
    assert.ok(f.pr.body.includes("pm-ops-candidate-v1"));
  });
});


test("crash after hook success but before completion journal refuses automatic replay", async () => {
  await withAdapter(async f => {
    Object.assign(f.state, { registry: true, tag: f.e.pr.mergedSha, release: true });
    process.env.POST_RELEASE_SCRIPT = "release:bundle";
    f.control.failWriteAt = 2;
    await assert.rejects(runReleaseContinuation("post-hook"), /GitHub API refused POST/);
    assert.equal(readFileSync(join(f.root, "hooks"), "utf8"), "run release:bundle\n");
    await assert.rejects(runReleaseContinuation("post-hook"), /incomplete or ambiguous/);
    await assert.rejects(runReleaseContinuation("complete"), /incomplete or ambiguous/);
    assert.equal(readFileSync(join(f.root, "hooks"), "utf8"), "run release:bundle\n");
    assert.ok(f.pr.body.includes("pm-ops-candidate-v1"));
  });
});


test("fresh daily probe retires stranded unpublished intent and admits later preparation with leased branch reuse", async () => {
  await withAdapter(async f => {
    f.state.main = "9".repeat(40); process.env.TRIGGER_SHA = f.state.main;
    await assert.rejects(runReleaseContinuation("verify"), /current-source identity/);
    await assert.rejects(runReleaseContinuation("attempt"), /not admitted/);
    await runReleaseContinuation("probe");
    assert.match(readFileSync(join(f.root, "output"), "utf8"), /action=stranded/);
    assert.match(readFileSync(join(f.root, "output"), "utf8"), /pending=false/);
    assert.equal(parseCandidateReceipt(f.pr.body), null);
    assert.deepEqual(parseCandidateReceipt(f.pr.body, true), f.receipt);
    assert.ok(f.state.comments.some(comment => comment.body.includes("Retired unpublished release")));
    assert.ok(!f.calls.some(call => /releases|git\/refs/.test(call.path) && call.method !== "GET"));
    writeFileSync(join(f.root, "output"), "");
    await runReleaseContinuation("probe");
    assert.equal(readFileSync(join(f.root, "output"), "utf8"), "pending=false\n");
    await runReleaseContinuation("retired-branch");
  });
});

test("old delivery cannot retire a stranded receipt and attested repair survives advanced main", async () => {
  await withAdapter(async f => {
    f.state.main = "9".repeat(40);
    await runReleaseContinuation("probe");
    assert.match(readFileSync(join(f.root, "output"), "utf8"), /pending=true/);
    assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
    assert.deepEqual(parseCandidateReceipt(f.pr.body), f.receipt);
    Object.assign(f.state, { registry: true });
    await runReleaseContinuation("verify");
    assert.match(readFileSync(join(f.root, "output"), "utf8"), /action=recover/);
    await assert.rejects(runReleaseContinuation("attempt"), /not admitted/);
    assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
  });
});

test("stranded retirement refuses failed or unconfirmed writes and retains exact intent", async () => {
  await withAdapter(async f => {
    f.state.main = "9".repeat(40); process.env.TRIGGER_SHA = f.state.main;
    f.control.write404 = true;
    await assert.rejects(runReleaseContinuation("probe"), /GitHub API refused POST/);
    Object.assign(f.control, { write404: false, ignorePersistence: true });
    await assert.rejects(runReleaseContinuation("probe"), /retirement was not confirmed/);
    assert.deepEqual(parseCandidateReceipt(f.pr.body), f.receipt);
    assert.doesNotMatch(readFileSync(join(f.root, "output"), "utf8"), /pending=false/);
  });
});

test("retired branch reuse refuses unowned, unmerged, changed or unreceipted remote heads", async () => {
  for (const defect of ["active", "fork", "open", "unmerged", "head", "receipt-head", "receipt-repo", "body"]) await withAdapter(async f => {
    f.pr.body = retiredCandidateBody(f.receipt, "Retired");
    if (defect === "active") f.pr.body = candidateBody(f.receipt);
    if (defect === "fork") f.pr.head.repo.full_name = "foreign/package";
    if (defect === "open") f.pr.state = "open";
    if (defect === "unmerged") f.pr.merged = false;
    if (defect === "head") f.pr.head.sha = "9".repeat(40);
    if (defect === "receipt-head") f.pr.body = retiredCandidateBody({ ...f.receipt, candidate: { ...f.c, headSha: "9".repeat(40) } }, "Retired");
    if (defect === "receipt-repo") f.pr.body = retiredCandidateBody({ ...f.receipt, candidate: { ...f.c, repository: "foreign/package" } }, "Retired");
    if (defect === "body") f.pr.body = "<!-- pm-ops-retired-candidate-v1\nbroken";
    await assert.rejects(runReleaseContinuation("retired-branch"));
    assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
  });
});

test("a failed superseded close cannot leave an active receipt to block discovery", async () => {
  const f = remoteFixture(); f.pr.state = "open";
  const old = structuredClone(f.pr); old.number = 41; old.head.ref = "release/2026.11.05";
  const api: ReleaseApi = async (path, method = "GET", body) => {
    if (method === "PATCH") {
      const patch = body as { body?: string; state?: string };
      if (patch.state) throw new Error("synthetic close failure");
      Object.assign(old, patch); return {};
    }
    if (method === "POST") return {};
    return path.endsWith("/42") ? f.pr : old;
  };
  await assert.rejects(closeSuperseded([41], 42, f.c.repository, api), /Could not retire or close/);
  assert.equal(old.state, "open");
  assert.equal(parseCandidateReceipt(old.body), null);
  assert.deepEqual(parseCandidateReceipt(old.body, true), f.receipt);
  assert.deepEqual([f.pr, old].filter(pr => parseCandidateReceipt(pr.body)).map(pr => pr.number), [42]);
  for (const body of ["legacy owned release PR", null]) {
    Object.assign(old, { body });
    await assert.rejects(closeSuperseded([41], 42, f.c.repository, api), /Could not retire or close/);
    assert.equal(parseCandidateReceipt(old.body), null);
  }
});


test("preparation stamp binds a fresh run even when version metadata is already on main", async () => {
  await withAdapter(async f => {
    await runReleaseContinuation("stamp");
    const path = join(f.root, ".github/pm-release-candidate.json"), first = readFileSync(path, "utf8");
    assert.equal(JSON.parse(first).baseSha, f.c.baseSha);
    assert.equal(JSON.parse(first).version, f.c.version);
    process.env.GITHUB_RUN_ID = "11";
    await runReleaseContinuation("stamp");
    assert.notEqual(readFileSync(path, "utf8"), first);
    for (const [key, bad] of [["RELEASE_BASE_SHA", "bad"], ["NPM_VERSION", "latest"], ["GITHUB_RUN_ID", "1.5"], ["GITHUB_RUN_ID", "0"], ["GITHUB_RUN_ATTEMPT", "1.5"], ["GITHUB_RUN_ATTEMPT", "0"]]) {
      const before = process.env[key]; process.env[key] = bad;
      await assert.rejects(runReleaseContinuation("stamp"), /Malformed preparation/);
      if (before === undefined) delete process.env[key]; else process.env[key] = before;
    }
    process.env.GITHUB_REPOSITORY = "foreign"; process.env.CALLER_WORKFLOW = "foreign/.github/workflows/release.yml@main";
    await assert.rejects(runReleaseContinuation("stamp"), /Malformed preparation/);
  });
});

test("fresh retirement and retired-branch reuse refuse an intent changed after discovery", async () => {
  for (const transition of ["probe", "retired-branch"]) await withAdapter(async f => {
    f.state.main = "9".repeat(40); process.env.TRIGGER_SHA = f.state.main;
    if (transition === "retired-branch") f.pr.body = retiredCandidateBody(f.receipt, "Retired");
    const transport = globalThis.fetch; let reads = 0;
    globalThis.fetch = async (input, init) => {
      const target = String(input).endsWith("/pulls/42") && init?.method === "GET";
      const patch = target && ++reads === (transition === "probe" ? 2 : 1);
      const response = await transport(input, init);
      return patch ? new Response(JSON.stringify({ ...f.pr, body: transition === "probe" ? "changed after discovery" : null }), { status: 200 }) : response;
    };
    await assert.rejects(runReleaseContinuation(transition), /changed before retirement|branch identity changed/);
    assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
  });
});


test("successful preparation remains trusted after later cleanup fails, with exact-attempt job proof", async () => {
  const f = remoteFixture(); f.run.conclusion = "failure";
  assert.equal((await f.inspect()).action, "publish");
  assert.ok(f.calls.some(call => call.path.includes("/attempts/1/jobs?")));
  const rerun: ReleaseApi = (path, method, body) => path.endsWith("/runs/10/attempts/1") ? Promise.resolve({ ...f.run, run_attempt: 1 })
    : path.endsWith("/runs/10") ? Promise.resolve({ ...f.run, run_attempt: 2 }) : f.api(path, method, body);
  assert.equal((await inspectCandidate(f.receipt, f.options, rerun, f.registry, () => ({ states: ["SUCCESS"], review: "APPROVED" }))).action, "publish");
  for (const [status, conclusion] of [["in_progress", "success"], ["completed", "failure"], ["completed", null]]) {
    await assert.rejects(inspectJobProof(f, { total_count: 1, jobs: [{ name: "prepare", status, conclusion, run_id: f.c.runId, head_sha: f.c.baseSha }] }), /Untrusted/);
  }
});

test("preparation job proof refuses missing, duplicate, truncated or changing pages", async () => {
  const f = remoteFixture(), job = { name: "prepare", status: "completed", conclusion: "success", run_id: f.c.runId, head_sha: f.c.baseSha };
  for (const data of [{ total_count: -1, jobs: [] }, { total_count: 0, jobs: [] }, { total_count: 1, jobs: [] }, { total_count: 2, jobs: [job, job] }, { total_count: 1, jobs: null }]) {
    await assert.rejects(inspectJobProof(f, data), /preparation job|paginated/);
  }
  for (const patch of [{ run_id: 999 }, { head_sha: "9".repeat(40) }]) {
    await assert.rejects(inspectJobProof(f, { total_count: 1, jobs: [{ ...job, ...patch }] }), /job identity/);
  }
  for (const changing of [false, true]) {
    const inspect = () => inspectJobProof(f, path => ({ total_count: changing && path.endsWith("page=2") ? 102 : 101,
      jobs: path.endsWith("page=1") ? Array.from({ length: 100 }, () => ({ ...job, name: "other" })) : [job] }));
    if (changing) await assert.rejects(inspect(), /job count/);
    else assert.equal((await inspect()).action, "publish");
  }
});

test("a changed squash parent or tree retires on current main, allowing the next preparation without publication", async () => {
  for (const changed of ["parent", "tree", "version"]) await withAdapter(async f => {
    if (changed === "parent") f.state.parents = ["9".repeat(40)];
    if (changed === "tree") f.state.tree = "9".repeat(40);
    if (changed === "version") f.state.pkgVersion = "2026.11.7";
    assert.equal(f.state.main, f.e.pr.mergedSha);
    await assert.rejects(runReleaseContinuation("verify"), /current-source identity/);
    await runReleaseContinuation("probe");
    assert.match(readFileSync(join(f.root, "output"), "utf8"), /pending=false/);
    assert.equal(parseCandidateReceipt(f.pr.body), null);
    assert.ok(f.state.comments.some(comment => comment.body.includes("Fresh preparation is required")));
    assert.equal(f.calls.some(call => call.method !== "GET" && /releases|git\/refs/.test(call.path)), false);
    assert.equal((await freshPreparation(f)).version, f.c.version);
  });
});

test("the verify adapter refuses a stale trigger even when every current merged identity agrees", async () => {
  await withAdapter(async f => {
    assert.equal(f.state.main, f.e.pr.mergedSha);
    process.env.TRIGGER_SHA = "9".repeat(40);
    await assert.rejects(runReleaseContinuation("verify"), /current-source identity/);
    assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
    assert.deepEqual(parseCandidateReceipt(f.pr.body), f.receipt);
  });
});

test("trusted tool source is bound to the original run and preserves legacy receipts", async () => {
  const f = remoteFixture();
  assert.equal((await f.inspect()).toolsSha, f.c.toolsSha);
  assert.equal((await f.inspect()).signerWorkflow, "unbraind/pm-ops/.github/workflows/daily-release.yml@refs/heads/main");
  delete f.c.toolsSha; f.pr.body = candidateBody(f.receipt);
  assert.equal((await f.inspect()).toolsSha, "f".repeat(40));
  for (const referenced of [[], [{ path: "foreign/workflow@main", sha: "f".repeat(40) }],
    [{ path: "unbraind/pm-ops/.github/workflows/daily-release.yml@main", sha: "bad" }], [...f.run.referenced_workflows, ...f.run.referenced_workflows]]) {
    f.run.referenced_workflows = referenced; await assert.rejects(f.inspect(), /tools commit/);
  }
  const fresh = remoteFixture(); fresh.run.referenced_workflows[0].sha = "9".repeat(40);
  await assert.rejects(fresh.inspect(), /tools commit/);
  const version = remoteFixture();
  const api: ReleaseApi = async (path, method, body) => path.startsWith("repos/unbraind/pm-ops/contents/") ? { content: Buffer.from('{"name":"pm-ops","version":"9999.1.1"}').toString("base64") } : version.api(path, method, body);
  await assert.rejects(inspectCandidate(version.receipt, version.options, api, version.registry), /tools version/);
});

test("a forged registry signature preserves active intent instead of repairing or clearing it", async () => {
  await withAdapter(async f => {
    f.state.registry = true;
    await assert.rejects(runProductionContinuation("probe", async () => { throw new Error("Invalid Sigstore signature"); }), /Invalid Sigstore signature/);
    assertIntentRetained(f);
  });
});

test("legacy self-caller derives its exact source tools from main when referenced workflows are absent", async () => {
  const f = remoteFixture();
  f.c.repository = "unbraind/pm-ops"; delete f.c.toolsSha;
  f.options.repository = f.c.repository; f.run.repository.full_name = f.c.repository;
  f.pr.head.repo.full_name = f.c.repository; f.pr.base.repo.full_name = f.c.repository;
  f.c.packageName = "pm-ops"; f.state.pkgName = "pm-ops";
  Reflect.deleteProperty(f.run, "referenced_workflows"); f.pr.body = candidateBody(f.receipt);
  assert.equal((await f.inspect()).toolsSha, f.c.baseSha);
  f.options.repository = "other/package";
  await assert.rejects(f.inspect());
});

test("production adapter cryptographically refuses unsigned registry JSON without an injected verifier", async () => {
  const f = remoteFixture(); f.state.registry = true;
  await assert.rejects(inspectProductionCandidate(f.receipt, f.options, f.api, f.registry, () => ({ states: ["SUCCESS"], review: "APPROVED" })));
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});


test("registry proof separates the authenticated reusable signer from signed caller source identity", async () => {
  const f = remoteFixture(); f.state.registry = true; let verified = false;
  await inspectProductionCandidate(f.receipt, f.options, f.api, f.registry, () => ({ states: ["SUCCESS"], review: "APPROVED" }), async (_bundle, identity) => {
    assert.equal(identity.repository, f.c.repository); assert.equal(identity.workflow, f.c.workflow);
    assert.equal(identity.signerWorkflow, "unbraind/pm-ops/.github/workflows/daily-release.yml@refs/heads/main"); verified = true;
  });
  assert.equal(verified, true);
});

test("changed caller config retires open or merged unpublished intent even when the project path changes", async () => {
  for (const merged of [false, true]) await withAdapter(async f => {
    setMergeState(f, merged);
    process.env.RELEASE_CONFIG = '{"node-version":"26","npm-project-dir":"new-project"}';
    process.env.NPM_PROJECT_DIR = "new-project";
    await runReleaseContinuation("probe");
    assert.match(readFileSync(join(f.root, "output"), "utf8"), /pending=false/);
    assert.equal(parseCandidateReceipt(f.pr.body), null);
    assert.ok(!f.calls.some(call => call.path.includes("contents/new-project")));
    if (!merged) assert.match(readFileSync(join(f.root, "merge-args"), "utf8"), /--disable-auto/);
    assert.equal((await freshPreparation(f)).configDigest, releaseConfigDigest(JSON.parse(process.env.RELEASE_CONFIG)));
  });
});

test("config-change recovery retains attempted, published or unavailable intent and old deliveries cannot retire it", async () => {
  for (const merged of [false, true]) for (const evidence of ["attempt", "registry", "tag", "release", "outage"]) await withAdapter(async f => {
    setMergeState(f, merged);
    process.env.RELEASE_CONFIG = '{"node-version":"26"}';
    if (evidence === "attempt") f.state.comments.push({ user: { login: "github-actions[bot]" }, body: `<!-- pm-ops-publication-v1\n${JSON.stringify({ candidate: releaseDigest(JSON.stringify(f.c)) })}\n-->` });
    if (evidence === "registry") f.state.registry = true;
    if (evidence === "tag" || evidence === "release") f.state.tag = f.e.pr.mergedSha;
    if (evidence === "release") f.state.release = true;
    if (evidence === "outage") f.state.registryUnavailable = true;
    await assert.rejects(runReleaseContinuation("probe"));
    assertIntentRetained(f);
  });
  await withAdapter(async f => {
    process.env.RELEASE_CONFIG = '{"node-version":"26"}'; process.env.TRIGGER_SHA = "9".repeat(40);
    await runReleaseContinuation("probe");
    assert.match(readFileSync(join(f.root, "output"), "utf8"), /pending=true/);
    assertIntentRetained(f);
  });
});

test("open config retirement refuses a failed auto-merge disable before changing durable intent", async () => {
  await withAdapter(async f => {
    setMergeState(f, false);
    process.env.RELEASE_CONFIG = '{"node-version":"26"}';
    writeFileSync(join(f.root, "gh"), "#!/bin/sh\nexit 7\n");
    await assert.rejects(runReleaseContinuation("probe"));
    assertIntentRetained(f);
  });
});

test("contents-read policy exposes all required apps without administration and refuses missing or ruleset evidence", () => {
  const previous = process.env.GITHUB_REPOSITORY; process.env.GITHUB_REPOSITORY = "example/package";
  try {
    const valid = protectionFixture(); assert.deepEqual(valid.read().states, ["SUCCESS", "SUCCESS"]);
    assert.ok(valid.calls.some(args => args[1].endsWith("/branches/main")));
    assert.ok(valid.calls.every(args => !args.some(arg => /branchProtectionRule|\/protection/.test(arg))));
    for (const app of [null, -1, 7]) { valid.branch.protection.required_status_checks.checks[0].app_id = app; assert.equal(valid.read().states[0], "SUCCESS"); }
    for (const change of [
      (f: ReturnType<typeof protectionFixture>) => { f.branch.name = "foreign"; },
      (f: ReturnType<typeof protectionFixture>) => { f.branch.protected = false; },
      (f: ReturnType<typeof protectionFixture>) => { f.branch.protection.enabled = false; },
      (f: ReturnType<typeof protectionFixture>) => { f.branch.protection.required_status_checks.enforcement_level = "off"; },
      (f: ReturnType<typeof protectionFixture>) => { Reflect.deleteProperty(f.branch.protection, "required_status_checks"); },
      (f: ReturnType<typeof protectionFixture>) => { Object.assign(f.branch.protection.required_status_checks, { contexts: null }); },
      (f: ReturnType<typeof protectionFixture>) => { Object.assign(f.branch.protection.required_status_checks, { checks: null }); },
      (f: ReturnType<typeof protectionFixture>) => { f.branch.protection.required_status_checks.checks = []; },
      (f: ReturnType<typeof protectionFixture>) => { f.branch.protection.required_status_checks.checks[0].context = ""; },
      (f: ReturnType<typeof protectionFixture>) => { f.branch.protection.required_status_checks.checks[0].app_id = -2; },
      (f: ReturnType<typeof protectionFixture>) => { f.branch.protection.required_status_checks.contexts.push("missing"); },
      (f: ReturnType<typeof protectionFixture>) => { f.branch.protection.required_status_checks.contexts = ["CI"]; },
      (f: ReturnType<typeof protectionFixture>) => { f.state.rules = {}; },
      (f: ReturnType<typeof protectionFixture>) => { f.state.rules = [{ type: "required_status_checks" }]; },
      (f: ReturnType<typeof protectionFixture>) => { f.pr.baseRefName = "foreign"; },
      (f: ReturnType<typeof protectionFixture>) => { f.pr.reviewDecision = "unknown"; },
      (f: ReturnType<typeof protectionFixture>) => { f.nodes[0].name = "unrepresented"; },
      (f: ReturnType<typeof protectionFixture>) => { f.pr.commits.nodes = []; },
    ]) { const f = protectionFixture(); change(f); assert.throws(f.read, /incomplete/); }
  } finally { if (previous === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = previous; }
});

test("a changed receipt cannot hide an earlier bot publication attempt during config retirement", async () => {
  await withAdapter(async f => {
    const original = releaseDigest(JSON.stringify(f.c));
    f.state.comments.push({ user: { login: "github-actions[bot]" }, body: `<!-- pm-ops-publication-v1\n${JSON.stringify({ candidate: original })}\n-->` });
    f.c.configDigest = "9".repeat(64); f.pr.body = candidateBody(f.receipt);
    await assert.rejects(runReleaseContinuation("probe"), /attempt identity disagrees/);
    assertIntentRetained(f);
    assert.equal(f.state.comments.length, 1);
  });
});

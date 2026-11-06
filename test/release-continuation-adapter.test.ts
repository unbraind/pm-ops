/** Execute the workflow adapter against synthetic, authoritative REST and registry boundaries. */
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
import { candidateBody, parseCandidateReceipt, inspectCandidate, closeSuperseded, requiredProtection, githubApi, registryJson, runReleaseContinuation, type ReleaseApi } from "../scripts/release-continuation.ts";

const previousProject = process.env.NPM_PROJECT_DIR;
process.env.NPM_PROJECT_DIR = ".";
after(() => { if (previousProject === undefined) delete process.env.NPM_PROJECT_DIR; else process.env.NPM_PROJECT_DIR = previousProject; });

/** Stateful remote fixture: no release workflow or registry write escapes this object. */
function remoteFixture() {
  const c = candidateFixture(), e = evidenceFixture(), receipt = { candidate: c, artifactId: 20 };
  const pr = { number: 42, body: candidateBody(receipt), state: "closed", merged: true, merged_at: "2026-11-06T04:00:00Z" as string | null, merge_commit_sha: e.pr.mergedSha,
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
  return { c, e, receipt, pr, run, artifact, calls, state, api, options, registry, inspect: () => inspectCandidate(receipt, options, api, registry, () => ({ states: state.checks, review: "APPROVED" })) };
}

/** Execute the production entry point with isolated artifacts, native transport fixtures and no real credentials. */
async function withAdapter(callback: (f: ReturnType<typeof remoteFixture> & { root: string; handoff: string; refresh: () => void; control: { ignorePersistence: boolean } }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "release-adapter-")), handoff = join(root, "release-artifact"); mkdirSync(handoff);
  const f = remoteFixture(), originalFetch = globalThis.fetch;
  const values: Record<string, string> = { GITHUB_REPOSITORY: f.c.repository, GH_TOKEN: "synthetic-token", RELEASE_CONFIG: "{}", CALLER_WORKFLOW: `${f.c.repository}/${f.c.workflow}@refs/heads/main`,
    RUNNER_TEMP: root, GITHUB_OUTPUT: join(root, "output"), NPM_PROJECT_DIR: ".", TRIGGER_SHA: f.e.triggerSha, RELEASE_TIMEZONE: "Europe/Vienna", RELEASE_PR_NUMBER: "42", RELEASE_BRANCH: f.pr.head.ref,
    REMOTE_BRANCH_SHA: f.c.headSha, ARTIFACT_ID: "20", RELEASE_BASE_SHA: f.c.baseSha, VERIFIED_COMMIT: f.c.headSha, VERIFIED_TREE: f.c.tree, NPM_VERSION: f.c.version, RELEASE_TAG: f.c.tag,
    PACKAGE_NAME: f.c.packageName, CLI_VERSION: f.c.cliVersion, PM_OPS_VERSION: f.c.opsVersion, GITHUB_RUN_ID: "10", GITHUB_RUN_ATTEMPT: "1", NPM_PUBLISH: "true", IS_RUST: "false", RELEASE_FIXTURE: root,
    PATH: `${root}:${process.env.PATH}` };
  const saved = new Map([...Object.keys(values), "CANDIDATE_RECEIPT", "SUPERSEDED_PR_NUMBERS"].map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const refresh = () => {
    f.c.configDigest = releaseConfigDigest({}); f.c.packageSha256 = releaseDigest("verified bytes"); f.c.notesSha256 = releaseDigest("verified notes");
    f.c.packageIntegrity = `sha512-${createHash("sha512").update("verified bytes").digest("base64")}`;
    f.pr.body = candidateBody(f.receipt); process.env.CANDIDATE_RECEIPT = JSON.stringify(f.receipt);
    writeFileSync(join(handoff, "candidate.json"), JSON.stringify(f.c)); writeFileSync(join(handoff, "package.tgz"), "verified bytes"); writeFileSync(join(handoff, "RELEASE_NOTES.md"), "verified notes");
    writeFileSync(join(root, "output"), "");
    writeFileSync(join(root, "protection.json"), JSON.stringify({ data: { repository: { pullRequest: { headRefOid: f.c.headSha, reviewDecision: "APPROVED",
      baseRef: { branchProtectionRule: { requiresApprovingReviews: true, requiredStatusChecks: [{ context: "CI", app: null }] } },
      commits: { nodes: [{ commit: { oid: f.c.headSha, statusCheckRollup: { contexts: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true }] } } } }] },
    } } } }));
  };
  refresh();
  const control = { ignorePersistence: false };
  writeFileSync(join(root, "gh"), '#!/bin/sh\ncase "$1 $2" in\n"api graphql") cat "$RELEASE_FIXTURE/protection.json" ;;\n"pr merge") echo merge >> "$RELEASE_FIXTURE/merges" ;;\n*) exit 9 ;;\nesac\n'); chmodSync(join(root, "gh"), 0o755);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    let data: unknown;
    if (url.startsWith("https://api.github.com/")) {
      const path = url.slice("https://api.github.com/".length), body = init?.body ? JSON.parse(String(init.body)) as { body?: string } : undefined;
      data = await f.api(path, init?.method, body);
      if (init?.method === "PATCH" && body?.body && !control.ignorePersistence) Object.assign(f.pr, { body: body.body });
    } else if (url.startsWith("https://registry.npmjs.org/")) data = await f.registry(url.slice("https://registry.npmjs.org/".length));
    else throw new Error("Unexpected fixture host");
    return new Response(JSON.stringify(data), { status: data === null ? 404 : 200 });
  };
  try { await callback({ ...f, root, handoff, refresh, control }); }
  finally { Object.assign(globalThis, { fetch: originalFetch }); for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); }
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
    await runReleaseContinuation("verify"); await runReleaseContinuation("attempt");
    const journal = f.calls.find(call => call.method === "POST")?.body as { body: string };
    assert.ok(journal.body.includes(releaseDigest(JSON.stringify(f.c))));
    await assert.rejects(runReleaseContinuation("complete"), /not completely/);
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
        assert.deepEqual(await githubApi("fixture", "POST", { intent: true }), status === 404 ? null : status === 204 ? {} : { proof: true });
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
  await assert.rejects(f.inspect(), /identity changed/);
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
    cargo = "[package]\n"; await assert.rejects(inspectCandidate(f.receipt, f.options, api, f.registry, check), /source or artifact/);
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
  await closeSuperseded([41], 42, f.c.repository, api);
  Object.assign(f.pr, { merged: false }); await assert.rejects(closeSuperseded([41], 42, f.c.repository, api), /successor/);
});

test("native protection refuses API errors and absent policy while nullable states stay missing", () => {
  const previous = process.env.GITHUB_REPOSITORY; process.env.GITHUB_REPOSITORY = "example/package";
  const head = "b".repeat(40);
  const pr = { headRefOid: head, reviewDecision: null, baseRef: { branchProtectionRule: { requiresApprovingReviews: false, requiredStatusChecks: [{ context: "CI", app: null }, { context: "legacy", app: null }] } },
    commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: { totalCount: 2, pageInfo: { hasNextPage: false }, nodes: [
      { __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: null, isRequired: true }, { __typename: "StatusContext", context: "legacy", state: null, isRequired: true },
    ] } } } }] } };
  try {
    const valid = { data: { repository: { pullRequest: pr } } };
    assert.deepEqual(requiredProtection(42, head, () => JSON.stringify(valid)), { states: ["MISSING", "MISSING"], review: "" });
    assert.throws(() => requiredProtection(42, head, () => JSON.stringify({ ...valid, errors: [{}] })), /incomplete/);
    const commit = pr.commits.nodes[0].commit;
    commit.oid = "wrong"; assert.throws(() => requiredProtection(42, head, () => JSON.stringify(valid)), /incomplete/); commit.oid = head;
    Object.assign(pr.baseRef, { branchProtectionRule: null }); assert.throws(() => requiredProtection(42, head, () => JSON.stringify(valid)), /incomplete/);
  } finally { if (previous === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = previous; }
});

test("importing the adapter without a main argv never starts a release transition", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import ${JSON.stringify(new URL("../scripts/release-continuation.ts", import.meta.url).href)};`], {
    encoding: "utf8", env: { ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) },
  });
  assert.equal(result.status, 0, result.stderr);
});

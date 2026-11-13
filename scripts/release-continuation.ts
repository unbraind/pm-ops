/** Trusted workflow adapter. An empty probe uses only Node built-ins and performs no installation. */
import { execFileSync } from "../subprocess.ts";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureReleaseRuntime, installReleaseTools, workflowToolsRoot } from "./release-runtime.ts";
import { verifyRegistryProvenance, type ProvenanceIdentity, type verifySigstoreBundle } from "../release-provenance.ts";
import { pathToFileURL } from "node:url";
import {
  cargoPackageVersion, decideReleaseContinuation, decideUnpublishedRetirement, ownsContinuationPr, releaseConfigDigest, releaseDigest, validateReleaseCandidate, verifyReleaseHandoff,
  type ContinuationEvidence, type ContinuationPr, type ReleaseCandidate,
} from "../release-continuation.ts";

/** Durable PR body receipt; its candidate must match the original trusted run artifact. */
export interface CandidateReceipt { candidate: ReleaseCandidate; artifactId: number }

/** REST PR fields used to obtain authoritative ownership before every write. */
interface RestPr {
  number: number; body: string | null; state: string; merged: boolean; merge_commit_sha: string | null;
  merged_at?: string | null;
  user: { login: string }; head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
}

/** Injectable HTTP boundary for deterministic workflow fixtures, including unreadable responses. */
export type ReleaseApi = (path: string, method?: string, body?: unknown) => Promise<unknown>;

const marker = "<!-- pm-ops-candidate-v1\n";
const retiredMarker = "<!-- pm-ops-retired-candidate-v1\n";
const attemptMarker = "<!-- pm-ops-publication-v1\n";

/** Read a required workflow value without printing credentials or environment state. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing workflow input: ${name}`);
  return value;
}

/** Read GET absence explicitly and refuse every failed authenticated GitHub mutation. */
export async function githubApi(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.github.com/${path}`, {
    method, headers: { Authorization: `Bearer ${required("GH_TOKEN")}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404 && method === "GET") return null;
  if (!response.ok) throw new Error(`GitHub API refused ${method} ${path}: ${response.status}`);
  return response.status === 204 ? {} : response.json();
}

/** Exhaust all pages with an explicit refusal bound; truncated evidence never authorizes writes. */
async function pages<T>(api: ReleaseApi, path: string): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const data = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (!Array.isArray(data)) throw new Error("Unreadable paginated release evidence");
    result.push(...data as T[]);
    if (data.length < 100) return result;
  }
  throw new Error("Release evidence exceeds the bounded pagination limit");
}

/** Discover bot-created receipt-bearing PRs through the REST issue index, without scanning all PR history. */
export async function discoverCandidatePrs(repository: string, base: string, api: ReleaseApi): Promise<RestPr[]> {
  const issues = await pages<{ number: number; body: string | null; pull_request?: unknown }>(api,
    `repos/${repository}/issues?state=all&creator=github-actions%5Bbot%5D&sort=created&direction=asc`);
  const result: RestPr[] = [];
  for (const issue of issues) {
    if (!issue.pull_request || !issue.body?.includes(marker)) continue;
    const pr = await api(`repos/${repository}/pulls/${issue.number}`) as RestPr;
    if (ownsContinuationPr(identity(pr), repository, base)) result.push(pr);
  }
  return result;
}

/** Parse only an unambiguous versioned durable record; malformed records block preparation. */
export function parseCandidateReceipt(body: string, retired = false): CandidateReceipt | null {
  const prefix = retired ? retiredMarker : marker;
  if (!body.includes(prefix)) return null;
  const parts = body.split(prefix);
  const end = parts[1].indexOf("\n-->");
  if (parts.length !== 2 || end < 0) throw new Error("Malformed candidate receipt");
  const receipt = JSON.parse(parts[1].slice(0, end)) as CandidateReceipt;
  validateReleaseCandidate(receipt.candidate);
  if (!Number.isSafeInteger(receipt.artifactId) || receipt.artifactId < 1) throw new Error("Missing immutable artifact ID");
  return receipt;
}

/** Serialize a durable receipt before enabling auto-merge, including the immutable artifact ID. */
export function candidateBody(receipt: CandidateReceipt): string {
  return `Verified daily release; protected squash auto-merge requested.\n${marker}${JSON.stringify(receipt)}\n-->`;
}

/** Preserve the exact retired candidate for audit without leaving an active discovery marker. */
export function retiredCandidateBody(receipt: CandidateReceipt, reason: string): string {
  return reason + "\n" + retiredMarker + JSON.stringify(receipt) + "\n-->";
}

/** Identify a verified unpublished retirement so its closed unmerged branch can receive fresh preparation. */
function unpublishedRetirementReason(candidate: ReleaseCandidate, operator: boolean): string {
  return "Retired unpublished release " + candidate.tag + (operator ? " at the operator's explicit request; required protection checks were not bypassed."
    : " because its source or caller configuration is no longer the verified current-main candidate. Fresh preparation is required.");
}

/** Retire only a freshly owned intent and confirm persistence before allowing new admission. */
async function retireReceipt(pr: RestPr, repository: string, reason: string, api: ReleaseApi): Promise<void> {
  const originalBody = pr.body, head = pr.head.sha, state = pr.state, merged = pr.merged;
  const current = await api("repos/" + repository + "/pulls/" + pr.number) as RestPr;
  if (!ownsContinuationPr(identity(current), repository, "main") || current.head.sha !== head || current.body !== originalBody || current.state !== state || current.merged !== merged) throw new Error("Release intent changed before retirement");
  const receipt = parseCandidateReceipt(originalBody ?? "");
  const body = receipt ? retiredCandidateBody(receipt, reason) : reason;
  await api("repos/" + repository + "/issues/" + pr.number + "/comments", "POST", { body: reason });
  await api("repos/" + repository + "/pulls/" + pr.number, "PATCH", { body });
  const saved = await api("repos/" + repository + "/pulls/" + pr.number) as RestPr;
  if (saved.body !== body || !ownsContinuationPr(identity(saved), repository, "main") || saved.head.sha !== head || saved.state !== state || saved.merged !== merged) throw new Error("Release receipt retirement was not confirmed");
}

/** Convert authoritative REST fields to the shared ownership and identity contract. */
function identity(pr: RestPr): ContinuationPr {
  return { number: pr.number, author: pr.user.login, repository: pr.base.repo.full_name,
    headRepository: pr.head.repo?.full_name ?? "", base: pr.base.ref, branch: pr.head.ref, head: pr.head.sha,
    state: pr.state, merged: pr.merged, mergedSha: pr.merge_commit_sha };
}

/** Resolve annotated tags to a commit and reject missing, cyclic or excessive indirection. */
async function tagCommit(api: ReleaseApi, repository: string, tag: string): Promise<string | null> {
  let ref = await api(`repos/${repository}/git/ref/tags/${tag}`) as { object: { type: string; sha: string } } | null;
  if (!ref) return null;
  for (let depth = 0; depth < 10; depth++) {
    if (ref.object.type === "commit") return ref.object.sha;
    if (ref.object.type !== "tag") break;
    ref = await api(`repos/${repository}/git/tags/${ref.object.sha}`) as typeof ref;
    if (!ref) break;
  }
  throw new Error("Unreadable release tag target");
}

/** Calendar day used identically for npm times, GitHub publication dates and the daily cap. */
function day(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

/** Read public registry JSON without npm configuration; only an authoritative 404 means absence. */
export async function registryJson(path: string): Promise<unknown> {
  const response = await fetch(`https://registry.npmjs.org/${path}`, { signal: AbortSignal.timeout(30_000), cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry evidence unavailable: ${response.status}`);
  return response.json();
}

/** Authenticate registry provenance and bind every source field before reconciliation. */
async function registryProof(c: ReleaseCandidate, merged: string, readRegistry: (path: string) => Promise<unknown>, signerWorkflow: string, verify?: typeof verifySigstoreBundle): Promise<ContinuationEvidence["registry"]> {
  const metadata = await readRegistry(`${encodeURIComponent(c.packageName)}/${c.version}`) as { dist: { integrity: string; attestations?: { url: string } } } | null;
  if (!metadata) return "absent";
  const url = metadata.dist.attestations?.url;
  if (metadata.dist.integrity !== c.packageIntegrity || !url?.startsWith("https://registry.npmjs.org/")) return "unverified";
  const envelope = await readRegistry(url.slice("https://registry.npmjs.org/".length));
  if (!verify) ensureReleaseRuntime();
  const identity: ProvenanceIdentity = { repository: c.repository, workflow: c.workflow, ref: "refs/heads/" + c.defaultBranch, commit: merged, integrity: c.packageIntegrity, signerWorkflow };
  return await verifyRegistryProvenance(envelope, identity, verify) ? "verified" : "unverified";
}

/** Normalize documented workflow identities without accepting a foreign repository or ref. */
export function normalizeWorkflowPath(path: string, repository: string, branch: string, sha: string): string {
  const [location, ref, extra] = path.split("@");
  const local = location.startsWith(repository + "/") ? location.slice(repository.length + 1) : location;
  if (extra !== undefined || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(local)
    || (ref !== undefined && ![branch, "refs/heads/" + branch, sha].includes(ref))) throw new Error("Untrusted preparation workflow path or ref");
  return local;
}

/** Bind verification to one successful prepare job in the recorded attempt, not later cleanup. */
async function preparationConclusion(api: ReleaseApi, repository: string, c: ReleaseCandidate): Promise<string> {
  let expected: number | null = null;
  const jobs = await pages<{ name: string; status: string; conclusion: string | null; run_id: number; head_sha: string }>(async path => {
    const data = await api(path) as { total_count: number; jobs: unknown[] } | null;
    if (!data || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || (expected !== null && data.total_count !== expected)) throw new Error("Unreadable preparation job count");
    expected = data.total_count;
    return data.jobs;
  }, "repos/" + repository + "/actions/runs/" + c.runId + "/attempts/" + c.runAttempt + "/jobs");
  const prepare = jobs.filter(job => job.name === "prepare" || job.name.endsWith(" / prepare"));
  if (jobs.length !== expected || prepare.length !== 1) throw new Error("Missing, truncated or ambiguous preparation job proof");
  if (prepare[0].run_id !== c.runId || prepare[0].head_sha !== c.baseSha) throw new Error("Preparation job identity changed");
  return prepare[0].status === "completed" ? prepare[0].conclusion ?? "" : "";
}

/** Bind the signer to GitHub's executing reusable job ref, independently of preparation tools. */
export function publishingSignerWorkflow(workflowRef: string): string {
  if (!/^unbraind\/pm-ops\/\.github\/workflows\/daily-release\.yml@(refs\/heads\/main|[a-f0-9]{40})$/.test(workflowRef)) {
    throw new Error("Untrusted publishing job workflow ref");
  }
  return workflowRef;
}

/** Diagnose a pending protected PR from freshly read exact-head evidence, never remembered approval. */
export async function releaseWaitReason(number: number, head: string, repository: string, api: ReleaseApi = githubApi): Promise<string> {
  const pr = await api(`repos/${repository}/pulls/${number}`) as RestPr & { mergeable_state: string };
  if (!ownsContinuationPr(identity(pr), repository, "main") || pr.head.sha !== head || pr.state !== "open") throw new Error("Release diagnosis head or ownership changed");
  const state = pr.mergeable_state.toUpperCase();
  if (state === "BEHIND") return "BEHIND: update the release branch to satisfy strict up-to-date protection.";
  if (state === "DIRTY") return "DIRTY: regenerate the release metadata to resolve merge conflicts.";
  const checks = await pages<{ name: string; head_sha: string; status: string; conclusion: string | null; html_url: string }>(async path => {
    const data = await api(path) as { check_runs: unknown[] }; return data.check_runs;
  }, `repos/${repository}/commits/${head}/check-runs?filter=latest`);
  const statuses = await pages<{ context: string; state: string; target_url: string | null }>(api, `repos/${repository}/commits/${head}/statuses`);
  const latest = new Map<string, typeof statuses[number]>();
  for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status);
  const failing = checks.filter(check => check.head_sha === head && check.status === "completed" && ["failure", "cancelled", "timed_out", "startup_failure", "stale"].includes(check.conclusion ?? ""))
    .map(check => `${check.name} (${check.html_url})`);
  failing.push(...[...latest.values()].filter(status => ["failure", "error"].includes(status.state)).map(status => `${status.context} (${status.target_url ?? "no run link"})`));
  if (failing.length) return "failing: " + failing.join(", ");
  const runs = await pages<{ head_sha: string; event: string; status: string; conclusion: string | null; html_url: string }>(async path => {
    const data = await api(path) as { workflow_runs: unknown[] }; return data.workflow_runs;
  }, `repos/${repository}/actions/runs?head_sha=${head}`);
  const waiting = runs.filter(run => run.head_sha === head && run.event === "pull_request" && (run.status === "waiting" || run.status === "action_required" || run.conclusion === "action_required"));
  if (waiting.length) return "awaiting workflow approval: " + waiting.map(run => run.html_url).join(", ");
  return `still settling (merge state: ${state}): inspect required checks and review decisions.`;
}

/** Re-read live planning metadata and registry provenance; execution separately binds downloaded bytes. */
export async function inspectCandidate(receipt: CandidateReceipt, options: {
  repository: string; triggerSha: string; workflow: string; publishingWorkflowRef: string; configDigest: string; timezone: string; now: string; retireUnpublished?: boolean; prNumber?: number;
}, api: ReleaseApi = githubApi, readRegistry = registryJson,
checks: (number: number, head: string) => { states: string[]; review: string } = requiredProtection,
verify?: typeof verifySigstoreBundle): Promise<{ action: string; pr: RestPr; mainSha: string; toolsSha: string; signerWorkflow: string }> {
  const c = receipt.candidate;
  const configChanged = c.configDigest !== options.configDigest;
  validateReleaseCandidate(c);
  const repo = `repos/${options.repository}`;
  const metadata = await api(repo) as { default_branch: string };
  if (options.prNumber !== undefined && (!Number.isSafeInteger(options.prNumber) || options.prNumber < 1)) throw new Error("Invalid candidate PR number");
  const pull = (options.prNumber === undefined ? await discoverCandidatePrs(options.repository, metadata.default_branch, api)
    : [await api(`${repo}/pulls/${options.prNumber}`) as RestPr])
    .filter(pr => ownsContinuationPr(identity(pr), options.repository, metadata.default_branch) && pr.body && parseCandidateReceipt(pr.body)?.artifactId === receipt.artifactId);
  if (pull.length !== 1) throw new Error("Candidate PR receipt is missing or duplicated");
  const pr = await api(`${repo}/pulls/${pull[0].number}`) as RestPr;
  if (JSON.stringify(parseCandidateReceipt(pr.body ?? "")) !== JSON.stringify(receipt)) throw new Error("Candidate receipt changed during reconciliation");
  const main = await api(`${repo}/git/ref/heads/${metadata.default_branch}`) as { object: { sha: string } };
  if (options.retireUnpublished === true) {
    const tagSha = await tagCommit(api, options.repository, c.tag);
    const release = await api(`${repo}/releases/tags/${c.tag}`);
    const registry = c.npmPublish && await readRegistry(`${encodeURIComponent(c.packageName)}/${c.version}`) !== null ? "unverified" : "absent";
    const comments = await pages<{ user: { login: string }; body: string }>(api, `${repo}/issues/${pr.number}/comments`);
    const attempted = comments.some(comment => comment.user.login === "github-actions[bot]"
      && (comment.body.startsWith(attemptMarker) || comment.body.startsWith("<!-- pm-ops-post-hook-v1\n")));
    const action = decideUnpublishedRetirement(c, { ...options, defaultBranch: metadata.default_branch, pr: identity(pr), registry, attempted, tagSha, releaseSha: release ? tagSha ?? "present" : null });
    return { action, pr, mainSha: main.object.sha, toolsSha: c.toolsSha ?? c.baseSha, signerWorkflow: "" };
  }
  const run = await api(`${repo}/actions/runs/${c.runId}/attempts/${c.runAttempt}`) as {
    repository: { full_name: string }; head_branch: string; head_sha: string; path: string; event: string; run_attempt: number; referenced_workflows?: { path: string; sha: string }[];
  } | null;
  if (!run) throw new Error("Untrusted or expired preparation artifact: preparation run is unavailable");
  const referenced = run.referenced_workflows?.filter(item => item.path.startsWith("unbraind/pm-ops/.github/workflows/daily-release.yml@")) ?? [];
  const toolsSha = referenced.length === 1 ? referenced[0].sha : referenced.length === 0 && options.repository === "unbraind/pm-ops" ? c.baseSha : "";
  if (!/^[a-f0-9]{40}$/.test(toolsSha) || (c.toolsSha !== undefined && c.toolsSha !== toolsSha)) throw new Error("Trusted release tools commit is missing or changed");
  const signerWorkflow = publishingSignerWorkflow(options.publishingWorkflowRef);
  const tools = await api("repos/unbraind/pm-ops/contents/package.json?ref=" + toolsSha) as { content: string } | null;
  if (!tools) throw new Error("Trusted release tools package is unavailable");
  const toolsPackage = JSON.parse(Buffer.from(tools.content, "base64").toString("utf8")) as { name: string; version: string };
  if (toolsPackage.name !== "pm-ops" || toolsPackage.version !== c.opsVersion) throw new Error("Trusted release tools version changed");
  const prepared = await preparationConclusion(api, options.repository, c);
  const artifact = await api(`${repo}/actions/artifacts/${receipt.artifactId}`) as { expired: boolean; workflow_run: { id: number }; name: string } | null;
  const merged = pr.merged ? await api(`${repo}/git/commits/${pr.merge_commit_sha}`) as { tree: { sha: string }; parents: { sha: string }[] } : null;
  const project = requiredProjectPath();
  const rust = process.env.IS_RUST === "true";
  const source = pr.merged && !configChanged ? await api(`${repo}/contents/${project ? project + "/" : ""}${rust ? "Cargo.toml" : "package.json"}?ref=${pr.merge_commit_sha}`) as { content: string } : null;
  if (pr.merged && !configChanged && !source) throw new Error("Merged package version proof is unreadable");
  const text = source ? Buffer.from(source.content, "base64").toString("utf8") : "";
  const pkg = text && !rust ? JSON.parse(text) as { version: string; name: string } : null;
  if (pkg && pkg.name !== c.packageName) throw new Error("Merged package name changed");
  const version = source ? rust ? cargoPackageVersion(text) : pkg!.version : c.version;
  const protection = pr.merged && !configChanged ? checks(pr.number, c.headSha) : { states: [], review: "" };
  const tagSha = pr.merged || configChanged ? await tagCommit(api, options.repository, c.tag) : null;
  const release = pr.merged || configChanged ? await api(`${repo}/releases/tags/${c.tag}`) as { tag_name: string; draft: boolean } | null : null;
  if (release && (release.tag_name !== c.tag || release.draft || !tagSha)) throw new Error("GitHub Release identity disagrees");
  const registry = configChanged && c.npmPublish
    ? await readRegistry(`${encodeURIComponent(c.packageName)}/${c.version}`) === null ? "absent" : "unverified"
    : pr.merged && c.npmPublish ? await registryProof(c, pr.merge_commit_sha!, readRegistry, signerWorkflow, verify) : tagSha ? "verified" : "absent";
  const comments = pr.merged || configChanged ? await pages<{ user: { login: string }; body: string }>(api, `${repo}/issues/${pr.number}/comments`) : [];
  const attempts = comments.filter(comment => comment.user.login === "github-actions[bot]" && comment.body.startsWith(attemptMarker))
    .map(comment => JSON.parse(comment.body.slice(attemptMarker.length, -4)) as { candidate: string });
  if (attempts.some(attempt => attempt.candidate !== releaseDigest(JSON.stringify(c)))) throw new Error("Publication attempt identity disagrees; operator reconciliation is required");
  const attempted = attempts.length !== 0 || comments.some(comment => comment.user.login === "github-actions[bot]" && comment.body.startsWith("<!-- pm-ops-post-hook-v1\n"));
  let publishedToday = false;
  if (pr.merged && !configChanged && (registry === "absent" || (!c.npmPublish && !release))) {
    const today = day(options.now, options.timezone);
    const releases = await pages<{ published_at: string | null }>(api, `${repo}/releases`);
    publishedToday = releases.some(item => item.published_at && day(item.published_at, options.timezone) === today);
    if (c.npmPublish) {
      const pkg = await readRegistry(encodeURIComponent(c.packageName)) as { time: Record<string, string> } | null;
      if (pkg && (!pkg.time || typeof pkg.time !== "object" || Array.isArray(pkg.time))) throw new Error("Unreadable registry publication history");
      publishedToday ||= Object.entries(pkg?.time ?? {}).some(([key, value]) => !["created", "modified", c.version].includes(key) && day(value, options.timezone) === today);
    }
  }
  const action = decideReleaseContinuation(c, { ...options, defaultBranch: metadata.default_branch, mainSha: main.object.sha, pr: identity(pr),
    run: { repository: run.repository.full_name, branch: run.head_branch, sha: run.head_sha, workflow: normalizeWorkflowPath(run.path, options.repository, metadata.default_branch, c.baseSha), event: run.event, conclusion: prepared, attempt: run.run_attempt },
    artifactAvailable: artifact?.expired === false && artifact.workflow_run?.id === c.runId && artifact.name === `verified-daily-release-${c.headSha}`,
    mergedTree: merged?.tree.sha ?? "", mergedParents: merged?.parents.map(parent => parent.sha) ?? [], requiredChecks: protection.states, reviewDecision: protection.review,
    version, tagSha, releaseSha: release ? tagSha : null, registry, attempted, publishedToday,
  });
  return { action, pr, mainSha: main.object.sha, toolsSha, signerWorkflow };
}

/** Read package path as data; traversal and absolute paths are refused before API calls. */
function requiredProjectPath(): string {
  const path = required("NPM_PROJECT_DIR");
  if (path.startsWith("/") || path.split("/").includes("..") || /[\r\n?#]/.test(path)) throw new Error("Unsafe project path");
  return path === "." ? "" : path;
}

/** Read complete classic check policy with contents-read access and bind every context to the PR head. */
export function requiredProtection(number: number, expectedHead: string,
  run: (args: string[]) => string = args => execFileSync("gh", args, { encoding: "utf8", timeout: 30_000 }), withRuns = false): { states: string[]; review: string; runs?: string[] } {
  const [owner, repository] = required("GITHUB_REPOSITORY").split("/");
  const branch = JSON.parse(run(["api", `repos/${owner}/${repository}/branches/main`])) as {
    name: string; protected: boolean; protection?: { enabled: boolean; required_status_checks?: {
      enforcement_level: string; contexts: string[]; checks: { context: string; app_id: number | null }[];
    } };
  };
  const rules = JSON.parse(run(["api", `repos/${owner}/${repository}/rules/branches/main`])) as unknown;
  const rule = branch.protection?.required_status_checks;
  if (branch.name !== "main" || branch.protected !== true || branch.protection?.enabled !== true || !rule || !["non_admins", "everyone"].includes(rule.enforcement_level)
    || !Array.isArray(rule.contexts) || !Array.isArray(rule.checks) || rule.checks.length === 0
    || rule.checks.some(check => typeof check.context !== "string" || !check.context || (check.app_id !== null && check.app_id !== -1 && (!Number.isSafeInteger(check.app_id) || check.app_id < 1)))
    || rule.contexts.some(context => !rule.checks.some(check => check.context === context)) || rule.checks.some(check => !rule.contexts.includes(check.context))
    || !Array.isArray(rules) || rules.length !== 0) throw new Error("Required protection policy is unreadable, incomplete or includes unsupported active rulesets");
  const query = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){headRefOid baseRefName reviewDecision commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){totalCount pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name status conclusion isRequired(pullRequestNumber:$n) checkSuite{app{databaseId} workflowRun{url}}} ... on StatusContext{context state isRequired(pullRequestNumber:$n)}}}}}}}}}}`;
  const response = JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "-F", `o=${owner}`, "-F", `r=${repository}`, "-F", `n=${number}`])) as {
    errors?: unknown[]; data: { repository: { pullRequest: {
      headRefOid: string; baseRefName: string; reviewDecision: string | null;
      commits: { nodes: { commit: { oid: string; statusCheckRollup: { contexts: { totalCount: number; pageInfo: { hasNextPage: boolean }; nodes: {
        __typename: string; name?: string; context?: string; state?: string; status?: string; conclusion?: string; isRequired: boolean; checkSuite?: { app: { databaseId: number } | null; workflowRun?: { url: string } | null };
      }[] } } } }[] };
    } } };
  };
  const pr = response.data.repository.pullRequest;
  const commit = pr.commits.nodes[0]?.commit;
  const contexts = commit?.statusCheckRollup?.contexts;
  if (response.errors?.length || pr.headRefOid !== expectedHead || pr.baseRefName !== "main" || commit?.oid !== expectedHead
    || (pr.reviewDecision !== null && !["APPROVED", "REVIEW_REQUIRED", "CHANGES_REQUESTED"].includes(pr.reviewDecision))
    || !contexts || contexts.pageInfo.hasNextPage || contexts.totalCount !== contexts.nodes.length
    || contexts.nodes.some(node => node.isRequired && !rule.checks.some(check => check.context === (node.name ?? node.context)))) throw new Error("Required protection policy or exact-head evidence is unreadable or incomplete");
  const runs = new Set<string>();
  const states = rule.checks.flatMap(check => {
    const matching = contexts.nodes.filter(node => (node.name ?? node.context) === check.context && node.isRequired === true
      && (check.app_id === null || check.app_id === -1 || node.checkSuite?.app?.databaseId === check.app_id));
    if (withRuns) for (const node of matching) {
      const url = node.checkSuite?.workflowRun?.url;
      if (url === undefined) continue;
      const prefix = `https://github.com/${owner}/${repository}/actions/runs/`;
      const id = url.startsWith(prefix) ? url.slice(prefix.length) : "";
      if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("Untrusted required workflow run URL");
      runs.add(id);
    }
    return matching.length ? matching.map(node => node.__typename === "CheckRun" ? node.status === "COMPLETED" ? node.conclusion ?? "MISSING" : "PENDING" : node.state ?? "MISSING") : ["MISSING"];
  });
  return { states, review: pr.reviewDecision ?? "", ...(withRuns ? { runs: [...runs] } : {}) };
}

/** Approve only waiting PR runs proven by exact-head required checks, independent of workflow names. */
export async function approveRequiredWorkflowRuns(number: number, head: string, repository: string, api: ReleaseApi = githubApi,
  proof: () => { runs?: string[] } = () => requiredProtection(number, head, undefined, true)): Promise<void> {
  const pr = await api(`repos/${repository}/pulls/${number}`) as RestPr;
  if (!ownsContinuationPr(identity(pr), repository, "main") || pr.head.sha !== head || pr.state !== "open") throw new Error("Untrusted approval candidate");
  const eligible = new Set(proof().runs);
  const runs = await pages<{ id: number; head_sha: string; event: string; status: string; conclusion: string | null }>(async path => {
    const data = await api(path) as { workflow_runs: unknown[] };
    return data.workflow_runs;
  }, `repos/${repository}/actions/runs?head_sha=${head}`);
  for (const run of runs) if (eligible.has(String(run.id)) && run.head_sha === head && run.event === "pull_request"
    && (run.status === "waiting" || run.conclusion === "action_required")) {
    await api(`repos/${repository}/actions/runs/${run.id}/approve`, "POST");
  }
}

/** Retire owned superseded receipts before closing; every failed mutation remains visible. */
export async function closeSuperseded(numbers: number[], successor: number, repository: string, api: ReleaseApi = githubApi): Promise<void> {
  const current = await api(`repos/${repository}/pulls/${successor}`) as RestPr;
  if (!ownsContinuationPr(identity(current), repository, "main") || (current.state !== "open" && !current.merged)) throw new Error("Untrusted successor PR");
  const successorReceipt = parseCandidateReceipt(current.body ?? "");
  if (!successorReceipt || successorReceipt.candidate.repository !== repository || successorReceipt.candidate.headSha !== current.head.sha) throw new Error("Untrusted successor receipt");
  for (const number of numbers) {
    if (number === successor) continue;
    try {
      const pr = await api(`repos/${repository}/pulls/${number}`) as RestPr;
      if (!ownsContinuationPr(identity(pr), repository, "main") || pr.state !== "open") continue;
      await retireReceipt(pr, repository, `Superseded by release PR #${successor}.`, api);
      await api(`repos/${repository}/pulls/${number}`, "PATCH", { state: "closed" });
    } catch (error) { throw new Error(`Could not retire or close superseded release PR #${number}`, { cause: error }); }
  }
}

/** Journal a configured hook before execution and retain intent until its success is durable.
 * An interrupted attempt is ambiguous and requires operator verification; never replay it blindly.
 */
async function reconcilePostHook(receipt: CandidateReceipt, pr: RestPr, repository: string, completionOnly = false): Promise<void> {
  const script = process.env.POST_RELEASE_SCRIPT;
  if (!script) return;
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/.test(script)) throw new Error("Unsafe post-release script");
  const marker = "<!-- pm-ops-post-hook-v1\n";
  const fingerprint = releaseDigest(JSON.stringify({ candidate: receipt.candidate, commit: pr.merge_commit_sha, script }));
  const endpoint = "repos/" + repository + "/issues/" + pr.number + "/comments";
  const comments = await pages<{ user: { login: string }; body: string }>(githubApi, endpoint);
  const records = comments.filter(comment => comment.user.login === "github-actions[bot]" && comment.body.startsWith(marker))
    .map(comment => JSON.parse(comment.body.slice(marker.length, -4)) as { fingerprint: string; state: string }).filter(record => record.fingerprint === fingerprint);
  if (records.some(record => record.state === "complete")) return;
  if (completionOnly || records.length) throw new Error("Post-release hook is incomplete or ambiguous; preserve intent for operator verification");
  const record = async (state: string) => githubApi(endpoint, "POST", { body: marker + JSON.stringify({ fingerprint, state }) + "\n-->" });
  await record("attempt");
  execFileSync("npm", ["run", script], { cwd: process.env.NPM_PROJECT_PATH ?? ".", stdio: "inherit" });
  await record("complete");
}

/** Invoke one bounded workflow transition; every schedule starts with discovery, never preparation. */
export async function runReleaseContinuation(mode: string | undefined, verifyProvenance?: typeof verifySigstoreBundle): Promise<void> {
  if (mode === "tools") {
    const prefix = mkdtempSync(join(required("RUNNER_TEMP"), "pm-ops-tools-"));
    const module = installReleaseTools(process.env.RELEASE_TOOLS_ROOT || workflowToolsRoot, prefix, required("PM_OPS_VERSION"));
    appendFileSync(required("GITHUB_ENV"), "PM_OPS_MODULE=" + module + "\nPM_OPS_TOOLS=" + prefix + "\n");
    return;
  }
  const repository = required("GITHUB_REPOSITORY");
  const output = (key: string, value: string | number) => appendFileSync(required("GITHUB_OUTPUT"), `${key}=${value}\n`);
  const configDigest = releaseConfigDigest(JSON.parse(required("RELEASE_CONFIG")) as Record<string, unknown>);
  const workflow = required("CALLER_WORKFLOW").split(`${repository}/`)[1]?.split("@")[0];
  if (!workflow) throw new Error("Unexpected caller workflow identity");
  const handoff = join(required("RUNNER_TEMP"), "release-artifact");
  if (mode === "stamp") {
    const stamp = { schema: 1, repository, baseSha: required("RELEASE_BASE_SHA"), version: required("NPM_VERSION"),
      runId: Number(required("GITHUB_RUN_ID")), runAttempt: Number(required("GITHUB_RUN_ATTEMPT")), configDigest };
    if (!/^[A-Za-z0-9_][\w.-]*\/[A-Za-z0-9_][\w.-]*$/.test(repository) || !/^[a-f0-9]{40}$/.test(stamp.baseSha)
      || !/^\d{4}\.\d+\.\d+(-\d+)?$/.test(stamp.version) || !Number.isSafeInteger(stamp.runId) || stamp.runId < 1
      || !Number.isSafeInteger(stamp.runAttempt) || stamp.runAttempt < 1) throw new Error("Malformed preparation stamp");
    const directory = join(required("GITHUB_WORKSPACE"), ".github");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "pm-release-candidate.json"), JSON.stringify(stamp, null, 2) + "\n");
    return;
  }
  if (mode === "manifest") {
    const packageBytes = process.env.IS_RUST === "true" ? Buffer.alloc(0) : readFileSync(join(handoff, "package.tgz"));
    const c: ReleaseCandidate = {
      schema: 1, repository, defaultBranch: "main", baseSha: required("RELEASE_BASE_SHA"), headSha: required("VERIFIED_COMMIT"), tree: required("VERIFIED_TREE"),
      version: required("NPM_VERSION"), tag: required("RELEASE_TAG"), packageName: process.env.PACKAGE_NAME || "github-only",
      packageSha256: releaseDigest(packageBytes), packageIntegrity: `sha512-${createHash("sha512").update(packageBytes).digest("base64")}`,
      notesSha256: releaseDigest(readFileSync(join(handoff, "RELEASE_NOTES.md"))), cliVersion: process.env.CLI_VERSION ?? "", opsVersion: required("PM_OPS_VERSION"), toolsSha: required("WORKFLOW_TOOLS_SHA"),
      runId: Number(required("GITHUB_RUN_ID")), runAttempt: Number(required("GITHUB_RUN_ATTEMPT")), workflow, configDigest, npmPublish: required("NPM_PUBLISH") === "true",
    };
    validateReleaseCandidate(c);
    writeFileSync(join(handoff, "candidate.json"), JSON.stringify(c));
    return;
  }
  if (mode === "supersede") {
    await closeSuperseded((process.env.SUPERSEDED_PR_NUMBERS ?? "").split(" ").filter(Boolean).map(Number), Number(required("RELEASE_PR_NUMBER")), repository);
    return;
  }
  if (mode === "approve") {
    await approveRequiredWorkflowRuns(Number(required("RELEASE_PR_NUMBER")), required("RELEASE_COMMIT"), repository);
    return;
  }
  if (mode === "ownership") {
    const pr = await githubApi(`repos/${repository}/pulls/${required("RELEASE_PR_NUMBER")}`) as RestPr;
    if (!ownsContinuationPr(identity(pr), repository, "main") || pr.state !== "open" || pr.head.ref !== required("RELEASE_BRANCH") || pr.head.sha !== required("REMOTE_BRANCH_SHA")) throw new Error("Release PR ownership or head changed");
    return;
  }
  if (mode === "retired-branch") {
    const branch = required("RELEASE_BRANCH"), head = required("REMOTE_BRANCH_SHA");
    const prs = await pages<RestPr>(githubApi, "repos/" + repository + "/pulls?state=closed&base=main&head=" + repository.split("/")[0] + ":" + branch);
    const matching = prs.filter(pr => ownsContinuationPr(identity(pr), repository, "main") && pr.head.ref === branch && pr.head.sha === head && pr.body?.includes(retiredMarker));
    if (matching.length !== 1) throw new Error("Unverified retired release branch");
    const pr = await githubApi("repos/" + repository + "/pulls/" + matching[0].number) as RestPr;
    const receipt = parseCandidateReceipt(pr.body ?? "", true);
    const cancelled = receipt !== null && [true, false].some(operator => pr.body === retiredCandidateBody(receipt, unpublishedRetirementReason(receipt.candidate, operator)));
    if (!ownsContinuationPr(identity(pr), repository, "main") || pr.state !== "closed" || (!pr.merged && !cancelled) || pr.head.ref !== branch || pr.head.sha !== head
      || !receipt || receipt.candidate.repository !== repository || receipt.candidate.headSha !== head) throw new Error("Retired release branch identity changed");
    return;
  }
  if (mode === "request") {
    const candidate = JSON.parse(readFileSync(join(handoff, "candidate.json"), "utf8")) as ReleaseCandidate;
    validateReleaseCandidate(candidate);
    const receipt = { candidate, artifactId: Number(required("ARTIFACT_ID")) };
    const number = required("RELEASE_PR_NUMBER");
    const pr = await githubApi(`repos/${repository}/pulls/${number}`) as RestPr;
    if (!ownsContinuationPr(identity(pr), repository, "main") || pr.head.sha !== candidate.headSha || pr.state !== "open") throw new Error("Release PR identity changed before auto-merge");
    await githubApi(`repos/${repository}/pulls/${number}`, "PATCH", { body: candidateBody(receipt) });
    // The durable receipt must be readable BEFORE the protected merge path can remove discovery state.
    const persisted = await githubApi(`repos/${repository}/pulls/${number}`) as RestPr;
    if (JSON.stringify(parseCandidateReceipt(persisted.body ?? "")) !== JSON.stringify(receipt)) throw new Error("Candidate persistence was not confirmed");
    execFileSync("gh", ["pr", "merge", number, "--repo", repository, "--auto", "--squash", "--match-head-commit", candidate.headSha], { stdio: "inherit" });
    return;
  }
  const options = { repository, publishingWorkflowRef: process.env.PUBLISHING_WORKFLOW_REF ?? "", triggerSha: required("TRIGGER_SHA"), workflow, configDigest, timezone: required("RELEASE_TIMEZONE"), now: new Date().toISOString(), retireUnpublished: process.env.RETIRE_UNPUBLISHED === "true" };
  let receipt: CandidateReceipt;
  if (mode === "probe") {
    const prs = await discoverCandidatePrs(repository, "main", githubApi);
    const candidates = prs.filter(pr => ownsContinuationPr(identity(pr), repository, "main") && (options.retireUnpublished || pr.state === "open" || typeof pr.merged_at === "string") && pr.body?.includes(marker));
    if (candidates.length > 1) throw new Error("Multiple pending release intents; reconcile explicitly before admitting more work");
    if (!candidates.length) { output("pending", "false"); return; }
    receipt = parseCandidateReceipt(candidates[0].body!)!;
    Object.assign(options, { prNumber: candidates[0].number });
  } else {
    receipt = JSON.parse(required("CANDIDATE_RECEIPT")) as CandidateReceipt;
    verifyReleaseHandoff(receipt.candidate, readFileSync(join(handoff, "candidate.json"), "utf8"),
      readFileSync(join(handoff, "RELEASE_NOTES.md")), process.env.IS_RUST === "true" ? Buffer.alloc(0) : readFileSync(join(handoff, "package.tgz")));
  }
  const result = await inspectCandidate(receipt, options, githubApi, registryJson, requiredProtection, verifyProvenance);
  if (result.action === "pending" || result.action === "refresh") process.stdout.write(`Release PR #${result.pr.number}: ${await releaseWaitReason(result.pr.number, receipt.candidate.headSha, repository)}\n`);
  let retired = false;
  if ((result.action === "stranded" || result.action === "retire") && mode === "probe") {
    if (options.triggerSha === result.mainSha) {
      if (result.pr.state === "open" && !result.pr.merged) execFileSync("gh", ["pr", "merge", String(result.pr.number), "--repo", repository, "--disable-auto"], { stdio: "inherit" });
      await retireReceipt(result.pr, repository, unpublishedRetirementReason(receipt.candidate, result.action === "retire"), githubApi);
      if (result.pr.state === "open") {
        await githubApi(`repos/${repository}/pulls/${result.pr.number}`, "PATCH", { state: "closed" });
        const closed = await githubApi(`repos/${repository}/pulls/${result.pr.number}`) as RestPr;
        if (!ownsContinuationPr(identity(closed), repository, "main") || closed.head.sha !== receipt.candidate.headSha || closed.state !== "closed" || closed.merged
          || JSON.stringify(parseCandidateReceipt(closed.body ?? "", true)) !== JSON.stringify(receipt)) throw new Error("Operator retirement closure was not confirmed");
      }
      retired = true;
    }
    process.stdout.write("::warning::Release intent is stranded; " + (retired ? "unpublished receipt retired for fresh daily preparation." : "wait for a run triggered at current main before retirement.") + "\n");
  }
  if (mode === "verify" && !["publish", "recover", "complete"].includes(result.action)) throw new Error("Publication requires admitted current-source identity");
  output("pending", result.action === "refresh" || retired ? "false" : "true");
  output("action", result.action);
  output("receipt", JSON.stringify(receipt));
  output("pr_number", result.pr.number);
  output("merged_sha", result.pr.merge_commit_sha ?? "");
  for (const [key, value] of Object.entries(receipt.candidate)) output(key, String(value));
  output("artifact_id", receipt.artifactId);
  output("tools_sha", result.toolsSha);
  output("signer_workflow", result.signerWorkflow);
  if (mode === "attempt") {
    if (result.action !== "publish") throw new Error("Publish is not admitted by fresh evidence");
    await githubApi(`repos/${repository}/issues/${result.pr.number}/comments`, "POST", { body: `${attemptMarker}${JSON.stringify({ candidate: releaseDigest(JSON.stringify(receipt.candidate)), commit: result.pr.merge_commit_sha, attemptedAt: options.now })}\n-->` });
  } else if (mode === "post-hook") {
    if (result.action !== "complete") throw new Error("Post-release hook requires reconciled publication");
    await reconcilePostHook(receipt, result.pr, repository);
  } else if (mode === "complete") {
    if (result.action !== "complete") throw new Error("Publication is not completely reconciled");
    await reconcilePostHook(receipt, result.pr, repository, true);
    await githubApi(`repos/${repository}/pulls/${result.pr.number}`, "PATCH", { body: `Daily release ${receipt.candidate.tag} published and reconciled at ${result.pr.merge_commit_sha}.` });
  } else if (!["probe", "verify"].includes(mode ?? "")) throw new Error("Unknown continuation transition");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReleaseContinuation(process.argv[2]).catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}

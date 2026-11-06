/** Trusted workflow adapter. The probe uses only Node built-ins and performs no installation. */
import { execFileSync } from "../subprocess.ts";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  decideReleaseContinuation, ownsContinuationPr, releaseConfigDigest, releaseDigest, validateReleaseCandidate,
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
const attemptMarker = "<!-- pm-ops-publication-v1\n";

/** Read a required workflow value without printing credentials or environment state. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing workflow input: ${name}`);
  return value;
}

/** Execute authenticated GitHub REST calls, preserving non-404 failures as refusals. */
export async function githubApi(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.github.com/${path}`, {
    method, headers: { Authorization: `Bearer ${required("GH_TOKEN")}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
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

/** Parse only an unambiguous versioned durable record; malformed records block preparation. */
export function parseCandidateReceipt(body: string): CandidateReceipt | null {
  if (!body.includes(marker)) return null;
  const parts = body.split(marker);
  if (parts.length !== 2 || !parts[1].endsWith("\n-->")) throw new Error("Malformed candidate receipt");
  const receipt = JSON.parse(parts[1].slice(0, -4)) as CandidateReceipt;
  validateReleaseCandidate(receipt.candidate);
  if (!Number.isSafeInteger(receipt.artifactId) || receipt.artifactId < 1) throw new Error("Missing immutable artifact ID");
  return receipt;
}

/** Serialize a durable receipt before enabling auto-merge, including the immutable artifact ID. */
export function candidateBody(receipt: CandidateReceipt): string {
  return `Verified daily release; protected squash auto-merge requested.\n${marker}${JSON.stringify(receipt)}\n-->`;
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

/** Verify source and digest in registry-served provenance, without executing package code. */
async function registryProof(c: ReleaseCandidate, merged: string, readRegistry: (path: string) => Promise<unknown>): Promise<ContinuationEvidence["registry"]> {
  const metadata = await readRegistry(`${encodeURIComponent(c.packageName)}/${c.version}`) as { dist: { integrity: string; attestations?: { url: string } } } | null;
  if (!metadata) return "absent";
  const url = metadata.dist.attestations?.url;
  if (metadata.dist.integrity !== c.packageIntegrity || !url?.startsWith("https://registry.npmjs.org/")) return "unverified";
  const proof = await readRegistry(url.slice("https://registry.npmjs.org/".length)) as { attestations: { predicateType: string; bundle: { dsseEnvelope: { payload: string } } }[] };
  const digest = Buffer.from(c.packageIntegrity.slice(7), "base64").toString("hex");
  return proof.attestations.some(entry => {
    if (entry.predicateType !== "https://slsa.dev/provenance/v1") return false;
    const statement = JSON.parse(Buffer.from(entry.bundle.dsseEnvelope.payload, "base64").toString("utf8")) as {
      subject: { digest: { sha512: string } }[]; predicate: { buildDefinition: { resolvedDependencies: { digest: { gitCommit: string } }[] } };
    };
    return statement.subject.some(subject => subject.digest.sha512 === digest)
      && statement.predicate.buildDefinition.resolvedDependencies.some(dep => dep.digest.gitCommit === merged);
  }) ? "verified" : "unverified";
}

/** Re-read all publication proof. No webhook payload, PR artifact or API failure substitutes for it. */
export async function inspectCandidate(receipt: CandidateReceipt, options: {
  repository: string; triggerSha: string; workflow: string; configDigest: string; timezone: string; now: string;
}, api: ReleaseApi = githubApi, readRegistry = registryJson,
checks: (number: number, head: string) => { states: string[]; review: string } = requiredProtection): Promise<{ action: string; pr: RestPr }> {
  const c = receipt.candidate;
  validateReleaseCandidate(c);
  const repo = `repos/${options.repository}`;
  const metadata = await api(repo) as { default_branch: string };
  const pull = (await pages<RestPr>(api, `${repo}/pulls?state=all&base=${metadata.default_branch}&sort=updated&direction=desc`))
    .filter(pr => pr.body && parseCandidateReceipt(pr.body)?.artifactId === receipt.artifactId);
  if (pull.length !== 1) throw new Error("Candidate PR receipt is missing or duplicated");
  const pr = await api(`${repo}/pulls/${pull[0].number}`) as RestPr;
  if (JSON.stringify(parseCandidateReceipt(pr.body ?? "")) !== JSON.stringify(receipt)) throw new Error("Candidate receipt changed during reconciliation");
  const run = await api(`${repo}/actions/runs/${c.runId}`) as {
    repository: { full_name: string }; head_branch: string; head_sha: string; path: string; event: string; conclusion: string; run_attempt: number;
  };
  const artifact = await api(`${repo}/actions/artifacts/${receipt.artifactId}`) as { expired: boolean; workflow_run: { id: number }; name: string };
  const main = await api(`${repo}/git/ref/heads/${metadata.default_branch}`) as { object: { sha: string } };
  const merged = pr.merged ? await api(`${repo}/git/commits/${pr.merge_commit_sha}`) as { tree: { sha: string }; parents: { sha: string }[] } : null;
  const project = requiredProjectPath();
  const rust = process.env.IS_RUST === "true";
  const source = pr.merged ? await api(`${repo}/contents/${project ? project + "/" : ""}${rust ? "Cargo.toml" : "package.json"}?ref=${pr.merge_commit_sha}`) as { content: string } : null;
  const text = source ? Buffer.from(source.content, "base64").toString("utf8") : "";
  const pkg = text && !rust ? JSON.parse(text) as { version: string; name: string } : null;
  if (pkg && pkg.name !== c.packageName) throw new Error("Merged package name changed");
  const version = source ? rust ? /^\[package\][^]*?^version\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? "" : pkg!.version : c.version;
  const protection = pr.merged ? checks(pr.number, c.headSha) : { states: [], review: "" };
  const tagSha = pr.merged ? await tagCommit(api, options.repository, c.tag) : null;
  const release = pr.merged ? await api(`${repo}/releases/tags/${c.tag}`) as { tag_name: string; draft: boolean } | null : null;
  if (release && (release.tag_name !== c.tag || release.draft || !tagSha)) throw new Error("GitHub Release identity disagrees");
  const registry = pr.merged && c.npmPublish ? await registryProof(c, pr.merge_commit_sha!, readRegistry) : tagSha ? "verified" : "absent";
  const comments = pr.merged ? await pages<{ user: { login: string }; body: string }>(api, `${repo}/issues/${pr.number}/comments`) : [];
  const attempted = comments.some(comment => comment.user.login === "github-actions[bot]" && comment.body.startsWith(attemptMarker)
    && JSON.parse(comment.body.slice(attemptMarker.length, -4)).candidate === releaseDigest(JSON.stringify(c)));
  let publishedToday = false;
  if (pr.merged && (registry === "absent" || (!c.npmPublish && !release))) {
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
    run: { repository: run.repository.full_name, branch: run.head_branch, sha: run.head_sha, workflow: run.path, event: run.event, conclusion: run.conclusion, attempt: run.run_attempt },
    artifactAvailable: artifact.expired === false && artifact.workflow_run.id === c.runId && artifact.name === `verified-daily-release-${c.headSha}`,
    mergedTree: merged?.tree.sha ?? "", mergedParents: merged?.parents.map(parent => parent.sha) ?? [], requiredChecks: protection.states, reviewDecision: protection.review,
    version, artifactSha256: c.packageSha256, tagSha, releaseSha: release ? tagSha : null, registry, attempted, publishedToday,
  });
  return { action, pr };
}

/** Read package path as data; traversal and absolute paths are refused before API calls. */
function requiredProjectPath(): string {
  const path = required("NPM_PROJECT_DIR");
  if (path.startsWith("/") || path.split("/").includes("..") || /[\r\n?#]/.test(path)) throw new Error("Unsafe project path");
  return path === "." ? "" : path;
}

/** Read the complete required-context/app policy and exact-head rollup, refusing missing proof. */
export function requiredProtection(number: number, expectedHead: string,
  run: (args: string[]) => string = args => execFileSync("gh", args, { encoding: "utf8", timeout: 30_000 })): { states: string[]; review: string } {
  const [owner, repository] = required("GITHUB_REPOSITORY").split("/");
  const query = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){headRefOid reviewDecision baseRef{branchProtectionRule{requiresApprovingReviews requiredStatusChecks{context app{id}}}} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){totalCount pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name status conclusion isRequired(pullRequestNumber:$n) checkSuite{app{id}}} ... on StatusContext{context state isRequired(pullRequestNumber:$n)}}}}}}}}}}`;
  const response = JSON.parse(run(["api", "graphql", "-f", `query=${query}`, "-F", `o=${owner}`, "-F", `r=${repository}`, "-F", `n=${number}`])) as {
    errors?: unknown[]; data: { repository: { pullRequest: {
      headRefOid: string; reviewDecision: string | null;
      baseRef: { branchProtectionRule: { requiresApprovingReviews: boolean; requiredStatusChecks: { context: string; app: { id: string } | null }[] } | null };
      commits: { nodes: { commit: { oid: string; statusCheckRollup: { contexts: { totalCount: number; pageInfo: { hasNextPage: boolean }; nodes: {
        __typename: string; name?: string; context?: string; state?: string; status?: string; conclusion?: string; isRequired: boolean; checkSuite?: { app: { id: string } | null };
      }[] } } } }[] };
    } } };
  };
  const pr = response.data.repository.pullRequest;
  const rule = pr.baseRef.branchProtectionRule;
  const commit = pr.commits.nodes[0]?.commit;
  const contexts = commit?.statusCheckRollup?.contexts;
  if (response.errors?.length || pr.headRefOid !== expectedHead || commit?.oid !== expectedHead || !rule
    || typeof rule.requiresApprovingReviews !== "boolean" || !Array.isArray(rule.requiredStatusChecks)
    || !contexts || contexts.pageInfo.hasNextPage || contexts.totalCount !== contexts.nodes.length) throw new Error("Required protection policy or exact-head evidence is unreadable or incomplete");
  const states = rule.requiredStatusChecks.flatMap(check => {
    const matching = contexts.nodes.filter(node => (node.name ?? node.context) === check.context && node.isRequired === true
      && (check.app === null || node.checkSuite?.app?.id === check.app.id));
    return matching.length ? matching.map(node => node.__typename === "CheckRun" ? node.status === "COMPLETED" ? node.conclusion ?? "MISSING" : "PENDING" : node.state ?? "MISSING") : ["MISSING"];
  });
  return { states, review: rule.requiresApprovingReviews && pr.reviewDecision !== "APPROVED" ? "REVIEW_REQUIRED" : pr.reviewDecision ?? "" };
}

/** Close only freshly revalidated owned PRs; cleanup failures are reported without undoing intent. */
export async function closeSuperseded(numbers: number[], successor: number, repository: string, api: ReleaseApi = githubApi): Promise<void> {
  const current = await api(`repos/${repository}/pulls/${successor}`) as RestPr;
  if (!ownsContinuationPr(identity(current), repository, "main") || (current.state !== "open" && !current.merged)) throw new Error("Untrusted successor PR");
  for (const number of numbers) {
    if (number === successor) continue;
    try {
      const pr = await api(`repos/${repository}/pulls/${number}`) as RestPr;
      if (!ownsContinuationPr(identity(pr), repository, "main") || pr.state !== "open") continue;
      await api(`repos/${repository}/issues/${number}/comments`, "POST", { body: `Superseded by release PR #${successor}.` });
      await api(`repos/${repository}/pulls/${number}`, "PATCH", { state: "closed" });
    } catch { process.stdout.write(`::warning::Could not close superseded release PR #${number}\n`); }
  }
}

/** Invoke one bounded workflow transition; every schedule starts with discovery, never preparation. */
export async function runReleaseContinuation(mode: string | undefined): Promise<void> {
  const repository = required("GITHUB_REPOSITORY");
  const output = (key: string, value: string | number) => appendFileSync(required("GITHUB_OUTPUT"), `${key}=${value}\n`);
  const configDigest = releaseConfigDigest(JSON.parse(required("RELEASE_CONFIG")) as Record<string, unknown>);
  const workflow = required("CALLER_WORKFLOW").split(`${repository}/`)[1]?.split("@")[0];
  if (!workflow) throw new Error("Unexpected caller workflow identity");
  const handoff = join(required("RUNNER_TEMP"), "release-artifact");
  if (mode === "manifest") {
    const packageBytes = process.env.IS_RUST === "true" ? Buffer.alloc(0) : readFileSync(join(handoff, "package.tgz"));
    const c: ReleaseCandidate = {
      schema: 1, repository, defaultBranch: "main", baseSha: required("RELEASE_BASE_SHA"), headSha: required("VERIFIED_COMMIT"), tree: required("VERIFIED_TREE"),
      version: required("NPM_VERSION"), tag: required("RELEASE_TAG"), packageName: process.env.PACKAGE_NAME || "github-only",
      packageSha256: releaseDigest(packageBytes), packageIntegrity: `sha512-${createHash("sha512").update(packageBytes).digest("base64")}`,
      notesSha256: releaseDigest(readFileSync(join(handoff, "RELEASE_NOTES.md"))), cliVersion: process.env.CLI_VERSION ?? "", opsVersion: required("PM_OPS_VERSION"),
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
  if (mode === "ownership") {
    const pr = await githubApi(`repos/${repository}/pulls/${required("RELEASE_PR_NUMBER")}`) as RestPr;
    if (!ownsContinuationPr(identity(pr), repository, "main") || pr.state !== "open" || pr.head.ref !== required("RELEASE_BRANCH") || pr.head.sha !== required("REMOTE_BRANCH_SHA")) throw new Error("Release PR ownership or head changed");
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
  const options = { repository, triggerSha: required("TRIGGER_SHA"), workflow, configDigest, timezone: required("RELEASE_TIMEZONE"), now: new Date().toISOString() };
  let receipt: CandidateReceipt;
  if (mode === "probe") {
    const prs = await pages<RestPr>(githubApi, `repos/${repository}/pulls?state=all&base=main&sort=updated&direction=desc`);
    const candidates = prs.filter(pr => ownsContinuationPr(identity(pr), repository, "main") && (pr.state === "open" || typeof pr.merged_at === "string") && pr.body?.includes(marker));
    if (candidates.length > 1) throw new Error("Multiple pending release intents; reconcile explicitly before admitting more work");
    if (!candidates.length) { output("pending", "false"); return; }
    receipt = parseCandidateReceipt(candidates[0].body!)!;
  } else {
    receipt = JSON.parse(required("CANDIDATE_RECEIPT")) as CandidateReceipt;
    const artifact = readFileSync(join(handoff, "candidate.json"), "utf8");
    if (artifact !== JSON.stringify(receipt.candidate)) throw new Error("Stale candidate artifact");
    if (releaseDigest(readFileSync(join(handoff, "RELEASE_NOTES.md"))) !== receipt.candidate.notesSha256) throw new Error("Stale release notes");
    if (receipt.candidate.npmPublish && releaseDigest(readFileSync(join(handoff, "package.tgz"))) !== receipt.candidate.packageSha256) throw new Error("Stale package artifact");
  }
  const result = await inspectCandidate(receipt, options);
  output("pending", result.action === "refresh" ? "false" : "true");
  output("action", result.action);
  output("receipt", JSON.stringify(receipt));
  output("pr_number", result.pr.number);
  output("merged_sha", result.pr.merge_commit_sha ?? "");
  for (const [key, value] of Object.entries(receipt.candidate)) output(key, String(value));
  output("artifact_id", receipt.artifactId);
  if (mode === "attempt") {
    if (result.action !== "publish") throw new Error("Publish is not admitted by fresh evidence");
    await githubApi(`repos/${repository}/issues/${result.pr.number}/comments`, "POST", { body: `${attemptMarker}${JSON.stringify({ candidate: releaseDigest(JSON.stringify(receipt.candidate)), commit: result.pr.merge_commit_sha, attemptedAt: options.now })}\n-->` });
  } else if (mode === "complete") {
    if (result.action !== "complete") throw new Error("Publication is not completely reconciled");
    await githubApi(`repos/${repository}/pulls/${result.pr.number}`, "PATCH", { body: `Daily release ${receipt.candidate.tag} published and reconciled at ${result.pr.merge_commit_sha}.` });
  } else if (!["probe", "verify"].includes(mode ?? "")) throw new Error("Unknown continuation transition");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReleaseContinuation(process.argv[2]).catch((error: unknown) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}

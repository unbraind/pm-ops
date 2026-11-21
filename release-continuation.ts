/** Dependency-free decisions for durable release intents and runner-free reconciliation. */
import { createHash } from "node:crypto";

export { assertReleaseHeadingDate } from "./release-changelog-options.ts";

/** Immutable candidate prepared by a trusted default-branch workflow. */
export interface ReleaseCandidate {
  schema: 1;
  repository: string;
  defaultBranch: string;
  baseSha: string;
  headSha: string;
  tree: string;
  version: string;
  tag: string;
  packageName: string;
  packageSha256: string;
  packageIntegrity: string;
  notesSha256: string;
  cliVersion: string;
  opsVersion: string;
  /** Exact trusted tool commit; absent only on legacy receipts. */
  toolsSha?: string;
  /** Effective npm lifecycle execution used to verify the prepared hooks. */
  npmLifecycle?: boolean | "unknown";
  /** Fallback lifecycle execution prepared for nested npm calls. */
  npmLifecycleConfigured?: boolean | "unknown";
  runId: number;
  runAttempt: number;
  workflow: string;
  configDigest: string;
  npmPublish: boolean;
}

/** Authoritative current PR identity; a list/search result alone never authorizes mutation. */
export interface ContinuationPr {
  number: number;
  author: string;
  repository: string;
  headRepository: string;
  base: string;
  branch: string;
  head: string;
  state: string;
  merged: boolean;
  mergedSha: string | null;
}

/** Live metadata proof for planning; downloaded bytes are verified separately by verifyReleaseHandoff. */
export interface ContinuationEvidence {
  repository: string;
  defaultBranch: string;
  mainSha: string;
  triggerSha: string;
  workflow: string;
  configDigest: string;
  pr: ContinuationPr;
  /** Source run identity and successful prepare-job conclusion from its exact attempt. */
  run: { repository: string; branch: string; sha: string; workflow: string; event: string; conclusion: string; attempt: number };
  artifactAvailable: boolean;
  mergedTree: string;
  mergedParents: string[];
  requiredChecks: string[];
  reviewDecision: string;
  version: string;
  tagSha: string | null;
  releaseSha: string | null;
  registry: "absent" | "verified" | "unverified";
  /** Registry publication predates the trusted preparation run, so this candidate cannot own it. */
  registryPredatesPreparation?: boolean;
  attempted: boolean;
  /** Millisecond timestamps for the latest bound npm attempt and the start of the live registry read. */
  retirementTiming?: { lastAttemptAt: number; registryCheckedAt: number };
  publishedToday: boolean;
  /** Explicit operator-only recovery; never grants publication permission. */
  retireUnpublished?: boolean;
}

/** Hash exact bytes for the artifact, notes, candidate and caller-configuration bindings. */
export function releaseDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Bind every caller input except the scheduling-only mode; key order is immaterial. */
export function releaseConfigDigest(inputs: Record<string, unknown>): string {
  return releaseDigest(JSON.stringify(Object.entries(inputs).filter(([key]) => !["reconcile-only", "retire-unpublished"].includes(key)).sort(([a], [b]) => a < b ? -1 : 1)));
}

/** Read an explicit Cargo package version without crossing into a dependency or workspace table. */
export function cargoPackageVersion(text: string): string {
  return /^[ \t]*\[package\][^\r\n]*\r?\n(?:(?!^[ \t]*\[)[\s\S])*?^[ \t]*version[ \t]*=[ \t]*"([^"\r\n]+)"/m.exec(text)?.[1] ?? "";
}

/** Prove ownership before refreshing or closing a PR; use the same predicate on both paths. */
export function ownsContinuationPr(pr: ContinuationPr, repository: string, base: string): boolean {
  return pr.author === "github-actions[bot]" && pr.repository === repository && pr.headRepository === repository
    && pr.base === base && /^release\/\d{4}\.\d{1,2}\.\d{1,2}(-\d+)?$/.test(pr.branch);
}

/** Refuse malformed durable input before it reaches paths, shell arguments or remote effects. */
export function validateReleaseCandidate(candidate: ReleaseCandidate): void {
  const c = candidate;
  const fields = ["schema", "repository", "defaultBranch", "baseSha", "headSha", "tree", "version", "tag", "packageName", "packageSha256", "packageIntegrity", "notesSha256", "cliVersion", "opsVersion", "toolsSha", "npmLifecycle", "npmLifecycleConfigured", "runId", "runAttempt", "workflow", "configDigest", "npmPublish"];
  if (c.schema !== 1 || !/^[A-Za-z0-9_][\w.-]*\/[A-Za-z0-9_][\w.-]*$/.test(c.repository) || c.defaultBranch !== "main"
    || ![c.baseSha, c.headSha, c.tree].every(sha => /^[a-f0-9]{40}$/.test(sha))
    || !/^\d{4}\.\d+\.\d+(-\d+)?$/.test(c.version) || c.tag !== `v${c.version.split("-")[0].split(".").map(part => part.padStart(2, "0")).join(".")}${c.version.includes("-") ? "-" + c.version.split("-")[1] : ""}`
    || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(c.packageName)
    || ![c.packageSha256, c.notesSha256, c.configDigest].every(digest => /^[a-f0-9]{64}$/.test(digest))
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(c.packageIntegrity)
    || !Number.isSafeInteger(c.runId) || c.runId < 1 || !Number.isSafeInteger(c.runAttempt) || c.runAttempt < 1
    || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(c.workflow)
    || typeof c.npmPublish !== "boolean" || typeof c.cliVersion !== "string" || (c.cliVersion !== "" && !/^\d{4}\.\d+\.\d+(-\d+)?$/.test(c.cliVersion))
    || (c.npmLifecycle !== undefined && c.npmLifecycle !== "unknown" && typeof c.npmLifecycle !== "boolean")
    || (c.npmLifecycleConfigured !== undefined && (c.npmLifecycle === undefined
      || (c.npmLifecycleConfigured !== "unknown" && typeof c.npmLifecycleConfigured !== "boolean")))
    || (c.toolsSha !== undefined && !/^[a-f0-9]{40}$/.test(c.toolsSha))
    || !/^\d{4}\.\d+\.\d+(-\d+)?$/.test(c.opsVersion) || Object.keys(c).some(key => !fields.includes(key))) {
    throw new Error("Malformed release candidate");
  }
}

/** Bind downloaded handoff bytes before any publication, recovery, hook or completion effect. */
export function verifyReleaseHandoff(candidate: ReleaseCandidate, manifest: string, notes: Uint8Array, packageBytes: Uint8Array): void {
  validateReleaseCandidate(candidate);
  if (manifest !== JSON.stringify(candidate)) throw new Error("Stale candidate artifact");
  if (releaseDigest(notes) !== candidate.notesSha256) throw new Error("Stale release notes");
  if (releaseDigest(packageBytes) !== candidate.packageSha256) throw new Error("Stale package artifact");
  if (`sha512-${createHash("sha512").update(packageBytes).digest("base64")}` !== candidate.packageIntegrity) throw new Error("Stale package integrity");
}

/** Evidence for explicit retirement, where any visible npm version blocks cancellation. */
export type RetirementEvidence = Pick<ContinuationEvidence, "repository" | "defaultBranch" | "workflow" | "pr" | "attempted" | "tagSha" | "releaseSha"
  | "retireUnpublished" | "retirementTiming"> & { registry: ContinuationEvidence["registry"] | "present" };

/** Match the ten-minute npm visibility window in the daily publish workflow. */
export const publicationSettleMs = 10 * 60_000;

/** Bind every transition to the freshly read same-repository bot branch and exact candidate head. */
function assertContinuationIdentity(c: ReleaseCandidate, e: RetirementEvidence): void {
  validateReleaseCandidate(c);
  if (c.repository !== e.repository || c.defaultBranch !== e.defaultBranch || c.workflow !== e.workflow
    || !ownsContinuationPr(e.pr, e.repository, e.defaultBranch) || e.pr.head !== c.headSha) throw new Error("Release identity changed");
}

/** Cancel owned unpublished intent even when its obsolete preparation evidence is unavailable. */
export function decideUnpublishedRetirement(c: ReleaseCandidate, e: RetirementEvidence): "retire" {
  assertContinuationIdentity(c, e);
  if (e.retireUnpublished !== true) throw new Error("Operator retirement requires you to explicitly set retire-unpublished=true in a reconcile-only run.");
  if (e.releaseSha !== null) throw new Error("Operator retirement refused because a GitHub Release exists. Reconcile the existing release.");
  if (e.tagSha !== null) throw new Error("Operator retirement refused because a Git tag exists. Reconcile publication for the existing tag.");
  if (e.registry === "unverified") throw new Error("Operator retirement refused because npm registry evidence is unavailable. Retry retirement when the live version check succeeds.");
  if (e.registry !== "absent") throw new Error("Operator retirement refused because the version exists on npm. Verify provenance and reconcile publication.");
  if (e.attempted) {
    const timing = e.retirementTiming;
    if (!timing) throw new Error("Operator retirement refused because the attempt outcome is ambiguous. Verify the publication journal and exact npm version before retrying.");
    if (!(timing.registryCheckedAt > timing.lastAttemptAt + publicationSettleMs)) {
      throw new Error("Operator retirement refused while the attempt is settling. Wait until more than 10 minutes after the latest publish attempt, then rerun retirement for a fresh npm check.");
    }
  }
  return "retire";
}

/** Plan from authoritative metadata; verifyReleaseHandoff binds bytes before executing the plan. */
export function decideReleaseContinuation(c: ReleaseCandidate, e: ContinuationEvidence): "pending" | "refresh" | "publish" | "recover" | "complete" | "stranded" | "retire" | "occupied" {
  assertContinuationIdentity(c, e);
  if (e.retireUnpublished === true) return decideUnpublishedRetirement(c, e);
  if (e.run.repository !== c.repository || e.run.branch !== c.defaultBranch || e.run.sha !== c.baseSha || e.run.workflow !== c.workflow
    || !["schedule", "workflow_dispatch"].includes(e.run.event) || e.run.conclusion !== "success" || e.run.attempt !== c.runAttempt
    || !e.artifactAvailable) throw new Error("Untrusted or expired preparation artifact");
  if (c.configDigest !== e.configDigest) {
    if (e.registry === "absent" && !e.attempted && e.tagSha === null && e.releaseSha === null) return "stranded";
    throw new Error("Caller configuration changed with publication evidence; operator reconciliation is required");
  }
  if (!e.pr.merged) return e.mainSha === c.baseSha ? "pending" : "refresh";
  if (e.pr.state !== "closed" || !e.pr.mergedSha) throw new Error("Merged source identity changed");
  const parent = e.mergedParents.length === 1 ? e.mergedParents[0] : null;
  const changedSource = e.mergedTree !== c.tree || parent !== c.baseSha || e.version !== c.version;
  if (e.requiredChecks.length === 0 || e.requiredChecks.some(state => state !== "SUCCESS")
    || !["APPROVED", ""].includes(e.reviewDecision)) throw new Error("Required protection proof is missing or not green; use reconcile-only with retire-unpublished for verified untouched intent");
  // A protected squash onto a different base can retire an unused receipt for the same occupied version.
  const unattemptedSquash = !e.attempted && e.version === c.version && parent !== null && parent !== c.baseSha
    && /^[a-f0-9]{40}$/.test(parent) && /^[a-f0-9]{40}$/.test(e.mergedTree);
  if (c.npmPublish && (!changedSource || unattemptedSquash) && e.registry === "unverified" && e.registryPredatesPreparation === true
    && e.tagSha === null && e.releaseSha === null) return "occupied";
  if ((e.tagSha !== null && e.tagSha !== e.pr.mergedSha) || (e.releaseSha !== null && (e.releaseSha !== e.pr.mergedSha || e.tagSha === null))
    || e.registry === "unverified") throw new Error("Live publication identity disagrees");
  if (changedSource) {
    if (e.registry === "absent" && !e.attempted && e.tagSha === null && e.releaseSha === null) return "stranded";
    throw new Error("Merged source changed with publication evidence; operator reconciliation is required");
  }
  if (e.registry === "verified" && e.tagSha !== null && e.releaseSha !== null) return "complete";
  // A recorded attempt is not evidence of failure: a registry 404 may be delayed visibility.
  if (e.attempted && e.registry === "absent") throw new Error("Publication outcome is ambiguous; reconcile registry visibility before retry");
  if (e.publishedToday && (e.registry === "absent" || !c.npmPublish)) throw new Error("Daily automatic publication cap reached");
  if (e.registry === "verified") return "recover";
  if (e.mainSha !== e.pr.mergedSha || e.triggerSha !== e.pr.mergedSha) {
    if (e.tagSha !== null) throw new Error("Stranded publication has a tag; operator reconciliation is required");
    return "stranded";
  }
  return "publish";
}

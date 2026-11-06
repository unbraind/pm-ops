/** Dependency-free decisions for durable release intents and runner-free reconciliation. */
import { createHash } from "node:crypto";

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

/** Live proof gathered again at the publication boundary, never from an event payload. */
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
  artifactSha256: string;
  tagSha: string | null;
  releaseSha: string | null;
  registry: "absent" | "verified" | "unverified";
  attempted: boolean;
  publishedToday: boolean;
}

/** Hash exact bytes for the artifact, notes, candidate and caller-configuration bindings. */
export function releaseDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Bind every caller input except the scheduling-only mode; key order is immaterial. */
export function releaseConfigDigest(inputs: Record<string, unknown>): string {
  return releaseDigest(JSON.stringify(Object.entries(inputs).filter(([key]) => key !== "reconcile-only").sort(([a], [b]) => a < b ? -1 : 1)));
}

/** Prove ownership before refreshing or closing a PR; use the same predicate on both paths. */
export function ownsContinuationPr(pr: ContinuationPr, repository: string, base: string): boolean {
  return pr.author === "github-actions[bot]" && pr.repository === repository && pr.headRepository === repository
    && pr.base === base && /^release\/\d{4}\.\d{1,2}\.\d{1,2}(-\d+)?$/.test(pr.branch);
}

/** Refuse malformed durable input before it reaches paths, shell arguments or remote effects. */
export function validateReleaseCandidate(candidate: ReleaseCandidate): void {
  const c = candidate;
  const fields = ["schema", "repository", "defaultBranch", "baseSha", "headSha", "tree", "version", "tag", "packageName", "packageSha256", "packageIntegrity", "notesSha256", "cliVersion", "opsVersion", "toolsSha", "runId", "runAttempt", "workflow", "configDigest", "npmPublish"];
  if (c.schema !== 1 || !/^[A-Za-z0-9_][\w.-]*\/[A-Za-z0-9_][\w.-]*$/.test(c.repository) || c.defaultBranch !== "main"
    || ![c.baseSha, c.headSha, c.tree].every(sha => /^[a-f0-9]{40}$/.test(sha))
    || !/^\d{4}\.\d+\.\d+(-\d+)?$/.test(c.version) || c.tag !== `v${c.version.split("-")[0].split(".").map(part => part.padStart(2, "0")).join(".")}${c.version.includes("-") ? "-" + c.version.split("-")[1] : ""}`
    || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(c.packageName)
    || ![c.packageSha256, c.notesSha256, c.configDigest].every(digest => /^[a-f0-9]{64}$/.test(digest))
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(c.packageIntegrity)
    || !Number.isSafeInteger(c.runId) || c.runId < 1 || !Number.isSafeInteger(c.runAttempt) || c.runAttempt < 1
    || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(c.workflow)
    || typeof c.npmPublish !== "boolean" || typeof c.cliVersion !== "string" || (c.cliVersion !== "" && !/^\d{4}\.\d+\.\d+(-\d+)?$/.test(c.cliVersion))
    || (c.toolsSha !== undefined && !/^[a-f0-9]{40}$/.test(c.toolsSha))
    || !/^\d{4}\.\d+\.\d+(-\d+)?$/.test(c.opsVersion) || Object.keys(c).some(key => !fields.includes(key))) {
    throw new Error("Malformed release candidate");
  }
}

/** Admit only trusted merged bytes; pending checks consume no runner time between invocations. */
export function decideReleaseContinuation(c: ReleaseCandidate, e: ContinuationEvidence): "pending" | "refresh" | "publish" | "recover" | "complete" | "stranded" {
  validateReleaseCandidate(c);
  if (c.repository !== e.repository || c.defaultBranch !== e.defaultBranch || c.workflow !== e.workflow
    || !ownsContinuationPr(e.pr, e.repository, e.defaultBranch) || e.pr.head !== c.headSha) throw new Error("Release identity changed");
  if (e.run.repository !== c.repository || e.run.branch !== c.defaultBranch || e.run.sha !== c.baseSha || e.run.workflow !== c.workflow
    || !["schedule", "workflow_dispatch"].includes(e.run.event) || e.run.conclusion !== "success" || e.run.attempt !== c.runAttempt
    || !e.artifactAvailable) throw new Error("Untrusted or expired preparation artifact");
  if (c.configDigest !== e.configDigest) {
    if (e.registry === "absent" && !e.attempted && e.tagSha === null && e.releaseSha === null) return "stranded";
    throw new Error("Caller configuration changed with publication evidence; operator reconciliation is required");
  }
  if (!e.pr.merged) return e.mainSha === c.baseSha ? "pending" : "refresh";
  if (e.pr.state !== "closed" || !e.pr.mergedSha || e.artifactSha256 !== c.packageSha256) throw new Error("Merged source or artifact changed");
  const changedSource = e.mergedTree !== c.tree || e.mergedParents.length !== 1 || e.mergedParents[0] !== c.baseSha || e.version !== c.version;
  if (e.requiredChecks.length === 0 || e.requiredChecks.some(state => state !== "SUCCESS")
    || !["APPROVED", ""].includes(e.reviewDecision)) throw new Error("Required protection proof is missing or not green");
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

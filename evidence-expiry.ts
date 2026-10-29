/** Operational evidence freshness over core assurance receipts; no Git or writes. */
import { readRegularText } from "./regular-input.ts";
import { createRequire } from "node:module";
import type * as PmSdk from "@unbrained/pm-cli/sdk";
import type { AssuranceGateVerdict, AssuranceScope } from "@unbrained/pm-cli/sdk";

const requireSdk = createRequire(import.meta.url);
/** Acquire the public SDK only when evidence evaluation needs it, independent of CLI executable paths. */
function evidenceSdk(): typeof PmSdk { return requireSdk("@unbrained/pm-cli/sdk") as typeof PmSdk; }

/** Stable outcomes; fresh means reusable evidence, never a new operational test. */
export type EvidenceStatus = "fresh" | "revalidate" | "unavailable";
/** Typed diagnostics shared by SDK and CLI. */
export type EvidenceCode = "fresh" | "evidence_missing" | "evidence_unavailable" | "receipt_not_accepted"
  | "scope_mismatch" | "version_unavailable" | "version_changed" | "evidence_expired" | "evidence_future";
/** Named exact package, backend or deployment identities; keys define the change boundary. */
export type EvidenceVersions = Readonly<Record<string, string>>;
/** A retained claim attached to one exact core assertion receipt. */
export interface OperationalEvidenceClaim {
  /** Public stable claim label. */
  id: string;
  /** Independent assurance dimension. */
  kind: "health" | "coverage" | "recovery";
  /** Exact receipt identity; a newer unrelated verdict cannot replace it. */
  receipt: { gate_id: string; tree_id: string; evaluated_at: string; assertion_id: string };
  /** Required population scope, validated by the core assertion contract. */
  scope: AssuranceScope;
  /** Positive integer time-to-live, in seconds from receipt evaluation. */
  max_age_seconds: number;
  /** Relevant identities captured when the receipt was accepted; never inferred from current versions. */
  versions: EvidenceVersions;
}
/** Versioned policy persisted by the consumer alongside its operational evidence. */
export interface EvidenceExpiryPolicy {
  /** Policy format. */
  version: 1;
  /** Unique claim labels; 1-1000 claims. */
  claims: readonly OperationalEvidenceClaim[];
}
/** Safe actionable refusal, excluding paths, receipt content and raw backend errors. */
export class EvidenceExpiryRefusal extends Error {
  /** Stable machine-readable classification. */
  readonly code: "invalid_policy" | "invalid_versions" | "invalid_options" | "evidence_unavailable";
  /** Safe next action. */
  readonly remedy: string;
  /** CLI usage failures are distinct from unavailable evidence. */
  readonly exitCode: number;
  /** Construct a refusal that agents can recover from without parsing raw exceptions. */
  constructor(code: EvidenceExpiryRefusal["code"], remedy: string) {
    super(`${code}: ${remedy}`);
    this.name = "EvidenceExpiryRefusal";
    this.code = code;
    this.remedy = remedy;
    this.exitCode = code === "evidence_unavailable" ? 1 : 2;
  }
}
/** One bounded diagnostic row, without observed values or connection details. */
export interface EvidenceExpiryRow {
  /** Claim id. */
  id: string;
  /** Independent assurance dimension. */
  kind: OperationalEvidenceClaim["kind"];
  /** Reusability classification. */
  status: EvidenceStatus;
  /** First failing requirement, using deterministic precedence. */
  code: EvidenceCode;
  /** Relevant keys changed or absent; never version values. */
  affected: string[];
  /** Exclusive expiration boundary, or null if evidence is unavailable. */
  expires_at: string | null;
  /** Safe next action. */
  remedy: string;
}
/** Compact report; counts cover all claims even when rows are bounded. */
export interface EvidenceExpiryReport {
  /** Report schema. */
  version: 1;
  /** True only if every claim has fresh accepted evidence. */
  ok: boolean;
  /** Stable evaluation instant. */
  evaluated_at: string;
  /** Total claims evaluated before row projection. */
  total: number;
  /** Counts across the entire policy. */
  counts: Record<EvidenceStatus, number>;
  /** Refusals precede fresh claims; original order is retained within each group. */
  rows: EvidenceExpiryRow[];
  /** Exact omitted row count; use a larger limit to restore. */
  omitted: number;
}
/** Deterministic evaluation and explicit bounded output. */
export interface EvidenceExpiryOptions {
  /** ISO UTC instant; defaults to the actual current time. */
  now?: string;
  /** Maximum rows, 1-1000; default 20. */
  limit?: number;
}

/** Narrow an untrusted value to an object. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Public labels have bounded agent output and no filesystem semantics. */
function label(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9@][a-zA-Z0-9@._:/-]{0,127}$/.test(value);
}
/** Accept canonical UTC timestamps, refusing ambiguous dates and rollover. */
function instant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
/** Validate version maps without inferring or normalizing exact identity strings. */
export function parseEvidenceVersions(value: unknown): EvidenceVersions {
  if (!record(value) || Object.keys(value).length > 100 || Object.entries(value).some(([key, version]) =>
    !label(key) || typeof version !== "string" || !version.trim() || version.length > 128)) {
    throw new EvidenceExpiryRefusal("invalid_versions", "Provide an object of at most 100 public identity keys and nonempty exact version strings.");
  }
  return { ...value } as Record<string, string>;
}
/** Validate attachment policy while delegating assertion scope semantics to the core SDK. */
export function parseEvidenceExpiryPolicy(value: unknown): EvidenceExpiryPolicy {
  const refuse = (): never => { throw new EvidenceExpiryRefusal("invalid_policy", "Provide version 1, 1-1000 uniquely named claims with kind, exact receipt, core scope, positive max_age_seconds and nonempty captured versions."); };
  if (!record(value) || value.version !== 1 || !Array.isArray(value.claims) || value.claims.length < 1 || value.claims.length > 1000) return refuse();
  const ids = new Set<string>();
  const claims = value.claims.map((claim: unknown): OperationalEvidenceClaim => {
    if (!record(claim) || !label(claim.id) || ids.has(claim.id) || typeof claim.kind !== "string" || !["health", "coverage", "recovery"].includes(claim.kind)
      || !record(claim.receipt) || !label(claim.receipt.gate_id) || !label(claim.receipt.assertion_id)
      || !label(claim.receipt.tree_id) || !instant(claim.receipt.evaluated_at)
      || !record(claim.scope) || typeof claim.scope.kind !== "string" || !["all", "active", "filter"].includes(claim.scope.kind)
      || (claim.scope.kind === "filter" && !label(claim.scope.measurement_id))
      || !Number.isSafeInteger(claim.max_age_seconds) || Number(claim.max_age_seconds) < 1
      || Number(claim.max_age_seconds) > 315_360_000) return refuse();
    let scope: AssuranceScope;
    let versions: EvidenceVersions;
    try {
      scope = evidenceSdk().validateAssertionDefinition({ id: "expiry-scope", measurement_id: "expiry-scope", owner_item_id: "expiry-scope",
        scope: claim.scope as AssuranceScope, zero: true, enforcement: "block",
        negative_control: { cases: [{ observed: 0, expected: "pass" }, { observed: 1, expected: "fail" }] },
      }).scope;
      versions = parseEvidenceVersions(claim.versions);
      if (Object.keys(versions).length === 0) return refuse();
    } catch { return refuse(); }
    ids.add(claim.id);
    return { id: claim.id, kind: claim.kind as OperationalEvidenceClaim["kind"], receipt: { ...claim.receipt } as OperationalEvidenceClaim["receipt"],
      scope, max_age_seconds: Number(claim.max_age_seconds), versions };
  });
  return { version: 1, claims };
}

/** Scope comparison uses only the discriminants accepted by the core validator. */
function sameScope(left: AssuranceScope, right: AssuranceScope): boolean {
  return record(right) && left.kind === right.kind && (left.kind !== "filter" || (right.kind === "filter" && left.measurement_id === right.measurement_id));
}
/** Safe remedies do not disclose backend data or filesystem locations. */
const REMEDIES: Record<EvidenceCode, string> = {
  fresh: "",
  evidence_missing: "Record accepted evidence and bind its exact identity; only the newest 1000 durable gate verdicts are searched.",
  evidence_unavailable: "Restore readable, sealed core assurance history on a stable snapshot, then retry.",
  receipt_not_accepted: "Rerun the operational check and persist a complete passing assertion with proven negative controls and a nonempty population.",
  scope_mismatch: "Collect evidence for the required core population scope and update the attachment.",
  version_unavailable: "Supply current identities for every version key required by this claim.",
  version_changed: "Revalidate this claim against its changed identities, then attach the new receipt and captured versions.",
  evidence_expired: "Rerun this operational check and attach its new receipt; do not extend an old receipt timestamp.",
  evidence_future: "Correct the evaluation clock or collect evidence with a valid timestamp.",
};

/** Evaluate one exact receipt; missing or non-passing evidence cannot be promoted by a version match. */
function evaluateClaim(claim: OperationalEvidenceClaim, versions: EvidenceVersions, receipts: readonly AssuranceGateVerdict[] | null, now: number): EvidenceExpiryRow {
  const row: EvidenceExpiryRow = { id: claim.id, kind: claim.kind, status: "unavailable", code: "evidence_missing", affected: [], expires_at: null, remedy: "" };
  const matches = receipts?.filter((receipt) => record(receipt) && receipt.gate_id === claim.receipt.gate_id && receipt.tree_id === claim.receipt.tree_id && receipt.evaluated_at === claim.receipt.evaluated_at);
  const gate = matches?.length === 1 ? matches[0] : undefined;
  const assertions = Array.isArray(gate?.assertions) ? gate.assertions.filter((assertion) => record(assertion) && assertion.assertion_id === claim.receipt.assertion_id) : undefined;
  const assertion = assertions?.length === 1 ? assertions[0] : undefined;
  if (receipts === null) row.code = "evidence_unavailable";
  else if (!gate || !assertion) row.code = "evidence_missing";
  else if (gate.dry_run !== false || gate.assertions_total !== gate.assertions.length || assertion.verdict !== "pass"
    || assertion.negative_control_proven !== true || !Number.isSafeInteger(assertion.population_size) || assertion.population_size < 1) row.code = "receipt_not_accepted";
  else if (!sameScope(claim.scope, assertion.scope)) row.code = "scope_mismatch";
  else {
    const captured = Date.parse(gate.evaluated_at);
    const expires = captured + claim.max_age_seconds * 1000;
    row.expires_at = new Date(expires).toISOString();
    const keys = Object.keys(claim.versions).sort();
    const missing = keys.filter((key) => !Object.hasOwn(versions, key));
    const changed = keys.filter((key) => Object.hasOwn(versions, key) && claim.versions[key] !== versions[key]);
    if (missing.length) { row.code = "version_unavailable"; row.affected = missing; }
    else {
      row.status = "revalidate";
      if (captured > now) row.code = "evidence_future";
      else if (changed.length) { row.code = "version_changed"; row.affected = changed; }
      else if (now >= expires) row.code = "evidence_expired";
      else { row.status = "fresh"; row.code = "fresh"; }
    }
  }
  row.remedy = REMEDIES[row.code];
  return row;
}

/**
 * Evaluate caller-supplied durable receipts from any backend, without I/O.
 * The caller owns receipt authenticity; use auditEvidenceExpiry for a directory tracker.
 * null represents unavailable evidence and never an empty successful observation.
 */
export function evaluateEvidenceExpiry(policy: EvidenceExpiryPolicy, currentVersions: EvidenceVersions,
  receipts: readonly AssuranceGateVerdict[] | null, options: EvidenceExpiryOptions = {}): EvidenceExpiryReport {
  const parsed = parseEvidenceExpiryPolicy(policy);
  const versions = parseEvidenceVersions(currentVersions);
  const now = options.now ?? new Date().toISOString();
  const limit = options.limit ?? 20;
  if (!instant(now) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new EvidenceExpiryRefusal("invalid_options", "Use a canonical UTC ISO timestamp and an integer row limit from 1 through 1000.");
  }
  const rows = parsed.claims.map((claim) => evaluateClaim(claim, versions, receipts, Date.parse(now)));
  const counts: EvidenceExpiryReport["counts"] = { fresh: 0, revalidate: 0, unavailable: 0 };
  for (const row of rows) counts[row.status]++;
  const ordered = [...rows.filter((row) => row.status !== "fresh"), ...rows.filter((row) => row.status === "fresh")];
  return { version: 1, ok: counts.fresh === rows.length, evaluated_at: now, total: rows.length, counts, rows: ordered.slice(0, limit), omitted: Math.max(0, rows.length - limit) };
}

/** Read core receipts and verify record envelopes through SDK primitives, refusing concurrent history changes. */
async function readEvidence(pmRoot: string): Promise<AssuranceGateVerdict[] | null> {
  try {
    const { getWorkspaceHistoryPath, listAssuranceVerdicts, readHistorySnapshot, verifyHistoryRecordHash, WORKSPACE_HISTORY_ID } = evidenceSdk();
    const path = getWorkspaceHistoryPath(pmRoot);
    const before = await readHistorySnapshot(path, WORKSPACE_HISTORY_ID);
    for (const entry of before.entries.filter((entry) => entry.op === "assurance:gate:verdict")) {
      const integrity = verifyHistoryRecordHash(entry);
      if (!integrity.ok || integrity.coverage !== "record_and_item_state") return null;
    }
    const receipts = await listAssuranceVerdicts(pmRoot, { limit: 1000 });
    const after = await readHistorySnapshot(path, WORKSPACE_HISTORY_ID);
    return before.raw === after.raw ? receipts : null;
  } catch { return null; }
}

/** Evaluate a directory tracker with side-effect-free public SDK reads; works outside Git. */
export async function auditEvidenceExpiry(pmRoot: string, policy: EvidenceExpiryPolicy, versions: EvidenceVersions,
  options: EvidenceExpiryOptions = {}): Promise<EvidenceExpiryReport> {
  return evaluateEvidenceExpiry(policy, versions, await readEvidence(pmRoot), options);
}
/** Parse a JSON input without leaking paths or raw parser diagnostics. */
async function readInput(path: string, code: "invalid_policy" | "invalid_versions"): Promise<unknown> {
  try { return JSON.parse(readRegularText(path)); }
  catch { throw new EvidenceExpiryRefusal(code, "Provide a regular JSON input file no larger than 16 MiB matching the documented schema."); }
}
/** CLI-friendly file inputs; the selected tracker remains host-owned. */
export async function auditEvidenceExpiryFiles(pmRoot: string, policyFile: string, versionsFile: string,
  options: EvidenceExpiryOptions = {}): Promise<EvidenceExpiryReport> {
  const policy = parseEvidenceExpiryPolicy(await readInput(policyFile, "invalid_policy"));
  const versions = parseEvidenceVersions(await readInput(versionsFile, "invalid_versions"));
  return auditEvidenceExpiry(pmRoot, policy, versions, options);
}

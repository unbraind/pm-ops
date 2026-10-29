import type { AssuranceGateVerdict, AssuranceScope } from "@unbrained/pm-cli/sdk";
/** Stable outcomes; fresh means reusable evidence, never a new operational test. */
export type EvidenceStatus = "fresh" | "revalidate" | "unavailable";
/** Typed diagnostics shared by SDK and CLI. */
export type EvidenceCode = "fresh" | "evidence_missing" | "evidence_unavailable" | "receipt_not_accepted" | "scope_mismatch" | "version_unavailable" | "version_changed" | "evidence_expired" | "evidence_future";
/** Named exact package, backend or deployment identities; keys define the change boundary. */
export type EvidenceVersions = Readonly<Record<string, string>>;
/** A retained claim attached to one exact core assertion receipt. */
export interface OperationalEvidenceClaim {
    /** Public stable claim label. */
    id: string;
    /** Independent assurance dimension. */
    kind: "health" | "coverage" | "recovery";
    /** Exact receipt identity; a newer unrelated verdict cannot replace it. */
    receipt: {
        gate_id: string;
        tree_id: string;
        evaluated_at: string;
        assertion_id: string;
    };
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
export declare class EvidenceExpiryRefusal extends Error {
    /** Stable machine-readable classification. */
    readonly code: "invalid_policy" | "invalid_versions" | "invalid_options" | "evidence_unavailable";
    /** Safe next action. */
    readonly remedy: string;
    /** CLI usage failures are distinct from unavailable evidence. */
    readonly exitCode: number;
    /** Construct a refusal that agents can recover from without parsing raw exceptions. */
    constructor(code: EvidenceExpiryRefusal["code"], remedy: string);
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
/** Validate version maps without inferring or normalizing exact identity strings. */
export declare function parseEvidenceVersions(value: unknown): EvidenceVersions;
/** Validate attachment policy while delegating assertion scope semantics to the core SDK. */
export declare function parseEvidenceExpiryPolicy(value: unknown): EvidenceExpiryPolicy;
/**
 * Evaluate caller-supplied durable receipts from any backend, without I/O.
 * The caller owns receipt authenticity; use auditEvidenceExpiry for a directory tracker.
 * null represents unavailable evidence and never an empty successful observation.
 */
export declare function evaluateEvidenceExpiry(policy: EvidenceExpiryPolicy, currentVersions: EvidenceVersions, receipts: readonly AssuranceGateVerdict[] | null, options?: EvidenceExpiryOptions): EvidenceExpiryReport;
/** Evaluate a directory tracker with side-effect-free public SDK reads; works outside Git. */
export declare function auditEvidenceExpiry(pmRoot: string, policy: EvidenceExpiryPolicy, versions: EvidenceVersions, options?: EvidenceExpiryOptions): Promise<EvidenceExpiryReport>;
/** CLI-friendly file inputs; the selected tracker remains host-owned. */
export declare function auditEvidenceExpiryFiles(pmRoot: string, policyFile: string, versionsFile: string, options?: EvidenceExpiryOptions): Promise<EvidenceExpiryReport>;
//# sourceMappingURL=evidence-expiry.d.ts.map
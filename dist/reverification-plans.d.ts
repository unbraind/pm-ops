import { type EvidenceExpiryOptions } from "./evidence-expiry.ts";
/** One explicit evidence classification; authenticity belongs to the supplying expiry evaluator. */
export interface ReverificationClaim {
    /** Public claim identity, independent of native item status names. */
    id: string;
    /** Existing evidence classification, never inferred from a planned check. */
    status: "fresh" | "revalidate" | "unavailable";
}
/** Caller-approved logical check; this module never runs commands. */
export interface ReverificationCheck {
    /** Unique public check identity. */
    id: string;
    /** Explicit caller approval; dependencies require their own approval too. */
    approved: boolean;
    /** Integer cost units, 0-1000000000, shared across the whole catalog. */
    cost: number;
    /** Checks that must succeed first; missing or cyclic prerequisites cause gaps. */
    requires: string[];
    /** Claims this check can support after a successful fresh rerun and receipt attachment. */
    supports: string[];
}
/** Strict bounded compiler input; no persisted state, executable code or implicit defaults. */
export interface ReverificationInput {
    /** Contract version. */
    version: 1;
    /** Complete declared evidence population, 1-32 unique claims. */
    claims: ReverificationClaim[];
    /** Explicit requested claim identities, 1-16 unique targets. */
    targets: string[];
    /** Up to 18 checks, permitting an exact bounded search instead of a greedy estimate. */
    checks: ReverificationCheck[];
}
/** Recoverable usage failures; no untrusted content or filesystem paths are echoed. */
export declare class ReverificationRefusal extends Error {
    /** Stable refusal classification. */
    readonly code: "invalid_reverification_input" | "invalid_reverification_plan";
    /** Public safe recovery instruction. */
    readonly remedy: string;
    /** Invalid contracts are usage failures. */
    readonly exitCode = 2;
    /** Construct a sanitized refusal with its remedy. */
    constructor(code: ReverificationRefusal["code"], remedy: string);
}
/** Every target is accounted for, including targets that cannot be repaired. */
export interface ReverificationRow {
    /** Requested claim identity. */
    claim: string;
    /** A planned check is conditional, never fresh evidence. */
    code: "fresh" | "rerun_required" | "no_supporting_check" | "approval_required" | "dependency_unavailable";
    /** Selected supporting check, or null for fresh evidence and gaps. */
    check: string | null;
    /** Safe next action; empty only for already fresh evidence. */
    remedy: string;
}
/** Compact exact plan; ok means complete repair coverage, never an assurance verdict. */
export interface ReverificationPlan {
    /** Output contract version. */
    version: 1;
    /** Digest of the entire normalized input, including evidence states, costs and approvals. */
    id: string;
    /** True only when every target is fresh or has an approved, executable dependency closure. */
    ok: boolean;
    /** Exact integer total of selected checks, charged once each. */
    cost: number;
    /** Cost of rerunning every executable approved check, including irrelevant checks. */
    all_cost: number;
    /** Exact nonnegative difference from all_cost. */
    saved: number;
    /** Topological order; shared prerequisites appear exactly once. */
    steps: {
        id: string;
        cost: number;
        requires: string[];
    }[];
    /** Complete target accounting; no row truncation. */
    rows: ReverificationRow[];
}
/** Single strict boundary schema shared by file readers, SDK callers and producers. */
export declare function parseReverificationInput(value: unknown): ReverificationInput;
/** Enforce finite exact output totals and their documented arithmetic before returning a plan. */
export declare function validateReverificationCosts(value: unknown): void;
/** Validate once, then compute the exact minimum-cost approved repair set without I/O. */
export declare function compileReverificationPlan(value: unknown): ReverificationPlan;
/** Validate a transported plan by regenerating it through the same compiler and source contract. */
export declare function parseReverificationPlan(value: unknown, input: unknown): ReverificationPlan;
/** Read strict bounded JSON while keeping path and parser diagnostics private. */
export declare function readReverificationInput(path: string): ReverificationInput;
/** Re-read canonical expiry evidence before compiling; missing attachments remain unavailable. */
export declare function auditReverificationFiles(pmRoot: string, policy: string, versions: string, input: string, options?: EvidenceExpiryOptions): Promise<ReverificationPlan>;
//# sourceMappingURL=reverification-plans.d.ts.map
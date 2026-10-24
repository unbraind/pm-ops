/** Accepted observations; raw failure output is never retained. */
export declare const DIAGNOSTIC_FAILURES: readonly ["schema_unreadable", "items_unreadable", "history_invalid", "registry_unavailable"];
/** Failure classifications callers derive from their observed scan/report failures. */
export type DiagnosticFailure = typeof DIAGNOSTIC_FAILURES[number];
/** Fixed catalog identities, independent of executable locations. */
export type DiagnosticCommand = "sdk:schema:v1" | "sdk:items:v1" | "sdk:history:v1" | "http:registry-head:v1";
/** Hard ceilings, charged before dispatch; network counts logical HTTP requests. */
export interface DiagnosticBudget {
    /** Maximum total child launches, including failed launches; 0-4. */
    processes: number;
    /** Maximum HTTP requests; 0-1. Local SDK probes use zero. */
    network: number;
    /** Shared wall-clock deadline, including process startup; 1-60000 ms. */
    time_ms: number;
}
/** One ordered, fixed-cost catalog invocation. */
export interface DiagnosticStep {
    /** Stable command identity; no shell or caller-supplied code. */
    command: DiagnosticCommand;
    /** Observed classification that selected this command. */
    failure: DiagnosticFailure;
    /** Worst-case reservation charged before launching. */
    cost: {
        processes: 1;
        network: number;
    };
}
/** Portable review artifact; contains no paths, secrets or raw failure text. */
export interface DiagnosticPlan {
    /** Catalog and receipt format version. */
    version: 1;
    /** SHA-256 binding to the canonical tracker directory, excluding its cleartext path. */
    scope: string;
    /** Deterministic digest of scope, catalog steps and budgets. */
    id: string;
    /** Reviewable hard resource ceilings. */
    budget: DiagnosticBudget;
    /** Deduplicated catalog order; at most four steps. */
    steps: DiagnosticStep[];
}
/** Safe machine-readable refusal with a fixed recovery instruction. */
export declare class DiagnosticRefusal extends Error {
    /** Stable error category. */
    readonly code: "invalid_plan" | "invalid_options" | "scope_unavailable" | "scope_mismatch" | "selection_required";
    /** Safe next action. */
    readonly remedy: string;
    /** Invalid or unselected input is a usage refusal. */
    readonly exitCode = 2;
    /** Construct without retaining untrusted input or raw errors. */
    constructor(code: DiagnosticRefusal["code"], remedy: string);
}
/** Receipt codes never carry subprocess output. */
export type DiagnosticCode = "verified" | "probe_failed" | "network_budget" | "process_budget" | "time_budget";
/** One sanitized receipt, including skipped probes so scope never silently shrinks. */
export interface DiagnosticReceipt {
    /** Exact reviewed command identity. */
    command: DiagnosticCommand;
    /** Why the probe ran or could not run. */
    code: DiagnosticCode;
    /** Verified item, schema-type or history-entry count; zero for failures and skipped probes. */
    checked: number;
    /** Fixed, data-free next action. */
    remedy: string;
}
/** Compact result retains every planned identity, even after exhaustion. */
export interface DiagnosticRun {
    /** Receipt format. */
    version: 1;
    /** Selected plan digest. */
    plan: string;
    /** Exact reviewed scope digest. */
    scope: string;
    /** True only when every probe verified. Inspect this diagnostic predicate. */
    ok: boolean;
    /** Reserved resources and measured wall time. */
    used: DiagnosticBudget;
    /** Complete ordered receipt set. */
    rows: DiagnosticReceipt[];
}
/** Generate a review artifact only; does not launch probes or write the tracker. */
export declare function createDiagnosticPlan(pmRoot: string, failures: readonly DiagnosticFailure[], budget?: DiagnosticBudget): Promise<DiagnosticPlan>;
/** Reject tampering, extra fields and stale catalog definitions before execution. */
export declare function parseDiagnosticPlan(value: unknown): DiagnosticPlan;
/** Execute exactly the selected reviewed plan, stopping all further dispatch after any budget exhaustion. */
export declare function executeDiagnosticPlan(pmRoot: string, input: DiagnosticPlan, selected: string, start?: number): Promise<DiagnosticRun>;
/** Read a bounded review artifact, refusing paths and parser errors without echoing them. */
export declare function readDiagnosticPlan(path: string): Promise<DiagnosticPlan>;
//# sourceMappingURL=diagnostic-plans.d.ts.map
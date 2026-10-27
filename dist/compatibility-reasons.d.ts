/** Explicit metadata; null means unknown, while an empty capability list means known empty. */
export interface CompatibilityComponent {
    /** Public metadata identity, independent of package resolution or paths. */
    id: string;
    /** Observed exact semantic version, or null when unavailable. */
    version: string | null;
    /** Exhaustive declared support, or null when unavailable. */
    capabilities: string[] | null;
}
/** One directed declaration from a package or extension to its dependency or host. */
export interface CompatibilityRequirement {
    /** Unique declaration identity. */
    id: string;
    /** Declaring component. */
    from: string;
    /** Required component. */
    to: string;
    /** npm semantic version range; null is unknown, * is explicitly unrestricted. */
    range: string | null;
    /** Required capabilities; null is unknown, [] explicitly requires none. */
    capabilities: string[] | null;
    /** Optional native extension bounds, evaluated by the public SDK against the target. */
    manifest?: {
        pm_min_version?: string;
        pm_max_version?: string;
    };
}
/** Versioned strict input; at most 16 components and 12 requirements. */
export interface CompatibilityInput {
    /** Input contract version. */
    version: 1;
    /** Unique observed components. */
    components: CompatibilityComponent[];
    /** Unique directed declarations; cycles are permitted. */
    requirements: CompatibilityRequirement[];
}
/** Actionable refusal that never includes supplied paths or raw parser errors. */
export declare class CompatibilityRefusal extends Error {
    /** Stable machine-readable classification. */
    readonly code: "invalid_compatibility_input" | "compatibility_input_unreadable" | "invalid_compatibility_output" | "compatibility_sdk_unavailable";
    /** Safe recovery guidance. */
    readonly remedy: string;
    /** Invalid input is a usage error. */
    readonly exitCode = 2;
    /** Construct a sanitized refusal. */
    constructor(code: CompatibilityRefusal["code"], remedy: string);
}
/** One independently established conflict with a minimum-cardinality witness. */
export interface CompatibilityConflict {
    /** Joint declarations, observed pin, capability declaration, or native admission finding. */
    code: "joint_range_conflict" | "installed_pin_conflict" | "capability_conflict" | "extension_bound_conflict";
    /** Exact declaration ids; installed pin/support is explicit in the row's component. */
    requirements: string[];
    /** Conflicting capability or native SDK code, if relevant. */
    detail: string;
}
/** Compact explanation for a component with incoming constraints. */
export interface CompatibilityRow {
    /** Observed target metadata, including unknowns. */
    component: CompatibilityComponent;
    /** Incompatibility takes precedence; unknowns remain visible independently. */
    status: "compatible" | "incompatible" | "unknown";
    /** OR of conjunctions (all ranges in each inner array must hold). Preserves npm prerelease rules. */
    compatible_ranges: string[][] | null;
    /** Minimum witnesses per established conflict dimension. */
    conflicts: CompatibilityConflict[];
    /** Declaration ids with incomplete metadata and a reason code. */
    unknown: {
        requirement: string;
        code: string;
    }[];
    /** Deterministic shortest upstream paths ending at relevant declarations; ids refer to declarations. */
    chains: string[][];
    /** Next safe step; never an authorization or automatic change. */
    remedy: string;
}
/** Bounded report; ok means every declared check is compatible, never admission authorization. */
export interface CompatibilityReport {
    /** Report contract version. */
    version: 1;
    /** True only with no conflicts or unknowns. */
    ok: boolean;
    /** Evaluation is observational. */
    preview: true;
    /** Complete declarations so every reason chain is self-contained. */
    requirements: CompatibilityRequirement[];
    /** One row per referenced target, sorted by id. */
    rows: CompatibilityRow[];
    /** Finite bounded outcome counts. */
    counts: {
        compatible: number;
        incompatible: number;
        unknown: number;
    };
    /** Literal argv previews, never executed. */
    commands: string[][];
}
/** One strict structural schema shared by SDK and file producers; metadata text stays verbatim. */
export declare function parseCompatibilityInput(value: unknown): CompatibilityInput;
/** Check every emitted numeric field before returning a successful report. */
export declare function validateCompatibilityCounts(counts: CompatibilityReport["counts"], rowCount: number): void;
/** Explain joint declarations without loading extensions, invoking commands or touching tracker state. */
export declare function explainCompatibility(value: unknown): CompatibilityReport;
/** Read at most 64 KiB of regular JSON; no shell, Git, installs or configuration edits. */
export declare function readCompatibilityReasons(path: string): CompatibilityReport;
//# sourceMappingURL=compatibility-reasons.d.ts.map
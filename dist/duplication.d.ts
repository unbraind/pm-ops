/**
 * Canonical TypeScript duplication analysis and fail-closed gate for the fleet.
 *
 * Two jscpd majors are supported, and their engines are structurally
 * different, so the analyzer dispatches on the installed major:
 *
 * - jscpd 4 ships a Node.js programmatic API, used directly so consumer
 *   launchers stay small while preserving the detector's clone locations.
 * - jscpd 5 replaced the Node.js API with a self-contained Rust binary, so
 *   the analyzer runs the binary with its JSON reporter and parses the report.
 */
/** Default TypeScript glob scanned by the duplication gate. */
export declare const DEFAULT_DUPLICATION_GLOBS: readonly string[];
/** A clone pair with repository-relative file names and inclusive line ranges. */
export interface DuplicationClone {
    /** First cloned file and its inclusive source line range. */
    readonly first: {
        readonly file: string;
        readonly startLine: number;
        readonly endLine: number;
    };
    /** Second cloned file and its inclusive source line range. */
    readonly second: {
        readonly file: string;
        readonly startLine: number;
        readonly endLine: number;
    };
}
/** The measured result returned by the programmatic duplication analyzer. */
export interface DuplicationReport {
    /** Aggregate duplicated-line percentage implied by jscpd's line counts. */
    readonly percentage: number;
    /** Total source lines scanned by jscpd. */
    readonly totalLines: number;
    /** Lines counted as duplicated by jscpd. */
    readonly duplicatedLines: number;
    /** Number of TypeScript source files actually analyzed by jscpd. */
    readonly sources: number;
    /** In-scope files matched by the globs but skipped by jscpd. */
    readonly skippedSources: readonly string[];
    /** Number of clone pairs returned by jscpd. */
    readonly cloneCount: number;
    /** Every clone pair, including pairs below the configured threshold. */
    readonly clones: readonly DuplicationClone[];
}
/** Process and repository boundaries accepted by {@link runDuplicationGate}. */
export interface DuplicationGateOptions {
    /** Repository root containing package.json and the TypeScript files to scan. */
    readonly repoRoot?: string;
    /** Fast-glob patterns passed to jscpd; defaults to every TypeScript file. */
    readonly globs?: readonly string[];
    /** Minimum jscpd token count; defaults to 50 for direct analysis callers. */
    readonly minTokens?: number;
    /** Success logger used by the launcher and behavioral tests. */
    readonly log?: (message: string) => void;
    /** Failure logger used by the launcher and behavioral tests. */
    readonly error?: (message: string) => void;
    /** Exit boundary used to assert fail-closed behavior without ending a test process. */
    readonly exit?: (code: number) => never;
}
/** One cloned file end as reported by jscpd 5's JSON reporter. */
interface ReportedCloneEnd {
    /** Absolute file path, because the analyzer runs jscpd with `--absolute`. */
    readonly name: string;
    /** First cloned line, inclusive. */
    readonly start: number;
    /** Last cloned line, inclusive. */
    readonly end: number;
}
/** One clone pair as reported by jscpd 5's JSON reporter. */
interface ReportedClone {
    readonly firstFile: ReportedCloneEnd;
    readonly secondFile: ReportedCloneEnd;
}
/** jscpd 5's JSON report shape, as written by its `json` reporter. */
interface ReportedAnalysis {
    readonly duplicates: readonly ReportedClone[];
    readonly statistics: {
        readonly total: {
            readonly lines: number;
            readonly duplicatedLines: number;
        };
    };
}
/**
 * Parse and validate a jscpd 5 JSON report.
 *
 * Every field the duplication gate consumes is checked, so a jscpd output
 * format change fails the gate closed instead of silently reporting zero.
 *
 * @param report - The parsed `jscpd-report.json` value.
 * @returns The clone pairs and aggregate line statistics, validated.
 */
export declare function parseJscpdReport(report: unknown): ReportedAnalysis;
/** Return the fail-closed diagnostic for an empty or partially analyzed scope. */
export declare function duplicationGateDiagnostic(report: Pick<DuplicationReport, "sources" | "skippedSources">): string | undefined;
/**
 * Analyze a repository's TypeScript sources with the installed jscpd major.
 *
 * jscpd 4 runs through its Node.js API and jscpd 5 through its Rust binary,
 * and both are resolved from the repository root so a consumer's own jscpd
 * dependency is the engine that answers.
 *
 * @param options - Repository root and optional source globs.
 * @returns Aggregate percentage and every clone pair found by jscpd.
 */
export declare function analyzeDuplication(options?: Pick<DuplicationGateOptions, "repoRoot" | "globs" | "minTokens">): Promise<DuplicationReport>;
/**
 * Run the configured duplication threshold gate and print every clone pair.
 *
 * A missing or malformed `duplicationGate` block fails closed with a
 * remediation message. The default minimum token count is 50, matching jscpd.
 *
 * @param options - Repository, glob, logging, and process boundaries.
 */
export declare function runDuplicationGate(options?: DuplicationGateOptions): Promise<void>;
export {};
//# sourceMappingURL=duplication.d.ts.map
/**
 * Canonical TypeScript duplication analysis and fail-closed gate for the fleet.
 *
 * This module uses jscpd's programmatic detector rather than its CLI, keeping
 * consumer launchers small while preserving the detector's clone locations and
 * aggregate percentage for machine-readable callers.
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
    /** Aggregate duplicated-line percentage reported by jscpd. */
    readonly percentage: number;
    /** Total source lines scanned by jscpd. */
    readonly totalLines: number;
    /** Lines counted as duplicated by jscpd. */
    readonly duplicatedLines: number;
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
/**
 * Analyze a repository's TypeScript sources with jscpd's programmatic API.
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
//# sourceMappingURL=duplication.d.ts.map
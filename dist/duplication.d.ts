/**
 * Default globs scanned by the duplication gate: every authored TypeScript
 * source (`.ts`, `.tsx`, `.mts`, `.cts`) in the repository.
 */
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
    /** Glob patterns passed to jscpd; defaults to every TypeScript file. */
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
    /** Whole-line span of the clone, at least one line per the analyzer's floor. */
    readonly lines: number;
}
/** jscpd 5's JSON report shape, as written by its `json` reporter. */
interface ReportedAnalysis {
    readonly duplicates: readonly ReportedClone[];
    readonly statistics: {
        readonly total: {
            readonly lines: number;
            readonly duplicatedLines: number;
            readonly sources: number;
        };
    };
}
/**
 * Parse and validate a jscpd 5 JSON report.
 *
 * Every field the duplication gate consumes is checked, so a jscpd output
 * format change fails the gate closed instead of silently reporting zero.
 * jscpd 5.4 counts overlapping clone regions once per clone, so
 * `duplicatedLines` may exceed the total `lines` of the scanned sources; the
 * fail-closed bound is instead the sum of the reported clone spans, which no
 * real report can exceed without double-counting clones themselves.
 *
 * @param report - The parsed `jscpd-report.json` value.
 * @returns The clone pairs and aggregate line statistics, validated.
 */
export declare function parseJscpdReport(report: unknown): ReportedAnalysis;
/**
 * Maximum brace-union alternatives one configured glob may expand into.
 *
 * The duplication gate refuses a configured glob whose brace expansion would
 * produce more than this many alternatives, so a hostile configuration
 * cannot explode memory; realistic configurations expand to a handful.
 */
export declare const MAX_GLOB_UNION_ALTERNATIVES = 1024;
/**
 * Expand comma brace unions so leading negative alternatives remain excludes.
 *
 * The leftmost expandable union is expanded first and every alternative is
 * expanded recursively before the next, preserving the exact left-to-right
 * expansion order; nested and non-comma braces are left literal. Expansion is
 * refused with a clear error as soon as it would exceed
 * {@link MAX_GLOB_UNION_ALTERNATIVES} alternatives: every alternative always
 * contributes at least one expanded pattern, so a union wider than the
 * remaining budget overflows immediately, before its alternatives are built.
 *
 * @param pattern - The combined glob pattern to expand.
 * @returns The expanded patterns, in the previous left-to-right order.
 * @throws When the expansion would exceed {@link MAX_GLOB_UNION_ALTERNATIVES}.
 */
export declare function expandGlobUnions(pattern: string): string[];
/**
 * Discover authored sources with built-in glob, preserving fast-glob's scope.
 * Hidden entries supplement native glob because Bun omits even explicit .*.
 * Native path matching on prefixed segments retains the former dot:true policy.
 * lstat rejects discovered symlinks; explicit symlink bases retain prior scope.
 */
export declare function globMatchedSources(repoRoot: string, pattern: string): Promise<string[]>;
/**
 * Build the jscpd scan-target arguments for one analysis.
 *
 * The matched sources are handed to jscpd as explicit scan paths, because its
 * own walker only walks each scan root and cannot reach a configured scope
 * outside the repository root, which the source discovery accepts; the paths
 * are resolved absolute so jscpd's working directory is irrelevant, and the
 * `--pattern` filter is dropped because jscpd would re-apply it to the already
 * discovered paths and drop them. An empty match keeps the repository-root
 * scan with the configured pattern, so the completeness receipt still proves
 * the zero-source result instead of an empty argument list. An explicit list
 * too long for a conservative argv budget — which also clears Windows's
 * 32 767-character command-line ceiling — moves into a temporary jscpd config
 * file instead of being chunked: chunks would miss every clone pair whose
 * files land in different chunks and undercount duplication for a fail-closed
 * gate.
 *
 * @param repoRoot - Repository root the matched sources are relative to.
 * @param pattern - The combined glob pattern of the configured scope.
 * @param matchedSources - Repository-relative sources matched by the scope.
 * @param outputDir - Scratch directory for the analysis report and list file.
 * @returns The jscpd positional and `--config` scan-target arguments.
 */
export declare function jscpdScanArguments(repoRoot: string, pattern: string, matchedSources: readonly string[], outputDir: string): string[];
/** Return the fail-closed diagnostic for an empty or partially analyzed scope. */
export declare function duplicationGateDiagnostic(report: Pick<DuplicationReport, "sources" | "skippedSources">): string | undefined;
/**
 * Analyze a repository's TypeScript sources with the installed jscpd 5 binary.
 * Resolve from the repository root so the consumer's own dependency answers.
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
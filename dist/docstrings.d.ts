import { SyntaxKind } from "typescript/unstable/ast";
/**
 * Minimum number of meaningful words a docstring must contain after filler
 * removal. Below this the comment is too thin to document anything.
 */
export declare const MIN_DOC_WORDS = 4;
/**
 * Minimum number of meaningful words a docstring must contribute that the
 * identifier itself does not already carry. This is what rejects a comment that
 * merely restates the name.
 */
export declare const MIN_NOVEL_WORDS = 2;
/**
 * Number of source lines a non-exported function body must span before it joins
 * the documented surface. Short private helpers stay undocumented; substantial
 * ones must explain themselves.
 */
export declare const INTERNAL_BODY_LINES = 4;
/** A single documentation violation found in one source file. */
export interface DocstringViolation {
    /** Path of the file, relative to the scanned root. */
    readonly file: string;
    /** 1-based line of the declaration that failed. */
    readonly line: number;
    /** Symbol that failed, e.g. `parseFoo` or `Widget.render`. */
    readonly symbol: string;
    /** Actionable reason naming the rule that failed. */
    readonly reason: string;
}
/** Aggregate result of scanning one tree. */
export interface DocstringReport {
    /** Number of authored TypeScript files (`.ts`, `.tsx`, `.mts`, `.cts`) analyzed. */
    readonly files_scanned: number;
    /** Number of declarations evaluated against the rules. */
    readonly declarations_checked: number;
    /** Every violation, in source order. */
    readonly violations: readonly DocstringViolation[];
}
/**
 * Result of analyzing a single source text via {@link analyzeSource}: the
 * violations it produced and how many declarations were evaluated.
 */
export interface SourceAnalysis {
    /** Violations found in this source. */
    readonly violations: readonly DocstringViolation[];
    /** Declarations evaluated against the rules. */
    readonly declarations: number;
}
/** A scanned token with the offsets needed for JSDoc recovery and line numbers. */
export interface Token {
    /** Token kind (a `SyntaxKind` numeric value). */
    readonly kind: SyntaxKind;
    /** Offset where the token text starts (after preceding trivia). */
    readonly start: number;
    /** Offset where the token's leading trivia starts. */
    readonly fullStart: number;
    /** The token's literal text. */
    readonly text: string;
}
/**
 * Convert a token stream into a clean array of braces. Runs the unstable
 * scanner with trivia skipped and applies the two corrections documented at the
 * top of this file: template-substitution `}` is rescanned into a template
 * continuation, and `/` is rescanned as a regex only in regex context. TSX
 * uses the scanner's JSX variant so `</tag>` is one closing-tag token rather
 * than a slash that could consume later declarations as a regex. The
 * returned array never contains a brace that does not correspond to a real
 * `{` / `}` in the source.
 */
export declare function tokenize(text: string, file: string): Token[];
/**
 * Analyze one already-read TypeScript source text and report the docstring
 * violations it contains plus how many declarations were evaluated.
 */
export declare function analyzeSource(text: string, file: string): SourceAnalysis;
/**
 * Walk a directory tree and analyze every authored TypeScript source (`.ts`,
 * `.tsx`, `.mts`, or `.cts`) beneath it, skipping the `.d.ts` / `.d.mts` /
 * `.d.cts` ambient-declaration files and the structural non-source directories.
 * Scanning zero files fails by throwing rather than passing vacuously.
 */
export declare function analyzeDocstringCoverage(options: {
    root: string;
    sourceDirs?: readonly string[];
}): DocstringReport;
//# sourceMappingURL=docstrings.d.ts.map
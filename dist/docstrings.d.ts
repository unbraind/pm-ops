/**
 * @file Lexer-backed docstring coverage analyzer.
 *
 * The fleet mandate requires every source declaration to carry a real
 * docstring, enforced by a gate that cannot be cheated. A naive implementation
 * is worse than none: a green check that proves nothing is active cover for
 * missing documentation. This module is the replacement for a prior regex-based
 * attempt, rebuilt on the one source of truth that distinguishes real syntax
 * from text that merely looks syntactic: the TypeScript token stream.
 *
 * ## Why a lexer, not a regex or the compiler
 *
 * TypeScript 7 removed the stable compiler API (`createSourceFile`,
 * `forEachChild`, …), so there is no AST to walk: `import ts from "typescript"`
 * yields only `{ version }` at run time. What the `typescript/unstable/ast`
 * surface still exposes is the lexer — `createScanner` — which emits exactly
 * the punctuation and keywords that exist in the file. A brace inside a string,
 * template literal, regex, or comment is never a `OpenBraceToken`; a declaration
 * written inside a comment produces no tokens at all. That is precisely the
 * property a brace-counting regex lacks, and it is what makes the rules below
 * trustworthy.
 *
 * The scanner needs two corrections the unstable surface does not apply
 * automatically, both handled in {@link tokenize}:
 *
 * 1. A template substitution `${ … }` emits a `CloseBraceToken` for the `}`
 *    without a matching `OpenBraceToken` (the `${` is folded into the
 *    `TemplateHead`). Plain brace counting is corrupted by it, exactly as the
 *    regex version was corrupted by braces in strings. The fix is to track a
 *    frame stack and, only when a `}` closes a substitution frame, call
 *    `reScanTemplateToken` so it becomes a `TemplateMiddle` / `TemplateTail`
 *    and never reaches the brace counter.
 *
 * 2. The scanner does not decide regex versus division on its own: a `/` is
 *    always a `SlashToken`, and `reScanSlashToken` scans a regex
 *    unconditionally — which swallows a division operator and everything after
 *    it as one unterminated regular expression. The fix is to rescan `/` as a
 *    regex only when the previous significant token cannot end an expression,
 *    matching the heuristic every JavaScript lexer uses.
 *
 * After that, the token array contains only real, balanced braces, and group
 * matching over it is exact.
 *
 * ## Docstring recovery
 *
 * `getLeadingCommentRanges(text, tokenFullStart)` returns only the comments in
 * the contiguous trivia immediately preceding a token, so a JSDoc block that
 * lives inside a string literal, a template, or a commented-out line is
 * invisible to it — the four classic cheats. JSDoc is a block comment (`kind`
 * `3`) beginning with `/**`; a `//` line comment is `kind` `2` and does not
 * count.
 *
 * ## Rules
 *
 * The documented surface — every symbol {@link judge} evaluates — is:
 *
 * - every exported declaration (`function`, `class`, `interface`, `type`,
 *   `const` / `let` / `var`, including `export default function|class`);
 * - every non-`private`, non-`protected`, non-`#` member of an exported class
 *   (methods, properties, and `get` / `set` accessors);
 * - every non-exported `function` whose body spans more than
 *   {@link INTERNAL_BODY_LINES} lines, implemented (unlike the prior attempt's
 *   declared-but-never-read constant).
 *
 * A passing docstring must carry at least {@link MIN_DOC_WORDS} meaningful words
 * after filler removal and contribute at least {@link MIN_NOVEL_WORDS} terms the
 * identifier did not already carry, so a `Gets the name.` JSDoc on `getName`
 * fails.
 *
 * ## Fail-closed
 *
 * A declaration keyword the finder cannot classify is a violation with reason
 * `unrecognized declaration form`, never a silent skip. The silent skip is the
 * cheat this gate exists to prevent.
 *
 * ## Out of scope (structural, not configurable)
 *
 * `.d.ts` ambient declarations, `test/`, `dist/`, and `node_modules` are skipped
 * by hard-coded directory rules; imports and re-export statements (`export { … }
 * from`, `export * from`) declare nothing; `export default <expression>`,
 * overload signatures, constructors, index signatures, computed-name members,
 * `private` / `protected` / `#` members, and anonymous function/arrow
 * expressions carry no stable identifier and are therefore not in the documented
 * surface. There is deliberately no ignore list: an exemption must be a
 * documented rule with a reason, not a configuration entry.
 */
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
    /** Number of `.ts` files analyzed. */
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
/**
 * Analyze one already-read TypeScript source text and report the docstring
 * violations it contains plus how many declarations were evaluated.
 */
export declare function analyzeSource(text: string, file: string): SourceAnalysis;
/**
 * Walk a directory tree and analyze every authored `.ts` source beneath it,
 * skipping `.d.ts` files and the structural non-source directories. Scanning
 * zero files fails by throwing rather than passing vacuously.
 */
export declare function analyzeDocstringCoverage(options: {
    root: string;
    sourceDirs?: readonly string[];
}): DocstringReport;
//# sourceMappingURL=docstrings.d.ts.map
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
import { createScanner, getLeadingCommentRanges } from "typescript/unstable/ast/scanner";
import { SyntaxKind, LanguageVariant } from "typescript/unstable/ast";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
/**
 * Minimum number of meaningful words a docstring must contain after filler
 * removal. Below this the comment is too thin to document anything.
 */
export const MIN_DOC_WORDS = 4;
/**
 * Minimum number of meaningful words a docstring must contribute that the
 * identifier itself does not already carry. This is what rejects a comment that
 * merely restates the name.
 */
export const MIN_NOVEL_WORDS = 2;
/**
 * Number of source lines a non-exported function body must span before it joins
 * the documented surface. Short private helpers stay undocumented; substantial
 * ones must explain themselves.
 */
export const INTERNAL_BODY_LINES = 4;
/**
 * Filler words stripped before a docstring or identifier is reduced to its
 * content terms. These carry no domain meaning, so counting them would let a
 * restating comment pass the word-count rule.
 */
const FILLER = new Set([
    "a", "an", "the", "of", "for", "to", "from", "in", "on", "at", "by", "with",
    "and", "or", "is", "are", "was", "be", "been", "this", "that", "these", "those",
    "it", "its", "as", "get", "gets", "set", "sets", "return", "returns", "returned",
    "value", "values", "given", "used", "use", "uses", "when", "if", "then", "into",
    "via", "per", "not", "may", "can", "will", "has", "have", "had", "does", "do",
    "making", "make", "called", "call", "calls",
    "whether", "while", "which", "what", "where", "how", "why",
    "both", "each", "all", "any", "some", "no", "nor", "none", "either", "neither",
    "also", "always", "never", "often", "usually", "typically", "generally",
    "respectively", "eg", "ie",
]);
/**
 * Directory entries never descended into while collecting source files. Each is
 * a structural exclusion with a reason, not a configurable ignore list:
 *
 * - `node_modules` / `dist` / `dist-test` / `coverage` are installed or built
 *   output, not authored source;
 * - `test` holds the gate's own fixtures, which intentionally lack docstrings;
 * - `.git` is version-control metadata.
 */
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-test", "coverage", "test", ".git"]);
/**
 * Tokens after which a `/` is a regex rather than division, per the heuristic
 * every JavaScript lexer applies: a `/` is division only when the previous
 * significant token can end an expression. Everything else (operators, `=`, `,`,
 * `(`, `[`, `{`, `;`, `:`, `?`, `return`, `typeof`, …) starts a new expression
 * and so begins a regex.
 */
const DIVISION_PREVIOUS = new Set([
    SyntaxKind.Identifier,
    SyntaxKind.NumericLiteral,
    SyntaxKind.StringLiteral,
    SyntaxKind.NoSubstitutionTemplateLiteral,
    SyntaxKind.TemplateTail,
    SyntaxKind.RegularExpressionLiteral,
    SyntaxKind.BigIntLiteral,
    SyntaxKind.TrueKeyword,
    SyntaxKind.FalseKeyword,
    SyntaxKind.NullKeyword,
    SyntaxKind.ThisKeyword,
    SyntaxKind.SuperKeyword,
    SyntaxKind.CloseParenToken,
    SyntaxKind.CloseBracketToken,
]);
/** Tokens that can begin a class member after automatic semicolon insertion. */
const MEMBER_STARTS = new Set([
    SyntaxKind.Identifier,
    SyntaxKind.PrivateIdentifier,
    SyntaxKind.StringLiteral,
    SyntaxKind.NumericLiteral,
    SyntaxKind.AtToken,
    SyntaxKind.OpenBracketToken,
    SyntaxKind.AsteriskToken,
    SyntaxKind.PublicKeyword,
    SyntaxKind.PrivateKeyword,
    SyntaxKind.ProtectedKeyword,
    SyntaxKind.StaticKeyword,
    SyntaxKind.ReadonlyKeyword,
    SyntaxKind.AbstractKeyword,
    SyntaxKind.OverrideKeyword,
    SyntaxKind.DeclareKeyword,
    SyntaxKind.AsyncKeyword,
    SyntaxKind.GetKeyword,
    SyntaxKind.SetKeyword,
    SyntaxKind.ConstructorKeyword,
]);
/**
 * Tokens after which a fresh primary type may begin, so a following `{` is an
 * object/type literal rather than a function body. Used by the return-type
 * skipper to find where a function body actually starts.
 */
const TYPE_CONTINUES = new Set([
    SyntaxKind.ColonToken,
    SyntaxKind.BarToken,
    SyntaxKind.AmpersandToken,
    SyntaxKind.EqualsGreaterThanToken,
    SyntaxKind.CommaToken,
    SyntaxKind.QuestionToken,
    SyntaxKind.DotToken,
    SyntaxKind.ExtendsKeyword,
    SyntaxKind.InKeyword,
    SyntaxKind.KeyOfKeyword,
    SyntaxKind.TypeOfKeyword,
    SyntaxKind.InferKeyword,
    SyntaxKind.ReadonlyKeyword,
    SyntaxKind.NewKeyword,
    SyntaxKind.AsKeyword,
    SyntaxKind.SatisfiesKeyword,
    SyntaxKind.IsKeyword,
]);
/** Sentinel returned when the cursor runs past the last token, so every loop can test for end of input uniformly. */
const EOF_TOKEN = { kind: SyntaxKind.EndOfFile, start: Number.MAX_SAFE_INTEGER, fullStart: Number.MAX_SAFE_INTEGER, text: "" };
/** `true` for a `SyntaxKind` in the keyword range (used for member-name checks). */
function isKeyword(kind) {
    return kind >= SyntaxKind.FirstKeyword && kind <= SyntaxKind.LastKeyword;
}
/**
 * Convert a token stream into a clean array of braces. Runs the unstable
 * scanner with trivia skipped and applies the two corrections documented at the
 * top of this file: template-substitution `}` is rescanned into a template
 * continuation, and `/` is rescanned as a regex only in regex context. The
 * returned array never contains a brace that does not correspond to a real
 * `{` / `}` in the source.
 */
function tokenize(text) {
    const scanner = createScanner(true, LanguageVariant.Standard, text);
    const tokens = [];
    const group = [];
    let prev;
    for (;;) {
        let kind = scanner.scan();
        if (kind === SyntaxKind.EndOfFile)
            break;
        if (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) {
            if (prev === undefined || !DIVISION_PREVIOUS.has(prev)) {
                kind = scanner.reScanSlashToken();
            }
        }
        if (kind === SyntaxKind.TemplateHead || kind === SyntaxKind.TemplateMiddle) {
            group.push("sub");
        }
        else if (kind === SyntaxKind.OpenBraceToken) {
            group.push("brace");
        }
        else if (kind === SyntaxKind.OpenParenToken) {
            group.push("paren");
        }
        else if (kind === SyntaxKind.OpenBracketToken) {
            group.push("bracket");
        }
        else if (kind === SyntaxKind.CloseBraceToken) {
            const top = group[group.length - 1];
            if (top === "sub") {
                kind = scanner.reScanTemplateToken(false);
                group.pop();
                if (kind === SyntaxKind.TemplateMiddle)
                    group.push("sub");
            }
            else if (top === "brace") {
                group.pop();
            }
        }
        else if (kind === SyntaxKind.CloseParenToken) {
            if (group[group.length - 1] === "paren")
                group.pop();
        }
        else if (kind === SyntaxKind.CloseBracketToken) {
            if (group[group.length - 1] === "bracket")
                group.pop();
        }
        tokens.push({ kind, start: scanner.getTokenStart(), fullStart: scanner.getTokenFullStart(), text: scanner.getTokenText() });
        prev = kind;
    }
    return tokens;
}
/**
 * Build a direct offset-to-1-based-line map so any token offset resolves to its
 * line in O(1) without re-scanning the text per lookup.
 */
function buildLineMap(text) {
    const lines = new Uint32Array(text.length + 1);
    let line = 1;
    for (let i = 0; i < text.length; i++) {
        lines[i] = line;
        if (text.charCodeAt(i) === 10)
            line++;
    }
    lines[text.length] = line;
    return lines;
}
/**
 * Reduce a comment or identifier to its lowercased, content-bearing words by
 * splitting camelCase and identifier boundaries and dropping short tokens and
 * {@link FILLER}.
 */
function toWords(text) {
    return text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/[^A-Za-z0-9]+/)
        .map((word) => word.toLowerCase())
        .filter((word) => word.length > 1 && !FILLER.has(word));
}
/**
 * Strip the `/** … *\/` delimiters and per-line leading asterisks from a raw
 * comment range, then drop fenced code blocks and `@tag` markers so the
 * remaining text is the prose a docstring is judged on.
 */
function cleanComment(raw) {
    const body = raw.replace(/^\/\*\*?/, "").replace(/\*\/$/, "");
    const stripped = body.split("\n").map((line) => line.replace(/^\s*\* ?/, "").trim());
    let text = stripped.join("\n");
    text = text.replace(/```[^`]*?```/g, " ");
    text = text.replace(/@[A-Za-z][A-Za-z0-9_-]*/g, " ");
    return text.replace(/\s+/g, " ").trim();
}
/**
 * Recursively collect every authored `.ts` file (excluding `.d.ts`) beneath the
 * given roots, skipping the structural non-source directories in
 * {@link SKIP_DIRS}. A root may itself be a single file.
 */
function collectSourceFiles(roots) {
    const out = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch (error) {
            throw new Error(`docstring coverage: cannot read directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
        }
        for (const name of entries) {
            const full = join(dir, name);
            let info;
            try {
                info = statSync(full);
            }
            catch (error) {
                throw new Error(`docstring coverage: cannot stat ${full}: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (info.isDirectory()) {
                if (!SKIP_DIRS.has(name))
                    walk(full);
            }
            else if (info.isFile() && name.endsWith(".ts") && !name.endsWith(".d.ts")) {
                out.push(full);
            }
        }
    };
    for (const root of roots) {
        let info;
        try {
            info = statSync(root);
        }
        catch (error) {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
                continue;
            throw new Error(`docstring coverage: cannot stat root ${root}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (info.isDirectory()) {
            walk(root);
        }
        else if (info.isFile() && root.endsWith(".ts") && !root.endsWith(".d.ts")) {
            out.push(root);
        }
    }
    return out;
}
/**
 * Recursive-descent declaration finder over a clean token array. Non-exported by
 * design: its members are implementation detail, not documented surface, and
 * the public entry points {@link analyzeSource} / {@link analyzeDocstringCoverage}
 * are what callers (and the gate) depend on.
 */
class SourceAnalyzer {
    violations = [];
    declarationsChecked = 0;
    i = 0;
    text;
    file;
    tokens;
    lineOf;
    constructor(text, file, tokens, lineOf) {
        this.text = text;
        this.file = file;
        this.tokens = tokens;
        this.lineOf = lineOf;
    }
    /** Parse the whole source as a module body. */
    run() {
        this.parseStatements();
    }
    cur() {
        return this.tokens[this.i] ?? EOF_TOKEN;
    }
    peekKind(n) {
        return this.tokens[this.i + n]?.kind;
    }
    at(kind) {
        return this.cur().kind === kind;
    }
    /** Index of the closer matching the opener at `openIdx`, balancing over the clean array. */
    matchingClose(openIdx) {
        let depth = 0;
        for (let j = openIdx; j < this.tokens.length; j++) {
            const k = this.tokens[j].kind;
            if (k === SyntaxKind.OpenBraceToken || k === SyntaxKind.OpenParenToken || k === SyntaxKind.OpenBracketToken) {
                depth++;
            }
            else if (k === SyntaxKind.CloseBraceToken || k === SyntaxKind.CloseParenToken || k === SyntaxKind.CloseBracketToken) {
                depth--;
                if (depth === 0)
                    return j;
            }
        }
        return this.tokens.length - 1;
    }
    /** Advance past the balanced group whose opener is the current token. */
    skipGroup() {
        this.i = this.matchingClose(this.i) + 1;
    }
    /** Parse statements inside the brace block opened at `openIdx`, then consume its closer. */
    descendBlock(openIdx) {
        this.i = openIdx + 1;
        this.parseStatements();
        if (this.i < this.tokens.length && this.at(SyntaxKind.CloseBraceToken))
            this.i++;
    }
    /** Parse statements until a closing brace or end of input. */
    parseStatements() {
        while (this.i < this.tokens.length) {
            const k = this.cur().kind;
            if (k === SyntaxKind.CloseBraceToken || k === SyntaxKind.EndOfFile)
                return;
            this.parseStatement();
        }
    }
    /** Parse one statement in any statement context (module, block, body). */
    parseStatement() {
        const head = this.cur();
        const k = head.kind;
        switch (k) {
            case SyntaxKind.ExportKeyword:
                this.parseExport();
                return;
            case SyntaxKind.ImportKeyword:
                this.skipUntilSemicolon();
                return;
            case SyntaxKind.FunctionKeyword:
                this.parseFunction({ exported: false, head });
                return;
            case SyntaxKind.ClassKeyword:
                this.parseClass({ exported: false, head });
                return;
            case SyntaxKind.AsyncKeyword:
                if (this.peekKind(1) === SyntaxKind.FunctionKeyword) {
                    this.i++;
                    this.parseFunction({ exported: false, head });
                }
                else {
                    this.skipExpressionStatement();
                }
                return;
            case SyntaxKind.AbstractKeyword:
                if (this.peekKind(1) === SyntaxKind.ClassKeyword) {
                    this.i++;
                    this.parseClass({ exported: false, head });
                }
                else {
                    this.skipExpressionStatement();
                }
                return;
            case SyntaxKind.DeclareKeyword:
                this.skipUntilSemicolon();
                return;
            case SyntaxKind.InterfaceKeyword:
                this.skipNonExportedInterface();
                return;
            case SyntaxKind.TypeKeyword:
                this.skipNonExportedTypeAlias();
                return;
            case SyntaxKind.ConstKeyword:
            case SyntaxKind.LetKeyword:
            case SyntaxKind.VarKeyword:
                this.i++;
                this.skipExpressionStatement();
                return;
            case SyntaxKind.EnumKeyword:
            case SyntaxKind.NamespaceKeyword:
                this.failClosed(head, "unrecognized declaration form");
                this.skipUntilSemicolon();
                return;
            case SyntaxKind.OpenBraceToken:
                this.descendBlock(this.i);
                return;
            case SyntaxKind.SemicolonToken:
                this.i++;
                return;
            case SyntaxKind.AtToken:
                this.skipDecorators();
                this.parseStatement();
                return;
            case SyntaxKind.IfKeyword:
                this.parseIf();
                return;
            case SyntaxKind.ForKeyword:
                this.parseFor();
                return;
            case SyntaxKind.WhileKeyword:
                this.i++;
                this.skipHeaderParen();
                this.parseBlockOrStatement();
                return;
            case SyntaxKind.DoKeyword:
                this.parseDoWhile();
                return;
            case SyntaxKind.SwitchKeyword:
                this.i++;
                this.skipHeaderParen();
                if (this.at(SyntaxKind.OpenBraceToken))
                    this.descendBlock(this.i);
                return;
            case SyntaxKind.TryKeyword:
                this.parseTry();
                return;
            case SyntaxKind.CaseKeyword:
                this.i++;
                this.skipUntilColon();
                return;
            case SyntaxKind.DefaultKeyword:
                this.i++;
                if (this.at(SyntaxKind.ColonToken))
                    this.i++;
                return;
            case SyntaxKind.ReturnKeyword:
            case SyntaxKind.ThrowKeyword:
            case SyntaxKind.BreakKeyword:
            case SyntaxKind.ContinueKeyword:
                this.skipExpressionStatement();
                return;
            default:
                if (k === SyntaxKind.Identifier && this.peekKind(1) === SyntaxKind.ColonToken) {
                    this.i += 2;
                    this.parseStatement();
                    return;
                }
                this.skipExpressionStatement();
                return;
        }
    }
    /** Parse an `export` form, classifying the declaration or skipping a re-export. */
    parseExport() {
        const exportToken = this.cur();
        this.i++; // export
        if (this.at(SyntaxKind.DefaultKeyword)) {
            this.i++; // default
            if (this.at(SyntaxKind.AsyncKeyword) && this.peekKind(1) === SyntaxKind.FunctionKeyword) {
                this.i++;
                this.parseFunction({ exported: true, defaultExport: true, head: exportToken });
                return;
            }
            if (this.at(SyntaxKind.FunctionKeyword)) {
                this.parseFunction({ exported: true, defaultExport: true, head: exportToken });
                return;
            }
            if (this.at(SyntaxKind.AbstractKeyword) && this.peekKind(1) === SyntaxKind.ClassKeyword) {
                this.i++;
                this.parseClass({ exported: true, defaultExport: true, head: exportToken });
                return;
            }
            if (this.at(SyntaxKind.ClassKeyword)) {
                this.parseClass({ exported: true, defaultExport: true, head: exportToken });
                return;
            }
            // export default <expression> declares nothing; skip it.
            this.skipExpressionStatement();
            return;
        }
        if (this.at(SyntaxKind.OpenBraceToken)) {
            this.skipGroup();
            this.skipUntilSemicolon();
            return;
        }
        if (this.at(SyntaxKind.AsteriskToken)) {
            this.skipUntilSemicolon();
            return;
        }
        if (this.at(SyntaxKind.TypeKeyword) && this.peekKind(1) === SyntaxKind.OpenBraceToken) {
            this.i++;
            this.skipGroup();
            this.skipUntilSemicolon();
            return;
        }
        if (this.at(SyntaxKind.TypeKeyword)) {
            this.i++;
            this.parseTypeLike({ exported: true, head: exportToken });
            return;
        }
        if (this.at(SyntaxKind.AsyncKeyword) && this.peekKind(1) === SyntaxKind.FunctionKeyword) {
            this.i++;
            this.parseFunction({ exported: true, head: exportToken });
            return;
        }
        if (this.at(SyntaxKind.FunctionKeyword)) {
            this.parseFunction({ exported: true, head: exportToken });
            return;
        }
        if (this.at(SyntaxKind.AbstractKeyword) && this.peekKind(1) === SyntaxKind.ClassKeyword) {
            this.i++;
            this.parseClass({ exported: true, head: exportToken });
            return;
        }
        if (this.at(SyntaxKind.ClassKeyword)) {
            this.parseClass({ exported: true, head: exportToken });
            return;
        }
        if (this.at(SyntaxKind.InterfaceKeyword)) {
            this.i++;
            this.parseTypeLike({ exported: true, head: exportToken });
            return;
        }
        if (this.at(SyntaxKind.ConstKeyword) || this.at(SyntaxKind.LetKeyword) || this.at(SyntaxKind.VarKeyword)) {
            this.i++;
            this.parseExportedVar({ head: exportToken });
            return;
        }
        this.failClosed(this.cur(), "unrecognized declaration form");
        this.skipUntilSemicolon();
    }
    /** Parse a `function` declaration or expression at the current token. */
    parseFunction(opts) {
        this.i++; // function
        if (this.at(SyntaxKind.AsteriskToken))
            this.i++; // generator
        let name;
        if (this.at(SyntaxKind.Identifier)) {
            name = this.cur().text;
            this.i++;
        }
        if (this.at(SyntaxKind.LessThanToken))
            this.skipTypeParams();
        if (this.at(SyntaxKind.OpenParenToken))
            this.skipGroup();
        const body = this.findFunctionBody();
        if (body.kind === "body") {
            const open = this.tokens[body.openIdx];
            const closeIdx = this.matchingClose(body.openIdx);
            const bodyLines = this.lineOf[this.tokens[closeIdx].start] - this.lineOf[open.start];
            if (opts.exported || bodyLines > INTERNAL_BODY_LINES) {
                this.judge(opts.head, name ?? (opts.defaultExport ? "default" : "(anonymous)"));
            }
            this.descendBlock(body.openIdx);
        }
        // A signature with no body is an overload or ambient declaration: out of scope.
    }
    /** Parse a `class` declaration or expression at the current token. */
    parseClass(opts) {
        this.i++; // class
        let name;
        if (this.at(SyntaxKind.Identifier)) {
            name = this.cur().text;
            this.i++;
        }
        if (this.at(SyntaxKind.LessThanToken))
            this.skipTypeParams();
        const bodyIdx = this.findClassBody();
        if (opts.exported)
            this.judge(opts.head, name ?? "default");
        if (bodyIdx >= 0) {
            this.i = bodyIdx + 1;
            this.parseMembers(name ?? "default", opts.exported);
            if (this.at(SyntaxKind.CloseBraceToken))
                this.i++;
        }
        else if (this.at(SyntaxKind.SemicolonToken)) {
            this.i++;
        }
    }
    /** Parse members of a class body until its closing brace. */
    parseMembers(className, classExported) {
        while (this.i < this.tokens.length) {
            const k = this.cur().kind;
            if (k === SyntaxKind.CloseBraceToken || k === SyntaxKind.EndOfFile)
                return;
            this.parseMember(className, classExported);
        }
    }
    /** Parse one class member, enforcing the documented-surface rule when in scope. */
    parseMember(className, classExported) {
        const head = this.cur();
        while (this.at(SyntaxKind.AtToken))
            this.skipDecorator();
        let isPrivate = false;
        let accessor = "";
        for (;;) {
            const k = this.cur().kind;
            if (k === SyntaxKind.PrivateKeyword || k === SyntaxKind.ProtectedKeyword) {
                isPrivate = true;
                this.i++;
                continue;
            }
            if (k === SyntaxKind.PublicKeyword ||
                k === SyntaxKind.StaticKeyword ||
                k === SyntaxKind.ReadonlyKeyword ||
                k === SyntaxKind.AbstractKeyword ||
                k === SyntaxKind.OverrideKeyword ||
                k === SyntaxKind.DeclareKeyword ||
                k === SyntaxKind.AsyncKeyword) {
                this.i++;
                continue;
            }
            if ((k === SyntaxKind.GetKeyword || k === SyntaxKind.SetKeyword) && this.peekKind(1) === SyntaxKind.Identifier) {
                accessor = k === SyntaxKind.GetKeyword ? "get" : "set";
                this.i++;
                continue;
            }
            break;
        }
        const k = this.cur().kind;
        if (k === SyntaxKind.HashToken || k === SyntaxKind.PrivateIdentifier) {
            this.i++;
            if (this.at(SyntaxKind.OpenParenToken) || this.at(SyntaxKind.LessThanToken))
                this.skipCallable();
            else
                this.skipMemberRest();
            return;
        }
        if (k === SyntaxKind.SemicolonToken) {
            this.i++;
            return;
        }
        if (k === SyntaxKind.OpenBracketToken) {
            this.skipGroup();
            this.skipMemberRest();
            return;
        }
        if (k === SyntaxKind.OpenBraceToken) {
            this.descendBlock(this.i);
            return;
        }
        if (k === SyntaxKind.AsteriskToken)
            this.i++;
        const nameKind = this.cur().kind;
        if (nameKind === SyntaxKind.ConstructorKeyword) {
            this.i++;
            this.skipCallable();
            return;
        }
        if (nameKind === SyntaxKind.Identifier || isKeyword(nameKind)) {
            const name = this.cur().text;
            this.i++;
            const memberName = accessor ? `${accessor} ${name}` : name;
            const next = this.cur().kind;
            if (next === SyntaxKind.OpenParenToken || next === SyntaxKind.LessThanToken) {
                if (next === SyntaxKind.LessThanToken)
                    this.skipTypeParams();
                if (this.at(SyntaxKind.OpenParenToken))
                    this.skipGroup();
                const body = this.findFunctionBody();
                if (body.kind === "body") {
                    if (classExported && !isPrivate)
                        this.judge(head, `${className}.${memberName}`);
                    this.descendBlock(body.openIdx);
                }
            }
            else {
                if (classExported && !isPrivate)
                    this.judge(head, `${className}.${name}`);
                this.skipMemberRest();
            }
            return;
        }
        this.i++;
    }
    /** Skip a decorator (`@expr`) and any chained decorators. */
    skipDecorators() {
        while (this.at(SyntaxKind.AtToken))
            this.skipDecorator();
    }
    /** Skip one decorator: the `@` and the following dotted-name and optional call arguments. */
    skipDecorator() {
        this.i++; // @
        if (this.cur().kind === SyntaxKind.Identifier) {
            this.i++;
            while (this.at(SyntaxKind.DotToken)) {
                this.i++;
                if (this.cur().kind === SyntaxKind.Identifier || isKeyword(this.cur().kind))
                    this.i++;
            }
        }
        if (this.at(SyntaxKind.OpenParenToken))
            this.skipGroup();
    }
    /** Skip type parameters `<…>` starting at the current `<`. */
    skipTypeParams() {
        let depth = 0;
        while (this.i < this.tokens.length) {
            const k = this.cur().kind;
            if (k === SyntaxKind.LessThanToken) {
                depth++;
                this.i++;
                continue;
            }
            if (k === SyntaxKind.GreaterThanToken) {
                depth--;
                this.i++;
                if (depth <= 0)
                    return;
                continue;
            }
            if (k === SyntaxKind.GreaterThanGreaterThanToken) {
                depth -= 2;
                this.i++;
                if (depth <= 0)
                    return;
                continue;
            }
            if (k === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
                depth -= 3;
                this.i++;
                if (depth <= 0)
                    return;
                continue;
            }
            if (k === SyntaxKind.OpenBraceToken || k === SyntaxKind.OpenParenToken || k === SyntaxKind.OpenBracketToken || k === SyntaxKind.SemicolonToken)
                return;
            this.i++;
        }
    }
    /**
     * Starting just after a function's parameter list, skip the optional return
     * type and locate the body brace (or the `;` of an overload signature). A `{`
     * is the body only when the type so far is complete (no primary can follow),
     * so an object-literal return type `{ a: number }` is consumed as a type
     * rather than mistaken for the body.
     */
    findFunctionBody() {
        let depth = 0;
        let typeStart = false;
        while (this.i < this.tokens.length) {
            const k = this.cur().kind;
            if (k === SyntaxKind.OpenBraceToken && depth === 0 && !typeStart)
                return { kind: "body", openIdx: this.i };
            if (k === SyntaxKind.SemicolonToken && depth === 0) {
                this.i++;
                return { kind: "signature" };
            }
            if ((k === SyntaxKind.CloseBraceToken || k === SyntaxKind.EndOfFile) && depth === 0)
                return { kind: "none" };
            if (k === SyntaxKind.OpenBraceToken || k === SyntaxKind.OpenParenToken || k === SyntaxKind.OpenBracketToken || k === SyntaxKind.LessThanToken) {
                depth++;
                typeStart = false;
            }
            else if (k === SyntaxKind.CloseBraceToken || k === SyntaxKind.CloseParenToken || k === SyntaxKind.CloseBracketToken || k === SyntaxKind.GreaterThanToken) {
                depth = Math.max(0, depth - 1);
                typeStart = false;
            }
            else if (k === SyntaxKind.GreaterThanGreaterThanToken) {
                depth = Math.max(0, depth - 2);
                typeStart = false;
            }
            else if (k === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
                depth = Math.max(0, depth - 3);
                typeStart = false;
            }
            else if (TYPE_CONTINUES.has(k)) {
                typeStart = true;
            }
            else {
                typeStart = false;
            }
            this.i++;
        }
        return { kind: "none" };
    }
    /** Starting after a class name, skip type parameters and heritage to the body brace (or `-1`). */
    findClassBody() {
        let depth = 0;
        while (this.i < this.tokens.length) {
            const k = this.cur().kind;
            if (k === SyntaxKind.OpenBraceToken && depth === 0)
                return this.i;
            if (k === SyntaxKind.SemicolonToken && depth === 0) {
                this.i++;
                return -1;
            }
            if (k === SyntaxKind.EndOfFile)
                return -1;
            if (k === SyntaxKind.OpenBraceToken || k === SyntaxKind.OpenParenToken || k === SyntaxKind.OpenBracketToken || k === SyntaxKind.LessThanToken) {
                depth++;
            }
            else if (k === SyntaxKind.CloseBraceToken || k === SyntaxKind.CloseParenToken || k === SyntaxKind.CloseBracketToken || k === SyntaxKind.GreaterThanToken) {
                depth = Math.max(0, depth - 1);
            }
            else if (k === SyntaxKind.GreaterThanGreaterThanToken) {
                depth = Math.max(0, depth - 2);
            }
            else if (k === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
                depth = Math.max(0, depth - 3);
            }
            this.i++;
        }
        return -1;
    }
    /** Skip a non-exported `interface` (its body declares nothing in scope). */
    skipNonExportedInterface() {
        this.i++; // interface
        if (this.at(SyntaxKind.Identifier))
            this.i++;
        if (this.at(SyntaxKind.LessThanToken))
            this.skipTypeParams();
        const bodyIdx = this.findClassBody();
        if (bodyIdx >= 0)
            this.i = this.matchingClose(bodyIdx) + 1;
        if (this.at(SyntaxKind.SemicolonToken))
            this.i++;
    }
    /** Skip a non-exported `type` alias to its terminating `;`. */
    skipNonExportedTypeAlias() {
        this.i++; // type
        if (this.at(SyntaxKind.Identifier))
            this.i++;
        if (this.at(SyntaxKind.LessThanToken))
            this.skipTypeParams();
        this.skipUntilSemicolon();
    }
    /** Judge an exported `interface` or `type` alias, then skip its body. */
    parseTypeLike(opts) {
        if (opts.exported) {
            if (this.at(SyntaxKind.Identifier)) {
                this.judge(opts.head, this.cur().text);
            }
            else {
                this.judge(opts.head, "(anonymous)");
            }
        }
        if (this.at(SyntaxKind.Identifier))
            this.i++;
        if (this.at(SyntaxKind.LessThanToken))
            this.skipTypeParams();
        this.skipUntilSemicolon();
    }
    /** Judge every binding in an exported `const` / `let` / `var` declaration. */
    parseExportedVar(opts) {
        for (;;) {
            if (this.at(SyntaxKind.Identifier)) {
                this.judge(opts.head, this.cur().text);
                this.i++;
            }
            else if (this.at(SyntaxKind.OpenBraceToken) || this.at(SyntaxKind.OpenBracketToken)) {
                const openIdx = this.i;
                const closeIdx = this.matchingClose(openIdx);
                const open = this.tokens[openIdx];
                const close = this.tokens[closeIdx];
                this.judge(opts.head, this.text.slice(open.start, close.start + close.text.length).replace(/\s+/g, " "));
                this.i = closeIdx + 1;
            }
            else {
                this.failClosed(this.cur(), "unrecognized declaration form");
                this.skipExpressionStatement();
                return;
            }
            let hasInitializer = false;
            while (this.i < this.tokens.length) {
                const k = this.cur().kind;
                if (k === SyntaxKind.SemicolonToken) {
                    this.i++;
                    return;
                }
                if (k === SyntaxKind.CloseBraceToken || k === SyntaxKind.EndOfFile)
                    return;
                if (k === SyntaxKind.CommaToken) {
                    this.i++;
                    break;
                }
                if (k === SyntaxKind.EqualsToken) {
                    hasInitializer = true;
                    this.i++;
                    continue;
                }
                if (!hasInitializer && k === SyntaxKind.LessThanToken) {
                    this.skipTypeParams();
                    continue;
                }
                if (k === SyntaxKind.OpenBraceToken || k === SyntaxKind.OpenParenToken || k === SyntaxKind.OpenBracketToken) {
                    this.skipGroup();
                    continue;
                }
                this.i++;
            }
        }
    }
    /** Skip a callable's optional type parameters, parameter list, and body. */
    skipCallable() {
        if (this.at(SyntaxKind.LessThanToken))
            this.skipTypeParams();
        if (this.at(SyntaxKind.OpenParenToken))
            this.skipGroup();
        const body = this.findFunctionBody();
        if (body.kind === "body")
            this.descendBlock(body.openIdx);
    }
    /** Skip a member's trailing type or initializer to its terminating `;`. */
    skipMemberRest() {
        while (this.i < this.tokens.length) {
            const k = this.cur().kind;
            if (k === SyntaxKind.SemicolonToken) {
                this.i++;
                return;
            }
            if (k === SyntaxKind.CloseBraceToken || k === SyntaxKind.EndOfFile)
                return;
            const previous = this.tokens[this.i - 1];
            if (previous &&
                this.lineOf[this.cur().start] > this.lineOf[previous.start] &&
                DIVISION_PREVIOUS.has(previous.kind) &&
                MEMBER_STARTS.has(k)) {
                return;
            }
            if (k === SyntaxKind.OpenBraceToken || k === SyntaxKind.OpenParenToken || k === SyntaxKind.OpenBracketToken) {
                this.skipGroup();
                continue;
            }
            this.i++;
        }
    }
    /** Skip tokens to the next `;` at group-depth zero, balancing nested groups. */
    skipUntilSemicolon() {
        while (this.i < this.tokens.length) {
            const k = this.cur().kind;
            if (k === SyntaxKind.SemicolonToken) {
                this.i++;
                return;
            }
            if (k === SyntaxKind.CloseBraceToken || k === SyntaxKind.EndOfFile)
                return;
            if (k === SyntaxKind.OpenBraceToken || k === SyntaxKind.OpenParenToken || k === SyntaxKind.OpenBracketToken) {
                this.skipGroup();
                continue;
            }
            this.i++;
        }
    }
    /** Skip tokens to the next `:` at group-depth zero (a `case` label). */
    skipUntilColon() {
        while (this.i < this.tokens.length) {
            const k = this.cur().kind;
            if (k === SyntaxKind.ColonToken) {
                this.i++;
                return;
            }
            if (k === SyntaxKind.CloseBraceToken || k === SyntaxKind.EndOfFile)
                return;
            if (k === SyntaxKind.OpenBraceToken || k === SyntaxKind.OpenParenToken || k === SyntaxKind.OpenBracketToken) {
                this.skipGroup();
                continue;
            }
            this.i++;
        }
    }
    /** Skip a control-flow header's `(...)` when present. */
    skipHeaderParen() {
        if (this.at(SyntaxKind.OpenParenToken))
            this.skipGroup();
    }
    /** Parse an `if (…) body else body`. */
    parseIf() {
        this.i++;
        this.skipHeaderParen();
        this.parseBlockOrStatement();
        if (this.at(SyntaxKind.ElseKeyword)) {
            this.i++;
            this.parseBlockOrStatement();
        }
    }
    /** Parse a `for (…) body` (and `for await`). */
    parseFor() {
        this.i++;
        if (this.at(SyntaxKind.AwaitKeyword))
            this.i++;
        this.skipHeaderParen();
        this.parseBlockOrStatement();
    }
    /** Parse a `do body while (…);`. */
    parseDoWhile() {
        this.i++;
        this.parseBlockOrStatement();
        if (this.at(SyntaxKind.WhileKeyword)) {
            this.i++;
            this.skipHeaderParen();
            if (this.at(SyntaxKind.SemicolonToken))
                this.i++;
        }
    }
    /** Parse a `try { } catch (…) { } finally { }`. */
    parseTry() {
        this.i++;
        if (this.at(SyntaxKind.OpenBraceToken))
            this.descendBlock(this.i);
        if (this.at(SyntaxKind.CatchKeyword)) {
            this.i++;
            if (this.at(SyntaxKind.OpenParenToken))
                this.skipGroup();
            if (this.at(SyntaxKind.OpenBraceToken))
                this.descendBlock(this.i);
        }
        if (this.at(SyntaxKind.FinallyKeyword)) {
            this.i++;
            if (this.at(SyntaxKind.OpenBraceToken))
                this.descendBlock(this.i);
        }
    }
    /** Parse a statement body that is either a brace block or a single statement. */
    parseBlockOrStatement() {
        if (this.at(SyntaxKind.OpenBraceToken))
            this.descendBlock(this.i);
        else
            this.parseStatement();
    }
    /**
     * Skip an expression statement to its terminating `;` (or a block/EOF under
     * ASI), descending into arrow/function brace bodies so nested declarations
     * are still found, and skipping object literals and other groups opaquely.
     */
    skipExpressionStatement() {
        while (this.i < this.tokens.length) {
            const k = this.cur().kind;
            if (k === SyntaxKind.SemicolonToken) {
                this.i++;
                return;
            }
            if (k === SyntaxKind.CloseBraceToken || k === SyntaxKind.EndOfFile)
                return;
            if (k === SyntaxKind.OpenBraceToken) {
                const prev = this.tokens[this.i - 1]?.kind;
                if (prev === SyntaxKind.CloseParenToken || prev === SyntaxKind.EqualsGreaterThanToken) {
                    this.descendBlock(this.i);
                }
                else {
                    this.skipGroup();
                }
                continue;
            }
            if (k === SyntaxKind.OpenParenToken || k === SyntaxKind.OpenBracketToken) {
                this.skipGroup();
                continue;
            }
            this.i++;
        }
    }
    /** Record a fail-closed violation for a declaration the finder cannot classify. */
    failClosed(token, reason) {
        this.declarationsChecked++;
        this.violations.push({ file: this.file, line: this.lineOf[token.start], symbol: token.text, reason });
    }
    /**
     * Evaluate one documented-surface declaration: recover its leading JSDoc and
     * check it has enough meaningful, non-restating words, recording a violation
     * with a specific reason otherwise.
     */
    judge(head, symbol) {
        this.declarationsChecked++;
        const doc = this.extractJsdoc(head);
        const line = this.lineOf[head.start];
        if (!doc) {
            this.violations.push({ file: this.file, line, symbol, reason: "no docstring" });
            return;
        }
        const words = toWords(doc);
        if (words.length < MIN_DOC_WORDS) {
            this.violations.push({ file: this.file, line, symbol, reason: `docstring has fewer than ${MIN_DOC_WORDS} meaningful words (got ${words.length})` });
            return;
        }
        const nameWords = new Set(toWords(symbol));
        const novel = words.filter((word) => !nameWords.has(word));
        if (novel.length < MIN_NOVEL_WORDS) {
            this.violations.push({ file: this.file, line, symbol, reason: `docstring restates the identifier (needs ${MIN_NOVEL_WORDS}+ terms not in the name)` });
        }
    }
    /**
     * Recover the JSDoc text immediately preceding a token, or `""` when none.
     * Only a block comment (`kind` {@link SyntaxKind.MultiLineCommentTrivia}) beginning with `/**` counts; a `//` line
     * comment, or no comment at all, yields `""`.
     */
    extractJsdoc(head) {
        const ranges = getLeadingCommentRanges(this.text, head.fullStart);
        if (!ranges || ranges.length === 0)
            return "";
        let best = -1;
        for (let index = 0; index < ranges.length; index++) {
            const range = ranges[index];
            if (range.kind === SyntaxKind.MultiLineCommentTrivia &&
                this.text.charCodeAt(range.pos) === 0x2f &&
                this.text.charCodeAt(range.pos + 1) === 0x2a &&
                this.text.charCodeAt(range.pos + 2) === 0x2a) {
                best = index;
            }
        }
        if (best < 0)
            return "";
        const range = ranges[best];
        return cleanComment(this.text.slice(range.pos, range.end));
    }
}
/**
 * Analyze one already-read TypeScript source text and report the docstring
 * violations it contains plus how many declarations were evaluated.
 */
export function analyzeSource(text, file) {
    const tokens = tokenize(text);
    const analyzer = new SourceAnalyzer(text, file, tokens, buildLineMap(text));
    analyzer.run();
    return { violations: analyzer.violations, declarations: analyzer.declarationsChecked };
}
/**
 * Walk a directory tree and analyze every authored `.ts` source beneath it,
 * skipping `.d.ts` files and the structural non-source directories. Scanning
 * zero files fails by throwing rather than passing vacuously.
 */
export function analyzeDocstringCoverage(options) {
    const roots = options.sourceDirs && options.sourceDirs.length > 0
        ? options.sourceDirs.map((dir) => join(options.root, dir))
        : [options.root];
    const files = collectSourceFiles(roots).sort();
    if (files.length === 0) {
        throw new Error(`docstring coverage: no TypeScript source files found under ${options.root} (scanning zero files cannot pass vacuously)`);
    }
    const reportBase = files.length === 1 && files[0] === options.root ? dirname(options.root) : options.root;
    let declarations = 0;
    const violations = [];
    for (const file of files) {
        const text = readFileSync(file, "utf8");
        const result = analyzeSource(text, relative(reportBase, file));
        declarations += result.declarations;
        violations.push(...result.violations);
    }
    return { files_scanned: files.length, declarations_checked: declarations, violations };
}
//# sourceMappingURL=docstrings.js.map
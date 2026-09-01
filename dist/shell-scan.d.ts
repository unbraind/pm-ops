/**
 * Tokenises shell text into the commands it would actually run.
 *
 * A guard that decides "does any publish here omit `--provenance`" is only as
 * good as its idea of what a command is. The previous scan answered that
 * question with a regular expression: it blanked every quoted span so an
 * advisory `echo "npm publish"` could not read as an invocation, then split the
 * remainder on `&&`, `||`, `;` and a space-surrounded `|`.
 *
 * Both halves of that shortcut are wrong in the same direction -- they make the
 * gate report a pass it has not earned:
 *
 * - Blanking quoted spans deletes the argument being audited. `npm publish
 *   "--provenance"` runs with an attestation but scans as one without, and the
 *   reverse case is worse: `eval "npm publish"` and `bash -c 'npm publish'` are
 *   real unattested publishes that vanish entirely, leaving a conventional
 *   attested sibling elsewhere in the file to carry the audit to green.
 * - Splitting on three operators misses a backgrounding `&`, a pipe written
 *   without surrounding spaces (`true|npm publish`), and command substitution.
 *
 * So the text is tokenised the way a shell does it -- quotes resolved rather
 * than erased, operators recognised as operators, `$(...)`, backticks, `eval`
 * and `sh -c` payloads recursed into -- and each command records whether its
 * words were quoted. Nothing downstream has to guess.
 *
 * This is deliberately not a shell. It resolves only provably literal scalar
 * and array bindings, preserves unknown expansions, and removes redirections
 * when locating command words; it does not expand globs or arithmetic. It
 * exists to enumerate candidate command invocations for auditing, where
 * missing one is a security failure and inventing one is merely noise.
 *
 * @packageDocumentation
 */
/** One word of a command, after quote resolution. */
export interface ShellToken {
    /** The word's text with its quoting removed. */
    value: string;
    /** True when any part of the word came from inside quotes. */
    quoted: boolean;
    /**
     * True when the word's FIRST character came from inside quotes.
     *
     * `quoted` alone cannot tell an assignment apart from a literal that merely
     * looks like one. `NPM_CONFIG_REGISTRY="https://example"` is a real
     * assignment whose value happens to be quoted, while `"FOO=bar"` is a single
     * quoted word that the shell does not treat as an assignment at all. Both set
     * `quoted`; only the second starts inside quotes.
     */
    startsQuoted: boolean;
}
/** One simple command: the words it would run, in order. */
export type ShellCommand = ShellToken[];
/**
 * Split shell text into the simple commands it contains.
 *
 * Command substitutions are scanned as well as the command containing them,
 * because `VERSION=$(npm publish)` runs a publish however unusual that is, and a
 * gate that only looked at the outer assignment would miss it.
 *
 * `eval`, `bash -c` and their siblings receive the same treatment one level
 * deeper: their string argument is re-tokenised, so a publish smuggled through
 * an interpreter is enumerated alongside a plain one. Recursion is bounded --
 * shell text that nests evaluators more than a handful of levels deep is not
 * something this repository writes, and an unbounded walk over hostile input is
 * a denial of service rather than a stronger audit.
 *
 * @param text - Shell text, typically one file or one manifest script body.
 * @param depth - Current evaluator recursion depth; callers pass nothing.
 * @returns Every simple command found, outermost first.
 */
export declare function tokenizeCommands(text: string, depth?: number): ShellCommand[];
/**
 * Name the program a command runs, or nothing when it runs none.
 *
 * Leading `NAME=value` assignments and wrapper words are skipped, and a path is
 * reduced to its basename so `/usr/local/bin/npm publish` is recognised. The
 * distinction this exists to draw is command *position*: `echo npm publish`
 * prints three words and publishes nothing, while the previous scan searched
 * the whole line for the word `npm` and counted it as an invocation.
 *
 * @param command - One simple command's tokens.
 * @returns The program's basename, or undefined for an empty or assignment-only command.
 */
export declare function commandName(input: ShellCommand): string | undefined;
/**
 * Enumerate every reading of a command that could name a program.
 *
 * `commandName` answers "what does this command run" and answers it once. That
 * is right for reporting and wrong for auditing, because a wrapper's options
 * are not all known: `sudo -u root npm publish` stops at `root`, since `-u`
 * takes a value and nothing here knows that. Enumerating the value-taking
 * options of every wrapper would be a list that silently goes stale, and each
 * omission is a publish that disappears from the audit.
 *
 * So once a wrapper has been consumed, every later word is also offered as a
 * possible program, with the words after it as its arguments. An auditor asking
 * "does any publish here lack an attestation" then cannot miss one behind a
 * wrapper option it has never heard of.
 *
 * The cost is noise, never a miss: `sudo -u npm publish` -- a user actually
 * named `npm` -- is offered as a publish that no shell would run. For a gate
 * whose failure mode is an unattested release, a spurious finding an operator
 * dismisses is the cheaper error.
 *
 * A command with no wrapper yields exactly one reading, so ordinary commands
 * are unaffected.
 *
 * @param command - One simple command's tokens.
 * @returns Each candidate reading, the command's own first.
 */
export declare function commandCandidates(input: ShellCommand): ShellCommand[];
/**
 * List a command's arguments -- everything after its program name.
 *
 * @param command - One simple command's tokens.
 * @returns The argument tokens, in order.
 */
export declare function commandArguments(input: ShellCommand): ShellToken[];
/** A tracked file's path and contents. */
export interface SourceFile {
    /** Repository-relative path. */
    file: string;
    /** File contents. */
    text: string;
}
/**
 * Collapse shell and YAML line continuations so one logical command is one string.
 *
 * A backslash at end of line joins the next line; without this every multi-line
 * invocation looks like a set of fragments, none of which carries both the
 * version input and the date flag.
 *
 * @param text - Raw file contents.
 * @returns The same text with continuations joined.
 */
export declare function joinContinuations(text: string): string;
/**
 * Index bash array assignments so a shared options array can be expanded.
 *
 * The release workflows declare `common=( ... )` once and pass `"${common[@]}"`
 * to each invocation, precisely so the invocations cannot drift. A scan that
 * reads only the invocation line therefore sees none of the shared flags.
 * Quoted or escaped closing parentheses are members, not array boundaries; an
 * unsupported array shape is left unknown so verification fails closed.
 *
 * @param text - File contents with continuations already joined.
 * @returns Array name mapped to the flag text it holds.
 */
export declare function bashArrays(text: string): Map<string, string>;
/**
 * Read persistent literal assignments from one control-operator-delimited segment.
 *
 * The line segmenter has already separated `;`, `&&`, and `||`. Shell keywords
 * and grouping operators can still precede an assignment in the remaining text:
 * `then NPM=npm`, `do FLAG=--provenance`, and `( NPM=npm` are all assignment-only
 * commands. Tokenising finds command position without an anchored text pattern.
 *
 * The ordinary line-opening parser remains the more permissive path for quoted
 * and escaped literal values. A compound-position assignment is accepted only
 * when its token was wholly unquoted and substitution-free; uncertainty is left
 * unresolved so the auditor can refuse rather than invent a binding.
 *
 * @param segment - One segment returned by {@link segmentShellLine}.
 * @returns Literal scalar bindings made by assignment-only commands.
 */
export declare function literalScalarAssignments(segment: string): Map<string, string>;
/**
 * Report which lines of a file are heredoc *body* rather than shell source.
 *
 * A heredoc body is data on a command's stdin. It cannot bind a variable in the
 * shell that reads it, so indexing `FLAG=--provenance` out of one invents a
 * binding the shell never makes, and an unattested `npm publish $FLAG` then
 * borrowed that flag and passed the attestation gate. Every heredoc spelling
 * hid a binding the same way: the plain `<<EOF`, the space- and tab-separated
 * `<<  EOF`, the quoted `<<'EOF'` and `<<"EOF"`, the tab-stripping `<<-EOF`,
 * and one written after another redirection (`cat > f <<EOF`).
 *
 * Only *binding* is suppressed here, never publish detection. A heredoc can
 * carry a script that is written to a file and executed later, so an
 * `npm publish` inside one remains a publish path this scan must report. Both
 * halves of that split fail closed: an unindexed name leaves `$FLAG`
 * unresolved, so the publish reads as unattested and the gate fails, and a
 * publish written into a heredoc still has to carry the flag itself.
 *
 * Several heredocs may open on one line (`cat <<A <<B`); bash reads their
 * bodies in the order the redirections appear, which is the order kept here. A
 * body whose delimiter never arrives runs to the end of the file, exactly as
 * the shell would read it.
 *
 * @param lines - The file's lines, with continuations already joined.
 * @returns One flag per line, true where that line is heredoc body.
 */
export declare function heredocBodyLines(lines: string[]): boolean[];
/**
 * Report body-data lines on which Bash performs parameter expansion.
 *
 * Quote removal still applies to every delimiter, but quoting any part of that
 * delimiter suppresses expansion in its body. Terminator lines never expand.
 *
 * @param lines - The file's lines, with continuations already joined.
 * @returns One flag per line, true only for expandable heredoc body data.
 */
export declare function heredocExpansionLines(lines: string[]): boolean[];
/**
 * Parse the scalar names one command unsets, or nothing.
 *
 * `unset FLAG` after `FLAG=--provenance` leaves the shell passing no flag at
 * all, so retaining the binding let an unattested publish borrow `--provenance`
 * and pass the gate. Commands are read through the tokeniser rather than an
 * anchored whole-line pattern, because `echo ready; unset FLAG` unsets exactly
 * as effectively as a line holding nothing else.
 *
 * An unset the parent shell would not actually perform -- inside `$(...)`, or
 * one the tokeniser surfaces from a nested body -- is honoured too, because the
 * two directions of error are not symmetric. Dropping a binding can only make a
 * later `$FLAG` unresolve, which reads as an unattested publish and *fails* the
 * gate; keeping one the shell discarded is what lets an unattested publish
 * pass. Erring toward the false alarm is the only direction that cannot ship an
 * unattested artifact.
 *
 * Leading environment assignments and the `command unset` / `builtin unset`
 * wrapper forms all reach the same builtin and therefore remove the same
 * bindings.
 *
 * `-v` selects the variable namespace, which is what this map models. `-f`
 * unsets a shell function and touches no variable, so such a command is left to
 * bind nothing.
 *
 * @param command - One tokenised command.
 * @returns The scalar names unset, empty when the command unsets none.
 */
export declare function unsetNames(command: ShellCommand): string[];
/**
 * Split one shell line into segments separated by control operators.
 *
 * Quoting and backslash escaping are respected so that operators inside quotes
 * or after a backslash do not split. Comments (`#` at a word boundary) absorb
 * the rest of the line into the preceding segment. The returned array
 * interleaves text segments with operator segments (`;`, `&`, `&&`, `|`, `||`).
 *
 * @param line - One line of shell source (continuations already joined).
 * @returns Segments where control operators are separate entries.
 */
export declare function segmentShellLine(line: string): string[];
/**
 * Net change in `case` nesting contributed by one line.
 *
 * Tracked separately from block depth because a `case` arm label ends in a bare
 * `)` that is not a parenthesis close. Without knowing a `case` is open, that
 * `)` decrements the depth counter and tags an assignment inside an untaken arm
 * as file-scoped, which then attests a publish after `esac`.
 *
 * @param line - One already-continuation-joined source line.
 * @returns +1 for each `case` opened, -1 for each `esac` closed.
 */
export declare function caseDepthChange(line: string): number;
/**
 * Decide whether text starts a new `case` arm.
 *
 * An arm label ends at an unquoted `)` that does not close a parenthesis group.
 * Treating an uncertain bare close as an arm boundary is deliberately
 * conservative: it discards bindings from the preceding arm, which can only
 * make later attestation fail closed.
 *
 * @param line - One already-continuation-joined source segment inside a case.
 * @returns True when the segment contains a case-arm label terminator.
 */
export declare function startsCaseArm(line: string): boolean;
/**
 * Net change in block nesting contributed by one line.
 *
 * Counts shell keywords and brace/parenthesis groups outside quotes. This is a
 * nesting count, not a parse: it exists to tell "this assignment is inside
 * something conditional" from "this assignment is the file's own scope", which
 * is the distinction attestation depends on.
 *
 * @param line - One already-continuation-joined source line.
 * @param insideCase - Whether a `case` is open, so a bare `)` is an arm label
 *   rather than a group close.
 * @returns Positive when the line opens more blocks than it closes.
 */
export declare function blockDepthChange(line: string, insideCase?: boolean): number;
/**
 * Index scalar assignments per line, so a command held in a variable can be
 * audited against the bindings that stand where it actually runs.
 *
 * `CMD="npm publish"` followed by `$CMD` runs a publish that no scan of the
 * invocation line can see, because the invocation line contains no publish. The
 * assignment is where the command actually is. `NPM=npm` followed by
 * `$NPM publish` hides one the same way, so unquoted values are indexed too.
 *
 * A name is taken only where a line OPENS with one assignment carrying a fully
 * literal value and holds nothing else before its end or a `;`. `NPM=npm; cmd`
 * therefore binds, because the semicolon ends the assignment and the shell keeps
 * it afterwards, while `NPM=npm cmd` does not, because that binding lasts only
 * for the command it precedes. Requiring the line to OPEN with the assignment is
 * what keeps a `;` inside a comment from exposing one. That single rule keeps
 * the scan from inventing
 * bindings the shell never makes, each of which let an unattested publish
 * borrow a flag and pass the gate:
 *
 * - `# FLAG=--provenance` is a comment, and a comment is not a line that is
 *   only an assignment.
 * - `echo "config NPM=npm"` is a command with an argument, not an assignment.
 * - `FLAG=--provenance some-command` binds only for that one command; the shell
 *   does not keep it afterwards, so neither does this map.
 * - `$(FLAG=--provenance)` binds inside a subshell that the outer shell never
 *   sees.
 * - `NPM=npm$SUFFIX` and `NPM=npm$(printf foo)` are not literal. The value must
 *   match to the end of the line, so a prefix is never mistaken for the whole
 *   value -- the mistake that let a scan analyse a different command from the
 *   one the shell runs.
 *
 * `export NPM=npm`, a trailing `# comment` and a CRLF line ending are all still
 * assignments: refusing them left `$NPM` unresolved, and an attested publish
 * elsewhere in the file then satisfied the non-vacuity guard, so being too
 * strict here passes an unattested publish just as being too loose does.
 *
 * Escapes are honoured outside single quotes, so `NPM=npm\\ publish` is one word
 * holding a command while `CMD='"'"'a\\b'"'"' keeps its backslash as the shell does.
 * A value that still carries a substitution, backtick, quote or parenthesis
 * after unescaping is refused: inlining `pkg_name="$(node -p …)"` injects an
 * unbalanced parenthesis into an unrelated command, and the scan then reports
 * invocations that are not there while losing the one that is -- a false
 * verdict in both directions, which is worse than not resolving the variable.
 * Shell metacharacters (`;`, `&`, `|`, `<`, `>`, `{`, `}`) are also refused
 * after unescaping: an escaped `\;` would become `;`, and the tokeniser would
 * split on it, so `FLAG=--provenance\;` would let an unattested publish borrow
 * a flag the shell passes as a literal `--provenance;` argument.
 *
 * Two things the shell does that a line-at-a-time reading missed both let an
 * unattested publish pass. A heredoc body is stdin data and binds nothing, yet
 * `FLAG=--provenance` inside one was indexed as an assignment; see
 * {@link heredocBodyLines}. And `unset FLAG` discards a binding, yet the map
 * kept it, so a later `npm publish $FLAG` borrowed a flag the shell no longer
 * passed; see the deletion below.
 *
 * Because `unset` makes a binding's lifetime positional, the result is one map
 * per line rather than one per file. Reading every invocation against the
 * file's end state would report an unattested publish for a flag that was
 * genuinely set where the publish runs and unset only afterwards.
 *
 * @param text - File contents with continuations already joined.
 * @returns One map per line: the bindings in effect once that line has run.
 */
export declare function shellScalarsByLine(text: string): Array<Map<string, string>>;
/**
 * The scalar bindings standing at the end of a file.
 *
 * @param text - File contents with continuations already joined.
 * @returns Variable name mapped to the literal text it holds.
 */
export declare function shellScalars(text: string): Map<string, string>;
/**
 * Expand unescaped, non-single-quoted scalar references against known bindings.
 *
 * An unknown name is left in place for the same reason an unknown array is:
 * erasing it would turn "not understood" into "carries no flags", which reads
 * as a pass.
 *
 * @param line - One logical command.
 * @param scalars - Scalar assignments from the same file.
 * @returns The command with expandable known scalar references inlined.
 */
export declare function expandScalars(line: string, scalars: Map<string, string>): string;
/**
 * Expand `"${name[@]}"` references against the file's array declarations.
 *
 * An unknown name is left untouched rather than erased: silently dropping it
 * would turn "this scan does not understand the command" into "this command has
 * no flags", which reads as a pass.
 *
 * @param line - One logical command.
 * @param arrays - Array declarations from the same file.
 * @returns The command with referenced array contents inlined.
 */
export declare function expandArrays(line: string, arrays: Map<string, string>): string;
/** The outcome of one verifier run. */
export interface VerifierResult {
    /** Reasons the run failed; empty means it passed. */
    failures: string[];
    /** Lines describing what was checked, for the operator. */
    notes: string[];
}
//# sourceMappingURL=shell-scan.d.ts.map
/** Shared shell classifications for release hooks and executable workflow bodies. */
/** The environments in which release shell source is inspected. */
export type ReleaseShellScope = "hook" | "workflow";
/** Shell features whose support depends on their execution context. */
type ReleaseConstruct = "case arms" | "shell negation" | "pipefail" | "time prefix" | "container job";
/** Identify a construct outside the grammar in its current execution context. */
export declare function unsupportedReleaseConstruct(construct: ReleaseConstruct, scope: ReleaseShellScope, shell?: string): boolean;
/** Stable diagnostic code for package hook grammar refusals. */
export declare const UNSUPPORTED_RELEASE_HOOK = "release_hook_unsupported_construct";
/** Report a grammar refusal with owning hook and migration advice. */
export declare function describeUnsupportedReleaseHook(construct: string, hook: string): string;
/** A shell prefix requires an unquoted identifier. The env utility accepts any nonempty name. */
export declare function isShellAssignment(word: {
    value: string;
    startsQuoted?: boolean;
}, utility?: boolean): boolean;
/** Whether a backslash introduces an escape inside double quotes. */
export declare function isDoubleQuotedShellEscape(next: string): boolean;
/** The current position within each nested shell case. */
export type ShellCaseState = "subject" | "in" | "pattern" | "pattern-data" | "body";
/** A case can read its next pattern or the remaining words in a started pattern. */
export declare function inShellCasePattern(state: ShellCaseState | undefined): boolean;
/** Classify case words before a scanner treats them as executable argv. */
export declare function readShellCaseWord(stack: ShellCaseState[], value: string, literal: boolean, commandStart: boolean): "open" | "header" | "pattern" | "close" | undefined;
/** Recognize a standalone brace reserved word at a command boundary. */
export declare function isReleaseGroupBrace(brace: string, words: readonly object[]): boolean;
/** Whether a command is governed by a timing prefix, directly or through a group. */
export declare function hasReleaseTiming(command: readonly object[]): boolean;
/** Associate commands with a timing prefix outside their compound command. */
export declare function recordTimedReleaseGroup(command: readonly object[]): void;
/** Preserve physical words even for commands reconstructed inside an evaluator. */
export declare function recordReleaseShellWord(word: object, raw: string): void;
/** Record when the next command is a stage of the same shell pipeline. */
export declare function recordReleasePipeline(words: readonly object[]): void;
/** Apply the same construct rules and pipeline scope to every shell reader. */
export declare function releaseCommandConstructs<Command extends ReadonlyArray<{
    releaseKeyword?: boolean;
}>>(commands: readonly Command[], scope: ReleaseShellScope, rawWord?: (word: Command[number]) => string | undefined): Map<Command, string>;
/** Count the physical source characters occupied by a case arm terminator. */
export declare function shellCaseTerminator(text: string, index: number): number;
/** Read one logical shell line and retain its physical end for edits. */
export declare function readShellLogicalLine(text: string, start: number, joins: (line: string) => boolean): {
    value: string;
    end: number;
    lines: number;
};
/** An odd final backslash escapes the newline after the literal pairs. */
export declare function hasShellContinuation(line: string): boolean;
/** Unsupported modes change parsing, builtin lookup, or pipeline isolation. */
export declare function unsupportedReleaseShellMode([program, ...args]: readonly {
    value: string;
    unresolved?: boolean;
}[]): string | undefined;
export {};
//# sourceMappingURL=release-shell-constructs.d.ts.map
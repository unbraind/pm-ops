/** Shared shell classifications for release hooks and executable workflow bodies. */
/** The environments in which release shell source is inspected. */
export type ReleaseShellScope = "hook" | "workflow";
/** Shell features whose support depends on their execution context. */
type ReleaseConstruct = "case arms" | "shell negation" | "pipefail";
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
/** The current position within each nested shell case. */
export type ShellCaseState = "subject" | "in" | "pattern" | "pattern-data" | "body";
/** A case can read its next pattern or the remaining words in a started pattern. */
export declare function inShellCasePattern(state: ShellCaseState | undefined): boolean;
/** Classify case words before a scanner treats them as executable argv. */
export declare function readShellCaseWord(stack: ShellCaseState[], value: string, literal: boolean, commandStart: boolean): "open" | "header" | "pattern" | "close" | undefined;
/** Count the characters occupied by a shell case arm terminator. */
export declare function shellCaseTerminator(text: string, index: number): number;
export {};
//# sourceMappingURL=release-shell-constructs.d.ts.map
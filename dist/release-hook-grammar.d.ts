import { type ShellCommand, type ShellToken, type ShellTokenSpan } from "./shell-scan.ts";
/** Return the producing command upstream of a supported output filter. */
export declare function releaseOutputProducer(command: ShellCommand): ShellCommand;
/** Whether shell edits in this command are local to a pipeline stage or subshell. */
export declare function isIsolatedReleaseCommand(words: ShellCommand): boolean;
/** Whether the command belongs to the condition list of a while or until loop. */
export declare function isReleaseLoopCondition(words: ShellCommand): boolean;
/** Whether the shell joined source lines inside a descriptor redirection. */
export declare function isContinuedDescriptor(word: ShellToken): boolean;
/** Whether this word includes unquoted shell brace expansion. */
export declare function hasBraceExpansion(word: ShellToken): boolean;
/** Return the first unsupported construct in the command. */
export declare function hookSyntaxProblem(words: ShellCommand): string | undefined;
/** Literal or indirect generator references, including opaque shell input. */
export declare function mentionsGenerator(word: ShellToken): boolean;
/** Return the variable expanded by this word that is inherited from a script runner. */
export declare function inheritedVariable(word: ShellToken, bindings: ReadonlySet<string>): string | undefined;
/** A fixed option name with a quoted, single-word dynamic value. */
export declare function literalOptionName(word: ShellToken): string | undefined;
/** One actionable diagnostic across verification, preparation and continuation. */
export declare function refuseHook(construct: string): never;
/** Describe a context the release manifest cannot represent. */
export declare function describeReleaseContextChange(construct: string): string;
/** Split only on unquoted shell list operators. Never execute or recursively guess a payload. */
export declare function parseReleaseHook(text: string): {
    commands: ShellCommand[];
    spans: WeakMap<ShellToken, ShellTokenSpan>;
    heredocBodies: Map<ShellCommand, ShellToken>;
};
//# sourceMappingURL=release-hook-grammar.d.ts.map
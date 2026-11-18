import { type ShellCommand, type ShellToken, type ShellTokenSpan } from "./shell-scan.ts";
/** Return the first unsupported construct in the command. */
export declare function hookSyntaxProblem(words: ShellCommand): string | undefined;
/** Literal generator references and shell words referencing a local generator binding. */
export declare function mentionsGenerator(word: ShellToken): boolean;
/** A fixed option name with a quoted, single-word dynamic value. */
export declare function literalOptionName(word: ShellToken): string | undefined;
/** One actionable diagnostic across verification, preparation and continuation. */
export declare function refuseHook(construct: string): never;
/** Split only on unquoted shell list operators. Never execute or recursively guess a payload. */
export declare function parseReleaseHook(text: string): {
    commands: ShellCommand[];
    spans: WeakMap<ShellToken, ShellTokenSpan>;
};
//# sourceMappingURL=release-hook-grammar.d.ts.map
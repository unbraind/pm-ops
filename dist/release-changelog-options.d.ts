import { type ShellCommand, type ShellToken, type ShellTokenSpan } from "./shell-scan.ts";
/** The flag that makes an untagged heading version-derived. */
export declare const DATE_FLAG = "--date-from-version";
/** The option that pins the heading day of a resumed release. */
export declare const FALLBACK_DATE_FLAG = "--date-fallback";
/** Whether a YYYY-MM-DD string names an existing day, including years 0–99. */
export declare function isRealCalendarDay(day: string): boolean;
/** Resolve the hook scripts and their local script dependencies before editing or verifying them. */
export declare function resolveChangelogHooks(scripts: Record<string, unknown> | undefined, hooks: readonly string[]): Map<string, string>;
/** Read generator arguments during an audit, where only declared forwards are trusted. */
export declare function changelogArguments(words: ShellCommand, scriptNames: ReadonlySet<string>): ShellToken[] | undefined;
/** One command in a decoded manifest script, with its source and effective argv. */
export interface ChangelogScriptCommand {
    /** Name of the script that supplied the command. */
    name: string;
    /** Source text before shell tokenization. */
    text: string;
    /** Original command words, including any wrappers. */
    words: ShellCommand;
    /** Command words with inherited package-script arguments appended. */
    effective: ShellCommand;
    /** pnpm delimiters that reached this command as literal arguments. */
    forwardedSeparators: ShellToken[];
    /** Source offsets for editable words from this script. */
    spans: WeakMap<ShellToken, ShellTokenSpan>;
    /** Whether the scanner found unfinished shell syntax in the script. */
    malformed: boolean;
}
/** Scan local scripts in invocation order and join forwarded argv at its actual destination. */
export declare function visitChangelogScriptCommands(scripts: ReadonlyMap<string, string>, inspect: (entry: ChangelogScriptCommand) => void, hooks?: readonly string[]): void;
type DateOption = {
    kind: "version" | "missing-day";
    first: ShellToken;
    last: ShellToken;
} | {
    kind: "pin" | "invalid-day";
    first: ShellToken;
    last: ShellToken;
    day: string;
};
/** Decode literal date options and retain their shell words for edits. */
export declare function readReleaseDateOptions(args: readonly ShellToken[]): DateOption[];
/** Refuse publication when a standalone generator's heading differs from the verified merge day. */
export declare function assertReleaseHeadingDate(scripts: readonly string[], mergeDay: string, packageVersion?: string, scriptNames?: ReadonlySet<string>): void;
/** Verify the complete generator argv from each release hook before publication. */
export declare function assertReleaseHookHeadingDate(scripts: ReadonlyMap<string, string>, hooks: readonly string[], mergeDay: string, packageVersion?: string): void;
/** Enable empty sections on each generator while preserving shell operators and redirections. */
export declare function includeEmptyReleaseSections(script: string, scriptNames?: ReadonlySet<string>): string;
/** Refresh the inline pins, or restore the standing policy for a current version. */
export declare function rewriteReleaseHeadingDate(script: string, headingDate: string, scriptNames?: ReadonlySet<string>): string;
/** Rewrite all heading options received by the manifest's resolved release hooks. */
export declare function rewriteReleaseHookDates(scripts: ReadonlyMap<string, string>, hooks: readonly string[], headingDate: string): Map<string, string>;
export {};
//# sourceMappingURL=release-changelog-options.d.ts.map
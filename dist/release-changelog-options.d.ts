import { type ShellCommand, type ShellToken } from "./shell-scan.ts";
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
/** Refuse publication when the verified merge day differs from the prepared heading day. */
export declare function assertReleaseHeadingDate(scripts: readonly string[], mergeDay: string, packageVersion?: string): void;
/** Enable empty sections on each generator while preserving shell operators and redirections. */
export declare function includeEmptyReleaseSections(script: string): string;
/** Refresh the inline pins, or restore the standing policy for a current version. */
export declare function rewriteReleaseHeadingDate(script: string, headingDate: string): string;
export {};
//# sourceMappingURL=release-changelog-options.d.ts.map
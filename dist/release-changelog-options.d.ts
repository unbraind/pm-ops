import { type ShellCommand, type ShellToken } from "./shell-scan.ts";
/** The flag that makes an untagged heading version-derived. */
export declare const DATE_FLAG = "--date-from-version";
/** The option that pins the heading day of a resumed release. */
export declare const FALLBACK_DATE_FLAG = "--date-fallback";
/** Whether a YYYY-MM-DD string names an existing day, including years 0–99. */
export declare function isRealCalendarDay(day: string): boolean;
/** Return the arguments of a recognized pm-changelog command or launcher. */
export declare function changelogArguments(words: ShellCommand): ShellToken[] | undefined;
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
/** Decode each date option and retain its first and last shell words for edits. */
export declare function readReleaseDateOptions(args: readonly ShellToken[]): DateOption[];
/** Refuse publication when the verified merge day differs from a prepared pin. */
export declare function assertReleaseHeadingDate(scripts: readonly string[], mergeDay: string): void;
/** Refresh the inline pins, or restore the standing policy for a current version. */
export declare function rewriteReleaseHeadingDate(script: string, headingDate: string): string;
export {};
//# sourceMappingURL=release-changelog-options.d.ts.map
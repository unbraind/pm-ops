import { type ShellCommand, type ShellToken, type ShellTokenSpan } from "./shell-scan.ts";
/** The flag that makes an untagged heading version-derived. */
export declare const DATE_FLAG = "--date-from-version";
/** The option that pins the heading day of a resumed release. */
export declare const FALLBACK_DATE_FLAG = "--date-fallback";
/** The three generator inputs that bind a heading to a release. */
export declare const VERSION_INPUTS: readonly ["--release-version-from-package", "--release-version", "--version"];
/** True when a command supplies an explicit release version. */
export declare function hasVersionInput(args: readonly ShellToken[]): boolean;
/** Whether a YYYY-MM-DD string names an existing day, including years 0–99. */
export declare function isRealCalendarDay(day: string): boolean;
/** Mirror pm-changelog by preserving the date prefix of the committer timestamp. */
export declare function releaseCommitDay(timestamp: string): string;
/** Whether npm automatically runs the named script's pre/post scripts. */
export type NpmLifecycle = boolean | "unknown";
/** Resolve CLI-independent npm configuration from the workflow env and project .npmrc. */
export declare function npmLifecycle(projectConfig: string | undefined, environment?: Readonly<Record<string, unknown>>): NpmLifecycle;
/** Resolve the same graph used by preparation and continuation, including comment-only hooks. */
export declare function resolveChangelogHooks(scripts: Record<string, unknown> | undefined, hooks: readonly string[], lifecycle?: NpmLifecycle): Map<string, string>;
/** Whether a non-root step could run a generator or delegate to its local package scripts. */
export declare function needsReleaseProject(words: ShellCommand, names?: ReadonlySet<string>): boolean;
/** Read generator arguments during an audit, where only declared forwards are trusted. */
export declare function changelogArguments(words: ShellCommand, scriptNames: ReadonlySet<string>): ShellToken[] | undefined;
/** One command in a decoded manifest script, with its source and effective argv. */
export interface ChangelogScriptCommand {
    /** Name of the script that supplied the command. */
    name: string;
    /** Local script names available to this command. */
    names: ReadonlySet<string>;
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
    /** Context refusal for an audit that collects diagnostics instead of throwing. */
    contextProblem?: string;
}
/** Lifecycle inputs for direct npm hooks and standalone workflow shell bodies. */
interface NpmLifecycleInputs {
    /** Configuration inherited by the configured hooks. */
    lifecycle?: NpmLifecycle;
    /** Static environment of each standalone workflow step. */
    workflowSteps?: ReadonlyMap<string, NpmLifecycle>;
}
/** Scan local scripts in invocation order and join forwarded argv at its actual destination. */
export declare function visitChangelogScriptCommands(scripts: ReadonlyMap<string, string>, inspect: (entry: ChangelogScriptCommand) => void, hooks?: readonly string[], resolved?: Map<string, string>, entryPoints?: ReadonlySet<string>, npm?: NpmLifecycleInputs): void;
type DateOption = {
    kind: "version";
    first: ShellToken;
    last: ShellToken;
} | {
    kind: "pin";
    first: ShellToken;
    last: ShellToken;
    day: string;
} | {
    kind: "missing-day";
    first: ShellToken;
    last: ShellToken;
} | {
    kind: "invalid-day";
    first: ShellToken;
    last: ShellToken;
    day: string;
};
/** Decode literal date options and retain their shell words for edits. */
export declare function readReleaseDateOptions(args: readonly ShellToken[]): DateOption[];
/** Refuse publication when a standalone generator's heading differs from the verified merge day. */
export declare function assertReleaseHeadingDate(scripts: readonly string[], mergeDay: string, packageVersion?: string, scriptNames?: ReadonlySet<string>): void;
/** Verify the complete generator argv from each release hook before publication. */
export declare function assertReleaseHookHeadingDate(scripts: ReadonlyMap<string, string>, hooks: readonly string[], mergeDay: string, packageVersion?: string, lifecycle?: NpmLifecycle): void;
/** Enable empty sections on each generator while preserving shell operators and redirections. */
export declare function includeEmptyReleaseSections(script: string, scriptNames?: ReadonlySet<string>): string;
/** Refresh the inline pins, or restore the standing policy for a current version. */
export declare function rewriteReleaseHeadingDate(script: string, headingDate: string, scriptNames?: ReadonlySet<string>): string;
/** Rewrite all heading options received by the manifest's resolved release hooks. */
export declare function rewriteReleaseHookDates(scripts: ReadonlyMap<string, string>, hooks: readonly string[], headingDate: string, lifecycle?: NpmLifecycle): Map<string, string>;
export {};
//# sourceMappingURL=release-changelog-options.d.ts.map
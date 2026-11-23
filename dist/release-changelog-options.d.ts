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
/** The active setting and the fallback after npm clears its exported ignore-scripts key. */
export type NpmLifecyclePolicy = NpmLifecycle | {
    /** Policy at the entry point, before per-command overrides. */
    active: NpmLifecycle;
    /** Effective policy with the lowercase npm_config_ignore_scripts entry removed. */
    configured: NpmLifecycle;
};
/** Read the active setting from either a simple policy or the richer npm environment. */
export declare function activeNpmLifecycle(policy: NpmLifecyclePolicy): NpmLifecycle;
/** Collect the nonempty environment aliases npm can read as ignore-scripts. */
export declare function npmLifecycleEnvironmentValues(environment: Readonly<Record<string, unknown>>): unknown[];
/** Resolve CLI-independent npm configuration from the workflow env and project .npmrc. */
export declare function npmLifecycle(projectConfig: string | undefined, environment?: Readonly<Record<string, unknown>>): NpmLifecycle;
/** Resolve the same graph used by preparation and continuation, including comment-only hooks. */
export declare function resolveChangelogHooks(scripts: Record<string, unknown> | undefined, hooks: readonly string[], lifecycle?: NpmLifecyclePolicy): Map<string, string>;
/** Look for a reachable generator without interpreting an opaque command as executable argv. */
export declare function canReachGenerator(words: ShellCommand, names?: ReadonlySet<string>, seen?: Set<string>, writing?: boolean, lifecycle?: NpmLifecycle, configured?: NpmLifecycle): boolean;
/** Outside a release hook, trace only redirects carrying a generator or a known script forward. */
export declare function generatedWriterProblem(words: ShellCommand, written: Set<string>, heredoc?: ShellToken, names?: ReadonlySet<string>, seen?: Set<string>): string | undefined;
/** Whether a non-root step could run a generator or delegate to its local package scripts. */
export declare function needsReleaseProject(words: ShellCommand, names?: ReadonlySet<string>): boolean;
/** Read generator arguments during an audit, where only declared forwards are trusted. */
export declare function changelogArguments(words: ShellCommand, scriptNames: ReadonlySet<string>, hook?: string): ShellToken[] | undefined;
/** One command in a decoded manifest script, with its source and effective argv. */
export interface ChangelogScriptCommand {
    /** Script forwards leading to this invocation, from the root to its caller. */
    parents: readonly string[];
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
    /** The invocation belongs to an explicitly configured release hook. */
    configuredHook?: boolean;
}
/** Static inputs for one workflow step in the release-hook audit. */
export interface WorkflowReleaseStep {
    /** User-facing workflow source location. */
    label: string;
    /** Environment policy at the start of the step. */
    lifecycle: NpmLifecyclePolicy;
    /** Container job which cannot supply release lifecycle evidence. */
    containerJob?: string;
}
/** Lifecycle inputs for direct npm hooks and standalone workflow shell bodies. */
interface NpmLifecycleInputs {
    /** Configuration inherited by the configured hooks. */
    lifecycle: NpmLifecyclePolicy;
    /** Inspect only explicitly invoked scripts when classifying the configured main command. */
    mainOnly?: boolean;
    /** Hooks also invoked by a reusable release caller under the project configuration. */
    projectEntryPoints?: ReadonlySet<string>;
    /** Static environment of each standalone workflow step. */
    workflowSteps?: ReadonlyMap<string, WorkflowReleaseStep>;
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
/** Resolve the output, inspection flags, and argv consumed by the changelog adapter. */
export declare function changelogOutputTarget<T extends Pick<ShellToken, "value" | "unresolved">>(args: readonly T[]): {
    output: Pick<ShellToken, "unresolved" | "value">;
    outputWord: T | undefined;
    invalidOption: string | undefined;
    check: boolean;
    stdout: boolean;
    consumed: Set<number>;
    positions: number[];
};
/** Decode literal date options and retain their shell words for edits. */
export declare function readReleaseDateOptions(args: readonly ShellToken[]): DateOption[];
/** Refuse suppression of the pending heading in a versioned all-tags release. */
export declare function assertPendingRelease(args: ShellCommand, positions?: readonly number[], advice?: string): void;
/** Refuse publication when a standalone generator's heading differs from the verified merge day. */
export declare function assertReleaseHeadingDate(scripts: readonly string[], mergeDay: string, packageVersion?: string, scriptNames?: ReadonlySet<string>): void;
/** Verify the complete generator argv from each release hook before publication. */
export declare function assertReleaseHookHeadingDate(scripts: ReadonlyMap<string, string>, hooks: readonly string[], mergeDay: string, packageVersion?: string, lifecycle?: NpmLifecyclePolicy): void;
/** Enable empty sections on each generator while preserving shell operators and redirections. */
export declare function includeEmptyReleaseSections(script: string, scriptNames?: ReadonlySet<string>): string;
/** Save the flag and any npm delimiters on the root caller, preserving shared target scripts. */
export declare function includeEmptyCustomHook(script: string, scripts: ReadonlyMap<string, string>, hasGenerator?: boolean, allowStatusOnly?: boolean, hook?: string): string;
/** Refresh the inline pins, or restore the standing policy for a current version. */
export declare function rewriteReleaseHeadingDate(script: string, headingDate: string, scriptNames?: ReadonlySet<string>): string;
/** Add the empty-section flag at the call site when it supplies the generator entrypoint. */
export declare function includeEmptyForwardedGenerators(scripts: ReadonlyMap<string, string>, hooks: readonly string[], lifecycle: NpmLifecyclePolicy): Map<string, string>;
/** Rewrite all heading options received by the manifest's resolved release hooks. */
export declare function rewriteReleaseHookDates(scripts: ReadonlyMap<string, string>, hooks: readonly string[], headingDate: string, lifecycle?: NpmLifecyclePolicy, packageVersion?: string): Map<string, string>;
export {};
//# sourceMappingURL=release-changelog-options.d.ts.map
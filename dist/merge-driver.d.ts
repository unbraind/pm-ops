/**
 * Canonical installer for pm's field-aware Git merge drivers.
 *
 * Git never clones `.git/config`, so every fleet package has to run
 * `pm merge install` from its npm `prepare` script or concurrent agents
 * conflict on tracker files. Twelve repositories vendored a byte-identical
 * untyped JavaScript hook for that step. This module is the typed, tested
 * replacement those packages import as `pm-ops/merge-driver`.
 *
 * Absence of `pm` is a supported production-install state and skips with a
 * one-line notice. A present but broken CLI fails loudly so an install cannot
 * pretend it configured merge safety when it did not. Windows PATH quoting,
 * PATHEXT shims, and the `execFile` `.cmd` limitation are honoured through an
 * injectable process boundary so the POSIX path is never faked.
 *
 * @packageDocumentation
 */
/**
 * Process boundary that runs `pm merge install` at a resolved launcher path.
 *
 * Tests inject this to prove Windows hands cmd.exe only the constant command
 * `pm merge install` (never an interpolated path) without executing a POSIX
 * binary under a fake Windows PATH. Production uses
 * `execFileSync` so a broken CLI's status and output reach the npm prepare hook.
 */
export type MergeInstaller = (executable: string, arguments_: string[], options: {
    stdio: "inherit";
    env: NodeJS.ProcessEnv;
    shell: boolean;
}) => unknown;
/**
 * Return whether `path` is a regular file the current platform would execute.
 *
 * POSIX requires the executable bit. Windows keys executability off PATHEXT,
 * so a regular file is enough; directories, missing paths, and (on POSIX)
 * mode-000 files are rejected without turning an ordinary absent-CLI install
 * into a failure.
 */
export declare function isExecutableFile(path: string, platform: NodeJS.Platform): boolean;
/**
 * Resolve the exact `pm` launcher on the supplied PATH, or `null` if none.
 *
 * Inspection never executes a candidate, so a present-but-broken CLI is not
 * mistaken for absence. Empty POSIX components mean the current directory;
 * Windows ignores them, may quote directories that contain spaces, and appends
 * each PATHEXT suffix (defaulting to `.COM;.EXE;.BAT;.CMD` when unset).
 */
export declare function pmOnPath(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null;
/**
 * Install clone-local merge drivers when `pm` is available.
 *
 * @returns `0` when installation ran or `pm` was absent (a one-line notice is
 * printed on skip). A present CLI whose `pm merge install` fails returns that
 * command's numeric status, or `1` when the failure has no status.
 */
export declare function runPrepareMergeDriver(environment?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, install?: MergeInstaller): number;
//# sourceMappingURL=merge-driver.d.ts.map
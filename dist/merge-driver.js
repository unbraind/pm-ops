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
import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
/**
 * Return whether `path` is a regular file the current platform would execute.
 *
 * POSIX requires the executable bit. Windows keys executability off PATHEXT,
 * so a regular file is enough; directories, missing paths, and (on POSIX)
 * mode-000 files are rejected without turning an ordinary absent-CLI install
 * into a failure.
 */
export function isExecutableFile(path, platform) {
    try {
        if (!statSync(path).isFile())
            return false;
        if (platform === "win32")
            return true;
        accessSync(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Resolve the exact `pm` launcher on the supplied PATH, or `null` if none.
 *
 * Inspection never executes a candidate, so a present-but-broken CLI is not
 * mistaken for absence. Empty POSIX components mean the current directory;
 * Windows ignores them, may quote directories that contain spaces, and appends
 * each PATHEXT suffix (defaulting to `.COM;.EXE;.BAT;.CMD` when unset).
 */
export function pmOnPath(environment, platform) {
    const directories = (environment.PATH ?? "")
        .split(platform === "win32" ? ";" : ":")
        .map((entry) => platform === "win32" && entry.startsWith('"') && entry.endsWith('"')
        ? entry.slice(1, -1)
        : entry === "" && platform !== "win32"
            ? "."
            : entry)
        .filter((entry) => entry !== "");
    const extensions = platform === "win32"
        ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
        : [""];
    for (const directory of directories) {
        for (const extension of extensions) {
            const candidate = join(directory, `pm${extension}`);
            if (isExecutableFile(candidate, platform))
                return candidate;
        }
    }
    return null;
}
/**
 * Install clone-local merge drivers when `pm` is available.
 *
 * @returns `0` when installation ran or `pm` was absent (a one-line notice is
 * printed on skip). A present CLI whose `pm merge install` fails returns that
 * command's numeric status, or `1` when the failure has no status.
 */
export function runPrepareMergeDriver(environment = process.env, platform = process.platform, install = execFileSync) {
    const executable = pmOnPath(environment, platform);
    if (executable === null) {
        console.error("pm is not on PATH; skipping merge-driver install");
        return 0;
    }
    try {
        // Node cannot execFile a Windows .cmd shim, so Windows has to go through
        // cmd.exe. Only the constant command `pm merge install` may cross that
        // boundary: interpolating the resolved path would let a PATH directory
        // containing spaces split the command line, or one containing cmd
        // metacharacters (`&`, `|`, `^`, `%`) inject into it. cmd resolves `pm`
        // from the same PATH and PATHEXT that discovery just validated. POSIX
        // executes the validated absolute path directly, with no shell at all.
        const windows = platform === "win32";
        install(windows ? "pm" : executable, ["merge", "install"], {
            stdio: "inherit",
            env: environment,
            shell: windows,
        });
        return 0;
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : error);
        if (typeof error === "object" && error !== null && "status" in error &&
            typeof error.status === "number") {
            return error.status;
        }
        return 1;
    }
}
//# sourceMappingURL=merge-driver.js.map
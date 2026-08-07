/**
 * Cross-platform npm prepare hook for pm's field-aware Git merge drivers.
 *
 * The hook skips consumer installs that do not provide a pm executable, but a
 * present yet broken CLI fails loudly so a clone cannot appear merge-safe when
 * its local Git configuration was never installed.
 */

import { execSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Inputs controlling PATH resolution and command execution. */
interface PrepareMergeDriverOptions {
  /** PATH text to inspect; defaults to the current process environment. */
  readonly path?: string;
  /** Windows PATHEXT text; defaults to the standard executable extensions. */
  readonly pathExt?: string;
  /** Platform whose executable rules should be applied. */
  readonly platform?: NodeJS.Platform;
  /** Command runner used once a pm executable is proven present. */
  readonly execute?: typeof execSync;
}

/**
 * Determine whether a PATH candidate is a regular executable file.
 *
 * POSIX requires the executable mode bit; Windows uses PATHEXT and therefore
 * needs only a regular file. Missing, inaccessible, and directory candidates
 * are rejected without turning an ordinary absent-CLI install into a failure.
 */
export function isExecutableFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    if (!statSync(path).isFile()) return false;
  } catch {
    return false;
  }
  if (platform === "win32") return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the pm executable by inspecting PATH without executing candidates.
 *
 * Empty POSIX path components mean the current directory, whereas Windows
 * ignores them and may quote directories containing spaces. A present but
 * broken CLI deliberately returns true so the subsequent install fails loudly.
 */
export function pmOnPath(options: PrepareMergeDriverOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const directories = (options.path ?? process.env.PATH ?? "")
    .split(pathDelimiter)
    .map((directory) => {
      if (
        platform === "win32" && directory.length >= 2 &&
        directory.startsWith('"') && directory.endsWith('"')
      ) {
        return directory.slice(1, -1);
      }
      return directory === "" ? (platform === "win32" ? "" : ".") : directory;
    })
    .filter((directory) => directory !== "");
  const extensions = platform === "win32"
    ? (options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(
      ";",
    ).map((extension) => extension.trim()).filter(Boolean)
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      if (isExecutableFile(join(directory, `pm${extension}`), platform)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Install clone-local pm merge drivers when the CLI is available.
 *
 * @returns True when installation ran, or false when pm was absent and the
 * consumer install was intentionally left untouched.
 */
export function prepareMergeDriver(
  options: PrepareMergeDriverOptions = {},
): boolean {
  if (!pmOnPath(options)) return false;
  (options.execute ?? execSync)("pm merge install", { stdio: "inherit" });
  return true;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  prepareMergeDriver();
}

/** Mirror tracked working files, including staged and unstaged deletions, into a disposable clone. */
import { copyFileSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "../subprocess.ts";

/** Remove obsolete clone files before copying the source's existing tracked files. */
export function mirrorTrackedSnapshot(source: string, candidate: string, env: NodeJS.ProcessEnv): void {
  const tracked = (cwd: string) => execFileSync("git", ["ls-files", "-z"], { cwd, env, encoding: "utf8" }).split("\0").filter(Boolean);
  const files = new Set(tracked(source).filter(file => statSync(join(source, file), { throwIfNoEntry: false })?.isFile()));
  for (const file of tracked(candidate)) {
    if (!files.has(file)) rmSync(join(candidate, file), { force: true, recursive: true });
  }
  for (const file of files) {
    const destination = join(candidate, file);
    if (lstatSync(destination, { throwIfNoEntry: false })?.isDirectory()) rmSync(destination, { recursive: true });
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(source, file), destination);
  }
}

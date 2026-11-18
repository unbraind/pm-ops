/** Mirror tracked working files, including staged and unstaged deletions, into a disposable clone. */
import { copyFileSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "../subprocess.ts";

/** Remove obsolete clone files before copying the source's existing tracked files. */
export function mirrorTrackedSnapshot(source: string, candidate: string, env: NodeJS.ProcessEnv): void {
  const tracked = (cwd: string) => execFileSync("git", ["ls-files", "-z"], { cwd, env, encoding: "utf8" }).split("\0").filter(Boolean);
  const files = new Set(tracked(source).filter(file => {
    const entry = lstatSync(join(source, file), { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) throw new Error("Cannot mirror tracked symbolic link: " + file);
    return entry?.isFile();
  }));
  for (const file of tracked(candidate)) {
    if (!files.has(file)) rmSync(join(candidate, file), { force: true, recursive: true });
  }
  for (const file of files) {
    const destination = join(candidate, file);
    const previous = lstatSync(destination, { throwIfNoEntry: false });
    if (previous?.isDirectory() || previous?.isSymbolicLink()) rmSync(destination, { recursive: true });
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(source, file), destination);
  }
  execFileSync("git", ["add", "-u"], { cwd: candidate, env });
  if (files.size > 0) {
    execFileSync("git", ["--literal-pathspecs", "add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      cwd: candidate, env, input: [...files].join("\0") + "\0",
    });
  }
}

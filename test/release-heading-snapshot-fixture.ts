/** Mirror tracked working files, including staged and unstaged deletions, into a disposable clone. */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "../subprocess.ts";

/** Remove obsolete clone files before copying the source's existing tracked files. */
export function mirrorTrackedSnapshot(source: string, candidate: string, env: NodeJS.ProcessEnv): void {
  const tracked = (cwd: string) => execFileSync("git", ["ls-files", "-z"], { cwd, env, encoding: "utf8" }).split("\0").filter(Boolean);
  const files = tracked(source);
  for (const file of new Set([...tracked(candidate), ...files])) {
    if (!existsSync(join(source, file))) rmSync(join(candidate, file), { force: true });
  }
  for (const file of files) {
    if (!existsSync(join(source, file))) continue;
    mkdirSync(dirname(join(candidate, file)), { recursive: true });
    copyFileSync(join(source, file), join(candidate, file));
  }
}

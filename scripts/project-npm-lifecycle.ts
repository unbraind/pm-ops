/** Resolve the effective, explicitly configured lifecycle policy in npm's project context. */
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { npmLifecycle, type NpmLifecycle } from "../release-changelog-options.ts";
import { spawnSync } from "../subprocess.ts";
import { isMainInvocation } from "./main-invocation.ts";
import { npmCli } from "./release-runtime.ts";

/** Use npm's own workspace and npmrc loader, without running any package scripts. */
async function readLifecycle(): Promise<NpmLifecycle> {
  const cli = npmCli(true);
  const fromNpm = createRequire(cli);
  const Config = fromNpm("@npmcli/config");
  const config = new Config({ ...fromNpm("@npmcli/config/lib/definitions"), npmPath: dirname(dirname(cli)),
    argv: [process.execPath, cli, "run"], env: { ...process.env } });
  await config.load();
  const key = "ignore-scripts";
  if (config.find(key) === "env") return npmLifecycle(undefined, process.env);
  for (const source of ["project", "user", "global", "builtin"]) {
    const layer = config.data.get(source);
    if (layer.loadError && layer.loadError.code !== "ENOENT") return "unknown";
    if (Object.hasOwn(layer.data, key)) {
      const value = config.get(key, source);
      return typeof value === "boolean" ? !value : "unknown";
    }
  }
  return "unknown";
}

/** Run from the hook directory so npm resolves relative configuration paths there too. */
export function projectNpmLifecycle(cwd: string): NpmLifecycle {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { cwd, encoding: "utf8" });
  if (result.status === 0 && result.stdout === "true") return true;
  if (result.status === 0 && result.stdout === "false") return false;
  return "unknown";
}

if (isMainInvocation(process.argv, import.meta.url)) {
  process.stdout.write(String(await readLifecycle().catch(() => "unknown")));
}

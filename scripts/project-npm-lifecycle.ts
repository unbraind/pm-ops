/** Resolve the effective, explicitly configured lifecycle policy in npm's project context. */
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { npmLifecycle, type NpmLifecycle } from "../release-changelog-options.ts";
import { spawnSync } from "../subprocess.ts";
import { isMainInvocation } from "./main-invocation.ts";
import { npmCli } from "./release-runtime.ts";

/** Use npm's own workspace and npmrc loader, without running any package scripts. */
async function readLifecycle(env: NodeJS.ProcessEnv): Promise<NpmLifecycle> {
  const cli = npmCli(true);
  const fromNpm = createRequire(cli);
  const Config = fromNpm("@npmcli/config");
  const config = new Config({ ...fromNpm("@npmcli/config/lib/definitions"), npmPath: dirname(dirname(cli)),
    argv: [process.execPath, cli, "run"], env: { ...env } });
  await config.load();
  const key = "ignore-scripts";
  if (config.find(key) === "env") return npmLifecycle(undefined, env);
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

/** Decode a scalar written by the npm probe or verified release receipt. */
export function parseNpmLifecycle(value: string | undefined): NpmLifecycle {
  if (value === "true") return true;
  if (value === "false") return false;
  return "unknown";
}

/** Retain the config that nested npm commands reload after clearing the exported setting. */
export function projectNpmLifecyclePolicy(cwd: string): { active: NpmLifecycle; configured: NpmLifecycle } {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--policy"], { cwd, encoding: "utf8" });
  const [active, configured] = result.status === 0 ? result.stdout.split(":") : [];
  return { active: parseNpmLifecycle(active), configured: parseNpmLifecycle(configured) };
}

/** Model clearing npm's canonical key before a nested invocation reloads configuration. */
export function npmLifecycleFallbackEnvironment(env: NodeJS.ProcessEnv, platform = process.platform): NodeJS.ProcessEnv {
  const key = "npm_config_ignore_scripts";
  const fallback = platform === "win32"
    ? Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== key))
    : { ...env };
  fallback[key] = "";
  return fallback;
}

if (isMainInvocation(process.argv, import.meta.url)) {
  const active = await readLifecycle(process.env).catch(() => "unknown");
  if (process.argv[2] === "--policy") {
    const configured = process.env.npm_config_ignore_scripts
      ? await readLifecycle(npmLifecycleFallbackEnvironment(process.env)).catch(() => "unknown")
      : active;
    process.stdout.write(active + ":" + configured);
  } else process.stdout.write(String(active));
}

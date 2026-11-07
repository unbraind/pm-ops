/** Install locked runtime dependencies only when release tooling is actually needed. */
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devNull, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFileSync } from "../subprocess.ts";

/** The source checkout containing this trusted helper, never a release PR checkout. */
export const workflowToolsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Install dependencies from the trusted commit's lockfile without running lifecycle scripts. */
function installLockedRuntime(args: string[], cwd: string): void { execFileSync("npm", args, { cwd, stdio: "inherit", timeout: 180_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NPM_CONFIG_USERCONFIG: devNull,
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/", NPM_CONFIG_CACHE: join(tmpdir(), "pm-ops-runtime-cache") } }); }

/** Install the private verifier only for a pending publication, never for an empty probe. */
export function ensureReleaseRuntime(root = workflowToolsRoot, run: (args: string[], cwd: string) => void = installLockedRuntime): void {
  const privateRoot = join(root, ".github/release-runtime");
  if (!existsSync(join(root, "node_modules/sigstore/package.json")) && !existsSync(join(privateRoot, "node_modules/sigstore/package.json"))) {
    run(["ci", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], privateRoot);
  }
}

/** Load the exact checked-out planner, even when its declared package version is unpublished. */
export function installReleaseTools(root: string, prefix: string, version: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string };
  if (pkg.name !== "pm-ops" || pkg.version !== version) throw new Error("Release tools identity changed");
  if (!existsSync(join(root, "node_modules/semver/package.json"))) installLockedRuntime(["ci", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], root);
  const module = createRequire(import.meta.url)(join(root, "dist/daily-release.js")) as Record<string, unknown>;
  if (["decideDailyRelease", "verifyBunScript", "stampCargoVersion", "stampExtensionVersion", "latestReleaseTag"].some(name => typeof module[name] !== "function")) throw new Error("Release tools are incompatible with this workflow");
  mkdirSync(join(prefix, "node_modules"), { recursive: true });
  symlinkSync(root, join(prefix, "node_modules/pm-ops"), "junction");
  return join(prefix, "node_modules/pm-ops/dist/daily-release.js");
}

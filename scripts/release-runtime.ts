/** Install locked runtime dependencies only when release tooling is actually needed. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devNull, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFileSync } from "../subprocess.ts";

/** The source checkout containing this trusted helper, never a release PR checkout. */
export const workflowToolsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Locate an npm CLI without executing a shell or switching the selected Node. */
function npmCli(): string {
  const adjacent = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  if (existsSync(adjacent)) return adjacent;
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const candidate of [join(directory, "node_modules/npm/bin/npm-cli.js"), join(directory, "../lib/node_modules/npm/bin/npm-cli.js")]) {
      if (existsSync(candidate)) return candidate;
    }
    const launcher = join(directory, "npm");
    if (existsSync(launcher)) {
      const target = realpathSync(launcher);
      if (target.endsWith("npm-cli.js")) return target;
    }
  }
  throw new Error("Release runtime needs an npm CLI beside Node or in a PATH npm installation; install npm before retrying");
}

/** Install dependencies from the trusted commit's lockfile without running lifecycle scripts. */
function installLockedRuntime(args: string[], cwd: string): void {
  // A fixed shared cache would let another user on a multi-user host pre-seed registry
  // metadata and a forged tarball whose CLI this process then executes; a fresh
  // private mkdtemp cache (0700) cannot be pre-populated and is always removed.
  const cache = mkdtempSync(join(tmpdir(), "pm-ops-npm-cache-"));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NPM_CONFIG_USERCONFIG: devNull,
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/", NPM_CONFIG_CACHE: cache };
  const options = { cwd, env, timeout: 180_000, encoding: "utf8" as const };
  const expected = "11.21.0";
  let prefix: string | undefined;
  try {
    const command = process.execPath;
    let leading = [npmCli()];
    if (execFileSync(command, [...leading, "--version"], options).trim() !== expected) {
      prefix = mkdtempSync(join(tmpdir(), "pm-ops-npm-"));
      execFileSync(command, [...leading, "install", "--prefix", prefix, "--no-save", "--package-lock=false", `npm@${expected}`, "--ignore-scripts", "--no-audit", "--no-fund"], { ...options, cwd: prefix, stdio: "inherit" });
      leading = [join(prefix, "node_modules/npm/bin/npm-cli.js")];
      const active = execFileSync(command, [...leading, "--version"], options).trim();
      if (active !== expected) throw new Error(`Expected npm ${expected}, got ${active}`);
    }
    execFileSync(command, [...leading, ...args], { ...options, stdio: "inherit" });
  } finally {
    if (prefix !== undefined) rmSync(prefix, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
}

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

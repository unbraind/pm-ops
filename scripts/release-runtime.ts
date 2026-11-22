/** Install locked runtime dependencies only when release tooling is actually needed. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devNull, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { isExecutableFile } from "../merge-driver.ts";
import { execFileSync } from "../subprocess.ts";

/** The source checkout containing this trusted helper, never a release PR checkout. */
export const workflowToolsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// npm's generated Bash shim has two exec paths to the same adjacent CLI.
// Accept the stock body so a launcher containing a different command stays opaque.
const DIRECT_WINDOWS_NPM = new RegExp([
  "^#!/bin/sh",
  String.raw`basedir=\$\(dirname "\$\(echo "\$0" \| sed -e 's,\\{2},/,g'\)"\)`,
  "",
  "case `uname` in",
  String.raw`    \*CYGWIN\*\|\*MINGW\*\|\*MSYS\*\)`,
  "        if command -v cygpath > /dev/null 2>&1; then",
  String.raw`            basedir=\x60cygpath -w "\$basedir"\x60`,
  "        fi",
  "    ;;",
  "esac",
  "",
  String.raw`if \[ -x "\$basedir/node" \]; then`,
  String.raw`  exec "\$basedir/node"  "\$basedir/((?:\.\./|node_modules/)npm/bin/npm-cli\.js)" "\$@"`,
  "else ?",
  String.raw`  exec node  "\$basedir/\1" "\$@"`,
  "fi",
  "$",
].join("\n"));

/** Follow a stock Windows launcher using the same Node and configured prefix. */
function windowsNpmCli(launcher: string): string | undefined {
  const directory = dirname(launcher);
  const launcherName = basename(launcher);
  if (!["npm", "npm.cmd"].includes(launcherName)) return undefined;
  const localNode = join(directory, "node.exe");
  // A launcher without adjacent Node can use a different runtime from PATH.
  // The probe must use the same Node to resolve the default global npmrc.
  if (!isExecutableFile(localNode, "win32") || realpathSync(localNode) !== realpathSync(process.execPath)) return undefined;
  const source = windowsLauncherText(launcher);
  const direct = DIRECT_WINDOWS_NPM.exec(source)?.[1];
  if (direct) {
    const cli = resolve(directory, direct);
    return isExecutableFile(cli, "win32") ? realpathSync(cli) : undefined;
  }
  const bundledNode = dirname(process.execPath);
  // A batch launcher uses its own directory. Only the running Node's
  // installation supplies the bundled helper that the probe may execute.
  if (launcherName === "npm.cmd" && realpathSync(directory) !== realpathSync(bundledNode)) return undefined;
  const bin = join(bundledNode, "node_modules/npm/bin");
  const template = join(bin, launcherName);
  if (!existsSync(template) || source !== windowsLauncherText(template)) return undefined;
  const prefix = execFileSync(process.execPath, [join(bin, "npm-prefix.js")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (!isAbsolute(prefix) || /[\r\n]/.test(prefix)) return undefined;
  const configured = join(prefix, "node_modules/npm/bin/npm-cli.js");
  const bundled = join(bin, "npm-cli.js");
  const cli = isExecutableFile(configured, "win32") ? configured : bundled;
  return isExecutableFile(cli, "win32") ? realpathSync(cli) : undefined;
}

/** Normalize line endings when comparing npm launcher bodies. */
function windowsLauncherText(file: string): string {
  return readFileSync(file, "utf8").replaceAll("\r\n", "\n");
}

/** Search native Windows launcher extensions in PATHEXT order. */
function windowsNpmLauncherNames(): string[] {
  return (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";").map(extension => extension.trim())
    .filter(extension => /^\.[a-z0-9]+$/.test(extension)).map(extension => "npm" + extension);
}

/** Locate an npm CLI without executing a shell or switching the selected Node. */
export function npmCli(pathOnly = false): string {
  const adjacent = join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  if (!pathOnly && existsSync(adjacent)) return adjacent;
  const win = process.platform === "win32";
  const native = win && !process.env.MSYSTEM;
  const directories = (process.env.PATH?.split(delimiter) ?? []).map(directory => win ? directory.replace(/^"(.*)"$/, "$1") : directory);
  if (pathOnly && native && process.env.NoDefaultCurrentDirectoryInExePath === undefined) directories.unshift(process.cwd());
  const names = native ? windowsNpmLauncherNames() : win ? ["npm", "npm.exe"] : ["npm"];
  for (const directory of directories) {
    if (!directory && (!pathOnly || win)) continue;
    if (pathOnly) {
      const launcher = names.map(name => join(directory, name)).find(file => isExecutableFile(file, process.platform));
      if (!launcher) continue;
      const target = realpathSync(launcher);
      if (basename(target) === "npm-cli.js") return target;
      const windowsCli = win ? windowsNpmCli(launcher) : undefined;
      if (windowsCli) return windowsCli;
      // An unrecognized shim ahead of npm may select another installation.
      break;
    }
    for (const candidate of [join(directory, "node_modules/npm/bin/npm-cli.js"), join(directory, "../lib/node_modules/npm/bin/npm-cli.js")]) {
      if (existsSync(candidate)) return resolve(candidate);
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

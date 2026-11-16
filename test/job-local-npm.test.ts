import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

/** The pinned npm version every workflow installs into a job-local prefix. */
const pin = "11.21.0";

/** Install commands that replace the npm of the shared Node installation. */
const globalReplacers = /npm\s+(?=[^\n]*\b(?:install|i)\b)(?=[^\n]*(?:\s-g\b|--global\b))[^\n]*\bnpm@/u;

/**
 * Locate the npm CLI that ships inside the running Node installation.
 *
 * That installation is the one a global install would replace, so it is the
 * "shared npm" the isolation test must prove untouched.
 *
 * @returns Absolute path of the running npm CLI entry script.
 */
function runningNpmCli(): string {
  const binDirectory = dirname(process.execPath);
  // Windows ships a shell launcher named npm as well as npm.cmd; execute its
  // adjacent JavaScript CLI rather than handing that shell script to Node.
  const windowsLayout = join(binDirectory, "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(windowsLayout)) return windowsLayout;
  const unixLayout = join(binDirectory, "npm");
  if (existsSync(unixLayout)) return realpathSync(unixLayout);
  throw new Error("cannot locate the npm CLI shipped with the running Node installation");
}

/** Run one npm CLI entry script with the current Node and capture its version. */
function npmVersion(cli: string): string {
  const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Install the pinned npm into one prefix and resolve when the install exits. */
function installInto(prefix: string, cwd: string): Promise<{ status: number | null; stderr: string; started: number; ended: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    // The install must not inherit the surrounding npm configuration (such as
    // allow-scripts or prefix settings exported by an `npm test` wrapper):
    // this reproduces the isolated job environment the workflow step gets on
    // a runner, and user-level config can hard-fail project-scoped installs.
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!/^npm_config_/iu.test(name) && value !== undefined) env[name] = value;
    }
    const started = performance.now();
    const child = spawn(process.execPath, [
      runningNpmCli(), "install", "--prefix", prefix, `npm@${pin}`,
      "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(cwd, "cache"),
    ], { cwd, env, timeout: 300_000, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk as string;
    });
    child.on("error", rejectPromise);
    child.on("close", status => resolvePromise({ status, stderr: stderr.slice(0, 4096), started, ended: performance.now() }));
  });
}

/** Hash all files in the shared npm package, independently of timestamps and version. */
function npmDigest(cli: string): string {
  const hash = createHash("sha256");
  const packageRoot = dirname(dirname(cli));
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      hash.update(path.slice(packageRoot.length));
      if (entry.isDirectory()) visit(path);
      else hash.update(readFileSync(path));
    }
  };
  visit(packageRoot);
  return hash.digest("hex");
}

test("no workflow replaces the shared global npm installation", () => {
  // Parallel jobs on one runner host share the Node installation in the
  // toolcache. A global npm install replaces the shared npm while a sibling
  // job is using it, which surfaced as ENOTEMPTY exits and `npm: command not
  // found`. Every pinned npm install must target a job-local prefix instead.
  const directory = resolve(import.meta.dirname, "../.github/workflows");
  for (const name of readdirSync(directory).sort()) {
    if (!/\.ya?ml$/u.test(name)) continue;
    const source = readFileSync(join(directory, name), "utf8");
    assert.doesNotMatch(source, globalReplacers, `${name} must install the pinned npm into a job-local prefix`);
  }
  assert.match("run: npm install -g npm@11.21.0", globalReplacers, "the audit must still detect a global npm install");
  assert.match("run: npm i -g npm@11.21.0", globalReplacers, "the audit must still detect the short global form");
});

test("overlapping pinned installs into separate prefixes leave the shared npm untouched", { timeout: 900_000 }, async () => {
  // The issue's acceptance list: two jobs on one host install the same pin at
  // the same time. With job-local prefixes both installs must succeed, both
  // prefixes must stay available at the pin, and the shared Node
  // installation's npm must be bit-for-bit untouched. The second round repeats
  // the overlap from a warm package cache.
  const cli = runningNpmCli();
  const sharedVersion = npmVersion(cli);
  const sharedMtime = statSync(cli).mtimeMs;
  const sharedDigest = npmDigest(cli);
  const root = mkdtempSync(join(tmpdir(), "npm-prefix-overlap-"));
  try {
    for (const round of ["cold", "warm"] as const) {
      const prefixes = [join(root, round, "first"), join(root, round, "second")];
      const [first, second] = await Promise.all(prefixes.map(prefix => installInto(prefix, root)));
      assert.ok(Math.max(first.started, second.started) < Math.min(first.ended, second.ended), "the two installs must overlap");
      for (const [label, result] of [["first", first], ["second", second]] as const) {
        assert.equal(result.status, 0, `${round}/${label} install failed: ${result.stderr}`);
      }
      for (const prefix of prefixes) {
        const pinnedCli = join(prefix, "node_modules", "npm", "bin", "npm-cli.js");
        assert.equal(npmVersion(pinnedCli), pin, `${prefix} must provide the pin`);
        // Each launcher must also reach a clean dependency install, not merely print a version.
        const consumer = join(prefix, "consumer");
        mkdirSync(consumer);
        writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "synthetic-consumer", version: "1.0.0" }));
        writeFileSync(join(consumer, "package-lock.json"), JSON.stringify({ name: "synthetic-consumer", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "synthetic-consumer", version: "1.0.0" } } }));
        const clean = spawnSync(process.execPath, [pinnedCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer, encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_/iu.test(name))) });
        assert.equal(clean.status, 0, clean.stderr);
      }
    }
    assert.equal(npmVersion(cli), sharedVersion, "the shared npm must keep its original version");
    assert.equal(statSync(cli).mtimeMs, sharedMtime, "the shared npm must stay untouched");
    assert.equal(npmDigest(cli), sharedDigest, "the entire shared npm package must remain byte-identical");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

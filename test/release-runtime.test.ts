/** Bootstrap exact source tools without relying on publication of their declared package version. */
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "../subprocess.ts";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureReleaseRuntime, installReleaseTools, workflowToolsRoot } from "../scripts/release-runtime.ts";
import { interceptRuntimeNpm } from "./runtime-npm-fixture.ts";
import { runReleaseContinuation } from "../scripts/release-continuation.ts";

/** A source checkout whose intentionally unpublished version must never be requested from npm. */
function sourceFixture(root: string, name = "pm-ops", version = "9999.1.1"): string {
  const source = join(root, "source"); mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({ name, version, type: "module" }));
  symlinkSync(join(workflowToolsRoot, "node_modules"), join(source, "node_modules"), "junction");
  symlinkSync(join(workflowToolsRoot, "dist"), join(source, "dist"), "junction");
  return source;
}

/** Restore synthetic runtime identity and remove its disposable source checkout. */
function restoreRuntimeProcess(root: string, platform: PropertyDescriptor, executable: PropertyDescriptor, restoreNpm: () => void): void {
  Object.defineProperty(process, "platform", platform);
  restoreNpm();
  Object.defineProperty(process, "execPath", executable);
  rmSync(root, { recursive: true, force: true });
}

test("unpublished trusted source version bootstraps from exact committed planner bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "release-source-tools-"));
  const keys = ["RUNNER_TEMP", "PM_OPS_VERSION", "RELEASE_TOOLS_ROOT", "GITHUB_ENV", "PATH"];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  const restoreNpm = interceptRuntimeNpm(root, 'if (process.argv[2] === "--version") console.log("11.21.0"); else { require("node:fs").writeFileSync("unpublished-lookup", process.argv.slice(2).join(" ")); process.exit(7); }');
  try {
    const source = sourceFixture(root);
    const module = installReleaseTools(source, join(root, "prefix"), "9999.1.1");
    assert.equal(existsSync(join(source, "unpublished-lookup")), false);
    assert.equal(readFileSync(module, "utf8"), readFileSync(join(workflowToolsRoot, "dist/daily-release.js"), "utf8"));
    assert.throws(() => installReleaseTools(source, join(root, "wrong"), "9999.1.2"), /identity/);
    writeFileSync(join(source, "package.json"), '{"name":"foreign","version":"9999.1.1","type":"module"}');
    assert.throws(() => installReleaseTools(source, join(root, "foreign"), "9999.1.1"), /identity/);
    writeFileSync(join(source, "package.json"), '{"name":"pm-ops","version":"9999.1.1","type":"module"}');
    Object.assign(process.env, { RUNNER_TEMP: root, PM_OPS_VERSION: "9999.1.1", RELEASE_TOOLS_ROOT: source, GITHUB_ENV: join(root, "env") });
    await runReleaseContinuation("tools");
    assert.match(readFileSync(join(root, "env"), "utf8"), /PM_OPS_MODULE=.*daily-release.js\nPM_OPS_TOOLS=/);
    delete process.env.RELEASE_TOOLS_ROOT; process.env.PM_OPS_VERSION = JSON.parse(readFileSync(join(workflowToolsRoot, "package.json"), "utf8")).version;
    await runReleaseContinuation("tools");
    const incompatible = join(root, "incompatible"); mkdirSync(join(incompatible, "dist"), { recursive: true });
    writeFileSync(join(incompatible, "package.json"), '{"name":"pm-ops","version":"9999.1.1","type":"module"}');
    writeFileSync(join(incompatible, "dist/daily-release.js"), 'export const decideDailyRelease = 1;\n');
    symlinkSync(join(workflowToolsRoot, "node_modules"), join(incompatible, "node_modules"), "junction");
    assert.throws(() => installReleaseTools(incompatible, join(root, "bad"), "9999.1.1"), /incompatible/);
    const uninstalled = join(root, "uninstalled"); mkdirSync(join(uninstalled, "dist"), { recursive: true });
    writeFileSync(join(uninstalled, "package.json"), '{"name":"pm-ops","version":"9999.1.1","type":"module"}');
    cpSync(join(workflowToolsRoot, "dist/daily-release.js"), join(uninstalled, "dist/daily-release.js"));
    assert.throws(() => installReleaseTools(uninstalled, join(root, "missing"), "9999.1.1"), /Command failed/);
    assert.match(readFileSync(join(uninstalled, "unpublished-lookup"), "utf8"), /^ci --omit=dev --ignore-scripts/);
  } finally {
    restoreNpm();
    for (const key of keys) { const prior = saved.get(key); if (prior === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = prior; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime installs only locked production dependencies without lifecycle scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "release-runtime-"));
  const restoreNpm = interceptRuntimeNpm(root, 'if (process.argv[2] === "--version") console.log("11.21.0"); else require("node:fs").writeFileSync("install-args", process.argv.slice(2).join(" "));');
  try {
    let calls = 0;
    const privateRoot = join(root, ".github/release-runtime"); mkdirSync(privateRoot, { recursive: true });
    ensureReleaseRuntime(root, (args, cwd) => { calls++; assert.equal(cwd, privateRoot); assert.deepEqual(args, ["ci", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"]); });
    assert.equal(calls, 1);
    ensureReleaseRuntime(undefined, () => {});
    ensureReleaseRuntime(root);
    assert.match(readFileSync(join(privateRoot, "install-args"), "utf8"), /^ci --omit=dev --ignore-scripts/);
    assert.doesNotMatch(readFileSync(join(privateRoot, "install-args"), "utf8"), /pm-ops@/);
    mkdirSync(join(privateRoot, "node_modules/sigstore"), { recursive: true }); writeFileSync(join(privateRoot, "node_modules/sigstore/package.json"), "{}");
    ensureReleaseRuntime(root, () => { throw new Error("already installed"); });
    assert.equal(existsSync(join(root, "node_modules")), false);
  } finally { restoreNpm(); rmSync(root, { recursive: true, force: true }); }
});

test("an empty native probe works with no installed runtime dependencies and never invokes npm", () => {
  const root = mkdtempSync(join(tmpdir(), "release-empty-source-"));
  try {
    mkdirSync(join(root, "scripts"));
    for (const path of ["release-continuation.ts", "release-provenance.ts", "subprocess.ts", "scripts/release-continuation.ts", "scripts/release-runtime.ts", "scripts/main-invocation.ts"]) {
      cpSync(new URL("../" + path, import.meta.url), join(root, path));
    }
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "read-only-fixture.mjs"), 'globalThis.fetch = async () => new Response("[]");\n');
    writeFileSync(join(root, "npm"), '#!/bin/sh\necho unexpected > "$PWD/npm-invoked"\nexit 7\n'); chmodSync(join(root, "npm"), 0o755);
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(join(root, "read-only-fixture.mjs")).href, join(root, "scripts/release-continuation.ts"), "probe"], { cwd: root, encoding: "utf8", timeout: 30_000, env: {
      PATH: root + ":" + process.env.PATH, GITHUB_REPOSITORY: "example/package", GH_TOKEN: "synthetic-token", RELEASE_CONFIG: "{}",
      CALLER_WORKFLOW: "example/package/.github/workflows/release.yml@refs/heads/main", RUNNER_TEMP: root, GITHUB_OUTPUT: join(root, "output"),
      TRIGGER_SHA: "a".repeat(40), RELEASE_TIMEZONE: "UTC",
    } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, "output"), "utf8"), "pending=false\n");
    assert.equal(existsSync(join(root, "npm-invoked")), false);
    assert.equal(existsSync(join(root, "node_modules")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("every on-demand locked installer pins npm and refuses bootstrap failures before ci", () => {
  const root = mkdtempSync(join(tmpdir(), "release-lazy-npm-"));
  let restoreNpm = () => {};
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const executable = Object.getOwnPropertyDescriptor(process, "execPath")!;
  try {
    // A Node executable under a path with spaces is the launch condition the
    // fixture must survive; a shebang cannot carry such a path, so the PATH
    // command has to launch the CLI with a quoted interpreter reference.
    const spaced = join(root, "node with space"); mkdirSync(spaced);
    const spacedNode = join(spaced, process.platform === "win32" ? "node.exe" : "node");
    try { linkSync(process.execPath, spacedNode); } catch { cpSync(process.execPath, spacedNode); chmodSync(spacedNode, 0o755); }
    Object.defineProperty(process, "execPath", { ...executable, value: spacedNode });
    const bin = join(root, "bin with space");
    // The inherited npm deliberately refuses every global installation, even as root.
    // Its only successful bootstrap writes a CLI which is absent from PATH.
    restoreNpm = interceptRuntimeNpm(root, `const fs = require("node:fs");
const path = require("node:path");
if (process.env.NPM_CONFIG_CACHE) fs.writeFileSync(path.join(${JSON.stringify(bin)}, "cache-info"), JSON.stringify({ dir: process.env.NPM_CONFIG_CACHE, mode: fs.statSync(process.env.NPM_CONFIG_CACHE).mode & 511 }));
const args = process.argv.slice(2);
const cwd = process.cwd();
if (args[0] === "--version") {
  console.log(fs.readFileSync(path.join(cwd, "before"), "utf8"));
} else if (args[0] === "install") {
  if (args.includes("-g") || args.includes("--global")) process.exit(77);
  const prefix = args[args.indexOf("--prefix") + 1];
  // Bootstrap runs outside the source checkout, so inherit the scenario through a file.
  const scenario = fs.readFileSync(path.join(${JSON.stringify(bin)}, "scenario"), "utf8");
  fs.appendFileSync(path.join(scenario, "calls"), JSON.stringify(args) + "\\n");
  fs.writeFileSync(path.join(scenario, "bootstrap-prefix"), prefix);
  if (fs.readFileSync(path.join(scenario, "cli"), "utf8") === "present") {
    fs.mkdirSync(path.join(prefix, "node_modules/npm/bin"), { recursive: true });
    fs.writeFileSync(path.join(prefix, "node_modules/npm/bin/npm-cli.js"), ${JSON.stringify(`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.NPM_CONFIG_CACHE) fs.appendFileSync(path.join(process.cwd(), "cli-caches"), process.env.NPM_CONFIG_CACHE + "\\n");
fs.appendFileSync(path.join(process.cwd(), "calls"), JSON.stringify(args) + "\\n");
if (args[0] === "--version") console.log(fs.readFileSync("after", "utf8"));
else if (args[0] === "ci") {
  if (fs.readFileSync("ci-status", "utf8") !== "0") process.exit(8);
  fs.symlinkSync(${JSON.stringify(join(workflowToolsRoot, "node_modules"))}, "node_modules", "junction");
}`)});
  }
  process.exit(Number(fs.readFileSync(path.join(scenario, "status"), "utf8")));
} else if (args[0] === "ci") {
  fs.appendFileSync(path.join(cwd, "calls"), JSON.stringify(args) + "\\n");
  if (fs.readFileSync("ci-status", "utf8") !== "0") process.exit(8);
  fs.symlinkSync(${JSON.stringify(join(workflowToolsRoot, "node_modules"))}, "node_modules", "junction");
}
`);
    process.env.PATH = bin; // No git or pinned npm executable is discoverable through PATH.
    const twin = join(bin, process.platform === "win32" ? "node.exe" : "node");
    const twinRun = spawnSync(twin, ["-e", "process.stdout.write('twin')"], { encoding: "utf8" });
    assert.equal(twinRun.status, 0, twinRun.stderr ?? String(twinRun.error), "the fixture Node twin must be executable without symlink privileges");
    assert.equal(twinRun.stdout, "twin");
    for (const target of ["native", "windows-launch"]) {
      if (target === "windows-launch") {
        Object.defineProperty(process, "platform", { ...platform, value: "win32" });
        rmSync(join(bin, "npm")); // Only Node and its adjacent bundled CLI remain.
      }
      for (const installer of ["private", "tools"]) for (const [before, after, status, ciStatus, success, cli] of [
        ["11.21.0", "11.21.0", "0", "0", true, "present"], ["10.9.3", "11.21.0", "0", "0", true, "present"],
        ["10.9.3", "10.9.3", "0", "0", false, "present"], ["10.9.3", "11.22.0", "0", "0", false, "present"], ["10.9.3", "11.21.0", "7", "0", false, "present"],
        ["10.9.3", "11.21.0", "0", "8", false, "present"],
        ["10.9.3", "11.21.0", "0", "0", false, "missing"],
      ] as const) {
        const source = join(root, `${target}-${installer}-${before}-${after}-${status}-${ciStatus}-${cli}`); mkdirSync(source);
        writeFileSync(join(source, "package.json"), '{"name":"pm-ops","version":"9999.1.1","type":"module"}');
        symlinkSync(join(workflowToolsRoot, "dist"), join(source, "dist"), "junction");
        const cwd = installer === "tools" ? source : join(source, ".github/release-runtime"); mkdirSync(cwd, { recursive: true });
        for (const [file, value] of [["before", before], ["after", after], ["status", status], ["ci-status", ciStatus], ["cli", cli]]) writeFileSync(join(cwd, file), value);
        writeFileSync(join(bin, "scenario"), cwd);
        const run = () => installer === "tools" ? installReleaseTools(source, join(source, "prefix"), "9999.1.1") : ensureReleaseRuntime(source);
        if (success) run(); else assert.throws(run, /Expected npm|Command failed|ENOENT/, `${installer}/${cli}`);
        const cache = JSON.parse(readFileSync(join(bin, "cache-info"), "utf8")) as { dir: string; mode: number };
        assert.match(cache.dir, /pm-ops-npm-cache-/, "install through a fresh private cache, never a shared fixed path");
        if (process.platform !== "win32") assert.equal(cache.mode, 0o700, "private cache permissions");
        assert.equal(existsSync(cache.dir), false, "remove the private cache on every install outcome");
        const cliCaches = existsSync(join(cwd, "cli-caches")) ? readFileSync(join(cwd, "cli-caches"), "utf8").trim().split("\n").filter(Boolean) : [];
        const generatedCliCalls = before === "11.21.0" || status !== "0" || cli !== "present" ? 0 : after === "11.21.0" ? 2 : 1;
        assert.deepEqual(cliCaches, Array.from({ length: generatedCliCalls }, () => cache.dir), "the bootstrapped CLI probe and ci must both use the private cache");
        const calls = readFileSync(join(cwd, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
        assert.equal(calls.some(call => call[0] === "ci"), success || ciStatus !== "0", `${installer}/${before}/${after}/${status}/${ciStatus}`);
        if (before === "11.21.0") assert.equal(calls.length, 1);
        else {
          const prefix = readFileSync(join(cwd, "bootstrap-prefix"), "utf8");
          assert.deepEqual(calls[0], ["install", "--prefix", prefix, "--no-save", "--package-lock=false", "npm@11.21.0", "--ignore-scripts", "--no-audit", "--no-fund"]);
          assert.equal(existsSync(prefix), false, "remove temporary npm after success, bootstrap failure, version mismatch and ci failure");
          if (status === "0" && cli === "present") assert.deepEqual(calls[1], ["--version"], "probe the bootstrapped CLI before ci");
        }
        if (success) assert.deepEqual(calls.at(-1), ["ci", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"]);
      }
    }
  } finally { restoreRuntimeProcess(root, platform, executable, restoreNpm); }
});

test("missing npm CLI refuses clearly and removes the private cache", () => {
  const root = mkdtempSync(join(tmpdir(), "release-windows-missing-"));
  const restoreNpm = interceptRuntimeNpm(root, "process.exit(9);");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const tempKeys = ["TMPDIR", "TMP", "TEMP"];
  const savedTemp = new Map(tempKeys.map(key => [key, process.env[key]]));
  try {
    for (const key of tempKeys) process.env[key] = root;
    rmSync(join(root, "bin with space", "node_modules/npm/bin/npm-cli.js"));
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    for (const path of [join(root, "bin with space"), undefined]) {
      if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
      assert.throws(() => ensureReleaseRuntime(root), /needs an npm CLI/);
      assert.deepEqual(readdirSync(root).filter(name => name.startsWith("pm-ops-npm-cache-")), []);
    }
  } finally {
    for (const key of tempKeys) { const prior = savedTemp.get(key); if (prior === undefined) delete process.env[key]; else process.env[key] = prior; }
    Object.defineProperty(process, "platform", platform);
    restoreNpm();
    rmSync(root, { recursive: true, force: true });
  }
});

test("matching npm uses the caller Node and discovers non-adjacent PATH installations", () => {
  const root = mkdtempSync(join(tmpdir(), "release-npm-discovery-"));
  const executable = Object.getOwnPropertyDescriptor(process, "execPath")!;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const restoreNpm = interceptRuntimeNpm(root, `
if (process.argv[2] === "--version") console.log("11.21.0");
else require("node:fs").writeFileSync("installed-with-node", process.execPath);
`);
  try {
    const bin = join(root, "bin with space");
    const standalone = join(root, "standalone"); mkdirSync(standalone);
    const node = join(standalone, process.platform === "win32" ? "node.exe" : "node");
    try { linkSync(executable.value, node); } catch { cpSync(executable.value, node); chmodSync(node, 0o755); }
    Object.defineProperty(process, "execPath", { ...executable, value: node });
    const poison = join(root, "poison"); mkdirSync(poison);
    writeFileSync(join(poison, "node"), "#!/bin/sh\nexit 91\n"); chmodSync(join(poison, "node"), 0o755);
    process.env.PATH = poison + delimiter + bin;
    for (const target of new Set([platform.value, "win32"])) {
      Object.defineProperty(process, "platform", { ...platform, value: target });
      const source = join(root, `source-${target}`); mkdirSync(join(source, ".github/release-runtime"), { recursive: true });
      ensureReleaseRuntime(source);
      const actualNode = readFileSync(join(source, ".github/release-runtime/installed-with-node"), "utf8");
      assert.equal(actualNode, node, "matching npm must run with the explicit caller Node even when PATH has another Node");
    }
  } finally { restoreRuntimeProcess(root, platform, executable, restoreNpm); }
});

test("POSIX npm symlink discovery does not depend on the host Node layout", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "release-npm-symlink-"));
  const restoreNpm = interceptRuntimeNpm(root, 'if (process.argv[2] === "--version") console.log("11.21.0"); else require("node:fs").writeFileSync("installed", "yes");');
  try {
    const bin = join(root, "bin with space");
    const cli = join(root, "npm-cli.js");
    renameSync(join(bin, "node_modules/npm/bin/npm-cli.js"), cli);
    rmSync(join(bin, "npm")); symlinkSync(cli, join(bin, "npm"));
    process.env.PATH = bin;
    mkdirSync(join(root, ".github/release-runtime"), { recursive: true });
    ensureReleaseRuntime(root);
    assert.equal(readFileSync(join(root, ".github/release-runtime/installed"), "utf8"), "yes");
  } finally { restoreNpm(); rmSync(root, { recursive: true, force: true }); }
});

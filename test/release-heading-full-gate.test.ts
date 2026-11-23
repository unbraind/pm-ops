/** Exercise acceptance cleanup without rerunning the nested release gate. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { spawnSync } from "../subprocess.ts";

/** Isolate each acceptance invocation and its executable fixtures. */
function gateFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "release-heading-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const scratch = join(root, "scratch");
  mkdirSync(bin);
  mkdirSync(scratch);
  return { bin, scratch };
}

test("release heading acceptance removes its checkout on command failure and interruption", { skip: process.platform === "win32" }, t => {
  const { bin, scratch } = gateFixture(t);
  const acceptance = resolve("test/release-heading-full-gate.acceptance.ts");
  for (const [signal, code] of [[undefined, 1], ["TERM", 143], ["INT", 130]] as const) {
    const interrupt = signal ? `kill -${signal} "$PPID"\nsleep 1\n` : "";
    writeFileSync(join(bin, "git"), "#!/bin/sh\necho clone-started >&2\n" + interrupt + "exit 79\n", { mode: 0o755 });
    const result = spawnSync(process.execPath, [acceptance], {
      env: { NODE_OPTIONS: process.env.NODE_OPTIONS, PATH: [bin, process.env.PATH].join(delimiter), TMPDIR: scratch },
      encoding: "utf8", timeout: 10_000,
    });
    assert.match(result.stderr, /clone-started/);
    assert.deepEqual(readdirSync(scratch), [], String(signal));
    assert.equal(result.status, code, result.stderr);
  }
});

test("Round HA acceptance waits for a descendant to finish using its checkout", { skip: process.platform === "win32" }, t => {
  const { bin, scratch } = gateFixture(t);
  const fixture = join(bin, "descendant.mjs");
  const launch = [process.execPath, fixture].map(file => "'" + file.replaceAll("'", "'\\''") + "'").join(" ");
  writeFileSync(join(bin, "git"), '#!/bin/sh\nexec ' + launch + ' "$PPID"\n', { mode: 0o755 });
  writeFileSync(fixture, [
    'import { spawn } from "node:child_process";',
    'import { readdirSync } from "node:fs";',
    'if (process.argv[2] === "child") {',
    '  process.on("SIGTERM", () => setTimeout(() => {',
    '    console.error(readdirSync(' + JSON.stringify(scratch) + ').length === 1 ? "checkout still present" : "checkout removed early");',
    '    process.exit(0);',
    '  }, 200));',
    '  process.send("ready"); setInterval(() => {}, 1000);',
    '} else {',
    '  const child = spawn(process.execPath, [process.argv[1], "child"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });',
    '  child.once("message", () => process.kill(Number(process.argv[2]), "SIGTERM"));',
    '}',
  ].join("\n"));
  const result = spawnSync(process.execPath, [resolve("test/release-heading-full-gate.acceptance.ts")], {
    env: { NODE_OPTIONS: process.env.NODE_OPTIONS, PATH: [bin, process.env.PATH].join(delimiter), TMPDIR: scratch },
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 143, result.stderr);
  assert.match(result.stderr, /checkout still present/);
  assert.deepEqual(readdirSync(scratch), []);
});

test("Round HA the Windows acceptance runner starts npm.cmd", t => {
  const { bin, scratch } = gateFixture(t);
  const launcher = join(bin, "npm.cmd");
  const args: string[] = [];
  if (process.platform === "win32") {
    writeFileSync(launcher, "@echo off\r\necho npm cmd fixture %*\r\nif %1==ci exit /b 0\r\nexit /b 79\r\n");
  } else {
    writeFileSync(launcher, '#!/bin/sh\necho "npm cmd fixture $*"\nif [ "$1" = ci ]; then exit 0; fi\nexit 79\n', { mode: 0o755 });
    const bootstrap = join(bin, "windows-launch.mjs");
    // On POSIX exercise the same dispatch and translate only the batch launch
    // into its executable fixture. Windows executes the batch file natively.
    writeFileSync(bootstrap, [
      'import childProcess from "node:child_process";',
      'import { syncBuiltinESMExports } from "node:module";',
      'Object.defineProperty(process, "platform", { value: "win32" });',
      'const spawn = childProcess.spawn;',
      'childProcess.spawn = (command, args, options) => {',
      '  if (command !== "npm" && command !== "npm.cmd") return spawn(command, args, options);',
      '  if (command !== "npm.cmd" || !options.shell) throw new Error("npm.cmd requires the Windows launcher");',
      '  return spawn(' + JSON.stringify(launcher) + ', args, { ...options, shell: false });',
      '};',
      'syncBuiltinESMExports();',
    ].join("\n"));
    args.push("--import", bootstrap);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^path$/i.test(key)));
  const result = spawnSync(process.execPath, [...args, resolve("test/release-heading-full-gate.acceptance.ts")], {
    env: { ...env, PATH: [bin, process.env.PATH].join(delimiter), TEMP: scratch, TMP: scratch, TMPDIR: scratch },
    encoding: "utf8", timeout: 60_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /npm cmd fixture ci/, result.stderr);
  assert.match(result.stdout, /npm cmd fixture run changelog:check/, result.stderr);
  assert.deepEqual(readdirSync(scratch), []);
});

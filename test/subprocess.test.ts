/** Real child processes prove every capture adapter rejects overflow without leaking partial output. */
import assert from "node:assert/strict";
import childProcess, { type ExecFileSyncOptions, type SpawnSyncOptions } from "node:child_process";
import fs, { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { tokenize } from "../docstrings.ts";
import { CAPTURE_LIMIT, CaptureRefusal, ShellRefusal, execFileSync, refuseCaptureOverflow, spawnSync } from "../subprocess.ts";
import { defaultExec } from "../release-completeness.ts";
import { runBashFixture } from "./bash-fixture.ts";

/** Assert the stable sanitized refusal and actionable remedy. */
function refused(error: unknown): boolean {
  assert.ok(error instanceof CaptureRefusal);
  assert.equal(error.code, "output_limit"); assert.equal(error.exitCode, 2);
  assert.match(error.remedy, /Reduce or paginate.*stream bulk data/);
  assert.doesNotMatch(error.message, /ENOBUFS|SECRET|stdio_maxbuffer/i);
  return true;
}

for (const [name, capture] of [["execFileSync", execFileSync], ["spawnSync", spawnSync]] as const) {
  test(`${name} refuses truthy shell options before reaching Node`, t => {
    let launches = 0;
    t.mock.method(childProcess, name, () => { launches++; throw new Error("unexpected Node launch"); });
    syncBuiltinESMExports();
    try {
      for (const shell of [true, "SECRET-shell"]) {
        for (const invoke of [() => capture("SECRET-command", ["SECRET-argument"], { shell }), () => capture("SECRET-command", { shell })]) {
          assert.throws(invoke, error => {
            assert.ok(error instanceof ShellRefusal);
            assert.equal(error.code, "shell_not_allowed"); assert.equal(error.exitCode, 2);
            assert.equal(error.name, "ShellRefusal");
            assert.match(error.remedy, /Pass the executable and an argument array/);
            assert.equal(error.message, `${error.code}: ${error.remedy}`);
            assert.doesNotMatch(error.message, /SECRET/);
            return true;
          });
        }
      }
      assert.equal(launches, 0);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });

  test(`${name} forces shell false after caller options in both overloads`, t => {
    const reachedNode = new Error("observed Node options");
    let launches = 0;
    t.mock.method(childProcess, name, (file: string, args: readonly string[], options: ExecFileSyncOptions) => {
      launches++;
      assert.equal(file, "literal-executable");
      assert.deepEqual(args, []);
      assert.equal(options.shell, false);
      assert.equal(options.maxBuffer, CAPTURE_LIMIT);
      throw reachedNode;
    });
    syncBuiltinESMExports();
    try {
      for (const overload of ["args", "options"]) {
        let reads = 0;
        // The guard sees false; the later spread sees true. The final override must still win.
        const changingShell = { get shell() { return reads++ > 0; } };
        for (const options of [{}, { shell: false }, { shell: "" }, changingShell]) {
          assert.throws(() => overload === "args"
            ? capture("literal-executable", [], options)
            : capture("literal-executable", options), error => error === reachedNode);
        }
      }
      assert.equal(launches, 8);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}

test("Bash fixtures execute owned script files with bounded capture and clean up on success and refusal", t => {
  const original = childProcess.spawnSync;
  const makeTemp = fs.mkdtempSync;
  const directories: string[] = [];
  const paths: string[] = [];
  const script = "printf '%s' 'literal fixture'";
  t.mock.method(fs, "mkdtempSync", (prefix: string) => {
    const root = makeTemp(prefix);
    directories.push(root);
    return root;
  });
  t.mock.method(childProcess, "spawnSync", (file: string, args: readonly string[], options: SpawnSyncOptions) => {
    assert.equal(file, "bash");
    assert.deepEqual(args.slice(0, -1), ["--noprofile", "--norc", "-e"]);
    paths.push(args.at(-1)!);
    assert.equal(readFileSync(paths.at(-1)!, "utf8"), script);
    assert.equal(options.shell, false);
    assert.equal(options.maxBuffer, CAPTURE_LIMIT);
    return original(file, args, options);
  });
  syncBuiltinESMExports();
  try {
    const result = runBashFixture(script, { encoding: "utf8" }, ["-e"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "literal fixture");
    assert.equal(existsSync(paths[0]!), false);
    assert.throws(() => runBashFixture(script, { encoding: "utf8", shell: true }), ShellRefusal);
    assert.equal(directories.length, 2);
    for (const directory of directories) assert.equal(existsSync(directory), false);
    assert.equal(paths.length, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("real exec and spawn captures refuse oversized stdout and stderr with typed remedies", () => {
  for (const capture of [execFileSync, spawnSync]) {
    for (const stream of ["stdout", "stderr"]) {
      assert.throws(() => capture(process.execPath, ["-e", `process.${stream}.write('SECRET'.repeat(65536))`], { encoding: "utf8", maxBuffer: 1024 }), refused);
    }
    assert.throws(() => capture(process.execPath, ["-e", `process.stdout.write('x'.repeat(${CAPTURE_LIMIT + 1024 * 1024}))`], { encoding: "utf8" }), refused);
    for (const maxBuffer of [0, -1, Infinity, 0.5]) assert.throws(() => capture(process.execPath, [], { maxBuffer }), refused);
  }
  assert.throws(() => defaultExec(process.execPath, ["-e", `process.stderr.write('x'.repeat(${CAPTURE_LIMIT + 1024 * 1024}))`]), refused);
});

test("bounded adapters retain ordinary failures and successful text or binary output", () => {
  assert.equal(execFileSync(process.execPath, ["-e", "process.stdout.write('ok')"], { encoding: "utf8" }), "ok");
  assert.equal(execFileSync(process.execPath, ["-e", "process.stdout.write('ok')"]).toString(), "ok");
  assert.equal(spawnSync(process.execPath, ["-e", "process.stdout.write('ok')"], { encoding: "utf8" }).stdout, "ok");
  assert.equal(spawnSync(process.execPath, ["-e", "process.stdout.write('ok')"]).stdout.toString(), "ok");
  assert.throws(() => execFileSync(process.execPath, ["-e", "process.exit(7)"]), error => !(error instanceof CaptureRefusal));
  assert.equal(spawnSync(process.execPath, ["-e", "process.exit(7)"]).status, 7);
  assert.equal(typeof execFileSync(process.execPath), "object");
  assert.equal(spawnSync(process.execPath).status, 0);
  assert.equal(execFileSync(process.execPath, { encoding: "utf8" }), "");
  assert.equal(spawnSync(process.execPath, { encoding: "utf8" }).stdout, "");
  assert.throws(() => refuseCaptureOverflow({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, 1024), refused);
  refuseCaptureOverflow(null, 1024); refuseCaptureOverflow(undefined, 1024); refuseCaptureOverflow({ code: "ENOENT" }, 1024);
});

test("descriptor output streams bulk bytes while stderr remains bounded", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-stream-"));
  const path = join(root, "member");
  const fd = openSync(path, "w");
  try {
    assert.equal(defaultExec(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(5 * 1024 * 1024, 255))"], { stdoutFd: fd }), "");
    assert.equal(readFileSync(path).length, 5 * 1024 * 1024);
  } finally { closeSync(fd); rmSync(root, { recursive: true, force: true }); }
});

test("package and test capture inventory uses bounded adapters or inherited stdio", () => {
  const root = new URL("../", import.meta.url);
  for (const directory of ["", "scripts/", "templates/", "test/"]) {
    for (const name of readdirSync(new URL(directory, root)).filter(name => name.endsWith(".ts"))) {
      const path = directory + name;
      if (path === "subprocess.ts") continue;
      const tokens = tokenize(readFileSync(new URL(path, root), "utf8"), path).map(token => token.text);
      const raw = new Set<string>();
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] !== "import") continue;
        const end = tokens.indexOf(";", i);
        const statement = tokens.slice(i, end);
        if (!statement.some(token => /^['"]node:child_process['"]$/.test(token))) continue;
        for (const token of statement) if (/^(exec|execFile|execSync|execFileSync|spawnSync)$/.test(token)) raw.add(token);
      }
      for (let i = 0; i < tokens.length; i++) {
        if (!raw.has(tokens[i]) || tokens[i + 1] !== "(") continue;
        let depth = 1; let end = i + 2;
        for (; end < tokens.length && depth > 0; end++) {
          if (tokens[end] === "(") depth++;
          if (tokens[end] === ")") depth--;
        }
        const call = tokens.slice(i + 2, end - 1);
        assert.ok(call.some((token, index) => token === "stdio" && call[index + 1] === ":" && /^['"]inherit['"]$/.test(call[index + 2])), `raw process capture: ${path}`);
      }
    }
  }
});

/** Real child processes prove every capture adapter rejects overflow without leaking partial output. */
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tokenize } from "../docstrings.ts";
import { CAPTURE_LIMIT, CaptureRefusal, execFileSync, refuseCaptureOverflow, spawnSync } from "../subprocess.ts";
import { defaultExec } from "../release-completeness.ts";

/** Assert the stable sanitized refusal and actionable remedy. */
function refused(error: unknown): boolean {
  assert.ok(error instanceof CaptureRefusal);
  assert.equal(error.code, "output_limit"); assert.equal(error.exitCode, 2);
  assert.match(error.remedy, /Reduce or paginate.*stream bulk data/);
  assert.doesNotMatch(error.message, /ENOBUFS|SECRET|stdio_maxbuffer/i);
  return true;
}

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

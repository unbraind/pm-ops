import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test, { after, before } from "node:test";

import {
  isExecutableFile,
  pmOnPath,
  prepareMergeDriver,
} from "../scripts/prepare-merge-driver.ts";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "pm-ops-prepare-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Create an executable POSIX command fixture. */
function executable(path: string, body = "exit 0"): void {
  writeFileSync(path, `#!/usr/bin/env sh\n${body}\n`);
  chmodSync(path, 0o755);
}

test("isExecutableFile rejects missing, directory, and non-executable POSIX candidates", () => {
  const directory = join(root, "candidates");
  mkdirSync(directory, { recursive: true });
  const plain = join(directory, "plain");
  writeFileSync(plain, "data\n");
  const runnable = join(directory, "runnable");
  executable(runnable);

  assert.strictEqual(isExecutableFile(join(directory, "missing")), false);
  assert.strictEqual(isExecutableFile(directory), false);
  assert.strictEqual(isExecutableFile(plain, "linux"), false);
  assert.strictEqual(isExecutableFile(runnable, "linux"), true);
  assert.strictEqual(isExecutableFile(plain, "win32"), true);
});

test("pmOnPath mirrors POSIX empty entries and Windows quoting plus PATHEXT", () => {
  const posix = join(root, "posix-bin");
  mkdirSync(posix, { recursive: true });
  executable(join(posix, "pm"));
  assert.strictEqual(
    pmOnPath({
      path: `${join(root, "missing")}${delimiter}${posix}`,
      platform: "linux",
    }),
    true,
  );
  assert.strictEqual(
    pmOnPath({ path: join(root, "missing"), platform: "linux" }),
    false,
  );
  assert.strictEqual(pmOnPath({ path: "", platform: "linux" }), false);

  const windows = join(root, "windows bin");
  mkdirSync(windows, { recursive: true });
  writeFileSync(join(windows, "pm.CMD"), "@echo off\r\n");
  assert.strictEqual(
    pmOnPath({
      path: `;\"${windows}\"`,
      pathExt: ";.EXE;.CMD;",
      platform: "win32",
    }),
    true,
  );
  assert.strictEqual(
    pmOnPath({ path: ";", pathExt: "", platform: "win32" }),
    false,
  );

  const previousPath = process.env.PATH;
  const previousPathExt = process.env.PATHEXT;
  try {
    delete process.env.PATH;
    assert.strictEqual(pmOnPath({ platform: "linux" }), false);
    process.env.PATH = windows;
    process.env.PATHEXT = ".CMD";
    assert.strictEqual(pmOnPath({ platform: "win32" }), true);
    delete process.env.PATHEXT;
    assert.strictEqual(pmOnPath({ platform: "win32" }), true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = previousPathExt;
  }
});

test("prepareMergeDriver skips an absent CLI and executes exactly one install for a present CLI", () => {
  assert.strictEqual(
    prepareMergeDriver({ path: join(root, "absent"), platform: "linux" }),
    false,
  );

  const bin = join(root, "prepare-bin");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "pm"));
  const calls: string[] = [];
  const execute = ((command: string) => {
    calls.push(command);
    return Buffer.alloc(0);
  }) as unknown as typeof execSync;
  assert.strictEqual(
    prepareMergeDriver({ path: bin, platform: "linux", execute }),
    true,
  );
  assert.deepStrictEqual(calls, ["pm merge install"]);
});

test("prepare hook direct entrypoint skips absence and fails loudly for a broken present CLI", () => {
  const script = resolve(
    import.meta.dirname,
    "../scripts/prepare-merge-driver.ts",
  );
  const cwd = join(root, "direct-cwd");
  mkdirSync(cwd, { recursive: true });
  const absent = execSync(
    `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: process.platform === "win32" ? "" : join(root, "absent-bin"),
      },
    },
  );
  assert.strictEqual(absent, "");

  const bin = join(root, "broken-bin");
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(join(bin, "pm.CMD"), "@echo off\r\nexit /b 7\r\n");
  } else {
    executable(join(bin, "pm"), "exit 7");
  }
  assert.throws(() =>
    execSync(`${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, {
      cwd,
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      },
    })
  );
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test, { after, before } from "node:test";

import {
  isExecutableFile,
  pmOnPath,
  runPrepareMergeDriver,
  type MergeInstaller,
} from "../merge-driver.ts";
import "../scripts/prepare-merge-driver.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const pinnedPm = join(packageRoot, "node_modules", ".bin", "pm");
const launcher = resolve(import.meta.dirname, "../scripts/prepare-merge-driver.ts");

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "pm-ops-merge-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Create an executable POSIX command fixture. */
function executable(path: string, body = "exit 0"): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * Copy process.env without the parent invocation's PM tracker context.
 *
 * Disposable git repos must discover their own tracker. Deleting the keys
 * keeps that contract explicit instead of relying on child-process coercion.
 */
function isolatedEnv(path: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: path };
  delete environment.PM_GLOBAL_PATH;
  delete environment.PM_PATH;
  delete environment.PM_SOURCE_PM_PATH;
  delete environment.PM_SOURCE_WORKSPACE_ROOT;
  return environment;
}

/** Run this repository's prepare-merge-driver launcher as a child process. */
function runLauncher(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [launcher], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

test("package.json exports ./merge-driver with types and default", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    exports: { "./merge-driver": { types: string; default: string } };
  };
  assert.deepEqual(manifest.exports["./merge-driver"], {
    types: "./dist/merge-driver.d.ts",
    default: "./dist/merge-driver.js",
  });
});

test("isExecutableFile rejects missing, directory, and non-executable POSIX candidates", () => {
  const directory = join(root, "candidates");
  mkdirSync(directory, { recursive: true });
  const plain = join(directory, "plain");
  writeFileSync(plain, "data\n");
  const runnable = join(directory, "runnable");
  executable(runnable);

  assert.equal(isExecutableFile(join(directory, "missing"), "linux"), false);
  assert.equal(isExecutableFile(directory, "linux"), false);
  assert.equal(isExecutableFile(plain, "linux"), false);
  assert.equal(isExecutableFile(runnable, "linux"), true);
  assert.equal(isExecutableFile(plain, "win32"), true);
});

test("pmOnPath mirrors POSIX empty entries and Windows quoting plus PATHEXT", () => {
  const posix = join(root, "posix-bin");
  mkdirSync(posix, { recursive: true });
  executable(join(posix, "pm"));
  assert.equal(
    pmOnPath({ PATH: `${join(root, "missing")}:${posix}` }, "linux"),
    join(posix, "pm"),
  );
  assert.equal(pmOnPath({ PATH: join(root, "missing") }, "linux"), null);
  assert.equal(pmOnPath({ PATH: posix }, "linux"), join(posix, "pm"));
  assert.equal(pmOnPath({ PATH: `:${posix}` }, "linux"), join(posix, "pm"));
  assert.equal(pmOnPath({}, "win32"), null);
  assert.equal(pmOnPath({ PATH: ";" }, "win32"), null);
  assert.equal(pmOnPath({ PATH: "" }, "linux"), null);
  assert.equal(pmOnPath({}, "linux"), null);

  const windows = join(root, "windows bin");
  mkdirSync(windows, { recursive: true });
  const shim = join(windows, "pm.CMD");
  writeFileSync(shim, "@echo off\r\n");
  assert.equal(
    pmOnPath({ PATH: `;\"${windows}\"`, PATHEXT: ";.EXE;.CMD;" }, "win32"),
    shim,
  );
  assert.equal(pmOnPath({ PATH: windows, PATHEXT: " ; .CMD ; " }, "win32"), shim);
  assert.equal(pmOnPath({ PATH: windows }, "win32"), shim);
  assert.equal(pmOnPath({ PATH: `"${windows}`, PATHEXT: ".CMD" }, "win32"), null);
  assert.equal(pmOnPath({ PATH: windows, PATHEXT: "" }, "win32"), null);
  assert.equal(pmOnPath({ PATH: ";", PATHEXT: "" }, "win32"), null);
});

test("missing, directory, and non-executable PATH candidates skip with a notice", (context) => {
  const notices: unknown[] = [];
  context.mock.method(console, "error", (message: unknown) => {
    notices.push(message);
  });
  const install: MergeInstaller = () => {
    throw new Error("install must not run when pm is absent");
  };

  const missing = join(root, "absent-bin");
  mkdirSync(missing, { recursive: true });
  assert.equal(runPrepareMergeDriver({ PATH: missing }, "linux", install), 0);

  const directoryParent = join(root, "directory-parent");
  mkdirSync(join(directoryParent, "pm"), { recursive: true });
  assert.equal(runPrepareMergeDriver({ PATH: directoryParent }, "linux", install), 0);

  const nonExecParent = join(root, "non-exec-parent");
  mkdirSync(nonExecParent, { recursive: true });
  writeFileSync(join(nonExecParent, "pm"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(nonExecParent, "pm"), 0o644);
  assert.equal(runPrepareMergeDriver({ PATH: nonExecParent }, "linux", install), 0);

  assert.equal(notices.length, 3);
  for (const notice of notices) {
    assert.equal(notice, "pm is not on PATH; skipping merge-driver install");
  }
});

test("Windows shims resolve the quoted PATHEXT path and request shell", () => {
  const windows = join(root, "windows-shim");
  mkdirSync(windows, { recursive: true });
  const shim = join(windows, "pm.CMD");
  writeFileSync(shim, "@echo off\r\n");
  const environment = { PATH: `"${windows}"`, PATHEXT: ".CMD;.EXE" };
  let observed: {
    executable: string;
    arguments_: string[];
    options: { stdio: "inherit"; env: NodeJS.ProcessEnv; shell: boolean };
  } | undefined;
  const install: MergeInstaller = (executable, arguments_, options) => {
    observed = { executable, arguments_, options };
  };
  assert.equal(runPrepareMergeDriver(environment, "win32", install), 0);
  assert.deepEqual(observed, {
    executable: shim,
    arguments_: ["merge", "install"],
    options: { stdio: "inherit", env: environment, shell: true },
  });
});

test("POSIX success uses execFile without a shell at the resolved path", () => {
  const bin = join(root, "success-bin");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "pm"));
  const environment = { PATH: bin };
  let observedShell: boolean | undefined;
  const install: MergeInstaller = (executable, arguments_, options) => {
    assert.equal(executable, join(bin, "pm"));
    assert.deepEqual(arguments_, ["merge", "install"]);
    assert.equal(options.stdio, "inherit");
    assert.equal(options.env, environment);
    observedShell = options.shell;
  };
  assert.equal(runPrepareMergeDriver(environment, "linux", install), 0);
  assert.equal(observedShell, false);
});

test("install failures preserve numeric status and normalize other throws", (context) => {
  context.mock.method(console, "error", () => undefined);
  const bin = join(root, "failure-bin");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "pm"));
  const environment = { PATH: bin };
  const withStatus: MergeInstaller = () => {
    throw { status: 7 };
  };
  const errorWithoutStatus: MergeInstaller = () => {
    throw new Error("launch failed");
  };
  const nonObject: MergeInstaller = () => {
    throw "broken";
  };
  const emptyObject: MergeInstaller = () => {
    throw {};
  };
  const nonNumericStatus: MergeInstaller = () => {
    throw { status: "no" };
  };
  const nullThrow: MergeInstaller = () => {
    throw null;
  };
  assert.equal(runPrepareMergeDriver(environment, "linux", withStatus), 7);
  assert.equal(runPrepareMergeDriver(environment, "linux", errorWithoutStatus), 1);
  assert.equal(runPrepareMergeDriver(environment, "linux", nonObject), 1);
  assert.equal(runPrepareMergeDriver(environment, "linux", emptyObject), 1);
  assert.equal(runPrepareMergeDriver(environment, "linux", nonNumericStatus), 1);
  assert.equal(runPrepareMergeDriver(environment, "linux", nullThrow), 1);
});

test("a real broken pm script exits non-zero with its output", () => {
  const bin = join(root, "broken-bin");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "pm"), "echo broken-pm >&2\nexit 1");
  const code = runPrepareMergeDriver({ PATH: bin }, process.platform);
  assert.equal(code, 1);
});

test("the pinned pm binary writes merge.*.driver git config in a temp repo", { timeout: 60_000 }, () => {
  const repo = mkdtempSync(join(tmpdir(), "pm-ops-merge-"));
  try {
    execFileSync("git", ["init"], { cwd: repo, encoding: "utf8" });
    const environment = isolatedEnv(`${dirname(pinnedPm)}${delimiter}${process.env.PATH ?? ""}`);
    execFileSync(process.execPath, [
      pinnedPm,
      "init",
      "--defaults",
      "--agent-guidance",
      "skip",
      "--no-merge-fence",
    ], {
      cwd: repo,
      env: environment,
      encoding: "utf8",
    });
    assert.throws(
      () =>
        execFileSync("git", ["config", "--local", "--get-regexp", "^merge\\..*\\.driver$"], {
          cwd: repo,
          encoding: "utf8",
        }),
    );
    const launched = runLauncher({ cwd: repo, env: environment });
    assert.equal(launched.status, 0, `${launched.stdout}\n${launched.stderr}`);
    const config = execFileSync("git", ["config", "--local", "--get-regexp", "^merge\\."], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.match(config, /merge\.pm-item-toon\.driver /);
    assert.match(config, /merge\.pm-item-markdown\.driver /);
    assert.match(config, /merge\.pm-history\.driver /);
    assert.match(config, /merge\.pm-relationship\.driver /);
    assert.match(config, /merge\.pm-json\.driver /);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prepare hook direct entrypoint skips absence and fails loudly for a broken present CLI", () => {
  const cwd = join(root, "direct-cwd");
  mkdirSync(cwd, { recursive: true });
  const absent = runLauncher({
    cwd,
    env: isolatedEnv(join(root, "absent-launcher")),
  });
  assert.equal(absent.status, 0);
  assert.equal(absent.stdout, "");
  assert.match(absent.stderr, /pm is not on PATH; skipping merge-driver install/);

  const bin = join(root, "broken-launcher-bin");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "pm"), "echo broken-launcher >&2\nexit 7");
  const broken = runLauncher({
    cwd,
    env: isolatedEnv(bin),
  });
  assert.equal(broken.status, 7);
  assert.match(broken.stderr, /broken-launcher/);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";

const packageRoot = resolve(import.meta.dirname, "..");
const template = join(packageRoot, "templates", "prepare-merge-driver.ts");
const prepareEntry = join(packageRoot, "merge-driver-prepare.ts");

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "pm-ops-launcher-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Create a consumer checkout root. The canonical launcher runs in place with
 * this directory as its working directory, exactly as npm runs `prepare`, so a
 * copy in `scripts/` behaves identically and coverage is attributed to the
 * shipped template itself.
 *
 * `pmOps` selects what `node_modules/pm-ops` is: absent (an omit-dev install),
 * this package itself, or a stale pm-ops whose exports predate the entry.
 */
function consumer(name: string, pmOps: "absent" | "current" | "stale"): string {
  const directory = join(root, name);
  mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, type: "module" }));
  if (pmOps !== "absent") mkdirSync(join(directory, "node_modules"));
  if (pmOps === "current") symlinkSync(packageRoot, join(directory, "node_modules", "pm-ops"), "dir");
  if (pmOps === "stale") {
    mkdirSync(join(directory, "node_modules", "pm-ops"));
    writeFileSync(
      join(directory, "node_modules", "pm-ops", "package.json"),
      JSON.stringify({ name: "pm-ops", type: "module", exports: { "./merge-driver": "./merge-driver.js" } }),
    );
  }
  return directory;
}

/**
 * Put a stub `pm` on a fresh PATH directory that records its arguments and
 * exits with `status`, and return that directory plus the record file.
 */
function stubPm(name: string, status: number, body = ""): { bin: string; record: string } {
  const bin = join(root, `${name}-bin`);
  const record = join(root, `${name}-args.txt`);
  mkdirSync(bin);
  writeFileSync(join(bin, "pm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${record}'\n${body}\nexit ${status}\n`);
  chmodSync(join(bin, "pm"), 0o755);
  return { bin, record };
}

/** Run a script with only `bin` on PATH, as npm's prepare hook would from `cwd`. */
function run(cwd: string, script: string, bin: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: bin },
  });
  return { status: result.status, stderr: result.stderr };
}

test("an omit-dev checkout without pm-ops skips with exactly one notice and succeeds", { skip: process.platform === "win32" }, () => {
  const directory = consumer("omit-dev", "absent");
  const { bin, record } = stubPm("omit-dev", 0);
  const result = run(directory, template, bin);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "pm-ops is not installed (omit-dev install); skipping merge-driver install\n");
  assert.throws(() => readFileSync(record, "utf8"), /ENOENT/);
});

test("a full install runs pm merge install through the pm-ops entry", { skip: process.platform === "win32" }, () => {
  const directory = consumer("full", "current");
  const { bin, record } = stubPm("full", 0);
  const result = run(directory, template, bin);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(record, "utf8"), "merge install\n");
});

test("a failing pm merge install fails the launcher with the same status", { skip: process.platform === "win32" }, () => {
  const directory = consumer("broken-pm", "current");
  const { bin, record } = stubPm("broken-pm", 7);
  const result = run(directory, template, bin);
  assert.equal(result.status, 7, result.stderr);
  assert.equal(readFileSync(record, "utf8"), "merge install\n");
});

test("an installer killed by a signal fails the install instead of reporting success", { skip: process.platform === "win32" }, () => {
  const directory = consumer("killed", "current");
  // The stub's parent is the pm-ops installer process the launcher spawned.
  const { bin, record } = stubPm("killed", 0, "kill -9 $PPID");
  const result = run(directory, template, bin);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(readFileSync(record, "utf8"), "merge install\n");
});

test("a pm-ops too old to export the entry fails loudly instead of skipping", { skip: process.platform === "win32" }, () => {
  const directory = consumer("stale", "stale");
  const { bin, record } = stubPm("stale", 0);
  const result = run(directory, template, bin);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
  assert.throws(() => readFileSync(record, "utf8"), /ENOENT/);
});

test("a pm-ops whose entry file is missing fails loudly instead of skipping", { skip: process.platform === "win32" }, () => {
  const directory = consumer("no-entry", "stale");
  writeFileSync(
    join(directory, "node_modules", "pm-ops", "package.json"),
    JSON.stringify({ name: "pm-ops", type: "module", exports: { "./merge-driver/prepare": "./missing.js" } }),
  );
  const { bin, record } = stubPm("no-entry", 0);
  const result = run(directory, template, bin);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing\.js/);
  assert.throws(() => readFileSync(record, "utf8"), /ENOENT/);
});

test("a pm-ops directory left without its package.json fails loudly instead of skipping", { skip: process.platform === "win32" }, () => {
  // A broken install (an interrupted extraction, a manual rm) can leave the
  // package directory behind with no package.json. Resolution then fails with
  // MODULE_NOT_FOUND exactly as for an omit-dev install, so the launcher must
  // not read that as absence and skip the drivers.
  const directory = consumer("broken", "absent");
  mkdirSync(join(directory, "node_modules", "pm-ops"), { recursive: true });
  const { bin, record } = stubPm("broken", 0);
  const result = run(directory, template, bin);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot find module 'pm-ops\/merge-driver\/prepare'/);
  assert.doesNotMatch(result.stderr, /skipping merge-driver install/);
  assert.throws(() => readFileSync(record, "utf8"), /ENOENT/);
});

test("a dangling pm-ops link fails loudly instead of skipping", { skip: process.platform === "win32" }, () => {
  const directory = consumer("dangling", "absent");
  mkdirSync(join(directory, "node_modules"));
  symlinkSync(join(directory, "gone"), join(directory, "node_modules", "pm-ops"), "dir");
  const { bin, record } = stubPm("dangling", 0);
  const result = run(directory, template, bin);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /skipping merge-driver install/);
  assert.throws(() => readFileSync(record, "utf8"), /ENOENT/);
});

test("an installed pm-ops without an exports map fails loudly instead of skipping", { skip: process.platform === "win32" }, () => {
  const directory = consumer("no-exports", "stale");
  writeFileSync(join(directory, "node_modules", "pm-ops", "package.json"), JSON.stringify({ name: "pm-ops" }));
  const { bin, record } = stubPm("no-exports", 0);
  const result = run(directory, template, bin);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot find module 'pm-ops\/merge-driver\/prepare'/);
  assert.throws(() => readFileSync(record, "utf8"), /ENOENT/);
});

test("the prepare entry itself skips with a notice when pm is not on PATH", { skip: process.platform === "win32" }, () => {
  const empty = join(root, "empty-bin");
  mkdirSync(empty);
  const result = run(root, prepareEntry, empty);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "pm is not on PATH; skipping merge-driver install\n");
});

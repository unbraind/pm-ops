/** Packing must preserve clone-local Git configuration while installs still register drivers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

const packageRoot = resolve(import.meta.dirname, "..");

/** Execute real npm/git commands in a disposable consumer and require successful completion. */
function execute(root: string, program: string, args: string[], env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32" && program === "npm") {
    // Windows cannot spawn npm's cmd shim without a shell. The npm test
    // runner supplies its actual CLI path, so Node can execute it directly.
    assert.ok(env.npm_execpath, "Run this Windows fixture through the npm test runner");
    args = [env.npm_execpath, ...args];
    program = process.execPath;
  }
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout + result.stderr;
}

test("real npm pack never mutates git config and npm install/ci still run prepare", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-ops-pack-"));
  try {
    mkdirSync(join(root, "scripts"));
    copyFileSync(join(packageRoot, "templates/prepare-merge-driver.ts"), join(root, "scripts/prepare-merge-driver.ts"));
    const installed = join(root, "node_modules/pm-ops");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "pm-ops", type: "module", exports: { "./merge-driver/prepare": "./prepare.js" } }));
    writeFileSync(join(installed, "prepare.js"), 'import { execFileSync } from "node:child_process"; execFileSync("git", ["config", "--local", "merge.fixture.driver", "pm merge driver"]);');
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pack-prepare-fixture", version: "1.0.0", type: "module", scripts: { prepare: "node scripts/prepare-merge-driver.ts" } }));
    const env: NodeJS.ProcessEnv = { ...process.env, npm_config_userconfig: devNull, NPM_CONFIG_USERCONFIG: devNull };
    delete env.npm_command;
    // A parent's allow-scripts whitelist belongs to that parent's project.
    // npm rejects it as a CLI option during a different project installation.
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "npm_config_allow_scripts") delete env[key];
    }
    execute(root, "git", ["init", "-q"], env);
    const config = join(root, ".git/config");
    const before = readFileSync(config);
    execute(root, "npm", ["pack", "--pack-destination", root], env);
    assert.deepEqual(readFileSync(config), before, "npm pack changed git config");
    const lock = join(root, ".git/config.lock");
    writeFileSync(lock, "synthetic lock owner\n");
    execute(root, "npm", ["pack", "--pack-destination", root], env);
    assert.deepEqual(readFileSync(config), before);
    assert.equal(readFileSync(lock, "utf8"), "synthetic lock owner\n",
      "artifact creation must neither acquire nor remove another Git writer's lock");
    unlinkSync(lock);
    // The guard runs before resolution, so broken installs cannot make pack
    // fail. It does not mask those errors when npm is actually installing.
    const metadata = readFileSync(join(installed, "package.json"));
    unlinkSync(join(installed, "package.json"));
    for (const npmCommand of ["pack", "publish"]) {
      const skipped = execute(root, process.execPath, [join(root, "scripts/prepare-merge-driver.ts")], { ...env, npm_command: npmCommand });
      assert.equal(skipped.split("skipping merge-driver install").length - 1, 1);
      assert.deepEqual(readFileSync(config), before);
    }
    const broken = spawnSync(process.execPath, [join(root, "scripts/prepare-merge-driver.ts")], {
      cwd: root, encoding: "utf8", env: { ...env, npm_command: "install" },
    });
    assert.notEqual(broken.status, 0, "install must refuse the broken package");
    assert.doesNotMatch(broken.stderr, /skipping merge-driver install/);
    writeFileSync(join(installed, "package.json"), metadata);
    for (const hook of ["templates/prepare-merge-driver.ts", "scripts/prepare-merge-driver.ts", "merge-driver-prepare.ts"]) {
      for (const npmCommand of ["pack", "publish"]) {
        const skipped = execute(root, process.execPath, [join(packageRoot, hook)], { ...env, npm_command: npmCommand });
        assert.equal(skipped.split("skipping merge-driver install").length - 1, 1);
        assert.deepEqual(readFileSync(config), before);
      }
    }
    execute(root, process.execPath, [join(root, "scripts/prepare-merge-driver.ts")], { ...env, npm_command: "install" });
    assert.equal(execute(root, "git", ["config", "--local", "--get", "merge.fixture.driver"], env).trim(), "pm merge driver");
    // Real installs use this repository's hook against a boundary pm shim;
    // npm prunes extraneous dependencies, so its pm-ops entry is unnecessary.
    const bin = join(root, "bin");
    mkdirSync(bin);
    /** npm's lifecycle shell resolves the appropriate native launcher on each platform. */
    const launcher = join(bin, process.platform === "win32" ? "pm.cmd" : "pm");
    writeFileSync(launcher, process.platform === "win32"
      ? '@echo off\r\ngit config --local merge.fixture.driver "pm merge driver"\r\n'
      : '#!/bin/sh\ngit config --local merge.fixture.driver "pm merge driver"\n');
    chmodSync(launcher, 0o755);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pack-prepare-fixture", version: "1.0.0", scripts: { prepare: `node ${JSON.stringify(join(packageRoot, "scripts/prepare-merge-driver.ts"))}` } }));
    for (const command of ["install", "ci"]) {
      execute(root, "git", ["config", "--local", "--unset", "merge.fixture.driver"], env);
      execute(root, "npm", [command, "--no-audit", "--no-fund"], { ...env, PATH: `${bin}${delimiter}${env.PATH}` });
      assert.match(execute(root, "git", ["config", "--local", "--get", "merge.fixture.driver"], env), /pm merge driver/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

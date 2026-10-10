/** Native Windows real-consumer controls: independently revert each launcher and refuse npm 10. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { npmLauncher } from "./npm-launcher.ts";

assert.equal(process.platform, "win32", "These controls require native Windows");
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.npm_execpath;

for (const program of ["npm", "npx"] as const) {
  const launch = npmLauncher(program, ["--version"], env);
  assert.equal(launch.executable, process.execPath);
  const actual = spawnSync(launch.executable, launch.args, { env, encoding: "utf8" });
  assert.equal(actual.status, 0, actual.stderr + actual.stdout);
  assert.match(actual.stdout.trim(), /^11\./);
  console.log(program, "Node CLI", launch.args[0], "version", actual.stdout.trim());
}

for (const file of ["test/pack-prepare.test.ts", "test/packed-consumer.acceptance.ts"]) {
  const repaired = readFileSync(file);
  try {
    writeFileSync(file, execFileSync("git", ["show", `ea29cb425a72b6729d24b00df4573e8c092c7cfa:${file}`]));
    const result = spawnSync(process.execPath, file.endsWith(".test.ts") ? ["--test", file] : [file], {
      env, encoding: "utf8", timeout: 180_000,
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, `Old launcher unexpectedly passed: ${file}`);
    assert.match(result.stdout + result.stderr, file.endsWith(".test.ts")
      ? /Run this Windows fixture through the npm test runner/ : /npm --version/);
    console.log("source-only revert rejected", file);
  } finally {
    writeFileSync(file, repaired);
    assert.deepEqual(readFileSync(file), repaired);
  }
}

const prefix = mkdtempSync(join(tmpdir(), "pm-ops-npm10-"));
try {
  const install = npmLauncher("npm", ["install", "--global", "--prefix", prefix, "npm@10.9.4", "--ignore-scripts", "--no-audit", "--no-fund"], env);
  const installed = spawnSync(install.executable, install.args, { env, encoding: "utf8", timeout: 180_000 });
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  const legacyEnv: NodeJS.ProcessEnv = { ...env, PATH: `${prefix}${delimiter}${env.PATH}`, NPM_CONFIG_PREFIX: prefix };
  for (const key of Object.keys(legacyEnv)) {
    if (key.toLowerCase() === "npm_config_prefix" && key !== "NPM_CONFIG_PREFIX") delete legacyEnv[key];
  }
  const version = npmLauncher("npm", ["--version"], legacyEnv);
  const actual = spawnSync(version.executable, version.args, { env: legacyEnv, encoding: "utf8" });
  assert.equal(actual.status, 0, actual.stderr + actual.stdout);
  assert.equal(actual.stdout.trim(), "10.9.4");
  const refused = spawnSync(process.execPath, ["test/packed-consumer.acceptance.ts"], {
    env: legacyEnv, encoding: "utf8", timeout: 180_000,
  });
  assert.equal(refused.error, undefined);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /npm 11 pack acceptance requires an independently verified npm 11 executable/);
  assert.doesNotMatch(refused.stdout + refused.stderr, /npm pack PASS|candidate tarball sha256/);
  console.log("actual npm 10.9.4 rejected before packing");
} finally {
  rmSync(prefix, { recursive: true, force: true });
}

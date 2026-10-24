/** Verify packed duplication gates in npm and native Bun consumers without fast-glob. */
import assert from "node:assert/strict";
import { spawnSync } from "../subprocess.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { npmLauncher } from "./npm-launcher.ts";

const source = process.cwd();
const root = mkdtempSync(join(tmpdir(), "pm-ops-packed-duplication-"));
const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
delete env.PM_PATH;
delete env.PM_AUTHOR;
env.NPM_CONFIG_USERCONFIG = devNull;
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === "npm_config_allow_scripts") delete env[key];
}

/** Run a consumer command, requiring its exact expected exit status. */
function run(cwd: string, executable: string, args: string[], status = 0): string {
  const launch = executable === "npm" ? npmLauncher(executable, args, env) : { executable, args };
  const result = spawnSync(launch.executable, launch.args, { cwd, env, encoding: "utf8", timeout: 180_000 });
  assert.equal(result.status, status, `${executable} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout + result.stderr;
}

try {
  run(source, "npm", ["pack", "--pack-destination", root]);
  const archive = readdirSync(root).find((file) => file.endsWith(".tgz"));
  assert.ok(archive);
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as {
    devDependencies: { jscpd: string };
  };
  for (const runtime of ["npm", "bun"]) {
    const cwd = join(root, runtime);
    mkdirSync(join(cwd, "scripts"), { recursive: true });
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: "synthetic-duplication-consumer", version: "1.0.0", private: true, type: "module",
      devDependencies: { "pm-ops": `file:${join(root, archive)}`, jscpd: manifest.devDependencies.jscpd },
      scripts: { duplication: `${runtime === "npm" ? "node" : "bun"} scripts/duplication-gate.ts` },
      duplicationGate: { threshold: 0, minTokens: 20 },
    }));
    // Consumers call the export through the documented thin launcher: pm-ops has no CLI bin.
    writeFileSync(join(cwd, "scripts/duplication-gate.ts"),
      'import { runDuplicationGate } from "pm-ops/duplication";\nawait runDuplicationGate();\n');
    run(cwd, runtime, ["install", "--ignore-scripts"]);
    assert.equal(existsSync(join(cwd, "node_modules/fast-glob")), false);
    assert.equal(existsSync(join(cwd, "node_modules/braces")), false);
    writeFileSync(join(cwd, "src/clean.ts"), "export const clean = 1;\n");
    assert.match(run(cwd, runtime, ["run", "duplication"]), /0% duplicated lines .*2 source\(s\)/);
    const clone = Array.from({ length: 10 }, (_, index) => `export const repeated${index} = ${index};`).join("\n") + "\n";
    writeFileSync(join(cwd, "src/first.ts"), clone);
    writeFileSync(join(cwd, "src/second.ts"), clone);
    assert.match(run(cwd, runtime, ["run", "duplication"], 1), /exceeds the configured 0% threshold/);
    console.log(`${runtime}: packed clean gate PASS; duplicate gate refuses PASS; fast-glob/braces absent PASS`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

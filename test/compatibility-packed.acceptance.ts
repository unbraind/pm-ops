/** Packed SDK and command acceptance across isolated npm/Bun global, local and x launchers. */
import assert from "node:assert/strict";
import * as disk from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir, devNull } from "node:os";
import { decode } from "@toon-format/toon";
import { spawnSync } from "../subprocess.ts";
import { explainCompatibility, parseCompatibilityInput } from "../compatibility-reasons.ts";
import { developmentCliVersion } from "./dependency-contract.ts";

const source = process.cwd();
const scratch = disk.mkdtempSync(join(tmpdir(), "compat-packed-"));
const hostVersion = developmentCliVersion(source);
const selectedMode = process.argv[2];
assert.ok(selectedMode === undefined || ["npm-local", "npm-global", "bun-local", "bun-global"].includes(selectedMode));
const metadata = parseCompatibilityInput(JSON.parse(disk.readFileSync("docs/examples/compatibility.json", "utf8")));
metadata.requirements[0]!.manifest = { pm_min_version: "1.0.0" };
const expected = explainCompatibility(metadata);
const baseEnvironment = { ...process.env, HOME: join(scratch, "home"), NPM_CONFIG_USERCONFIG: devNull, PM_AUTHOR: "codex-agent",
  GIT_CEILING_DIRECTORIES: dirname(scratch), PM_OPS_OFFLINE: "1" };
disk.mkdirSync(baseEnvironment.HOME);

/** Execute a real consumer command with a bounded deadline and sanitized failure reporting. */
function execute(cwd: string, program: string, args: string[], extra: NodeJS.ProcessEnv = {}): string {
  const launched = spawnSync(program, args, { cwd, env: { ...baseEnvironment, ...extra }, encoding: "utf8", timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(launched.status, 0, `${program}: ${launched.stderr}\n${launched.stdout}`);
  return launched.stdout;
}

try {
  execute(source, "npm", ["pack", "--ignore-scripts", "--pack-destination", scratch]);
  const archive = join(scratch, disk.readdirSync(scratch).find((entry) => entry.endsWith(".tgz"))!);
  let accepted = 0;
  let sdkConsumers = 0;
  for (const runtime of ["npm", "bun"] as const) {
    for (const global of [false, true]) {
      if (selectedMode !== undefined && selectedMode !== `${runtime}-${global ? "global" : "local"}`) continue;
      const project = join(scratch, `${runtime}-${global ? "global" : "local"}`); disk.mkdirSync(project);
      const prefix = join(project, "prefix");
      const context = { PM_PATH: join(project, ".agents", "pm"), PM_GLOBAL_PATH: join(project, "global-state"), BUN_INSTALL: prefix,
        BUN_INSTALL_GLOBAL_DIR: join(prefix, "modules"), BUN_INSTALL_BIN: join(prefix, "bin") };
      disk.writeFileSync(join(project, "package.json"), JSON.stringify({ name: "compat-consumer", private: true, type: "module" }));
      const initialPackage = disk.readFileSync(join(project, "package.json"));
      execute(project, runtime, runtime === "npm"
        ? ["install", ...(global ? ["--global", "--prefix", prefix] : []), "--ignore-scripts", "--no-audit", "--no-fund", archive, `@unbrained/pm-cli@${hostVersion}`]
        : ["add", ...(global ? ["--global"] : []), "--ignore-scripts", archive, `@unbrained/pm-cli@${hostVersion}`], context);
      if (global) assert.deepEqual(disk.readFileSync(join(project, "package.json")), initialPackage);
      const modules = global ? join(prefix, runtime === "npm" ? "lib/node_modules" : "modules/node_modules") : join(project, "node_modules");
      const pm = global ? join(prefix, "bin", "pm") : join(modules, ".bin", "pm");
      execute(project, pm, ["init", "--defaults", "--agent-guidance", "skip"], context);
      // Core's archive installer retains dependencies outside npm's global module discovery graph.
      execute(project, pm, ["package", "install", global ? archive : join(modules, "pm-ops"), "--project", "--json"], context);
      const input = join(project, "metadata.json"); disk.writeFileSync(input, JSON.stringify(metadata));
      const launchers = global ? [{ command: runtime === "bun" ? "bun" : pm, prefix: runtime === "bun" ? ["run", "--bun", pm] : [] }] : [
        { command: pm, prefix: [] }, { command: runtime === "npm" ? "npx" : "bunx", prefix: runtime === "npm" ? ["--no-install", "pm"] : ["--bun", "--no-install", "pm"] },
      ];
      for (const launcher of launchers) {
        for (const json of [false, true]) {
          const output = execute(project, launcher.command, [...launcher.prefix, "ops", "compatibility", "--input", input, ...(json ? ["--json"] : [])], context);
          assert.deepEqual(json ? JSON.parse(output) : decode(output), expected);
        }
        accepted++;
      }
      // The SDK resolves from the installed graph, independent of CLI executable paths.
      const probe = join(modules, "compat-sdk.mjs");
      disk.writeFileSync(probe, 'import { explainCompatibility } from "pm-ops/compatibility-reasons"; import fs from "node:fs"; console.log(JSON.stringify(explainCompatibility(JSON.parse(fs.readFileSync(process.argv[2], "utf8")))));');
      assert.deepEqual(JSON.parse(execute(project, runtime === "bun" ? "bun" : process.execPath, [probe, input], context)), expected);
      sdkConsumers++;
      assert.equal(disk.existsSync(join(project, ".git")), false);
      console.log(`${runtime} ${global ? "global" : "local + x"}: PASS`);
    }
  }
  assert.equal(accepted, selectedMode === undefined ? 6 : selectedMode.endsWith("global") ? 1 : 2);
  assert.equal(sdkConsumers, selectedMode === undefined ? 4 : 1);
  console.log(`${accepted} launch modes, ${accepted * 2} format checks, ${sdkConsumers} SDK consumers: PASS`);
} finally { disk.rmSync(resolve(scratch), { recursive: true, force: true }); }

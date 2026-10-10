/**
 * Accept the tarball under npm/Node and native Bun using disposable consumers.
 *
 * Real SDK trackers, extension activation and Git merge-driver health are
 * exercised without stubbing package behavior. npm 10 and 11 packing must
 * preserve configuration bytes. Fixture state is removed on every exit; no
 * publication or existing tracker mutation is performed. Both runtimes are
 * required when running `npm run accept:packed`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { devNull, homedir } from "node:os";
import type { HealthResult, ValidateResult } from "@unbrained/pm-cli/sdk";

const source = process.cwd();
mkdirSync(join(source, "coverage"), { recursive: true });
const root = mkdtempSync(join(source, "coverage", "packed-consumers-"));
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: join(root, "home"),
  NPM_CONFIG_USERCONFIG: devNull,
  NPM_CONFIG_CACHE: join(homedir(), ".npm"),
  PM_TELEMETRY_DISABLED: "1",
  PM_AUTHOR: "codex-sol",
  PM_OPS_OFFLINE: "1",
};
mkdirSync(env.HOME!);

/** Run one bounded consumer operation, retaining stdout for behavioral assertions. */
function run(cwd: string, program: string, args: string[], extra: NodeJS.ProcessEnv = {}): string {
  const result = spawnSync(program, args, {
    cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 180_000,
  });
  assert.equal(result.status, 0, `${program} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  console.log(program, args[0], "PASS");
  return result.stdout;
}

try {
  run(source, "npm", ["pack", "--pack-destination", root]);
  const archives = readdirSync(root).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const archive = join(root, archives[0]!);
  console.log("candidate tarball sha256", createHash("sha256").update(readFileSync(archive)).digest("hex"));
  for (const runtime of ["npm", "bun"]) {
    const cwd = join(root, runtime);
    mkdirSync(cwd);
    const context = { PM_PATH: join(cwd, ".agents/pm"), PM_GLOBAL_PATH: join(cwd, "global") };
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: "synthetic-consumer", version: "1.0.0", private: true, type: "module",
      devDependencies: { "pm-ops": `file:${archive}`, "@unbrained/pm-cli": "2026.10.9" },
      scripts: { prepare: "node scripts/prepare-merge-driver.ts" },
    }));
    run(cwd, runtime, runtime === "npm"
      ? ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"]
      : ["install", "--ignore-scripts"]);
    const pm = (args: string[]): string => runtime === "npm"
      ? run(cwd, "npx", ["--no-install", "pm", ...args], context)
      : run(cwd, "bunx", ["--bun", "--no-install", "pm", ...args], context);
    run(cwd, "git", ["init", "-q"]);
    pm(["init", "--defaults", "--agent-guidance", "skip", "--prefix", "fixture", "--json"]);
    const created: unknown = JSON.parse(pm([
      "create", "Synthetic packed acceptance", "--type", "Task",
      "--description", "Disposable publication and install fixture", "--json",
    ]));
    assert.ok(created !== null && typeof created === "object" && "id" in created && typeof created.id === "string");
    mkdirSync(join(cwd, "scripts"));
    copyFileSync(join(cwd, "node_modules/pm-ops/templates/prepare-merge-driver.ts"), join(cwd, "scripts/prepare-merge-driver.ts"));
    run(cwd, "npm", ["run", "prepare"], { ...context, npm_command: "install" });
    const health = JSON.parse(pm(["health", "--strict-exit", "--require-merge-drivers", "--json"])) as HealthResult;
    assert.equal(health.ok, true);
    const validation = JSON.parse(pm(["validate", "--json"])) as ValidateResult;
    assert.equal(validation.ok, true);
    const config = join(cwd, ".git/config");
    const before = readFileSync(config);
    run(cwd, "npm", ["pack", "--pack-destination", root], context);
    assert.deepEqual(readFileSync(config), before);
    // npm 10 executes prepare even with this flag. The shipped launcher must
    // protect configuration under the exact reported lifecycle behavior.
    run(cwd, "npx", ["--yes", "npm@10.9.4", "pack", "--ignore-scripts", "--pack-destination", root], context);
    assert.deepEqual(readFileSync(config), before);
    const program = `
import assert from "node:assert/strict";
import { auditPublishAttestation } from "pm-ops/attestation";
import extension from "pm-ops";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
const audit = auditPublishAttestation([{ file: "release.sh", text: 'npm publish --provenance\\ndeploy() { npm "$@"; }; deploy publish' }]);
assert.ok(audit.failures.length);
const quoted = auditPublishAttestation([{ file: "release.sh", text: 'npm publish --provenance\\nPUB="npm publish"; "$PUB" --provenance' }]);
assert.ok(quoted.failures.length);
assert.deepEqual(auditPublishAttestation([{ file: "release.sh", text: "npm publish --provenance" }]).failures, []);
const activation = await activateExtensionForTest(extension, { name: "pm-ops", capabilities: ["commands", "renderers", "schema", "parser", "services"] });
assert.deepEqual(activation.failed, []);
const result = await runRegisteredCommandForTest(activation.commands, { command: "ops status", pmRoot: process.env.PM_PATH, options: { repos: ["."] } });
assert.equal(result.handled, true);
console.log("packed auditor and actual SDK activation PASS");
`;
    writeFileSync(join(cwd, "smoke.mjs"), program);
    console.log(runtime, run(cwd, runtime === "npm" ? process.execPath : "bun",
      runtime === "npm" ? ["smoke.mjs"] : ["run", "smoke.mjs"], context).trim());
    console.log(runtime, "SDK 2026.10.9; create, validate, strict merge-driver health; npm 11 pack and npm 10 ignore-scripts config byte identity PASS");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

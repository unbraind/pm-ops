/** Exercise parsed caller policy and its actual command-line entry point. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { checkReleaseCaller } from "../release-caller.ts";
import { runReleaseCaller, releaseCallerMain } from "../scripts/release-caller.ts";
import { runCmd } from "./command-test-helpers.ts";

const caller = readFileSync(new URL("../templates/release-caller.yml", import.meta.url), "utf8").replaceAll("0".repeat(40), "a".repeat(40));

test("release caller accepts the rendered template and refuses embedded copies, malformed YAML and unsafe triggers", () => {
  assert.deepEqual(checkReleaseCaller(caller), []);
  const bad = ["jobs: [", "null", "jobs: []", "jobs: null", "jobs: { release: null }", "jobs: { release: { uses: wrong } }", caller.replace("contents: write", "contents: read"), caller.replace("permissions: {}", "permissions: null"), caller.replace("permissions: {}", "permissions: write-all"), caller.replace("permissions: {}", "permissions: { contents: write }"), caller.replace("      contents: write", "      packages: write\n      contents: write"), caller.replace("a".repeat(40), "0".repeat(40)), caller + "env: { PRIVATE_LOGIC: true }\n", caller.replace("  schedule:", "  pull_request:\n  schedule:"), caller.replace("  workflow_dispatch:", ""), caller.replace("    permissions:", "    secrets: inherit\n    permissions:"), caller.replace("    permissions:", "    with: { pm-ops-version: 2026.10.19 }\n    permissions:"), caller.replace(" # v2026.10.19", ""), caller.replace("permissions: {}", "permissions: {}\npermissions: {}")];
  for (const source of bad) assert.ok(checkReleaseCaller(source).length > 0, source);
  assert.ok(checkReleaseCaller(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")).length > 0);
});

test("release-caller CLI and pm-ops policy check report real package files", async () => {
  const root = mkdtempSync(join(tmpdir(), "release-caller-"));
  const previousExit = process.exitCode;
  try {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    const path = join(root, ".github/workflows/release.yml");
    writeFileSync(path, caller);
    const lines: string[] = [];
    assert.equal(runReleaseCaller(path, line => lines.push(line)), true);
    releaseCallerMain([process.execPath, new URL(import.meta.url).pathname], new URL("../scripts/release-caller.ts", import.meta.url).href);
    const moduleUrl = new URL("../scripts/release-caller.ts", import.meta.url).href;
    releaseCallerMain([process.execPath, new URL(moduleUrl).pathname, path], moduleUrl);
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      releaseCallerMain([process.execPath, new URL(moduleUrl).pathname], moduleUrl);
    } finally { process.chdir(originalCwd); }
    const ext = await createExtensionTestHarness(extension, { capabilities: ["commands", "renderers", "schema", "parser", "services"] });
    const policy = join(root, "policy.json");
    writeFileSync(policy, JSON.stringify({ checks: [{ id: "release-caller", severity: "error" }] }));
    /** Read one actual policy result through the real SDK dispatch engine. */
    const check = async () => runCmd<{ repos: { checks: { pass: boolean; message: string }[] }[] }>(ext, "ops policy", { repos: [root], policy });
    assert.equal((await check()).repos[0].checks[0].pass, true);
    writeFileSync(path, "jobs: {}");
    assert.equal(runReleaseCaller(path, line => lines.push(line)), false);
    assert.ok(lines.some(line => line.includes("exactly one")));
    releaseCallerMain([process.execPath, new URL(moduleUrl).pathname, path], moduleUrl);
    assert.equal(process.exitCode, 1);
    assert.equal((await check()).repos[0].checks[0].pass, false);
    rmSync(path);
    assert.match((await check()).repos[0].checks[0].message, /missing/);
    assert.throws(() => runReleaseCaller(path, () => {}), /ENOENT/);
  } finally {
    process.exitCode = previousExit;
    rmSync(root, { recursive: true, force: true });
  }
});

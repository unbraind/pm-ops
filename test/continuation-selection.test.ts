/** One adversarial selector corpus shared across runtime, caller, policy and attestation entry points. */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { assertContinuationSelection } from "../continuation-runtime.ts";
import { assertContinuationSelection as compiledSelection } from "../dist/continuation-runtime.js";
import { inspectReleaseCaller, checkReleaseCaller } from "../release-caller.ts";
import { auditPublishAttestation } from "../attestation.ts";
import { spawnSync } from "../subprocess.ts";
import { releaseCallerFixture } from "./canonical-tags-fixture.ts";
import { continuationSelectionCases } from "./continuation-selection-corpus.ts";
import { runCmd } from "./command-test-helpers.ts";

const { caller, releasedSha, canonical, api } = releaseCallerFixture();
const sha = "e".repeat(40), tag = "v2099.01.01";
const current = caller.replace(releasedSha, sha).replace("v2026.10.19", tag);
const cases = continuationSelectionCases();

/** Render one caller without changing its immutable workflow identity. */
function withSelection(selection: string, source = current): string {
  return source.replace("    with:", `    with:\n      node-version: ${JSON.stringify(selection)}`);
}

test("all selector and caller entry points agree with the adversarial stable-runtime oracle", () => {
  api.setTags({ ...canonical, [tag]: sha });
  try {
    for (const { selection, supported } of cases) {
      for (const validate of [assertContinuationSelection, compiledSelection]) {
        if (supported) assert.doesNotThrow(() => validate(selection), selection);
        else assert.throws(() => validate(selection), /22.18.0/, selection);
      }
      const source = withSelection(selection), tags = { [tag]: sha };
      assert.equal(inspectReleaseCaller(source, () => tags).status, supported ? "verified" : "refused", selection);
      assert.equal(checkReleaseCaller(source, tags).length === 0, supported, selection);
      const audit = auditPublishAttestation([{ file: ".github/workflows/release.yml", text: source }]);
      assert.equal(audit.failures.length === 0, supported, selection);
      assert.equal(audit.recognition.kind, supported ? "recognized" : "none", selection);
    }
    assert.equal(checkReleaseCaller(withSelection(">=20 <21", caller)).length, 0, "audited legacy workflow selectors retain their released contract");
  } finally { api.setTags(canonical); }
});

test("real SDK policy refuses every unsupported selector in a non-git project", async () => {
  const root = mkdtempSync(join(tmpdir(), "selection-policy-"));
  const ext = await createExtensionTestHarness(extension, { capabilities: ["commands", "renderers", "schema", "parser", "services"] });
  api.setTags({ [tag]: sha });
  try {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    const policy = join(root, "policy.json");
    writeFileSync(policy, JSON.stringify({ checks: [{ id: "release-caller", severity: "error" }] }));
    for (const { selection, supported } of cases) {
      writeFileSync(join(root, ".github/workflows/release.yml"), withSelection(selection));
      const result = await runCmd<{ repos: { checks: { pass: boolean; status: string }[] }[] }>(ext, "ops policy", { repos: [root], policy });
      assert.equal(result.repos[0].checks[0].pass, supported, selection);
      assert.equal(result.repos[0].checks[0].status, supported ? "verified" : "refused", selection);
    }
  } finally { api.setTags(canonical); await ext.deactivate(); rmSync(root, { recursive: true, force: true }); }
});

test("standalone caller CLI refuses unsupported ranges before offline deferral in a non-git project", () => {
  const root = mkdtempSync(join(tmpdir(), "selection-cli-"));
  const entry = new URL("../scripts/release-caller.ts", import.meta.url).pathname;
  const options = { encoding: "utf8" as const, env: { ...process.env, PM_OPS_OFFLINE: "1" } };
  try {
    const path = join(root, "release.yml");
    for (const { selection, supported } of cases.slice(0, 14)) {
      writeFileSync(path, withSelection(selection));
      const result = spawnSync(process.execPath, [entry, path], options);
      assert.equal(result.status, supported ? 0 : 1, selection + result.stderr);
      assert.match(result.stderr, supported ? /unverified-offline/ : /22.18.0/, selection);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime preflight loads from a dependency-free checkout before any selector needs semver", () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-no-dependencies-"));
  try {
    copyFileSync(new URL("../dist/continuation-runtime.js", import.meta.url), join(root, "guard.mjs"));
    const result = spawnSync(process.execPath, [join(root, "guard.mjs")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

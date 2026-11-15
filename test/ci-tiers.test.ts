/** Assert the intentional hosted PR / local deep workflow contract. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { testTime } from "./support/time.ts";

test("required jobs remain hosted and exhaustive jobs use a four-leg local matrix", () => {
  const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const deep = parse(readFileSync(".github/workflows/ci-deep.yml", "utf8"));
  assert.equal(ci.on.push, undefined);
  assert.deepEqual(ci.jobs.test.strategy.matrix["node-version"], [22, 26]);
  assert.equal(ci.jobs.test["runs-on"], "ubuntu-latest");
  for (const job of Object.values(ci.jobs) as Record<string, unknown>[]) assert.ok(Number(job["timeout-minutes"]) <= 30);
  assert.equal(ci.jobs["windows-consumers"]["runs-on"], "windows-2025");
  assert.equal(ci.jobs["release-lock"]["runs-on"], "ubuntu-latest");
  assert.match(deep.jobs.deep["runs-on"], /PM_LOCAL_DEEP.*self-hosted.*pm-local.*ubuntu-latest/);
  assert.equal(deep.jobs.deep["timeout-minutes"], 120);
  assert.deepEqual(deep.jobs.deep.strategy.matrix, { "node-version": [22, 26], "package-manager": ["npm", "bun"] });
  const gates = deep.jobs.deep.steps.filter((step: { run?: string }) => step.run?.endsWith("run release:check"));
  assert.deepEqual(gates.map((step: { run: string; if: string }) => [step.run, step.if]), [
    ["npm run release:check", "matrix.package-manager == 'npm'"],
    ["bun run release:check", "matrix.package-manager == 'bun'"],
  ]);
  assert.equal(deep.jobs.deep.env.PM_TEST_DEPTH, "full");
  assert.equal(deep.jobs.deep.env.PM_TEST_TIME_SCALE, 3);
  assert.ok(Number.isInteger(testTime(1.1)));
});

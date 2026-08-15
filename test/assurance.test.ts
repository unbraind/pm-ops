import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";
import {
  qualityMeasurementProvider,
  QUALITY_PROVIDER_ID,
} from "../assurance.ts";

/** Capability ids the harness may grant, mirroring the manifest's vocabulary. */
type TestCapability =
  | "commands"
  | "renderers"
  | "hooks"
  | "schema"
  | "importers"
  | "search"
  | "parser"
  | "preflight"
  | "services";

/** The committed manifest, so the harness grants exactly what the package ships. */
const manifest = JSON.parse(
  readFileSync(new URL("../manifest.json", import.meta.url), "utf-8"),
) as { readonly capabilities: readonly TestCapability[] };

/**
 * Minimal resolve context for direct provider calls.
 *
 * Tests bind the workspace coordinates to a temp directory rather than the
 * repository tracker, exactly as the ASSURANCE.md extension-provider guidance
 * requires: provider fixtures must never point at the live tracker.
 */
interface TestContext {
  readonly provider: string;
  readonly key: string;
  readonly parameters: Record<string, string | number | boolean | null>;
  readonly trigger: string;
  readonly pm_root: string;
  readonly repo_root: string;
}

/** Build a resolve context rooted at a temp workspace directory. */
function context(
  base: string,
  key: string,
  parameters: Record<string, string | number | boolean | null> = {},
): TestContext {
  return {
    provider: QUALITY_PROVIDER_ID,
    key,
    parameters,
    trigger: "ci",
    pm_root: join(base, ".agents", "pm"),
    repo_root: base,
  };
}

/** Resolve a key against a temp workspace and return the provider result. */
function resolve(
  base: string,
  key: string,
  parameters: Record<string, string | number | boolean | null> = {},
): {
  value: number | string[];
  population_size: number;
  cost: number;
  contributors?: string[];
} {
  return qualityMeasurementProvider.resolve(context(base, key, parameters)) as {
    value: number | string[];
    population_size: number;
    cost: number;
    contributors?: string[];
  };
}

/** Set a file's access and modification times to `secondsFromEpoch`. */
function setMtime(path: string, secondsFromEpoch: number): void {
  utimesSync(path, secondsFromEpoch, secondsFromEpoch);
}

/**
 * The canonical coverage fixture: two partially-covered files and one fully
 * covered file, so the `uncovered_files` filter exercises both its "deficient"
 * and "not deficient" branches. Counts across the whole report:
 *
 * - lines:      found 5, hit 3  -> 60%   deficient: a, b
 * - branches:   found 2, hit 1  -> 50%   deficient: a
 * - functions:  found 3, hit 2  -> 66.67% deficient: b
 * - statements: found 5, hit 3  -> 60%   deficient: a, b
 */
function writeCoverageFixture(base: string): string {
  mkdirSync(join(base, "src"), { recursive: true });
  mkdirSync(join(base, "coverage"), { recursive: true });
  writeFileSync(join(base, "src", "a.ts"), "export function foo(){return 1;}\n");
  writeFileSync(join(base, "src", "b.ts"), "export function bar(){return 2;}\n");
  writeFileSync(join(base, "src", "c.ts"), "export function baz(){return 3;}\n");
  const lcov = join(base, "coverage", "lcov.info");
  writeFileSync(lcov, [
    "SF:src/a.ts",
    "FN:1,foo",
    "FNDA:1,foo",
    "FNF:1",
    "FNH:1",
    "DA:1,1",
    "DA:2,0",
    "DA:3,1",
    "LF:3",
    "LH:2",
    "BRDA:1,0,0,1",
    "BRDA:1,0,1,0",
    "BRF:2",
    "BRH:1",
    "end_of_record",
    "SF:src/b.ts",
    "FN:1,bar",
    "FNDA:0,bar",
    "FNF:1",
    "FNH:0",
    "DA:1,0",
    "LF:1",
    "LH:0",
    "BRF:0",
    "BRH:0",
    "end_of_record",
    "SF:src/c.ts",
    "FN:1,baz",
    "FNDA:1,baz",
    "FNF:1",
    "FNH:1",
    "DA:1,1",
    "LF:1",
    "LH:1",
    "BRF:0",
    "BRH:0",
    "end_of_record",
    "",
  ].join("\n"));
  // The report must be newer than every source it covers so the staleness
  // refusal stays satisfied for the non-stale assertions below.
  const now = Math.floor(Date.now() / 1000);
  setMtime(join(base, "src", "a.ts"), now - 7_200);
  setMtime(join(base, "src", "b.ts"), now - 7_200);
  setMtime(join(base, "src", "c.ts"), now - 7_200);
  setMtime(lcov, now - 3_600);
  return lcov;
}

/** Create a temp workspace directory and register its removal for cleanup. */
const cleanup: string[] = [];
function freshWorkspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pm-ops-assurance-${prefix}-`));
  cleanup.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of cleanup) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider declares the pm-ops-quality id and four keys with the contracted shapes", () => {
  assert.strictEqual(qualityMeasurementProvider.id, "pm-ops-quality");
  assert.strictEqual(qualityMeasurementProvider.cost_class, "medium");
  assert.strictEqual(qualityMeasurementProvider.network, false);
  assert.strictEqual(qualityMeasurementProvider.timeout_ms, 30_000);
  assert.deepStrictEqual(
    Object.keys(qualityMeasurementProvider.keys).sort(),
    ["coverage-percent", "docstring-percent", "uncovered-files", "undocumented-symbols"],
  );
  assert.strictEqual(
    qualityMeasurementProvider.keys["coverage-percent"].parameters?.dimension.required,
    true,
  );
  assert.strictEqual(
    qualityMeasurementProvider.keys["coverage-percent"].value_type,
    "number",
  );
  assert.strictEqual(
    qualityMeasurementProvider.keys["uncovered-files"].value_type,
    "string_set",
  );
});

test("coverage_percent reduces each dimension to its true percentage with real population and contributors", () => {
  const base = freshWorkspace("cov-dims");
  writeCoverageFixture(base);

  const lines = resolve(base, "coverage-percent", { dimension: "lines" });
  assert.strictEqual(lines.value, 60);
  assert.strictEqual(lines.population_size, 5);
  assert.strictEqual(lines.cost, 3);
  assert.deepStrictEqual(lines.contributors, ["src/a.ts", "src/b.ts"]);

  const branches = resolve(base, "coverage-percent", { dimension: "branches" });
  assert.strictEqual(branches.value, 50);
  assert.strictEqual(branches.population_size, 2);
  assert.deepStrictEqual(branches.contributors, ["src/a.ts"]);

  const functions = resolve(base, "coverage-percent", { dimension: "functions" });
  assert.strictEqual(functions.value, 66.67);
  assert.strictEqual(functions.population_size, 3);
  assert.deepStrictEqual(functions.contributors, ["src/b.ts"]);

  const statements = resolve(base, "coverage-percent", { dimension: "statements" });
  assert.strictEqual(statements.value, 60);
  assert.strictEqual(statements.population_size, 5);
  assert.deepStrictEqual(statements.contributors, ["src/a.ts", "src/b.ts"]);
});

test("coverage_percent honours an explicit absolute report path", () => {
  const base = freshWorkspace("cov-abs");
  const lcov = writeCoverageFixture(base);
  const result = resolve(base, "coverage-percent", {
    dimension: "lines",
    report: lcov,
  });
  assert.strictEqual(result.value, 60);
  assert.strictEqual(result.population_size, 5);
});

test("uncovered_files lists only files below full coverage and reports every file as population", () => {
  const base = freshWorkspace("cov-uncovered");
  writeCoverageFixture(base);
  const result = resolve(base, "uncovered-files");
  assert.deepStrictEqual(result.value, ["src/a.ts", "src/b.ts"]);
  assert.strictEqual(result.population_size, 3);
  assert.strictEqual(result.cost, 3);
  assert.deepStrictEqual(result.contributors, ["src/a.ts", "src/b.ts"]);
});

test("coverage_percent rejects an unknown dimension value", () => {
  const base = freshWorkspace("cov-bad-dim");
  writeCoverageFixture(base);
  assert.throws(
    () => resolve(base, "coverage-percent", { dimension: "loc" }),
    /unknown coverage dimension "loc"/,
  );
});

test("coverage_percent rejects a missing required dimension parameter", () => {
  const base = freshWorkspace("cov-missing-dim");
  writeCoverageFixture(base);
  assert.throws(
    () => resolve(base, "coverage-percent", {}),
    /requires a string "dimension" parameter/,
  );
  assert.throws(
    () => resolve(base, "coverage-percent", { dimension: null }),
    /requires a string "dimension" parameter/,
  );
});

test("coverage_percent rejects a missing report file with an actionable message", () => {
  const base = freshWorkspace("cov-missing-report");
  writeCoverageFixture(base);
  assert.throws(
    () =>
      resolve(base, "coverage-percent", {
        dimension: "lines",
        report: join(base, "coverage", "absent.info"),
      }),
    /coverage report not found/,
  );
});

test("coverage_percent is deterministic and never divides by zero on a report with zero records", () => {
  const base = freshWorkspace("cov-empty");
  mkdirSync(join(base, "coverage"), { recursive: true });
  const lcov = join(base, "coverage", "lcov.info");
  writeFileSync(lcov, "\n");
  const now = Math.floor(Date.now() / 1000);
  setMtime(lcov, now);
  const result = resolve(base, "coverage-percent", { dimension: "lines" });
  assert.strictEqual(result.value, 100);
  assert.strictEqual(result.population_size, 0);
  assert.strictEqual(result.cost, 0);
  assert.deepStrictEqual(result.contributors, []);
});

test("coverage_percent parses a report whose final section omits end_of_record", () => {
  const base = freshWorkspace("cov-no-eor");
  mkdirSync(join(base, "src"), { recursive: true });
  mkdirSync(join(base, "coverage"), { recursive: true });
  writeFileSync(join(base, "src", "only.ts"), "export function z(){return 0;}\n");
  const lcov = join(base, "coverage", "lcov.info");
  // No trailing end_of_record: the parser must still flush the pending record.
  writeFileSync(
    lcov,
    [
      "SF:src/only.ts",
      "FN:1,z",
      "FNDA:1,z",
      "FNF:1",
      "FNH:1",
      "DA:1,1",
      "LF:1",
      "LH:1",
      "BRF:0",
      "BRH:0",
      "",
    ].join("\n"),
  );
  const now = Math.floor(Date.now() / 1000);
  setMtime(join(base, "src", "only.ts"), now - 3_600);
  setMtime(lcov, now);
  const result = resolve(base, "coverage-percent", { dimension: "lines" });
  assert.strictEqual(result.value, 100);
  assert.strictEqual(result.population_size, 1);
  assert.strictEqual(result.cost, 1);
});

test("coverage_percent handles absolute SF paths, DA checksum fields, and malformed DA records", () => {
  const base = freshWorkspace("cov-edges");
  mkdirSync(join(base, "coverage"), { recursive: true });
  const absSource = join(base, "abs.ts");
  writeFileSync(absSource, "export function q(){return 0;}\n");
  const lcov = join(base, "coverage", "lcov.info");
  writeFileSync(
    lcov,
    [
      `SF:${absSource}`,
      "DA:1,2,abc123", // checksum field present: the count is the second field ("2")
      "DA:5", // malformed record with no comma: counted as found, never hit
      "LF:2",
      "LH:1",
      "BRF:0",
      "BRH:0",
      "end_of_record",
      "",
    ].join("\n"),
  );
  const now = Math.floor(Date.now() / 1000);
  setMtime(absSource, now - 3_600);
  setMtime(lcov, now);
  // Two DA records, one hit (the checksum record), so statements are 50% and
  // the absolute-pathed file shows up as a deficient contributor.
  const result = resolve(base, "coverage-percent", { dimension: "statements" });
  assert.strictEqual(result.value, 50);
  assert.strictEqual(result.population_size, 2);
  assert.strictEqual(result.cost, 1);
  assert.deepStrictEqual(result.contributors, ["abs.ts"]);
});

test("coverage_percent refuses a stale report after a real source edit, and a regenerated report resolves", () => {
  const base = freshWorkspace("cov-stale");
  const lcov = writeCoverageFixture(base);
  const touched = join(base, "src", "a.ts");

  // A genuine edit — new content, stamped with a real modification time by
  // the filesystem — leaves the older report describing a tree that no longer
  // exists. No utimes tampering: the refusal below is earned by the write.
  writeFileSync(
    touched,
    "export function foo(){return 1;}\nexport function added(){return 2;}\n",
  );
  const editedMtime = statSync(touched).mtimeMs;
  const staleReportMtime = statSync(lcov).mtimeMs;
  assert.ok(
    editedMtime > staleReportMtime,
    `edited source (${editedMtime}) must be newer than the report (${staleReportMtime})`,
  );

  assert.throws(
    () => resolve(base, "coverage-percent", { dimension: "lines" }),
    (error: Error) => {
      assert.match(
        error.message,
        /refusing a stale coverage report/,
        "must name the staleness refusal",
      );
      assert.ok(
        error.message.includes("src/a.ts"),
        `must name the offending source file; got: ${error.message}`,
      );
      assert.ok(
        error.message.includes(lcov),
        `must name the report path; got: ${error.message}`,
      );
      return true;
    },
  );

  // Regenerate the report the way a real test run does: write a fresh lcov
  // that covers the edited file. Its mtime now post-dates the edit, so the
  // same measurement resolves — with numbers that moved because the report
  // moved (a.ts gained one covered line: lines 4/6 instead of 3/5).
  writeFileSync(
    lcov,
    [
      "SF:src/a.ts",
      "FN:1,foo",
      "FNDA:1,foo",
      "FN:2,added",
      "FNDA:1,added",
      "FNF:2",
      "FNH:2",
      "DA:1,1",
      "DA:2,1",
      "DA:3,0",
      "DA:4,1",
      "LF:4",
      "LH:3",
      "BRDA:1,0,0,1",
      "BRDA:1,0,1,0",
      "BRF:2",
      "BRH:1",
      "end_of_record",
      "SF:src/b.ts",
      "FN:1,bar",
      "FNDA:0,bar",
      "FNF:1",
      "FNH:0",
      "DA:1,0",
      "LF:1",
      "LH:0",
      "BRF:0",
      "BRH:0",
      "end_of_record",
      "SF:src/c.ts",
      "FN:1,baz",
      "FNDA:1,baz",
      "FNF:1",
      "FNH:1",
      "DA:1,1",
      "LF:1",
      "LH:1",
      "BRF:0",
      "BRH:0",
      "end_of_record",
      "",
    ].join("\n"),
  );
  const freshReportMtime = statSync(lcov).mtimeMs;
  assert.ok(
    freshReportMtime >= editedMtime,
    `regenerated report (${freshReportMtime}) must not be older than the edit (${editedMtime})`,
  );
  const resolved = resolve(base, "coverage-percent", { dimension: "lines" });
  assert.strictEqual(resolved.value, 66.67);
  assert.strictEqual(resolved.population_size, 6);
  assert.deepStrictEqual(resolved.contributors, ["src/a.ts", "src/b.ts"]);
});

test("coverage staleness refusal skips a source the report names but that no longer exists", () => {
  const base = freshWorkspace("cov-missing-source");
  mkdirSync(join(base, "src"), { recursive: true });
  mkdirSync(join(base, "coverage"), { recursive: true });
  // The report names src/gone.ts, which is never written to disk.
  writeFileSync(join(base, "src", "present.ts"), "export function p(){return 0;}\n");
  const lcov = join(base, "coverage", "lcov.info");
  writeFileSync(
    lcov,
    [
      "SF:src/gone.ts",
      "DA:1,1",
      "LF:1",
      "LH:1",
      "BRF:0",
      "BRH:0",
      "end_of_record",
      "SF:src/present.ts",
      "DA:1,1",
      "LF:1",
      "LH:1",
      "BRF:0",
      "BRH:0",
      "end_of_record",
      "",
    ].join("\n"),
  );
  const now = Math.floor(Date.now() / 1000);
  setMtime(join(base, "src", "present.ts"), now - 3_600);
  setMtime(lcov, now);
  // A missing file cannot be "newer"; the staleness check skips it and the
  // missing file is simply absent from the contributors (it carried no debt).
  const result = resolve(base, "coverage-percent", { dimension: "lines" });
  assert.strictEqual(result.value, 100);
  assert.strictEqual(result.population_size, 2);
});

test("docstring_percent reports the documented share with real symbol population and contributors", () => {
  const base = freshWorkspace("doc-percent");
  writeFileSync(
    join(base, "documented.ts"),
    "/** Add one to a number and return the increased value. */\nexport function increment(n) { return n + 1; }\n",
  );
  writeFileSync(join(base, "undocumented.ts"), "export function halve(n) { return n / 2; }\n");
  const result = resolve(base, "docstring-percent");
  assert.strictEqual(result.value, 50);
  assert.strictEqual(result.population_size, 2);
  assert.strictEqual(result.cost, 2);
  assert.deepStrictEqual(result.contributors, ["undocumented.ts:halve"]);
});

test("docstring_percent honours an explicit absolute root path", () => {
  const base = freshWorkspace("doc-abs");
  writeFileSync(
    join(base, "documented.ts"),
    "/** Add one to a number and return the increased value. */\nexport function increment(n) { return n + 1; }\n",
  );
  const result = resolve(base, "docstring-percent", { root: base });
  assert.strictEqual(result.value, 100);
  assert.strictEqual(result.population_size, 1);
});

test("docstring_percent reports 100 over a tree whose files declare nothing documentable", () => {
  const base = freshWorkspace("doc-empty");
  writeFileSync(join(base, "empty.ts"), "// nothing declared\n1 + 1;\n");
  const result = resolve(base, "docstring-percent");
  assert.strictEqual(result.value, 100);
  assert.strictEqual(result.population_size, 0);
  assert.strictEqual(result.cost, 0);
  assert.deepStrictEqual(result.contributors, []);
});

test("undocumented_symbols lists the path:symbol labels missing a docstring", () => {
  const base = freshWorkspace("doc-symbols");
  writeFileSync(
    join(base, "documented.ts"),
    "/** Add one to a number and return the increased value. */\nexport function increment(n) { return n + 1; }\n",
  );
  writeFileSync(join(base, "undocumented.ts"), "export function halve(n) { return n / 2; }\n");
  const result = resolve(base, "undocumented-symbols");
  assert.deepStrictEqual(result.value, ["undocumented.ts:halve"]);
  assert.strictEqual(result.population_size, 2);
  assert.strictEqual(result.cost, 2);
  assert.deepStrictEqual(result.contributors, ["undocumented.ts:halve"]);
});

test("resolve rejects a key the provider does not declare", () => {
  const base = freshWorkspace("unknown-key");
  assert.throws(
    () => resolve(base, "not_a_key"),
    /provider does not declare key "not_a_key"/,
  );
});

test("the extension registers the provider through the real host activation engine", async () => {
  // Not a hand-rolled `activate(api as any)` double: the SDK harness runs
  // pm's real registration validation and activation engine, so a malformed
  // provider definition or a manifest missing the `services` capability fails
  // here instead of being silently accepted.
  const ext = await createExtensionTestHarness(extension, {
    name: "pm-ops",
    capabilities: manifest.capabilities,
  });
  assert.deepEqual(ext.activation.failed, [], "activation must not fail");

  const providers = ext.activation.registrations.assurance_providers;
  assert.strictEqual(
    providers.length,
    1,
    "exactly one assurance measurement provider must be registered",
  );
  const [provider] = providers;
  assert.strictEqual(provider.name, "pm-ops");
  assert.strictEqual(provider.definition.id, QUALITY_PROVIDER_ID);
  assert.deepStrictEqual(
    Object.keys(provider.definition.keys).sort(),
    [
      "coverage-percent",
      "docstring-percent",
      "uncovered-files",
      "undocumented-symbols",
    ],
  );
  assert.strictEqual(
    provider.definition.keys["coverage-percent"]?.parameters?.dimension
      ?.required,
    true,
  );
  assert.strictEqual(provider.definition.cost_class, "medium");
  assert.strictEqual(provider.definition.network, false);

  // The host stores a serializable definition (resolve stringified) plus the
  // runtime definition carrying the live resolver. Invoking that registered
  // resolver through a real temp workspace proves the clone the host keeps
  // for gate dispatch is the provider this module exports.
  assert.strictEqual(typeof provider.runtime_definition.resolve, "function");
  const base = freshWorkspace("harness-resolve");
  writeCoverageFixture(base);
  const result = await provider.runtime_definition.resolve({
    provider: QUALITY_PROVIDER_ID,
    key: "coverage-percent",
    parameters: { dimension: "lines" },
    trigger: "gate",
    pm_root: join(base, ".agents", "pm"),
    repo_root: base,
  });
  assert.strictEqual(result.value, 60);
  assert.strictEqual(result.population_size, 5);

  await ext.deactivate();
});

test("workspaceBase resolves relative paths against repo_root, then source_workspace_root, then cwd", () => {
  // repo_root is the primary coordinate and is exercised by every test above;
  // here we prove the two fallbacks resolve the same fixture.
  const base = freshWorkspace("base-repo");
  writeCoverageFixture(base);

  const sourceOnlyBase = freshWorkspace("base-source");
  writeCoverageFixture(sourceOnlyBase);
  const fromSource = qualityMeasurementProvider.resolve({
    provider: QUALITY_PROVIDER_ID,
    key: "coverage-percent",
    parameters: { dimension: "lines" },
    trigger: "ci",
    pm_root: join(sourceOnlyBase, ".agents", "pm"),
    source_workspace_root: sourceOnlyBase,
  }) as { value: number };
  assert.strictEqual(fromSource.value, 60);

  // cwd fallback: chdir into a fixture workspace whose context carries no
  // workspace coordinates, so workspaceBase falls through to process.cwd().
  const cwdBase = freshWorkspace("base-cwd");
  writeCoverageFixture(cwdBase);
  const previousCwd = process.cwd();
  try {
    process.chdir(cwdBase);
    const fromCwd = qualityMeasurementProvider.resolve({
      provider: QUALITY_PROVIDER_ID,
      key: "coverage-percent",
      parameters: { dimension: "lines" },
      trigger: "ci",
      pm_root: join(cwdBase, ".agents", "pm"),
    }) as { value: number };
    assert.strictEqual(fromCwd.value, 60);
  } finally {
    process.chdir(previousCwd);
  }
});

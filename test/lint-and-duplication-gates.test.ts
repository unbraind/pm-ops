import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";

import { ESLint } from "eslint";

import { analyzeDuplication, duplicationGateDiagnostic, parseJscpdReport, runDuplicationGate } from "../duplication.ts";
import { fleetEslintConfig, runLintGate } from "../eslint.ts";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "pm-ops-lint-duplication-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Exit sentinel used to assert the duplication gate's non-zero contract. */
class GateExit extends Error {
  /** Requested process status. */
  readonly code: number;

  /** Preserve the status in the catchable test error. */
  constructor(code: number) {
    super(`gate exited ${code}`);
    this.code = code;
  }
}

/**
 * Run the duplication gate on a repository, assert it requests exit code 1
 * through the gate exit boundary, and return its collected output.
 */
async function gateFailureOutput(
  repoRoot: string,
  options: { readonly globs?: readonly string[] } = {},
): Promise<{ logs: string; errors: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  await assert.rejects(
    runDuplicationGate({
      repoRoot,
      globs: options.globs,
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
      exit: (code) => {
        throw new GateExit(code);
      },
    }),
    (error: unknown) => error instanceof GateExit && error.code === 1,
  );
  return { logs: logs.join("\n"), errors: errors.join("\n") };
}

/** Create a package fixture with the requested duplication configuration. */
function packageFixture(
  name: string,
  duplicationGate: Record<string, unknown> | null | undefined,
): string {
  const directory = join(root, name);
  mkdirSync(join(directory, "src"), { recursive: true });
  const manifest = duplicationGate === undefined ? {} : { duplicationGate };
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest)}\n`);
  return directory;
}

/** Write a token-rich source block that jscpd can recognize with its real detector. */
function duplicateSources(directory: string, secondDirectory = "src"): void {
  const source = [
    "export function repeatedValue(): number {",
    "  const firstValue = 1;",
    "  const secondValue = 2;",
    "  const thirdValue = 3;",
    "  const fourthValue = 4;",
    "  const fifthValue = 5;",
    "  const sixthValue = 6;",
    "  const seventhValue = 7;",
    "  const eighthValue = 8;",
    "  return firstValue + secondValue + thirdValue + fourthValue + fifthValue + sixthValue + seventhValue + eighthValue;",
    "}",
  ].join("\n") + "\n";
  mkdirSync(join(directory, secondDirectory), { recursive: true });
  writeFileSync(join(directory, "src", "first.ts"), source);
  writeFileSync(join(directory, secondDirectory, "second.ts"), source);
}

/** Build a clone-containing source file larger than jscpd's historical line limit. */
function largeDuplicateSources(directory: string): void {
  const block = [
    "export function largeRepeatedValue(): number {",
    "  const firstLargeValue = 1;",
    "  const secondLargeValue = 2;",
    "  const thirdLargeValue = 3;",
    "  return firstLargeValue + secondLargeValue + thirdLargeValue;",
    "}",
  ].join("\n");
  const filler = Array.from(
    { length: 1500 },
    (_, index) => `export const fillerValue${index} = ${index};`,
  ).join("\n");
  writeFileSync(join(directory, "src", "large.ts"), `${filler}\n${block}\n${block}\n`);
  writeFileSync(join(directory, "src", "large-companion.ts"), `${block}\n`);
}

/** Create one TypeScript file for each syntax selector in the canonical policy. */
function forbiddenSyntaxFixture(directory: string): void {
  const fixtures: Record<string, string> = {
    explicitAny: "export const value: any = 1;\n",
    dynamicImport: "const value = import(\"./value.ts\"); export { value };\n",
    inlineImportType: "type Value = import(\"./value.ts\").Value; export type { Value };\n",
    parameterProperty: "class Value { constructor(public readonly value: string) {} } export { Value };\n",
    enum: "enum Value { one } export { Value };\n",
    namespace: "namespace Value { export const one = 1; } export { Value };\n",
    importEquals: "import Value = require(\"./value\"); export { Value };\n",
    exportEquals: "const value = 1; export = value;\n",
  };
  for (const [name, source] of Object.entries(fixtures)) {
    writeFileSync(join(directory, `${name}.ts`), source);
  }
}

test("fleet ESLint config reports every forbidden syntax with its canonical message", async () => {
  const directory = join(root, "forbidden-syntax");
  mkdirSync(directory, { recursive: true });
  forbiddenSyntaxFixture(directory);
  const eslint = new ESLint({
    cwd: directory,
    overrideConfigFile: true,
    overrideConfig: fleetEslintConfig(),
  });
  const results = await eslint.lintFiles(["."]);
  const messages = results.flatMap((result) => result.messages.map((message) => message.message));
  const expected = [
    "Use a precise type instead of explicit any.",
    "Dynamic imports are forbidden; use a top-level import.",
    "Inline type imports are forbidden; use a top-level type import.",
    "Parameter properties require non-erasable emit.",
    "Enums require non-erasable emit; use literal unions.",
    "Namespaces and TypeScript modules are forbidden.",
    "Import-equals syntax is forbidden.",
    "Export-equals syntax is forbidden.",
  ];
  for (const message of expected) assert.ok(messages.includes(message), message);
  assert.ok(messages.length >= expected.length);
});

test("fleet ESLint config accepts clean TypeScript and appends consumer ignores", async () => {
  const directory = join(root, "clean-lint");
  mkdirSync(join(directory, "generated"), { recursive: true });
  writeFileSync(join(directory, "index.ts"), "export const value: string = \"clean\";\n");
  writeFileSync(join(directory, "generated", "bad.ts"), "export const value: any = 1;\n");
  writeFileSync(join(directory, "babel.config.json"), JSON.stringify({ plugins: ["./missing-babel-plugin.cjs"] }));
  const config = fleetEslintConfig({ ignores: ["generated/**"] });
  assert.deepEqual(config[0]?.ignores, [".agents/**", "coverage/**", "dist/**", "dist-test/**", "node_modules/**", "generated/**"]);
  const eslint = new ESLint({ cwd: directory, overrideConfigFile: true, overrideConfig: config });
  const results = await eslint.lintFiles(["."]);
  assert.deepEqual(results.flatMap((result) => result.messages), []);
  assert.equal(await runLintGate({ cwd: directory, files: ["."], ignores: ["generated/**"] }), 0);
});

test("duplication analyzer finds clone ranges and honors multiple source globs", async () => {
  const directory = packageFixture("clone-analysis", { threshold: 0, minTokens: 20 });
  duplicateSources(directory, "test");
  const report = await analyzeDuplication({
    repoRoot: directory,
    globs: ["src/**/*.ts", "test/**/*.ts"],
    minTokens: 20,
  });
  assert.ok(report.percentage > 0);
  assert.equal(report.sources, 2);
  assert.deepEqual(report.skippedSources, []);
  assert.equal(report.cloneCount, 1);
  assert.equal(report.clones[0]?.first.file, "src/first.ts");
  assert.equal(report.clones[0]?.second.file, "test/second.ts");
  assert.equal(report.clones[0]?.first.startLine, 1);
  assert.equal(report.clones[0]?.second.endLine, 11);
  const defaultRootReport = await analyzeDuplication({ globs: ["eslint.ts"] });
  assert.ok(defaultRootReport.totalLines > 0);
  const defaultTokenReport = await analyzeDuplication({ repoRoot: directory, globs: ["src/**/*.ts"] });
  assert.ok(defaultTokenReport.totalLines > 0);
});

test("duplication scope diagnostics fail closed for empty and skipped sources", () => {
  assert.equal(
    duplicationGateDiagnostic({ sources: 0, skippedSources: [] }),
    "duplication-gate: no TypeScript sources were analyzed for the configured glob scope.",
  );
  assert.equal(
    duplicationGateDiagnostic({ sources: 1, skippedSources: ["src/skipped.ts", "test/skipped.ts"] }),
    "duplication-gate: jscpd skipped 2 in-scope file(s):\n  src/skipped.ts\n  test/skipped.ts",
  );
  assert.equal(duplicationGateDiagnostic({ sources: 1, skippedSources: [] }), undefined);
});

test("duplication gate fails with both clone ranges and passes a clean fixture", async () => {
  const duplicate = packageFixture("clone-failure", { threshold: 0, minTokens: 20 });
  duplicateSources(duplicate);
  const failure = await gateFailureOutput(duplicate);
  assert.match(failure.logs, /src\/first\.ts:1-11 <-> src\/second\.ts:1-11/);
  assert.match(failure.errors, /exceeds the configured 0% threshold/);

  const clean = packageFixture("clone-pass", { threshold: 0 });
  writeFileSync(join(clean, "src", "one.ts"), "export const one = 1;\n");
  const cleanLogs: string[] = [];
  await runDuplicationGate({ repoRoot: clean, log: (message) => cleanLogs.push(message) });
  assert.match(cleanLogs.join("\n"), /0% duplicated lines/);
});

test("duplication gate excludes generated PM extension copies but keeps tracked source in scope", async () => {
  const directory = packageFixture("installed-pm-extension", { threshold: 0, minTokens: 20 });
  duplicateSources(directory, ".agents/pm/extensions/pm-ops");
  const report = await analyzeDuplication({ repoRoot: directory, minTokens: 20 });
  assert.equal(report.sources, 1);
  assert.ok(report.totalLines > 0);
  assert.equal(report.cloneCount, 0);
  assert.deepEqual(report.skippedSources, []);
  const logs: string[] = [];
  await runDuplicationGate({ repoRoot: directory, log: (message) => logs.push(message) });
  assert.match(logs.join("\n"), /1 source\(s\)/);
});

test("duplication gate analyzes large files and rejects empty scopes", async () => {
  const large = packageFixture("large-clone", { threshold: 0, minTokens: 20 });
  largeDuplicateSources(large);
  const largeFailure = await gateFailureOutput(large);
  assert.match(largeFailure.logs, /2 source\(s\)/);
  assert.match(largeFailure.errors, /exceeds the configured 0% threshold/);

  const empty = packageFixture("empty-scope", { threshold: 0 });
  const emptyFailure = await gateFailureOutput(empty, { globs: ["src/**/*.ts"] });
  assert.match(emptyFailure.errors, /no TypeScript sources were analyzed/);
});

test("duplication gate fails closed for missing, malformed, unreadable, and empty glob configuration", async () => {
  const messages: string[] = [];
  const missing = packageFixture("missing-duplication-config", undefined);
  messages.push((await gateFailureOutput(missing)).errors);
  assert.match(messages.join("\n"), /no `duplicationGate` block/);

  const malformed = packageFixture("malformed-duplication-config", { threshold: -1 });
  messages.push((await gateFailureOutput(malformed)).errors);
  assert.match(messages.join("\n"), /invalid `duplicationGate`/);

  const invalidShape = packageFixture("invalid-duplication-shape", null);
  messages.push((await gateFailureOutput(invalidShape)).errors);

  const invalidTokens = packageFixture("invalid-min-tokens", { threshold: 0, minTokens: 0 });
  messages.push((await gateFailureOutput(invalidTokens)).errors);

  const missingManifest = join(root, "missing-manifest");
  mkdirSync(missingManifest);
  messages.push((await gateFailureOutput(missingManifest)).errors);
  assert.match(messages.join("\n"), /could not read package\.json/);

  const emptyGlob = packageFixture("empty-glob", { threshold: 0 });
  messages.push((await gateFailureOutput(emptyGlob, { globs: [] })).errors);
  assert.match(messages.join("\n"), /at least one source glob/);
});


/** Create a package fixture whose `jscpd` dependency is the real jscpd 4 package. */
function jscpd4Fixture(name: string, duplicationGate: Record<string, unknown>): string {
  const directory = packageFixture(name, duplicationGate);
  mkdirSync(join(directory, "node_modules"), { recursive: true });
  symlinkSync(
    resolve(import.meta.dirname, "../node_modules/jscpd4"),
    join(directory, "node_modules", "jscpd"),
    "dir",
  );
  return directory;
}

test("duplication analyzer reports the same clone pairs through the real jscpd 4 and jscpd 5 engines", async () => {
  const v4 = jscpd4Fixture("engine-parity-v4", { threshold: 0, minTokens: 20 });
  duplicateSources(v4, "test");
  const v5 = packageFixture("engine-parity-v5", { threshold: 0, minTokens: 20 });
  duplicateSources(v5, "test");
  const globs = ["src/**/*.ts", "test/**/*.ts"];
  const report4 = await analyzeDuplication({ repoRoot: v4, globs, minTokens: 20 });
  const report5 = await analyzeDuplication({ repoRoot: v5, globs, minTokens: 20 });
  assert.deepEqual(report5.clones, report4.clones);
  assert.equal(report4.cloneCount, 1);
  assert.equal(report4.sources, 2);
  assert.equal(report5.sources, 2);
  assert.deepEqual(report4.skippedSources, []);
  assert.deepEqual(report5.skippedSources, []);
  assert.equal(report4.clones[0]?.first.startLine, 1);
  assert.equal(report4.clones[0]?.second.endLine, 11);

  const empty4 = await analyzeDuplication({ repoRoot: v4, globs: ["nope/**/*.ts"] });
  assert.equal(empty4.sources, 0);
  assert.deepEqual(empty4.skippedSources, []);
  assert.equal(empty4.percentage, 0);

  const gate = await gateFailureOutput(v4, { globs });
  assert.match(gate.errors, /exceeds the configured 0% threshold/);
});

test("duplication gate fails closed when the real jscpd 5 binary package is missing", async () => {
  const broken = packageFixture("jscpd5-missing-platform", { threshold: 0 });
  mkdirSync(join(broken, "node_modules"), { recursive: true });
  cpSync(
    resolve(import.meta.dirname, "../node_modules/jscpd"),
    join(broken, "node_modules", "jscpd"),
    { recursive: true },
  );
  writeFileSync(join(broken, "src", "first.ts"), "export const one = 1;\n");
  const gate = await gateFailureOutput(broken);
  assert.match(gate.errors, /jscpd analysis failed/);
  assert.match(gate.errors, /exited with status 1/);
});

test("jscpd 5 report parsing accepts a real report shape and fails closed for malformed ones", () => {
  const clone = {
    firstFile: { name: "/repo/src/first.ts", start: 1, end: 11 },
    secondFile: { name: "/repo/test/second.ts", start: 1, end: 11 },
  };
  const statistics = { total: { lines: 22, duplicatedLines: 11 } };
  const parsed = parseJscpdReport({ duplicates: [clone], statistics });
  assert.equal(parsed.duplicates.length, 1);
  assert.equal(parsed.duplicates[0]?.firstFile.name, "/repo/src/first.ts");
  assert.equal(parsed.statistics.total.lines, 22);
  const malformed: unknown[] = [
    null,
    "report",
    { duplicates: "no", statistics },
    { duplicates: [null], statistics },
    { duplicates: [{ firstFile: null, secondFile: clone.secondFile }], statistics },
    { duplicates: [{ firstFile: { name: 1, start: 1, end: 2 }, secondFile: clone.secondFile }], statistics },
    { duplicates: [{ firstFile: { name: "a.ts", start: "1", end: 2 }, secondFile: clone.secondFile }], statistics },
    { duplicates: [{ firstFile: { name: "a.ts", start: Number.NaN, end: 2 }, secondFile: clone.secondFile }], statistics },
    { duplicates: [clone], statistics: null },
    { duplicates: [clone], statistics: { total: null } },
    { duplicates: [clone], statistics: { total: { lines: "22", duplicatedLines: 11 } } },
    { duplicates: [clone], statistics: { total: { lines: 22 } } },
    { duplicates: [clone], statistics: { total: { lines: 0, duplicatedLines: 1 } } },
    { duplicates: [clone], statistics: { total: { lines: 22, duplicatedLines: -1 } } },
    { duplicates: [clone], statistics: { total: { lines: 22.5, duplicatedLines: 11 } } },
    { duplicates: [clone], statistics: { total: { lines: 22, duplicatedLines: 1.5 } } },
  ];
  for (const report of malformed) assert.throws(() => parseJscpdReport(report), /jscpd report/);
});

test("direct gate launchers preserve success and failure statuses", async () => {
  const duplicationScript = resolve(import.meta.dirname, "../scripts/duplication-gate.ts");
  const clean = packageFixture("launcher-pass", { threshold: 0 });
  writeFileSync(join(clean, "src", "one.ts"), "export const one = 1;\n");
  const success = spawnSync(process.execPath, [duplicationScript], { cwd: clean, encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /0% duplicated lines/);

  const lintScript = resolve(import.meta.dirname, "../scripts/lint.ts");
  const lintClean = join(root, "launcher-lint-pass");
  mkdirSync(lintClean);
  symlinkSync(resolve(import.meta.dirname, "../node_modules"), join(lintClean, "node_modules"), "dir");
  writeFileSync(join(lintClean, "index.ts"), "export const value: string = \"ok\";\n");
  const lintSuccess = spawnSync(process.execPath, [lintScript], { cwd: lintClean, encoding: "utf8" });
  assert.equal(lintSuccess.status, 0, lintSuccess.stderr);

  const lintDirty = join(root, "launcher-lint-fail");
  mkdirSync(lintDirty);
  symlinkSync(resolve(import.meta.dirname, "../node_modules"), join(lintDirty, "node_modules"), "dir");
  writeFileSync(join(lintDirty, "index.ts"), "export const value: any = 1;\n");
  assert.equal(await runLintGate({ cwd: lintDirty, files: ["."] }), 1);
  const lintFailure = spawnSync(process.execPath, [lintScript], { cwd: lintDirty, encoding: "utf8" });
  assert.equal(lintFailure.status, 1);
  assert.match(lintFailure.stderr, /Use a precise type instead of explicit any/);
});

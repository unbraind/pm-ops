import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";

import { ESLint } from "eslint";

import { analyzeDuplication, runDuplicationGate } from "../duplication.ts";
import { fleetEslintConfig } from "../eslint.ts";

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
  const config = fleetEslintConfig({ ignores: ["generated/**"] });
  assert.deepEqual(config[0]?.ignores, [".agents/**", "coverage/**", "dist/**", "dist-test/**", "node_modules/**", "generated/**"]);
  const eslint = new ESLint({ cwd: directory, overrideConfigFile: true, overrideConfig: config });
  const results = await eslint.lintFiles(["."]);
  assert.deepEqual(results.flatMap((result) => result.messages), []);
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

test("duplication gate fails with both clone ranges and passes a clean fixture", async () => {
  const duplicate = packageFixture("clone-failure", { threshold: 0, minTokens: 20 });
  duplicateSources(duplicate);
  const logs: string[] = [];
  const errors: string[] = [];
  await assert.rejects(
    runDuplicationGate({
      repoRoot: duplicate,
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
      exit: (code) => {
        throw new GateExit(code);
      },
    }),
    (error: unknown) => error instanceof GateExit && error.code === 1,
  );
  assert.match(logs.join("\n"), /src\/first\.ts:1-11 <-> src\/second\.ts:1-11/);
  assert.match(errors.join("\n"), /exceeds the configured 0% threshold/);

  const clean = packageFixture("clone-pass", { threshold: 0 });
  writeFileSync(join(clean, "src", "one.ts"), "export const one = 1;\n");
  const cleanLogs: string[] = [];
  await runDuplicationGate({ repoRoot: clean, log: (message) => cleanLogs.push(message) });
  assert.match(cleanLogs.join("\n"), /0% duplicated lines/);
});

test("duplication gate fails closed for missing, malformed, unreadable, and empty glob configuration", async () => {
  const missing = packageFixture("missing-duplication-config", undefined);
  const messages: string[] = [];
  await assert.rejects(
    runDuplicationGate({
      repoRoot: missing,
      error: (message) => messages.push(message),
      exit: (code) => {
        throw new GateExit(code);
      },
    }),
    (error: unknown) => error instanceof GateExit && error.code === 1,
  );
  assert.match(messages.join("\n"), /no `duplicationGate` block/);

  const malformed = packageFixture("malformed-duplication-config", { threshold: -1 });
  await assert.rejects(
    runDuplicationGate({
      repoRoot: malformed,
      error: (message) => messages.push(message),
      exit: (code) => {
        throw new GateExit(code);
      },
    }),
    GateExit,
  );
  assert.match(messages.join("\n"), /invalid `duplicationGate`/);

  const invalidShape = packageFixture("invalid-duplication-shape", null);
  await assert.rejects(
    runDuplicationGate({
      repoRoot: invalidShape,
      error: (message) => messages.push(message),
      exit: (code) => {
        throw new GateExit(code);
      },
    }),
    GateExit,
  );

  const invalidTokens = packageFixture("invalid-min-tokens", { threshold: 0, minTokens: 0 });
  await assert.rejects(
    runDuplicationGate({
      repoRoot: invalidTokens,
      error: (message) => messages.push(message),
      exit: (code) => {
        throw new GateExit(code);
      },
    }),
    GateExit,
  );

  const missingManifest = join(root, "missing-manifest");
  mkdirSync(missingManifest);
  await assert.rejects(
    runDuplicationGate({
      repoRoot: missingManifest,
      error: (message) => messages.push(message),
      exit: (code) => {
        throw new GateExit(code);
      },
    }),
    GateExit,
  );
  assert.match(messages.join("\n"), /could not read package\.json/);

  const emptyGlob = packageFixture("empty-glob", { threshold: 0 });
  await assert.rejects(
    runDuplicationGate({
      repoRoot: emptyGlob,
      globs: [],
      error: (message) => messages.push(message),
      exit: (code) => {
        throw new GateExit(code);
      },
    }),
    GateExit,
  );
  assert.match(messages.join("\n"), /at least one source glob/);
});

test("direct gate launchers preserve success and failure statuses", () => {
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
  const lintFailure = spawnSync(process.execPath, [lintScript], { cwd: lintDirty, encoding: "utf8" });
  assert.equal(lintFailure.status, 1);
  assert.match(lintFailure.stderr, /Use a precise type instead of explicit any/);
});

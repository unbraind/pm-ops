import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";

import { runCoverageGate } from "../scripts/coverage-gate.ts";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "pm-ops-coverage-gate-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Exit sentinel used to assert fail-closed paths without terminating the suite. */
class GateExit extends Error {
  /** Process status the gate requested. */
  readonly code: number;

  /** Preserve the requested exit status for assertions. */
  constructor(code: number) {
    super(`coverage gate exited ${code}`);
    this.code = code;
  }
}

/** Construct one isolated package fixture with the requested coverage configuration. */
function fixture(name: string, coverageGate: Record<string, unknown> | null = {
  sources: ["src"],
  tests: ["test/*.test.ts"],
  thresholds: { statements: 100, lines: 100, branches: 100, functions: 100 },
  ignore: [],
}): string {
  const directory = join(root, name);
  mkdirSync(join(directory, "src", "nested"), { recursive: true });
  writeFileSync(
    join(directory, "src", "index.ts"),
    "export const value = 1;\n",
  );
  writeFileSync(
    join(directory, "src", "nested", "worker.ts"),
    "export const worker = 2;\n",
  );
  writeFileSync(
    join(directory, "src", "types.d.ts"),
    "export interface Value {}\n",
  );
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify(coverageGate === null ? {} : { coverageGate })}\n`,
  );
  return directory;
}

/** Build a deterministic spawn result matching Node's synchronous child contract. */
function spawnResult(
  overrides: Partial<SpawnSyncReturns<string>> = {},
): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  };
}

/** Turn the gate's process boundary into a catchable exception. */
function exit(code: number): never {
  throw new GateExit(code);
}

/** Write an lcov source-file list for the fixture package. */
function writeLcov(directory: string, files: readonly string[]): void {
  mkdirSync(join(directory, "coverage"), { recursive: true });
  writeFileSync(
    join(directory, "coverage", "lcov.info"),
    `${files.map((file) => `SF:${file}\nend_of_record`).join("\n")}\n`,
  );
}

/** Assert that one failing fixture appended exactly its expected diagnostic. */
function assertSingleDiagnostic(messages: readonly string[], before: number, expected: RegExp): void {
  assert.strictEqual(messages.length, before + 1);
  assert.match(messages[before], expected);
}

test("coverage gate accepts a complete report and forwards all four exact thresholds", () => {
  const directory = fixture("complete");
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawn = ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    writeLcov(directory, [
      "src/index.ts",
      resolve(directory, "src/nested/worker.ts"),
    ]);
    return spawnResult();
  }) as unknown as typeof spawnSync;

  runCoverageGate({ repoRoot: directory, spawn, exit });
  assert.strictEqual(calls.length, 1);
  for (const flag of ["--statements", "--branches", "--functions", "--lines"]) {
    const index = calls[0].args.indexOf(flag);
    assert.notStrictEqual(index, -1);
    assert.strictEqual(calls[0].args[index + 1], "100");
  }
  assert.ok(calls[0].args.includes("--per-file"));
  assert.deepStrictEqual(
    calls[0].args.filter((arg) => arg === "--include").length,
    2,
  );
});

test("coverage gate defaults to its package root and native process boundaries", () => {
  const packageRoot = resolve(import.meta.dirname, "..");
  const spawn = (() => {
    writeLcov(packageRoot, [
      "index.ts",
      "docstrings.ts",
      "assurance.ts",
      "scripts/coverage-gate.ts",
      "scripts/docstring-gate.ts",
      "scripts/prepare-merge-driver.ts",
      "scripts/verify-release-changelog-date.ts",
      "scripts/verify-release-publish-attestation.ts",
    ]);
    return spawnResult();
  }) as unknown as typeof spawnSync;
  try {
    runCoverageGate({ spawn, exit });
  } finally {
    rmSync(join(packageRoot, "coverage", "lcov.info"), { force: true });
  }
});

test("coverage gate direct entrypoint executes against an explicit package root", () => {
  const directory = fixture("direct-entry", {
    sources: ["src/index.ts"],
    tests: [],
    thresholds: { statements: 100, lines: 100, branches: 100, functions: 100 },
  });
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(
      join(bin, "npx.cmd"),
      `@echo off\r\nmkdir coverage 2>nul\r\n(echo SF:src/index.ts& echo end_of_record)>coverage\\lcov.info\r\n`,
    );
  } else {
    writeFileSync(
      join(bin, "npx"),
      "#!/usr/bin/env sh\nmkdir -p coverage\nprintf 'SF:src/index.ts\\nend_of_record\\n' > coverage/lcov.info\n",
    );
    chmodSync(join(bin, "npx"), 0o755);
  }
  const result = spawnSync(process.execPath, [
    resolve(import.meta.dirname, "../scripts/coverage-gate.ts"),
    directory,
  ], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${
        process.env.PATH ?? ""
      }`,
    },
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 source file\(s\) reported/);

  if (process.platform === "win32") {
    writeFileSync(
      join(bin, "npx.cmd"),
      `@echo off\r\nmkdir coverage 2>nul\r\n(echo SF:index.ts& echo end_of_record& echo SF:docstrings.ts& echo end_of_record& echo SF:assurance.ts& echo end_of_record& echo SF:scripts/coverage-gate.ts& echo end_of_record& echo SF:scripts/docstring-gate.ts& echo end_of_record& echo SF:scripts/prepare-merge-driver.ts& echo end_of_record& echo SF:scripts/verify-release-changelog-date.ts& echo end_of_record& echo SF:scripts/verify-release-publish-attestation.ts& echo end_of_record)>coverage\\lcov.info\r\n`,
    );
  } else {
    writeFileSync(
      join(bin, "npx"),
      "#!/usr/bin/env sh\nmkdir -p coverage\nprintf 'SF:index.ts\\nend_of_record\\nSF:docstrings.ts\\nend_of_record\\nSF:assurance.ts\\nend_of_record\\nSF:scripts/coverage-gate.ts\\nend_of_record\\nSF:scripts/docstring-gate.ts\\nend_of_record\\nSF:scripts/prepare-merge-driver.ts\\nend_of_record\\nSF:scripts/verify-release-changelog-date.ts\\nend_of_record\\nSF:scripts/verify-release-publish-attestation.ts\\nend_of_record\\n' > coverage/lcov.info\n",
    );
  }
  const packageRoot = resolve(import.meta.dirname, "..");
  try {
    const defaultRoot = spawnSync(process.execPath, [
      resolve(import.meta.dirname, "../scripts/coverage-gate.ts"),
    ], {
      cwd: packageRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${
          process.env.PATH ?? ""
        }`,
      },
    });
    assert.strictEqual(defaultRoot.status, 0, defaultRoot.stderr);
  } finally {
    rmSync(join(packageRoot, "coverage", "lcov.info"), { force: true });
  }
});

test("coverage gate rejects missing configuration and invalid or empty source declarations", (context) => {
  const messages: string[] = [];
  context.mock.method(
    console,
    "error",
    (...args: unknown[]) => messages.push(args.join(" ")),
  );

  let before = messages.length;
  assert.throws(
    () => runCoverageGate({ repoRoot: fixture("no-config", null), exit }),
    GateExit,
  );
  assertSingleDiagnostic(messages, before, /no `coverageGate` block/);

  const missing = fixture("missing-source", {
    sources: ["missing"],
    tests: [],
    thresholds: { statements: 100, lines: 100, branches: 100, functions: 100 },
  });
  before = messages.length;
  assert.throws(() => runCoverageGate({ repoRoot: missing, exit }), GateExit);
  assertSingleDiagnostic(messages, before, /does not exist/);

  const invalid = fixture("invalid-source", {
    sources: ["package.json"],
    tests: [],
    thresholds: { statements: 100, lines: 100, branches: 100, functions: 100 },
  });
  before = messages.length;
  assert.throws(() => runCoverageGate({ repoRoot: invalid, exit }), GateExit);
  assertSingleDiagnostic(messages, before, /not a TypeScript source/);

  const declaration = fixture("declaration-source", {
    sources: ["src/types.d.ts"],
    tests: [],
    thresholds: { statements: 100, lines: 100, branches: 100, functions: 100 },
  });
  before = messages.length;
  assert.throws(
    () => runCoverageGate({ repoRoot: declaration, exit }),
    GateExit,
  );
  assertSingleDiagnostic(messages, before, /not a TypeScript source/);

  const empty = fixture("empty-source", {
    sources: [],
    tests: [],
    thresholds: { statements: 100, lines: 100, branches: 100, functions: 100 },
  });
  before = messages.length;
  assert.throws(() => runCoverageGate({ repoRoot: empty, exit }), GateExit);
  assertSingleDiagnostic(messages, before, /source walk found no files/);
});

test("coverage gate diagnoses unreadable and malformed package manifests", (context) => {
  const messages: string[] = [];
  context.mock.method(console, "error", (...args: unknown[]) => messages.push(args.join(" ")));
  const missing = join(root, "missing-manifest");
  mkdirSync(missing);
  let before = messages.length;
  assert.throws(() => runCoverageGate({ repoRoot: missing, exit }), GateExit);
  assertSingleDiagnostic(messages, before, /could not read package\.json/);

  const malformed = join(root, "malformed-manifest");
  mkdirSync(malformed);
  writeFileSync(join(malformed, "package.json"), "not-json\n");
  before = messages.length;
  assert.throws(() => runCoverageGate({ repoRoot: malformed, exit }), GateExit);
  assertSingleDiagnostic(messages, before, /could not read package\.json/);
});

test("coverage gate rejects runner launch failures and non-zero test or threshold results", (context) => {
  context.mock.method(console, "error", () => undefined);
  const directory = fixture("runner-failures");
  const launchFailure = (() =>
    spawnResult({
      error: new Error("cannot launch"),
      status: null,
    })) as unknown as typeof spawnSync;
  assert.throws(
    () => runCoverageGate({ repoRoot: directory, spawn: launchFailure, exit }),
    (error: unknown) => error instanceof GateExit && error.code === 1,
  );

  for (const status of [2, null]) {
    const failed = (() =>
      spawnResult({ status })) as unknown as typeof spawnSync;
    assert.throws(
      () => runCoverageGate({ repoRoot: directory, spawn: failed, exit }),
      (error: unknown) =>
        error instanceof GateExit && error.code === (status ?? 1),
    );
  }
});

test("coverage gate rejects absent and incomplete lcov reports", (context) => {
  const messages: string[] = [];
  context.mock.method(
    console,
    "error",
    (...args: unknown[]) => messages.push(args.join(" ")),
  );

  const absent = fixture("absent-report");
  const noReport = (() => spawnResult()) as unknown as typeof spawnSync;
  let before = messages.length;
  assert.throws(
    () => runCoverageGate({ repoRoot: absent, spawn: noReport, exit }),
    GateExit,
  );
  assertSingleDiagnostic(messages, before, /no coverage report/);

  const incomplete = fixture("incomplete-report");
  const omitted = (() => {
    writeLcov(incomplete, ["src/index.ts"]);
    return spawnResult();
  }) as unknown as typeof spawnSync;
  before = messages.length;
  assert.throws(
    () => runCoverageGate({ repoRoot: incomplete, spawn: omitted, exit }),
    GateExit,
  );
  assertSingleDiagnostic(messages, before, /never loaded during the run/);
});

test("coverage gate verifies type-only ignores against effective compiler output", (context) => {
  const messages: string[] = [];
  context.mock.method(
    console,
    "error",
    (...args: unknown[]) => messages.push(args.join(" ")),
  );
  const config = {
    sources: ["src"],
    tests: [],
    thresholds: { statements: 100, lines: 100, branches: 100, functions: 100 },
    ignore: ["src/nested/worker.ts"],
  };

  const outside = fixture("ignore-outside", {
    ...config,
    ignore: ["other.ts"],
  });
  const showConfig = (() =>
    spawnResult({
      stdout: JSON.stringify({
        compilerOptions: { outDir: "dist", rootDir: "." },
      }),
    })) as unknown as typeof spawnSync;
  let before = messages.length;
  assert.throws(
    () => runCoverageGate({ repoRoot: outside, spawn: showConfig, exit }),
    GateExit,
  );
  assertSingleDiagnostic(messages, before, /not under `sources`/);

  for (
    const [name, result] of [
      [
        "show-config-stderr",
        spawnResult({ status: 1, stderr: "compiler unavailable" }),
      ],
      ["show-config-silent", spawnResult({ status: 1 })],
    ] as const
  ) {
    const directory = fixture(name, config);
    const failedConfig = (() => result) as unknown as typeof spawnSync;
    before = messages.length;
    assert.throws(
      () => runCoverageGate({ repoRoot: directory, spawn: failedConfig, exit }),
      GateExit,
    );
    assertSingleDiagnostic(messages, before, /could not resolve the effective tsconfig/);
  }

  const invalidConfig = fixture("show-config-invalid-json", config);
  const invalidJson = (() => spawnResult({ stdout: "not-json" })) as unknown as typeof spawnSync;
  before = messages.length;
  assert.throws(
    () => runCoverageGate({ repoRoot: invalidConfig, spawn: invalidJson, exit }),
    GateExit,
  );
  assertSingleDiagnostic(messages, before, /tsc --showConfig returned invalid JSON/);

  const missingEmit = fixture("ignore-missing-emit", config);
  before = messages.length;
  assert.throws(
    () => runCoverageGate({ repoRoot: missingEmit, spawn: showConfig, exit }),
    GateExit,
  );
  assertSingleDiagnostic(messages, before, /no compiled output/);

  const runtimeEmit = fixture("ignore-runtime-emit", config);
  mkdirSync(join(runtimeEmit, "dist", "src", "nested"), { recursive: true });
  writeFileSync(
    join(runtimeEmit, "dist", "src", "nested", "worker.js"),
    "export const worker = 2;\n",
  );
  before = messages.length;
  assert.throws(
    () => runCoverageGate({ repoRoot: runtimeEmit, spawn: showConfig, exit }),
    GateExit,
  );
  assertSingleDiagnostic(messages, before, /emits runtime code/);

  const typeOnly = fixture("ignore-type-only", config);
  mkdirSync(join(typeOnly, "dist", "src", "nested"), { recursive: true });
  writeFileSync(
    join(typeOnly, "dist", "src", "nested", "worker.js"),
    "/** docs */\n// erased\nexport {};\n",
  );
  let calls = 0;
  const complete = (() => {
    calls += 1;
    if (calls === 1) {
      return spawnResult({
        stdout: JSON.stringify({
          compilerOptions: { outDir: "dist", rootDir: "." },
        }),
      });
    }
    writeLcov(typeOnly, ["src/index.ts"]);
    return spawnResult();
  }) as unknown as typeof spawnSync;
  runCoverageGate({ repoRoot: typeOnly, spawn: complete, exit });

  const defaultEmit = fixture("ignore-default-emit", config);
  mkdirSync(join(defaultEmit, "dist", "src", "nested"), { recursive: true });
  writeFileSync(
    join(defaultEmit, "dist", "src", "nested", "worker.js"),
    "export {};\n",
  );
  let defaultCalls = 0;
  const defaultPaths = (() => {
    defaultCalls += 1;
    if (defaultCalls === 1) {
      return spawnResult({ stdout: JSON.stringify({ compilerOptions: {} }) });
    }
    writeLcov(defaultEmit, ["src/index.ts"]);
    return spawnResult();
  }) as unknown as typeof spawnSync;
  runCoverageGate({ repoRoot: defaultEmit, spawn: defaultPaths, exit });
});

test("coverage gate honors custom skipped directories and Windows launcher selection", () => {
  const directory = fixture("custom-skip", {
    sources: ["src", "src/index.ts"],
    skipDirs: ["nested"],
    tests: [],
    thresholds: { statements: 100, lines: 100, branches: 100, functions: 100 },
    ignore: ["src/types-only.ts"],
  });
  writeFileSync(join(directory, "src", "types-only.ts"), "export interface TypeOnly {}\n");
  mkdirSync(join(directory, "dist", "src"), { recursive: true });
  writeFileSync(join(directory, "dist", "src", "types-only.js"), "export {};\n");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const commands: string[] = [];
  const spawn = ((command: string) => {
    commands.push(command);
    if (commands.length === 1) {
      return spawnResult({ stdout: JSON.stringify({ compilerOptions: { outDir: "dist", rootDir: "." } }) });
    }
    writeLcov(directory, ["src/index.ts"]);
    return spawnResult();
  }) as unknown as typeof spawnSync;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    runCoverageGate({ repoRoot: directory, spawn, exit });
  } finally {
    Object.defineProperty(process, "platform", platform!);
  }
  assert.deepStrictEqual(commands, ["npx.cmd", "npx.cmd"]);
});

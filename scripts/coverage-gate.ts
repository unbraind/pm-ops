/**
 * Coverage gate for the package test suite.
 *
 * Runs `c8` and `node --test` against the TypeScript sources directly (Node
 * executes `.ts` natively, so the reported
 * line numbers are the ones an author edits, not compiled output), enforces a
 * per-dimension threshold, and reconciles the reported file list against the
 * files actually on disk.
 *
 * That last step is the reason this script exists rather than a bare
 * `c8 --check-coverage` invocation. Coverage tools can omit files
 * that were loaded during the run: a source module with no test at all is
 * omitted from the report entirely rather than reported at zero. The published
 * percentage is therefore computed over the tested subset, and a package can
 * satisfy a 100% threshold while an entire module goes unexercised. Comparing
 * the report against a directory walk turns that silent omission into a failure
 * naming the missing files, so the threshold cannot be passed by narrowing what
 * the suite touches.
 *
 * Configuration lives in `package.json` under `coverageGate` so the numbers the
 * gate enforces are visible in the same file that declares the scripts, and a
 * threshold change shows up in review as a deliberate diff.
 *
 * @example
 * ```bash
 * node scripts/coverage-gate.ts
 * ```
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimum acceptable percentage for each independently reported dimension.
 */
interface CoverageThresholds {
  /** Minimum percentage of executable statements that must be covered. */
  readonly statements: number;
  /** Minimum percentage of executable lines that must be covered. */
  readonly lines: number;
  /** Minimum percentage of branch arms that must be taken. */
  readonly branches: number;
  /** Minimum percentage of declared functions that must be invoked. */
  readonly functions: number;
}

/** The `coverageGate` block read from `package.json`. */
interface CoverageGateConfig {
  /**
   * Source locations the gate requires to appear in the report. Each entry is
   * either a directory, walked recursively for `.ts` files, or a single file.
   *
   * Prefer a directory — including `"."` for a package whose entrypoint sits at
   * the repository root. A directory is enumerated at run time, so a source file
   * added later is required automatically. An explicit file list freezes the
   * required set at the moment it was written, and a new untested module simply
   * never enters it, which is the same blind spot this gate exists to close.
   */
  readonly sources: readonly string[];
  /**
   * Directory names skipped while walking, on top of {@link DEFAULT_SKIP_DIRS}.
   * Needed only for a source tree with a non-standard non-source directory.
   */
  readonly skipDirs?: readonly string[];
  /** Test file arguments handed to `node --test`. */
  readonly tests: readonly string[];
  /** Threshold enforced on the aggregate report. */
  readonly thresholds: CoverageThresholds;
  /**
   * Source files exempt from the presence check, each of which must be
   * type-only. A module that erases to nothing emits no coverage counters, so
   * requiring it in the report would make the gate unsatisfiable.
   */
  readonly ignore?: readonly string[];
}

/** Shape of the `package.json` fields this script reads. */
interface PackageManifest {
  readonly coverageGate?: CoverageGateConfig;
}

/** Injectable boundaries used by behavioral tests without weakening the CLI gate. */
interface CoverageGateOptions {
  /** Repository root containing the package manifest and measured sources. */
  readonly repoRoot?: string;
  /** Synchronous process launcher, injectable for deterministic failure contracts. */
  readonly spawn?: typeof spawnSync;
  /** Exit boundary, injectable so tests can assert fail-closed diagnostics. */
  readonly exit?: (code: number) => never;
}

const defaultRepoRoot = resolve(import.meta.dirname, "..");

/** Execute the fail-closed coverage gate for one package repository. */
export function runCoverageGate(options: CoverageGateOptions = {}): void {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const spawn = options.spawn ?? spawnSync;
  const exit = options.exit ?? process.exit;
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as PackageManifest;
  } catch (error) {
    console.error(`coverage-gate: could not read package.json: ${String(error)}`);
    return exit(1);
  }
  const config = manifest.coverageGate;

  if (!config) {
    console.error("coverage-gate: package.json has no `coverageGate` block.");
    return exit(1);
  }
  const gateConfig: CoverageGateConfig = config;

  /** Compiler paths used to locate a source file's emitted output. */
  interface TsConfig {
    readonly compilerOptions?: {
      readonly outDir?: string;
      readonly rootDir?: string;
    };
  }

  /**
   * Resolves the compiler's effective output paths.
   *
   * Asks `tsc --showConfig` rather than parsing `tsconfig.json` directly: the file
   * may be JSONC and may inherit `outDir`/`rootDir` through an `extends` chain, so
   * a raw `JSON.parse` can either throw on a valid config or silently read the
   * wrong paths.
   *
   * Fails closed if the compiler cannot be reached. This feeds the check that
   * decides whether an exempted module is genuinely type-only, and guessing the
   * emit layout there could clear an executable module by looking at the wrong
   * file — the one outcome this gate must never produce. A package that cannot
   * run its own compiler has a problem worth stopping for.
   */
  function resolveEmitPaths(): { outDir: string; rootDir: string } {
    const shown = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsc", "--showConfig", "-p", "tsconfig.json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (shown.status !== 0 || !shown.stdout) {
      console.error(
        [
          "coverage-gate: could not resolve the effective tsconfig via `tsc --showConfig`,",
          "so the emit layout is unknown and `coverageGate.ignore` entries cannot be verified",
          "as type-only. Refusing to guess.",
          shown.stderr?.trim() ? `\n${shown.stderr.trim()}` : "",
        ].join("\n"),
      );
      exit(1);
    }
    let parsed: TsConfig;
    try {
      parsed = JSON.parse(shown.stdout) as TsConfig;
    } catch (error) {
      console.error(`coverage-gate: tsc --showConfig returned invalid JSON: ${String(error)}`);
      return exit(1);
    }
    return {
      outDir: parsed.compilerOptions?.outDir ?? "dist",
      rootDir: parsed.compilerOptions?.rootDir ?? ".",
    };
  }

  /**
   * Directories never treated as source, so that `sources: ["."]` works for a
   * package whose entrypoint sits at the repository root.
   *
   * These hold tests, build output, static assets, metadata, and installed
   * dependencies. Executable package tooling under `scripts/` is deliberately
   * included: release gates and install hooks are source code whose failures can
   * block or corrupt the package lifecycle.
   */
  const DEFAULT_SKIP_DIRS: readonly string[] = [
    "node_modules",
    "dist",
    "dist-test",
    "coverage",
    "test",
    "tests",
    "public",
    ".agents",
    ".git",
    ".github",
  ];

  const skipDirs = new Set([
    ...DEFAULT_SKIP_DIRS,
    ...(gateConfig.skipDirs ?? []),
  ]);

  /**
   * Collects every TypeScript source file at a configured location.
   *
   * A file entry resolves to itself; a directory entry is walked recursively with
   * {@link DEFAULT_SKIP_DIRS} pruned. Declaration files are skipped either way:
   * they carry no runtime code and so can never appear in a coverage report.
   *
   * @param target - Absolute path to a source file or directory.
   * @returns Repository-relative POSIX paths, in directory order.
   */
  function collectSources(target: string): string[] {
    if (!existsSync(target)) {
      console.error(
        `coverage-gate: \`coverageGate.sources\` names ${
          relative(repoRoot, target)
        }, which does not exist.`,
      );
      exit(1);
    }
    if (!statSync(target).isDirectory()) {
      if (!target.endsWith(".ts") || target.endsWith(".d.ts")) {
        console.error(
          `coverage-gate: \`coverageGate.sources\` names ${
            relative(repoRoot, target)
          }, which is not a TypeScript source file. A declaration file or non-TypeScript entry can never appear in a coverage report, so requiring it would make the gate unsatisfiable.`,
        );
        exit(1);
      }
      return [relative(repoRoot, target).split(sep).join("/")];
    }
    const found: string[] = [];
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          found.push(...collectSources(join(target, entry.name)));
        }
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        found.push(
          relative(repoRoot, join(target, entry.name)).split(sep).join("/"),
        );
      }
    }
    return found;
  }

  const expected = gateConfig.sources.flatMap((source) =>
    collectSources(join(repoRoot, source))
  );
  const exempt = new Set(gateConfig.ignore ?? []);
  const required = expected.filter((file) => !exempt.has(file));

  /**
   * Rejects an `ignore` entry that still carries runtime code.
   *
   * The exemption exists for type-only modules, which erase to nothing and so can
   * never appear in a coverage report. Left untested, it is also the one way to
   * remove an executable module from both the measured set and the required set —
   * exactly the escape this gate exists to prevent. TypeScript emits `export {};`
   * and nothing else for a module that erases completely, so the compiled output
   * settles the question rather than the author's say-so.
   */
  const emitPaths = (gateConfig.ignore ?? []).length > 0
    ? resolveEmitPaths()
    : { outDir: "dist", rootDir: "." };

  for (const file of gateConfig.ignore ?? []) {
    if (!expected.includes(file)) {
      console.error(
        `coverage-gate: \`coverageGate.ignore\` names ${file}, which is not under \`sources\`.`,
      );
      exit(1);
    }
    const emitted = join(
      repoRoot,
      emitPaths.outDir,
      relative(join(repoRoot, emitPaths.rootDir), join(repoRoot, file)),
    ).replace(/\.ts$/, ".js");
    if (!existsSync(emitted)) {
      console.error(
        `coverage-gate: cannot verify that ignored file ${file} is type-only — no compiled output at ${
          relative(repoRoot, emitted)
        }. Build before running the gate, or correct \`outDir\`/\`rootDir\`.`,
      );
      exit(1);
    }
    // Block comments are stripped as well as line comments: tsc carries a
    // file-leading JSDoc into the emit, so a documented type-only module would
    // otherwise read as runtime code and be rejected for having a comment.
    const body = readFileSync(emitted, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/export\s*\{\s*\}\s*;?/g, "")
      .trim();
    if (body.length > 0) {
      console.error(
        `coverage-gate: \`coverageGate.ignore\` names ${file}, but it emits runtime code to ${
          relative(repoRoot, emitted)
        }. Only type-only modules may be exempt; anything executable must be covered.`,
      );
      exit(1);
    }
  }

  if (required.length === 0) {
    console.error(
      "coverage-gate: source walk found no files; check `coverageGate.sources`.",
    );
    exit(1);
  }

  const lcovPath = join(repoRoot, "coverage", "lcov.info");
  mkdirSync(join(repoRoot, "coverage"), { recursive: true });
  // Delete any previous report first. If this run writes none, a leftover file
  // from an earlier, broader run would satisfy the presence check on stale data —
  // the gate would pass by reading history rather than by measuring anything.
  rmSync(lcovPath, { force: true });

  const result = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    [
      "c8",
      "--all",
      // Scope the report to exactly the files the presence check requires. Passing
      // the enumerated paths rather than a directory glob keeps the two in step by
      // construction, and keeps test files and tooling out of the percentages even
      // when the source root is the repository root.
      ...required.flatMap((file) => ["--include", file]),
      "--check-coverage",
      "--per-file",
      "--statements",
      String(gateConfig.thresholds.statements),
      "--lines",
      String(gateConfig.thresholds.lines),
      "--branches",
      String(gateConfig.thresholds.branches),
      "--functions",
      String(gateConfig.thresholds.functions),
      "--reporter",
      "text",
      "--reporter",
      "lcov",
      "--reports-dir",
      join(repoRoot, "coverage"),
      process.execPath,
      "--test",
      ...gateConfig.tests,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      // Pin the timezone so the measurement is reproducible on any machine.
      // Code that branches on a timestamp's UTC offset takes different paths under
      // a local offset than under UTC, which moves the reported percentage between
      // a contributor's machine and CI. A threshold pinned to one machine's number
      // then fails on the other for reasons unrelated to the change under review.
      env: { ...process.env, TZ: "UTC" },
    },
  );

  if (result.error) {
    console.error(
      `coverage-gate: failed to start the test runner: ${result.error.message}`,
    );
    exit(1);
  }

  // Surface a runner failure before touching the report at all. A failing suite,
  // an unmet threshold, or a test file that will not load can each leave the lcov
  // output absent or incomplete, and every diagnostic below would then describe a
  // coverage-configuration problem the author does not have — burying the test
  // failure they need to act on.
  if (result.status !== 0) {
    exit(result.status ?? 1);
  }

  /**
   * Source files the run actually reported on, read back from the lcov output.
   *
   * `SF:` paths are normalised to repository-relative POSIX form so they can be
   * compared against the walk. The lcov reporter emits them relative to the
   * working directory on Linux, but that is not contractual and Windows runners
   * have been seen to emit absolute paths; without normalising, the presence
   * check would invert into a permanently red build that blames every source file
   * for never loading.
   */
  const reported = new Set<string>();
  try {
    statSync(lcovPath);
    for (const line of readFileSync(lcovPath, "utf8").split("\n")) {
      if (!line.startsWith("SF:")) continue;
      const raw = line.slice(3).trim();
      const abs = isAbsolute(raw) ? raw : join(repoRoot, raw);
      reported.add(relative(repoRoot, abs).split(sep).join("/"));
    }
  } catch {
    console.error(
      `coverage-gate: no coverage report was written to ${
        relative(repoRoot, lcovPath)
      }.`,
    );
    exit(1);
  }

  const missing = required.filter((file) => !reported.has(file));

  if (missing.length > 0) {
    console.error(
      [
        "",
        `coverage-gate: ${missing.length} source file(s) never loaded during the run and were`,
        "omitted from the coverage report, so the reported percentages exclude them entirely:",
        ...missing.map((file) => `  - ${file}`),
        "",
        "Import each file from a test (or exercise it through the CLI entrypoint under test).",
        "A file that is genuinely type-only belongs in `coverageGate.ignore` in package.json.",
        "",
      ].join("\n"),
    );
    exit(1);
  }

  console.log(
    `\ncoverage-gate: ${required.length} source file(s) reported, thresholds met.`,
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCoverageGate({
    repoRoot: process.argv[2] === undefined
      ? defaultRepoRoot
      : resolve(process.argv[2]),
  });
}

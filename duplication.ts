/**
 * Canonical TypeScript duplication analysis and fail-closed gate for the fleet.
 *
 * Two jscpd majors are supported, and their engines are structurally
 * different, so the analyzer dispatches on the installed major:
 *
 * - jscpd 4 ships a Node.js programmatic API, used directly so consumer
 *   launchers stay small while preserving the detector's clone locations.
 * - jscpd 5 replaced the Node.js API with a self-contained Rust binary, so
 *   the analyzer runs the binary with its JSON reporter and parses the report.
 */

import fastGlob from "fast-glob";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

/** Default TypeScript glob scanned by the duplication gate. */
export const DEFAULT_DUPLICATION_GLOBS: readonly string[] = ["**/*.ts"];

/** A clone pair with repository-relative file names and inclusive line ranges. */
export interface DuplicationClone {
  /** First cloned file and its inclusive source line range. */
  readonly first: { readonly file: string; readonly startLine: number; readonly endLine: number };
  /** Second cloned file and its inclusive source line range. */
  readonly second: { readonly file: string; readonly startLine: number; readonly endLine: number };
}

/** The measured result returned by the programmatic duplication analyzer. */
export interface DuplicationReport {
  /** Aggregate duplicated-line percentage implied by jscpd's line counts. */
  readonly percentage: number;
  /** Total source lines scanned by jscpd. */
  readonly totalLines: number;
  /** Lines counted as duplicated by jscpd. */
  readonly duplicatedLines: number;
  /** Number of TypeScript source files actually analyzed by jscpd. */
  readonly sources: number;
  /** In-scope files matched by the globs but skipped by jscpd. */
  readonly skippedSources: readonly string[];
  /** Number of clone pairs returned by jscpd. */
  readonly cloneCount: number;
  /** Every clone pair, including pairs below the configured threshold. */
  readonly clones: readonly DuplicationClone[];
}

/** Process and repository boundaries accepted by {@link runDuplicationGate}. */
export interface DuplicationGateOptions {
  /** Repository root containing package.json and the TypeScript files to scan. */
  readonly repoRoot?: string;
  /** Fast-glob patterns passed to jscpd; defaults to every TypeScript file. */
  readonly globs?: readonly string[];
  /** Minimum jscpd token count; defaults to 50 for direct analysis callers. */
  readonly minTokens?: number;
  /** Success logger used by the launcher and behavioral tests. */
  readonly log?: (message: string) => void;
  /** Failure logger used by the launcher and behavioral tests. */
  readonly error?: (message: string) => void;
  /** Exit boundary used to assert fail-closed behavior without ending a test process. */
  readonly exit?: (code: number) => never;
}

interface DuplicationGateConfig {
  readonly threshold: number;
  readonly minTokens: number;
}

/** One cloned file end as reported by jscpd 5's JSON reporter. */
interface ReportedCloneEnd {
  /** Absolute file path, because the analyzer runs jscpd with `--absolute`. */
  readonly name: string;
  /** First cloned line, inclusive. */
  readonly start: number;
  /** Last cloned line, inclusive. */
  readonly end: number;
}

/** One clone pair as reported by jscpd 5's JSON reporter. */
interface ReportedClone {
  readonly firstFile: ReportedCloneEnd;
  readonly secondFile: ReportedCloneEnd;
}

/** jscpd 5's JSON report shape, as written by its `json` reporter. */
interface ReportedAnalysis {
  readonly duplicates: readonly ReportedClone[];
  readonly statistics: {
    readonly total: { readonly lines: number; readonly duplicatedLines: number };
  };
}

/** One cloned file end as reported by jscpd 4's programmatic API. */
interface ProgrammaticCloneEnd {
  readonly sourceId: string;
  readonly start: { readonly line: number };
  readonly end: { readonly line: number };
}

/** jscpd 4's structural API surface, read from @jscpd/core's published types. */
interface ProgrammaticApi {
  detectClonesAndStatistic(options: ProgrammaticOptions): Promise<{
    clones: readonly { readonly duplicationA: ProgrammaticCloneEnd; readonly duplicationB: ProgrammaticCloneEnd }[];
    statistic: {
      readonly total: { readonly lines: number; readonly duplicatedLines: number; readonly sources: number };
      readonly formats: { readonly typescript?: { readonly sources: Readonly<Record<string, unknown>> } };
    };
  }>;
}

/** The jscpd 4 option subset the analyzer passes, from IOptions's shape. */
interface ProgrammaticOptions {
  readonly path: readonly string[];
  readonly pattern: string;
  readonly minTokens: number;
  readonly minLines: number;
  readonly maxLines: number;
  readonly maxSize: string;
  readonly format: readonly string[];
  readonly ignore: readonly string[];
  readonly absolute: boolean;
  readonly gitignore: boolean;
  readonly reporters: readonly string[];
  readonly silent: boolean;
}

/** Where the installed jscpd package lives and which engine generation it is. */
interface JscpdInstallation {
  /** Major version of the installed jscpd package. */
  readonly major: number;
  /** Directory of the installed jscpd package. */
  readonly packageDir: string;
  /**
   * jscpd 4's programmatic entry point, or jscpd 5's package manifest, which
   * is the only package anchor its binary-only layout exposes.
   */
  readonly entryPath: string;
}

const defaultRepoRoot = process.cwd();
const MAX_DUPLICATION_LINES = Number.MAX_SAFE_INTEGER;
const MAX_DUPLICATION_SIZE = `${Number.MAX_SAFE_INTEGER}b`;
const DUPLICATION_IGNORES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/dist-test/**",
  "**/coverage/**",
  "**/.git/**",
  "**/*.d.ts",
] as const;
const require = createRequire(import.meta.url);

/** Return whether an unknown JSON value is a record with string keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Require a record-shaped JSON value from jscpd's report, failing closed otherwise. */
function expectRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`duplication: jscpd report ${context} is not an object`);
  return value;
}

/** Require a finite number field of a jscpd report record, failing closed otherwise. */
function expectNumber(record: Record<string, unknown>, key: string, context: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`duplication: jscpd report ${context} is not a number`);
  }
  return value;
}

/** Require a string field of a jscpd report record, failing closed otherwise. */
function expectString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`duplication: jscpd report ${context} is not a string`);
  return value;
}

/** Require one cloned file end of a jscpd 5 report record. */
function expectCloneEnd(value: unknown, context: string): ReportedCloneEnd {
  const record = expectRecord(value, context);
  return {
    name: expectString(record, "name", `${context}.name`),
    start: expectNumber(record, "start", `${context}.start`),
    end: expectNumber(record, "end", `${context}.end`),
  };
}

/**
 * Parse and validate a jscpd 5 JSON report.
 *
 * Every field the duplication gate consumes is checked, so a jscpd output
 * format change fails the gate closed instead of silently reporting zero.
 *
 * @param report - The parsed `jscpd-report.json` value.
 * @returns The clone pairs and aggregate line statistics, validated.
 */
export function parseJscpdReport(report: unknown): ReportedAnalysis {
  const root = expectRecord(report, "root");
  const duplicates = root.duplicates;
  if (!Array.isArray(duplicates)) throw new Error("duplication: jscpd report duplicates is not an array");
  const clones = duplicates.map((clone) => {
    const record = expectRecord(clone, "clone");
    return {
      firstFile: expectCloneEnd(record.firstFile, "clone.firstFile"),
      secondFile: expectCloneEnd(record.secondFile, "clone.secondFile"),
    };
  });
  const statistics = expectRecord(root.statistics, "statistics");
  const total = expectRecord(statistics.total, "statistics.total");
  const lines = expectNumber(total, "lines", "statistics.total.lines");
  const duplicatedLines = expectNumber(total, "duplicatedLines", "statistics.total.duplicatedLines");
  // An impossible count (negative, fractional, or more duplicated than total lines)
  // would compute a passing percentage, so it fails closed like a missing field.
  if (
    !Number.isInteger(lines) ||
    !Number.isInteger(duplicatedLines) ||
    duplicatedLines < 0 ||
    duplicatedLines > lines
  ) {
    throw new Error("duplication: jscpd report statistics.total contains impossible line counts");
  }
  return { duplicates: clones, statistics: { total: { lines, duplicatedLines } } };
}

/** Parse and validate the package-level duplication gate contract. */
function readDuplicationConfig(manifest: Record<string, unknown>): DuplicationGateConfig | undefined {
  if (!isRecord(manifest.duplicationGate)) return undefined;
  const block = manifest.duplicationGate;
  const threshold = block.threshold;
  const minTokens = block.minTokens;
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 100
  ) return undefined;
  if (
    minTokens !== undefined &&
    (typeof minTokens !== "number" || !Number.isInteger(minTokens) || minTokens < 1)
  ) return undefined;
  return { threshold, minTokens: minTokens ?? 50 };
}

/** Convert jscpd's source identifier into a stable repository-relative path. */
function relativeSource(repoRoot: string, sourceId: string): string {
  return relative(repoRoot, resolve(repoRoot, sourceId)).split(sep).join("/");
}

/** Convert one cloned file end into the public report's file and line-range shape. */
function cloneEnd(repoRoot: string, sourceId: string, startLine: number, endLine: number): DuplicationClone["first"] {
  return { file: relativeSource(repoRoot, sourceId), startLine, endLine };
}

/** Convert one jscpd 4 clone into the public report's line-range shape. */
function mapProgrammaticClone(
  repoRoot: string,
  clone: { readonly duplicationA: ProgrammaticCloneEnd; readonly duplicationB: ProgrammaticCloneEnd },
): DuplicationClone {
  return {
    first: cloneEnd(repoRoot, clone.duplicationA.sourceId, clone.duplicationA.start.line, clone.duplicationA.end.line),
    second: cloneEnd(repoRoot, clone.duplicationB.sourceId, clone.duplicationB.start.line, clone.duplicationB.end.line),
  };
}

/** Convert one jscpd 5 clone into the public report's line-range shape. */
function mapReportedClone(repoRoot: string, clone: ReportedClone): DuplicationClone {
  return {
    first: cloneEnd(repoRoot, clone.firstFile.name, clone.firstFile.start, clone.firstFile.end),
    second: cloneEnd(repoRoot, clone.secondFile.name, clone.secondFile.start, clone.secondFile.end),
  };
}

/** Turn configured glob entries into the one fast-glob pattern jscpd accepts. */
function combineGlobs(globs: readonly string[]): string {
  if (globs.length === 0) throw new Error("duplication-gate: at least one source glob is required");
  return globs.length === 1 ? globs[0]! : `{${globs.join(",")}}`;
}

/** Match the files jscpd is expected to analyze with the same scope and ignores. */
function globMatchedSources(repoRoot: string, pattern: string): string[] {
  return fastGlob.sync(pattern, {
    absolute: true,
    cwd: repoRoot,
    dot: true,
    followSymbolicLinks: true,
    ignore: [...DUPLICATION_IGNORES],
    onlyFiles: true,
  })
    .filter((source) => source.endsWith(".ts") && !source.endsWith(".d.ts"))
    .map((source) => relativeSource(repoRoot, source))
    .sort();
}

/** Build the bounded jscpd 4 options shared by matching and actual analysis. */
function duplicationOptions(repoRoot: string, pattern: string, minTokens: number): ProgrammaticOptions {
  return {
    path: [repoRoot],
    pattern,
    minTokens,
    minLines: 1,
    maxLines: MAX_DUPLICATION_LINES,
    maxSize: MAX_DUPLICATION_SIZE,
    format: ["typescript"],
    ignore: [...DUPLICATION_IGNORES],
    absolute: true,
    gitignore: false,
    reporters: [],
    silent: true,
  };
}

/** Compute the duplicated-line percentage jscpd's own line counts imply. */
function percentageOf(duplicatedLines: number, totalLines: number): number {
  return totalLines > 0 ? (duplicatedLines / totalLines) * 100 : 0;
}

/**
 * Resolve the installed jscpd package, preferring the repository root.
 *
 * Consumers install jscpd as their own (optional) peer dependency, so the
 * repository root is where the analyzer must find it; this module's own
 * directory keeps the gate working for this repository's runs. jscpd 4
 * resolves through its programmatic entry point, while jscpd 5 exposes no
 * entry at all and resolves through its package manifest; when jscpd is
 * installed nowhere, the manifest lookup throws Node's own not-found error.
 */
function resolveJscpdEntry(repoRoot: string): JscpdInstallation {
  try {
    const entryPath = require.resolve("jscpd", { paths: [repoRoot, import.meta.dirname] });
    const packageDir = packageDirOf(entryPath);
    return { major: majorOf(packageDir), packageDir, entryPath };
  } catch {
    // jscpd 5 has no package entry point; its manifest is the only anchor.
    const manifestPath = require.resolve("jscpd/package.json", { paths: [repoRoot, import.meta.dirname] });
    const packageDir = dirname(manifestPath);
    return { major: majorOf(packageDir), packageDir, entryPath: manifestPath };
  }
}

/** Read the engine generation from a jscpd package's manifest. */
function majorOf(packageDir: string): number {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version?: unknown };
  return Number.parseInt(String(manifest.version), 10);
}

/** The directory of a package entry, walking up to the package manifest. */
function packageDirOf(entryPath: string): string {
  let directory = dirname(entryPath);
  while (!existsSync(join(directory, "package.json"))) directory = dirname(directory);
  return directory;
}

/**
 * Analyze with jscpd 4's programmatic API.
 *
 * jscpd 4 publishes a per-file statistic, so files the globs matched but
 * jscpd never analyzed fail the gate closed through `skippedSources`.
 */
async function analyzeWithProgrammatic(
  installation: JscpdInstallation,
  repoRoot: string,
  pattern: string,
  minTokens: number,
  matchedSources: readonly string[],
): Promise<DuplicationReport> {
  const api = require(installation.entryPath) as ProgrammaticApi;
  const result = await api.detectClonesAndStatistic(duplicationOptions(repoRoot, pattern, minTokens));
  const analyzedSources = Object.keys(
    result.statistic.formats.typescript?.sources ?? {},
  )
    .map((source) => relativeSource(repoRoot, source))
    .sort();
  const analyzed = new Set(analyzedSources);
  return {
    percentage: percentageOf(result.statistic.total.duplicatedLines, result.statistic.total.lines),
    totalLines: result.statistic.total.lines,
    duplicatedLines: result.statistic.total.duplicatedLines,
    sources: result.statistic.total.sources,
    skippedSources: matchedSources.filter((source) => !analyzed.has(source)),
    cloneCount: result.clones.length,
    clones: result.clones.map((clone) => mapProgrammaticClone(repoRoot, clone)),
  };
}

/**
 * Analyze with jscpd 5's binary through its JSON reporter.
 *
 * jscpd 5 is a self-contained Rust binary driven by `run-jscpd.js`, and its
 * JSON report carries no per-file analysis record. The only files it drops
 * from `statistics.total.sources` are those below the token floor, which
 * cannot hold a clone of `minTokens` tokens, so the in-scope file set is the
 * analyzed set and nothing in scope can be silently skipped.
 */
function analyzeWithBinary(
  installation: JscpdInstallation,
  repoRoot: string,
  pattern: string,
  minTokens: number,
  matchedSources: readonly string[],
): DuplicationReport {
  const outputDir = mkdtempSync(join(tmpdir(), "pm-ops-jscpd-"));
  try {
    const result = spawnSync(process.execPath, [
      join(installation.packageDir, "run-jscpd.js"),
      repoRoot,
      "--pattern", pattern,
      "--format", "typescript",
      "--min-tokens", String(minTokens),
      "--min-lines", "1",
      "--max-lines", String(MAX_DUPLICATION_LINES),
      "--max-size", MAX_DUPLICATION_SIZE,
      "--ignore", DUPLICATION_IGNORES.join(","),
      "--reporters", "json",
      "--output", outputDir,
      "--silent",
      "--no-colors",
      "--absolute",
      "--no-gitignore",
    ], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`duplication: jscpd exited with status ${String(result.status)}: ${String(result.stderr)}`);
    }
    const rawReport = JSON.parse(readFileSync(join(outputDir, "jscpd-report.json"), "utf8")) as unknown;
    const reported = parseJscpdReport(rawReport);
    return {
      percentage: percentageOf(reported.statistics.total.duplicatedLines, reported.statistics.total.lines),
      totalLines: reported.statistics.total.lines,
      duplicatedLines: reported.statistics.total.duplicatedLines,
      sources: matchedSources.length,
      skippedSources: [],
      cloneCount: reported.duplicates.length,
      clones: reported.duplicates.map((clone) => mapReportedClone(repoRoot, clone)),
    };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

/** Return the fail-closed diagnostic for an empty or partially analyzed scope. */
export function duplicationGateDiagnostic(
  report: Pick<DuplicationReport, "sources" | "skippedSources">,
): string | undefined {
  if (report.sources === 0) return "duplication-gate: no TypeScript sources were analyzed for the configured glob scope.";
  if (report.skippedSources.length > 0) {
    return `duplication-gate: jscpd skipped ${report.skippedSources.length} in-scope file(s):\n`
      + report.skippedSources.map((source) => `  ${source}`).join("\n");
  }
  return undefined;
}

/**
 * Analyze a repository's TypeScript sources with the installed jscpd major.
 *
 * jscpd 4 runs through its Node.js API and jscpd 5 through its Rust binary,
 * and both are resolved from the repository root so a consumer's own jscpd
 * dependency is the engine that answers.
 *
 * @param options - Repository root and optional source globs.
 * @returns Aggregate percentage and every clone pair found by jscpd.
 */
export async function analyzeDuplication(
  options: Pick<DuplicationGateOptions, "repoRoot" | "globs" | "minTokens"> = {},
): Promise<DuplicationReport> {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const pattern = combineGlobs(options.globs ?? DEFAULT_DUPLICATION_GLOBS);
  const minTokens = options.minTokens ?? 50;
  const matchedSources = globMatchedSources(repoRoot, pattern);
  const installation = resolveJscpdEntry(repoRoot);
  if (installation.major >= 5) {
    return analyzeWithBinary(installation, repoRoot, pattern, minTokens, matchedSources);
  }
  return analyzeWithProgrammatic(installation, repoRoot, pattern, minTokens, matchedSources);
}

/**
 * Run the configured duplication threshold gate and print every clone pair.
 *
 * A missing or malformed `duplicationGate` block fails closed with a
 * remediation message. The default minimum token count is 50, matching jscpd.
 *
 * @param options - Repository, glob, logging, and process boundaries.
 */
export async function runDuplicationGate(
  options: DuplicationGateOptions = {},
): Promise<void> {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const exit = options.exit ?? process.exit;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as unknown;
  } catch (cause) {
    error(`duplication-gate: could not read package.json: ${String(cause)}`);
    return exit(1);
  }
  if (!isRecord(manifest) || !("duplicationGate" in manifest)) {
    error("duplication-gate: package.json has no `duplicationGate` block; add { \"threshold\": <percent>, \"minTokens\": <n> }.");
    return exit(1);
  }
  const config = readDuplicationConfig(manifest);
  if (config === undefined) {
    error("duplication-gate: invalid `duplicationGate`; threshold must be a number from 0 to 100 and minTokens must be a positive integer.");
    return exit(1);
  }
  let report: DuplicationReport;
  try {
    report = await analyzeDuplication({
      repoRoot,
      globs: options.globs,
      minTokens: config.minTokens,
    });
  } catch (cause) {
    error(`duplication-gate: jscpd analysis failed: ${String(cause)}`);
    return exit(1);
  }
  log(
    `duplication-gate: ${report.percentage}% duplicated lines (${report.duplicatedLines}/${report.totalLines}), ${report.sources} source(s), ${report.cloneCount} clone pair(s), threshold ${config.threshold}%`,
  );
  const scopeDiagnostic = duplicationGateDiagnostic(report);
  if (scopeDiagnostic) {
    error(scopeDiagnostic);
    return exit(1);
  }
  for (const clone of report.clones) {
    log(
      `  ${clone.first.file}:${clone.first.startLine}-${clone.first.endLine} <-> ${clone.second.file}:${clone.second.startLine}-${clone.second.endLine}`,
    );
  }
  if (report.percentage > config.threshold) {
    error(
      `duplication-gate: ${report.percentage}% exceeds the configured ${config.threshold}% threshold; remove the reported clone pairs or document a justified threshold change in package.json.`,
    );
    return exit(1);
  }
}

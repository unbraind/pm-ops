/**
 * Canonical TypeScript duplication analysis and fail-closed gate for the fleet.
 *
 * This module uses jscpd's programmatic detector rather than its CLI, keeping
 * consumer launchers small while preserving the detector's clone locations and
 * aggregate percentage for machine-readable callers.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { IClone, IOptions, IStatistic } from "@jscpd/core";

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
  /** Aggregate duplicated-line percentage reported by jscpd. */
  readonly percentage: number;
  /** Total source lines scanned by jscpd. */
  readonly totalLines: number;
  /** Lines counted as duplicated by jscpd. */
  readonly duplicatedLines: number;
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

interface DuplicationApi {
  detectClonesAndStatistic(
    options: IOptions,
  ): Promise<{ clones: IClone[]; statistic: IStatistic }>;
}

const defaultRepoRoot = process.cwd();
const require = createRequire(import.meta.url);
const jscpd = require("jscpd") as DuplicationApi;

/** Return whether an unknown JSON value is a record with string keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

/** Convert one jscpd clone into the public report's line-range shape. */
function mapClone(repoRoot: string, clone: IClone): DuplicationClone {
  return {
    first: {
      file: relativeSource(repoRoot, clone.duplicationA.sourceId),
      startLine: clone.duplicationA.start.line,
      endLine: clone.duplicationA.end.line,
    },
    second: {
      file: relativeSource(repoRoot, clone.duplicationB.sourceId),
      startLine: clone.duplicationB.start.line,
      endLine: clone.duplicationB.end.line,
    },
  };
}

/** Turn configured glob entries into the one fast-glob pattern jscpd accepts. */
function combineGlobs(globs: readonly string[]): string {
  if (globs.length === 0) throw new Error("duplication-gate: at least one source glob is required");
  return globs.length === 1 ? globs[0]! : `{${globs.join(",")}}`;
}

/**
 * Analyze a repository's TypeScript sources with jscpd's programmatic API.
 *
 * @param options - Repository root and optional source globs.
 * @returns Aggregate percentage and every clone pair found by jscpd.
 */
export async function analyzeDuplication(
  options: Pick<DuplicationGateOptions, "repoRoot" | "globs" | "minTokens"> = {},
): Promise<DuplicationReport> {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const pattern = combineGlobs(options.globs ?? DEFAULT_DUPLICATION_GLOBS);
  const result = await jscpd.detectClonesAndStatistic({
    path: [repoRoot],
    pattern,
    minTokens: options.minTokens ?? 50,
    format: ["typescript"],
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-test/**",
      "**/coverage/**",
      "**/.git/**",
      "**/*.d.ts",
    ],
    absolute: true,
    gitignore: false,
    reporters: [],
    silent: true,
  });
  return {
    percentage: result.statistic.total.percentage,
    totalLines: result.statistic.total.lines,
    duplicatedLines: result.statistic.total.duplicatedLines,
    cloneCount: result.clones.length,
    clones: result.clones.map((clone) => mapClone(repoRoot, clone)),
  };
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
    `duplication-gate: ${report.percentage}% duplicated lines (${report.duplicatedLines}/${report.totalLines}), ${report.cloneCount} clone pair(s), threshold ${config.threshold}%`,
  );
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

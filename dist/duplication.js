/**
 * Canonical TypeScript duplication analysis and fail-closed gate for the fleet.
 *
 * This module uses jscpd's programmatic detector rather than its CLI, keeping
 * consumer launchers small while preserving the detector's clone locations and
 * aggregate percentage for machine-readable callers.
 */
import fastGlob from "fast-glob";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
/** Default TypeScript glob scanned by the duplication gate. */
export const DEFAULT_DUPLICATION_GLOBS = ["**/*.ts"];
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
];
const require = createRequire(import.meta.url);
const jscpd = require("jscpd");
/** Return whether an unknown JSON value is a record with string keys. */
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
/** Parse and validate the package-level duplication gate contract. */
function readDuplicationConfig(manifest) {
    if (!isRecord(manifest.duplicationGate))
        return undefined;
    const block = manifest.duplicationGate;
    const threshold = block.threshold;
    const minTokens = block.minTokens;
    if (typeof threshold !== "number" ||
        !Number.isFinite(threshold) ||
        threshold < 0 ||
        threshold > 100)
        return undefined;
    if (minTokens !== undefined &&
        (typeof minTokens !== "number" || !Number.isInteger(minTokens) || minTokens < 1))
        return undefined;
    return { threshold, minTokens: minTokens ?? 50 };
}
/** Convert jscpd's source identifier into a stable repository-relative path. */
function relativeSource(repoRoot, sourceId) {
    return relative(repoRoot, resolve(repoRoot, sourceId)).split(sep).join("/");
}
/** Convert one jscpd clone into the public report's line-range shape. */
function mapClone(repoRoot, clone) {
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
function combineGlobs(globs) {
    if (globs.length === 0)
        throw new Error("duplication-gate: at least one source glob is required");
    return globs.length === 1 ? globs[0] : `{${globs.join(",")}}`;
}
/** Match the files jscpd is expected to analyze with the same scope and ignores. */
function globMatchedSources(repoRoot, pattern) {
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
/** Build the bounded jscpd options shared by matching and actual analysis. */
function duplicationOptions(repoRoot, pattern, minTokens) {
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
/** Return the fail-closed diagnostic for an empty or partially analyzed scope. */
export function duplicationGateDiagnostic(report) {
    if (report.sources === 0)
        return "duplication-gate: no TypeScript sources were analyzed for the configured glob scope.";
    if (report.skippedSources.length > 0) {
        return `duplication-gate: jscpd skipped ${report.skippedSources.length} in-scope file(s):\n`
            + report.skippedSources.map((source) => `  ${source}`).join("\n");
    }
    return undefined;
}
/**
 * Analyze a repository's TypeScript sources with jscpd's programmatic API.
 *
 * @param options - Repository root and optional source globs.
 * @returns Aggregate percentage and every clone pair found by jscpd.
 */
export async function analyzeDuplication(options = {}) {
    const repoRoot = options.repoRoot ?? defaultRepoRoot;
    const pattern = combineGlobs(options.globs ?? DEFAULT_DUPLICATION_GLOBS);
    const minTokens = options.minTokens ?? 50;
    const result = await jscpd.detectClonesAndStatistic(duplicationOptions(repoRoot, pattern, minTokens));
    const matchedSources = globMatchedSources(repoRoot, pattern);
    const analyzedSources = Object.keys(result.statistic.formats.typescript?.sources ?? {})
        .map((source) => relativeSource(repoRoot, source))
        .sort();
    const analyzed = new Set(analyzedSources);
    return {
        percentage: result.statistic.total.percentage,
        totalLines: result.statistic.total.lines,
        duplicatedLines: result.statistic.total.duplicatedLines,
        sources: result.statistic.total.sources,
        skippedSources: matchedSources.filter((source) => !analyzed.has(source)),
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
export async function runDuplicationGate(options = {}) {
    const repoRoot = options.repoRoot ?? defaultRepoRoot;
    const log = options.log ?? console.log;
    const error = options.error ?? console.error;
    const exit = options.exit ?? process.exit;
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    }
    catch (cause) {
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
    let report;
    try {
        report = await analyzeDuplication({
            repoRoot,
            globs: options.globs,
            minTokens: config.minTokens,
        });
    }
    catch (cause) {
        error(`duplication-gate: jscpd analysis failed: ${String(cause)}`);
        return exit(1);
    }
    log(`duplication-gate: ${report.percentage}% duplicated lines (${report.duplicatedLines}/${report.totalLines}), ${report.sources} source(s), ${report.cloneCount} clone pair(s), threshold ${config.threshold}%`);
    const scopeDiagnostic = duplicationGateDiagnostic(report);
    if (scopeDiagnostic) {
        error(scopeDiagnostic);
        return exit(1);
    }
    for (const clone of report.clones) {
        log(`  ${clone.first.file}:${clone.first.startLine}-${clone.first.endLine} <-> ${clone.second.file}:${clone.second.startLine}-${clone.second.endLine}`);
    }
    if (report.percentage > config.threshold) {
        error(`duplication-gate: ${report.percentage}% exceeds the configured ${config.threshold}% threshold; remove the reported clone pairs or document a justified threshold change in package.json.`);
        return exit(1);
    }
}
//# sourceMappingURL=duplication.js.map
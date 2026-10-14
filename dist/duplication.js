/**
 * Canonical TypeScript duplication analysis and fail-closed gate for the fleet.
 *
 * jscpd 5 runs as a self-contained Rust binary with a validated JSON report.
 * Source discovery uses Node's built-in glob and preserves the authored scope.
 */
import { glob, lstat, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
/**
 * Default globs scanned by the duplication gate: every authored TypeScript
 * source (`.ts`, `.tsx`, `.mts`, `.cts`) in the repository.
 */
export const DEFAULT_DUPLICATION_GLOBS = ["**/*.{ts,tsx,mts,cts}"];
const defaultRepoRoot = process.cwd();
const MAX_DUPLICATION_LINES = Number.MAX_SAFE_INTEGER;
const MAX_DUPLICATION_SIZE = `${Number.MAX_SAFE_INTEGER}b`;
const DUPLICATION_IGNORES = [
    "**/node_modules/**",
    "**/dist/**",
    "**/dist-test/**",
    "**/coverage/**",
    "**/.git/**",
    "**/.agents/pm/extensions/**",
    "**/*.d.ts",
    "**/*.d.mts",
    "**/*.d.cts",
];
const require = createRequire(import.meta.url);
/** Return whether an unknown JSON value is a record with string keys. */
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
/** Require a record-shaped JSON value from jscpd's report, failing closed otherwise. */
function expectRecord(value, context) {
    if (!isRecord(value))
        throw new Error(`duplication: jscpd report ${context} is not an object`);
    return value;
}
/** Require a finite number field of a jscpd report record, failing closed otherwise. */
function expectNumber(record, key, context) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`duplication: jscpd report ${context} is not a number`);
    }
    return value;
}
/** Require a string field of a jscpd report record, failing closed otherwise. */
function expectString(record, key, context) {
    const value = record[key];
    if (typeof value !== "string")
        throw new Error(`duplication: jscpd report ${context} is not a string`);
    return value;
}
/** Require one cloned file end of a jscpd 5 report record. */
function expectCloneEnd(value, context) {
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
 * jscpd 5.4 counts overlapping clone regions once per clone, so
 * `duplicatedLines` may exceed the total `lines` of the scanned sources; the
 * fail-closed bound is instead the sum of the reported clone spans, which no
 * real report can exceed without double-counting clones themselves.
 *
 * @param report - The parsed `jscpd-report.json` value.
 * @returns The clone pairs and aggregate line statistics, validated.
 */
export function parseJscpdReport(report) {
    const root = expectRecord(report, "root");
    const duplicates = root.duplicates;
    if (!Array.isArray(duplicates))
        throw new Error("duplication: jscpd report duplicates is not an array");
    const clones = duplicates.map((clone) => {
        const record = expectRecord(clone, "clone");
        const lines = expectNumber(record, "lines", "clone.lines");
        if (!Number.isInteger(lines) || lines < 1) {
            throw new Error("duplication: jscpd report clone.lines is not a positive integer span");
        }
        return {
            firstFile: expectCloneEnd(record.firstFile, "clone.firstFile"),
            secondFile: expectCloneEnd(record.secondFile, "clone.secondFile"),
            lines,
        };
    });
    const statistics = expectRecord(root.statistics, "statistics");
    const total = expectRecord(statistics.total, "statistics.total");
    const lines = expectNumber(total, "lines", "statistics.total.lines");
    const duplicatedLines = expectNumber(total, "duplicatedLines", "statistics.total.duplicatedLines");
    const sources = expectNumber(total, "sources", "statistics.total.sources");
    const cloneLineSpans = clones.reduce((total, clone) => total + clone.lines, 0);
    const largestCloneSpan = clones.reduce((largest, clone) => Math.max(largest, clone.lines), 0);
    // Impossible counts could compute a passing percentage or false completeness.
    if (!Number.isInteger(lines) ||
        lines < 0 ||
        largestCloneSpan > lines ||
        !Number.isInteger(duplicatedLines) ||
        duplicatedLines < 0 ||
        duplicatedLines > cloneLineSpans ||
        !Number.isInteger(sources) ||
        sources < 0) {
        throw new Error("duplication: jscpd report statistics.total contains impossible counts");
    }
    return { duplicates: clones, statistics: { total: { lines, duplicatedLines, sources } } };
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
/** Convert one cloned file end into the public report's file and line-range shape. */
function cloneEnd(repoRoot, sourceId, startLine, endLine) {
    return { file: relativeSource(repoRoot, sourceId), startLine, endLine };
}
/** Convert one jscpd 5 clone into the public report's line-range shape. */
function mapReportedClone(repoRoot, clone) {
    return {
        first: cloneEnd(repoRoot, clone.firstFile.name, clone.firstFile.start, clone.firstFile.end),
        second: cloneEnd(repoRoot, clone.secondFile.name, clone.secondFile.start, clone.secondFile.end),
    };
}
/** Turn configured glob entries into the one brace-union pattern jscpd accepts. */
function combineGlobs(globs) {
    if (globs.length === 0)
        throw new Error("duplication-gate: at least one source glob is required");
    return globs.length === 1 ? globs[0] : `{${globs.join(",")}}`;
}
/** Expand comma brace unions so leading negative alternatives remain excludes. */
function expandGlobUnions(pattern) {
    const union = /\{([^{}]*,[^{}]*)\}/.exec(pattern);
    if (!union)
        return [pattern];
    return union[1].split(",").flatMap((alternative) => expandGlobUnions(pattern.slice(0, union.index) + alternative + pattern.slice(union.index + union[0].length)));
}
/**
 * Prefix ordinary path segments before native matching to preserve dot:true.
 * The common prefix makes hidden names ordinary without changing wildcard,
 * character-class or extglob matching; globstars retain their native meaning.
 */
function dotInclusivePath(path) {
    return path.split("/").map((segment) => segment === "**" ? segment : `x${segment}`).join("/");
}
/**
 * Discover authored sources with built-in glob, preserving fast-glob's scope.
 * Hidden entries supplement native glob because Bun omits even explicit .*.
 * Native path matching on prefixed segments retains the former dot:true policy.
 * lstat rejects discovered symlinks; explicit symlink bases retain prior scope.
 */
export async function globMatchedSources(repoRoot, pattern) {
    const root = resolve(repoRoot);
    const patterns = expandGlobUnions(pattern);
    const positives = patterns.filter((value) => !value.startsWith("!"));
    const includes = positives.map((value) => dotInclusivePath(relativeSource(root, value)));
    const excludes = [...DUPLICATION_IGNORES, ...patterns.filter((value) => value.startsWith("!"))
            .map((value) => value.slice(1))].map((value) => dotInclusivePath(relativeSource(root, value)));
    const sources = [];
    // Begin at each literal pattern base, preserving ../ and explicit symlink bases.
    const directories = [...new Set(positives.map((value) => {
            const literal = relativeSource(root, value).split(/[?*[{(]/, 1)[0];
            return resolve(root, literal.endsWith("/") ? literal : dirname(literal));
        }))].filter((directory) => statSync(directory, { throwIfNoEntry: false }) !== undefined);
    const visited = new Set();
    for (const directory of directories) {
        if (visited.has(directory))
            continue;
        visited.add(directory);
        const entries = new Set();
        for await (const entry of glob("*", { cwd: directory }))
            entries.add(entry);
        for (const entry of await readdir(directory)) {
            if (entry.startsWith("."))
                entries.add(entry);
        }
        for (const entry of entries) {
            const absolute = resolve(directory, entry);
            const source = relativeSource(root, absolute);
            const candidate = dotInclusivePath(source);
            if (excludes.some((exclude) => matchesGlob(candidate, exclude)))
                continue;
            const stat = await lstat(absolute);
            if (stat.isDirectory())
                directories.push(absolute);
            if (stat.isFile() && includes.some((include) => matchesGlob(candidate, include))
                && (source.endsWith(".ts") || source.endsWith(".tsx") || source.endsWith(".mts") || source.endsWith(".cts"))) {
                sources.push(source);
            }
        }
    }
    return [...new Set(sources)].sort();
}
/** Compute the duplicated-line percentage jscpd's own line counts imply. */
function percentageOf(duplicatedLines, totalLines) {
    return totalLines > 0 ? (duplicatedLines / totalLines) * 100 : 0;
}
/** Resolve a consumer's jscpd 5 package before falling back to this package. */
function resolveJscpdEntry(repoRoot) {
    const manifestPath = require.resolve("jscpd/package.json", { paths: [repoRoot, import.meta.dirname] });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const major = Number.parseInt(String(manifest.version), 10);
    if (major !== 5)
        throw new Error("duplication: jscpd >=5.0.0 <6.0.0 is required");
    return { packageDir: dirname(manifestPath) };
}
/**
 * Analyze with jscpd 5's binary through its JSON reporter.
 *
 * jscpd 5 is a self-contained Rust binary driven by `run-jscpd.js`, and its
 * JSON report carries only aggregate source counts. A second one-token scan
 * proves that its format filter read every in-scope file, including short ones.
 */
function analyzeWithBinary(installation, repoRoot, pattern, minTokens, matchedSources) {
    const outputDir = mkdtempSync(join(tmpdir(), "pm-ops-jscpd-"));
    try {
        const run = (tokens) => {
            // The package gate owns its threshold; an ambient .jscpd.json must not
            // make either scan exit before its JSON source-count receipt is read.
            const result = spawnSync(process.execPath, [
                join(installation.packageDir, "run-jscpd.js"),
                repoRoot,
                "--pattern", pattern,
                "--format", "typescript,tsx",
                "--min-tokens", String(tokens),
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
            ], { cwd: outputDir, encoding: "utf8" });
            if (result.status !== 0) {
                throw new Error(`duplication: jscpd exited with status ${String(result.status)}: ${String(result.stderr)}`);
            }
            const rawReport = JSON.parse(readFileSync(join(outputDir, "jscpd-report.json"), "utf8"));
            return parseJscpdReport(rawReport);
        };
        const reported = run(minTokens);
        const verifiedSources = minTokens === 1 ? reported.statistics.total.sources : run(1).statistics.total.sources;
        if (verifiedSources !== matchedSources.length) {
            throw new Error(`duplication: jscpd scanned ${verifiedSources} of ${matchedSources.length} in-scope TypeScript sources at the one-token floor`);
        }
        return {
            percentage: percentageOf(reported.statistics.total.duplicatedLines, reported.statistics.total.lines),
            totalLines: reported.statistics.total.lines,
            duplicatedLines: reported.statistics.total.duplicatedLines,
            sources: matchedSources.length,
            skippedSources: [],
            cloneCount: reported.duplicates.length,
            clones: reported.duplicates.map((clone) => mapReportedClone(repoRoot, clone)),
        };
    }
    finally {
        rmSync(outputDir, { recursive: true, force: true });
    }
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
 * Analyze a repository's TypeScript sources with the installed jscpd 5 binary.
 * Resolve from the repository root so the consumer's own dependency answers.
 *
 * @param options - Repository root and optional source globs.
 * @returns Aggregate percentage and every clone pair found by jscpd.
 */
export async function analyzeDuplication(options = {}) {
    const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot);
    const pattern = combineGlobs(options.globs ?? DEFAULT_DUPLICATION_GLOBS);
    const minTokens = options.minTokens ?? 50;
    const matchedSources = await globMatchedSources(repoRoot, pattern);
    const installation = resolveJscpdEntry(repoRoot);
    return analyzeWithBinary(installation, repoRoot, pattern, minTokens, matchedSources);
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
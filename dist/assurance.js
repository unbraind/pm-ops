/**
 * Assurance measurement provider that turns the fleet's pinned code-quality
 * thresholds into audited bounds.
 *
 * Every fleet package historically hand-rolled a `scripts/coverage-gate.ts`
 * with thresholds pinned under `coverageGate` in `package.json`. Lowering one
 * was an ordinary diff: nothing in the workflow recorded *why* a number moved,
 * and nothing proved the bound still meant anything. Under pm-cli's assurance
 * surface, weakening a bound requires an `authorization_decision` naming a
 * terminal Decision item the host verifies, and every non-dry gate verdict is
 * appended to the immutable workspace history stream. That only bites if the
 * quality numbers can be *measured* by an assurance provider, which is what
 * this module exports.
 *
 * The provider reads a local lcov coverage report and the canonical docstring
 * analyzer and reduces them to four measurement keys. It owns no quality
 * thresholds itself — those live in assertions and gates the consuming
 * workspace declares — but it refuses to be satisfied by a *stale* coverage
 * report, because a gate that runs against yesterday's `lcov.info` after today's
 * source edit is a gate that measures nothing.
 *
 * @see {@link https://github.com/unbraind/pm-cli/blob/main/docs/ASSURANCE.md ASSURANCE.md}
 * for the measurement / assertion / gate vocabulary this provider plugs into.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { analyzeDocstringCoverage } from "./docstrings.js";
/** Stable provider id used by measurement declarations and gate allow-lists. */
export const QUALITY_PROVIDER_ID = "pm-ops-quality";
/**
 * The four lcov dimensions this provider can reduce to a single percentage.
 *
 * lcov has native `LF`/`LH`, `BRF`/`BRH`, and `FNF`/`FNH` counters for lines,
 * branches, and functions, but no native statement counter: statements are
 * reconstructed from the per-line `DA:` records the reporter already emits.
 */
const COVERAGE_DIMENSIONS = [
    "lines",
    "branches",
    "functions",
    "statements",
];
/** Default lcov report path when a measurement omits the `report` parameter. */
const DEFAULT_REPORT = "coverage/lcov.info";
/** Default source root when a docstring measurement omits the `root` parameter. */
const DEFAULT_ROOT = ".";
/**
 * Parse lcov text into one record per covered file.
 *
 * lcov delimits file sections with `SF:` and `end_of_record`. A well-formed
 * report always pairs them, but real reporters occasionally omit the trailing
 * `end_of_record` on the last section, so the parser flushes a pending record
 * on the next `SF:` and once more at end-of-input rather than dropping it.
 * `SF:` paths may be absolute or repo-relative; both are normalised to a
 * repo-relative POSIX label resolved against `base`, matching how the package's
 * own `coverage-gate.ts` reads them back.
 */
function parseLcov(text, base) {
    const records = [];
    let file = "";
    let sourcePath = "";
    let linesFound = 0;
    let linesHit = 0;
    let branchesFound = 0;
    let branchesHit = 0;
    let functionsFound = 0;
    let functionsHit = 0;
    let statementsFound = 0;
    let statementsHit = 0;
    let started = false;
    const flush = () => {
        if (!started) {
            return;
        }
        records.push({
            file,
            sourcePath,
            linesFound,
            linesHit,
            branchesFound,
            branchesHit,
            functionsFound,
            functionsHit,
            statementsFound,
            statementsHit,
        });
        started = false;
        file = "";
        sourcePath = "";
        linesFound = 0;
        linesHit = 0;
        branchesFound = 0;
        branchesHit = 0;
        functionsFound = 0;
        functionsHit = 0;
        statementsFound = 0;
        statementsHit = 0;
    };
    for (const rawLine of text.split("\n")) {
        const line = rawLine.trimEnd();
        if (line === "end_of_record") {
            flush();
            continue;
        }
        if (line.startsWith("SF:")) {
            flush();
            const raw = line.slice(3).trim();
            const absolute = isAbsolute(raw) ? raw : join(base, raw);
            file = relative(base, absolute).split(sep).join("/");
            sourcePath = absolute;
            started = true;
            continue;
        }
        if (!started) {
            continue;
        }
        if (line.startsWith("DA:")) {
            // Each `DA:<line>,<count>[,<checksum>]` record is one instrumented
            // statement: count it as found unconditionally and as hit when its
            // execution count (the second field, never the line number) is > 0.
            statementsFound++;
            const firstComma = line.indexOf(",", 3);
            const secondComma = firstComma === -1 ? -1 : line.indexOf(",", firstComma + 1);
            const countEnd = secondComma === -1 ? line.length : secondComma;
            const count = firstComma === -1
                ? Number.NaN
                : Number(line.slice(firstComma + 1, countEnd));
            if (Number.isFinite(count) && count > 0) {
                statementsHit++;
            }
            continue;
        }
        if (line.startsWith("LF:")) {
            linesFound = countAfter(line, 3);
        }
        else if (line.startsWith("LH:")) {
            linesHit = countAfter(line, 3);
        }
        else if (line.startsWith("BRF:")) {
            branchesFound = countAfter(line, 4);
        }
        else if (line.startsWith("BRH:")) {
            branchesHit = countAfter(line, 4);
        }
        else if (line.startsWith("FNF:")) {
            functionsFound = countAfter(line, 4);
        }
        else if (line.startsWith("FNH:")) {
            functionsHit = countAfter(line, 4);
        }
    }
    flush();
    return records;
}
/**
 * Read the integer payload following an lcov count tag (`LF:42`).
 *
 * `tagLength` is the length of the tag including its colon. A malformed payload
 * coerces to `0` rather than `NaN` so one corrupt line cannot poison an
 * otherwise valid report into a non-finite percentage.
 */
function countAfter(line, tagLength) {
    return Number(line.slice(tagLength)) || 0;
}
/**
 * Resolve a path-shaped provider parameter against the workspace base.
 *
 * Absolute paths are honoured as-is; relative paths resolve against the base so
 * a measurement declared with the default `coverage/lcov.info` finds the report
 * regardless of the process working directory the host happened to launch from.
 * A non-string value falls back to the default rather than throwing, because the
 * host has already validated the parameter against its declared `string` type.
 */
function resolveParameterPath(value, fallback, base) {
    const raw = typeof value === "string" ? value : fallback;
    return isAbsolute(raw) ? raw : join(base, raw);
}
/**
 * Best on-disk root for resolving relative report and source paths.
 *
 * The host populates `repo_root` and `source_workspace_root` from the Git root
 * and the launch directory; `process.cwd()` is the last resort for direct unit
 * tests that construct a context by hand.
 */
function workspaceBase(context) {
    return context.repo_root ?? context.source_workspace_root ?? process.cwd();
}
/**
 * Reduce one record to the found/hit pair for the requested dimension.
 *
 * Statements are the only dimension reconstructed from `DA:` records rather than
 * read from a native lcov counter, so they branch on the parsed field.
 */
function dimensionCount(record, dimension) {
    switch (dimension) {
        case "lines":
            return { found: record.linesFound, hit: record.linesHit };
        case "branches":
            return { found: record.branchesFound, hit: record.branchesHit };
        case "functions":
            return { found: record.functionsFound, hit: record.functionsHit };
        case "statements":
            return { found: record.statementsFound, hit: record.statementsHit };
    }
}
/** Round a percentage to two decimals so verdicts carry stable, readable values. */
function roundPercent(value) {
    return Math.round(value * 100) / 100;
}
/**
 * Read and parse the lcov report, then refuse it if it is stale.
 *
 * A missing report fails with an actionable message rather than an opaque
 * filesystem error, because the gate author needs to know the `report`
 * parameter resolved to a path nothing wrote to. After parsing, the staleness
 * refusal compares the report's mtime against every covered source; see
 * {@link assertReportNotStale} for why that comparison is the provider's core
 * security property.
 */
function readCoverageReport(reportPath, base) {
    let text;
    try {
        text = readFileSync(reportPath, "utf8");
    }
    catch {
        throw new Error(`pm-ops-quality: coverage report not found at ${reportPath}. ` +
            'Provide the "report" parameter or generate the report by running the ' +
            "test suite with an lcov reporter before evaluating the gate.");
    }
    const records = parseLcov(text, base);
    assertReportNotStale(reportPath, records.map((record) => record.sourcePath));
    return records;
}
/**
 * Refuse a coverage report older than any source file it covers.
 *
 * This is the security property that makes the provider worth registering: a
 * gate that reads a report file can be satisfied by a *stale* report — run the
 * suite once at full coverage, edit the source, and the gate still passes
 * against yesterday's numbers. Comparing the report's mtime against the mtime of
 * every covered source (and only those, never wall-clock age) makes the verdict
 * depend on *what changed* rather than on *when the gate ran*. If any covered
 * source is newer than the report, resolution throws naming the offending file
 * and both timestamps, so the verdict can never be computed from a stale report
 * and can never silently downgrade to a pass.
 *
 * A source the report names but that no longer exists is skipped here: a missing
 * file cannot be "newer", and the absence is already visible in the verdict's
 * population and contributors. This check answers exactly one question — is the
 * report behind the source tree? — and refuses only when it is.
 */
function assertReportNotStale(reportPath, sourcePaths) {
    const reportMtime = statSync(reportPath).mtimeMs;
    const stale = [];
    for (const source of sourcePaths) {
        let info;
        try {
            info = statSync(source);
        }
        catch {
            continue;
        }
        if (info.mtimeMs > reportMtime) {
            stale.push({ source, mtime: info.mtimeMs });
        }
    }
    if (stale.length === 0) {
        return;
    }
    const reportIso = new Date(reportMtime).toISOString();
    const offenders = stale
        .map((entry) => `  ${entry.source} (modified ${new Date(entry.mtime).toISOString()})`)
        .join("\n");
    throw new Error(`pm-ops-quality: refusing a stale coverage report.\n` +
        `The report ${reportPath} (modified ${reportIso}) is older than source ` +
        "file(s) it covers, so its numbers no longer describe the current tree. " +
        "Re-run the test suite to regenerate the report before evaluating the gate.\n" +
        `Source files newer than the report:\n${offenders}`);
}
/**
 * Resolve the `coverage_percent` measurement for one dimension.
 *
 * The percentage is the dimension's total hit over its total found across the
 * whole report; the population denominator is that same total found, so a gate
 * reading the receipt can tell a 100% over two hundred lines from a vacuous
 * 100% over zero. Contributors are the repo-relative files still below full
 * coverage on the requested dimension, sorted for deterministic verdicts.
 */
function resolveCoveragePercent(context) {
    const dimension = requireCoverageDimension(context.parameters.dimension);
    const base = workspaceBase(context);
    const reportPath = resolveParameterPath(context.parameters.report, DEFAULT_REPORT, base);
    const records = readCoverageReport(reportPath, base);
    let found = 0;
    let hit = 0;
    const contributors = [];
    for (const record of records) {
        const counts = dimensionCount(record, dimension);
        found += counts.found;
        hit += counts.hit;
        if (counts.hit < counts.found) {
            contributors.push(record.file);
        }
    }
    contributors.sort();
    const value = found === 0 ? 100 : roundPercent((hit / found) * 100);
    return {
        value,
        population_size: found,
        cost: records.length,
        contributors,
    };
}
/**
 * Resolve the `uncovered_files` measurement.
 *
 * The value is the repo-relative set of files that are below full coverage on
 * *any* dimension, so a gate can bound how many files still carry coverage debt
 * without caring which dimension slipped. The population is every file in the
 * report, so the receipt reads "3 of 41 files are not fully covered".
 */
function resolveUncoveredFiles(context) {
    const base = workspaceBase(context);
    const reportPath = resolveParameterPath(context.parameters.report, DEFAULT_REPORT, base);
    const records = readCoverageReport(reportPath, base);
    // A file is "uncovered" when it falls short of full coverage on any one
    // dimension; a dimension lcov reports as empty (`found` 0) is vacuously
    // satisfied, so a branchless file can still be fully covered.
    const uncovered = records
        .filter((record) => record.linesHit < record.linesFound ||
        record.branchesHit < record.branchesFound ||
        record.functionsHit < record.functionsFound ||
        record.statementsHit < record.statementsFound)
        .map((record) => record.file)
        .sort();
    return {
        value: uncovered,
        population_size: records.length,
        cost: records.length,
        contributors: uncovered,
    };
}
/**
 * Resolve the `docstring_percent` measurement.
 *
 * Delegates to the canonical analyzer at {@link analyzeDocstringCoverage} rather
 * than reimplementing it, so the fleet has exactly one docstring definition.
 * The population is the count of documentable symbols and contributors are the
 * `path:symbol` labels still missing a docstring, matching the analyzer's own
 * violation output.
 */
function resolveDocstringPercent(context) {
    const base = workspaceBase(context);
    const root = resolveParameterPath(context.parameters.root, DEFAULT_ROOT, base);
    const report = analyzeDocstringCoverage({ root });
    const total = report.declarations_checked;
    const missing = report.violations.length;
    const value = total === 0 ? 100 : roundPercent(((total - missing) / total) * 100);
    const contributors = docstringContributors(report.violations);
    return { value, population_size: total, cost: total, contributors };
}
/**
 * Resolve the `undocumented_symbols` measurement.
 *
 * The value is the stable `path:symbol` label set for every symbol the analyzer
 * flagged, so a gate can name exactly which declarations carry the debt. The
 * population is the full documentable-symbol count, not just the violators, so
 * the receipt distinguishes "5 of 5 undocumented" from "5 of 200 undocumented".
 */
function resolveUndocumentedSymbols(context) {
    const base = workspaceBase(context);
    const root = resolveParameterPath(context.parameters.root, DEFAULT_ROOT, base);
    const report = analyzeDocstringCoverage({ root });
    const labels = docstringContributors(report.violations);
    return {
        value: labels,
        population_size: report.declarations_checked,
        cost: report.declarations_checked,
        contributors: labels,
    };
}
/**
 * Build sorted `path:symbol` contributor labels from analyzer violations.
 *
 * Centralised so both docstring keys derive identical labels from the same
 * violation stream; a future change to the label format changes both at once.
 */
function docstringContributors(violations) {
    return violations
        .map((violation) => `${violation.file}:${violation.symbol}`)
        .sort();
}
/**
 * Validate and accept the required `dimension` parameter for `coverage_percent`.
 *
 * The host validates that a required parameter is *present* and *string-typed*,
 * but it cannot validate the value domain, so an unknown dimension like
 * `"loc"` would otherwise flow through to a percentage of nothing. This guard
 * fails fast with the accepted vocabulary instead of returning a misleading 0%.
 */
function requireCoverageDimension(value) {
    if (typeof value !== "string") {
        throw new Error('pm-ops-quality: key "coverage_percent" requires a string "dimension" ' +
            `parameter; received ${value === null ? "null" : typeof value}.`);
    }
    if (!COVERAGE_DIMENSIONS.includes(value)) {
        throw new Error(`pm-ops-quality: unknown coverage dimension "${value}". Expected one of: ` +
            `${COVERAGE_DIMENSIONS.join(", ")}.`);
    }
    return value;
}
/**
 * The pm-ops quality assurance measurement provider.
 *
 * Registered through the `services` capability, it exposes four keys over a
 * local lcov report and the canonical docstring analyzer. It declares no
 * network use and a `medium` cost class so a trigger policy that caps work at
 * `low` can decline it before invocation. Key ids use the hyphen form the pm-cli
 * host requires for every stable lowercase id (`^[a-z0-9][a-z0-9-]*$`); the
 * hyphen and underscore spellings name the same measurements.
 */
export const qualityMeasurementProvider = {
    id: QUALITY_PROVIDER_ID,
    cost_class: "medium",
    network: false,
    timeout_ms: 30_000,
    keys: {
        "coverage-percent": {
            value_type: "number",
            description: "Percentage covered for one lcov dimension across the whole report.",
            parameters: {
                dimension: {
                    type: "string",
                    required: true,
                    description: "One of lines, branches, functions, or statements.",
                },
                report: {
                    type: "string",
                    required: false,
                    description: "Path to an lcov report; defaults to coverage/lcov.info.",
                },
            },
        },
        "uncovered-files": {
            value_type: "string_set",
            description: "Repo-relative files that are not at 100% on every dimension.",
            parameters: {
                report: {
                    type: "string",
                    required: false,
                    description: "Path to an lcov report; defaults to coverage/lcov.info.",
                },
            },
        },
        "docstring-percent": {
            value_type: "number",
            description: "Percentage of documentable symbols carrying a docstring.",
            parameters: {
                root: {
                    type: "string",
                    required: false,
                    description: "Source root to scan; defaults to the workspace root.",
                },
            },
        },
        "undocumented-symbols": {
            value_type: "string_set",
            description: "Stable path:symbol labels for symbols missing a docstring.",
            parameters: {
                root: {
                    type: "string",
                    required: false,
                    description: "Source root to scan; defaults to the workspace root.",
                },
            },
        },
    },
    resolve(context) {
        switch (context.key) {
            case "coverage-percent":
                return resolveCoveragePercent(context);
            case "uncovered-files":
                return resolveUncoveredFiles(context);
            case "docstring-percent":
                return resolveDocstringPercent(context);
            case "undocumented-symbols":
                return resolveUndocumentedSymbols(context);
            default:
                throw new Error(`pm-ops-quality: provider does not declare key "${context.key}".`);
        }
    },
};
//# sourceMappingURL=assurance.js.map
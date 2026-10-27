/** Observational compatibility explanations. Core alone decides extension admission. */
import { Range, inc, intersects, minVersion, satisfies, valid } from "semver";
import { createRequire } from "node:module";
import { readRegularText } from "./regular-input.js";
/** Resolve only the supported public SDK export, relative to this installed package graph. */
const requireSdk = createRequire(import.meta.url);
/** Acquire native authoring support lazily through Node's public package export loader. */
function checkNativeBounds(manifest, target) {
    let sdk;
    try {
        sdk = requireSdk("@unbrained/pm-cli/sdk/authoring");
    }
    catch {
        throw new CompatibilityRefusal("compatibility_sdk_unavailable", "Use a supported pm host and Node runtime with the public authoring SDK available; retain the metadata and retry without applying changes.");
    }
    return sdk.checkExtensionManifestCompatibility(manifest, target);
}
/** Actionable refusal that never includes supplied paths or raw parser errors. */
export class CompatibilityRefusal extends Error {
    /** Stable machine-readable classification. */
    code;
    /** Safe recovery guidance. */
    remedy;
    /** Invalid input is a usage error. */
    exitCode = 2;
    /** Construct a sanitized refusal. */
    constructor(code, remedy) {
        super(`${code}: ${remedy}`);
        this.name = "CompatibilityRefusal";
        this.code = code;
        this.remedy = remedy;
    }
}
/** Narrow an ordinary input object without prototype-based lookups. */
function object(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** Reject unknown fields; required fields are checked by the shared schema below. */
function keys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
}
/** Bounded public identifiers also prevent path or shell content in command previews. */
function identifier(value) {
    return typeof value === "string" && /^[a-zA-Z0-9_@][a-zA-Z0-9_.@/-]{0,95}$/.test(value) && !value.includes("..") && !value.startsWith("/");
}
/** Dense arrays only; Array.every alone silently accepts sparse arrays. */
function dense(value, max) {
    return Array.isArray(value) && value.length <= max && Object.keys(value).length === value.length
        && Array.from(value.keys()).every((index) => Object.hasOwn(value, index));
}
/** Validate a nullable exhaustive capability declaration. */
function capabilities(value) {
    return value === null || (dense(value, 16) && value.every(identifier) && new Set(value).size === value.length);
}
/** One strict structural schema shared by SDK and file producers; metadata text stays verbatim. */
export function parseCompatibilityInput(value) {
    const refuse = () => { throw new CompatibilityRefusal("invalid_compatibility_input", "Supply version 1, 1-16 unique components, 1-12 unique requirements referencing components, nullable versions/ranges/capabilities, and optional native manifest bounds. Use dense arrays, public ids and strings at most 256 characters; split ranges exceeding 256 alternative combinations per target."); };
    const text = (entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 256;
    if (!object(value) || !keys(value, ["version", "components", "requirements"]) || value.version !== 1
        || !dense(value.components, 16) || !value.components.length || !dense(value.requirements, 12) || !value.requirements.length)
        return refuse();
    for (const component of value.components) {
        if (!object(component) || !keys(component, ["id", "version", "capabilities"]) || !identifier(component.id)
            || !(component.version === null || text(component.version)) || !capabilities(component.capabilities))
            return refuse();
    }
    const components = value.components;
    const ids = new Set(components.map((component) => component.id));
    if (ids.size !== components.length)
        return refuse();
    const combinations = new Map();
    for (const requirement of value.requirements) {
        if (!object(requirement) || !keys(requirement, ["id", "from", "to", "range", "capabilities", "manifest"])
            || !identifier(requirement.id) || typeof requirement.from !== "string" || typeof requirement.to !== "string"
            || !ids.has(requirement.from) || !ids.has(requirement.to)
            || !(requirement.range === null || text(requirement.range)) || !capabilities(requirement.capabilities))
            return refuse();
        if (requirement.manifest !== undefined && (!object(requirement.manifest)
            || !keys(requirement.manifest, ["pm_min_version", "pm_max_version"])
            || !Object.values(requirement.manifest).every(text)))
            return refuse();
        const range = parseRange(requirement.range);
        const size = (combinations.get(String(requirement.to)) ?? 1) * (range?.set.length ?? 1);
        if (size > 256)
            return refuse();
        combinations.set(String(requirement.to), size);
    }
    const requirements = value.requirements;
    if (new Set(requirements.map((requirement) => requirement.id)).size !== requirements.length)
        return refuse();
    const parsed = structuredClone({ version: 1, components, requirements });
    for (const requirement of parsed.requirements)
        if (requirement.manifest === undefined)
            delete requirement.manifest;
    return parsed;
}
/** Unsupported metadata is unknown, including workspace/file/tag ranges; it is never a contradiction. */
function parseRange(value) {
    if (value === null || !value.trim())
        return null;
    try {
        return new Range(value.trim());
    }
    catch {
        return null;
    }
}
/** Internal control flow preserves the rejected range without exposing library exception text. */
class UnrepresentableRangeError extends Error {
    /** The source conjunction remains available to SDK/CLI consumers. */
    range;
    /** Preserve representation failure separately from incompatibility. */
    constructor(range) {
        super("unrepresentable_range");
        this.range = range;
    }
}
/** Translate a library rejection into a typed, actionable per-declaration result. */
function rangeReason(requirement, range) {
    return { requirement, code: "unrepresentable_range", range,
        remedy: "Supply a representable range or an observed version satisfying these declarations; no joint incompatibility was inferred from the rejected value." };
}
/** A library-produced version must itself survive the library parser before it can establish a verdict. */
function representedVersion(value, range) {
    const normalized = valid(value);
    if (normalized === null)
        throw new UnrepresentableRangeError(range);
    return normalized;
}
/** A single validated producer supplies minima for both full conjunctions and their comparator constraints. */
function minimumWitnesses(range) {
    const minimum = minVersion(range);
    return minimum === null ? [] : [representedVersion(minimum.version, range.raw)];
}
/** Comparator intervals can disprove a conjunction without inventing a version or changing prerelease admission. */
function overlappingClause(clause) {
    const merged = new Range(clause.map((range) => range.range || "*").join(" "));
    return intersects(merged, merged, { includePrerelease: true });
}
/** Let semver produce witnesses; keep each declaration's prerelease admission predicate authoritative. */
function feasibleClause(clause) {
    if (!overlappingClause(clause))
        return false;
    const merged = new Range(clause.map((range) => range.range || "*").join(" "));
    const accepts = (version) => clause.every((range) => range.test(version));
    for (const candidate of minimumWitnesses(merged)) {
        if (accepts(candidate))
            return true;
        if (accepts(representedVersion(inc(candidate, "patch"), merged.raw)))
            return true;
    }
    // A strict stable lower bound can hide an admitted prerelease core from minVersion.
    // Numeric identifier 0 is requested through semver's public increment operation.
    for (const range of clause)
        for (const comparators of range.set)
            for (const comparator of comparators) {
                if (!comparator.value || !comparator.semver.prerelease.length)
                    continue;
                if (minimumWitnesses(new Range(comparator.value)).some(accepts))
                    return true;
                const minimumPre = representedVersion(inc(comparator.semver, "prerelease", "0", false), merged.raw);
                if (accepts(minimumPre))
                    return true;
            }
    return false;
}
/** Intersect with tri-state evidence, preserving every original predicate and independently proven branch. */
function intersection(ranges, observed) {
    if (!ranges.length)
        return { ranges: [["*"]], rejected: [] };
    const label = ranges.map((range) => range.raw).join(" && ");
    try {
        const literals = [...observed, "0.0.0", "0.0.0-0", ...ranges.flatMap((range) => range.set.flatMap((set) => set.filter((comparator) => comparator.value).map((comparator) => comparator.semver.version)))];
        const witnessed = literals.some((version) => ranges.every((range) => range.test(version)));
        let clauses = [[]];
        for (const range of ranges) {
            const choices = range.set.map((set) => new Range(set.map((comparator) => comparator.value).join(" ") || "*"));
            clauses = clauses.flatMap((clause) => choices.map((choice) => [...clause, choice]));
        }
        // A supplied/declared valid witness proves nonemptiness without asking for a derived successor.
        // Keeping structurally possible empty branches changes no version admitted by the exact expression.
        const possible = [];
        let proven = false;
        let refused = false;
        for (const clause of clauses) {
            try {
                if ((witnessed ? overlappingClause : feasibleClause)(clause)) {
                    possible.push(clause);
                    proven = true;
                }
            }
            catch {
                // An undecided alternative remains part of the exact expression, but proves neither verdict.
                possible.push(clause);
                refused = true;
            }
        }
        const rejected = refused ? [label] : [];
        if (!proven && refused)
            return { ranges: null, rejected };
        if (!possible.length)
            return { ranges: [], rejected };
        return { ranges: clauses.length > 16 ? [ranges.map((range) => range.range || "*")]
                : possible.map((clause) => clause.map((range) => range.range || "*")), rejected };
    }
    catch {
        return { ranges: null, rejected: [label] };
    }
}
/** Search other subsets after refusals; fall back only to a full-set contradiction already established. */
function minimumConflict(entries, observed, established) {
    const unknown = new Map();
    let minimumUnproven = false;
    for (let size = 1; size < entries.length; size++) {
        let undecided = false;
        for (let mask = 1; mask < 2 ** entries.length; mask++) {
            const subset = entries.filter((_, index) => (mask & (1 << index)) !== 0);
            if (subset.length !== size)
                continue;
            const result = intersection(subset.map((entry) => entry.range), observed);
            for (const range of result.rejected)
                for (const entry of subset) {
                    if (!unknown.has(entry.id))
                        unknown.set(entry.id, rangeReason(entry.id, range));
                }
            if (result.ranges === null)
                undecided = true;
            else if (!result.ranges.length)
                return { requirements: subset.map((entry) => entry.id), minimumUnproven, unknown: [...unknown.values()] };
        }
        minimumUnproven ||= undecided;
    }
    return { requirements: established ? entries.map((entry) => entry.id) : null, minimumUnproven, unknown: [...unknown.values()] };
}
/** Find a shortest upstream path; cycles terminate and disconnected cycles retain their own declaration. */
function chain(edge, requirements) {
    const queue = [{ node: edge.from, path: [edge.id] }];
    const visited = new Set([edge.to, edge.from]);
    for (const current of queue) {
        const incoming = requirements.filter((entry) => entry.to === current.node);
        if (!incoming.length)
            return current.path;
        for (const parent of incoming)
            if (!visited.has(parent.from)) {
                visited.add(parent.from);
                queue.push({ node: parent.from, path: [parent.id, ...current.path] });
            }
    }
    return [edge.id];
}
/** Check every emitted numeric field before returning a successful report. */
export function validateCompatibilityCounts(counts, rowCount) {
    const values = Object.values(counts);
    if (!Number.isSafeInteger(rowCount) || rowCount < 1 || rowCount > 16 || values.length !== 3
        || !["compatible", "incompatible", "unknown"].every((key) => Object.hasOwn(counts, key))
        || !values.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 16)
        || values.reduce((sum, value) => sum + value, 0) !== rowCount) {
        throw new CompatibilityRefusal("invalid_compatibility_output", "Reject this report and regenerate from a valid bounded selection; report invalid counts to the producer.");
    }
}
/** Explain joint declarations without loading extensions, invoking commands or touching tracker state. */
export function explainCompatibility(value) {
    const input = parseCompatibilityInput(value);
    const requirements = input.requirements.sort((left, right) => left.id.localeCompare(right.id));
    const rows = [];
    for (const component of input.components.sort((left, right) => left.id.localeCompare(right.id))) {
        const incoming = requirements.filter((entry) => entry.to === component.id);
        if (!incoming.length)
            continue;
        const unknown = [];
        const conflicts = [];
        const known = [];
        const current = component.version === null ? null : valid(component.version.trim());
        for (const entry of incoming) {
            const range = parseRange(entry.range);
            if (range === null)
                unknown.push(entry.range === null || !entry.range.trim()
                    ? { requirement: entry.id, code: "range_unknown" } : rangeReason(entry.id, entry.range));
            else
                known.push({ id: entry.id, range });
            if (current === null)
                unknown.push({ requirement: entry.id, code: "version_unknown" });
            if (entry.capabilities === null || (entry.capabilities.length > 0 && component.capabilities === null))
                unknown.push({ requirement: entry.id, code: "capabilities_unknown" });
            else if (entry.capabilities !== null && component.capabilities !== null) {
                for (const capability of entry.capabilities)
                    if (!component.capabilities.includes(capability)) {
                        conflicts.push({ code: "capability_conflict", requirements: [entry.id], detail: capability });
                    }
            }
            if (entry.manifest !== undefined) {
                const result = checkNativeBounds(entry.manifest, { pmVersion: component.version?.trim() ?? "unknown" });
                for (const finding of result.findings) {
                    if (finding.severity === "error")
                        conflicts.push({ code: "extension_bound_conflict", requirements: [entry.id], detail: finding.code });
                    else
                        unknown.push({ requirement: entry.id, code: finding.code });
                }
            }
        }
        const observed = current === null ? [] : [current];
        const full = intersection(known.map((entry) => entry.range), observed);
        let common = full.ranges;
        for (const range of full.rejected)
            for (const entry of known)
                unknown.push(rangeReason(entry.id, range));
        if (common === null || !common.length) {
            const reduced = minimumConflict(known, observed, common !== null);
            unknown.push(...reduced.unknown);
            if (reduced.requirements !== null) {
                common = [];
                conflicts.unshift({ code: "joint_range_conflict", requirements: reduced.requirements, detail: "No version satisfies these declarations together.",
                    ...(reduced.minimumUnproven ? { minimum_unproven: true } : {}) });
            }
        }
        if (current !== null && !conflicts.some((conflict) => conflict.code === "joint_range_conflict")) {
            const failed = known.find((entry) => !satisfies(current, entry.range));
            if (failed)
                conflicts.unshift({ code: "installed_pin_conflict", requirements: [failed.id], detail: current });
        }
        const status = conflicts.length ? "incompatible" : unknown.length ? "unknown" : "compatible";
        const relevant = new Set([...conflicts.flatMap((conflict) => conflict.requirements), ...unknown.map((entry) => entry.requirement)]);
        rows.push({ component, status, compatible_ranges: common !== null && (!common.length || known.length === incoming.length) ? common : null, conflicts, unknown,
            chains: incoming.filter((entry) => !relevant.size || relevant.has(entry.id)).map((entry) => chain(entry, requirements)),
            remedy: status === "compatible" ? "Declarations agree; core still decides extension admission." : status === "unknown"
                ? "Obtain missing or supported version/capability metadata and rerun; do not infer incompatibility."
                : conflicts.some((conflict) => conflict.minimum_unproven)
                    ? "Retain the proven contradiction; obtain representable metadata before claiming minimum cardinality or changing any pin or capability declaration."
                    : "Review the minimum witnesses and compatible ranges; verify replacement metadata before changing any pin or capability declaration." });
    }
    const counts = { compatible: 0, incompatible: 0, unknown: 0 };
    for (const row of rows)
        counts[row.status]++;
    validateCompatibilityCounts(counts, rows.length);
    return { version: 1, ok: counts.incompatible + counts.unknown === 0, preview: true, requirements, rows, counts,
        commands: [["pm", "--version"], ["pm", "extension", "list", "--json"]] };
}
/** Read at most 64 KiB of regular JSON; no shell, Git, installs or configuration edits. */
export function readCompatibilityReasons(path) {
    let value;
    try {
        value = JSON.parse(readRegularText(path, 65536));
    }
    catch {
        throw new CompatibilityRefusal("compatibility_input_unreadable", "Supply a readable regular JSON metadata file no larger than 64 KiB; exclude pipes, devices and directories.");
    }
    return explainCompatibility(value);
}
//# sourceMappingURL=compatibility-reasons.js.map
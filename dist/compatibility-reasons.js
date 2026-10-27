/** Observational compatibility explanations. Core alone decides extension admission. */
import { Range, satisfies, valid } from "semver";
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
/** Candidate lower boundaries; strict prerelease successors append .0, with finite segment rollover. */
function boundaries(range) {
    const result = ["0.0.0", "0.0.0-0"];
    for (const set of range.set)
        for (const comparator of set) {
            if (!comparator.value)
                continue;
            const version = comparator.semver;
            const stable = `${version.major}.${version.minor}.${version.patch}`;
            result.push(version.version, stable);
            if (version.prerelease.length)
                result.push(`${version.version}.0`);
            else {
                const parts = [version.major, version.minor, version.patch];
                for (let index = 2; index >= 0; index--)
                    if (parts[index] < Number.MAX_SAFE_INTEGER) {
                        parts[index]++;
                        parts.fill(0, index + 1);
                        result.push(parts.join("."), `${parts.join(".")}-0`);
                        break;
                    }
            }
        }
    return result.filter((value) => valid(value) !== null);
}
/** Intersect disjunctions without flattening away each original npm prerelease admission predicate. */
function intersection(ranges) {
    let clauses = [[]];
    for (const range of ranges)
        clauses = clauses.flatMap((clause) => range.set.map((set) => [...clause, set.map((comparator) => comparator.value).join(" ") || "*"]));
    const candidates = [...new Set(ranges.flatMap(boundaries))];
    if (!ranges.length)
        return [["*"]];
    return clauses.filter((clause) => candidates.some((candidate) => clause.every((part) => satisfies(candidate, part))));
}
/** Exhaustive cardinality search, bounded to 12 declarations; stable id order breaks ties. */
function minimumConflict(entries) {
    const subsets = Array.from({ length: 2 ** entries.length - 1 }, (_, offset) => entries.filter((_, index) => ((offset + 1) & (1 << index)) !== 0));
    // The caller established that the full set is contradictory, so this is nonempty.
    const contradictory = subsets.filter((subset) => !intersection(subset.map((entry) => entry.range)).length);
    contradictory.sort((left, right) => left.length - right.length);
    return contradictory[0].map((entry) => entry.id);
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
                unknown.push({ requirement: entry.id, code: "range_unknown" });
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
        const common = intersection(known.map((entry) => entry.range));
        if (!common.length)
            conflicts.unshift({ code: "joint_range_conflict", requirements: minimumConflict(known), detail: "No version satisfies these declarations together." });
        else if (current !== null) {
            const failed = known.find((entry) => !satisfies(current, entry.range));
            if (failed)
                conflicts.unshift({ code: "installed_pin_conflict", requirements: [failed.id], detail: current });
        }
        const status = conflicts.length ? "incompatible" : unknown.length ? "unknown" : "compatible";
        const relevant = new Set([...conflicts.flatMap((conflict) => conflict.requirements), ...unknown.map((entry) => entry.requirement)]);
        rows.push({ component, status, compatible_ranges: !common.length || known.length === incoming.length ? common : null, conflicts, unknown,
            chains: incoming.filter((entry) => !relevant.size || relevant.has(entry.id)).map((entry) => chain(entry, requirements)),
            remedy: status === "compatible" ? "Declarations agree; core still decides extension admission." : status === "unknown"
                ? "Obtain missing or supported version/capability metadata and rerun; do not infer incompatibility." : "Review the minimum witnesses and compatible ranges; verify replacement metadata before changing any pin or capability declaration." });
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
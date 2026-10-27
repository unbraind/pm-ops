/** Observational compatibility explanations. Core alone decides extension admission. */
import { Range, inc, intersects, minVersion, satisfies, valid } from "semver";
import { createRequire } from "node:module";
import type { ExtensionManifestCompatibilityManifest, ExtensionManifestCompatibilityTarget, ExtensionManifestCompatibilityResult, ExtensionManifestCompatibilityCode } from "@unbrained/pm-cli/sdk/authoring";
import { readRegularText } from "./regular-input.ts";

/** Resolve only the supported public SDK export, relative to this installed package graph. */
const requireSdk = createRequire(import.meta.url);

/** Narrow SDK port loaded only for an explicit native manifest check. */
interface CompatibilitySdk {
  /** Loader-shared native version admission evaluation. */
  checkExtensionManifestCompatibility: (manifest: ExtensionManifestCompatibilityManifest, target: ExtensionManifestCompatibilityTarget) => ExtensionManifestCompatibilityResult;
}

/** Acquire native authoring support lazily through Node's public package export loader. */
function checkNativeBounds(manifest: ExtensionManifestCompatibilityManifest, target: ExtensionManifestCompatibilityTarget): ExtensionManifestCompatibilityResult {
  let sdk: CompatibilitySdk;
  try { sdk = requireSdk("@unbrained/pm-cli/sdk/authoring") as CompatibilitySdk; } catch {
    throw new CompatibilityRefusal("compatibility_sdk_unavailable", "Use a supported pm host and Node runtime with the public authoring SDK available; retain the metadata and retry without applying changes.");
  }
  return sdk.checkExtensionManifestCompatibility(manifest, target);
}

/** Explicit metadata; null means unknown, while an empty capability list means known empty. */
export interface CompatibilityComponent {
  /** Public metadata identity, independent of package resolution or paths. */
  id: string;
  /** Observed exact semantic version, or null when unavailable. */
  version: string | null;
  /** Exhaustive declared support, or null when unavailable. */
  capabilities: string[] | null;
}

/** One directed declaration from a package or extension to its dependency or host. */
export interface CompatibilityRequirement {
  /** Unique declaration identity. */
  id: string;
  /** Declaring component. */
  from: string;
  /** Required component. */
  to: string;
  /** npm semantic version range; null is unknown, * is explicitly unrestricted. */
  range: string | null;
  /** Required capabilities; null is unknown, [] explicitly requires none. */
  capabilities: string[] | null;
  /** Optional native extension bounds, evaluated by the public SDK against the target. */
  manifest?: { pm_min_version?: string; pm_max_version?: string };
}

/** Versioned strict input; at most 16 components and 12 requirements. */
export interface CompatibilityInput {
  /** Input contract version. */
  version: 1;
  /** Unique observed components. */
  components: CompatibilityComponent[];
  /** Unique directed declarations; cycles are permitted. */
  requirements: CompatibilityRequirement[];
}

/** Actionable refusal that never includes supplied paths or raw parser errors. */
export class CompatibilityRefusal extends Error {
  /** Stable machine-readable classification. */
  readonly code: "invalid_compatibility_input" | "compatibility_input_unreadable" | "invalid_compatibility_output" | "compatibility_sdk_unavailable";
  /** Safe recovery guidance. */
  readonly remedy: string;
  /** Invalid input is a usage error. */
  readonly exitCode = 2;
  /** Construct a sanitized refusal. */
  constructor(code: CompatibilityRefusal["code"], remedy: string) {
    super(`${code}: ${remedy}`); this.name = "CompatibilityRefusal"; this.code = code; this.remedy = remedy;
  }
}

/** One independently established conflict with a minimum-cardinality witness. */
export interface CompatibilityConflict {
  /** Joint declarations, observed pin, capability declaration, or native admission finding. */
  code: "joint_range_conflict" | "installed_pin_conflict" | "capability_conflict" | "extension_bound_conflict";
  /** Exact declaration ids; installed pin/support is explicit in the row's component. */
  requirements: string[];
  /** Conflicting capability or native SDK code, if relevant. */
  detail: string;
}

/** A rejected library value is incomplete evidence, never proof of an empty version domain. */
export interface UnrepresentableRangeReason {
  /** Declaration that could not be evaluated. */
  requirement: string;
  /** Stable discriminant for conservative domain refusals. */
  code: "unrepresentable_range";
  /** Exact range or conjunction the library could not represent. */
  range: string;
  /** Safe action without installs or configuration edits. */
  remedy: string;
}

/** Metadata gaps and native SDK advisories remain distinct from range representation failures. */
export type CompatibilityUnknownReason = UnrepresentableRangeReason | {
  /** Declaration owning the incomplete evidence. */
  requirement: string;
  /** Missing metadata or the native SDK's own diagnostic. */
  code: "range_unknown" | "version_unknown" | "capabilities_unknown" | ExtensionManifestCompatibilityCode;
};

/** Compact explanation for a component with incoming constraints. */
export interface CompatibilityRow {
  /** Observed target metadata, including unknowns. */
  component: CompatibilityComponent;
  /** Incompatibility takes precedence; unknowns remain visible independently. */
  status: "compatible" | "incompatible" | "unknown";
  /** OR of conjunctions (all ranges in each inner array must hold). Preserves npm prerelease rules. */
  compatible_ranges: string[][] | null;
  /** Minimum witnesses per established conflict dimension. */
  conflicts: CompatibilityConflict[];
  /** Declaration ids with incomplete metadata and a reason code. */
  unknown: CompatibilityUnknownReason[];
  /** Deterministic shortest upstream paths ending at relevant declarations; ids refer to declarations. */
  chains: string[][];
  /** Next safe step; never an authorization or automatic change. */
  remedy: string;
}

/** Bounded report; ok means every declared check is compatible, never admission authorization. */
export interface CompatibilityReport {
  /** Report contract version. */
  version: 1;
  /** True only with no conflicts or unknowns. */
  ok: boolean;
  /** Evaluation is observational. */
  preview: true;
  /** Complete declarations so every reason chain is self-contained. */
  requirements: CompatibilityRequirement[];
  /** One row per referenced target, sorted by id. */
  rows: CompatibilityRow[];
  /** Finite bounded outcome counts. */
  counts: { compatible: number; incompatible: number; unknown: number };
  /** Literal argv previews, never executed. */
  commands: string[][];
}

/** Narrow an ordinary input object without prototype-based lookups. */
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Reject unknown fields; required fields are checked by the shared schema below. */
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Bounded public identifiers also prevent path or shell content in command previews. */
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_@][a-zA-Z0-9_.@/-]{0,95}$/.test(value) && !value.includes("..") && !value.startsWith("/");
}

/** Dense arrays only; Array.every alone silently accepts sparse arrays. */
function dense(value: unknown, max: number): value is unknown[] {
  return Array.isArray(value) && value.length <= max && Object.keys(value).length === value.length
    && Array.from(value.keys()).every((index) => Object.hasOwn(value, index));
}

/** Validate a nullable exhaustive capability declaration. */
function capabilities(value: unknown): value is string[] | null {
  return value === null || (dense(value, 16) && value.every(identifier) && new Set(value).size === value.length);
}

/** One strict structural schema shared by SDK and file producers; metadata text stays verbatim. */
export function parseCompatibilityInput(value: unknown): CompatibilityInput {
  const refuse = (): never => { throw new CompatibilityRefusal("invalid_compatibility_input", "Supply version 1, 1-16 unique components, 1-12 unique requirements referencing components, nullable versions/ranges/capabilities, and optional native manifest bounds. Use dense arrays, public ids and strings at most 256 characters; split ranges exceeding 256 alternative combinations per target."); };
  const text = (entry: unknown): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 256;
  if (!object(value) || !keys(value, ["version", "components", "requirements"]) || value.version !== 1
    || !dense(value.components, 16) || !value.components.length || !dense(value.requirements, 12) || !value.requirements.length) return refuse();
  for (const component of value.components) {
    if (!object(component) || !keys(component, ["id", "version", "capabilities"]) || !identifier(component.id)
      || !(component.version === null || text(component.version)) || !capabilities(component.capabilities)) return refuse();
  }
  const components = value.components as CompatibilityComponent[];
  const ids = new Set(components.map((component) => component.id));
  if (ids.size !== components.length) return refuse();
  const combinations = new Map<string, number>();
  for (const requirement of value.requirements) {
    if (!object(requirement) || !keys(requirement, ["id", "from", "to", "range", "capabilities", "manifest"])
      || !identifier(requirement.id) || typeof requirement.from !== "string" || typeof requirement.to !== "string"
      || !ids.has(requirement.from) || !ids.has(requirement.to)
      || !(requirement.range === null || text(requirement.range)) || !capabilities(requirement.capabilities)) return refuse();
    if (requirement.manifest !== undefined && (!object(requirement.manifest)
      || !keys(requirement.manifest, ["pm_min_version", "pm_max_version"])
      || !Object.values(requirement.manifest).every(text))) return refuse();
    const range = parseRange(requirement.range as string | null);
    const size = (combinations.get(String(requirement.to)) ?? 1) * (range?.set.length ?? 1);
    if (size > 256) return refuse();
    combinations.set(String(requirement.to), size);
  }
  const requirements = value.requirements as unknown as CompatibilityRequirement[];
  if (new Set(requirements.map((requirement) => requirement.id)).size !== requirements.length) return refuse();
  const parsed: CompatibilityInput = structuredClone({ version: 1, components, requirements });
  for (const requirement of parsed.requirements) if (requirement.manifest === undefined) delete requirement.manifest;
  return parsed;
}

/** Unsupported metadata is unknown, including workspace/file/tag ranges; it is never a contradiction. */
function parseRange(value: string | null): Range | null {
  if (value === null || !value.trim()) return null;
  try { return new Range(value.trim()); } catch { return null; }
}

/** Internal control flow preserves the rejected range without exposing library exception text. */
class UnrepresentableRangeError extends Error {
  /** The source conjunction remains available to SDK/CLI consumers. */
  readonly range: string;
  /** Preserve representation failure separately from incompatibility. */
  constructor(range: string) {
    super("unrepresentable_range"); this.range = range;
  }
}

/** Translate a library rejection into a typed, actionable per-declaration result. */
function rangeReason(requirement: string, range: string): UnrepresentableRangeReason {
  return { requirement, code: "unrepresentable_range", range,
    remedy: "Supply a representable range or an observed version satisfying these declarations; no joint incompatibility was inferred from the rejected value." };
}

/** A library-produced version must itself survive the library parser before it can establish a verdict. */
function representedVersion(value: string | null, range: string): string {
  const normalized = valid(value as string);
  if (normalized === null) throw new UnrepresentableRangeError(range);
  return normalized;
}

/** A single validated producer supplies minima for both full conjunctions and their comparator constraints. */
function minimumWitnesses(range: Range): string[] {
  const minimum = minVersion(range);
  return minimum === null ? [] : [representedVersion(minimum.version, range.raw)];
}

/** Comparator intervals can disprove a conjunction without inventing a version or changing prerelease admission. */
function overlappingClause(clause: Range[]): boolean {
  const merged = new Range(clause.map((range) => range.range || "*").join(" "));
  return intersects(merged, merged, { includePrerelease: true });
}

/** Let semver produce witnesses; keep each declaration's prerelease admission predicate authoritative. */
function feasibleClause(clause: Range[]): boolean {
  if (!overlappingClause(clause)) return false;
  const merged = new Range(clause.map((range) => range.range || "*").join(" "));
  const accepts = (version: string): boolean => clause.every((range) => range.test(version));
  for (const candidate of minimumWitnesses(merged)) {
    if (accepts(candidate)) return true;
    if (accepts(representedVersion(inc(candidate, "patch"), merged.raw))) return true;
  }
  // A strict stable lower bound can hide an admitted prerelease core from minVersion.
  // Numeric identifier 0 is requested through semver's public increment operation.
  for (const range of clause) for (const comparators of range.set) for (const comparator of comparators) {
    if (!comparator.value || !comparator.semver.prerelease.length) continue;
    if (minimumWitnesses(new Range(comparator.value)).some(accepts)) return true;
    const minimumPre = representedVersion(inc(comparator.semver, "prerelease", "0", false), merged.raw);
    if (accepts(minimumPre)) return true;
  }
  return false;
}

/** Intersect using library comparator sets and operations, preserving every original prerelease predicate. */
function intersection(ranges: Range[], observed: readonly string[]): string[][] {
  if (!ranges.length) return [["*"]];
  const label = ranges.map((range) => range.raw).join(" && ");
  try {
    const literals = [...observed, "0.0.0", "0.0.0-0", ...ranges.flatMap((range) => range.set.flatMap((set) =>
      set.filter((comparator) => comparator.value).map((comparator) => comparator.semver.version)))];
    const witnessed = literals.some((version) => ranges.every((range) => range.test(version)));
    let clauses: Range[][] = [[]];
    for (const range of ranges) {
      const choices = range.set.map((set) => new Range(set.map((comparator) => comparator.value).join(" ") || "*"));
      clauses = clauses.flatMap((clause) => choices.map((choice) => [...clause, choice]));
    }
    // A supplied/declared valid witness proves nonemptiness without asking for a derived successor.
    // Keeping structurally possible empty branches changes no version admitted by the exact expression.
    const possible = clauses.filter(witnessed ? overlappingClause : feasibleClause);
    if (!possible.length) return [];
    if (clauses.length > 16) return [ranges.map((range) => range.range || "*")];
    return possible.map((clause) => clause.map((range) => range.range || "*"));
  } catch {
    throw new UnrepresentableRangeError(label);
  }
}

/** Exhaustive cardinality search uses the same library evaluator, including conservative representation refusals. */
function minimumConflict(entries: { id: string; range: Range }[], observed: readonly string[]): string[] {
  for (let size = 1; size < entries.length; size++) {
    for (let mask = 1; mask < 2 ** entries.length; mask++) {
      const subset = entries.filter((_, index) => (mask & (1 << index)) !== 0);
      if (subset.length === size && !intersection(subset.map((entry) => entry.range), observed).length) return subset.map((entry) => entry.id);
    }
  }
  return entries.map((entry) => entry.id);
}

/** Find a shortest upstream path; cycles terminate and disconnected cycles retain their own declaration. */
function chain(edge: CompatibilityRequirement, requirements: CompatibilityRequirement[]): string[] {
  const queue = [{ node: edge.from, path: [edge.id] }];
  const visited = new Set([edge.to, edge.from]);
  for (const current of queue) {
    const incoming = requirements.filter((entry) => entry.to === current.node);
    if (!incoming.length) return current.path;
    for (const parent of incoming) if (!visited.has(parent.from)) {
      visited.add(parent.from); queue.push({ node: parent.from, path: [parent.id, ...current.path] });
    }
  }
  return [edge.id];
}

/** Check every emitted numeric field before returning a successful report. */
export function validateCompatibilityCounts(counts: CompatibilityReport["counts"], rowCount: number): void {
  const values = Object.values(counts);
  if (!Number.isSafeInteger(rowCount) || rowCount < 1 || rowCount > 16 || values.length !== 3
    || !["compatible", "incompatible", "unknown"].every((key) => Object.hasOwn(counts, key))
    || !values.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 16)
    || values.reduce((sum, value) => sum + value, 0) !== rowCount) {
    throw new CompatibilityRefusal("invalid_compatibility_output", "Reject this report and regenerate from a valid bounded selection; report invalid counts to the producer.");
  }
}

/** Explain joint declarations without loading extensions, invoking commands or touching tracker state. */
export function explainCompatibility(value: unknown): CompatibilityReport {
  const input = parseCompatibilityInput(value);
  const requirements = input.requirements.sort((left, right) => left.id.localeCompare(right.id));
  const rows: CompatibilityRow[] = [];
  for (const component of input.components.sort((left, right) => left.id.localeCompare(right.id))) {
    const incoming = requirements.filter((entry) => entry.to === component.id);
    if (!incoming.length) continue;
    const unknown: CompatibilityRow["unknown"] = [];
    const conflicts: CompatibilityConflict[] = [];
    const known: { id: string; range: Range }[] = [];
    const current = component.version === null ? null : valid(component.version.trim());
    for (const entry of incoming) {
      const range = parseRange(entry.range);
      if (range === null) unknown.push(entry.range === null || !entry.range.trim()
        ? { requirement: entry.id, code: "range_unknown" } : rangeReason(entry.id, entry.range));
      else known.push({ id: entry.id, range });
      if (current === null) unknown.push({ requirement: entry.id, code: "version_unknown" });
      if (entry.capabilities === null || (entry.capabilities.length > 0 && component.capabilities === null)) unknown.push({ requirement: entry.id, code: "capabilities_unknown" });
      else if (entry.capabilities !== null && component.capabilities !== null) {
        for (const capability of entry.capabilities) if (!component.capabilities.includes(capability)) {
          conflicts.push({ code: "capability_conflict", requirements: [entry.id], detail: capability });
        }
      }
      if (entry.manifest !== undefined) {
        const result = checkNativeBounds(entry.manifest, { pmVersion: component.version?.trim() ?? "unknown" });
        for (const finding of result.findings) {
          if (finding.severity === "error") conflicts.push({ code: "extension_bound_conflict", requirements: [entry.id], detail: finding.code });
          else unknown.push({ requirement: entry.id, code: finding.code });
        }
      }
    }
    let common: string[][] | null = null;
    const observed = current === null ? [] : [current];
    try {
      common = intersection(known.map((entry) => entry.range), observed);
      if (!common.length) conflicts.unshift({ code: "joint_range_conflict", requirements: minimumConflict(known, observed), detail: "No version satisfies these declarations together." });
    } catch (error) {
      // The evaluator converts every library failure to this internal error contract.
      const rejected = error as UnrepresentableRangeError;
      common = null;
      for (const entry of known) unknown.push(rangeReason(entry.id, rejected.range));
    }
    if (current !== null && !conflicts.some((conflict) => conflict.code === "joint_range_conflict")) {
      const failed = known.find((entry) => !satisfies(current, entry.range));
      if (failed) conflicts.unshift({ code: "installed_pin_conflict", requirements: [failed.id], detail: current });
    }
    const status = conflicts.length ? "incompatible" : unknown.length ? "unknown" : "compatible";
    const relevant = new Set([...conflicts.flatMap((conflict) => conflict.requirements), ...unknown.map((entry) => entry.requirement)]);
    rows.push({ component, status, compatible_ranges: common !== null && (!common.length || known.length === incoming.length) ? common : null, conflicts, unknown,
      chains: incoming.filter((entry) => !relevant.size || relevant.has(entry.id)).map((entry) => chain(entry, requirements)),
      remedy: status === "compatible" ? "Declarations agree; core still decides extension admission." : status === "unknown"
        ? "Obtain missing or supported version/capability metadata and rerun; do not infer incompatibility." : "Review the minimum witnesses and compatible ranges; verify replacement metadata before changing any pin or capability declaration." });
  }
  const counts = { compatible: 0, incompatible: 0, unknown: 0 };
  for (const row of rows) counts[row.status]++;
  validateCompatibilityCounts(counts, rows.length);
  return { version: 1, ok: counts.incompatible + counts.unknown === 0, preview: true, requirements, rows, counts,
    commands: [["pm", "--version"], ["pm", "extension", "list", "--json"]] };
}

/** Read at most 64 KiB of regular JSON; no shell, Git, installs or configuration edits. */
export function readCompatibilityReasons(path: string): CompatibilityReport {
  let value: unknown;
  try { value = JSON.parse(readRegularText(path, 65536)); } catch {
    throw new CompatibilityRefusal("compatibility_input_unreadable", "Supply a readable regular JSON metadata file no larger than 64 KiB; exclude pipes, devices and directories.");
  }
  return explainCompatibility(value);
}

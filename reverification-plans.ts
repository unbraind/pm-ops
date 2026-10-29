/** Exact, read-only repair planning over caller-declared evidence and check contracts. */
import { createHash } from "node:crypto";
import { auditEvidenceExpiryFiles, type EvidenceExpiryOptions } from "./evidence-expiry.ts";
import { readRegularText } from "./regular-input.ts";

/** One explicit evidence classification; authenticity belongs to the supplying expiry evaluator. */
export interface ReverificationClaim {
  /** Public claim identity, independent of native item status names. */
  id: string;
  /** Existing evidence classification, never inferred from a planned check. */
  status: "fresh" | "revalidate" | "unavailable";
}
/** Caller-approved logical check; this module never runs commands. */
export interface ReverificationCheck {
  /** Unique public check identity. */
  id: string;
  /** Explicit caller approval; dependencies require their own approval too. */
  approved: boolean;
  /** Integer cost units, 0-1000000000, shared across the whole catalog. */
  cost: number;
  /** Checks that must succeed first; missing or cyclic prerequisites cause gaps. */
  requires: string[];
  /** Claims this check can support after a successful fresh rerun and receipt attachment. */
  supports: string[];
}
/** Strict bounded compiler input; no persisted state, executable code or implicit defaults. */
export interface ReverificationInput {
  /** Contract version. */
  version: 1;
  /** Complete declared evidence population, 1-32 unique claims. */
  claims: ReverificationClaim[];
  /** Explicit requested claim identities, 1-16 unique targets. */
  targets: string[];
  /** Up to 18 checks, permitting an exact bounded search instead of a greedy estimate. */
  checks: ReverificationCheck[];
}
/** Recoverable usage failures; no untrusted content or filesystem paths are echoed. */
export class ReverificationRefusal extends Error {
  /** Stable refusal classification. */
  readonly code: "invalid_reverification_input" | "invalid_reverification_plan";
  /** Public safe recovery instruction. */
  readonly remedy: string;
  /** Invalid contracts are usage failures. */
  readonly exitCode = 2;
  /** Construct a sanitized refusal with its remedy. */
  constructor(code: ReverificationRefusal["code"], remedy: string) {
    super(`${code}: ${remedy}`);
    this.name = "ReverificationRefusal"; this.code = code; this.remedy = remedy;
  }
}
/** Every target is accounted for, including targets that cannot be repaired. */
export interface ReverificationRow {
  /** Requested claim identity. */
  claim: string;
  /** A planned check is conditional, never fresh evidence. */
  code: "fresh" | "rerun_required" | "no_supporting_check" | "approval_required" | "dependency_unavailable";
  /** Selected supporting check, or null for fresh evidence and gaps. */
  check: string | null;
  /** Safe next action; empty only for already fresh evidence. */
  remedy: string;
}
/** Compact exact plan; ok means complete repair coverage, never an assurance verdict. */
export interface ReverificationPlan {
  /** Output contract version. */
  version: 1;
  /** Digest of the entire normalized input, including evidence states, costs and approvals. */
  id: string;
  /** True only when every target is fresh or has an approved, executable dependency closure. */
  ok: boolean;
  /** Exact integer total of selected checks, charged once each. */
  cost: number;
  /** Cost of rerunning every executable approved check, including irrelevant checks. */
  all_cost: number;
  /** Exact nonnegative difference from all_cost. */
  saved: number;
  /** Topological order; shared prerequisites appear exactly once. */
  steps: { id: string; cost: number; requires: string[] }[];
  /** Complete target accounting; no row truncation. */
  rows: ReverificationRow[];
}

/** Refuse a malformed boundary without exposing its contents. */
function invalid(): never {
  throw new ReverificationRefusal("invalid_reverification_input", "Supply strict version 1 JSON: 1-32 claims, 1-16 targets, 0-18 checks, unique public ids, explicit approvals, integer costs 0-1000000000, requires and supports arrays. Use smaller independently reviewed catalogs above these limits.");
}
/** Accept exactly the schema's own properties, rejecting unknown fields. */
function fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  for (const key of keys) if (!Object.hasOwn(value, key)) return false;
  return true;
}
/** Validate dense, bounded arrays before using array methods that skip holes. */
function dense(value: unknown, min: number, max: number): value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return false;
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) return false;
  return Object.keys(value).length === value.length;
}
/** Bounded public identifiers also permit ordinary prototype-shaped labels. */
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,47}$/.test(value);
}
/** Validate unique identifier arrays and canonicalize their set order. */
function identifiers(value: unknown, min: number, max: number): string[] {
  if (!dense(value, min, max) || !value.every(identifier) || new Set(value).size !== value.length) return invalid();
  return [...value].sort();
}
/** Single strict boundary schema shared by file readers, SDK callers and producers. */
export function parseReverificationInput(value: unknown): ReverificationInput {
  if (!fields(value, ["version", "claims", "targets", "checks"]) || value.version !== 1
    || !dense(value.claims, 1, 32) || !dense(value.checks, 0, 18)) return invalid();
  const claims = value.claims.map((entry): ReverificationClaim => {
    if (!fields(entry, ["id", "status"]) || !identifier(entry.id)
      || (entry.status !== "fresh" && entry.status !== "revalidate" && entry.status !== "unavailable")) return invalid();
    return { id: entry.id, status: entry.status };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const claimIds = new Set(claims.map((claim) => claim.id));
  if (claimIds.size !== claims.length) return invalid();
  const targets = identifiers(value.targets, 1, 16);
  if (targets.some((target) => !claimIds.has(target))) return invalid();
  const checks = value.checks.map((entry): ReverificationCheck => {
    if (!fields(entry, ["id", "approved", "cost", "requires", "supports"]) || !identifier(entry.id)
      || typeof entry.approved !== "boolean" || !Number.isSafeInteger(entry.cost) || Number(entry.cost) < 0 || Number(entry.cost) > 1_000_000_000) return invalid();
    const requires = identifiers(entry.requires, 0, 18);
    const supports = identifiers(entry.supports, 0, 32);
    if (supports.some((id) => !claimIds.has(id))) return invalid();
    return { id: entry.id, approved: entry.approved, cost: Number(entry.cost) || 0, requires, supports };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(checks.map((check) => check.id)).size !== checks.length) return invalid();
  return { version: 1, claims, targets, checks };
}

/** Compile one canonical input with exhaustive subset costs and dependency closure. */
function compile(input: ReverificationInput): ReverificationPlan {
  const { checks, targets } = input;
  const claims = new Map(input.claims.map((claim) => [claim.id, claim.status]));
  const indices = new Map(checks.map((check, index) => [check.id, index]));
  const closures = new Map<number, number>();
  /** Resolve prerequisites once; unapproved, missing and cyclic dependencies are unavailable. */
  function closure(index: number, visiting: Set<number>): number {
    const cached = closures.get(index);
    if (cached !== undefined) return cached;
    const check = checks[index]!;
    if (!check.approved) { closures.set(index, -1); return -1; }
    if (visiting.has(index)) return -1;
    visiting.add(index);
    let mask = 1 << index;
    for (const prerequisite of check.requires) {
      const next = indices.get(prerequisite);
      const dependency = next === undefined ? -1 : closure(next, visiting);
      if (dependency < 0) { mask = -1; break; }
      mask |= dependency;
    }
    visiting.delete(index); closures.set(index, mask);
    return mask;
  }
  for (let i = 0; i < checks.length; i++) closure(i, new Set());
  let needed = 0;
  let forbidden = 0;
  let allCost = 0;
  const coverage = checks.map((check, index) => {
    if (closures.get(index)! < 0) { forbidden |= 1 << index; return 0; }
    allCost += check.cost;
    let mask = 0;
    targets.forEach((id, bit) => { if (claims.get(id) !== "fresh" && check.supports.includes(id)) mask |= 1 << bit; });
    needed |= mask;
    return mask;
  });
  const size = 1 << checks.length;
  const costs = new Float64Array(size);
  const covered = new Uint32Array(size);
  const required = new Uint32Array(size);
  const counts = new Uint8Array(size);
  let best = 0; let bestCost = Number.MAX_SAFE_INTEGER; let bestCount = 19;
  // Every subset is visited; exact integer sums stay below 18 billion (< 2^53).
  for (let mask = 0; mask < size; mask++) {
    if (mask > 0) {
      const bit = mask & -mask; const index = 31 - Math.clz32(bit); const rest = mask ^ bit;
      costs[mask] = costs[rest]! + checks[index]!.cost;
      covered[mask] = covered[rest]! | coverage[index]!;
      required[mask] = required[rest]! | closures.get(index)!;
      counts[mask] = counts[rest]! + 1;
    }
    if ((mask & forbidden) !== 0 || (mask & required[mask]!) !== required[mask]!
      || covered[mask] !== needed) continue;
    const cost = costs[mask]!; const count = counts[mask]!;
    if (cost < bestCost || (cost === bestCost && count < bestCount)) { best = mask; bestCost = cost; bestCount = count; }
  }
  const steps: ReverificationPlan["steps"] = [];
  const emitted = new Set<string>();
  /** Emit shared prerequisites once, before every dependent. */
  function emit(index: number): void {
    const check = checks[index]!;
    if (emitted.has(check.id)) return;
    for (const prerequisite of check.requires) emit(indices.get(prerequisite)!);
    emitted.add(check.id); steps.push({ id: check.id, cost: check.cost, requires: [...check.requires] });
  }
  checks.forEach((_check, index) => { if ((best & (1 << index)) !== 0) emit(index); });
  const rows = targets.map((claim): ReverificationRow => {
    if (claims.get(claim) === "fresh") return { claim, code: "fresh", check: null, remedy: "" };
    const supporters = checks.filter((check) => check.supports.includes(claim));
    const selected = supporters.find((check) => emitted.has(check.id));
    if (selected) return { claim, code: "rerun_required", check: selected.id, remedy: "Run the approved dependency order through the existing runner; attach new accepted receipts and re-evaluate expiry before claiming freshness. Skip dependents if a prerequisite fails or is skipped." };
    const code = supporters.length === 0 ? "no_supporting_check" : supporters.every((check) => !check.approved) ? "approval_required" : "dependency_unavailable";
    return { claim, code, check: null, remedy: code === "no_supporting_check" ? "Declare a check that supports this claim." : code === "approval_required" ? "Review and explicitly approve a supporting check, then regenerate." : "Supply and approve every prerequisite and remove dependency cycles, then regenerate." };
  });
  const totals = { cost: bestCost, all_cost: allCost, saved: allCost - bestCost };
  validateReverificationCosts(totals);
  return { version: 1, id: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    ok: rows.every((row) => row.code === "fresh" || row.code === "rerun_required"), ...totals, steps, rows };
}

/** Enforce finite exact output totals and their documented arithmetic before returning a plan. */
export function validateReverificationCosts(value: unknown): void {
  if (!fields(value, ["cost", "all_cost", "saved"]) || Object.values(value).some((number) =>
    !Number.isSafeInteger(number) || Number(number) < 0 || Number(number) > 18_000_000_000)
    || Number(value.cost) > Number(value.all_cost) || Number(value.saved) !== Number(value.all_cost) - Number(value.cost)) {
    throw new ReverificationRefusal("invalid_reverification_plan", "Regenerate a plan whose exact integer costs satisfy 0 <= cost <= all_cost <= 18000000000 and saved = all_cost - cost.");
  }
}

/** Validate once, then compute the exact minimum-cost approved repair set without I/O. */
export function compileReverificationPlan(value: unknown): ReverificationPlan {
  return compile(parseReverificationInput(value));
}

/** Validate a transported plan by regenerating it through the same compiler and source contract. */
export function parseReverificationPlan(value: unknown, input: unknown): ReverificationPlan {
  const expected = compileReverificationPlan(input);
  // Canonical field order is the producer's version 1 serialization contract.
  let matches = false;
  try { matches = JSON.stringify(value) === JSON.stringify(expected); } catch { /* Cyclic or non-JSON output is an invalid artifact. */ }
  if (!matches) throw new ReverificationRefusal("invalid_reverification_plan", "Regenerate the plan from its current evidence and approved check contract; never replay a saved plan as current evidence.");
  return expected;
}

/** Read strict bounded JSON while keeping path and parser diagnostics private. */
export function readReverificationInput(path: string): ReverificationInput {
  let value: unknown;
  try { value = JSON.parse(readRegularText(path, 65536)); }
  catch { throw new ReverificationRefusal("invalid_reverification_input", "Supply a readable regular JSON file no larger than 64 KiB; pipes, devices and directories are unsupported. Then validate the version 1 check contract."); }
  return parseReverificationInput(value);
}

/** Re-read canonical expiry evidence before compiling; missing attachments remain unavailable. */
export async function auditReverificationFiles(pmRoot: string, policy: string, versions: string, input: string,
  options: EvidenceExpiryOptions = {}): Promise<ReverificationPlan> {
  const parsed = readReverificationInput(input);
  const expiry = await auditEvidenceExpiryFiles(pmRoot, policy, versions, { ...options, limit: 1000 });
  const observed = new Map(expiry.rows.map((row) => [row.id, row.status]));
  // The CLI cannot promote caller declarations to fresh evidence.
  parsed.claims = parsed.claims.map((claim) => ({ id: claim.id, status: observed.get(claim.id) ?? "unavailable" }));
  return compile(parsed);
}

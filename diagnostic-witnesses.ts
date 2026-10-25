/** Exact, bounded reduction of declared diagnostic inputs; no execution or state changes. */
import { readRegularInput } from "./regular-input.ts";
import { DIAGNOSTIC_COMMANDS, type DiagnosticCommand } from "./diagnostic-plans.ts";

/** One explicit public input value, unique within its scope and key. */
export interface DiagnosticFact {
  /** Unique portable reference. */
  id: string;
  /** Exact public environment/snapshot identity; never inferred from tracker paths. */
  scope: string;
  /** Input name, such as sdk.actual or sdk.required. */
  key: string;
  /** Exact input text, preserved without whitespace normalization. */
  value: string;
}
/** A declared failure with alternative sufficient input sets, not a causal proof. */
export interface WitnessCheck {
  /** Affected check identity. */
  id: string;
  /** Declared failure class. */
  failure: string;
  /** Exact scope matching every referenced fact. */
  scope: string;
  /** Existing canonical read-only probe to reproduce the observation. */
  command: DiagnosticCommand;
  /** Observed failure or unverified explanation; neither means proven root cause. */
  diagnosis: "observed" | "unverified";
  /** Each nonempty clause declares all facts sufficient together, not independently. */
  sufficient: string[][];
}
/** Strict input contract, capped for exhaustive minimization. */
export interface DiagnosticWitnessInput {
  /** Contract version. */
  version: 1;
  /** One through sixteen explicit facts. */
  facts: DiagnosticFact[];
  /** One through sixty-four unique affected checks, each with at most eight alternatives. */
  checks: WitnessCheck[];
}
/** One common evidence set, retaining every affected check and its epistemic level. */
export interface DiagnosticWitness extends Pick<WitnessCheck, "failure" | "scope" | "diagnosis"> {
  /** Minimal sufficient clause selected for these checks. */
  facts: string[];
  /** Sorted affected identities; none are omitted. */
  checks: Pick<WitnessCheck, "id" | "command">[];
}
/** Compact self-contained evidence; ok denotes reduction success, not diagnostic success. */
export interface DiagnosticWitnessReport {
  /** Output contract version. */
  version: 1;
  /** The complete input was accepted and reduced. */
  ok: true;
  /** Sufficiency is caller-declared and never promoted to causal verification. */
  basis: "declared_sufficiency";
  /** Exact global minimum number of distinct retained facts. */
  minimal: true;
  /** Original fact count, including facts removed by reduction. */
  input_facts: number;
  /** Complete affected check count. */
  affected_checks: number;
  /** Exact number of input facts not needed by the selected clauses. */
  omitted_facts: number;
  /** Only selected facts; all exact values remain intact. */
  facts: DiagnosticFact[];
  /** Separate failure classes, scopes and diagnosis levels never coalesce. */
  witnesses: DiagnosticWitness[];
}
/** Data-free refusal with an actionable remedy. */
export class WitnessRefusal extends Error {
  /** Stable classification. */
  readonly code: "invalid_witness_input" | "witness_input_unreadable" | "invalid_witness_output";
  /** Recovery instruction. */
  readonly remedy: string;
  /** Input refusals are usage failures. */
  readonly exitCode = 2;
  /** Exclude raw input, paths and parser errors. */
  constructor(code: WitnessRefusal["code"], remedy: string) {
    super(`${code}: ${remedy}`); this.name = "WitnessRefusal"; this.code = code; this.remedy = remedy;
  }
}

/** Strict object schema primitive; unknown and missing keys refuse. */
function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
/** Dense bounded arrays only, including at the direct SDK boundary. */
function array(value: unknown, max: number): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && value.length <= max
    && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean);
}
/** Portable labels exclude whitespace, paths and raw exception text. */
function label(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(value);
}
/** One strict schema validates every entry path before reduction. */
export function parseDiagnosticWitnessInput(value: unknown): DiagnosticWitnessInput {
  const refuse = (): never => { throw new WitnessRefusal("invalid_witness_input", "Supply version 1 with 1-16 unique scoped facts and 1-64 unique checks; each check needs 1-8 nonempty sufficient clauses referencing facts in its scope. Split larger selections. Use canonical diagnostic commands and observed or unverified diagnosis only."); };
  if (!object(value, ["version", "facts", "checks"]) || value.version !== 1 || !array(value.facts, 16) || !array(value.checks, 64)) return refuse();
  const facts = new Map<string, DiagnosticFact>();
  const keys = new Set<string>();
  for (const fact of value.facts) {
    if (!object(fact, ["id", "scope", "key", "value"]) || !label(fact.id) || !label(fact.scope) || !label(fact.key)
      || typeof fact.value !== "string" || fact.value.length < 1 || fact.value.length > 256 || facts.has(fact.id)) return refuse();
    const key = JSON.stringify([fact.scope, fact.key]);
    if (keys.has(key)) return refuse();
    keys.add(key); facts.set(fact.id, { id: fact.id, scope: fact.scope, key: fact.key, value: fact.value });
  }
  const ids = new Set<string>();
  const checks: WitnessCheck[] = [];
  for (const check of value.checks) {
    if (!object(check, ["id", "failure", "scope", "command", "diagnosis", "sufficient"]) || !label(check.id) || ids.has(check.id)
      || !label(check.failure) || !label(check.scope) || (typeof check.command !== "string" || !DIAGNOSTIC_COMMANDS.includes(check.command as DiagnosticCommand))
      || (check.diagnosis !== "observed" && check.diagnosis !== "unverified") || !array(check.sufficient, 8)) return refuse();
    const sufficient: string[][] = [];
    for (const clause of check.sufficient) {
      if (!array(clause, 16) || !clause.every((ref) => typeof ref === "string" && facts.get(ref)?.scope === check.scope) || new Set(clause).size !== clause.length) return refuse();
      sufficient.push((clause as string[]).slice().sort());
    }
    ids.add(check.id);
    checks.push({ id: check.id, failure: check.failure, scope: check.scope, command: check.command as DiagnosticCommand, diagnosis: check.diagnosis, sufficient });
  }
  return { version: 1, facts: [...facts.values()].sort((a, b) => a.id < b.id ? -1 : 1), checks: checks.sort((a, b) => a.id < b.id ? -1 : 1) };
}
/** Count selected facts in a mask bounded to sixteen bits. */
function population(mask: number): number {
  let count = 0;
  for (; mask; mask &= mask - 1) count++;
  return count;
}
/** Check every emitted numeric field before ok, also usable by consumers validating transport counts. */
export function validateDiagnosticWitnessCounts(report: Pick<DiagnosticWitnessReport, "version" | "input_facts" | "affected_checks" | "omitted_facts">): void {
  if (report.version !== 1 || !Number.isSafeInteger(report.input_facts) || report.input_facts < 1 || report.input_facts > 16
    || !Number.isSafeInteger(report.affected_checks) || report.affected_checks < 1 || report.affected_checks > 64
    || !Number.isSafeInteger(report.omitted_facts) || report.omitted_facts < 0 || report.omitted_facts >= report.input_facts) {
    throw new WitnessRefusal("invalid_witness_output", "Reject this packet and regenerate from a valid bounded selection; report invalid output counts to the producer.");
  }
}
/** Find the exact minimum union of declared sufficient clauses; deterministic mask order breaks ties. */
export function reduceDiagnosticWitnesses(input: unknown): DiagnosticWitnessReport {
  const parsed = parseDiagnosticWitnessInput(input);
  const positions = new Map(parsed.facts.map((fact, index) => [fact.id, 1 << index]));
  const clauses = parsed.checks.map((check) => check.sufficient.map((refs) => ({ refs, mask: refs.reduce((mask, ref) => mask | positions.get(ref)!, 0) }))
    .sort((a, b) => a.refs.length - b.refs.length || a.mask - b.mask));
  let selected = (1 << parsed.facts.length) - 1;
  let size = parsed.facts.length;
  for (let mask = 1; mask < (1 << parsed.facts.length); mask++) {
    const count = population(mask);
    if (count >= size) continue;
    if (clauses.every((choices) => choices.some((clause) => (clause.mask & mask) === clause.mask))) { selected = mask; size = count; }
  }
  const groups = new Map<string, DiagnosticWitness>();
  for (const [index, check] of parsed.checks.entries()) {
    const chosen = clauses[index]!.find((clause) => (clause.mask & selected) === clause.mask)!;
    const { failure, scope, command, diagnosis } = check;
    const key = JSON.stringify([failure, scope, diagnosis, chosen.refs]);
    const group = groups.get(key);
    if (group) group.checks.push({ id: check.id, command });
    else groups.set(key, { failure, scope, diagnosis, facts: chosen.refs, checks: [{ id: check.id, command }] });
  }
  const report: DiagnosticWitnessReport = { version: 1, ok: true, basis: "declared_sufficiency", minimal: true, input_facts: parsed.facts.length,
    affected_checks: parsed.checks.length, omitted_facts: parsed.facts.length - size,
    facts: parsed.facts.filter((_, index) => (selected & (1 << index)) !== 0), witnesses: [...groups.values()] };
  validateDiagnosticWitnessCounts(report);
  return report;
}
/** Read bounded JSON, then pass through the same strict SDK schema exactly once. */
export function readDiagnosticWitnesses(path: string): DiagnosticWitnessReport {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readRegularInput(path, 65536))); }
  catch { throw new WitnessRefusal("witness_input_unreadable", "Supply a readable regular JSON witness input file no larger than 64 KiB; exclude pipes, devices and directories."); }
  return reduceDiagnosticWitnesses(value);
}

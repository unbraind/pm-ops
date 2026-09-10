/**
 * Command-line launcher for the canonical lifecycle-policy drift checker.
 *
 * Shells out to the repo-pinned `pm` binary for `pm schema policies --json`,
 * hands the parsed policy document to the pure {@link verify} function, prints
 * a readable report, and exits non-zero on drift. The I/O is separated from the
 * rules so the suite can drive the checker against an injected executor rather
 * than only against this repository, which happens to satisfy the contract.
 *
 * @packageDocumentation
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import {
  CANONICAL_FLEET_LIFECYCLE_POLICY,
  report,
  verify,
  type CanonicalLifecyclePolicy,
  type LifecyclePolicyDrift,
  type PolicyDocument,
  type PolicyEnforcement,
  type PolicyEffect,
  type WorkflowPolicy,
} from "../lifecycle-policy.ts";
import { isMainInvocation } from "./main-invocation.ts";

export * from "../lifecycle-policy.ts";

/** The executor signature `readInstalledPolicies` accepts. */
export interface PolicyExecutor {
  /**
   * Run a command and return its stdout, throwing on a non-zero exit.
   * @param command - The program to run.
   * @param args - The program arguments.
   * @param options - The spawn options.
   * @returns The process stdout as a string.
   */
  (command: string, args: readonly string[], options: { cwd: string }): string;
}

/** The envelope `pm schema policies --json` prints around the policy document. */
interface PoliciesEnvelope {
  /** Whether the command produced a policy result. */
  readonly policy_result: boolean;
  /** The action the command performed. */
  readonly action: string;
  /** The policy document nested under `result`. */
  readonly result: PolicyDocument;
}

/**
 * Resolve the repo-pinned `pm` binary for a repository root.
 *
 * The binary is pinned under `devDependencies` so CI and a working copy resolve
 * the same CLI; resolving it from the repo rather than `PATH` keeps the
 * lifecycle-policy gate against the version the rest of `release:check` uses.
 *
 * @param root - Repository root to resolve the binary under.
 * @returns The absolute path to the pinned `pm` binary.
 */
export function resolvePmBinary(root: string): string {
  return resolve(root, "node_modules", ".bin", "pm");
}

/**
 * Default executor: runs a real local process and returns its stdout.
 *
 * @param command - The program to run.
 * @param args - The program arguments.
 * @param options - The spawn options.
 * @returns The process stdout as a string.
 */
export function defaultExec(
  command: string,
  args: readonly string[],
  options: { cwd: string },
): string {
  return execFileSync(command, args as string[], {
    cwd: options.cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Whether a value is a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Whether a value is a readonly array of non-empty strings. */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

/** Whether a value is a policy effect. */
function isPolicyEffect(value: unknown): value is PolicyEffect {
  return value === "advise" || value === "warn" || value === "refuse";
}

/** Whether a value is a policy enforcement mode. */
function isPolicyEnforcement(value: unknown): value is PolicyEnforcement {
  return value === "advise" || value === "refuse";
}

/**
 * Narrow an unknown parsed policy to a typed {@link WorkflowPolicy}, or throw.
 *
 * `pm schema policies --json` is trusted to be well-formed, but the canonical
 * contract is checked rather than assumed: a policy missing its `rule`, with an
 * unknown `effect`, or with a non-array `fields` is a drift the checker cannot
 * reason about and is rejected loudly rather than coerced into a plausible
 * shape.
 *
 * @param value - The parsed policy to narrow.
 * @returns The typed policy.
 * @throws When the policy does not match the declared shape.
 */
function narrowPolicy(value: unknown): WorkflowPolicy {
  if (typeof value !== "object" || value === null) {
    throw new Error(`policy is not an object: ${JSON.stringify(value)}`);
  }
  const v = value as Record<string, unknown>;
  if (!isNonEmptyString(v.id)) throw new Error(`policy id is missing: ${JSON.stringify(value)}`);
  if (!isPolicyEffect(v.effect)) throw new Error(`policy ${v.id}: effect is not advise|warn|refuse: ${JSON.stringify(v.effect)}`);
  if (typeof v.description !== "string") throw new Error(`policy ${v.id}: description is missing`);
  const subject = v.subject;
  if (typeof subject !== "object" || subject === null) throw new Error(`policy ${v.id}: subject is missing`);
  const s = subject as Record<string, unknown>;
  if (s.types !== undefined && !isStringArray(s.types)) throw new Error(`policy ${v.id}: subject.types is not a string array`);
  if (!isStringArray(s.statuses)) throw new Error(`policy ${v.id}: subject.statuses is not a string array`);
  const rule = v.rule;
  if (typeof rule !== "object" || rule === null) throw new Error(`policy ${v.id}: rule is missing`);
  const r = rule as Record<string, unknown>;
  if (r.kind !== "require_fields") throw new Error(`policy ${v.id}: rule.kind is not require_fields: ${JSON.stringify(r.kind)}`);
  if (!isStringArray(r.fields)) throw new Error(`policy ${v.id}: rule.fields is not a string array`);
  return {
    id: v.id,
    effect: v.effect,
    description: v.description,
    subject: { types: s.types, statuses: s.statuses },
    rule: { kind: "require_fields", fields: r.fields },
  };
}

/**
 * Parse the `pm schema policies --json` envelope into a typed document.
 *
 * @param output - The raw stdout of `pm schema policies --json`.
 * @returns The nested policy document.
 * @throws When the output is not the expected envelope or document.
 */
export function parsePoliciesOutput(output: string): PolicyDocument {
  const parsed: unknown = JSON.parse(output);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`policies output is not an object: ${output.slice(0, 200)}`);
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.policy_result !== true) {
    throw new Error(`policies output has no policy_result: ${output.slice(0, 200)}`);
  }
  const result = envelope.result;
  if (typeof result !== "object" || result === null) {
    throw new Error(`policies output has no result: ${output.slice(0, 200)}`);
  }
  const d = result as Record<string, unknown>;
  if (typeof d.version !== "number") throw new Error(`policy document version is missing`);
  if (!isPolicyEnforcement(d.enforcement)) {
    throw new Error(`policy document enforcement is not advise|refuse: ${JSON.stringify(d.enforcement)}`);
  }
  if (!Array.isArray(d.policies)) throw new Error(`policy document policies is not an array`);
  const policies = (d.policies as unknown[]).map(narrowPolicy);
  return { version: d.version, enforcement: d.enforcement, policies };
}

/**
 * Read a repository's installed policy document via the pinned `pm` binary.
 *
 * @param root - Repository root to read from.
 * @param exec - The executor to run `pm schema policies --json`; defaults to
 *   {@link defaultExec}.
 * @returns The parsed installed policy document.
 */
export function readInstalledPolicies(
  root: string,
  exec: PolicyExecutor = defaultExec,
): PolicyDocument {
  const pm = resolvePmBinary(root);
  const output = exec(pm, ["schema", "policies", "--json"], { cwd: root });
  return parsePoliciesOutput(output);
}

/**
 * Read and verify a repository's installed policies against the canonical set.
 *
 * @param root - Repository root to verify.
 * @param exec - The executor to run `pm`; defaults to {@link defaultExec}.
 * @param canonical - The canonical contract to compare against; defaults to
 *   {@link CANONICAL_FLEET_LIFECYCLE_POLICY}.
 * @returns The drift report.
 */
export function verifyRepo(
  root: string,
  exec: PolicyExecutor = defaultExec,
  canonical: CanonicalLifecyclePolicy = CANONICAL_FLEET_LIFECYCLE_POLICY,
): LifecyclePolicyDrift {
  return verify(readInstalledPolicies(root, exec), canonical);
}

/**
 * The instant the canonical contract was adopted, as an ISO-8601 timestamp.
 *
 * The completeness validator is retroactive: it evaluates every closed item
 * against the currently installed policies, including items closed long before
 * those policies existed. Those items cannot satisfy the contract honestly —
 * the evidence a rule asks for was never recorded, and inventing it produces a
 * field that restates the title and says nothing. A first attempt at this
 * contract did exactly that in twelve items, and because the policies are
 * installed at `refuse`, the engine then blocked removing the placeholder text
 * it had induced. Fabricated evidence in a tracker is worse than absent
 * evidence, because absent evidence is legible as absent.
 *
 * So the gate is scoped in time rather than applied retroactively. Work that
 * reached a terminal status at or after this instant must carry its declared
 * evidence and fails CI when it does not; work that closed before it is
 * reported as a backlog and does not fail. The `refuse` policies themselves are
 * untouched by this scoping — they act at transition time, so no NEW close can
 * omit its evidence regardless of what this verifier reports.
 */
export const CONTRACT_ADOPTED_AT = "2026-09-10T21:00:00.000Z";

/** One completeness violation as `pm ops validate --check-completeness` reports it. */
export interface CompletenessViolation {
  /** The offending item's id. */
  readonly id: string;
  /** The item type the policy matched on. */
  readonly type: string;
  /** The lifecycle status the item is in. */
  readonly status: string;
  /** The policy decision, including which required fields are missing. */
  readonly decision?: { readonly missing_fields?: readonly string[] };
}

/** A completeness result partitioned by whether the contract governs the item. */
export interface ScopedCompleteness {
  /** Violations on work that closed at or after adoption. These fail the gate. */
  readonly governed: readonly CompletenessViolation[];
  /** Violations on work that closed before adoption. Reported, not failed. */
  readonly predating: readonly CompletenessViolation[];
}

/**
 * Split completeness violations into the governed set and the pre-adoption backlog.
 *
 * An item is governed when its terminal timestamp is known and is not earlier
 * than `adoptedAt`. An item whose terminal timestamp is **unknown** is treated
 * as governed: the alternative fails open, and a missing timestamp is exactly
 * what a workspace edit that bypassed the CLI would produce.
 *
 * @param violations - Violations as the validator reported them.
 * @param terminalAtById - Each violating item's terminal timestamp, by id.
 * @param adoptedAt - The adoption instant, ISO-8601.
 * @returns The violations split into governed and predating.
 */
export function scopeCompletenessByAdoption(
  violations: readonly CompletenessViolation[],
  terminalAtById: ReadonlyMap<string, string | undefined>,
  adoptedAt: string = CONTRACT_ADOPTED_AT,
): ScopedCompleteness {
  const boundary = Date.parse(adoptedAt);
  const governed: CompletenessViolation[] = [];
  const predating: CompletenessViolation[] = [];
  for (const violation of violations) {
    const terminalAt = terminalAtById.get(violation.id);
    const closedAt = terminalAt === undefined ? Number.NaN : Date.parse(terminalAt);
    if (Number.isNaN(closedAt) || closedAt >= boundary) governed.push(violation);
    else predating.push(violation);
  }
  return { governed, predating };
}

/**
 * Render a scoped completeness result and choose the exit code.
 *
 * @param scoped - The partitioned violations.
 * @param write - Sink for each report line.
 * @param setExitCode - Sink for the process exit code.
 */
export function reportCompleteness(
  scoped: ScopedCompleteness,
  write: (line: string) => void,
  setExitCode: (code: number) => void,
): void {
  for (const violation of scoped.predating) {
    const missing = violation.decision?.missing_fields?.join(", ") ?? "unknown fields";
    write(`backlog - ${violation.id} closed before the contract and is missing ${missing}`);
  }
  if (scoped.predating.length > 0) {
    write(
      `note - ${scoped.predating.length} item(s) closed before ${CONTRACT_ADOPTED_AT}; `
      + "these are reported, not failed, because the evidence they lack was never recorded",
    );
  }
  for (const violation of scoped.governed) {
    const missing = violation.decision?.missing_fields?.join(", ") ?? "unknown fields";
    write(`fail - ${violation.id} (${violation.type}, ${violation.status}) is missing ${missing}`);
  }
  if (scoped.governed.length > 0) {
    write(`verify-lifecycle-policy: ${scoped.governed.length} governed item(s) lack declared evidence.`);
    setExitCode(1);
    return;
  }
  write("verify-lifecycle-policy: every item governed by the contract carries its declared evidence.");
}

/**
 * Run the completeness validator and scope its violations by adoption date.
 *
 * Each violating item's terminal timestamp is read with `pm get`, one call per
 * violation, so the cost is bounded by the number of violations rather than by
 * the corpus. `completed_at` is preferred over `closed_at` because a cancelled
 * item carries only the latter.
 *
 * @param root - Repository root to validate.
 * @param exec - The executor to run `pm`; defaults to {@link defaultExec}.
 * @param adoptedAt - The adoption instant; defaults to {@link CONTRACT_ADOPTED_AT}.
 * @returns The violations split into governed and predating.
 */
export function readScopedCompleteness(
  root: string,
  exec: PolicyExecutor = defaultExec,
  adoptedAt: string = CONTRACT_ADOPTED_AT,
): ScopedCompleteness {
  const pm = resolvePmBinary(root);
  const raw = exec(pm, ["ops", "validate", "--check-completeness", "--all-affected-ids", "--json"], { cwd: root });
  const parsed = JSON.parse(raw) as { checks?: ReadonlyArray<{ details?: { violations?: readonly CompletenessViolation[] } }> };
  const violations = parsed.checks?.[0]?.details?.violations ?? [];
  const terminalAtById = new Map<string, string | undefined>();
  for (const violation of violations) {
    const item = JSON.parse(exec(pm, ["get", violation.id, "--json"], { cwd: root })) as {
      item?: { completed_at?: string; closed_at?: string };
    };
    terminalAtById.set(violation.id, item.item?.completed_at ?? item.item?.closed_at);
  }
  return scopeCompletenessByAdoption(violations, terminalAtById, adoptedAt);
}

/**
 * Verify and report, but only when this module is the process entry point.
 *
 * The guard is a function rather than a bare `if` at module scope so the suite
 * can execute both answers. A bare `if` leaves its own body unreachable from
 * any in-process test, which is how an entry point quietly stops running.
 *
 * @param argv - The process argv to judge.
 * @param moduleUrl - This module's `import.meta.url`.
 * @param root - Repository root to verify.
 * @param exec - The executor to run `pm`; defaults to {@link defaultExec}.
 * @returns True when the verifier ran.
 */
export function runIfMain(
  argv: string[],
  moduleUrl: string,
  root: string,
  exec: PolicyExecutor = defaultExec,
): boolean {
  if (!isMainInvocation(argv, moduleUrl)) return false;
  const write = (line: string): void => { process.stdout.write(`${line}\n`); };
  const fail = (code: number): void => { process.exitCode = code; };
  report(verifyRepo(root, exec), write, fail);
  reportCompleteness(readScopedCompleteness(root, exec), write, fail);
  return true;
}

runIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."));
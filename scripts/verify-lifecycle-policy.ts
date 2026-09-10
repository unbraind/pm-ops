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
  report(
    verifyRepo(root, exec),
    (line) => process.stdout.write(`${line}\n`),
    (code) => { process.exitCode = code; },
  );
  return true;
}

runIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."));
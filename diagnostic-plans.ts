/** Reviewed, scope-bound orchestration over a closed read-only diagnostic catalog. */
import { readRegularText } from "./regular-input.ts";
import { createHash } from "node:crypto";
import { CaptureRefusal, spawnSync } from "./subprocess.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";

/** Accepted observations; raw failure output is never retained. */
export const DIAGNOSTIC_FAILURES = ["schema_unreadable", "items_unreadable", "history_invalid", "registry_unavailable"] as const;
/** Failure classifications callers derive from their observed scan/report failures. */
export type DiagnosticFailure = typeof DIAGNOSTIC_FAILURES[number];
/** Fixed catalog identities, independent of executable locations. */
export type DiagnosticCommand = "sdk:schema:v1" | "sdk:items:v1" | "sdk:history:v1" | "http:registry-head:v1";
/** Hard ceilings, charged before dispatch; network counts logical HTTP requests. */
export interface DiagnosticBudget {
  /** Maximum total child launches, including failed launches; 0-4. */
  processes: number;
  /** Maximum HTTP requests; 0-1. Local SDK probes use zero. */
  network: number;
  /** Shared wall-clock deadline, including process startup; 1-60000 ms. */
  time_ms: number;
}
/** One ordered, fixed-cost catalog invocation. */
export interface DiagnosticStep {
  /** Stable command identity; no shell or caller-supplied code. */
  command: DiagnosticCommand;
  /** Observed classification that selected this command. */
  failure: DiagnosticFailure;
  /** Worst-case reservation charged before launching. */
  cost: { processes: 1; network: number };
}
/** Portable review artifact; contains no paths, secrets or raw failure text. */
export interface DiagnosticPlan {
  /** Catalog and receipt format version. */
  version: 1;
  /** SHA-256 binding to the canonical tracker directory, excluding its cleartext path. */
  scope: string;
  /** Deterministic digest of scope, catalog steps and budgets. */
  id: string;
  /** Reviewable hard resource ceilings. */
  budget: DiagnosticBudget;
  /** Deduplicated catalog order; at most four steps. */
  steps: DiagnosticStep[];
}
/** Safe machine-readable refusal with a fixed recovery instruction. */
export class DiagnosticRefusal extends Error {
  /** Stable error category. */
  readonly code: "invalid_plan" | "invalid_options" | "scope_unavailable" | "scope_mismatch" | "selection_required";
  /** Safe next action. */
  readonly remedy: string;
  /** Invalid or unselected input is a usage refusal. */
  readonly exitCode = 2;
  /** Construct without retaining untrusted input or raw errors. */
  constructor(code: DiagnosticRefusal["code"], remedy: string) {
    super(`${code}: ${remedy}`);
    this.name = "DiagnosticRefusal"; this.code = code; this.remedy = remedy;
  }
}
/** Receipt codes never carry subprocess output. */
export type DiagnosticCode = "verified" | "probe_failed" | "output_limit" | "network_budget" | "process_budget" | "time_budget";
/** One sanitized receipt, including skipped probes so scope never silently shrinks. */
export interface DiagnosticReceipt {
  /** Exact reviewed command identity. */
  command: DiagnosticCommand;
  /** Why the probe ran or could not run. */
  code: DiagnosticCode;
  /** Verified item, schema-type or history-entry count; zero for failures and skipped probes. */
  checked: number;
  /** Fixed, data-free next action. */
  remedy: string;
}
/** Compact result retains every planned identity, even after exhaustion. */
export interface DiagnosticRun {
  /** Receipt format. */
  version: 1;
  /** Selected plan digest. */
  plan: string;
  /** Exact reviewed scope digest. */
  scope: string;
  /** True only when every probe verified. Inspect this diagnostic predicate. */
  ok: boolean;
  /** Reserved resources and measured wall time. */
  used: DiagnosticBudget;
  /** Complete ordered receipt set. */
  rows: DiagnosticReceipt[];
}

const COMMANDS: readonly DiagnosticCommand[] = ["sdk:schema:v1", "sdk:items:v1", "sdk:history:v1", "http:registry-head:v1"];
const REMEDIES: Record<DiagnosticCode, string> = {
  verified: "", probe_failed: "Restore readable tracker data or registry reachability, then review and retry the same scope.",
  output_limit: "Reduce diagnostic output or stream bulk data to a file, then review and retry the same scope.",
  network_budget: "Review a new plan with a sufficient network ceiling, or omit registry diagnostics.",
  process_budget: "Review a new plan with a sufficient process ceiling or fewer observations.",
  time_budget: "Review a new plan with a longer deadline or fewer observations.",
};
/** Stable content identity for a canonical JSON value. */
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/** Normalize bounded caller input before scope I/O or process execution. */
function makePlan(scope: string, failures: readonly DiagnosticFailure[], budget: DiagnosticBudget): DiagnosticPlan {
  if (!Array.isArray(failures) || failures.length < 1 || failures.length > 32 || failures.some((entry) => !DIAGNOSTIC_FAILURES.includes(entry))
    || !budget || !Number.isInteger(budget.processes) || budget.processes < 0 || budget.processes > 4
    || !Number.isInteger(budget.network) || budget.network < 0 || budget.network > 1
    || !Number.isInteger(budget.time_ms) || budget.time_ms < 1 || budget.time_ms > 60000) {
    throw new DiagnosticRefusal("invalid_options", "Supply known failure codes and integer ceilings: processes 0-4, network 0-1, time_ms 1-60000.");
  }
  const steps = DIAGNOSTIC_FAILURES.flatMap((failure, index): DiagnosticStep[] => failures.includes(failure)
    ? [{ failure, command: COMMANDS[index]!, cost: { processes: 1, network: index === 3 ? 1 : 0 } }] : []);
  const body = { version: 1 as const, scope, budget: { processes: budget.processes, network: budget.network, time_ms: budget.time_ms }, steps };
  return { ...body, id: digest(body) };
}
/** Resolve the selected directory once, sanitizing resolution failures. */
async function trackerScope(pmRoot: string): Promise<{ root: string; scope: string }> {
  try { const root = await realpath(pmRoot); return { root, scope: digest(root) }; }
  catch { throw new DiagnosticRefusal("scope_unavailable", "Select an existing readable tracker directory and regenerate the plan."); }
}
/** Generate a review artifact only; does not launch probes or write the tracker. */
export async function createDiagnosticPlan(pmRoot: string, failures: readonly DiagnosticFailure[],
  budget: DiagnosticBudget = { processes: 3, network: 0, time_ms: 10000 }): Promise<DiagnosticPlan> {
  makePlan("", failures, budget);
  return makePlan((await trackerScope(pmRoot)).scope, failures, budget);
}
/** Reject tampering, extra fields and stale catalog definitions before execution. */
export function parseDiagnosticPlan(value: unknown): DiagnosticPlan {
  try {
    const plan = value as DiagnosticPlan;
    if (plan.version !== 1 || !/^[a-f0-9]{64}$/.test(plan.scope)) throw new Error();
    const expected = makePlan(plan.scope, plan.steps.map((step) => step.failure), plan.budget);
    // Object key order is immaterial; every defined field and no unknown fields must match.
    if (digest(canonical(value)) !== digest(canonical(expected))) throw new Error();
    return expected;
  } catch { throw new DiagnosticRefusal("invalid_plan", "Regenerate the version 1 plan and review its unchanged commands, scope and budgets."); }
}
/** Sort object keys while preserving semantic array order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
/** Launch a bounded isolated worker; project only a validated numeric count. */
function probe(command: DiagnosticCommand, root: string, time: number): { code: DiagnosticCode; checked: number } {
  const module = new URL(`./diagnostic-probes${extname(fileURLToPath(import.meta.url))}`, import.meta.url).href;
  const scratch = mkdtempSync(join(tmpdir(), "pm-diagnostic-"));
  try {
    const script = `import { runDiagnosticProbe } from ${JSON.stringify(module)};`
      + ' try { const checked = await runDiagnosticProbe(process.argv[1], process.argv[2], process.argv[3]); process.stdout.write(JSON.stringify({checked})); } catch { process.exitCode = 1; }';
    const result = spawnSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "--eval", script, command, root, scratch], {
      cwd: root, timeout: time, killSignal: "SIGKILL", maxBuffer: 4096, encoding: "utf8", shell: false,
      env: { PATH: "", SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    if (result.error || result.status !== 0) return { code: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? "time_budget" : "probe_failed", checked: 0 };
    try {
      const value: unknown = JSON.parse(result.stdout);
      if (typeof value !== "object" || value === null || !("checked" in value) || !Number.isSafeInteger(value.checked) || Number(value.checked) < 0) throw new Error();
      return { code: "verified", checked: Number(value.checked) };
    } catch { return { code: "probe_failed", checked: 0 }; }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
/** Execute exactly the selected reviewed plan, stopping all further dispatch after any budget exhaustion. */
export async function executeDiagnosticPlan(pmRoot: string, input: DiagnosticPlan, selected: string, start = performance.now()): Promise<DiagnosticRun> {
  const plan = parseDiagnosticPlan(input);
  if (selected !== plan.id) throw new DiagnosticRefusal("selection_required", "Pass the exact reviewed plan id as the execution selection.");
  const scope = await trackerScope(pmRoot);
  if (scope.scope !== plan.scope) throw new DiagnosticRefusal("scope_mismatch", "Select the original tracker or generate and review a new plan for this scope.");
  const used: DiagnosticBudget = { processes: 0, network: 0, time_ms: 0 };
  const rows: DiagnosticReceipt[] = [];
  let stopped: DiagnosticCode | undefined;
  for (const step of plan.steps) {
    const remaining = plan.budget.time_ms - (performance.now() - start);
    if (!stopped) {
      if (remaining < 1) stopped = "time_budget";
      else if (used.processes + step.cost.processes > plan.budget.processes) stopped = "process_budget";
      else if (used.network + step.cost.network > plan.budget.network) stopped = "network_budget";
    }
    let result: { code: DiagnosticCode; checked: number };
    if (stopped) result = { code: stopped, checked: 0 };
    else {
      used.processes += step.cost.processes; used.network += step.cost.network;
      try { result = probe(step.command, scope.root, Math.floor(remaining)); }
      catch (error) { result = { code: error instanceof CaptureRefusal ? "output_limit" : "probe_failed", checked: 0 }; }
      if (result.code === "time_budget" || performance.now() - start >= plan.budget.time_ms) {
        stopped = "time_budget"; result = { code: stopped, checked: 0 };
      }
    }
    rows.push({ command: step.command, ...result, remedy: REMEDIES[result.code] });
  }
  used.time_ms = Math.ceil(performance.now() - start);
  return { version: 1, plan: plan.id, scope: plan.scope, ok: rows.every((row) => row.code === "verified"), used, rows };
}
/** Read a bounded review artifact, refusing paths and parser errors without echoing them. */
export async function readDiagnosticPlan(path: string): Promise<DiagnosticPlan> {
  try {
    return parseDiagnosticPlan(JSON.parse(readRegularText(path, 16384)));
  }
  catch { throw new DiagnosticRefusal("invalid_plan", "Supply a regular JSON plan file no larger than 16 KiB, generated by ops diagnose; pipes, sockets, devices and directories are unsupported."); }
}

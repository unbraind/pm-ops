/**
 * Proves the lifecycle-policy contract is non-vacuous: the engine really blocks,
 * the drift checker really detects drift, and the launcher wires both to the
 * process exit code.
 *
 * The pure `verify` rules are exercised against fixtures in
 * `lifecycle-policy.test.ts`. What these cases prove is that the real, pinned
 * `pm` binary enforces the canonical policy set on a throwaway workspace — a
 * violating item is refused with `workflow_policy_refused`, a compliant item
 * closes — and that `verify` detects a mutated installed policy. The workspace
 * is built self-contained under `os.tmpdir()` so the fixture asserts nothing
 * about any directory above it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_FLEET_LIFECYCLE_POLICY,
  CANONICAL_FLEET_POLICIES,
  verify,
  type WorkflowPolicy,
} from "../lifecycle-policy.ts";
import {
  defaultExec,
  parsePoliciesOutput,
  readInstalledPolicies,
  resolvePmBinary,
  runIfMain,
  verifyRepo,
  type PolicyExecutor,
} from "../scripts/verify-lifecycle-policy.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const PM_BIN = resolvePmBinary(repoRoot);

/** Run the pinned pm binary in a directory, returning status and stdout. */
function pm(
  cwd: string,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(PM_BIN, args as string[], {
    cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    // Suppress Node's own warning preamble (e.g. `(node:NNNN) ExperimentalWarning`
    // under the floor Node 22) so a refusal's `--json` error envelope on stderr
    // parses cleanly rather than colliding with a warning line.
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Run the pinned pm binary, throwing on a non-zero exit. */
function pmOk(cwd: string, args: readonly string[]): string {
  const result = pm(cwd, args);
  if (result.status !== 0) {
    throw new Error(`pm ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

/** JSON-decode the `--json` output of a pm command. */
function pmJson<T>(cwd: string, args: readonly string[]): T {
  return JSON.parse(pmOk(cwd, [...args, "--json"])) as T;
}

/** Install the canonical policy set into a workspace at refuse. */
function installCanonical(cwd: string): void {
  for (const policy of CANONICAL_FLEET_POLICIES) {
    pmOk(cwd, [
      "schema",
      "policy-put",
      policy.id,
      "--definition",
      JSON.stringify(policy),
      "--author",
      "pi-agent",
    ]);
  }
  pmOk(cwd, [
    "schema",
    "policy-mode",
    "refuse",
    "--message",
    "canonical fleet lifecycle-policy contract",
    "--author",
    "pi-agent",
  ]);
}

/** The id of the most recently created Feature whose title contains a marker. */
function featureId(cwd: string, marker: string): string {
  const list = pmJson<{ items: { id: string; type: string; title: string }[] }>(cwd, ["list"]);
  const found = list.items.find(
    (item) => item.type === "Feature" && item.title.includes(marker),
  );
  assert.ok(found, `a Feature titled with ${marker} was created`);
  return found.id;
}

test("resolvePmBinary points at the repo-pinned pm binary", () => {
  assert.ok(resolvePmBinary(repoRoot).endsWith(join("node_modules", ".bin", "pm")));
});

test("defaultExec runs a real local process and returns its stdout", () => {
  assert.equal(
    defaultExec(process.execPath, ["-e", "process.stdout.write('ok')"], { cwd: repoRoot }),
    "ok",
  );
});

test("parsePoliciesOutput narrows a valid envelope into a typed document", () => {
  const output = JSON.stringify({
    policy_result: true,
    action: "policies",
    changed: false,
    result: {
      version: 1,
      enforcement: "refuse",
      policies: [
        {
          id: "completeness-task",
          effect: "refuse",
          description: "x",
          subject: { types: ["Task"], statuses: ["closed"] },
          rule: { kind: "require_fields", fields: ["description"] },
        },
      ],
    },
  });
  const doc = parsePoliciesOutput(output);
  assert.equal(doc.enforcement, "refuse");
  assert.equal(doc.policies.length, 1);
  assert.equal(doc.policies[0]!.id, "completeness-task");
});

test("parsePoliciesOutput rejects a non-object output", () => {
  assert.throws(() => parsePoliciesOutput("null"), /policies output is not an object/);
  assert.throws(() => parsePoliciesOutput('"x"'), /policies output is not an object/);
});

test("parsePoliciesOutput rejects an envelope without policy_result", () => {
  assert.throws(
    () => parsePoliciesOutput(JSON.stringify({ action: "policies", result: { version: 1, enforcement: "refuse", policies: [] } })),
    /no policy_result/,
  );
});

test("parsePoliciesOutput rejects an envelope without a result document", () => {
  assert.throws(
    () => parsePoliciesOutput(JSON.stringify({ policy_result: true, action: "policies" })),
    /no result/,
  );
});

test("parsePoliciesOutput rejects a document with a bad version or enforcement", () => {
  assert.throws(
    () => parsePoliciesOutput(JSON.stringify({ policy_result: true, result: { enforcement: "refuse", policies: [] } })),
    /version is missing/,
  );
  assert.throws(
    () => parsePoliciesOutput(JSON.stringify({ policy_result: true, result: { version: 1, enforcement: "enforce", policies: [] } })),
    /enforcement is not advise\|refuse/,
  );
  assert.throws(
    () => parsePoliciesOutput(JSON.stringify({ policy_result: true, result: { version: 1, enforcement: "refuse", policies: {} } })),
    /policies is not an array/,
  );
});

test("parsePoliciesOutput rejects a malformed policy", () => {
  const result = { version: 1, enforcement: "refuse" };
  const envelope = (policies: unknown) =>
    JSON.stringify({ policy_result: true, action: "policies", changed: false, result: { ...result, policies } });
  assert.throws(() => parsePoliciesOutput(envelope([null])), /policy is not an object/);
  assert.throws(() => parsePoliciesOutput(envelope([{ effect: "refuse" }])), /policy id is missing/);
  assert.throws(() => parsePoliciesOutput(envelope([{ id: "x", effect: "enforce" }])), /effect is not advise\|warn\|refuse/);
  assert.throws(() => parsePoliciesOutput(envelope([{ id: "x", effect: "refuse" }])), /description is missing/);
  assert.throws(() => parsePoliciesOutput(envelope([{ id: "x", effect: "refuse", description: "d" }])), /subject is missing/);
  assert.throws(() => parsePoliciesOutput(envelope([{ id: "x", effect: "refuse", description: "d", subject: {} }])), /subject\.statuses is not a string array/);
  assert.throws(() => parsePoliciesOutput(envelope([{ id: "x", effect: "refuse", description: "d", subject: { types: "Task", statuses: ["closed"] } }])), /subject\.types is not a string array/);
  assert.throws(() => parsePoliciesOutput(envelope([{ id: "x", effect: "refuse", description: "d", subject: { statuses: ["closed"] } }])), /rule is missing/);
  assert.throws(() => parsePoliciesOutput(envelope([{ id: "x", effect: "refuse", description: "d", subject: { statuses: ["closed"] }, rule: { kind: "forbid" } }])), /rule\.kind is not require_fields/);
  assert.throws(() => parsePoliciesOutput(envelope([{ id: "x", effect: "refuse", description: "d", subject: { statuses: ["closed"] }, rule: { kind: "require_fields" } }])), /rule\.fields is not a string array/);
});

test("readInstalledPolicies reads the installed document via an injected executor", () => {
  const calls: string[] = [];
  const exec: PolicyExecutor = (_command, args) => {
    calls.push(args.join(" "));
    return JSON.stringify({
      policy_result: true,
      action: "policies",
      changed: false,
      result: { version: 1, enforcement: "refuse", policies: [] },
    });
  };
  const doc = readInstalledPolicies(repoRoot, exec);
  assert.equal(doc.enforcement, "refuse");
  assert.deepEqual(doc.policies, []);
  assert.ok(calls.some((c) => c.startsWith("schema policies --json")));
});

test("verifyRepo verifies through the injected executor and canonical", () => {
  const exec: PolicyExecutor = () =>
    JSON.stringify({
      policy_result: true,
      action: "policies",
      changed: false,
      result: {
        version: 1,
        enforcement: "advise",
        policies: [...CANONICAL_FLEET_POLICIES],
      },
    });
  const drift = verifyRepo(repoRoot, exec);
  assert.equal(drift.failures.length, 1);
  assert.match(drift.failures[0]!, /^enforcement is "advise"/);
});

test("runIfMain runs only as the entry point", () => {
  const scriptUrl = import.meta.resolve("../scripts/verify-lifecycle-policy.ts");
  const scriptPath = fileURLToPath(scriptUrl);
  // Not the entry point: returns false and runs nothing.
  const previous = process.exitCode;
  try {
    assert.equal(runIfMain(["node", process.execPath], scriptUrl, repoRoot), false);
    // The entry point with a passing repo: runs and returns true, no failing exit.
    const passing: PolicyExecutor = () =>
      JSON.stringify({
        policy_result: true,
        action: "policies",
        changed: false,
        result: {
          version: 1,
          enforcement: "refuse",
          policies: [...CANONICAL_FLEET_POLICIES],
        },
      });
    assert.equal(runIfMain(["node", scriptPath], scriptUrl, repoRoot, passing), true);
    assert.equal(process.exitCode, previous, "a matching repo must not set a failing exit code");
    // The entry point with a drifting repo: runs and sets exit 1.
    const drifting: PolicyExecutor = () =>
      JSON.stringify({
        policy_result: true,
        action: "policies",
        changed: false,
        result: { version: 1, enforcement: "advise", policies: [] },
      });
    assert.equal(runIfMain(["node", scriptPath], scriptUrl, repoRoot, drifting), true);
    assert.equal(process.exitCode, 1, "a drifting repo must set a failing exit code");
  } finally {
    process.exitCode = previous;
  }
});

test("non-vacuity: the pinned pm refuses a violating item and closes a compliant one", () => {
  const cwd = mkdtempSync(join(tmpdir(), "lifecycle-policy-nv-"));
  try {
    pmOk(cwd, ["init", "--yes"]);
    installCanonical(cwd);

    // Violating item: a Feature with no acceptance criteria, expected result, or
    // resolution. The close must be refused.
    pmOk(cwd, ["create", "Feature", "--title", "violating feature nv", "--author", "pi-agent"]);
    const violatingId = featureId(cwd, "violating feature nv");
    const refused = pm(cwd, [
      "close", violatingId, "--reason", "should refuse", "--author", "pi-agent", "--json",
    ]);
    assert.notEqual(refused.status, 0, "a violating close must not succeed");
    assert.equal(refused.status, 4, "a policy refusal exits 4");
    const refusedEnvelope = JSON.parse(refused.stderr) as { code?: string; exit_code?: number };
    assert.equal(refusedEnvelope.code, "workflow_policy_refused");
    assert.equal(refusedEnvelope.exit_code, 4);

    // Positive control: a Feature carrying every required field and a
    // resolution closes successfully.
    pmOk(cwd, ["create", "Feature", "--title", "compliant feature nv", "--author", "pi-agent"]);
    const compliantId = featureId(cwd, "compliant feature nv");
    pmOk(cwd, [
      "update", compliantId,
      "--acceptance-criteria", "ac",
      "--expected-result", "er",
      "--author", "pi-agent",
    ]);
    const closed = pm(cwd, [
      "close", compliantId,
      "--reason", "done",
      "--resolution", "resolved",
      "--author", "pi-agent",
    ]);
    assert.equal(closed.status, 0, "a compliant close must succeed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("non-vacuity: verify detects a mutated installed policy effect", () => {
  const cwd = mkdtempSync(join(tmpdir(), "lifecycle-policy-drift-"));
  try {
    pmOk(cwd, ["init", "--yes"]);
    installCanonical(cwd);

    // The installed document must match the canonical set.
    const installed = parsePoliciesOutput(pm(cwd, ["schema", "policies", "--json"]).stdout);
    assert.deepEqual(verify(installed).failures, []);

    // Mutate one installed policy's effect to advise, write it back, re-read,
    // and assert verify reports exactly that one drift.
    const policiesPath = resolve(cwd, ".agents", "pm", "schema", "policies.json");
    const raw = JSON.parse(readFileSync(policiesPath, "utf-8")) as {
      version: number;
      enforcement: string;
      policies: WorkflowPolicy[];
    };
    const mutated = {
      ...raw,
      policies: raw.policies.map((policy) =>
        policy.id === "completeness-feature"
          ? { ...policy, effect: "advise" }
          : policy,
      ),
    };
    writeFileSync(policiesPath, JSON.stringify(mutated, null, 2) + "\n");

    const drifted = parsePoliciesOutput(pm(cwd, ["schema", "policies", "--json"]).stdout);
    const drift = verify(drifted);
    assert.equal(drift.failures.length, 1, "exactly the mutated policy's effect drift");
    assert.match(
      drift.failures[0]!,
      /policy completeness-feature: effect is "advise", canonical requires "refuse"/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("non-vacuity: the repo's own installed policies match the canonical contract", () => {
  // pm-ops is the first repo that runs under the contract it publishes, so its
  // own installed document must report no drift.
  const drift = verifyRepo(repoRoot);
  assert.deepEqual(drift.failures, [], `pm-ops must satisfy its own contract: ${drift.failures.join("; ")}`);
});
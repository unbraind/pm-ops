/**
 * Executes the lifecycle-policy drift checker's rules against fixtures.
 *
 * The canonical set this repository installs satisfies its own contract, so
 * running `verify` against this repository would only prove today's tree is
 * fine. What these cases prove is that each drift category the checker reports
 * still fires on the defect it exists to catch: a missing policy, an extra
 * policy, a policy whose effect, rule, subject or description differs, and an
 * enforcement mode below the required `refuse` — while a document matching the
 * canonical set passes. The comparison is pure, so the rules are exercised here
 * against injected documents rather than only against this repository.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_FLEET_LIFECYCLE_POLICY,
  CANONICAL_FLEET_POLICIES,
  report,
  verify,
  type CanonicalLifecyclePolicy,
  type LifecyclePolicyDrift,
  type PolicyDocument,
  type WorkflowPolicy,
} from "../lifecycle-policy.ts";

/** The canonical policy set as a map keyed by id, for building fixtures. */
const CANONICAL_BY_ID = new Map(
  CANONICAL_FLEET_POLICIES.map((policy) => [policy.id, policy]),
);

/** A copy of the canonical document with zero policies, enforcement at refuse. */
function emptyRefuseDocument(): PolicyDocument {
  return { version: 1, enforcement: "refuse", policies: [] };
}

/** A document declaring exactly the canonical policies at refuse. */
function canonicalDocument(): PolicyDocument {
  return {
    version: 1,
    enforcement: CANONICAL_FLEET_LIFECYCLE_POLICY.enforcement,
    policies: [...CANONICAL_FLEET_POLICIES],
  };
}

/** Clone a policy and override selected fields. */
function withOverrides(
  id: string,
  overrides: Partial<WorkflowPolicy>,
): WorkflowPolicy {
  return { ...CANONICAL_BY_ID.get(id)!, ...overrides } as WorkflowPolicy;
}

test("the canonical set covers every fleet item type and the blanket resolution rule", () => {
  const ids = CANONICAL_FLEET_POLICIES.map((policy) => policy.id);
  assert.deepEqual(
    ids,
    [
      "completeness-issue",
      "completeness-feature",
      "completeness-task",
      "completeness-epic",
      "completeness-chore",
      "completeness-decision",
      "completeness-milestone",
      "fleet-closed-resolution",
    ],
  );
  for (const policy of CANONICAL_FLEET_POLICIES) {
    assert.equal(policy.effect, "refuse", `${policy.id} must enforce at refuse`);
    assert.ok(policy.description.length > 0, `${policy.id} must carry a description`);
    assert.equal(policy.rule.kind, "require_fields");
    assert.ok(policy.rule.fields.length > 0, `${policy.id} must require at least one field`);
    assert.deepEqual([...policy.subject.statuses], ["closed"], `${policy.id} must guard the closed status`);
  }
  assert.equal(CANONICAL_FLEET_LIFECYCLE_POLICY.enforcement, "refuse");
});

test("verify reports no drift on a document matching the canonical set", () => {
  const drift = verify(canonicalDocument());
  assert.deepEqual(drift.failures, []);
  assert.match(drift.notes[0]!, /ok - checked 8 canonical policies against 8 installed/);
});

test("verify reports every missing canonical policy", () => {
  const drift = verify(emptyRefuseDocument());
  assert.equal(drift.failures.length, CANONICAL_FLEET_POLICIES.length);
  for (const policy of CANONICAL_FLEET_POLICIES) {
    assert.ok(
      drift.failures.some((f) => f.startsWith(`missing policy ${policy.id}`)),
      `missing policy ${policy.id}`,
    );
  }
  assert.match(drift.notes[0]!, /against 0 installed/);
});

test("verify reports an extra policy the canonical set does not declare", () => {
  const doc = canonicalDocument();
  const extra: WorkflowPolicy = {
    id: "rogue-policy",
    effect: "advise",
    description: "not in the contract",
    subject: { types: ["Feature"], statuses: ["closed"] },
    rule: { kind: "require_fields", fields: ["x"] },
  };
  const drift = verify({ ...doc, policies: [...doc.policies, extra] });
  assert.equal(drift.failures.length, 1);
  assert.match(drift.failures[0]!, /extra policy rogue-policy/);
});

test("verify reports an enforcement mode below the required refuse", () => {
  const doc = canonicalDocument();
  const drift = verify({ ...doc, enforcement: "advise" });
  assert.equal(drift.failures.length, 1);
  assert.match(drift.failures[0]!, /^enforcement is "advise", canonical requires "refuse"/);
});

test("verify reports a policy whose effect differs", () => {
  const doc = canonicalDocument();
  const policies = doc.policies.map((policy) =>
    policy.id === "completeness-feature"
      ? withOverrides("completeness-feature", { effect: "advise" })
      : policy,
  );
  const drift = verify({ ...doc, policies });
  assert.equal(drift.failures.length, 1);
  assert.match(
    drift.failures[0]!,
    /policy completeness-feature: effect is "advise", canonical requires "refuse"/,
  );
});

test("verify reports a policy whose rule kind differs", () => {
  // The canonical rule kind is always `require_fields`. A drifted document
  // could carry an unknown kind the type system forbids, so the fixture is
  // built by widening the kind to a string and setting a value the checker
  // reads as differing. The rule is deep-copied so the canonical object is not
  // mutated through a shared reference.
  const doc = canonicalDocument();
  const canonicalTask = CANONICAL_BY_ID.get("completeness-task")!;
  const drifted: WorkflowPolicy = {
    ...canonicalTask,
    rule: { kind: "require_fields", fields: [...canonicalTask.rule.fields] },
  };
  (drifted.rule as { kind: string }).kind = "forbid_fields";
  const policies = doc.policies.map((p) => (p.id === "completeness-task" ? drifted : p));
  const drift = verify({ ...doc, policies });
  assert.equal(drift.failures.length, 1);
  assert.match(
    drift.failures[0]!,
    /policy completeness-task: rule kind is "forbid_fields", canonical requires "require_fields"/,
  );
});

test("verify reports a policy whose required fields differ", () => {
  const doc = canonicalDocument();
  const policies = doc.policies.map((policy) =>
    policy.id === "completeness-issue"
      ? withOverrides("completeness-issue", {
          rule: { kind: "require_fields", fields: ["repro_steps"] },
        })
      : policy,
  );
  const drift = verify({ ...doc, policies });
  assert.equal(drift.failures.length, 1);
  assert.match(
    drift.failures[0]!,
    /policy completeness-issue: rule fields are \[repro_steps\], canonical requires \[repro_steps,expected_result\]/,
  );
});

test("verify does not report a reordering of the required fields as drift", () => {
  const doc = canonicalDocument();
  const policies = doc.policies.map((policy) =>
    policy.id === "completeness-feature"
      ? withOverrides("completeness-feature", {
          rule: { kind: "require_fields", fields: ["expected_result", "acceptance_criteria"] },
        })
      : policy,
  );
  assert.deepEqual(verify({ ...doc, policies }).failures, []);
});

test("verify reports a policy whose subject types differ when installed drops them", () => {
  const doc = canonicalDocument();
  const drifted = withOverrides("completeness-epic", {
    subject: { statuses: ["closed"] },
  });
  const policies = doc.policies.map((p) => (p.id === "completeness-epic" ? drifted : p));
  const drift = verify({ ...doc, policies });
  assert.equal(drift.failures.length, 1);
  assert.match(
    drift.failures[0]!,
    /policy completeness-epic: subject types \[\*\], canonical requires \[Epic\]/,
  );
});

test("verify reports a policy whose subject types differ when installed adds them to a blanket rule", () => {
  const doc = canonicalDocument();
  const drifted = withOverrides("fleet-closed-resolution", {
    subject: { types: ["Feature"], statuses: ["closed"] },
  });
  const policies = doc.policies.map((p) => (p.id === "fleet-closed-resolution" ? drifted : p));
  const drift = verify({ ...doc, policies });
  assert.equal(drift.failures.length, 1);
  assert.match(
    drift.failures[0]!,
    /policy fleet-closed-resolution: subject types \[Feature\], canonical requires \[\*\]/,
  );
});

test("verify reports a policy whose subject statuses differ", () => {
  const doc = canonicalDocument();
  const drifted = withOverrides("completeness-chore", {
    subject: { types: ["Chore"], statuses: ["done"] },
  });
  const policies = doc.policies.map((p) => (p.id === "completeness-chore" ? drifted : p));
  const drift = verify({ ...doc, policies });
  assert.equal(drift.failures.length, 1);
  assert.match(
    drift.failures[0]!,
    /policy completeness-chore: subject statuses \[done\], canonical requires \[closed\]/,
  );
});

test("verify reports a policy whose description differs", () => {
  const doc = canonicalDocument();
  const drifted = withOverrides("completeness-decision", {
    description: "a stale reason",
  });
  const policies = doc.policies.map((p) => (p.id === "completeness-decision" ? drifted : p));
  const drift = verify({ ...doc, policies });
  assert.equal(drift.failures.length, 1);
  assert.match(
    drift.failures[0]!,
    /policy completeness-decision: description differs from the canonical text/,
  );
});

test("verify reports multiple drifts together, one per divergent policy", () => {
  const doc = canonicalDocument();
  const policies = doc.policies
    .filter((policy) => policy.id !== "completeness-milestone")
    .map((policy) =>
      policy.id === "completeness-feature"
        ? withOverrides("completeness-feature", { effect: "warn" })
        : policy,
    );
  const drift = verify({
    version: 1,
    enforcement: "advise",
    policies,
  });
  // enforcement + missing milestone + feature effect = 3 drifts.
  assert.equal(drift.failures.length, 3);
  assert.ok(drift.failures.some((f) => f.startsWith("enforcement is")));
  assert.ok(drift.failures.some((f) => f.startsWith("missing policy completeness-milestone")));
  assert.ok(drift.failures.some((f) => f.includes('effect is "warn"')));
});

test("verify accepts a caller-supplied canonical contract", () => {
  const custom: CanonicalLifecyclePolicy = {
    enforcement: "refuse",
    policies: [CANONICAL_BY_ID.get("completeness-task")!],
  };
  const installed: PolicyDocument = {
    version: 1,
    enforcement: "refuse",
    policies: [CANONICAL_BY_ID.get("completeness-task")!],
  };
  assert.deepEqual(verify(installed, custom).failures, []);
  const drifted: PolicyDocument = { ...installed, enforcement: "advise" };
  assert.equal(verify(drifted, custom).failures.length, 1);
});

test("report prints notes then failures and asks for a failing exit code on drift", () => {
  const lines: string[] = [];
  const codes: number[] = [];
  const drift: LifecyclePolicyDrift = {
    failures: ["enforcement is advise", "missing policy x"],
    notes: ["ok - checked 1"],
  };
  report(drift, (line) => lines.push(line), (code) => codes.push(code));
  assert.deepEqual(lines, [
    "ok - checked 1",
    "FAIL - enforcement is advise",
    "FAIL - missing policy x",
    "verify-lifecycle-policy: 2 drift(s).",
  ]);
  assert.deepEqual(codes, [1]);
});

test("report on a clean drift asks for no exit code and says so", () => {
  const lines: string[] = [];
  const codes: number[] = [];
  report(
    { failures: [], notes: ["ok - checked 8 canonical policies against 8 installed"] },
    (line) => lines.push(line),
    (code) => codes.push(code),
  );
  assert.deepEqual(lines, [
    "ok - checked 8 canonical policies against 8 installed",
    "verify-lifecycle-policy: the installed lifecycle policies match the canonical fleet contract.",
  ]);
  assert.deepEqual(codes, []);
});
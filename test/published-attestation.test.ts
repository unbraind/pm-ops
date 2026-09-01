/**
 * Regression tests for the published scanner and auditor contracts.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { auditPublishAttestation } from "../attestation.ts";
import { literalScalarAssignments, shellScalars, startsCaseArm } from "../shell-scan.ts";

test("the audit result makes a vacuous scan structurally distinct", () => {
  const empty = auditPublishAttestation([{ file: "release.yml", text: "npm ci\n" }]);
  assert.deepEqual(empty.recognition, { kind: "none" });
  assert.equal(empty.failures.length, 1);

  const clean = auditPublishAttestation([{
    file: "release.yml",
    text: "npm publish --provenance\n",
  }]);
  assert.deepEqual(clean.recognition, { kind: "recognized", count: 1 });
  assert.deepEqual(clean.failures, []);
});

test("literal assignment indexing is linear on adjacent assignment-like text", () => {
  const hostile = `A=${"!A=".repeat(40)}(`;
  const started = performance.now();
  assert.equal(shellScalars(hostile).size, 0);
  assert.ok(performance.now() - started < 100, "40 repetitions must complete under 100ms");
});

test("a binding from one conditional arm cannot attest a publish in its sibling arm", () => {
  const siblingIf = auditPublishAttestation([{
    file: "release.yml",
    text: [
      "if [ \"$X\" = \"1\" ]; then",
      "  FLAG=--provenance",
      "else",
      "  npm publish $FLAG",
      "fi",
    ].join("\n"),
  }]);
  assert.equal(siblingIf.failures.length, 1);
  assert.deepEqual(siblingIf.notes, []);

  const siblingElif = auditPublishAttestation([{
    file: "release.yml",
    text: "if false; then FLAG=--provenance; elif true; then npm publish $FLAG; fi",
  }]);
  assert.equal(siblingElif.failures.length, 1);

  const siblingCase = auditPublishAttestation([{
    file: "release.yml",
    text: "case $X in\n  one) FLAG=--provenance ;;\n  two) npm publish $FLAG ;;\nesac",
  }]);
  assert.equal(siblingCase.failures.length, 1);
});

test("a compound-line assignment exposes the unattested publish it routes", () => {
  const result = auditPublishAttestation([{
    file: "release.yml",
    text: [
      "npm publish --provenance",
      "if true; then NPM=npm; $NPM publish; fi",
    ].join("\n"),
  }]);
  assert.deepEqual(result.recognition, { kind: "recognized", count: 2 });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /npm publish/);
});

test("compound assignment indexing accepts only provably literal assignment commands", () => {
  for (const segment of ["then NPM=npm", "do NPM=npm", "else NPM=npm", "( NPM=npm", "{ NPM=npm", "label) NPM=npm"]) {
    assert.equal(literalScalarAssignments(segment).get("NPM"), "npm", segment);
  }
  assert.equal(literalScalarAssignments("then export NPM=npm").get("NPM"), "npm");
  for (const uncertain of [
    "then",
    "then echo",
    "then NPM=npm echo",
    'then "NPM=npm"',
    "then NPM=npm$SUFFIX",
    "then NPM=npm$(echo npm)",
    "then NPM=npm`echo npm`",
    "then NPM=npm#suffix",
  ]) {
    assert.equal(literalScalarAssignments(uncertain).size, 0, uncertain);
  }
  assert.equal(startsCaseArm("pattern)"), true);
  assert.equal(startsCaseArm("(nested)"), false);
  assert.equal(startsCaseArm("plain"), false);
});

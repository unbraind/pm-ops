/**
 * Regression tests for the published scanner and auditor contracts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { auditPublishAttestation } from "../attestation.ts";
import { bashArrays, expandArrays, expandScalars, literalScalarAssignments, shellScalars, startsCaseArm } from "../shell-scan.ts";

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
  // The structural assertion alone cannot see a complexity regression: a
  // quadratic implementation returns the same empty map. Scale the input until
  // the two are distinguishable and bound the elapsed time.
  //
  // Measured linear here at ~15 ms for this 60 KB input (5x the input costs
  // ~2.6x the time). A quadratic scan of the same input runs into seconds, so
  // the bound below has roughly two orders of magnitude of headroom over the
  // observed cost while still failing a genuine regression. It is deliberately
  // generous rather than tight: a bound a loaded CI runner can trip teaches
  // people to re-run the gate instead of reading it.
  const hostile = `A=${"!A=".repeat(20_000)}(`;
  const startedAt = process.hrtime.bigint();
  const indexed = shellScalars(hostile);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.equal(indexed.size, 0);
  assert.ok(
    elapsedMs < 2_000,
    `indexing ${hostile.length} characters took ${elapsedMs.toFixed(1)}ms, which indicates super-linear scanning`
  );
});

test("an unset inside a block invalidates an outer attestation binding", () => {
  const result = auditPublishAttestation([{
    file: "release.yml",
    text: [
      "FLAG=--provenance",
      "if [ -n \"$X\" ]; then",
      "  unset FLAG",
      "fi",
      "npm publish $FLAG",
    ].join("\n"),
  }]);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.recognition, { kind: "recognized", count: 1 });

  const siblingArm = auditPublishAttestation([{
    file: "release.yml",
    text: "FLAG=--provenance\nif test -n \"$X\"; then\nunset FLAG\nelse\n:\nfi\nnpm publish $FLAG",
  }]);
  assert.equal(siblingArm.failures.length, 1,
    "an unset in either possible arm leaves the post-block binding unprovable");
});

test("single-quoted and escaped references cannot borrow attestation evidence", () => {
  const scalars = new Map([["FLAG", "--provenance"]]);
  const arrays = bashArrays("FLAGS=(--provenance)");
  assert.equal(expandScalars("npm publish '$FLAG'", scalars), "npm publish '$FLAG'");
  assert.equal(expandScalars("npm publish \\$FLAG", scalars), "npm publish \\$FLAG");
  assert.equal(expandScalars("echo \\x; npm publish $FLAG", scalars), "echo \\x; npm publish --provenance",
    "an earlier escape does not suppress a later expandable reference");
  assert.equal(expandArrays("npm publish '${FLAGS[@]}'", arrays), "npm publish '${FLAGS[@]}'");

  for (const text of [
    "FLAG=--provenance\nnpm publish '$FLAG'",
    "FLAG=--provenance\nnpm publish \\$FLAG",
    "FLAGS=(--provenance)\nnpm publish '${FLAGS[@]}'",
  ]) {
    assert.equal(auditPublishAttestation([{ file: "release.yml", text }]).failures.length, 1, text);
  }
});

test("independent npm scripts cannot share attestation bindings", () => {
  const manifest = JSON.stringify({
    scripts: { setup: "FLAG=--provenance", release: "npm publish $FLAG" },
  });
  const result = auditPublishAttestation([{ file: "package.json", text: manifest }]);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.recognition, { kind: "recognized", count: 1 });
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

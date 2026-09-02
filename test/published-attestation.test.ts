/**
 * Regression tests for the published scanner and auditor contracts.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { auditPublishAttestation } from "../attestation.ts";
import { bashArrays, expandArrays, expandScalars, literalScalarAssignments, shellScalars, startsCaseArm, startsEnclosingCaseArm } from "../shell-scan.ts";

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

test("a publish written inside a non-run block scalar is a phantom, not coverage", () => {
  // GitHub Actions never executes the body of a block scalar under any key but
  // `run`. A publish written there is data, so counting it inflates the audit's
  // recognition count with an invocation that cannot run — and an attested
  // phantom is exactly what satisfies the non-vacuity guard while the real
  // publish is unattested. The workflow below runs `npm ci` and nothing else.
  const phantomOnly = auditPublishAttestation([{
    file: ".github/workflows/release.yml",
    text: [
      "jobs:", "  release:", "    steps:",
      "      - env:",
      "          NOTE: |",
      "            run: |",
      "              npm publish --access public --provenance",
      "        run: npm ci",
    ].join("\n"),
  }]);
  assert.deepEqual(phantomOnly.recognition, { kind: "none" }, "a phantom publish must not count as a recognised invocation");
  assert.equal(phantomOnly.failures.length, 1);

  // And the phantom must not pad the count beside a real invocation either.
  const phantomBesideReal = auditPublishAttestation([{
    file: ".github/workflows/release.yml",
    text: [
      "jobs:", "  release:", "    steps:",
      "      - env:",
      "          NOTE: |",
      "            run: |",
      "              npm publish --access public --provenance",
      "        run: |",
      "          npm publish --access public",
    ].join("\n"),
  }]);
  assert.deepEqual(phantomBesideReal.recognition, { kind: "recognized", count: 1 });
  assert.equal(phantomBesideReal.failures.length, 1);
});

test("a folded run block joins its lines before the flag is judged", () => {
  // Fail-closed guard. YAML folds a `>` block into one line before bash sees
  // it, so this publish does carry --provenance. Judging the lines separately
  // reads the flag as absent and refuses a release that is properly attested.
  const folded = auditPublishAttestation([{
    file: ".github/workflows/release.yml",
    text: [
      "jobs:", "  release:", "    steps:",
      "      - run: >",
      "          npm publish --access public",
      "          --provenance",
    ].join("\n"),
  }]);
  assert.deepEqual(folded.failures, [], "a folded attested publish must not be refused");
  assert.deepEqual(folded.recognition, { kind: "recognized", count: 1 });

  // Folding must not invent a flag that is not there.
  const foldedUnattested = auditPublishAttestation([{
    file: ".github/workflows/release.yml",
    text: [
      "jobs:", "  release:", "    steps:",
      "      - run: >",
      "          npm publish --access public",
      "          --tag next",
    ].join("\n"),
  }]);
  assert.equal(foldedUnattested.failures.length, 1);
});

test("an arm that opens a nested case is still a sibling of the arm before it", () => {
  // Fail-open guard. `b)` is mutually exclusive with `a)`, so the shell runs the
  // publish with FLAG unset. The arm reset used to be skipped for any segment
  // that opened a `case`, which let arm `a`'s binding stay visible inside the
  // nested block and attested a publish that would ship unattested.
  const nestedCase = auditPublishAttestation([{
    file: ".github/workflows/release.yml",
    text: [
      "jobs:",
      "  release:",
      "    steps:",
      "      - run: |",
      "          case \"$X\" in",
      "            a) FLAG=--provenance ;;",
      "            b) case \"$Y\" in",
      "                 c) npm publish --access public $FLAG ;;",
      "               esac",
      "               ;;",
      "          esac",
    ].join("\n"),
  }]);
  assert.equal(nestedCase.failures.length, 1, "a publish in a sibling arm must not borrow the earlier arm's flag");
  assert.deepEqual(nestedCase.notes, []);

  // The same shape reached through `else`, which is a sibling unconditionally.
  const elseOpensCase = auditPublishAttestation([{
    file: "release.yml",
    text: "if true; then FLAG=--provenance; else case $Y in c) npm publish $FLAG ;; esac; fi",
  }]);
  assert.equal(elseOpensCase.failures.length, 1);
});

test("a nested case does not discard a binding made in the arm that encloses it", () => {
  // Fail-closed guard, paired with the test above. Here the binding and the
  // publish are in the SAME arm, so the shell does pass the flag and the gate
  // must not refuse the release. Tightening the arm reset without this pair is
  // indistinguishable from over-correcting it: twice before, closing a
  // fail-open in this scope model opened a fail-closed one construction away.
  const sameArm = auditPublishAttestation([{
    file: ".github/workflows/release.yml",
    text: [
      "jobs:",
      "  release:",
      "    steps:",
      "      - run: |",
      "          case \"$X\" in",
      "            b) FLAG=--provenance",
      "               case \"$Y\" in",
      "                 c) npm publish --access public $FLAG ;;",
      "               esac",
      "               ;;",
      "          esac",
    ].join("\n"),
  }]);
  assert.deepEqual(sameArm.failures, []);
  assert.deepEqual(sameArm.recognition, { kind: "recognized", count: 1 });

  // And a flag bound before the block still survives it.
  const beforeBlock = auditPublishAttestation([{
    file: "release.yml",
    text: "FLAG=--provenance\ncase $X in a) : ;; esac\nnpm publish $FLAG",
  }]);
  assert.deepEqual(beforeBlock.failures, []);
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

test("a nested case opened inside the arm that binds the flag does not discard it", () => {
  // Fail-closed guard for the ONE-SEGMENT form, which the multi-line form does
  // not cover: here the arm label, the assignment, the nested opener and the
  // publish all share a line. The shell passes --provenance on this path, so
  // refusing it would block a legitimate release. This exact shape was opened
  // by the fix for the sibling-arm fail-open, which is why the pair matters.
  const oneSegment = auditPublishAttestation([{
    file: ".github/workflows/release.yml",
    text: [
      "jobs:", "  release:", "    steps:",
      "      - run: |",
      "          case \"$X\" in",
      "            b) FLAG=--provenance; case \"$Y\" in c) npm publish --access public $FLAG ;; esac ;;",
      "          esac",
    ].join("\n"),
  }]);
  assert.deepEqual(oneSegment.failures, [], "a binding made in the enclosing arm must survive a nested case");

  // Paired with the fail-open it must not reopen: a label that PRECEDES the
  // opener is a sibling of the previous arm and must still be reset.
  const siblingArm = auditPublishAttestation([{
    file: ".github/workflows/release.yml",
    text: [
      "jobs:", "  release:", "    steps:",
      "      - run: |",
      "          case \"$X\" in",
      "            a) FLAG=--provenance ;;",
      "            b) case \"$Y\" in c) npm publish --access public $FLAG ;; esac ;;",
      "          esac",
    ].join("\n"),
  }]);
  assert.equal(siblingArm.failures.length, 1);
});

test("a quoted YAML key neither hides a block nor promotes data to a run block", () => {
  // Fail-open guard: a quoted key on a non-run block used to leave the block
  // unconsumed, so an inner `run: |` was read as executable and its phantom
  // publish satisfied the non-vacuity check.
  for (const key of ['"NOTE"', "'NOTE'"]) {
    const phantom = auditPublishAttestation([{
      file: ".github/workflows/release.yml",
      text: [
        "jobs:", "  release:", "    steps:",
        "      - env:",
        `          ${key}: |`,
        "            run: |",
        "              npm publish --access public --provenance",
        "        run: npm ci",
      ].join("\n"),
    }]);
    assert.deepEqual(phantom.recognition, { kind: "none" }, `${key} must not admit a phantom publish`);
    assert.equal(phantom.failures.length, 1);
  }

  // Paired guard in the opposite direction: a quoted `run` key IS executable,
  // and treating it as data would hide a real unattested publish. Recognising
  // quoted keys only in the generic matcher would have caused exactly that.
  const quotedRun = auditPublishAttestation([{
    file: ".github/workflows/release.yml",
    text: ["jobs:", "  release:", "    steps:", "      - \"run\": |", "          npm publish --access public"].join("\n"),
  }]);
  assert.deepEqual(quotedRun.recognition, { kind: "recognized", count: 1 });
  assert.equal(quotedRun.failures.length, 1);
});

test("an arm label is attributed to the case that is already open, by position", () => {
  // The label precedes the opener, so it belongs to the enclosing `case`.
  assert.equal(startsEnclosingCaseArm('b) case "$Y" in'), true);
  // No opener at all: an ordinary arm of whatever case is already open.
  assert.equal(startsEnclosingCaseArm("b) npm publish $FLAG ;;"), true);
  // The opener precedes the label, so the label is the first arm of the block
  // this segment opens - it has no earlier sibling to be cleared of.
  assert.equal(startsEnclosingCaseArm('case "$Y" in c) npm publish $FLAG ;;'), false);
  // A balanced group is not an arm label: `(` opens and `)` closes it, so the
  // scan must consume both rather than stop at the first `)` it sees.
  assert.equal(startsEnclosingCaseArm("(nested) then"), false);
  assert.equal(startsEnclosingCaseArm("(a (b) c) label)"), true);
  assert.equal(startsEnclosingCaseArm("plain"), false);
});

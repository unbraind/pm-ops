/** Monotonic evidence: unknown refinements cannot erase proofs or become contradictions. */
import test from "node:test";
import assert from "node:assert/strict";
import { decode, encode } from "@toon-format/toon";
import { Range, satisfies } from "semver";
import { explainCompatibility } from "../compatibility-reasons.ts";
import { MAX_PRERELEASE_RANGE, rangePacket } from "./compatibility-range-corpus.ts";

/** Exhaustive exact oracle for this grammar: finite stable pins plus constraints admitting every pin. */
function exactMinimum(masks: readonly number[]): number {
  let minimum = masks.length;
  for (let selected = 1; selected < 2 ** masks.length; selected++) {
    const included = masks.filter((_, index) => (selected & (1 << index)) !== 0);
    if (included.reduce((bits, mask) => bits & mask, 7) === 0) minimum = Math.min(minimum, included.length);
  }
  return minimum;
}

test("500 seeded exact-domain sequences retain contradictions through unknown refinements, permutations and replays", () => {
  const versions = ["1.0.0", "2.0.0", "3.0.0"];
  // This certificate makes the bit-set oracle exact even for noise-only subsets.
  assert.ok(versions.every((version) => satisfies(version, MAX_PRERELEASE_RANGE)));
  let state = 0xbb67ae85;
  const random = (): number => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state; };
  for (let sequence = 0; sequence < 500; sequence++) {
    const count = 2 + random() % 3;
    let pins: number[];
    do { pins = Array.from({ length: count }, () => 1 + random() % 7); }
    while (pins.reduce((bits, mask) => bits & mask, 7) !== 0);
    const declarations = pins.map((bits) => ({ bits, range: versions.filter((_, index) => bits & (1 << index)).join(" || ") }));
    const baseline = rangePacket(declarations.map((entry) => entry.range), null);
    const prior = explainCompatibility(baseline);
    assert.equal(prior.rows[0]!.status, "incompatible");
    assert.equal(prior.rows[0]!.conflicts[0]!.requirements.length, exactMinimum(pins));
    const noise = 1 + random() % 2;
    for (let added = 0; added < noise; added++) declarations.splice(random() % (declarations.length + 1), 0, { bits: 7, range: MAX_PRERELEASE_RANGE });
    const input = rangePacket(declarations.map((entry) => entry.range), null);
    input.requirements.reverse();
    const packet = JSON.parse(" \r\n" + JSON.stringify(input, null, 2).replaceAll("\n", "\r\n") + "\r\n") as unknown;
    const report = explainCompatibility(packet);
    const row = report.rows[0]!;
    const witness = row.conflicts.find((entry) => entry.code === "joint_range_conflict")!;
    assert.equal(row.status, "incompatible", `sequence ${sequence}`);
    assert.deepEqual(row.compatible_ranges, []);
    assert.ok(witness);
    const positions = new Map(declarations.map((entry, index) => [`range-${index}`, entry.bits]));
    assert.ok(witness.requirements.every((id) => positions.has(id)));
    assert.equal(new Set(witness.requirements).size, witness.requirements.length);
    const retained = witness.requirements.map((id) => positions.get(id)!);
    assert.equal(retained.reduce((bits, mask) => bits & mask, 7), 0, "the emitted witness itself proves the contradiction");
    assert.equal(retained.length, exactMinimum(declarations.map((entry) => entry.bits)));
    assert.equal(witness.minimum_unproven, true, "unknown smaller subsets cannot certify global cardinality");
    assert.ok(row.unknown.some((reason) => reason.code === "unrepresentable_range" && reason.range === MAX_PRERELEASE_RANGE));
    assert.ok(row.unknown.filter((reason) => reason.code === "unrepresentable_range").length <= input.requirements.length);
    assert.deepEqual(decode(encode(report)), report);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
    assert.deepEqual(explainCompatibility(baseline), prior, "replaying older input retains its independent proof");
  }
});

test("refinement failures preserve exact empty singletons, positive OR branches and independent conflict dimensions", () => {
  const singleton = explainCompatibility(rangePacket([MAX_PRERELEASE_RANGE, "<0.0.0-0"], null)).rows[0]!;
  assert.equal(singleton.status, "incompatible");
  assert.deepEqual(singleton.compatible_ranges, []);
  assert.deepEqual(singleton.conflicts[0]!.requirements, ["range-1"]);
  assert.equal(singleton.conflicts[0]!.minimum_unproven, undefined, "unknown equal-sized alternatives do not prevent a minimum of one");
  const overflow = ">9007199254740991.9007199254740991.9007199254740991";
  const positive = explainCompatibility(rangePacket([overflow + " || >0.0.0 <0.0.2"], null)).rows[0]!;
  assert.ok(positive.compatible_ranges!.length > 0);
  assert.ok(positive.compatible_ranges!.some((conjunction) => conjunction.every((range) => satisfies("0.0.1", range))));
  assert.equal(positive.conflicts.length, 0);
  assert.ok(positive.unknown.some((reason) => reason.code === "unrepresentable_range"));
  const undecided = explainCompatibility(rangePacket([overflow + " || <0.0.0-0"], null)).rows[0]!;
  assert.equal(undecided.status, "unknown"); assert.equal(undecided.compatible_ranges, null);
  assert.equal(undecided.conflicts.length, 0, "one empty OR branch cannot prove the unknown branch empty");
  const capability = rangePacket([MAX_PRERELEASE_RANGE, "<1.0.0-z"], null);
  capability.requirements[0]!.capabilities = ["missing"];
  const row = explainCompatibility(capability).rows[0]!;
  assert.equal(row.status, "incompatible");
  assert.equal(row.conflicts[0]!.code, "capability_conflict");
  assert.ok(row.unknown.some((reason) => reason.code === "unrepresentable_range"));
});

test("a library rejection before branch evaluation preserves previously established capability evidence", (t) => {
  const input = rangePacket(["*"], null);
  input.requirements[0]!.capabilities = ["missing"];
  // Fault the library boundary, never the SDK or the package's evaluator.
  t.mock.method(Range.prototype, "test", () => { throw new RangeError("synthetic library rejection"); });
  try {
    const row = explainCompatibility(input).rows[0]!;
    assert.equal(row.status, "incompatible");
    assert.equal(row.conflicts[0]!.code, "capability_conflict");
    assert.equal(row.compatible_ranges, null);
    assert.ok(row.unknown.some((reason) => reason.code === "unrepresentable_range" && reason.range === "*"));
  } finally { t.mock.restoreAll(); }
});

/** Library decisions must agree with a brute-force version corpus, including maximum-length prereleases. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decode, encode } from "@toon-format/toon";
import { inc, minVersion, satisfies, valid } from "semver";
import { explainCompatibility } from "../compatibility-reasons.ts";
import { adversarialRangePackets, assertRangePackets, MAX_PRERELEASE_RANGE, rangePacket } from "./compatibility-range-corpus.ts";

test("semver library outcomes preserve max-length witnesses and name unrepresentable ranges", () => {
  const packets = adversarialRangePackets();
  assert.equal(MAX_PRERELEASE_RANGE.length, 256);
  assert.ok(valid(MAX_PRERELEASE_RANGE.slice(1)));
  assert.equal(valid(minVersion(MAX_PRERELEASE_RANGE)!.version), null, "the library itself can derive a rejected token");
  assertRangePackets(packets.map(explainCompatibility));
  for (const packet of packets) {
    const report = explainCompatibility(packet);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
    assert.deepEqual(decode(encode(report)), report);
    for (const reason of report.rows[0]!.unknown) if (reason.code === "unrepresentable_range") {
      assert.ok(reason.range.includes(packet.requirements[0]!.range!));
    }
  }
  const missing = explainCompatibility(rangePacket(["   "], null));
  assert.equal(missing.rows[0]!.unknown[0]!.code, "range_unknown");
  const unchanged = explainCompatibility(rangePacket([">=2026.10.20"], "2026.10.20"));
  assert.equal(unchanged.ok, true, "previously released metadata remains allowed");
});

test("500 seeded random range pairs equal brute-force corpus verdicts, including max-length prerelease tags", () => {
  const versions = new Set(["0.0.0-0", "0.0.0", "1.0.0-0", "1.0.0-a", "1.0.0-a.0", "1.0.0-a.1", "1.0.0-b", "1.0.0-b.0", "1.0.0-z", "1.0.0", "1.0.1-0", "1.0.1-a", "1.0.1-alpha", "1.0.1-beta.1", "1.0.1-z", "1.0.1", "2.0.0", "3.0.0",
    "1.0.0-" + "a".repeat(249), "1.0.0-" + "b".repeat(249), "1.0.0-" + "z".repeat(249)]);
  const endpoints = [...versions];
  for (const version of endpoints) {
    for (const expression of [">" + version, ">" + version + " <" + inc(version, "patch")]) {
      const successor = minVersion(expression);
      if (successor !== null && valid(successor.version) !== null) versions.add(successor.version);
    }
  }
  const corpus = [...versions];
  let seed = 0x6a09e667;
  const next = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const operators = ["", ">", ">=", "<", "<="];
  for (let sequence = 0; sequence < 500; sequence++) {
    const inferred = sequence % 7 === 1;
    const lower = ["1.0.1-a", "1.0.1-alpha", "1.0.1-beta.1", "1.0.1-z"][next() % 4]!;
    const ranges = sequence === 0 ? [MAX_PRERELEASE_RANGE, "<1.0.0-z"] : inferred ? [">1.0.0 >" + lower, ">=1.0.1-0 <1.0.1"] : Array.from({ length: 2 }, () => {
      const version = endpoints[next() % endpoints.length]!;
      const operator = operators[next() % operators.length]!;
      return operator + version;
    });
    if (ranges.some((range) => range.length > 256)) { sequence--; continue; }
    const witness = corpus.find((version) => ranges.every((range) => satisfies(version, range)));
    // Known observations prove positives independently; they must never be lost to a rejected synthesized successor.
    const report = explainCompatibility(rangePacket(ranges, inferred ? null : witness ?? "3.0.0"));
    assert.equal(Boolean(report.rows[0]!.compatible_ranges?.length), witness !== undefined, JSON.stringify(ranges));
    assert.equal(report.rows[0]!.status, witness === undefined ? "incompatible" : inferred ? "unknown" : "compatible", JSON.stringify(ranges));
    assert.deepEqual(decode(encode(report)), report);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  }
});

test("library-only inference preserves prerelease admission when no installed pin supplies a witness", () => {
  for (const ranges of [[">1.0.0 >1.0.1-alpha", ">=1.0.1-0 <1.0.1"], ["*", ">=1.0.0-alpha <2.0.0"], [">1.0.0 <1.0.1-beta"], [">1.0.0-alpha.1 <1.0.0-alpha.1.1"]]) {
    const row = explainCompatibility(rangePacket(ranges, null)).rows[0]!;
    assert.ok(row.compatible_ranges!.length > 0); assert.equal(row.conflicts.length, 0);
  }
  for (const ranges of [["*", ">=1.0.0-alpha <1.0.0"], [">1.0.0 <1.0.1"], ["<0.0.0-0"]]) {
    const row = explainCompatibility(rangePacket(ranges, null)).rows[0]!;
    assert.deepEqual(row.compatible_ranges, []); assert.equal(row.conflicts[0]!.code, "joint_range_conflict");
  }
});

test("joint range decisions contain no handwritten version successor construction", () => {
  const source = readFileSync(new URL("../compatibility-reasons.ts", import.meta.url), "utf8");
  for (const prohibited of [/\.prerelease\.(?:push|splice)\s*\(/, /\.(?:major|minor|patch)\s*(?:\+\+|\+=|=)/, /parts\.join\(["']\.["']\)/, /version\.version\}\.0/]) {
    assert.doesNotMatch(source, prohibited);
  }
  assert.match(source, /minVersion\(/); assert.match(source, /intersects\(/);
});

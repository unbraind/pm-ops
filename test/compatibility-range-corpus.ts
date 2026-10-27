/** Shared adversarial packets keep SDK, CLI and installed consumer checks on the same input contract. */
import assert from "node:assert/strict";
import type { CompatibilityInput, CompatibilityReport } from "../compatibility-reasons.ts";

/** The release token is valid at 255 characters; its naive .0 successor is not. */
export const MAX_PRERELEASE_RANGE = ">1.0.0-" + "a".repeat(249);

/** Build a bounded declaration packet without relying on a tracker or ambient defaults. */
export function rangePacket(ranges: readonly string[], version: string | null): CompatibilityInput {
  return { version: 1, components: [
    { id: "issuer", version: "1.0.0", capabilities: [] },
    { id: "target", version, capabilities: [] },
  ], requirements: ranges.map((range, index) => ({ id: `range-${index}`, from: "issuer", to: "target", range, capabilities: [] })) };
}

/** Positive witnesses and conservative library refusals must survive every transport/install topology. */
export function adversarialRangePackets(): CompatibilityInput[] {
  return [rangePacket([MAX_PRERELEASE_RANGE, "<1.0.0-z"], "1.0.0-b"),
    rangePacket([MAX_PRERELEASE_RANGE, "<1.0.0-z"], null),
    rangePacket([">=1.0.0-01"], "1.0.0-b"),
    rangePacket([">9007199254740991.9007199254740991.9007199254740991"], null),
    rangePacket([">1.0.0 >1.0.1-alpha", ">=1.0.1-0 <1.0.1"], null)];
}

/** Independently assert the protocol outcomes; never calculate expected values with the producer. */
export function assertRangePackets(reports: CompatibilityReport[]): void {
  assert.equal(reports.length, 5);
  assert.equal(reports[0]!.ok, true);
  assert.equal(reports[0]!.rows[0]!.status, "compatible");
  assert.ok(reports[0]!.rows[0]!.compatible_ranges!.length > 0);
  for (const report of reports.slice(1, 4)) {
    assert.equal(report.rows[0]!.status, "unknown");
    assert.equal(report.rows[0]!.compatible_ranges, null);
    assert.equal(report.rows[0]!.conflicts.length, 0);
    const reasons = report.rows[0]!.unknown.filter((reason) => reason.code === "unrepresentable_range");
    assert.ok(reasons.length > 0);
    for (const reason of reasons) {
      assert.ok(reason.range.length > 0); assert.match(reason.remedy, /representable range/);
    }
  }  assert.equal(reports[4]!.rows[0]!.status, "unknown");
  assert.ok(reports[4]!.rows[0]!.compatible_ranges!.length > 0);
  assert.equal(reports[4]!.rows[0]!.conflicts.length, 0);
  assert.ok(reports[4]!.rows[0]!.unknown.every((reason) => reason.code === "version_unknown"));

}

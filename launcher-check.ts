/**
 * Recognize canonical copied launchers without coupling consumers to package updates.
 * Historical hashes are append-only: accepting a copy does not upgrade its behavior.
 * @packageDocumentation
 */
import { readRegularInput } from "./regular-input.ts";
import { createHash } from "node:crypto";

/** SHA-256 of the frozen v1 template; changing it requires a versioned decision. */
export const FROZEN_LAUNCHER_SHA256 = "b7f41184dc4c401be8ca80a1c2817e23df5f35df825a141d305bc64e2d3c595a";

/** Released template revisions, verified from release tags and template history. */
const canonicalHashes: ReadonlySet<string> = new Set([
  FROZEN_LAUNCHER_SHA256,
  "7e2b16378a5c05f83ad56bea577c78e2d09eaeca00f688579801552ae1d1b98a", // v2026.09.23, 963a6c4
  "e248546626d7f3753a0c032795f05e36083b8dc130ac7e41f69f0d0faff0836f", // v2026.09.26, f87c17c
  "56b9a31db495ab91cc8b77d05c102f832ccc9dd327232846d569805db6ace6b7", // v2026.09.28, 5278964
  "2cc2d52bf51cd594f944f16bc5fde7d028276cfe59b89abd8c288e5208de88bc", // v2026.10.04, b97fd99
  "e5673aef66825b37dc8cda95d6d8320960c118db914aba509001c0b16e9c7d8a", // v2026.10.12, 3fca1f2
]);

/**
 * Assert that a consumer file is the frozen launcher or a previously released copy.
 * Throws for changed content and propagates read errors. Copy the frozen template
 * once for current behavior; future pm-ops bumps need no consumer launcher edits.
 * @param filePath - Path to the consumer's copied prepare launcher.
 */
export function assertCanonicalLauncher(filePath: string): void {
  const digest = createHash("sha256").update(readRegularInput(filePath)).digest("hex");
  if (!canonicalHashes.has(digest)) {
    throw new Error("Unrecognized pm-ops prepare launcher (SHA-256 " + digest +
      "). Copy pm-ops/templates/prepare-merge-driver.ts unchanged.");
  }
}

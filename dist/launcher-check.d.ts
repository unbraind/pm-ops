/** SHA-256 of the frozen v1 template; changing it requires a versioned decision. */
export declare const FROZEN_LAUNCHER_SHA256 = "b7f41184dc4c401be8ca80a1c2817e23df5f35df825a141d305bc64e2d3c595a";
/**
 * Assert that a consumer file is the frozen launcher or a previously released copy.
 * Throws for changed content and propagates read errors. Copy the frozen template
 * once for current behavior; future pm-ops bumps need no consumer launcher edits.
 * @param filePath - Path to the consumer's copied prepare launcher.
 */
export declare function assertCanonicalLauncher(filePath: string): void;
//# sourceMappingURL=launcher-check.d.ts.map
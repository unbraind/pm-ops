/**
 * Canonical strict flat configuration for every fleet TypeScript repository.
 *
 * Babel supplies the ESLint parser because typescript-eslint rejects the
 * TypeScript 7 compiler peer range used by part of the fleet. TypeScript stays
 * the authoritative compiler; Babel only supplies ESLint's ESTree syntax tree.
 */
import type { Linter } from "eslint";
/** Inputs for constructing a reusable flat policy in a consumer package. */
export interface FleetEslintConfigOptions {
    /** Additional repository-relative ignore globs appended to the fleet defaults. */
    readonly ignores?: readonly string[];
}
/**
 * Build the fleet's strict, TypeScript-aware ESLint flat configuration.
 *
 * The returned array is intentionally a fresh flat-config value, so a
 * consumer can append its own project-specific config without mutating the
 * canonical policy or another ESLint invocation.
 *
 * @param options - Optional additional ignore globs for generated files.
 * @returns ESLint flat-config entries ready for `ESLint` or `eslint`.
 */
export declare function fleetEslintConfig(options?: FleetEslintConfigOptions): Linter.Config[];
//# sourceMappingURL=eslint.d.ts.map
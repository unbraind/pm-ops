/**
 * Assurance measurement provider that turns the fleet's pinned code-quality
 * thresholds into audited bounds.
 *
 * Every fleet package historically hand-rolled a `scripts/coverage-gate.ts`
 * with thresholds pinned under `coverageGate` in `package.json`. Lowering one
 * was an ordinary diff: nothing in the workflow recorded *why* a number moved,
 * and nothing proved the bound still meant anything. Under pm-cli's assurance
 * surface, weakening a bound requires an `authorization_decision` naming a
 * terminal Decision item the host verifies, and every non-dry gate verdict is
 * appended to the immutable workspace history stream. That only bites if the
 * quality numbers can be *measured* by an assurance provider, which is what
 * this module exports.
 *
 * The provider reads a local lcov coverage report and the canonical docstring
 * analyzer and reduces them to four measurement keys. It owns no quality
 * thresholds itself — those live in assertions and gates the consuming
 * workspace declares — but it refuses to be satisfied by a *stale* coverage
 * report, because a gate that runs against yesterday's `lcov.info` after today's
 * source edit is a gate that measures nothing.
 *
 * @see {@link https://github.com/unbraind/pm-cli/blob/main/docs/ASSURANCE.md ASSURANCE.md}
 * for the measurement / assertion / gate vocabulary this provider plugs into.
 */
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
/**
 * Exact contract the host's `api.registerAssuranceMeasurementProvider`
 * expects for one provider registration.
 *
 * `@unbrained/pm-cli` keeps this type on its internal
 * `core/extensions/extension-types` module and does not yet re-export it
 * through any public `sdk/*` barrel (the SDK only exposes it as the parameter
 * of the registration method). Deriving it from that public method gives the
 * identical, exact shape without reaching into `dist/` internals or
 * hand-copying field names — if the SDK ever widens the method signature, this
 * alias widens with it.
 */
export type AssuranceMeasurementProviderDefinition = Parameters<ExtensionApi["registerAssuranceMeasurementProvider"]>[0];
/** Stable provider id used by measurement declarations and gate allow-lists. */
export declare const QUALITY_PROVIDER_ID = "pm-ops-quality";
/**
 * The pm-ops quality assurance measurement provider.
 *
 * Registered through the `services` capability, it exposes four keys over a
 * local lcov report and the canonical docstring analyzer. It declares no
 * network use and a `medium` cost class so a trigger policy that caps work at
 * `low` can decline it before invocation. Key ids use the hyphen form the pm-cli
 * host requires for every stable lowercase id (`^[a-z0-9][a-z0-9-]*$`); the
 * hyphen and underscore spellings name the same measurements.
 */
export declare const qualityMeasurementProvider: AssuranceMeasurementProviderDefinition;
//# sourceMappingURL=assurance.d.ts.map
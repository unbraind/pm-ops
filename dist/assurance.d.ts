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
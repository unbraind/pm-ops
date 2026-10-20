/** Resolve canonical release tags, or only one exact tag, including annotated tag peeling. */
export declare function fetchCanonicalReleaseTags(run?: (args: string[]) => string, tag?: string): Record<string, string>;
/** Explicit provenance outcome; unavailable fresh evidence never counts as approval. */
export interface ReleaseCallerResult {
    /** Whether canonical provenance was verified, refused, or deferred offline. */
    status: "verified" | "refused" | "unverified-offline";
    /** Structural or provenance diagnostics, including an explicit offline deferral. */
    errors: string[];
}
/** Whether PM_OPS_OFFLINE disables every networked canonical tag lookup.
 *
 * Every path that resolves canonical release tags offline shares this check, so the
 * documented offline mode behaves identically in policy runs, attestation audits and the CLI.
 */
export declare function isPmOpsOffline(): boolean;
/** Default resolver: never contacts the canonical API while PM_OPS_OFFLINE is set. */
export declare function defaultCanonicalTagResolver(tag?: string): Readonly<Record<string, string>>;
/** Verify a SHA-pinned caller with no embedded jobs, private steps, or inherited secrets. */
export declare function inspectReleaseCaller(source: string, resolveTags?: ((tag: string) => Readonly<Record<string, string>>)): ReleaseCallerResult;
/** Compatibility diagnostics; use inspectReleaseCaller to distinguish offline deferral from refusal. */
export declare function checkReleaseCaller(source: string, releaseTags?: Readonly<Record<string, string>>): string[];
//# sourceMappingURL=release-caller.d.ts.map
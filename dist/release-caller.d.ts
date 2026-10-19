/** Resolve only release tags owned by the canonical repository, including annotated tags. */
export declare function fetchCanonicalReleaseTags(run?: (args: string[]) => string): Record<string, string>;
/** Explicit provenance outcome; unavailable fresh evidence never counts as approval. */
export interface ReleaseCallerResult {
    /** Whether canonical provenance was verified, refused, or deferred offline. */
    status: "verified" | "refused" | "unverified-offline";
    /** Structural or provenance diagnostics, including an explicit offline deferral. */
    errors: string[];
}
/** Verify a SHA-pinned caller with no embedded jobs, private steps, or inherited secrets. */
export declare function inspectReleaseCaller(source: string, resolveTags?: (() => Readonly<Record<string, string>>)): ReleaseCallerResult;
/** Compatibility diagnostics; use inspectReleaseCaller to distinguish offline deferral from refusal. */
export declare function checkReleaseCaller(source: string, releaseTags?: Readonly<Record<string, string>>): string[];
//# sourceMappingURL=release-caller.d.ts.map
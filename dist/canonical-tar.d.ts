/** Unsafe or ambiguous archive contents cannot authorize release repair. */
export declare class TarballRefusal extends Error {
    /** Stable machine-readable refusal classification. */
    readonly code = "invalid_tarball";
    /** Archive refusal is an input error. */
    readonly exitCode = 2;
    /** Sanitized cause, independent of member names. */
    readonly reason: "entry_type" | "path" | "collision" | "format";
    /** Construct a sanitized diagnostic without registry-controlled names. */
    constructor(reason: "entry_type" | "path" | "collision" | "format");
}
/**
 * Read an uncompressed archive in fixed chunks, never extracting a member.
 * PAX is transport metadata for the following entry, not a filesystem entry.
 * All other extension kinds fail closed. See docs/tarball-manifests.md.
 */
export declare function canonicalTarManifest(path: string): string;
//# sourceMappingURL=canonical-tar.d.ts.map
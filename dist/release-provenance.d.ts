/** Identity required for the already-verified candidate's published artifact. */
export interface ProvenanceIdentity {
    repository: string;
    workflow: string;
    ref: string;
    commit: string;
    integrity: string;
    /** Authenticated executing reusable workflow; omitted for a legacy direct caller. */
    signerWorkflow?: string;
}
/** Match digest and commit claims; callers must authenticate the bundle separately. */
export declare function verifyPublishedProvenance(bundle: unknown, commit: string, integrity: string): boolean;
/** Bind authenticated certificate source claims independently of attacker-controlled signed JSON. */
export declare function verifyCertificateSource(certificate: {
    oids?: {
        oid: {
            id: number[];
        } | undefined;
        value: Buffer;
    }[];
} | undefined, expected: ProvenanceIdentity): void;
/** Resolve only a local private or development Sigstore installation, with a clear missing-runtime diagnostic. */
export declare function sigstoreRuntimePath(root?: string): string;
/** Verify Fulcio identity, signature, transparency evidence and authenticated signing time. */
export declare function verifySigstoreBundle(bundle: unknown, identity: ProvenanceIdentity): Promise<void>;
/** Accept only cryptographically verified SLSA from the exact repository, workflow and ref. */
export declare function verifyRegistryProvenance(bundle: unknown, identity: ProvenanceIdentity, verify?: typeof verifySigstoreBundle): Promise<boolean>;
//# sourceMappingURL=release-provenance.d.ts.map
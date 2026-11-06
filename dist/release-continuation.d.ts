/** Immutable candidate prepared by a trusted default-branch workflow. */
export interface ReleaseCandidate {
    schema: 1;
    repository: string;
    defaultBranch: string;
    baseSha: string;
    headSha: string;
    tree: string;
    version: string;
    tag: string;
    packageName: string;
    packageSha256: string;
    packageIntegrity: string;
    notesSha256: string;
    cliVersion: string;
    opsVersion: string;
    /** Exact trusted tool commit; absent only on legacy receipts. */
    toolsSha?: string;
    runId: number;
    runAttempt: number;
    workflow: string;
    configDigest: string;
    npmPublish: boolean;
}
/** Authoritative current PR identity; a list/search result alone never authorizes mutation. */
export interface ContinuationPr {
    number: number;
    author: string;
    repository: string;
    headRepository: string;
    base: string;
    branch: string;
    head: string;
    state: string;
    merged: boolean;
    mergedSha: string | null;
}
/** Live proof gathered again at the publication boundary, never from an event payload. */
export interface ContinuationEvidence {
    repository: string;
    defaultBranch: string;
    mainSha: string;
    triggerSha: string;
    workflow: string;
    configDigest: string;
    pr: ContinuationPr;
    /** Source run identity and successful prepare-job conclusion from its exact attempt. */
    run: {
        repository: string;
        branch: string;
        sha: string;
        workflow: string;
        event: string;
        conclusion: string;
        attempt: number;
    };
    artifactAvailable: boolean;
    mergedTree: string;
    mergedParents: string[];
    requiredChecks: string[];
    reviewDecision: string;
    version: string;
    artifactSha256: string;
    tagSha: string | null;
    releaseSha: string | null;
    registry: "absent" | "verified" | "unverified";
    attempted: boolean;
    publishedToday: boolean;
    /** Explicit operator-only recovery; never grants publication permission. */
    retireUnpublished?: boolean;
}
/** Hash exact bytes for the artifact, notes, candidate and caller-configuration bindings. */
export declare function releaseDigest(value: string | Uint8Array): string;
/** Bind every caller input except the scheduling-only mode; key order is immaterial. */
export declare function releaseConfigDigest(inputs: Record<string, unknown>): string;
/** Read an explicit Cargo package version without crossing into a dependency or workspace table. */
export declare function cargoPackageVersion(text: string): string;
/** Prove ownership before refreshing or closing a PR; use the same predicate on both paths. */
export declare function ownsContinuationPr(pr: ContinuationPr, repository: string, base: string): boolean;
/** Refuse malformed durable input before it reaches paths, shell arguments or remote effects. */
export declare function validateReleaseCandidate(candidate: ReleaseCandidate): void;
/** Identity evidence shared by publication and explicit non-publishing retirement. */
export type RetirementEvidence = Pick<ContinuationEvidence, "repository" | "defaultBranch" | "workflow" | "pr" | "registry" | "attempted" | "tagSha" | "releaseSha">;
/** Cancel owned unpublished intent even when its obsolete preparation evidence is unavailable. */
export declare function decideUnpublishedRetirement(c: ReleaseCandidate, e: RetirementEvidence): "retire";
/** Admit only trusted merged bytes; pending checks consume no runner time between invocations. */
export declare function decideReleaseContinuation(c: ReleaseCandidate, e: ContinuationEvidence): "pending" | "refresh" | "publish" | "recover" | "complete" | "stranded" | "retire";
//# sourceMappingURL=release-continuation.d.ts.map
import { defaultExec, type CompletenessFetcher } from "./release-completeness.ts";
import type { VerifierResult } from "./shell-scan.ts";
/** Process boundary shared by the real adapter and recorded command fixtures. */
export type RepairExecutor = typeof defaultExec;
/** Verified registry identity and provenance commit for one immutable version. */
export interface NpmEvidence {
    /** Registry package name. */
    name: string;
    /** Registry version coordinate. */
    version: string;
    /** Registry gitHead, required to match the signed commit. */
    gitHead: string;
    /** Signed source repository slug. */
    repository: string;
    /** Signed source commit, extracted only after npm verifies the bundle. */
    commit: string;
}
/** I/O contract for evidence and conditional writes; deliberately no publish API. */
export interface RepairClient {
    /** Verify npm provenance and read the coordinate's metadata. */
    npmEvidence(name: string, version: string): NpmEvidence;
    /** Read the actual remote tag's peeled commit, or null on proven absence. */
    remoteTag(root: string, tag: string): string | null;
    /** Read an immutable local commit's object or committed file. */
    git(root: string, args: string[]): string;
    /** Create only an absent remote tag at the attested commit. */
    createTag(slug: string, tag: string, commit: string): void;
    /** Create only a missing release with committed changelog notes. */
    createRelease(slug: string, tag: string, notes: string): void;
}
/**
 * Extract a unique source identity from npm's successful signature-audit output.
 * Raw registry metadata or a merely present attestation is never sufficient.
 */
export declare function evidenceFromAudit(name: string, version: string, gitHead: string, output: string): NpmEvidence;
/** Build the live adapter. All npm operations download/read; scripts are disabled. */
export declare function makeRepairClient(exec?: RepairExecutor): RepairClient;
/** Extract exactly one nonempty version section from an immutable changelog. */
export declare function committedReleaseNotes(changelog: string, version: string): string;
/**
 * Preflight all incomplete triples before writing. Never infer absence from a
 * failed read, move an existing tag, overwrite a release, or publish to npm.
 * Re-read remote state before each write and after uncertain write outcomes.
 */
export declare function repairReleaseCompleteness(root: string, fetcher: CompletenessFetcher, client: RepairClient): VerifierResult;
//# sourceMappingURL=release-repair.d.ts.map
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
    /** Registry release commit; the signed workflow source must be its ancestor. */
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
    /** Compare every packed file and the complete file set with the immutable release tree. */
    verifyTarball(root: string, commit: string, evidence: NpmEvidence): void;
    /** Create only an absent remote tag at the verified release commit. */
    createTag(slug: string, tag: string, commit: string): void;
    /** Create only a missing release with committed changelog notes. */
    createRelease(slug: string, tag: string, notes: string): void;
}
/** The subset of a verified SLSA v1 statement used to bind the source commit. */
export interface ProvenanceStatement {
    /** Provenance schema discriminator. */
    predicateType: string;
    /** Signed artifacts; repair requires exactly the coordinate's npm tarball. */
    subject?: {
        name?: string;
        digest?: {
            sha512?: string;
        };
    }[];
    /** Signed build definition with source dependencies. */
    predicate: {
        buildDefinition: {
            /** The signed workflow invocation; only the approved release workflow on main may authorize repair. */
            externalParameters?: {
                workflow?: {
                    path?: string;
                    ref?: string;
                    repository?: string;
                };
            };
            resolvedDependencies: {
                uri: string;
                digest: {
                    gitCommit: string;
                };
            }[];
        };
    };
}
/**
 * Extract a unique source identity from npm's successful signature-audit output.
 * Raw registry metadata or a merely present attestation is never sufficient.
 */
export declare function evidenceFromAudit(name: string, version: string, gitHead: string, output: string, integrity: string): NpmEvidence;
/** Verify signed workflow ancestry and exact package bytes at the release commit before permitting repair. */
export declare function verifyReleaseSource(root: string, commit: string, evidence: NpmEvidence, client: RepairClient): void;
/** Build the live adapter. All npm operations download/read; scripts are disabled. */
export declare function makeRepairClient(exec?: RepairExecutor): RepairClient;
/** Extract exactly one nonempty version section from an immutable changelog. */
export declare function committedReleaseNotes(changelog: string, version: string): string;
/**
 * Resolve one release's notes from committed changelogs, never from the working tree.
 *
 * The release commit's own changelog is the primary source: it records the
 * notes exactly as the released tree carried them. But a release whose commit
 * predates a changelog regeneration (the 2026.10.20 release commit was created
 * during this repository's generation-drift window and contains no section for
 * its own version, nor for 2026.10.16-2026.10.19) can never gain one - the
 * commit is immutable - so a single-source read refuses that repair forever
 * while every later daily release fails the same audit. The audit-time
 * committed changelog is the repository's own recovery source: it is
 * regenerated from every release tag (`changelog:full --all-release-tags`),
 * re-checked (`changelog:check`), and now guarded by the pre-release section
 * gate, so by the time a repair runs it carries exactly one section for every
 * released version. Both reads go through committed git state; uncommitted
 * working-tree edits are never release notes, and a fallback that also fails
 * still fails closed with the single-section requirement.
 *
 * @param root - Repository root the audit runs in.
 * @param commit - The verified release commit the notes describe.
 * @param version - The npm version string of the release.
 * @param client - The git boundary the repair reads committed files through.
 * @returns The nonempty release-note body for the version.
 * @throws When neither committed changelog has exactly one nonempty section.
 */
export declare function releaseNotesFor(root: string, commit: string, version: string, client: RepairClient): string;
/**
 * Preflight all incomplete triples before writing. Never infer absence from a
 * failed read, move an existing tag, overwrite a release, or publish to npm.
 * Re-read remote state before each write and after uncertain write outcomes.
 */
export declare function repairReleaseCompleteness(root: string, fetcher: CompletenessFetcher, client: RepairClient): VerifierResult;
//# sourceMappingURL=release-repair.d.ts.map
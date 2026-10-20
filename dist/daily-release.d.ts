/** GitHub CLI facts used to decide whether this workflow owns an open PR. */
export interface ReleasePullRequest {
    /** Repository-local PR number. */
    number: number;
    /** Source branch, including the release/ prefix. */
    headRefName: string;
    /** Must be explicitly false; a fork is never an owned branch. */
    isCrossRepository: boolean;
    /** The GITHUB_TOKEN identity as returned by gh pr list. */
    author: {
        login: string;
    } | null;
}
/** Immutable inputs read from current main, tags, and all open PRs. */
export interface DailyReleaseInput {
    /** Complete candidate list, passed through a file rather than the environment. */
    existingPrs: readonly ReleasePullRequest[];
    /** Current main commit, never the stale head of an existing release PR. */
    mainSha: string;
    /** Latest date release reachable from main. */
    lastRelease: {
        tag: string;
        sha: string;
    } | null;
    /** Calendar day in the configured release timezone, padded or unpadded. */
    today: string;
    /** Tree comparison catches an empty or reverted commit since the tag. */
    hasChanges: boolean;
    /** Every release tag reachable from main, including older spelling variants. */
    releaseTags: readonly string[];
    /** Optional reviewed package version; existing tags block re-publication until it changes. */
    packageVersion?: string;
    /** Registry-independent GitHub Release publication dates enforce the calendar cap in reviewed mode. */
    publishedToday?: boolean;
}
/** Normalize a release calendar day for daily comparisons, intentionally discarding any -N suffix. */
export declare function releaseVersion(date: string): string;
/** Select the newest numeric release date regardless of zero padding or tag creation order. */
export declare function latestReleaseTag(tags: readonly string[]): string;
/** Only same-repository, GITHUB_TOKEN-authored date branches may be rewritten or closed. */
export declare function ownsReleasePullRequest(pr: ReleasePullRequest): boolean;
/** Select the newest numeric date, then the highest PR number, independent of API ordering. */
export declare function selectReleasePullRequests(prs: readonly ReleasePullRequest[]): ReleasePullRequest[];
/** Block a second release today and skip unchanged trees; otherwise rebuild a protected PR from main. */
export declare function decideDailyRelease(input: DailyReleaseInput): {
    should_release: boolean;
    recovery_tag: string;
    action: string;
    tag: string;
    npm_version: string;
    base_sha: string;
    release_branch: string;
    pr_number: number;
    superseded_pr_numbers: string;
};
/** Stamp literal descriptor properties using the existing syntax-aware token stream. */
export declare function stampExtensionVersion(source: string, version: string): string;
/** Check registry-served SLSA v1 provenance binds both the tarball digest and published commit. */
export declare function verifyPublishedProvenance(bundle: unknown, commit: string, integrity: string): boolean;
export { verifyBunScript } from "./release-verification.ts";
/** Stamp the package table's literal Cargo version while preserving dependency and metadata versions. */
export declare function stampCargoVersion(source: string, version: string): string;
//# sourceMappingURL=daily-release.d.ts.map
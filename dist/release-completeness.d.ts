import type { VerifierResult } from "./shell-scan.ts";
/** A release tag matches a calendar version, optionally with a `-N` suffix. */
export declare const RELEASE_TAG_PATTERN: RegExp;
/**
 * Decide whether a tag is a release tag rather than an arbitrary ref.
 *
 * Only release tags are anchored: a non-release tag is not part of the release
 * triple contract and is ignored, so an unrelated tag cannot fail this gate.
 *
 * @param tag - A git tag name.
 * @returns True when the tag spells a calendar release version.
 */
export declare function isReleaseTag(tag: string): boolean;
/**
 * Convert a release tag to the npm version string it corresponds to.
 *
 * A tag zero-pads the month and day (`v2026.08.31`) while npm stores them
 * without padding (`2026.8.31`), and both may carry a `-N` suffix
 * (`v2026.07.14-1` -> `2026.7.14-1`). The components are parsed as numbers so
 * the leading zeros drop, which is also what makes the two spellings compare
 * equal.
 *
 * @param tag - A release tag name, with or without a leading `v`.
 * @returns The npm version string for that tag.
 */
export declare function tagToNpmVersion(tag: string): string;
/**
 * Convert a published npm version to the release tag it corresponds to.
 *
 * This is the inverse of {@link tagToNpmVersion}: it re-pads the month and day
 * to two digits and restores the leading `v`, so `2026.7.14-1` becomes
 * `v2026.07.14-1`. The year is already four digits, so padding to two leaves it
 * unchanged.
 *
 * @param version - A published npm version string.
 * @returns The release tag name for that version.
 */
export declare function npmVersionToTag(version: string): string;
/**
 * Extract the repository URL from a `package.json` `repository` field.
 *
 * The field may be a shorthand string or an object with a `url` key, and both
 * forms occur in this fleet, so the two are reconciled here rather than at
 * every caller.
 *
 * @param repo - The raw `repository` value from a manifest.
 * @returns The URL string, or an empty string when none is declared.
 */
export declare function repositoryUrl(repo: string | {
    url?: string;
} | undefined): string;
/**
 * Derive the `owner/name` slug from a repository URL.
 *
 * Accepts every spelling npm and git record: `git+https://github.com/o/n.git`,
 * `https://github.com/o/n`, `git@github.com:o/n.git`, and the `github:o/n`
 * shorthand. A URL that names no GitHub host yields an empty string so the
 * caller can fail closed rather than querying the wrong registry.
 *
 * The host check requires `hostname === "github.com"` exactly rather than a
 * substring test. A regex that merely looks for `github` anywhere in the URL
 * accepts `https://notgithub.com/owner/name` and
 * `https://evil.example/github:owner/name`, directing the verifier at the
 * wrong repository. The HTTPS form is parsed with `new URL` so the hostname is
 * compared precisely; the SSH (`git@github.com:owner/name`) and shorthand
 * (`github:owner/name`) forms are not valid URLs and are matched with anchored
 * patterns that require the `github.com` host literally.
 *
 * @param url - The repository URL to parse.
 * @returns The `owner/name` slug, or an empty string when no GitHub host is named.
 */
export declare function repoSlugFromUrl(url: string): string;
/**
 * Read the package name declared in a manifest.
 *
 * @param root - Repository root containing `package.json`.
 * @returns The `name` field, or an empty string when the manifest lacks one.
 */
export declare function packageNameFromManifest(root: string): string;
/**
 * Split command output into non-empty, trimmed lines.
 *
 * Used for `git tag` and `gh api ... releases` output, both of which are one entry
 * per line. A trailing newline produces no empty entry.
 *
 * @param output - Raw command output.
 * @returns The non-empty trimmed lines.
 */
export declare function parseLines(output: string): string[];
/**
 * Parse the complete JSON array emitted by `npm view <pkg> versions --json`.
 *
 * Reject malformed JSON and unreadable entries instead of dropping them. The
 * caller must report an unavailable inventory separately from an empty one;
 * otherwise a registry failure falsely describes existing releases as absent.
 *
 * @param output - Raw `npm view ... --json` output.
 * @returns Every version string from a successfully decoded inventory.
 * @throws When the response is not JSON or not an array of non-empty strings.
 */
export declare function parseNpmVersions(output: string): string[];
/**
 * Audit three release lists for completeness.
 *
 * A release tag is the anchor. For each release tag the check requires both a
 * matching published npm version and a matching GitHub Release, and it refuses
 * orphan npm versions and orphan GitHub Releases whose corresponding tag is
 * missing, so a triple is incomplete in any direction. Non-release tags are
 * ignored: they are not part of the release contract.
 *
 * An empty release-tag set is a failure rather than a pass: a scan that finds
 * no release tags is either pointed at the wrong repository or has outlived
 * the releases it guards, and both look identical to a clean result unless
 * said out loud.
 *
 * @param tags - Git tag names.
 * @param npmVersions - Published npm version strings.
 * @param githubReleases - GitHub Release tag names.
 * @returns Failures and per-list notes.
 */
export declare function auditReleaseCompleteness(tags: readonly string[], npmVersions: readonly string[], githubReleases: readonly string[]): VerifierResult;
/** A source of the three release lists, injectable so the suite is hermetic. */
export interface CompletenessFetcher {
    /** Git tag names in the repository at `root`. */
    tags(root: string): string[];
    /** The `origin` remote URL of the repository at `root`. */
    remoteUrl(root: string): string;
    /** Published npm version strings for `pkgName`. */
    npmVersions(pkgName: string): string[];
    /** GitHub Release tag names for the `owner/name` slug. */
    githubReleases(slug: string): string[];
    /**
     * Whether the GitHub Release of one tag exists, read by its tag. The list
     * endpoint can lag a release created seconds earlier; this read confirms a
     * tag the list lacks before the audit calls it missing.
     */
    githubReleaseForTag(slug: string, tag: string): boolean;
}
/**
 * Run a child process and return its stdout as a string.
 *
 * The default executor used by {@link makeFetcher}; exported so the suite can
 * cover the real {@link execFileSync} call with a local command rather than the
 * networked `npm`/`gh` invocations the fetcher builds.
 *
 * @param command - The program to run.
 * @param args - Arguments to pass.
 * @param options - Options such as `cwd`.
 * @returns The process stdout, decoded as UTF-8.
 */
export declare function defaultExec(command: string, args: string[], options?: {
    cwd?: string;
}): string;
/**
 * Fetch all GitHub Release tag names for a slug, paginating through the API.
 *
 * `gh release list -L N` caps at N entries, so a repository with more than N
 * releases silently omits the older ones. This function pages through the
 * GitHub releases API 100 at a time until a page returns fewer than a full
 * page, collecting every release so the completeness audit sees the full
 * history rather than a truncated prefix. Raising a fixed cap reproduces the
 * same defect later; paginating until the API reports no further pages does
 * not.
 *
 * @param exec - The executor to run `gh` commands through.
 * @param slug - The `owner/name` slug to query.
 * @returns All GitHub Release tag names, in API order.
 */
export declare function fetchGithubReleasesPaginated(exec: (command: string, args: string[], options: {
    cwd?: string;
}) => string, slug: string): string[];
/**
 * Build a fetcher from an executor.
 *
 * Separating the executor from the parsing lets the suite cover every command
 * construction and parser with an injected executor, while {@link defaultExec}
 * is covered separately by a local process. The fetcher the release gate uses
 * is built from {@link defaultExec}; the suite builds one from a mock.
 *
 * @param exec - The executor to run commands through.
 * @returns A fetcher whose methods gather one release list each.
 */
export declare function makeFetcher(exec: (command: string, args: string[], options: {
    cwd?: string;
}) => string): CompletenessFetcher;
/** The fetcher the release gate uses, built from the real executor. */
export declare const realFetcher: CompletenessFetcher;
/**
 * Gather the three release lists and audit them only when all reads succeed.
 *
 * A failed read names its source and makes no absence claims from partial data.
 * Missing package or repository identity is rejected before any registry read.
 * A release tag missing from the GitHub Release list is confirmed by a read of
 * that tag's release, because the list lags a release created moments earlier.
 *
 * @param root - Repository root to verify.
 * @param fetcher - The source of the three lists.
 * @returns Failures and notes for the repository.
 */
export declare function verify(root: string, fetcher: CompletenessFetcher): VerifierResult;
/**
 * Print a result and set a failing exit code when it failed.
 *
 * @param result - The audit outcome.
 * @param write - Sink for the report lines.
 * @param exit - Called with the process exit code when there were failures.
 */
export declare function report(result: VerifierResult, write: (line: string) => void, exit: (code: number) => void): void;
//# sourceMappingURL=release-completeness.d.ts.map
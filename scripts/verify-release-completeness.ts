/**
 * Proves every release tag of this package is a complete release triple: a git
 * tag, a published npm version, and a GitHub Release, all corresponding to one
 * another.
 *
 * The release workflow tags a commit and publishes to npm in the same job, but
 * the GitHub Release is a separate later step. When an earlier step failed -
 * as the bun-install verification did for 14 days from 2026-08-17 onward - the
 * job aborted before `Create GitHub release` ran, so tags and npm versions
 * accumulated with no GitHub Release and nothing reported the gap. The
 * publish-attestation and changelog-date gates both passed: the artifact was
 * attested and the heading was dated correctly, yet the release was only
 * two-thirds complete. This check closes that hole by requiring the third
 * member of every release triple to exist.
 *
 * The analysis is separated from the I/O so the rules are driven by the suite
 * against injected lists rather than only against this repository, which
 * happens to satisfy them. A release tag is the anchor: for each one the
 * check requires both a matching published npm version and a matching GitHub
 * Release, and it also refuses orphan npm versions and orphan GitHub Releases
 * whose corresponding tag is missing, so a triple is incomplete in any
 * direction.
 *
 * @packageDocumentation
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isMainInvocation } from "./main-invocation.ts";
import type { VerifierResult } from "./shell-command-scan.ts";

/** A release tag matches a calendar version, optionally with a `-N` suffix. */
export const RELEASE_TAG_PATTERN = /^v\d{4}\.\d{2}\.\d{2}(-\d+)?$/;

/**
 * Decide whether a tag is a release tag rather than an arbitrary ref.
 *
 * Only release tags are anchored: a non-release tag is not part of the release
 * triple contract and is ignored, so an unrelated tag cannot fail this gate.
 *
 * @param tag - A git tag name.
 * @returns True when the tag spells a calendar release version.
 */
export function isReleaseTag(tag: string): boolean {
  return RELEASE_TAG_PATTERN.test(tag);
}

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
export function tagToNpmVersion(tag: string): string {
  const core = tag.startsWith("v") ? tag.slice(1) : tag;
  const dash = core.indexOf("-");
  const base = dash >= 0 ? core.slice(0, dash) : core;
  const suffix = dash >= 0 ? core.slice(dash) : "";
  const parts = base.split(".").map((part) => String(Number(part)));
  return parts.join(".") + suffix;
}

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
export function npmVersionToTag(version: string): string {
  const dash = version.indexOf("-");
  const base = dash >= 0 ? version.slice(0, dash) : version;
  const suffix = dash >= 0 ? version.slice(dash) : "";
  const parts = base.split(".").map((part) => part.padStart(2, "0"));
  return `v${parts.join(".")}${suffix}`;
}

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
export function repositoryUrl(repo: string | { url?: string } | undefined): string {
  if (typeof repo === "string") return repo;
  return repo?.url ?? "";
}

/**
 * Derive the `owner/name` slug from a repository URL.
 *
 * Accepts every spelling npm and git record: `git+https://github.com/o/n.git`,
 * `https://github.com/o/n`, `git@github.com:o/n.git`, and the `github:o/n`
 * shorthand. A URL that names no GitHub host yields an empty string so the
 * caller can fail closed rather than querying the wrong registry.
 *
 * @param url - The repository URL to parse.
 * @returns The `owner/name` slug, or an empty string when no GitHub host is named.
 */
export function repoSlugFromUrl(url: string): string {
  const match = /(?:github\.com|github)[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url);
  return match ? match[1]! : "";
}

/**
 * Read the package name declared in a manifest.
 *
 * @param root - Repository root containing `package.json`.
 * @returns The `name` field, or an empty string when the manifest lacks one.
 */
export function packageNameFromManifest(root: string): string {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8")) as { name?: string };
  return pkg.name ?? "";
}

/**
 * Split command output into non-empty, trimmed lines.
 *
 * Used for `git tag` and `gh release list` output, both of which are one entry
 * per line. A trailing newline produces no empty entry.
 *
 * @param output - Raw command output.
 * @returns The non-empty trimmed lines.
 */
export function parseLines(output: string): string[] {
  return output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Parse the JSON array `npm view <pkg> versions --json` emits.
 *
 * npm prints a JSON array of version strings. A response that is not an array
 * (a single-version object, a malformed reply) yields nothing rather than
 * throwing, so a transient registry hiccup is reported by the gatherer's own
 * failure rather than crashing the parser.
 *
 * @param output - Raw `npm view ... --json` output.
 * @returns The version strings found, in the order npm prints them.
 */
export function parseNpmVersions(output: string): string[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

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
export function auditReleaseCompleteness(
  tags: readonly string[],
  npmVersions: readonly string[],
  githubReleases: readonly string[],
): VerifierResult {
  const releaseTags = tags.filter(isReleaseTag);
  const tagSet = new Set(releaseTags);
  const npmSet = new Set(npmVersions);
  const ghSet = new Set(githubReleases);
  const failures: string[] = [];

  if (releaseTags.length === 0) {
    failures.push("no release tags found - the scan is looking in the wrong place");
  }

  for (const tag of releaseTags) {
    const version = tagToNpmVersion(tag);
    if (!npmSet.has(version)) {
      failures.push(`release tag ${tag} has no corresponding published npm version (expected ${version})`);
    }
    if (!ghSet.has(tag)) {
      failures.push(`release tag ${tag} has no corresponding GitHub Release`);
    }
  }

  for (const version of npmVersions) {
    const tag = npmVersionToTag(version);
    if (!tagSet.has(tag)) {
      failures.push(`published npm version ${version} has no corresponding release tag (expected ${tag})`);
    }
  }

  for (const release of githubReleases) {
    if (!tagSet.has(release)) {
      failures.push(`GitHub Release ${release} has no corresponding release tag`);
    }
  }

  const notes: string[] = [];
  if (failures.length === 0) {
    notes.push(`ok - ${releaseTags.length} release tag(s), each with a published npm version and a GitHub Release`);
  }
  return { failures, notes };
}

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
export function defaultExec(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): string {
  return execFileSync(command, args, { encoding: "utf-8", ...options });
}

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
export function makeFetcher(exec: (command: string, args: string[], options: { cwd?: string }) => string): CompletenessFetcher {
  return {
    tags(root) {
      return parseLines(exec("git", ["tag"], { cwd: root }));
    },
    remoteUrl(root) {
      return exec("git", ["remote", "get-url", "origin"], { cwd: root }).trim();
    },
    npmVersions(pkgName) {
      return parseNpmVersions(exec("npm", ["view", pkgName, "versions", "--json"], {}));
    },
    githubReleases(slug) {
      return parseLines(exec("gh", ["release", "list", "-R", slug, "-L", "500", "--json", "tagName", "-q", ".[].tagName"], {}));
    },
  };
}

/** The fetcher the release gate uses, built from the real executor. */
export const realFetcher: CompletenessFetcher = makeFetcher(defaultExec);

/**
 * Gather the three release lists and audit them.
 *
 * @param root - Repository root to verify.
 * @param fetcher - The source of the three lists.
 * @returns Failures and notes for the repository.
 */
export function verify(root: string, fetcher: CompletenessFetcher): VerifierResult {
  const pkgName = packageNameFromManifest(root);
  const slug = repoSlugFromUrl(fetcher.remoteUrl(root));
  const tags = fetcher.tags(root);
  const npmVersions = fetcher.npmVersions(pkgName);
  const githubReleases = fetcher.githubReleases(slug);
  return auditReleaseCompleteness(tags, npmVersions, githubReleases);
}

/**
 * Print a result and set a failing exit code when it failed.
 *
 * @param result - The audit outcome.
 * @param write - Sink for the report lines.
 * @param exit - Called with the process exit code when there were failures.
 */
export function report(
  result: VerifierResult,
  write: (line: string) => void,
  exit: (code: number) => void,
): void {
  for (const note of result.notes) write(note);
  for (const failure of result.failures) write(`FAIL - ${failure}`);
  if (result.failures.length > 0) {
    write(`verify-release-completeness: ${result.failures.length} failure(s).`);
    exit(1);
    return;
  }
  write("verify-release-completeness: every release tag has a published npm version and a GitHub Release.");
}

/**
 * Verify and report, but only when this module is the process entry point.
 *
 * The guard is a function rather than a bare `if` at module scope so the suite
 * can execute both answers. A bare `if` leaves its own body unreachable from any
 * in-process test, which is how an entry point quietly stops running.
 *
 * @param argv - The process argv to judge.
 * @param moduleUrl - This module's `import.meta.url`.
 * @param root - Repository root to verify.
 * @param fetcher - The source of the three release lists.
 * @returns True when the verifier ran.
 */
export function runIfMain(
  argv: string[],
  moduleUrl: string,
  root: string,
  fetcher: CompletenessFetcher = realFetcher,
): boolean {
  if (!isMainInvocation(argv, moduleUrl)) return false;
  report(verify(root, fetcher), (line) => process.stdout.write(`${line}\n`), (code) => { process.exitCode = code; });
  return true;
}

runIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."));
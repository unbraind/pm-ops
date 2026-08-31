/**
 * Executes the release-completeness verifier's rules against injected lists.
 *
 * The verifier's own repository satisfies its rules now that the missing
 * GitHub Releases have been backfilled, so running it here would only prove
 * that today's tree is fine. What these cases prove is that each rule still
 * FAILS on the defect it exists to catch - a release tag with no published npm
 * version, a release tag with no GitHub Release, and the orphan npm versions
 * and GitHub Releases a partial release leaves behind - while a complete triple
 * passes. The three lists are injected so no test reaches the network.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  auditReleaseCompleteness,
  defaultExec,
  fetchGithubReleasesPaginated,
  isReleaseTag,
  makeFetcher,
  npmVersionToTag,
  packageNameFromManifest,
  parseLines,
  parseNpmVersions,
  realFetcher,
  RELEASE_TAG_PATTERN,
  repoSlugFromUrl,
  report,
  repositoryUrl,
  runIfMain,
  tagToNpmVersion,
  verify,
  type CompletenessFetcher,
} from "../scripts/verify-release-completeness.ts";

/** A fetcher that returns fixed lists, so no test reaches the network. */
function fixedFetcher(lists: {
  tags?: string[];
  remoteUrl?: string;
  npmVersions?: string[];
  githubReleases?: string[];
}): CompletenessFetcher {
  return {
    tags: () => lists.tags ?? [],
    remoteUrl: () => lists.remoteUrl ?? "https://github.com/unbraind/pm-ops.git",
    npmVersions: () => lists.npmVersions ?? [],
    githubReleases: () => lists.githubReleases ?? [],
  };
}

const COMPLETE_TAGS = ["v2026.08.17", "v2026.08.28"];
const COMPLETE_NPM = ["2026.8.17", "2026.8.28"];
const COMPLETE_GH = ["v2026.08.17", "v2026.08.28"];

test("isReleaseTag accepts calendar versions with and without a suffix, and rejects the rest", () => {
  for (const tag of ["v2026.08.31", "v2026.07.14-1", "v2026.01.01"]) {
    assert.equal(isReleaseTag(tag), true, tag);
  }
  for (const tag of ["2026.08.31", "v2026.8.31", "latest", "v2026.8", "release-1", ""]) {
    assert.equal(isReleaseTag(tag), false, tag);
  }
  assert.equal(RELEASE_TAG_PATTERN.test("v2026.08.31"), true);
});

test("tagToNpmVersion drops the leading v, the zero padding, and preserves a suffix", () => {
  assert.equal(tagToNpmVersion("v2026.08.31"), "2026.8.31");
  assert.equal(tagToNpmVersion("v2026.07.14-1"), "2026.7.14-1");
  assert.equal(tagToNpmVersion("v2026.01.01"), "2026.1.1");
  // A tag without a leading v is still normalised; isReleaseTag requires one,
  // but the normaliser itself must not assume it.
  assert.equal(tagToNpmVersion("2026.08.31"), "2026.8.31");
});

test("npmVersionToTag restores the leading v, the zero padding, and preserves a suffix", () => {
  assert.equal(npmVersionToTag("2026.8.31"), "v2026.08.31");
  assert.equal(npmVersionToTag("2026.7.14-1"), "v2026.07.14-1");
  assert.equal(npmVersionToTag("2026.1.1"), "v2026.01.01");
});

test("tagToNpmVersion and npmVersionToTag are inverses across the fleet's shapes", () => {
  for (const tag of ["v2026.08.31", "v2026.07.14-1", "v2026.07.10", "v2026.07.10-1"]) {
    assert.equal(npmVersionToTag(tagToNpmVersion(tag)), tag, tag);
  }
});

test("repositoryUrl reconciles a string and an object repository field", () => {
  assert.equal(repositoryUrl("git+https://github.com/unbraind/pm-ops.git"), "git+https://github.com/unbraind/pm-ops.git");
  assert.equal(repositoryUrl({ url: "https://github.com/unbraind/pm-ops" }), "https://github.com/unbraind/pm-ops");
  assert.equal(repositoryUrl(undefined), "");
});

test("repoSlugFromUrl extracts owner/name from every spelling git and npm record", () => {
  assert.equal(repoSlugFromUrl("git+https://github.com/unbraind/pm-ops.git"), "unbraind/pm-ops");
  assert.equal(repoSlugFromUrl("https://github.com/unbraind/pm-ops"), "unbraind/pm-ops");
  assert.equal(repoSlugFromUrl("git@github.com:unbraind/pm-ops.git"), "unbraind/pm-ops");
  assert.equal(repoSlugFromUrl("github:unbraind/pm-ops"), "unbraind/pm-ops");
  assert.equal(repoSlugFromUrl("https://github.com/unbraind/pm-ops/"), "unbraind/pm-ops");
  assert.equal(repoSlugFromUrl("not-a-github-url"), "");
});

test("repoSlugFromUrl rejects hostile hosts that merely contain 'github' and accepts valid GitHub forms", () => {
  // A substring test for `github` accepts `https://notgithub.com/o/n` and
  // `https://evil.example/github:o/n`, directing the verifier at the wrong
  // repository. The hostname must be `github.com` exactly; the SSH and
  // shorthand forms are matched with anchored patterns that require the host
  // literally.
  const cases: { url: string; expected: string; label: string }[] = [
    // Hostile inputs that must be REJECTED (empty slug)
    { url: "https://notgithub.com/o/n", expected: "", label: "notgithub.com is not github.com" },
    { url: "https://evil.example/github:o/n", expected: "", label: "evil.example with github: in path is not github.com" },
    { url: "https://evil.example/github/o/n", expected: "", label: "evil.example with github/ in path is not github.com" },
    { url: "http://github.com.evil.example/o/n", expected: "", label: "github.com subdomain of evil.example is not github.com" },
    // Valid GitHub inputs that must be ACCEPTED
    { url: "git@github.com:o/n", expected: "o/n", label: "SSH form without .git" },
    { url: "github:o/n", expected: "o/n", label: "shorthand form without .git" },
    { url: "https://github.com/o/n", expected: "o/n", label: "HTTPS form" },
    { url: "git+https://github.com/o/n.git", expected: "o/n", label: "git+HTTPS form with .git" },
    { url: "git@github.com:o/n.git", expected: "o/n", label: "SSH form with .git" },
    { url: "github:o/n.git", expected: "o/n", label: "shorthand form with .git" },
  ];
  for (const { url, expected, label } of cases) {
    assert.equal(repoSlugFromUrl(url), expected, `${label}: ${url}`);
  }
});

test("parseLines splits output into trimmed non-empty lines", () => {
  assert.deepEqual(parseLines("v1\nv2\nv3\n"), ["v1", "v2", "v3"]);
  assert.deepEqual(parseLines("  v1  \n\n v2 \n"), ["v1", "v2"]);
  assert.deepEqual(parseLines(""), []);
});

test("parseNpmVersions reads the JSON array npm view prints, and tolerates a non-array reply", () => {
  assert.deepEqual(parseNpmVersions('["2026.8.31","2026.8.28"]'), ["2026.8.31", "2026.8.28"]);
  assert.deepEqual(parseNpmVersions('["2026.8.31", 42, null, "2026.8.28"]'), ["2026.8.31", "2026.8.28"]);
  assert.deepEqual(parseNpmVersions('{"version":"2026.8.31"}'), [], "a single-version object is not an array");
  assert.deepEqual(parseNpmVersions("null"), []);
});

test("a complete triple passes and is reported as a single summary note", () => {
  const result = auditReleaseCompleteness(COMPLETE_TAGS, COMPLETE_NPM, COMPLETE_GH);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.notes, ["ok - 2 release tag(s), each with a published npm version and a GitHub Release"]);
});

test("a release tag with no published npm version fails, naming the expected version", () => {
  const result = auditReleaseCompleteness(COMPLETE_TAGS, ["2026.8.17"], COMPLETE_GH);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /release tag v2026\.08\.28 has no corresponding published npm version \(expected 2026\.8\.28\)/);
});

test("a release tag with no GitHub Release fails, naming the tag", () => {
  const result = auditReleaseCompleteness(COMPLETE_TAGS, COMPLETE_NPM, ["v2026.08.17"]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /release tag v2026\.08\.28 has no corresponding GitHub Release/);
});

test("a published npm version with no release tag fails, naming the expected tag", () => {
  const result = auditReleaseCompleteness(["v2026.08.17"], ["2026.8.17", "2026.8.28"], ["v2026.08.17"]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /published npm version 2026\.8\.28 has no corresponding release tag \(expected v2026\.08\.28\)/);
});

test("a GitHub Release with no release tag fails, naming the release", () => {
  const result = auditReleaseCompleteness(["v2026.08.17"], ["2026.8.17"], ["v2026.08.17", "v2026.08.28"]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /GitHub Release v2026\.08\.28 has no corresponding release tag/);
});

test("an empty release-tag set fails, because an empty scan and a clean tree look identical", () => {
  const result = auditReleaseCompleteness([], [], []);
  assert.deepEqual(result.failures, ["no release tags found - the scan is looking in the wrong place"]);
  assert.deepEqual(result.notes, []);
});

test("a non-release tag is ignored, so an unrelated ref cannot fail the gate", () => {
  const result = auditReleaseCompleteness(["v2026.08.17", "v2026.08.28", "latest", "release-1"], COMPLETE_NPM, COMPLETE_GH);
  assert.deepEqual(result.failures, []);
  assert.match(result.notes[0]!, /2 release tag/);
});

test("the measured 14-day defect - tags published to npm with no GitHub Release - fails", () => {
  // v2026.08.28, v2026.08.29 and v2026.08.31 were tagged and published but had
  // no GitHub Release for 14 days; this is exactly the gap the gate exists for.
  const tags = ["v2026.08.17", "v2026.08.28", "v2026.08.29", "v2026.08.31"];
  const npm = ["2026.8.17", "2026.8.28", "2026.8.29", "2026.8.31"];
  const gh = ["v2026.08.17"];
  const result = auditReleaseCompleteness(tags, npm, gh);
  assert.equal(result.failures.length, 3);
  for (const tag of ["v2026.08.28", "v2026.08.29", "v2026.08.31"]) {
    assert.ok(result.failures.some((f) => f === `release tag ${tag} has no corresponding GitHub Release`), tag);
  }
});

test("defaultExec runs a real local process and returns its stdout", () => {
  assert.equal(defaultExec(process.execPath, ["-e", "process.stdout.write('ok')"]), "ok");
});

test("makeFetcher builds a fetcher whose methods parse executor output", () => {
  const calls: string[] = [];
  const mockExec = (command: string, args: string[], _options: { cwd?: string }): string => {
    calls.push(`${command} ${args.join(" ")}`);
    if (args[0] === "tag") return "v2026.08.17\nv2026.08.28\n";
    if (args[0] === "remote") return "git@github.com:unbraind/pm-ops.git\n";
    if (args[0] === "view") return '["2026.8.17","2026.8.28"]';
    if (args[0] === "api") return "v2026.08.17\nv2026.08.28\n";
    return "";
  };
  const fetcher = makeFetcher(mockExec);
  assert.deepEqual(fetcher.tags("/repo"), ["v2026.08.17", "v2026.08.28"]);
  assert.equal(fetcher.remoteUrl("/repo"), "git@github.com:unbraind/pm-ops.git");
  assert.deepEqual(fetcher.npmVersions("pm-ops"), ["2026.8.17", "2026.8.28"]);
  assert.deepEqual(fetcher.githubReleases("unbraind/pm-ops"), ["v2026.08.17", "v2026.08.28"]);
  assert.ok(calls.some((c) => c.startsWith("git tag")), "the tags method runs git tag");
  assert.ok(calls.some((c) => c.includes("remote get-url origin")), "the remoteUrl method reads the origin remote");
  assert.ok(calls.some((c) => c.includes("view pm-ops versions --json")), "the npmVersions method queries npm");
  assert.ok(calls.some((c) => c.includes("api") && c.includes("repos/unbraind/pm-ops/releases")), "the githubReleases method queries the GitHub releases API");
});

test("realFetcher is built from the real executor at module load", () => {
  assert.equal(typeof realFetcher.tags, "function");
  assert.equal(typeof realFetcher.npmVersions, "function");
});

test("fetchGithubReleasesPaginated collects releases across a page boundary, not just the first page", () => {
  // `gh release list -L 500` caps at 500 entries, so a repository with more
  // than 500 releases silently omits the older ones. Past that cap, otherwise
  // complete tags get reported as missing a GitHub Release — permanently red
  // release:check. Paginating until the API reports no further pages does not.
  let pageCalls = 0;
  const page1 = Array.from({ length: 100 }, (_, i) => `v2026.01.${String(i + 1).padStart(2, "0")}`).join("\n") + "\n";
  const page2 = "v2026.02.01\nv2026.02.02\n";
  const mockExec = (command: string, args: string[], _options: { cwd?: string }): string => {
    if (args[0] === "api") {
      pageCalls++;
      return pageCalls === 1 ? page1 : page2;
    }
    return "";
  };
  const releases = fetchGithubReleasesPaginated(mockExec, "owner/repo");
  assert.equal(releases.length, 102, "all releases across both pages are collected");
  assert.equal(pageCalls, 2, "both pages were fetched");
  assert.deepEqual(releases.slice(0, 2), ["v2026.01.01", "v2026.01.02"]);
  assert.deepEqual(releases.slice(100), ["v2026.02.01", "v2026.02.02"]);
});

test("fetchGithubReleasesPaginated stops when a page returns fewer than a full page", () => {
  let pageCalls = 0;
  const mockExec = (command: string, args: string[], _options: { cwd?: string }): string => {
    if (args[0] === "api") {
      pageCalls++;
      return "v2026.01.01\nv2026.01.02\n";
    }
    return "";
  };
  const releases = fetchGithubReleasesPaginated(mockExec, "owner/repo");
  assert.equal(releases.length, 2, "a partial page is the last page");
  assert.equal(pageCalls, 1, "no second page is fetched after a partial page");
});

test("fetchGithubReleasesPaginated stops when a page returns nothing", () => {
  let pageCalls = 0;
  const mockExec = (command: string, args: string[], _options: { cwd?: string }): string => {
    if (args[0] === "api") {
      pageCalls++;
      return pageCalls === 1 ? Array.from({ length: 100 }, (_, i) => `v2026.01.${String(i + 1).padStart(2, "0")}`).join("\n") + "\n" : "";
    }
    return "";
  };
  const releases = fetchGithubReleasesPaginated(mockExec, "owner/repo");
  assert.equal(releases.length, 100, "a full page followed by an empty page yields exactly one page");
  assert.equal(pageCalls, 2, "the empty page was fetched to confirm no more results");
});

test("makeFetcher paginates githubReleases through the API rather than capping at a fixed limit", () => {
  let pageCalls = 0;
  const mockExec = (command: string, args: string[], _options: { cwd?: string }): string => {
    if (args[0] === "tag") return "v2026.01.01\n";
    if (args[0] === "remote") return "https://github.com/o/repo.git\n";
    if (args[0] === "view") return '["2026.1.1"]';
    if (args[0] === "api") {
      pageCalls++;
      if (pageCalls === 1) return Array.from({ length: 100 }, (_, i) => `v2026.01.${String(i + 1).padStart(2, "0")}`).join("\n") + "\n";
      return "v2026.02.01\n";
    }
    return "";
  };
  const fetcher = makeFetcher(mockExec);
  const releases = fetcher.githubReleases("o/repo");
  assert.equal(releases.length, 101, "the fetcher paginates past the first page");
  assert.equal(pageCalls, 2);
});

test("verify gathers the three lists through the fetcher and audits them", () => {
  const root = resolve(import.meta.dirname, "..");
  const result = verify(root, fixedFetcher({ tags: COMPLETE_TAGS, npmVersions: COMPLETE_NPM, githubReleases: COMPLETE_GH }));
  assert.deepEqual(result.failures, []);
  // The package name is read from the real manifest, so the fetcher is asked
  // for the real package's npm versions.
});

test("verify derives the repo slug from the remote URL the fetcher returns", () => {
  const root = resolve(import.meta.dirname, "..");
  let askedSlug = "";
  const fetcher: CompletenessFetcher = {
    tags: () => COMPLETE_TAGS,
    remoteUrl: () => "https://github.com/unbraind/pm-ops.git",
    npmVersions: () => COMPLETE_NPM,
    githubReleases: (slug) => { askedSlug = slug; return COMPLETE_GH; },
  };
  verify(root, fetcher);
  assert.equal(askedSlug, "unbraind/pm-ops");
});

test("packageNameFromManifest reads the name, and yields empty when the manifest lacks one", () => {
  assert.equal(packageNameFromManifest(resolve(import.meta.dirname, "..")), "pm-ops");
  const root = mkdtempSync(join(tmpdir(), "completeness-pkg-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
    assert.equal(packageNameFromManifest(root), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report prints notes then failures and asks for a failing exit code", () => {
  const lines: string[] = [];
  const codes: number[] = [];
  report({ failures: ["bad"], notes: ["fine"] }, (line) => lines.push(line), (code) => codes.push(code));
  assert.deepEqual(lines, ["fine", "FAIL - bad", "verify-release-completeness: 1 failure(s)."]);
  assert.deepEqual(codes, [1]);
});

test("report on a clean result says so and asks for no exit code", () => {
  const lines: string[] = [];
  const codes: number[] = [];
  report({ failures: [], notes: ["ok - 1 release tag(s), each with a published npm version and a GitHub Release"] }, (line) => lines.push(line), (code) => codes.push(code));
  assert.deepEqual(lines, ["ok - 1 release tag(s), each with a published npm version and a GitHub Release", "verify-release-completeness: every release tag has a published npm version and a GitHub Release."]);
  assert.deepEqual(codes, []);
});

test("runIfMain runs only as the entry point, and verifies with the fetcher it is given", () => {
  const scriptUrl = import.meta.resolve("../scripts/verify-release-completeness.ts");
  // Not the entry point: returns false and runs nothing.
  assert.equal(runIfMain(["node", fileURLToPath(import.meta.url)], scriptUrl, ".", fixedFetcher({})), false);
  // The entry point: runs the verifier with the injected fetcher and returns true.
  const previous = process.exitCode;
  try {
    const root = resolve(import.meta.dirname, "..");
    assert.equal(
      runIfMain(
        ["node", fileURLToPath(scriptUrl)],
        scriptUrl,
        root,
        fixedFetcher({ tags: COMPLETE_TAGS, npmVersions: COMPLETE_NPM, githubReleases: COMPLETE_GH }),
      ),
      true,
    );
    assert.equal(process.exitCode, previous, "a complete tree must not set a failing exit code");
    const failing = runIfMain(
      ["node", fileURLToPath(scriptUrl)],
      scriptUrl,
      root,
      fixedFetcher({ tags: ["v2026.08.28"], npmVersions: [], githubReleases: [] }),
    );
    assert.equal(failing, true);
    assert.equal(process.exitCode, 1, "an incomplete tree must set a failing exit code");
  } finally {
    process.exitCode = previous;
  }
});
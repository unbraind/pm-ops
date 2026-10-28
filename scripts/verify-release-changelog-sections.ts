/**
 * Proves the changelog carries exactly one nonempty section for every released
 * version AND the pending package version BEFORE a release starts.
 *
 * Why this gate exists separately from `npm run changelog:check`: that script
 * proves the committed changelog matches the generator's current output, so a
 * generator that itself omits a released version satisfies it. That is not
 * hypothetical: the 2026.10.16-2026.10.20 generation-drift window produced a
 * `CHANGELOG.md` ending at the 2026.10.15 section while `changelog:check`
 * passed, and the v2026.10.20 release commit was created with no section for
 * its own version. The tag and the npm publish succeeded, the GitHub Release
 * was never created, and the release repair then refused forever, because its
 * only note source was the immutable release commit's changelog. This gate
 * anchors the check on the release tags and package coordinate - independent of the
 * generator - and reuses {@link committedReleaseNotes}, the exact section
 * matcher the repair uses, so a changelog it accepts is a changelog the repair
 * can take notes from, and a changelog it refuses can never reach a release
 * commit again.
 *
 * The analysis is separated from the I/O so the rules are driven by the suite
 * against fixtures rather than only against this repository, which happens to
 * satisfy them.
 *
 * @packageDocumentation
 */
import { join, resolve } from "node:path";

import { readRegularText } from "../regular-input.ts";
import { execFileSync } from "../subprocess.ts";
import { committedReleaseNotes } from "../release-repair.ts";
import { isReleaseTag, npmVersionToTag, parseLines, tagToNpmVersion } from "../release-completeness.ts";
import type { VerifierResult } from "../shell-scan.ts";
import { runVerifierIfMain } from "./main-invocation.ts";

/**
 * Reduce raw git tag names to the released npm versions they correspond to.
 *
 * Non-release tags are not part of the release contract and are ignored, and
 * repeated tags collapse to one check while same-day suffix releases remain
 * distinct npm versions.
 *
 * @param tags - Git tag names as `git tag` prints them.
 * @returns The unique released npm version strings, in tag order.
 */
export function releasedVersions(tags: readonly string[]): string[] {
  return [...new Set(tags.filter(isReleaseTag).map(tagToNpmVersion))];
}

/** Include the intended package coordinate before tagging, normalized like historical tags. */
export function requiredVersions(tags: readonly string[], pendingVersion: unknown): string[] {
  if (typeof pendingVersion !== "string" || !isReleaseTag(npmVersionToTag(pendingVersion))) {
    throw new Error("package.json must declare a calendar release version");
  }
  return [...new Set([...releasedVersions(tags), tagToNpmVersion(pendingVersion)])];
}

/**
 * Audit one changelog text against every required release version.
 *
 * Every historical and pending version must have exactly one nonempty section - the same
 * requirement the repair places on the notes it publishes - so a missing,
 * duplicated or empty section fails before a release starts rather than as an
 * unrepairable historical refusal afterwards. An empty version list is a
 * failure rather than a pass: a scan must not succeed without checking any
 * release coordinate. A first release still checks its pending package version.
 *
 * @param changelog - The changelog text the release would commit.
 * @param versions - Required historical and pending npm version strings.
 * @returns Failures and per-version notes.
 */
export function auditChangelogSections(changelog: string, versions: readonly string[]): VerifierResult {
  const failures: string[] = [];
  const notes: string[] = [];
  if (versions.length === 0) {
    failures.push("no required release versions found - the section gate needs a release inventory");
  }
  for (const version of versions) {
    try {
      committedReleaseNotes(changelog, version);
      notes.push(`ok - exactly one changelog section for ${version}`);
    } catch (error) {
      failures.push(`required release version ${version} has no usable changelog section: ${String(error)}`);
    }
  }
  return { failures, notes };
}

/**
 * Read the complete intended release inventory and audit the checkout's changelog.
 *
 * The tag list is injectable so the suite can drive the rules hermetically;
 * the default reads `git tag` in the checkout, which CI and the release job
 * both fetch before running the gate. The package version is always read from
 * the checkout being checked, even when no corresponding tag exists yet.
 * Non-Git trackers can supply an explicit tag inventory; the default Git read
 * fails with a verifier diagnostic instead of crashing the caller.
 *
 * @param root - Checkout containing `package.json` and `CHANGELOG.md`.
 * @param tags - Git tag names; defaults to the checkout's own tags.
 * @returns Failures and notes for the checkout.
 */
export function verify(root: string, tags?: readonly string[]): VerifierResult {
  try {
    const manifest = JSON.parse(readRegularText(join(root, "package.json"))) as { version?: unknown } | null;
    const inventory = tags ?? parseLines(execFileSync("git", ["tag"], { cwd: root, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }));
    return auditChangelogSections(readRegularText(join(root, "CHANGELOG.md")), requiredVersions(inventory, manifest?.version));
  } catch (error) {
    return { failures: [`release section audit failed: ${String(error)}`], notes: [] };
  }
}

/**
 * Emit the per-version audit lines, then every failure, then the verdict, and
 * request exit code 1 only when a failure was reported.
 *
 * @param audit - The section-gate outcome to print.
 * @param sink - Sink for the report lines.
 * @param exit - Called with the process exit code when there were failures.
 */
export function report(audit: VerifierResult, sink: (line: string) => void, exit: (code: number) => void): void {
  for (const note of audit.notes) sink(note);
  for (const failure of audit.failures) sink(`FAIL - ${failure}`);
  const verdict = `verify-release-changelog-sections: ${audit.failures.length} failure(s).`;
  if (audit.failures.length > 0) {
    sink(verdict);
    exit(1);
    return;
  }
  sink("verify-release-changelog-sections: every required release version has exactly one nonempty changelog section.");
}

/**
 * Audit and report only when this file is the process entry point; the suite
 * declines the run when it is not.
 *
 * @param args - The process argv to judge.
 * @param moduleUrl - This module's `import.meta.url`.
 * @param checkout - Repository root to verify.
 * @returns True when the verifier ran.
 */
export function runIfMain(args: readonly string[], moduleUrl: string, checkout: string): boolean {
  return runVerifierIfMain(args, moduleUrl, () => verify(checkout), report);
}

runIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."));

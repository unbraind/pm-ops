/**
 * Executes the pre-release changelog section gate's rules against fixtures.
 *
 * This repository's changelog currently satisfies the gate, so the value of
 * these cases is that each rule still FAILS on the defect it exists to catch:
 * a changelog that stops before already-released versions (the exact
 * 2026.10.16-2026.10.20 generation-drift shape that shipped a release commit
 * with no section for its own version and made the release repair refuse
 * forever), a duplicated section, an empty section body, and a scan anchored
 * on no release tags at all. The section matcher is the repair's own
 * committedReleaseNotes, so what passes here is exactly what the repair can
 * take notes from later.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  auditChangelogSections,
  releasedVersions,
  report,
  runIfMain,
  verify,
} from "../scripts/verify-release-changelog-sections.ts";
import { assertCleanReport, assertFailingReport } from "./command-test-helpers.ts";

/** Two healthy adjacent sections. */
const healthy = "# Changelog\n\n## 2026.10.20 - 2026-10-20\n\n- One section.\n\n## 2026.10.19 - 2026-10-19\n\n- Earlier release.\n";
/** The drift shape: the changelog stops before versions that are already released. */
const drifted = "# Changelog\n\n## 2026.10.15 - 2026-10-15\n\n- Stops before the drift window.\n";

test("releasedVersions keeps release tags, drops others and collapses one version's spellings", () => {
  assert.deepEqual(releasedVersions(["v2026.10.20", "v2026.10.04", "not-a-release-tag", "backup/v2026.10.19"]), ["2026.10.20", "2026.10.4"]);
  assert.deepEqual(releasedVersions([]), []);
});

test("one nonempty section per released version passes", () => {
  const result = auditChangelogSections(healthy, ["2026.10.20", "2026.10.19"]);
  assert.deepEqual(result.failures, []);
  assert.ok(result.notes.includes("ok - exactly one changelog section for 2026.10.20"));
  assert.ok(result.notes.includes("ok - exactly one changelog section for 2026.10.19"));
});

test("the drift shape fails before a release starts: missing, duplicated and empty sections", () => {
  // The 2026-10-20 incident shape: sections end at 2026.10.15 while
  // 2026.10.16 through 2026.10.20 were already tagged and published.
  const missing = auditChangelogSections(drifted, ["2026.10.15", "2026.10.16", "2026.10.20"]);
  assert.equal(missing.failures.length, 2, missing.failures.join("; "));
  for (const version of ["2026.10.16", "2026.10.20"]) {
    assert.ok(missing.failures.some((failure) => failure.startsWith(`released version ${version} has no usable changelog section: committed changelog must have exactly one section for ${version}`)), missing.failures.join("; "));
  }
  const duplicated = auditChangelogSections(`${healthy}\n## 2026.10.20 - 2026-10-20\n\n- A second copy of the section.\n`, ["2026.10.20"]);
  assert.match(duplicated.failures[0]!, /exactly one section for 2026\.10\.20/);
  const empty = auditChangelogSections("# Changelog\n\n## 2026.10.20 - 2026-10-20\n\n## 2026.10.19 - 2026-10-19\n\n- Earlier release.\n", ["2026.10.20"]);
  assert.match(empty.failures[0]!, /section for 2026\.10\.20 is empty/);
  // No release tags is a failed scan, not a passing one.
  assert.match(auditChangelogSections(healthy, []).failures[0]!, /no released versions found/);
});

test("verify audits a checkout's changelog against injected tags, and the live repository passes", () => {
  const root = mkdtempSync(join(tmpdir(), "changelog-section-gate-"));
  try {
    writeFileSync(join(root, "CHANGELOG.md"), drifted);
    assert.equal(verify(root, ["v2026.10.15", "v2026.10.16"]).failures.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
  // The live repository anchors the gate on its real tags; this doubles as
  // the honest-current-tree check, so a regenerated changelog that lost a
  // released version fails here before any release starts.
  const live = verify(resolve("."));
  assert.deepEqual(live.failures, [], live.failures.join("; "));
  assert.ok(live.notes.length > 0);
});

test("the release gate chain runs the section check before a release starts", () => {
  const scripts = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.match(scripts["release:check"]!, /verify:release-changelog-sections/);
  assert.match(scripts["verify:release-changelog-sections"]!, /verify-release-changelog-sections\.ts/);
  const workflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  const gate = workflow.slice(workflow.indexOf("- name: Run release checks"), workflow.indexOf("- name: Commit release files"));
  assert.match(gate, /npm run release:check/);
});

test("report prints notes then failures and requests exit codes only on failures", () => {
  assertFailingReport(report, "verify-release-changelog-sections: 1 failure(s).");
  assertCleanReport(report, ["ok - exactly one changelog section for 2026.10.19"], "verify-release-changelog-sections: every released version has exactly one nonempty changelog section.");
});

test("entry point runs only as main and reports the checkout", () => {
  const moduleUrl = import.meta.resolve("../scripts/verify-release-changelog-sections.ts");
  const script = new URL(moduleUrl).pathname;
  const lines: string[] = [];
  const oldWrite = process.stdout.write;
  const oldExit = process.exitCode;
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    // A resolvable but different entry path declines to run: realpathSync
    // propagates on an unresolvable argv[1], so the "not main" probe must
    // name a real file - this suite's own path.
    const suite = new URL(import.meta.url).pathname;
    assert.equal(runIfMain(["node", suite], moduleUrl, resolve(".")), false);
    assert.equal(runIfMain(["node", script], moduleUrl, resolve(".")), true);
    assert.equal(process.exitCode, oldExit);
    assert.ok(lines.some((line) => line.includes("verify-release-changelog-sections:")));
  } finally { process.stdout.write = oldWrite; process.exitCode = oldExit; }
});
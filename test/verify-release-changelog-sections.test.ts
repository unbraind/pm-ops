/**
 * Executes the pre-release changelog section gate's rules against fixtures.
 *
 * This repository's changelog currently satisfies the gate, so the value of
 * these cases is that each rule still FAILS on the defect it exists to catch:
 * a changelog that stops before already-released versions (the exact
 * 2026.10.16-2026.10.20 generation-drift shape that shipped a release commit
 * with no section for its own version and made the release repair refuse
 * forever), an untagged pending release, a duplicated section, an empty
 * section body, and a scan with no required version inventory. The section matcher is the repair's own
 * committedReleaseNotes, so what passes here is exactly what the repair can
 * take notes from later.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditChangelogSections,
  releasedVersions,
  requiredVersions,
  report,
  runIfMain,
  verify,
} from "../scripts/verify-release-changelog-sections.ts";
import { assertCleanReport, assertFailingReport } from "./command-test-helpers.ts";
import { execFileSync, spawnSync } from "../subprocess.ts";
import { npmLauncher } from "./npm-launcher.ts";

/** Two healthy adjacent sections. */
const healthy = "# Changelog\n\n## 2026.10.20 - 2026-10-20\n\n- One section.\n\n## 2026.10.19 - 2026-10-19\n\n- Earlier release.\n";
/** The drift shape: the changelog stops before versions that are already released. */
const drifted = "# Changelog\n\n## 2026.10.15 - 2026-10-15\n\n- Stops before the drift window.\n";

test("releasedVersions keeps suffix releases, drops unrelated tags and collapses repeated tags", () => {
  assert.deepEqual(releasedVersions(["v2026.10.20", "v2026.10.20", "v2026.10.20-1", "v2026.10.04", "not-a-release-tag", "backup/v2026.10.19"]), ["2026.10.20", "2026.10.20-1", "2026.10.4"]);
  assert.deepEqual(releasedVersions([]), []);
});

test("required inventory preserves supported package versions and refuses an unusable pending coordinate", () => {
  for (const version of ["2026.10.20", "2026.10.29", "2026.10.29-1", "2026.10.04"]) {
    assert.ok(requiredVersions([], version).length === 1, version);
  }
  assert.deepEqual(requiredVersions(["v2026.10.04", "v2026.10.29-1"], "2026.10.4"), ["2026.10.4", "2026.10.29-1"]);
  for (const value of [undefined, null, false, 0, {}, [], "", "unreleased", "2026.10", "2026.10.29-beta"]) {
    assert.throws(() => requiredVersions(["v2026.10.28"], value), /package.json must declare a calendar release version/);
  }
});

test("every historical subset and pending coordinate requires every section before and after tagging", () => {
  const root = mkdtempSync(join(tmpdir(), "pending-section-inventory-"));
  const coordinates = [
    { tag: "v2026.10.04", package: "2026.10.04", version: "2026.10.4" },
    { tag: "v2026.10.28", package: "2026.10.28", version: "2026.10.28" },
    { tag: "v2026.10.29", package: "2026.10.29", version: "2026.10.29" },
    { tag: "v2026.10.29-1", package: "2026.10.29-1", version: "2026.10.29-1" },
  ];
  try {
    for (let mask = 0; mask < 2 ** coordinates.length; mask++) {
      const historical = coordinates.filter((_, index) => mask & (1 << index));
      const tags = [...historical, ...historical].map(coordinate => coordinate.tag).concat("backup/v2026.10.30");
      for (const pending of coordinates) {
        // The oracle is a literal table of npm/tag spellings, independent of
        // the production normalizer and inventory builder.
        const expected = [...new Set([...historical.map(coordinate => coordinate.version), pending.version])];
        writeFileSync(join(root, "package.json"), JSON.stringify({ version: pending.package }));
        const sections = expected.map(version => `## ${version}\n\nNo tracked changes.\n`);
        writeFileSync(join(root, "CHANGELOG.md"), sections.join("\n"));
        const valid = verify(root, tags);
        assert.deepEqual(valid.failures, [], `mask ${mask}, pending ${pending.package}`);
        assert.deepEqual(valid.notes, expected.map(version => `ok - exactly one changelog section for ${version}`));
        for (let index = 0; index < expected.length; index++) {
          const version = expected[index]!;
          for (const defect of ["missing", "duplicate", "empty"] as const) {
            const corrupted = defect === "missing" ? sections.filter((_, position) => position !== index)
              : defect === "duplicate" ? [...sections, sections[index]!]
              : sections.map((section, position) => position === index ? `## ${version}\n\n` : section);
            writeFileSync(join(root, "CHANGELOG.md"), corrupted.join("\n"));
            const result = verify(root, tags);
            assert.equal(result.failures.length, 1, `mask ${mask}, pending ${pending.package}, ${defect} ${version}`);
            assert.ok(result.failures[0]!.includes(`required release version ${version} `));
          }
        }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("npm and Bun verifier commands refuse untagged missing, duplicated and empty pending sections", () => {
  const root = mkdtempSync(join(tmpdir(), "pending-section-cli-"));
  const script = new URL("../scripts/verify-release-changelog-sections.ts", import.meta.url);
  const env: NodeJS.ProcessEnv = { ...process.env, NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull };
  for (const key of Object.keys(env)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|AUTH/i.test(key)) delete env[key];
  }
  try {
    execFileSync("git", ["init", "-q", root], { env });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Release fixture"], { cwd: root, env });
    execFileSync("git", ["tag", "v2026.10.28"], { cwd: root, env });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2026.10.29", scripts: { "verify:release-changelog-sections": "node gate.ts" } }));
    // Execute the real CLI guard and reporter against the disposable checkout.
    writeFileSync(join(root, "gate.ts"), `import { runIfMain } from ${JSON.stringify(script.href)};\nrunIfMain([process.execPath, ${JSON.stringify(fileURLToPath(script))}], ${JSON.stringify(script.href)}, import.meta.dirname);\n`);
    const previous = "## 2026.10.28\n\nNo tracked changes.\n";
    const pending = "## 2026.10.29\n\nNo tracked changes.\n";
    for (const executable of ["npm", "bun"]) {
      for (const [text, expected] of [[previous, 1], [previous + pending + pending, 1], [previous + "## 2026.10.29\n\n", 1], [previous + pending, 0]] as const) {
        writeFileSync(join(root, "CHANGELOG.md"), text);
        const args = ["run", "verify:release-changelog-sections"];
        const launch = executable === "npm" ? npmLauncher("npm", args, env) : { executable, args };
        const result = spawnSync(launch.executable, launch.args, { cwd: root, env, encoding: "utf8", shell: false });
        assert.equal(result.status, expected, `${executable}: ${result.stdout}\n${result.stderr}`);
        if (expected !== 0) assert.match(result.stdout, /required release version 2026\.10\.29 has no usable changelog section/);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unreadable or invalid package coordinates fail closed without modifying tracker inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "pending-section-invalid-"));
  try {
    const changelog = join(root, "CHANGELOG.md");
    writeFileSync(changelog, healthy);
    assert.equal(verify(root, ["v2026.10.20"]).failures.length, 1);
    for (const manifest of [null, {}, { version: null }, { version: "" }, { version: "invalid" }]) {
      const text = JSON.stringify(manifest);
      writeFileSync(join(root, "package.json"), text);
      assert.match(verify(root, ["v2026.10.20"]).failures[0]!, /package.json must declare a calendar release version/);
      assert.equal(readFileSync(join(root, "package.json"), "utf8"), text);
      assert.equal(readFileSync(changelog, "utf8"), healthy);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    assert.ok(missing.failures.some((failure) => failure.startsWith(`required release version ${version} has no usable changelog section: Error: committed changelog must have exactly one section for ${version}`)), missing.failures.join("; "));
  }
  const duplicated = auditChangelogSections(`${healthy}\n## 2026.10.20 - 2026-10-20\n\n- A second copy of the section.\n`, ["2026.10.20"]);
  assert.match(duplicated.failures[0]!, /exactly one section for 2026\.10\.20/);
  const empty = auditChangelogSections("# Changelog\n\n## 2026.10.20 - 2026-10-20\n\n## 2026.10.19 - 2026-10-19\n\n- Earlier release.\n", ["2026.10.20"]);
  assert.match(empty.failures[0]!, /section for 2026\.10\.20 is empty/);
  // An empty required-version inventory is a failed scan, not a passing one.
  assert.match(auditChangelogSections(healthy, []).failures[0]!, /no required release versions found/);
});

test("verify audits a checkout's changelog against injected tags, and the live repository passes", () => {
  const root = mkdtempSync(join(tmpdir(), "changelog-section-gate-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2026.10.16" }));
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
  assert.equal(scripts["prepublishOnly"], "npm run release:check");
  const workflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  const gate = workflow.slice(workflow.indexOf("- name: Run release checks"), workflow.indexOf("- name: Commit release files"));
  assert.match(gate, /npm run release:check/);
});

test("report prints notes then failures and requests exit codes only on failures", () => {
  assertFailingReport(report, "verify-release-changelog-sections: 1 failure(s).");
  assertCleanReport(report, ["ok - exactly one changelog section for 2026.10.19"], "verify-release-changelog-sections: every required release version has exactly one nonempty changelog section.");
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

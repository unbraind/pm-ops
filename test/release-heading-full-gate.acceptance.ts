/** Run the real release gate after the workflow rewrites a disposable candidate's date policy.
 * Kept outside the unit-test glob because release:check itself runs that suite. */
import assert from "node:assert/strict";
import { execFileSync } from "../subprocess.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { runBashFixture } from "./bash-fixture.ts";
import { mirrorTrackedSnapshot } from "./release-heading-snapshot-fixture.ts";

const source = process.cwd();
const root = mkdtempSync(join(tmpdir(), "release-heading-full-gate-"));
const candidate = join(root, "candidate");
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: process.env.NODE_OPTIONS,
  PM_TEST_DEPTH: process.env.PM_TEST_DEPTH,
  PM_TEST_TIME_SCALE: process.env.PM_TEST_TIME_SCALE,
  PM_TELEMETRY_DISABLED: "1", NPM_CONFIG_USERCONFIG: "/dev/null",
};

try {
  execFileSync("git", ["clone", "--quiet", "--shared", source, candidate], { env });
  const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: source, env, encoding: "utf8" }).trim();
  execFileSync("git", ["remote", "set-url", "origin", origin], { cwd: candidate, env });
  // Include the current, reviewable source and tracker edits rather than testing
  // only the last commit. Generated output is rebuilt by the gate.
  mirrorTrackedSnapshot(source, candidate, env);
  execFileSync("npm", ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: candidate, env, stdio: "inherit" });
  execFileSync("npm", ["run", "changelog:check"], { cwd: candidate, env, stdio: "inherit" });
  const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(manifest.scripts["release:check"]!, /npm run coverage/);
  const definition = parse(readFileSync(join(candidate, ".github/workflows/daily-release.yml"), "utf8"));
  const releaseEnv = {
    ...env, IS_RUST: "false", CHANGELOG_SCRIPT: "changelog:full", CHANGELOG_CHECK_SCRIPT: "changelog:check",
    NOTES_SCRIPT: "release:notes", RELEASE_HEADING_DATE: "2026-11-17", RUNNER_TEMP: root,
    GITHUB_STEP_SUMMARY: join(root, "summary.md"), CONTINUATION_SCRIPT: join(candidate, "scripts/release-continuation.ts"),
    // Reserve a fixture coordinate beyond the real tag history and stamp it
    // through the same workflow step used for the manifest and extension.
    NPM_VERSION: "2099.11.30", VERSION_POLICY: "daily", PREPARE_SCRIPT: "", BUILD_SCRIPT: "", PM_OPS_MODULE: join(candidate, "dist/index.js"),
  };
  const outputs = join(root, "prepare.out");
  for (const name of ["Update release version", "Prepare npm changelog hooks", "Generate changelog and release notes"]) {
    const step = definition.jobs.prepare.steps.find((entry: { name?: string }) => entry.name === name);
    const policy = name === "Generate changelog and release notes"
      ? Object.fromEntries(readFileSync(outputs, "utf8").trim().split("\n").map(line => line.split("="))) : {};
    const prepared = runBashFixture(step.run, { cwd: candidate, env: { ...releaseEnv, GITHUB_OUTPUT: outputs,
      PREPARED_NPM_LIFECYCLE: policy.npm_lifecycle, PREPARED_NPM_LIFECYCLE_CONFIGURED: policy.npm_lifecycle_configured }, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  }
  const rewritten = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { version: string; scripts: Record<string, string> };
  assert.equal(rewritten.version, releaseEnv.NPM_VERSION);
  assert.match(rewritten.scripts["changelog:full"]!, /--date-fallback 2026-11-17/);
  const versionDay = rewritten.version.split(".").map(part => part.padStart(2, "0")).join("-");
  assert.notEqual(versionDay, releaseEnv.RELEASE_HEADING_DATE);
  assert.equal(execFileSync("git", ["tag", "--list", rewritten.version, "v" + rewritten.version], { cwd: candidate, env, encoding: "utf8" }), "");
  const heading = `## ${rewritten.version} - ${releaseEnv.RELEASE_HEADING_DATE}`;
  for (const rendered of [join(candidate, "CHANGELOG.md"), join(root, "RELEASE_NOTES.md")]) {
    const lines = readFileSync(rendered, "utf8").split("\n");
    assert.ok(lines.includes(heading), `${heading} must be rendered`);
    assert.ok(!lines.includes(`## ${rewritten.version} - ${versionDay}`));
  }
  execFileSync("npm", ["run", "release:check"], { cwd: candidate, env: releaseEnv, stdio: "inherit" });
  console.log("rewritten release:check (including coverage): PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}

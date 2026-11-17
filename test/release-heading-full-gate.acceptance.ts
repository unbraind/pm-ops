/** Run the real release gate after the workflow rewrites a disposable candidate's date policy.
 * Kept outside the unit-test glob because release:check itself runs that suite. */
import assert from "node:assert/strict";
import { execFileSync } from "../subprocess.ts";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { runBashFixture } from "./bash-fixture.ts";

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
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: source, env, encoding: "utf8" }).split("\0").filter(Boolean);
  files.push("test/release-heading-full-gate.acceptance.ts");
  for (const file of files) {
    mkdirSync(dirname(join(candidate, file)), { recursive: true });
    copyFileSync(join(source, file), join(candidate, file));
  }
  symlinkSync(resolve(source, "node_modules"), join(candidate, "node_modules"), "junction");
  const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(manifest.scripts["release:check"]!, /npm run coverage/);
  const definition = parse(readFileSync(join(candidate, ".github/workflows/daily-release.yml"), "utf8"));
  const generation = definition.jobs.prepare.steps.find((step: { name?: string }) => step.name === "Generate changelog and release notes");
  const releaseEnv = {
    ...env, IS_RUST: "false", CHANGELOG_SCRIPT: "changelog:full", CHANGELOG_CHECK_SCRIPT: "changelog:check",
    NOTES_SCRIPT: "release:notes", RELEASE_HEADING_DATE: "2026-11-17", RUNNER_TEMP: root,
    GITHUB_STEP_SUMMARY: join(root, "summary.md"),
  };
  const prepared = runBashFixture(generation.run, { cwd: candidate, env: releaseEnv, encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const rewritten = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(rewritten.scripts["changelog:full"]!, /--date-fallback 2026-11-17/);
  execFileSync("npm", ["run", "release:check"], { cwd: candidate, env: releaseEnv, stdio: "inherit" });
  console.log("rewritten release:check (including coverage): PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}

/** Run the real release gate after the workflow rewrites a disposable candidate's date policy.
 * Kept outside the unit-test glob because release:check itself runs that suite. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "../subprocess.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { runBashFixture, stepOutputs } from "./bash-fixture.ts";
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
const cancellation = new AbortController();
const interrupt = () => cancellation.abort(130);
const terminate = () => cancellation.abort(143);
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);

/** Let the parent handle cancellation while a child owns files in the candidate. */
async function runGateCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  cancellation.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, { cwd, env, detached, stdio: "inherit" });
    /** Stop npm and its descendants together before removing their checkout. */
    function stopChild(): void {
      if (!detached || child.pid === undefined) {
        child.kill();
        return;
      }
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill();
      }
    }
    cancellation.signal.addEventListener("abort", stopChild, { once: true });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      cancellation.signal.removeEventListener("abort", stopChild);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
  cancellation.signal.throwIfAborted();
}

try {
  await runGateCommand("git", ["clone", "--quiet", "--shared", source, candidate], source, env);
  const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: source, env, encoding: "utf8" }).trim();
  execFileSync("git", ["remote", "set-url", "origin", origin], { cwd: candidate, env });
  // Include the current, reviewable source and tracker edits rather than testing
  // only the last commit. Generated output is rebuilt by the gate.
  mirrorTrackedSnapshot(source, candidate, env);
  await runGateCommand("npm", ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], candidate, env);
  await runGateCommand("npm", ["run", "changelog:check"], candidate, env);
  const manifest = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(manifest.scripts["release:check"]!, /npm run coverage/);
  const definition = parse(readFileSync(join(candidate, ".github/workflows/daily-release.yml"), "utf8"));
  // The extension suite expects a 2026 coordinate. Keep the candidate
  // untagged even when the cloned repository already has this release day.
  const fixtureVersion = "2026.12.31";
  const tags = new Set(execFileSync("git", ["tag", "--list"], { cwd: candidate, env, encoding: "utf8" })
    .split(/\r?\n/).map(tag => tag.replace(/^v/i, "")));
  let version = fixtureVersion;
  for (let suffix = 1; tags.has(version); suffix++) version = `${fixtureVersion}-${suffix}`;
  const releaseEnv = {
    ...env, IS_RUST: "false", CHANGELOG_SCRIPT: "changelog:full", CHANGELOG_CHECK_SCRIPT: "changelog:check",
    NOTES_SCRIPT: "release:notes", RELEASE_HEADING_DATE: "2026-11-17", RUNNER_TEMP: root,
    GITHUB_STEP_SUMMARY: join(root, "summary.md"), CONTINUATION_SCRIPT: join(candidate, "scripts/release-continuation.ts"),
    NPM_VERSION: version, VERSION_POLICY: "daily", PREPARE_SCRIPT: "", BUILD_SCRIPT: "", PM_OPS_MODULE: join(candidate, "dist/daily-release.js"),
  };
  const outputs = join(root, "prepare.out");
  for (const name of ["Update release version", "Prepare npm changelog hooks", "Generate changelog and release notes"]) {
    const step = definition.jobs.prepare.steps.find((entry: { name?: string }) => entry.name === name);
    const policy = name === "Generate changelog and release notes"
      ? stepOutputs(readFileSync(outputs, "utf8")) : {};
    const prepared = runBashFixture(step.run, { cwd: candidate, env: { ...releaseEnv, GITHUB_OUTPUT: outputs,
      PREPARED_NPM_LIFECYCLE: policy.npm_lifecycle, PREPARED_NPM_LIFECYCLE_CONFIGURED: policy.npm_lifecycle_configured }, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  }
  const rewritten = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { version: string; scripts: Record<string, string> };
  assert.equal(rewritten.version, releaseEnv.NPM_VERSION);
  assert.match(rewritten.scripts["changelog:full"]!, /--date-fallback 2026-11-17/);
  const versionDay = fixtureVersion.replaceAll(".", "-");
  assert.notEqual(versionDay, releaseEnv.RELEASE_HEADING_DATE);
  assert.equal(execFileSync("git", ["tag", "--list", rewritten.version, "v" + rewritten.version], { cwd: candidate, env, encoding: "utf8" }), "");
  const heading = `## ${rewritten.version} - ${releaseEnv.RELEASE_HEADING_DATE}`;
  for (const rendered of [join(candidate, "CHANGELOG.md"), join(root, "RELEASE_NOTES.md")]) {
    const lines = readFileSync(rendered, "utf8").split("\n");
    assert.ok(lines.includes(heading), `${heading} must be rendered`);
    assert.ok(!lines.includes(`## ${rewritten.version} - ${versionDay}`));
  }
  await runGateCommand("npm", ["run", "release:check"], candidate, releaseEnv);
  console.log("rewritten release:check (including coverage): PASS");
} catch (error) {
  if (!cancellation.signal.aborted) throw error;
  process.exitCode = cancellation.signal.reason;
} finally {
  rmSync(root, { recursive: true, force: true });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
}

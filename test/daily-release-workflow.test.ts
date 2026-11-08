/** Parse the executable workflow and assert its privilege and publication wiring. */
import { runBashFixture } from "./bash-fixture.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "../subprocess.ts";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { auditPublishAttestation } from "../attestation.ts";
import { assertNoNpmInstalls, assertPinnedNpmBootstrap } from "./npm-bootstrap-contract.ts";
import { requiredFixtureCases } from "./fixture-contracts.ts";

/** Workflow step fields used by the structural and shell regression tests. */
interface Step {
  /** Human-readable identity, optional for anonymous action steps. */
  name?: string;
  /** Whether failure is tolerated to preserve independent failure reporting. */
  "continue-on-error"?: boolean;
  /** Identifier whose outputs guard dependent effects. */
  id?: string;
  /** Immutable action reference. */
  uses?: string;
  /** Shell source, executed by tests only with isolated external boundaries. */
  run?: string;
  /** Conditional execution guard. */
  if?: string;
  /** Data passed without shell interpolation. */
  env?: Record<string, string>;
}

const source = readFileSync(new URL("../.github/workflows/daily-release.yml", import.meta.url), "utf8");
const workflow = parse(source) as {
  on: { workflow_call: { inputs: Record<string, { type: string; default: unknown }> } };
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean; queue: string };
  jobs: Record<string, { if: string; needs: string[]; env: Record<string, string>; permissions: Record<string, string>; steps: Step[] }>;
};
const ci = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")) as { jobs: Record<string, { strategy: { matrix: { "node-version": (string | number)[] } }; steps: Step[] }> };
const steps = Object.values(workflow.jobs).flatMap(job => job.steps);

/** Read a required executable step, failing if it was removed or renamed. */
function step(name: string): Step & { run: string } {
  const result = steps.find(s => s.name === name);
  assert.ok(result?.run, `missing executable step: ${name}`);
  return result as Step & { run: string };
}

/** Store a synthetic registry envelope without duplicating its transport encoding in shell fixtures. */
function writeProvenance(root: string, filename: string, statement: unknown): void {
  const payload = Buffer.from(JSON.stringify(statement)).toString("base64");
  writeFileSync(join(root, filename), JSON.stringify({ attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload } } }] }));
}

test("shared workflow grants permissions per job, pins actions, and gates every privileged run", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.release.permissions, { contents: "write", "pull-requests": "write", actions: "read", checks: "read", issues: "read", "id-token": "write" });
  assert.deepEqual(workflow.jobs.prepare.permissions, { contents: "read", "pull-requests": "read" });
  assert.deepEqual(workflow.jobs.alert.permissions, { contents: "read", issues: "write" });
  assert.match(workflow.jobs.release.if, /inputs.release-enabled && github.ref == 'refs\/heads\/main'/);
  assert.equal(workflow.concurrency.group, "daily-release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.concurrency.queue, "max");
  for (const job of Object.values(workflow.jobs)) for (const current of job.steps) {
    if (current.uses) assert.match(current.uses, /@[a-f0-9]{40}$/);
    if (current.run) {
      assert.doesNotMatch(current.run, /\$\{\{/);
      const syntax = spawnSync("bash", ["-n"], { input: current.run, encoding: "utf8" });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  }
  assert.doesNotMatch(source.replace(/^\s*#.*$/gm, ""), /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM/);
  assert.equal(step("Resolve pm-ops release version").env?.WORKFLOW_SHA, "${{ job.workflow_sha }}");
  assert.match(step("Resolve pm-ops release version").run, /peeled_commits/);
  assert.match(step("Resolve pm-ops release version").run, /Multiple release versions/);
  assert.match(step("Install pinned release tools").run, /node "\$CONTINUATION_SCRIPT" tools/);
});

test("planning calls the measured TypeScript module and keeps PR payloads in files", () => {
  const plan = step("Decide release");
  assert.match(plan.run, /--limit 1000/);
  assert.match(plan.run, /> "\$release_prs_file"/);
  assert.match(plan.run, /readFileSync\(process.argv\[2\]/);
  assert.match(plan.run, /decideDailyRelease\(/);
  assert.match(plan.run, /prs.length >= 1000/);
  assert.match(plan.run, /RELEASE_CURRENT_PACKAGE_VERSION=.*npm pkg get version/);
  assert.match(plan.run, /currentPackageVersion: e.RELEASE_CURRENT_PACKAGE_VERSION/);
  assert.doesNotMatch(plan.run, /export .*PRS|RELEASE_PRS=/);
  assert.equal(step("Merge release metadata through protected PR").env?.RELEASE_BASE_SHA, "${{ needs.prepare.outputs.base_sha }}");
  const merge = step("Merge release metadata through protected PR").run;
  assert.match(merge, /--force-with-lease="refs\/heads\/\$\{release_branch\}:\$\{remote_branch_sha\}"/);
  assert.ok(merge.indexOf('release_commit="$(git rev-parse HEAD)"') < merge.indexOf('remote_branch_sha='));
});

test("caller template and migration examples cover the union of every nested job permission", () => {
  const template = readFileSync(new URL("../templates/release-caller.yml", import.meta.url), "utf8");
  const docs = readFileSync(new URL("../docs/reusable-release.md", import.meta.url), "utf8");
  const callers = [template, ...Array.from(docs.matchAll(/```yaml\n([\s\S]*?)```/g), match => match[1])];
  assert.equal(callers.length, 3);
  const rank: Record<string, number> = { none: 0, read: 1, write: 2 };
  for (const caller of callers) {
    const granted = (parse(caller) as { jobs: { release: { permissions: Record<string, string> } } }).jobs.release.permissions;
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const [scope, level] of Object.entries(job.permissions)) {
        assert.ok(rank[granted[scope] ?? "none"] >= rank[level], `${name} requests ${scope}: ${level}`);
      }
    }
  }
});

test("publication continues only when trigger, merged main, package version, provenance and tag agree", () => {
  assert.match(step("Revalidate trusted merged candidate").run, /node "\$CONTINUATION_SCRIPT" verify/);
  for (const name of ["Publish npm package", "Publish extra targets", "Push release tag"]) assert.match(step(name).if!, /steps.continue.outputs.action != 'complete'/);
  assert.equal(workflow.jobs.release.env.TRIGGER_SHA, "${{ github.sha }}");
  assert.deepEqual(workflow.jobs.verify_bun.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.recover.permissions, { contents: "write", actions: "read" });
  assert.match(workflow.jobs.verify_bun.if, /needs.release.outputs.published == 'success'/);
  assert.match(workflow.jobs.verify_bun.if, /inputs.npm-publish && inputs.bun-verify/);
  assert.equal(step("Pack verified release").env?.BUN_VERIFY, "${{ inputs.npm-publish && inputs.bun-verify }}");
  assert.match(step("Verify bun install of published package").run, /bunx --bun --no-install pm health --strict-exit/);
  assert.match(step("Publish npm package").run, /npm publish \.\/release-artifact\/package\.tgz --access public --provenance --ignore-scripts/);
  assert.match(step("Publish npm package").run, /node "\$PROVENANCE_SCRIPT"/);
  assert.match(step("Pack verified release").run, /git diff --exit-code -- \./);
  assert.match(step("Pack verified release").run, /git status --porcelain=v1 --untracked-files=all/);
  assert.match(step("Publish npm package").run, /EXPECTED_COMMIT="\$\(git rev-parse HEAD\)"/);
  assert.match(step("Push release tag").run, /git rev-parse HEAD/);
  assert.match(step("Create GitHub release").if!, /!cancelled\(\).*steps.push_tag.outcome == 'success'/);
  assert.doesNotMatch(step("Create GitHub release").if!, /verify_bun/);
  assert.match(step("Fail the job on bun verification failure").if!, /verify_bun.outcome == 'failure'/);
  assert.ok(steps.indexOf(step("Publish npm package")) < steps.indexOf(step("Push release tag")));
  assert.ok(steps.indexOf(step("Verify merged release")) < steps.indexOf(step("Publish npm package")));
});

test("superseded cleanup delegates to authoritative ownership checks and merged branch deletion retains its lease", () => {
  assert.match(step("Close superseded release PRs").run, /node "\$CONTINUATION_SCRIPT" supersede/);
  assert.match(step("Clean up merged release branch").run, /--force-with-lease=.*expected_sha/);
  assert.equal(step("Clean up merged release branch").env?.EXPECTED_HEAD, "${{ needs.reconcile.outputs.headSha }}");
});

test("release approval reads waiting CI once at the prepared head without a timeout diagnosis", () => {
  const approve = step("Approve currently waiting release CI once").run;
  assert.equal(approve.trim(), 'set -euo pipefail\nnode "$CONTINUATION_SCRIPT" approve');
  assert.equal(step("Approve currently waiting release CI once").env?.RELEASE_PR_NUMBER, "${{ steps.probe.outputs.pr_number }}");
  assert.doesNotMatch(approve, /sleep|deadline|30 minutes/);
  assert.doesNotMatch(step("Merge release metadata through protected PR").run, /sleep|deadline|awaiting_approval/);
});

test("actual publication dates cap daily resumption as well as reviewed package versions", () => {
  const root = mkdtempSync(join(tmpdir(), "release-date-cap-"));
  try {
    for (const [name, output] of [["npm", '"2026.10.17"'], ["gh", "2026-10-20T01:00:00Z"]]) {
      writeFileSync(join(root, name), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
      chmodSync(join(root, name), 0o755);
    }
    const plan = step("Decide release").run;
    const dates = plan.slice(plan.indexOf('export RELEASE_PACKAGE_VERSION=""'), plan.indexOf('if [[ -n "$latest_tag" ]]'));
    for (const policy of ["daily", "package"]) {
      const result = runBashFixture(dates + '\nprintf "%s" "$RELEASE_PUBLISHED_TODAY"', {
        encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, RUNNER_TEMP: root, NPM_PROJECT_PATH: root,
          GITHUB_REPOSITORY: "example/package", IS_RUST: "false", VERSION_POLICY: policy, RELEASE_TODAY: "2026.10.20", RELEASE_TIMEZONE: "Europe/Vienna" },
      }, ["-e", "-o", "pipefail"]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "true", policy);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("completeness audit follows release and recovery even on no-change days and exposes failures to alerting", () => {
  const audit = workflow.jobs.audit;
  assert.deepEqual(audit.needs, ["prepare", "release", "recover", "verify_bun", "reconcile", "request"]);
  assert.match(audit.if, /^!cancelled\(\)/);
  assert.doesNotMatch(audit.if, /should_release|success\(\)|outcome/);
  assert.ok(workflow.jobs.alert.needs.includes("audit"));
  assert.deepEqual(audit.permissions, { contents: "write" });
  const run = step("Audit release completeness");
  assert.equal(run.env?.GH_TOKEN, "${{ github.token }}");
  assert.equal(run.env?.AUDIT_SCRIPT, "${{ inputs.audit-script }}");
  assert.match(run.run, /npm run "\$AUDIT_SCRIPT"/);
  assert.doesNotMatch(step("Run release checks").run, /AUDIT_SCRIPT/);
});

test("publish retries bind the local artifact and poll delayed attestations through the final read without republishing success", () => {
  const root = mkdtempSync(join(tmpdir(), "release-publish-poll-"));
  try {
    mkdirSync(join(root, "release-artifact"));
    writeFileSync(join(root, "provenance-boundary.ts"), "process.stdin.resume();\n");
    writeFileSync(join(root, "attempt.ts"), "// Synthetic publication-attempt journal boundary.\n");
    const artifact = Buffer.from("synthetic verified artifact");
    writeFileSync(join(root, "release-artifact/package.tgz"), artifact);
    writeFileSync(join(root, "package.json"), '{"name":"synthetic-package"}\n');
    const digest = createHash("sha512").update(artifact).digest();
    const integrity = `sha512-${digest.toString("base64")}`;
    const commit = "a".repeat(40);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const binaries = {
      git: `#!/bin/sh\nprintf '%s' '${commit}'\n`,
      curl: '#!/bin/sh\ncat "$RUNNER_TEMP/provenance.json"\n',
      sleep: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RUNNER_TEMP/sleeps"\n',
      npm: `#!/bin/sh
case "$1" in
  config) exit 0 ;;
  --version) echo 11.19.0 ;;
  publish) echo publish >> "$RUNNER_TEMP/publishes"; exit "$PUBLISH_STATUS" ;;
  view)
    case "$3" in
      version) exit 0 ;;
      dist)
        count=$(cat "$RUNNER_TEMP/reads"); count=$((count + 1)); echo "$count" > "$RUNNER_TEMP/reads"
        [ "$METADATA_MODE" != unavailable ] || exit 1
        [ "$count" -ge "$VISIBLE_READ" ] || exit 1
        echo "$REGISTRY_METADATA" ;;
    esac ;;
esac
`,
    };
    for (const [name, body] of Object.entries(binaries)) { writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755); }
    const fixtures = [
      { mode: "visible", integrity, visible: 1, publish: 0, status: 0, reads: 1, publishes: 0, sleeps: 0 },
      { mode: "visible", integrity, visible: 22, publish: 0, status: 0, reads: 22, publishes: 1, sleeps: 20 },
      { mode: "visible", integrity, visible: 25, publish: 1, status: 0, reads: 25, publishes: 3, sleeps: 22 },
      { mode: "visible", integrity: `sha512-${createHash("sha512").update("different artifact").digest("base64")}`, visible: 1, publish: 1, status: 1, reads: 26, publishes: 3, sleeps: 22 },
      { mode: "unavailable", integrity, visible: 1, publish: 1, status: 1, reads: 26, publishes: 3, sleeps: 22 },
    ];
    for (const fixture of fixtures) {
      const registryDigest = Buffer.from(fixture.integrity.slice(7), "base64").toString("hex");
      const statement = { subject: [{ digest: { sha512: registryDigest } }], predicate: { buildDefinition: { resolvedDependencies: [{ digest: { gitCommit: commit } }] } } };
      writeProvenance(root, "provenance.json", statement);
      for (const file of ["publishes", "sleeps"]) writeFileSync(join(root, file), "");
      writeFileSync(join(root, "reads"), "0");
      const result = runBashFixture(step("Publish npm package").run, { cwd: root, encoding: "utf8", env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root, HOME: root, CONTINUATION_SCRIPT: join(root, "attempt.ts"), NPM_CONFIG_USERCONFIG: join(root, "absent-config"),
        NPM_VERSION: "2026.10.20", REGISTRY_METADATA: JSON.stringify({ integrity: fixture.integrity, attestations: { url: "https://registry.npmjs.org/synthetic" } }), METADATA_MODE: fixture.mode,
        VISIBLE_READ: String(fixture.visible), PUBLISH_STATUS: String(fixture.publish), PROVENANCE_SCRIPT: join(root, "provenance-boundary.ts"), PM_OPS_MODULE: new URL("../dist/daily-release.js", import.meta.url).pathname,
      } });
      assert.equal(result.status, fixture.status, result.stdout + result.stderr);
      assert.equal(Number(readFileSync(join(root, "reads"), "utf8")), fixture.reads);
      for (const [file, count] of [["publishes", fixture.publishes], ["sleeps", fixture.sleeps]] as const) {
        assert.equal(readFileSync(join(root, file), "utf8").trim().split("\n").filter(Boolean).length, count);
      }
      if (fixture.mode === "unavailable") assert.match(result.stdout, /registry read failure, NOT proof/);
      if (fixture.integrity !== integrity) assert.match(result.stdout, /without matching commit and artifact provenance/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every declared package input is typed and wired into executable jobs", () => {
  const jobSource = source.slice(source.indexOf("jobs:"));
  for (const [name, input] of Object.entries(workflow.on.workflow_call.inputs)) {
    assert.ok(["string", "boolean"].includes(input.type));
    assert.equal(typeof input.default, input.type);
    assert.ok(jobSource.includes(`inputs.${name}`), `unwired input ${name}`);
  }
  for (const hook of ["PREPARE_SCRIPT", "VERIFY_SCRIPT", "PUBLISH_SCRIPT", "BUNX_SCRIPT"]) assert.ok(steps.some(s => s.run?.includes(`$${hook}`)), hook);
  assert.match(step("Run release checks").run, /npm run "\$VERIFY_SCRIPT"/);
  assert.match(step("Run release checks").run, /verifyBunScript\(process.env.VERIFY_SCRIPT\)/);
});

test("workflow version resolution peels annotated tags, normalizes dates and rejects ambiguity or missing releases", () => {
  const root = mkdtempSync(join(tmpdir(), "release-version-"));
  try {
    const sha = "a".repeat(40), tagObject = "b".repeat(40), other = "c".repeat(40);
    const remote = join(root, "tags");
    const output = join(root, "output");
    const git = join(root, "git");
    writeFileSync(git, "#!/bin/sh\n[ \"$*\" = \"ls-remote --tags https://github.com/unbraind/pm-ops refs/tags/v*\" ] || exit 9\ncat \"$TAG_FIXTURE\"\n");
    chmodSync(git, 0o755);
    const cases = [
      { tags: `${sha}\trefs/tags/v2026.10.19\n`, expected: "2026.10.19" },
      { tags: `${tagObject}\trefs/tags/v2026.08.09\n${sha}\trefs/tags/v2026.08.09^{}\n`, expected: "2026.8.9" },
      { tags: `${sha}\trefs/tags/v2026.08.09\n${sha}\trefs/tags/v2026.8.9\n`, expected: "2026.8.9" },
      { tags: `${sha}\trefs/tags/v2026.08.09-2\n`, expected: "2026.8.9-2" },
      { tags: `${sha}\trefs/tags/v2026.10.19\n${sha}\trefs/tags/v2026.10.18\n`, expected: "" },
      { tags: `${sha}\trefs/tags/v2026.10.19\n${other}\trefs/tags/v2026.10.19^{}\n`, expected: "" },
      { tags: `${sha}\trefs/tags/payload\nmalformed\trefs/tags/v2026.10.19\n`, expected: "" },
      { tags: "", expected: "" },
      // A fork-like fixture has a valid release tag, but the canonical remote names another commit.
      { tags: `${other}\trefs/tags/v2026.10.19\n`, expected: "" },
    ];
    for (const fixture of cases) {
      writeFileSync(remote, fixture.tags);
      writeFileSync(output, "");
      const result = runBashFixture(step("Resolve pm-ops release version").run, { encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: "example/package", PATH: `${root}:${process.env.PATH}`, TAG_FIXTURE: remote, WORKFLOW_SHA: sha, GITHUB_ENV: output, GITHUB_OUTPUT: join(root, "step-output") } });
      if (fixture.expected) {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(readFileSync(output, "utf8"), `PM_OPS_VERSION=${fixture.expected}\n`);
      } else assert.notEqual(result.status, 0, fixture.tags);
    }
    // The self-pilot must release the first workflow version without a circular tag prerequisite.
    const curl = join(root, "curl");
    writeFileSync(curl, '#!/bin/sh\ncase "$*" in\n*"raw.githubusercontent.com/unbraind/pm-ops/$WORKFLOW_SHA/package.json") echo \'{"version":"2026.11.5"}\' ;;\n*) exit 9 ;;\nesac\n');
    chmodSync(curl, 0o755);
    writeFileSync(remote, ""); writeFileSync(output, "");
    const self = runBashFixture(step("Resolve pm-ops release version").run, { encoding: "utf8", env: { ...process.env,
      PATH: `${root}:${process.env.PATH}`, GITHUB_REPOSITORY: "unbraind/pm-ops", TAG_FIXTURE: remote, WORKFLOW_SHA: sha,
      GITHUB_ENV: output, GITHUB_OUTPUT: join(root, "step-output"),
    } });
    assert.equal(self.status, 0, self.stdout + self.stderr);
    assert.equal(readFileSync(output, "utf8"), "PM_OPS_VERSION=2026.11.5\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("the shared workflow satisfies the canonical attestation auditor without exclusions", () => {
  assert.deepEqual(auditPublishAttestation([{ file: ".github/workflows/daily-release.yml", text: source }]).failures, []);
});


test("release staging commits first-time outputs, declared release files and deletions in root and nested projects", () => {
  for (const directory of [".", "packages/example package"]) {
    const root = mkdtempSync(join(tmpdir(), "release-staging-"));
    try {
      const project = join(root, directory);
      mkdirSync(join(project, "src"), { recursive: true });
      writeFileSync(join(project, "package.json"), '{"name":"example","version":"1.0.0"}\n');
      writeFileSync(join(project, "src/old.ts"), "export const old = true;\n");
      writeFileSync(join(root, ".gitignore"), "cache/\n");
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["add", "--", "."], { cwd: root });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial"], { cwd: root });
      const initial = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      writeFileSync(join(project, "CHANGELOG.md"), "First changelog\n");
      writeFileSync(join(project, "src/generated output.ts"), "export const generated = true;\n");
      rmSync(join(project, "src/old.ts"));
      writeFileSync(join(root, "release-manifest.json"), '{"release":true}\n');
      mkdirSync(join(project, "cache"));
      writeFileSync(join(project, "cache/ignored"), "cache\n");
      const bin = join(root, "cache/bin"); mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "just"), '#!/bin/sh\n[ "$1" = release-check ] && [ -f "$GITHUB_WORKSPACE/.github/pm-release-candidate.json" ]\n'); chmodSync(join(bin, "just"), 0o755);
      const transaction = "set -euo pipefail\n" + requiredFixtureCases(workflow.jobs.prepare.steps, ["Record preparation stamp", "Run release checks", "Commit release files"], current => current.name ?? "").map(current => current.run).join("\n");
      const stageEnv = { ...process.env, GITHUB_WORKSPACE: root, NPM_PROJECT_PATH: project, NPM_PROJECT_DIR: directory, RELEASE_FILES: "release-manifest.json", REPO_NAME: "example", RELEASE_TAG: "v2099.1.1", CONTINUATION_SCRIPT: new URL("../scripts/release-continuation.ts", import.meta.url).pathname, RELEASE_CONFIG: "{}", CALLER_WORKFLOW: "example/package/.github/workflows/release.yml@refs/heads/main", GITHUB_REPOSITORY: "example/package", RELEASE_BASE_SHA: initial, NPM_VERSION: "2099.1.1", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1", RUNNER_TEMP: root, IS_RUST: "true", PATH: `${bin}:${process.env.PATH}` };
      const result = runBashFixture(transaction, { cwd: root, encoding: "utf8", env: stageEnv });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const prefix = directory === "." ? "" : directory + "/";
      const changed = execFileSync("git", ["diff", "--name-only", "-z", initial, "HEAD"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).sort();
      assert.deepEqual(changed, [".github/pm-release-candidate.json", prefix + "CHANGELOG.md", prefix + "src/generated output.ts", prefix + "src/old.ts", "release-manifest.json"].sort());
      assert.equal(execFileSync("git", ["show", `HEAD:${prefix}CHANGELOG.md`], { cwd: root, encoding: "utf8" }), "First changelog\n");
      assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }), "");
      const previous = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      const resumed = runBashFixture(transaction, { cwd: root, encoding: "utf8", env: { ...stageEnv, GITHUB_RUN_ID: "2", RELEASE_BASE_SHA: previous } });
      assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
      assert.equal(execFileSync("git", ["diff", "--name-only", previous, "HEAD"], { cwd: root, encoding: "utf8" }).trim(), ".github/pm-release-candidate.json");

    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("pack guard refuses leftover untracked outputs anywhere in the package before creating a tarball", () => {
  const root = mkdtempSync(join(tmpdir(), "release-pack-guard-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "package.json"), '{"name":"example"}\n');
    execFileSync("git", ["add", "package.json"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial"], { cwd: root });
    const guard = step("Pack verified release").run.split('handoff=')[0];
    /** Run exactly the workflow pre-pack guards without any pack/publication effects. */
    const check = () => runBashFixture(guard, { cwd: root, encoding: "utf8", env: { ...process.env, NPM_PROJECT_PATH: root } });
    assert.equal(check().status, 0);
    for (const path of ["CHANGELOG.md", "generated-metadata.json"]) {
      writeFileSync(join(root, path), "new output\n");
      assert.notEqual(check().status, 0, path);
      rmSync(join(root, path));
    }
    assert.equal(check().status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pack validates CLI pins only when npm publication and Bun verification are both enabled", () => {
  const cases = [
    ...[
      { caller: "2026.10.15", fallback: "^2026.8.20", expected: "2026.10.15" },
      { caller: "2026.10.15-2", fallback: "2026.10.14", expected: "2026.10.15-2" },
      { caller: undefined, fallback: "2026.10.15", expected: "2026.10.15" },
      { caller: undefined, fallback: "2026.10.15-2", expected: "2026.10.15-2" },
      ...["^2026.8.20", "~2026.10.15", ">=2026.8.20", "*", "latest", "workspace:*", "2026.10.15-beta", "2026.10.15\nforged=value"].map(caller => ({ caller, fallback: "2026.10.15", expected: undefined })),
      { caller: undefined, fallback: "^2026.8.20", expected: undefined },
      { caller: undefined, fallback: undefined, expected: undefined },
    ].map(fixture => ({ ...fixture, npmPublish: true, bunVerify: true })),
    ...[
      { npmPublish: true, bunVerify: false },
      { npmPublish: false, bunVerify: true },
      { npmPublish: false, bunVerify: false },
    ].flatMap(flags => [
      { ...flags, caller: "^2026.8.20", fallback: "2026.10.15", expected: "" },
      { ...flags, caller: undefined, fallback: "^2026.8.20", expected: "" },
      { ...flags, caller: undefined, fallback: undefined, expected: "" },
    ]),
  ];
  for (const [index, fixture] of cases.entries()) {
    const root = mkdtempSync(join(tmpdir(), "release-cli-pin-"));
    try {
      const repo = join(root, "repo"), runner = join(root, "runner"), tools = join(root, "tools' directory");
      const directory = index % 2 === 0 ? "." : "packages/example";
      const project = join(repo, directory);
      mkdirSync(project, { recursive: true });
      mkdirSync(runner);
      mkdirSync(join(tools, "node_modules/pm-ops"), { recursive: true });
      writeFileSync(join(project, "package.json"), JSON.stringify({ name: "release-cli-fixture", version: "1.0.0", devDependencies: { "@unbrained/pm-cli": fixture.caller } }));
      if (fixture.fallback !== undefined || fixture.bunVerify && fixture.npmPublish) {
        writeFileSync(join(tools, "node_modules/pm-ops/package.json"), JSON.stringify({ devDependencies: { "@unbrained/pm-cli": fixture.fallback } }));
      }
      writeFileSync(join(runner, "RELEASE_NOTES.md"), "Synthetic release notes\n");
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["add", join(directory, "package.json")], { cwd: repo });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial"], { cwd: repo });
      const output = join(root, "output");
      writeFileSync(output, "");
      const result = runBashFixture(step("Pack verified release").run, {
        cwd: repo, encoding: "utf8", env: { ...process.env, GITHUB_WORKSPACE: repo, NPM_PROJECT_PATH: project, PM_OPS_TOOLS: tools, RUNNER_TEMP: runner, GITHUB_OUTPUT: output, IS_RUST: "false", BUN_VERIFY: String(fixture.npmPublish && fixture.bunVerify) },
      });
      const outputs = readFileSync(output, "utf8");
      if (fixture.expected !== undefined) {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.ok(outputs.split("\n").includes(`cli_version=${fixture.expected}`));
        assert.match(outputs, /^package_sha256=[a-f0-9]{64}$/m);
        const handoff = outputs.split("\n").find(line => line.startsWith("handoff="))!.slice("handoff=".length);
        assert.ok(readFileSync(join(handoff, "metadata.bundle")).length > 0);
        assert.ok(readFileSync(join(handoff, "package.tgz")).length > 0);
      } else {
        assert.notEqual(result.status, 0, JSON.stringify(fixture));
        assert.match(result.stdout + result.stderr, /::error::@unbrained\/pm-cli must be pinned to an exact version/);
        assert.doesNotMatch(outputs, /^(cli_version|commit|handoff)=/m);
        assert.equal(existsSync(join(runner, "pack.json")), false);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});


test("recovery queries the exact npm coordinate while preserving the original GitHub tag", () => {
  assert.equal(step("Repair missing GitHub Release").env?.PROVENANCE_RECOVERY, "true");
  const root = mkdtempSync(join(tmpdir(), "release-recovery-coordinate-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "recovery-fixture", version: "2026.10.18-1" }));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "package.json"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial"], { cwd: root });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const statement = { subject: [{ digest: { sha512: "abcd" } }], predicate: { buildDefinition: { resolvedDependencies: [{ digest: { gitCommit: commit } }] } } };
    writeProvenance(root, "attestation.json", statement);
    writeFileSync(join(root, "provenance-boundary.ts"), "if(process.env.PROVENANCE_RECOVERY!=='true')process.exitCode=1;process.stdin.resume();\n");
    const tools = {
      gh: `#!/bin/sh\nprintf '%s\\n' "$*" >> "$RUNNER_TEMP/gh-calls"\n[ "$2" != view ]\n`,
      npm: `#!/bin/sh\nprintf '%s\\n' "$*" >> "$RUNNER_TEMP/npm-calls"\nprintf '%s\\n' '{"integrity":"sha512-q80=","attestations":{"url":"https://registry.npmjs.org/synthetic"}}'\n`,
      curl: '#!/bin/sh\ncat "$RUNNER_TEMP/attestation.json"\n',
    };
    for (const [tool, body] of Object.entries(tools)) {
      writeFileSync(join(bin, tool), body);
      chmodSync(join(bin, tool), 0o755);
    }
    for (const [tag, version] of [["v2026.10.18-1", "2026.10.18-1"], ["v2026.08.09-2", "2026.8.9-2"], ["v2026.08.09", "2026.8.9"]]) {
      writeFileSync(join(root, "npm-calls"), "");
      writeFileSync(join(root, "gh-calls"), "");
      const result = runBashFixture(step("Repair missing GitHub Release").run, {
        cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root,
          PROVENANCE_SCRIPT: join(root, "provenance-boundary.ts"), EXPECTED_COMMIT: commit, RECOVERY_TAG: tag, NPM_PUBLISH: "true", GITHUB_REPOSITORY: "example/package",
          PROVENANCE_RECOVERY: String(step("Repair missing GitHub Release").env?.PROVENANCE_RECOVERY),
          PM_OPS_MODULE: new URL("../dist/daily-release.js", import.meta.url).pathname },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(readFileSync(join(root, "npm-calls"), "utf8"), `view recovery-fixture@${version} dist --prefer-online --json\n`);
      const calls = readFileSync(join(root, "gh-calls"), "utf8").trim().split("\n");
      assert.equal(calls.length, 2);
      assert.match(calls[1], new RegExp(`^release create ${tag} --repo `));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});



test("completed release recovery executes the journaled hook before retiring intent", () => {
  assert.match(step("Post release hook").if!, /^success\(\)/);
  assert.match(step("Post release hook").if!, /steps.continue.outputs.action == 'complete'/);
  assert.match(step("Post release hook").run!, /node "\$CONTINUATION_SCRIPT" post-hook/);
  assert.match(step("Complete durable release intent").if!, /steps.post_hook.outcome == 'success'/);
  assert.match(step("Install optional hook dependencies").if!, /\|\| inputs.post-release-script != ''/);
});

test("OIDC migration guidance scopes trusted publisher requirements to npm callers", () => {
  const docs = readFileSync(new URL("../docs/reusable-release.md", import.meta.url), "utf8");
  assert.match(docs, /checks npm OIDC identity before mutating a branch when \x60npm-publish: true\x60/);
  assert.match(docs, /For \x60npm-publish: true\x60, configure npm trusted publishing/);
  assert.match(docs, /GitHub-only callers need no npm trusted publisher/);
});

test("migration gap tracker never marks an inventoried package as unreadable", () => {
  const root = mkdtempSync(join(tmpdir(), "release-inventory-consistency-"));
  try {
    const docs = readFileSync(new URL("../docs/release-migration.md", import.meta.url), "utf8");
    const inventoried = new Set(Array.from(docs.matchAll(/^\| \[(pm-[\w-]+)\]/gm), match => match[1]));
    assert.ok(inventoried.size > 0);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/@unbrained/pm-cli/dist/cli.js", import.meta.url)), "show", "ops-release-inventory-gaps", "--json"], {
      encoding: "utf8", env: { ...process.env, PM_PATH: fileURLToPath(new URL("../.agents/pm", import.meta.url)), PM_GLOBAL_PATH: join(root, "global") },
    });
    assert.equal(result.status, 0, result.stderr);
    const item = JSON.parse(result.stdout) as { item: { description: string } };
    for (const claim of item.item.description.matchAll(/cannot inspect (pm-[\w-]+)/g)) assert.ok(!inventoried.has(claim[1]), `Inventory already covers ${claim[1]}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("stranded receipt retirement keeps reconciliation short and branch reuse behind a fresh ownership check", () => {
  assert.deepEqual(workflow.jobs.reconcile.permissions, { contents: "read", "pull-requests": "write", actions: "write", checks: "read", issues: "read" });
  assert.match(workflow.jobs.prepare.if, /needs.reconcile.outputs.pending == 'false'/);
  const request = step("Merge release metadata through protected PR").run!;
  assert.match(request, /node "\$CONTINUATION_SCRIPT" retired-branch/);
  assert.ok(request.indexOf('retired-branch') < request.indexOf('--force-with-lease='));
  for (const current of workflow.jobs.reconcile.steps) assertNoNpmInstalls(current.run ?? "");
});

test("all tool bootstraps use trusted source, and publication replays the recorded workflow SHA", () => {
  for (const name of ["prepare", "release", "recover"]) {
    const job = workflow.jobs[name], locate = job.steps.findIndex(s => s.name === "Locate trusted continuation tools"), install = job.steps.findIndex(s => s.name === "Install pinned release tools");
    assert.ok(locate >= 0 && install > locate, name);
    assert.equal(job.steps[install].run?.trim(), 'node "$CONTINUATION_SCRIPT" tools');
  }
  assert.equal(workflow.jobs.request.steps.some(s => s.name === "Install pinned release tools"), false);
  const recorded = workflow.jobs.release.steps.find(s => s.name === "Checkout recorded release tools") as Step & { with: Record<string, string> };
  assert.equal(recorded.with.repository, "unbraind/pm-ops");
  assert.equal(recorded.with.ref, "${{ needs.reconcile.outputs.tools_sha }}");
  assert.equal(workflow.jobs.prepare.steps.find(s => s.run?.trim() === 'node "$CONTINUATION_SCRIPT" manifest')!.env?.WORKFLOW_TOOLS_SHA, "${{ job.workflow_sha }}");
  assert.match(step("Publish npm package").run, /node "\$PROVENANCE_SCRIPT"/);
  assert.match(step("Repair missing GitHub Release").run, /node "\$PROVENANCE_SCRIPT"/);
  assert.doesNotMatch(source, /npm install .*pm-ops@/);
});

test("every continuation job enforces its runtime floor before executing TypeScript", () => {
  for (const job of Object.values(workflow.jobs)) {
    const locate = job.steps.findIndex(s => s.name === "Locate trusted continuation tools");
    if (locate < 0) continue;
    const guard = job.steps.findIndex(s => s.name === "Enforce continuation runtime floor");
    const first = job.steps.findIndex(s => s.run?.includes('node "$CONTINUATION_SCRIPT"'));
    assert.ok(guard > locate && guard < first);
    assert.match(job.steps[guard].run!, /dist\/continuation-runtime.js/);
  }
});

test("private runtime CI installs and executes its own lockfile after root-installation gates", () => {
  const steps = ci.jobs.test.steps, index = steps.findIndex(s => s.name === "Verify private provenance runtime");
  assert.ok(index > steps.findIndex(s => s.name === "Bun release gate"));
  assert.match(steps[index].run!, /npm ci --prefix \.github\/release-runtime .*--ignore-scripts --engine-strict/);
  assert.match(steps[index].run!, /node --test --test-concurrency=2 test\/release-provenance.test.ts/);
});

test("rollback guidance preserves reconciliation and documents explicit operator retirement", () => {
  const docs = readFileSync(new URL("../docs/release-migration.md", import.meta.url), "utf8");
  assert.match(docs, /release-enabled: true/); assert.match(docs, /reconcile-only: true/);
  assert.match(docs, /release-enabled: false.*disables reconciliation/);
  assert.match(docs, /retire-unpublished: true/);
});

test("every installing reusable job pins npm while reconciliation stays installation-free", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { packageManager: string };
  const runtime = JSON.parse(readFileSync(new URL("../.github/release-runtime/package.json", import.meta.url), "utf8")) as { packageManager: string };
  assert.equal(pkg.packageManager, "npm@11.21.0");
  assert.equal(runtime.packageManager, pkg.packageManager);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const node = job.steps.findIndex(s => s.uses?.startsWith("actions/setup-node@"));
    const setup = job.steps.findIndex(s => s.name === "Use an npm that supports trusted publishing");
    const selected = job.steps[node] as Step & { with: Record<string, unknown> };
    assert.equal(selected.with["node-version"], "${{ inputs.node-version }}");
    assert.equal(selected.with["package-manager-cache"], false);
    if (["reconcile", "request"].includes(name)) {
      assert.equal(setup, -1);
      for (const current of job.steps) assertNoNpmInstalls(current.run ?? "");
      continue;
    }
    if (name === "verify_bun") {
      const mirror = job.steps.findIndex(s => s.id === "verify_bun");
      const hook = job.steps.findIndex(s => s.name === "Run optional caller bunx acceptance");
      assert.ok(setup > mirror && hook > setup, "npm setup follows the independent Bun mirror check and precedes the hook");
      assert.equal(job.steps[setup].if, "inputs.bunx-script != '' && steps.verify_bun.outcome == 'success'");
      assert.equal(job.steps[hook].if, job.steps[setup].if);
      assertNoNpmInstalls(job.steps[mirror].run!);
    } else {
      assert.equal(setup, node + 1, `${name}: upgrade immediately after selecting the caller's Node`);
      assert.equal(job.steps[setup].if, undefined);
    }
    assertPinnedNpmBootstrap(job.steps[setup].run!);
    assert.match(job.steps[setup].run!, /npm install -g npm@11\.21\.0 --ignore-scripts --no-audit --no-fund/);
    assert.match(job.steps[setup].run!, /\[\[ "\$active" == "11\.21\.0" \]\]/);
  }
});

test("every reusable and CI npm setup refuses failed installs and wrong active versions", () => {
  const root = mkdtempSync(join(tmpdir(), "release-npm-pin-"));
  try {
    const installCommands = ["npm ci", "npm install -g another-package", "npm -g i another-package", "npm add another-package", "npm it another-package", "npm install-test another-package", "npm installt another-package", "npm clean-install", "npm cit", "npm sit", "npm ic", "npm install-ci-test", "npm clean-install-test", "npm in another-package", "npm ins another-package", "npm inst another-package", "npm insta another-package", "npm instal another-package", "npm isnt another-package", "npm isnta another-package", "npm isntal another-package", "npm isntall another-package", "npm install-clean", "npm isntall-clean", "npm installTest another-package", "npm installCiTest another-package"];
    const scenarios = installCommands.flatMap(command => [command, `if ${command}; then true; fi`, `for attempt in 1; do ${command}; done`, `NPM_CONFIG_CACHE=cache ${command}`, `env NPM_CONFIG_CACHE=cache ${command}`, `command ${command}`, command.replace(/^npm /, "npm.cmd ")]);
    for (const name of ["reconcile", "request"]) for (const current of workflow.jobs[name].steps) for (const install of scenarios) {
      assert.throws(() => assertNoNpmInstalls((current.run ?? "") + "\n" + install), /must not install/);
    }
    writeFileSync(join(root, "npm"), '#!/bin/sh\ncase "$1" in\ninstall) exit "$INSTALL_STATUS" ;;\n--version) echo "$ACTIVE_NPM" ;;\nesac\n', { mode: 0o755 });
    for (const [file, jobs] of [["reusable", workflow.jobs], ["CI", ci.jobs]] as const) for (const [name, job] of Object.entries(jobs)) {
      const setupName = file === "reusable" ? "Use an npm that supports trusted publishing" : "Install npm 11.21.0";
      const setups = job.steps.filter((s: Step) => s.name === setupName);
      assert.equal(setups.length, file === "reusable" && ["reconcile", "request"].includes(name) ? 0 : 1, `${file}/${name}`);
      for (const setup of setups) {
        assertPinnedNpmBootstrap(setup.run!);
        for (const extra of scenarios.flatMap(command => ["\n", "; ", " && "].map(separator => separator + command))) {
          assert.throws(() => assertPinnedNpmBootstrap(setup.run! + extra), /only the pinned npm/);
        }
        for (const [active, status, success] of [["11.21.0", "0", true], ["10.9.3", "0", false], ["11.22.0", "0", false], ["11.21.0", "7", false]] as const) {
          const result = runBashFixture(setup.run!, { encoding: "utf8", env: {
            PATH: `${root}:${process.env.PATH}`, ACTIVE_NPM: active, INSTALL_STATUS: status,
          } });
          assert.equal(result.status === 0, success, `${file}/${name}/${active}/${status}: ${result.stderr}`);
        }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failure reporting attempts its script after bootstrap or dependency installation fails", () => {
  const setup = workflow.jobs.alert.steps.find(s => s.id === "npm_setup")!;
  const report = step("Report release failure");
  assert.equal(setup["continue-on-error"], true);
  assert.equal(report.if, "${{ !cancelled() }}");
  assert.equal(report.env?.NPM_READY, "${{ steps.npm_setup.outcome == 'success' }}");
  const root = mkdtempSync(join(tmpdir(), "release-alert-failure-"));
  try {
    writeFileSync(join(root, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GITHUB_WORKSPACE/calls"\ncase "$1" in ci) exit "$INSTALL_STATUS" ;; run) touch "$GITHUB_WORKSPACE/alert-ran" ;; esac\n', { mode: 0o755 });
    for (const ready of ["true", "false"]) for (const status of ["0", "7"]) {
      writeFileSync(join(root, "calls"), ""); rmSync(join(root, "alert-ran"), { force: true });
      const result = runBashFixture(report.run, { encoding: "utf8", env: { PATH: `${root}:${process.env.PATH}`,
        GITHUB_WORKSPACE: root, NPM_PROJECT_DIR: ".", NPM_READY: ready, INSTALL_STATUS: status, ALERT_SCRIPT: "release:alert" } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(root, "alert-ran")), true);
      assert.equal(readFileSync(join(root, "calls"), "utf8"), (ready === "true" ? "ci --ignore-scripts\n" : "") + "run release:alert\n");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failure alerts fall back without dependencies and deduplicate the run issue", () => {
  const root = mkdtempSync(join(tmpdir(), "release-alert-fallback-"));
  try {
    writeFileSync(join(root, "missing-dependency.mjs"), 'import "uninstalled-alert-dependency";\n');
    writeFileSync(join(root, "npm"), `#!/bin/sh
case "$1" in
ci) exit 7 ;;
run) exec '${process.execPath}' "$GITHUB_WORKSPACE/missing-dependency.mjs" ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(root, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$GITHUB_WORKSPACE/gh-calls"
case "$2" in
list) if [ "$LIST_STATUS" != 0 ]; then exit "$LIST_STATUS"; fi; printf '%s\\n' "$EXISTING_ISSUES" ;;
create) for argument in "$@"; do last="$argument"; done
  cp "$last" "$GITHUB_WORKSPACE/issue-body"
  printf '%s' "$last" > "$GITHUB_WORKSPACE/body-path"
  exit "$CREATE_STATUS" ;;
esac
`, { mode: 0o755 });
    for (const [ready, existing, listStatus, createStatus, success, created] of [
      ["false", "[]", "0", "0", true, true], ["true", "[]", "0", "0", true, true],
      ["false", '[{"title":"Daily release failed (run 123)","number":7}]', "0", "0", true, false],
      ["false", "[]", "7", "0", false, false], ["false", "[]", "0", "7", false, true],
    ] as const) {
      writeFileSync(join(root, "gh-calls"), "");
      for (const file of ["issue-body", "body-path"]) rmSync(join(root, file), { force: true });
      const result = runBashFixture(step("Report release failure").run, { encoding: "utf8", env: {
        PATH: `${root}:${process.env.PATH}`, GITHUB_WORKSPACE: root, NPM_PROJECT_DIR: ".", NPM_READY: ready,
        ALERT_SCRIPT: "release:alert", GITHUB_REPOSITORY: "example/package", GITHUB_RUN_ID: "123",
        GITHUB_SERVER_URL: "https://github.com", EXISTING_ISSUES: existing, LIST_STATUS: listStatus, CREATE_STATUS: createStatus,
      } });
      assert.equal(result.status === 0, success, result.stderr);
      const calls = readFileSync(join(root, "gh-calls"), "utf8");
      assert.match(calls, /issue list/);
      assert.equal(calls.includes("issue create"), created);
      if (created) {
        assert.match(readFileSync(join(root, "issue-body"), "utf8"), /https:\/\/github.com\/example\/package\/actions\/runs\/123/);
        assert.equal(existsSync(readFileSync(join(root, "body-path"), "utf8")), false, "clean fallback body on success and failure");
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Bun mirror verification completes independently before optional npm setup", () => {
  const root = mkdtempSync(join(tmpdir(), "release-bun-before-npm-"));
  try {
    for (const command of ["bun", "bunx"]) writeFileSync(join(root, command), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RUNNER_TEMP/bun-calls"\n', { mode: 0o755 });
    writeFileSync(join(root, "npm"), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    const env = { PATH: `${root}:${process.env.PATH}`, RUNNER_TEMP: root, GITHUB_ENV: join(root, "github-env"),
      NPM_VERSION: "2026.11.7", PKG_NAME: "example-package", CLI_VERSION: "2026.11.4", BUNX_SCRIPT: "accept:bun",
      NPM_PROJECT_DIR: ".", GITHUB_WORKSPACE: root };
    const verified = runBashFixture(step("Verify bun install of published package").run, { encoding: "utf8", env });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(readFileSync(join(root, "bun-calls"), "utf8"), /health --strict-exit/);
    assert.match(readFileSync(join(root, "github-env"), "utf8"), /PM_PATH=.*\nPM_GLOBAL_PATH=.*\nBUN_INSTALL_CACHE_DIR=/);
    const setup = workflow.jobs.verify_bun.steps.find(s => s.name === "Use an npm that supports trusted publishing")!;
    const failed = runBashFixture(setup.run!, { encoding: "utf8", env });
    assert.notEqual(failed.status, 0);
    assert.match(readFileSync(join(root, "bun-calls"), "utf8"), /health --strict-exit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PR lock gate uses both committed locks and the exact script-disabled release install", () => {
  const job = ci.jobs["release-lock"];
  assert.deepEqual(job.strategy.matrix["node-version"], ["22.18.0", 26]);
  const command = "npm ci --omit=dev --ignore-scripts --legacy-peer-deps --no-audit --no-fund";
  const gate = job.steps.find(s => s.name === "Install committed locks exactly as release tools do")!;
  assert.equal(gate.if, undefined);
  assert.match(gate.run!, /for project in \. \.github\/release-runtime/);
  assert.match(gate.run!, /cp "\$project\/package.json" "\$project\/package-lock.json" "\$scratch\/"/);
  assert.ok(gate.run!.includes(command));
  const helper = readFileSync(new URL("../scripts/release-runtime.ts", import.meta.url), "utf8");
  assert.equal(helper.split(JSON.stringify(command.split(" ").slice(1)).replaceAll(",", ", ")).length - 1, 2);
  for (const entry of Object.values(ci.jobs)) {
    const setup = entry.steps.findIndex(s => s.name === "Install npm 11.21.0");
    assert.ok(setup >= 0);
    assert.match(entry.steps[setup].run!, /npm --version/);
    const firstInstall = entry.steps.findIndex(s => /npm ci/.test(s.run ?? ""));
    assert.ok(firstInstall > setup);
  }
});


test("every private runtime Node floor has an independent strict engine gate", () => {
  const floor = JSON.parse(readFileSync(new URL("../.github/release-runtime/package.json", import.meta.url), "utf8")).engines.node.replace(/^>=/, "");
  const job = ci.jobs["release-lock"];
  assert.ok(job.strategy.matrix["node-version"].includes(floor));
  const strict = job.steps.find((s: Step) => s.run?.includes("--engine-strict"));
  assert.ok(strict, "the floor needs a strict install in addition to the exact release command");
  assert.equal(strict.if, "${{ matrix.node-version == '" + floor + "' }}");
  assert.equal(strict.run, "npm ci --prefix .github/release-runtime --omit=dev --ignore-scripts --legacy-peer-deps --engine-strict --no-audit --no-fund");
  assert.ok(job.steps.indexOf(strict) > job.steps.findIndex((s: Step) => s.name === "Install committed locks exactly as release tools do"));
});

test("private runtime floor gate rejects incompatible root and transitive engines before installation", () => {
  const strict = ci.jobs["release-lock"].steps.find((s: Step) => s.run?.includes("--engine-strict"));
  assert.ok(strict, "a strict floor gate must exist before exercising its engine policy");
  const root = mkdtempSync(join(tmpdir(), "release-engine-policy-"));
  try {
    for (const target of ["", "node_modules/sigstore"]) {
      const cwd = join(root, target === "" ? "root-engine" : "dependency-engine");
      const runtime = join(cwd, ".github/release-runtime");
      mkdirSync(runtime, { recursive: true });
      const manifest = JSON.parse(readFileSync(new URL("../.github/release-runtime/package.json", import.meta.url), "utf8"));
      const lock = JSON.parse(readFileSync(new URL("../.github/release-runtime/package-lock.json", import.meta.url), "utf8"));
      assert.ok(lock.packages[target].engines.node, "the adversary must change an existing engine declaration");
      lock.packages[target].engines.node = ">=999.0.0";
      if (target === "") manifest.engines.node = ">=999.0.0";
      writeFileSync(join(runtime, "package.json"), JSON.stringify(manifest));
      writeFileSync(join(runtime, "package-lock.json"), JSON.stringify(lock));
      const result = runBashFixture(strict.run!, { cwd, encoding: "utf8", timeout: 30_000, env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        NPM_CONFIG_USERCONFIG: process.platform === "win32" ? "NUL" : "/dev/null", NPM_CONFIG_CACHE: join(cwd, "cache"),
      } });
      assert.notEqual(result.status, 0, target);
      assert.match(result.stderr, /EBADENGINE/, target);
      assert.equal(existsSync(join(runtime, "node_modules")), false, "engine refusal precedes dependency writes");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

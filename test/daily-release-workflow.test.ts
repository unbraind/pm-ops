/** Parse the executable workflow and assert its privilege and publication wiring. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { auditPublishAttestation } from "../attestation.ts";

/** Workflow step fields used by the structural and shell regression tests. */
interface Step {
  /** Human-readable identity, optional for anonymous action steps. */
  name?: string;
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
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, { if: string; permissions: Record<string, string>; steps: Step[] }>;
};
const steps = Object.values(workflow.jobs).flatMap(job => job.steps);

/** Read a required executable step, failing if it was removed or renamed. */
function step(name: string): Step & { run: string } {
  const result = steps.find(s => s.name === name);
  assert.ok(result?.run, `missing executable step: ${name}`);
  return result as Step & { run: string };
}

test("shared workflow grants permissions per job, pins actions, and gates every privileged run", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.release.permissions, { contents: "write", "pull-requests": "write", actions: "write", "id-token": "write" });
  assert.deepEqual(workflow.jobs.prepare.permissions, { contents: "read", "pull-requests": "read" });
  assert.deepEqual(workflow.jobs.alert.permissions, { contents: "read", issues: "write" });
  assert.match(workflow.jobs.release.if, /inputs.release-enabled && github.ref == 'refs\/heads\/main'/);
  assert.equal(workflow.concurrency.group, "daily-release");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
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
  assert.match(step("Install pinned release tools").run, /pm-ops@\$PM_OPS_VERSION/);
});

test("planning calls the measured TypeScript module and keeps PR payloads in files", () => {
  const plan = step("Decide release");
  assert.match(plan.run, /--limit 1000/);
  assert.match(plan.run, /> "\$release_prs_file"/);
  assert.match(plan.run, /readFileSync\(process.argv\[2\]/);
  assert.match(plan.run, /decideDailyRelease\(/);
  assert.match(plan.run, /prs.length >= 1000/);
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
  assert.match(step("Continue at the published commit").run, /\$MERGED_SHA" != "\$TRIGGER_SHA/);
  assert.match(step("Continue at the published commit").run, /gh workflow run/);
  for (const name of ["Verify merged release", "Publish npm package", "Publish extra targets", "Push release tag"]) assert.match(step(name).if!, /steps.continue.outputs.ready == 'true'/);
  assert.match(step("Verify merged release").run, /\$MERGED_SHA" == "\$TRIGGER_SHA/);
  assert.deepEqual(workflow.jobs.verify_bun.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.recover.permissions, { contents: "write" });
  assert.match(workflow.jobs.verify_bun.if, /needs.release.outputs.published == 'success'/);
  assert.match(step("Verify bun install of published package").run, /bunx --bun --no-install pm health --strict-exit/);
  assert.match(step("Publish npm package").run, /npm publish \.\/package\.tgz --access public --provenance --ignore-scripts/);
  assert.match(step("Publish npm package").run, /verifyPublishedProvenance/);
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

test("superseded cleanup failure cannot block the release, and branch cleanup keeps its lease", () => {
  const root = mkdtempSync(join(tmpdir(), "release-cleanup-"));
  try {
    const gh = join(root, "gh");
    writeFileSync(gh, "#!/bin/sh\nprintf '%s\\n' 'synthetic close refusal' >&2\nexit 1\n");
    chmodSync(gh, 0o755);
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step("Close superseded release PRs").run], { env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SUPERSEDED_PR_NUMBERS: "12 13", RELEASE_PR_NUMBER: "14", GITHUB_REPOSITORY: "example/package" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /warning::Could not close superseded release PR #12/);
    assert.match(result.stdout, /warning::Could not close superseded release PR #13/);
    assert.match(step("Clean up merged release branch").run, /--force-with-lease=.*expected_sha/);
    assert.match(step("Clean up merged release branch").run, /expected_sha="\$\(git rev-parse HEAD/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every declared package input is typed and wired into executable jobs", () => {
  const jobSource = source.slice(source.indexOf("jobs:"));
  for (const [name, input] of Object.entries(workflow.on.workflow_call.inputs)) {
    assert.ok(["string", "boolean"].includes(input.type));
    assert.equal(typeof input.default, input.type);
    assert.ok(jobSource.includes(`inputs.${name}`), `unwired input ${name}`);
  }
  for (const hook of ["PREPARE_SCRIPT", "VERIFY_SCRIPT", "PUBLISH_SCRIPT", "POST_RELEASE_SCRIPT", "BUNX_SCRIPT"]) assert.ok(steps.some(s => s.run?.includes(`$${hook}`)), hook);
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
      const result = spawnSync("bash", ["-c", step("Resolve pm-ops release version").run], { encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TAG_FIXTURE: remote, WORKFLOW_SHA: sha, GITHUB_ENV: output, GITHUB_OUTPUT: join(root, "step-output") } });
      if (fixture.expected) {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(readFileSync(output, "utf8"), `PM_OPS_VERSION=${fixture.expected}\n`);
      } else assert.notEqual(result.status, 0, fixture.tags);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("the shared workflow satisfies the canonical attestation auditor without exclusions", () => {
  assert.deepEqual(auditPublishAttestation([{ file: ".github/workflows/daily-release.yml", text: source }]).failures, []);
});

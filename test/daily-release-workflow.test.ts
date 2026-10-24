/** Parse the executable workflow and assert its privilege and publication wiring. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "../subprocess.ts";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  jobs: Record<string, { if: string; needs: string[]; permissions: Record<string, string>; steps: Step[] }>;
};
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
  assert.match(step("Continue at the published commit").run, /\$MERGED_SHA" != "\$TRIGGER_SHA/);
  assert.match(step("Continue at the published commit").run, /gh workflow run/);
  for (const name of ["Verify merged release", "Publish npm package", "Publish extra targets", "Push release tag"]) assert.match(step(name).if!, /steps.continue.outputs.ready == 'true'/);
  assert.match(step("Verify merged release").run, /\$MERGED_SHA" == "\$TRIGGER_SHA/);
  assert.deepEqual(workflow.jobs.verify_bun.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.recover.permissions, { contents: "write" });
  assert.match(workflow.jobs.verify_bun.if, /needs.release.outputs.published == 'success'/);
  assert.match(workflow.jobs.verify_bun.if, /inputs.npm-publish && inputs.bun-verify/);
  assert.equal(step("Pack verified release").env?.BUN_VERIFY, "${{ inputs.npm-publish && inputs.bun-verify }}");
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

test("release approval retries select only waiting CI runs on the prepared head", () => {
  const merge = step("Merge release metadata through protected PR").run;
  assert.match(merge, /actions\/runs\?head_sha=\$\{release_commit\}/);
  const filter = /--jq '(\.workflow_runs\[\]\?[\s\S]*?)'/.exec(merge)?.[1];
  assert.ok(filter);
  const result = spawnSync("jq", ["-r", filter], { encoding: "utf8", input: JSON.stringify({ workflow_runs: [
    { id: 1, name: "CI", conclusion: "action_required" },
    { id: 2, name: "CI", status: "waiting" },
    { id: 3, name: "Release", conclusion: "action_required" },
    { id: 4, name: "CI", conclusion: "success" },
  ] }) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "1\n2\n");
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
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", dates + '\nprintf "%s" "$RELEASE_PUBLISHED_TODAY"'], {
        encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, RUNNER_TEMP: root, NPM_PROJECT_PATH: root,
          GITHUB_REPOSITORY: "example/package", IS_RUST: "false", VERSION_POLICY: policy, RELEASE_TODAY: "2026.10.20", RELEASE_TIMEZONE: "Europe/Vienna" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "true", policy);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("completeness audit follows release and recovery even on no-change days and exposes failures to alerting", () => {
  const audit = workflow.jobs.audit;
  assert.deepEqual(audit.needs, ["prepare", "release", "recover", "verify_bun"]);
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
    mkdirSync(join(root, "release-handoff"));
    const artifact = Buffer.from("synthetic verified artifact");
    writeFileSync(join(root, "release-handoff/package.tgz"), artifact);
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
      const result = spawnSync("bash", ["-c", step("Publish npm package").run], { cwd: root, encoding: "utf8", env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root, HOME: root, NPM_CONFIG_USERCONFIG: join(root, "absent-config"),
        NPM_VERSION: "2026.10.20", REGISTRY_METADATA: JSON.stringify({ integrity: fixture.integrity, attestations: { url: "https://registry.npmjs.org/synthetic" } }), METADATA_MODE: fixture.mode,
        VISIBLE_READ: String(fixture.visible), PUBLISH_STATUS: String(fixture.publish), PM_OPS_MODULE: new URL("../dist/daily-release.js", import.meta.url).pathname,
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
      const result = spawnSync("bash", ["-c", step("Commit release files").run], {
        cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_WORKSPACE: root, NPM_PROJECT_PATH: project, NPM_PROJECT_DIR: directory, RELEASE_FILES: "release-manifest.json", REPO_NAME: "example", RELEASE_TAG: "v2099.1.1" },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const prefix = directory === "." ? "" : directory + "/";
      const changed = execFileSync("git", ["diff", "--name-only", "-z", initial, "HEAD"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).sort();
      assert.deepEqual(changed, [prefix + "CHANGELOG.md", prefix + "src/generated output.ts", prefix + "src/old.ts", "release-manifest.json"].sort());
      assert.equal(execFileSync("git", ["show", `HEAD:${prefix}CHANGELOG.md`], { cwd: root, encoding: "utf8" }), "First changelog\n");
      assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }), "");
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
    const guard = step("Pack verified release").run.split('handoff="$(mktemp')[0];
    /** Run exactly the workflow pre-pack guards without any pack/publication effects. */
    const check = () => spawnSync("bash", ["-c", guard], { cwd: root, encoding: "utf8", env: { ...process.env, NPM_PROJECT_PATH: root } });
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
      const result = spawnSync("bash", ["-c", step("Pack verified release").run], {
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
      const result = spawnSync("bash", ["-c", step("Repair missing GitHub Release").run], {
        cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root,
          EXPECTED_COMMIT: commit, RECOVERY_TAG: tag, NPM_PUBLISH: "true", GITHUB_REPOSITORY: "example/package",
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

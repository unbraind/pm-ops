/** Execute review-sensitive workflow fragments and the published migration command. */
import assert from "node:assert/strict";
import { type SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "../subprocess.ts";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { releaseCallerFixture } from "./canonical-tags-fixture.ts";

/** Read a repository-owned text artifact. */
function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("OIDC refusal instructions identify the caller workflow and repository", () => {
  const workflow = parse(read(".github/workflows/daily-release.yml")) as {
    jobs: { release: { steps: { name: string; run?: string; env?: Record<string, string> }[] } };
  };
  const step = workflow.jobs.release.steps.find(s => s.name === "Verify npm will accept this workflow's OIDC identity")!;
  const root = mkdtempSync(join(tmpdir(), "release-oidc-guidance-"));
  try {
    writeFileSync(join(root, "package.json"), '{"name":"example-package"}\n');
    writeFileSync(join(root, "curl"), `#!/bin/sh
case "$*" in
  *token/exchange/package/*)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then printf '%s' '{"message":"synthetic refusal"}' > "$2"; break; fi
      shift
    done
    printf '403' ;;
  *) printf '%s' '{"value":"synthetic-token"}' ;;
esac
`);
    chmodSync(join(root, "curl"), 0o755);
    for (const filename of ["publish-package.yaml", "release.yml"]) {
      const result = spawnSync("bash", ["-c", step.run!], {
        cwd: root, encoding: "utf8", env: {
          ...process.env, PATH: `${root}:${process.env.PATH}`, GITHUB_REPOSITORY: "example-org/example-package",
          CALLER_WORKFLOW: step.env?.CALLER_WORKFLOW === "${{ github.workflow_ref }}"
            ? `example-org/example-package/.github/workflows/${filename}@refs/heads/main` : "",
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc?request=1",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-request-token",
        },
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(result.stdout.includes(`organization 'example-org', repository 'example-package', workflow '${filename}', no environment.`), result.stdout);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("both release selectors resolve only complete threads from explicitly trusted Bot accounts", () => {
  const trusted = ["sourcery-ai", "cubic-dev-ai", "coderabbitai"];
  /** Build one fetched comment, including unavailable author identities. */
  const comment = (login: string | null, type = "Bot") => ({ author: login === null ? null : { login, __typename: type } });
  const cases = [
    ...trusted.map(login => ({ id: login, isResolved: false, authors: [comment(login)], count: 1 })),
    { id: "trusted-mixed", isResolved: false, authors: trusted.map(login => comment(login)), count: 3 },
    { id: "unknown", isResolved: false, authors: [comment("untrusted-reviewer")], count: 1 },
    { id: "mixed-bots", isResolved: false, authors: [comment(trusted[0]), comment("untrusted-reviewer")], count: 2 },
    { id: "human", isResolved: false, authors: [comment(trusted[0]), comment("reviewer", "User")], count: 2 },
    { id: "trusted-name-human", isResolved: false, authors: [comment(trusted[0], "User")], count: 1 },
    { id: "missing-author", isResolved: false, authors: [comment(trusted[0]), comment(null)], count: 2 },
    { id: "missing-login", isResolved: false, authors: [{ author: { __typename: "Bot" } }], count: 1 },
    { id: "empty", isResolved: false, authors: [], count: 0 },
    { id: "truncated", isResolved: false, authors: [comment(trusted[0])], count: 101 },
    { id: "resolved", isResolved: true, authors: [comment(trusted[0])], count: 1 },
  ];
  const input = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: cases.map(fixture => ({
    id: fixture.id, isResolved: fixture.isResolved, comments: { totalCount: fixture.count, nodes: fixture.authors },
  })) } } } } });
  for (const file of ["daily-release.yml", "release.yml"]) {
    const filter = /--jq '(\.data\.repository\.pullRequest\.reviewThreads[\s\S]*?)'/.exec(read(`.github/workflows/${file}`))?.[1];
    assert.ok(filter, `missing review selector in ${file}`);
    const result = spawnSync("jq", ["-r", filter], { input, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [...trusted, "trusted-mixed"], file);
  }
});

const { caller, releasedSha } = releaseCallerFixture();

test("documented consumer release gate requires verified provenance while CLI deferral remains successful", () => {
  const command = /```sh\n(node --input-type=module[^\n]*inspectReleaseCaller[^\n]*)\n```/.exec(read("docs/reusable-release.md"))?.[1];
  assert.ok(command, "missing executable migration gate");
  const root = mkdtempSync(join(tmpdir(), "release-doc-gate-"));
  try {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    mkdirSync(join(root, "node_modules"));
    symlinkSync(new URL("..", import.meta.url), join(root, "node_modules/pm-ops"), "junction");
    for (const fixture of [
      { source: caller, status: "verified", exit: 0 },
      { source: caller.replace(releasedSha, "e".repeat(40)).replace("v2026.10.19", "v2099.12.25"), status: "unverified-offline", exit: 1 },
      { source: caller.replace(releasedSha, "f".repeat(40)), status: "refused", exit: 1 },
    ]) {
      writeFileSync(join(root, ".github/workflows/release.yml"), fixture.source);
      const result: SpawnSyncReturns<string> = spawnSync("bash", ["-c", command], { cwd: root, encoding: "utf8", env: { ...process.env, PM_OPS_OFFLINE: "1" } });
      assert.match(result.stderr, new RegExp(fixture.status));
      assert.equal(result.status, fixture.exit, result.stdout + result.stderr);
      if (fixture.status === "unverified-offline") {
        const cli = spawnSync(process.execPath, [new URL("../scripts/release-caller.ts", import.meta.url).pathname], {
          cwd: root, encoding: "utf8", env: { ...process.env, PM_OPS_OFFLINE: "1" },
        });
        assert.equal(cli.status, 0, cli.stderr);
        assert.match(cli.stderr, /unverified-offline/);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("caller guides use the current CLI contract without a removed online flag", () => {
  const files = ["README.md", ...readdirSync(new URL("../docs/", import.meta.url), { recursive: true })
    .map(String).filter(path => path.endsWith(".md")).map(path => `docs/${path}`)];
  for (const file of files) assert.doesNotMatch(read(file), /--online\b/, file);
});

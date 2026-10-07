/** Hermetic release recovery with a real pm tracker, local git remote, and recorded npm output shape. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { create, init } from "@unbrained/pm-cli/sdk";
import { auditReleaseCompleteness, makeFetcher, verify, type CompletenessFetcher } from "../release-completeness.ts";
import { repairReleaseCompleteness as repairBuiltPackage } from "../dist/release-repair.js";
import { committedReleaseNotes, evidenceFromAudit, makeRepairClient, repairReleaseCompleteness, type NpmEvidence, type RepairClient, type RepairExecutor } from "../release-repair.ts";
import { runIfMain } from "../scripts/verify-release-completeness.ts";

const tag = "v2026.08.28";
const version = "2026.8.28";
const slug = "example/sample-package";
const name = "sample-package";
const changelog = "# Changelog\n\n## 2026.8.28 - 2026-08-28\n\n### Fixed\n\n- Committed recovery notes.\n\n## 2026.8.27 - 2026-08-27\n\n- Earlier release.\n";
const recorded = JSON.parse(readFileSync(new URL("./fixtures/release-provenance.json", import.meta.url), "utf8")) as {
  name: string; version: string; gitHead: string; invalid: unknown[];
  verified: { name: string; version: string; registry: string; attestationBundles: { predicateType: string; bundle: { dsseEnvelope: { payload: string } } }[] }[];
  statement: { predicateType: string; predicate: { buildDefinition: { resolvedDependencies: { uri: string; digest: { gitCommit: string } }[] } } };
};

/** Substitute the fixture commit into the normalized npm signature-audit response. */
function auditOutput(commit: string, mutate?: (fixture: typeof recorded) => void): string {
  const fixture = structuredClone(recorded);
  fixture.gitHead = commit;
  fixture.statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit = commit;
  mutate?.(fixture);
  fixture.verified[0]!.attestationBundles[0]!.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(fixture.statement)).toString("base64");
  return JSON.stringify(fixture);
}

/** Build a real tracker and local git remote; registry and release operations stay injected. */
async function fixture(options: { tag?: boolean; release?: boolean; version?: string; changelog?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pm-ops-repair-"));
  const remote = join(root, "remote.git");
  const cwd = join(root, "project");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["clone", "-q", remote, cwd], { stdio: "pipe" });
  const pm = { cwd, pmRoot: join(cwd, ".agents/pm"), noExtensions: true };
  await init("sample", {}, pm);
  await create({ type: "Task", title: "Repair acceptance scenario", description: "Local release recovery fixture", priority: 2 }, pm);
  const manifest = { name, version: options.version ?? version, repository: `https://github.com/${slug}` };
  writeFileSync(join(cwd, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(cwd, "CHANGELOG.md"), options.changelog ?? changelog);
  const git = (args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git(["add", "package.json", "CHANGELOG.md"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "release fixture"]);
  const commit = git(["rev-parse", "HEAD"]);
  git(["push", "-q", "origin", "HEAD:main"]);
  if (options.tag !== false) { git(["tag", tag]); git(["push", "-q", "origin", `refs/tags/${tag}`]); }
  const versions = [version];
  const releases = new Set(options.release ? [tag] : []);
  const writes: string[] = [];
  const bodies: string[] = [];
  const evidence: NpmEvidence = evidenceFromAudit(name, version, commit, auditOutput(commit));
  const adapter = makeRepairClient((command, args, execOptions) => {
    if (command === "git") return execFileSync(command, args, { ...execOptions, encoding: "utf8", stdio: "pipe" });
    assert.fail("local adapter must only run git");
  });
  const fetcher: CompletenessFetcher = {
    tags: () => git(["tag"]).split("\n").filter(Boolean),
    remoteUrl: () => `https://github.com/${slug}`,
    npmVersions: () => [...versions],
    githubReleases: () => [...releases],
    githubReleaseForTag: (_slug, queried) => releases.has(queried),
  };
  const client: RepairClient = {
    npmEvidence: () => evidence,
    remoteTag: adapter.remoteTag,
    git: adapter.git,
    createTag(_slug, queried, sha) {
      writes.push(`tag ${queried}`);
      execFileSync("git", ["--git-dir", remote, "update-ref", `refs/tags/${queried}`, sha, "0000000000000000000000000000000000000000"]);
    },
    createRelease(_slug, queried, body) { writes.push(`release ${queried}`); bodies.push(body); releases.add(queried); },
  };
  return { root, cwd, remote, commit, git, versions, releases, writes, bodies, evidence, fetcher, client, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("report-only repeats the missing release; repair uses committed notes and is idempotent", async () => {
  const f = await fixture();
  try {
    assert.match(verify(f.cwd, f.fetcher).failures[0]!, /no corresponding GitHub Release/);
    assert.equal(verify(f.cwd, f.fetcher).failures.length, 1);
    assert.deepEqual(f.writes, []);
    writeFileSync(join(f.cwd, "CHANGELOG.md"), "uncommitted notes must not be used");
    const repaired = repairReleaseCompleteness(f.cwd, f.fetcher, f.client);
    assert.deepEqual(repaired.failures, []);
    assert.deepEqual(f.writes, [`release ${tag}`]);
    assert.deepEqual(f.bodies, ["### Fixed\n\n- Committed recovery notes.\n"]);
    assert.deepEqual(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures, []);
    assert.equal(f.writes.length, 1);
  } finally { f.cleanup(); }
});

test("npm-only orphan gains exactly the attested remote tag then its release", async () => {
  const f = await fixture({ tag: false });
  try {
    assert.deepEqual(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures, []);
    assert.deepEqual(f.writes, [`tag ${tag}`, `release ${tag}`]);
    assert.equal(f.client.remoteTag(f.cwd, tag), f.commit);
    assert.deepEqual(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures, []);
    assert.equal(f.writes.length, 2);
  } finally { f.cleanup(); }
});

test("remote complete triple missing from local tags makes no writes", async () => {
  const f = await fixture({ release: true });
  try {
    f.git(["tag", "-d", tag]);
    assert.deepEqual(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures, []);
    assert.deepEqual(f.writes, []);
  } finally { f.cleanup(); }
});

test("local tag with missing remote ref is restored only at the attested commit", async () => {
  const f = await fixture({ release: true });
  try {
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "-d", `refs/tags/${tag}`]);
    assert.deepEqual(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures, []);
    assert.deepEqual(f.writes, [`tag ${tag}`]);
  } finally { f.cleanup(); }
});

test("all preflight mismatches refuse before writes, including an unpublished later tag", async () => {
  for (const mutate of [
    (f: Awaited<ReturnType<typeof fixture>>) => { f.versions.length = 0; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.evidence.commit = "a".repeat(40); },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.evidence.repository = "other/package"; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.evidence.name = "other-package"; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.evidence.version = "2026.8.29"; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.evidence.commit = "short"; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.client.npmEvidence = () => { throw new Error("invalid attestation signature"); }; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.git(["tag", "v2026.08.29"]); },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.fetcher.remoteUrl = () => "https://github.com/other/package"; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.fetcher.githubReleaseForTag = () => { throw new Error("HTTP 403"); }; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.client.remoteTag = () => { throw "network unavailable"; }; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.versions.push("1.0.0"); },
  ]) {
    const f = await fixture();
    try { mutate(f); assert.equal(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures.length, 1); assert.deepEqual(f.writes, []); }
    finally { f.cleanup(); }
  }
});

test("tag and signed commit mismatch, unavailable commit and committed identity refuse", async () => {
  for (const mode of ["remote", "local", "missing", "identity", "notes", "object"] as const) {
    const f = await fixture({ tag: mode !== "missing", version: mode === "identity" ? "2026.8.27" : version, changelog: mode === "notes" ? "# no notes" : changelog });
    try {
      if (mode === "remote") { f.evidence.gitHead = f.evidence.commit = "a".repeat(40); }
      if (mode === "local") { f.git(["commit", "--allow-empty", "-qm", "different", "--author=Fixture <fixture@example.test>"]); f.git(["tag", "-f", tag]); }
      if (mode === "missing") { f.evidence.gitHead = f.evidence.commit = "a".repeat(40); }
      if (mode === "object") { f.client.git = () => "b".repeat(40); f.git(["tag", "-d", tag]); }
      assert.match(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures.join(";"), /release repair refused/);
      assert.equal(f.writes.length, 0, mode);
    } finally { f.cleanup(); }
  }
});

test("uncertain tag and release writes reconcile only proven matching state", async () => {
  for (const succeeds of [true, false]) {
    const f = await fixture({ tag: false });
    try {
      const createTag = f.client.createTag;
      f.client.createTag = (...args) => { if (succeeds) createTag(...args); throw new Error("lost tag response"); };
      const createRelease = f.client.createRelease;
      f.client.createRelease = (...args) => { if (succeeds) createRelease(...args); throw new Error("lost release response"); };
      const result = repairReleaseCompleteness(f.cwd, f.fetcher, f.client);
      assert.equal(result.failures.length, succeeds ? 0 : 1);
    } finally { f.cleanup(); }
  }
  const f = await fixture();
  try {
    f.client.createRelease = () => { throw new Error("release failed"); };
    assert.match(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures[0]!, /release failed/);
  } finally { f.cleanup(); }
});

test("concurrent repair skips writes and conflicting remote changes refuse", async () => {
  for (const conflicting of [true, false]) {
    const f = await fixture({ tag: false });
    try {
      const read = f.client.remoteTag;
      let reads = 0;
      f.client.remoteTag = (root, queried) => {
        if (++reads === 2) {
          execFileSync("git", ["--git-dir", f.remote, "update-ref", `refs/tags/${tag}`, f.commit]);
          f.releases.add(tag);
          if (conflicting) return "a".repeat(40);
        }
        return read(root, queried);
      };
      assert.equal(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures.length, conflicting ? 1 : 0);
      assert.deepEqual(f.writes, []);
    } finally { f.cleanup(); }
  }
});

test("post-write verification exposes an invisible or failed tag creation", async () => {
  const f = await fixture({ tag: false });
  try {
    f.client.createTag = () => {};
    assert.match(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures[0]!, /remote tag changed/);
    assert.deepEqual(f.writes, []);
  } finally { f.cleanup(); }
});

test("notes require one exact nonempty committed version section", () => {
  assert.equal(committedReleaseNotes(changelog, version), "### Fixed\n\n- Committed recovery notes.\n");
  for (const text of ["# no section", changelog + changelog, `## ${version} - 2026-08-28\n\n`, `## ${version} - 2026-08-28`]) {
    assert.throws(() => committedReleaseNotes(text, version));
  }
});

test("verified npm audit rejects missing, ambiguous, invalid and mismatching provenance", () => {
  const commit = "a".repeat(40);
  assert.equal(evidenceFromAudit(name, version, commit, auditOutput(commit)).commit, commit);
  for (const change of [
    (f: typeof recorded) => { f.invalid.push({ code: "EATTESTATIONVERIFY" }); },
    (f: typeof recorded) => { f.invalid = null as unknown as unknown[]; },
    (f: typeof recorded) => { f.verified = null as unknown as typeof f.verified; },
    (f: typeof recorded) => { f.verified[0]!.name = "wrong"; },
    (f: typeof recorded) => { f.verified[0]!.version = "2026.8.27"; },
    (f: typeof recorded) => { f.verified[0]!.registry = "https://registry.example.test/"; },
    (f: typeof recorded) => { f.verified.push(structuredClone(f.verified[0]!)); },
    (f: typeof recorded) => { f.verified[0]!.attestationBundles[0]!.predicateType = "publish-attestation"; },
    (f: typeof recorded) => { f.statement.predicateType = "wrong"; },
    (f: typeof recorded) => { f.statement.predicate.buildDefinition.resolvedDependencies[0]!.uri = "https://notgithub.com/example/package"; },
    (f: typeof recorded) => { f.statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit = "short"; },
    (f: typeof recorded) => { f.statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit = "b".repeat(40); },
    (f: typeof recorded) => { f.statement.predicate.buildDefinition.resolvedDependencies = []; },
    (f: typeof recorded) => { f.statement.predicate.buildDefinition.resolvedDependencies.push(structuredClone(f.statement.predicate.buildDefinition.resolvedDependencies[0]!)); },
  ]) assert.throws(() => evidenceFromAudit(name, version, commit, auditOutput(commit, change)));
  assert.throws(() => evidenceFromAudit(name, version, "short", auditOutput(commit)));
  assert.throws(() => evidenceFromAudit(name, version, commit, "not JSON"));
});

test("live adapter constructs only conditional GitHub writes and read-only npm operations", () => {
  const commit = "a".repeat(40);
  const calls: { command: string; args: string[]; cwd?: string }[] = [];
  let notes = "";
  const scratchDirectories = new Set<string>();
  const exec: RepairExecutor = (command, args, options = {}) => {
    calls.push({ command, args, cwd: options.cwd });
    if (options.cwd !== undefined) scratchDirectories.add(options.cwd);
    if (command === "npm") {
      assert.ok(["view", "install", "audit"].includes(args[0]!));
      if (args[0] === "view") return JSON.stringify({ name, version, gitHead: commit });
      if (args[0] === "audit") return auditOutput(commit);
      assert.ok(args.includes("--ignore-scripts"));
      return "";
    }
    if (command === "gh" && args[0] === "release") {
      assert.ok(args.includes("--verify-tag"));
      assert.ok(args.includes("--latest=false"));
      const path = args[args.indexOf("--notes-file") + 1]!;
      notes = readFileSync(path, "utf8");
      scratchDirectories.add(resolve(path, ".."));
    }
    return "";
  };
  const client = makeRepairClient(exec);
  assert.equal(client.npmEvidence(name, version).commit, commit);
  client.createTag(slug, tag, commit);
  client.createRelease(slug, tag, "committed notes\n");
  assert.equal(notes, "committed notes\n");
  assert.ok(calls.some((call) => call.command === "gh" && call.args.includes(`sha=${commit}`)));
  assert.ok(calls.some((call) => call.args.includes("--include-attestations")));
  for (const directory of scratchDirectories) assert.equal(existsSync(directory), false);
  const fetcher = makeFetcher(() => "[]");
  assert.deepEqual(fetcher.npmVersions(name), []);
});

test("adapter refuses bad coordinate, unreadable tags and cleans up failing process calls", () => {
  const commit = "a".repeat(40);
  assert.throws(() => makeRepairClient(() => "{}").npmEvidence(name, version), /coordinate mismatch/);
  const directories: string[] = [];
  const failing = makeRepairClient((command, args, options = {}) => {
    if (command === "npm" && args[0] === "view") return JSON.stringify({ name, version, gitHead: commit });
    if (options.cwd) directories.push(options.cwd);
    throw new Error("process failed");
  });
  assert.throws(() => failing.npmEvidence(name, version), /process failed/);
  assert.throws(() => failing.createRelease(slug, tag, "notes"), /process failed/);
  for (const directory of directories) assert.equal(existsSync(directory), false);
  assert.equal(makeRepairClient(() => "").remoteTag(".", tag), null);
  assert.equal(makeRepairClient(() => `${commit}\trefs/tags/${tag}\n${"b".repeat(40)}\trefs/tags/${tag}^{}\n`).remoteTag(".", tag), "b".repeat(40));
  for (const output of [`short\trefs/tags/${tag}`, `${commit}\trefs/heads/main`]) assert.throws(() => makeRepairClient(() => output).remoteTag(".", tag), /unreadable/);
  assert.equal(makeRepairClient(() => "output\n").git(".", ["status"]), "output");
  // Construct the production boundary without running any network command.
  assert.equal(typeof makeRepairClient().npmEvidence, "function");
});

test("entry point requires exact repair flag and injects the hermetic client", async () => {
  const f = await fixture();
  const moduleUrl = import.meta.resolve("../scripts/verify-release-completeness.ts");
  const script = new URL(moduleUrl).pathname;
  const oldCode = process.exitCode;
  const oldWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    for (const flags of [["--repai"], ["--repair", "--repair"], ["--repair=false"]]) {
      assert.equal(runIfMain(["node", script, ...flags], moduleUrl, f.cwd, f.fetcher, f.client), true);
      assert.equal(process.exitCode, 1);
      assert.deepEqual(f.writes, []);
    }
    process.exitCode = oldCode;
    assert.equal(runIfMain(["node", script, "--repair"], moduleUrl, f.cwd, f.fetcher, f.client), true);
    assert.deepEqual(f.writes, [`release ${tag}`]);
    f.fetcher.remoteUrl = () => "https://notgithub.com/example/package";
    runIfMain(["node", script, "--repair"], moduleUrl, f.cwd, f.fetcher);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(auditReleaseCompleteness([tag], [version], [tag]).failures, []);
  } finally { process.stdout.write = oldWrite; process.exitCode = oldCode; f.cleanup(); }
});


test("recorded historical npm audit proves signed source and refuses registry gitHead drift", () => {
  const output = readFileSync(new URL("./fixtures/npm-signature-audit.json", import.meta.url), "utf8");
  const signed = "c7da4bf04039c3e0543026d003e9ee7bcd8615cd";
  assert.deepEqual(evidenceFromAudit("pm-ops", version, signed, output), {
    name: "pm-ops", version, gitHead: signed, commit: signed, repository: "unbraind/pm-ops",
  });
  const publishedGitHead = "5b6fbe73b7072d49c41d5cb3cad4d44142f3fe4a";
  assert.throws(() => evidenceFromAudit("pm-ops", version, publishedGitHead, output), /gitHead does not match/);
});


test("built package repairs a published orphan beside a real scratch pm tracker", async () => {
  const f = await fixture({ tag: false });
  try {
    const result = repairBuiltPackage(f.cwd, f.fetcher, f.client);
    assert.deepEqual(result.failures, [], JSON.stringify(result));
    assert.equal(f.writes.join(","), `tag ${tag},release ${tag}`);
    assert.ok(existsSync(join(f.cwd, ".agents/pm/settings.json")));
  } finally { f.cleanup(); }
});


test("an absent remote cannot authorize a conflicting local release tag", async () => {
  const f = await fixture();
  try {
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "-d", `refs/tags/${tag}`]);
    f.evidence.gitHead = f.evidence.commit = "a".repeat(40);
    assert.match(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures[0]!, /local tag and attested gitHead mismatch/);
    assert.equal(f.writes.length, 0);
  } finally { f.cleanup(); }
});

test("remote tag reads refuse option-shaped and non-release coordinates before git runs", () => {
  const calls: string[][] = [];
  const client = makeRepairClient((_command, args) => { calls.push([...args]); return ""; });
  for (const hostile of ["--upload-pack=touch /tmp/pwned", "-c", "main", "v1.0.0;rm -rf /"]) {
    assert.throws(() => client.remoteTag(process.cwd(), hostile), /unsupported release coordinate/);
  }
  assert.deepEqual(calls, []);
});

test("release-note headings are matched in linear time on long runs of spaces", () => {
  const hostile = `## ${version}${" ".repeat(50_000)}x\n\nbody\n`;
  const started = performance.now();
  assert.throws(() => committedReleaseNotes(hostile, version), /exactly one section/);
  assert.ok(performance.now() - started < 1_000, "heading parsing must not backtrack quadratically");
  assert.equal(committedReleaseNotes(`## ${version} - 2026-10-08\n\nnotes\n`, version), "notes\n");
});

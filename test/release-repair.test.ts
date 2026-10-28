/** Hermetic release recovery with a real pm tracker, local git remote, and recorded npm output shape. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "../subprocess.ts";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tarball, type TarMember } from "./tar-fixtures.ts";
import { TarballRefusal } from "../canonical-tar.ts";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { create, init } from "@unbrained/pm-cli/sdk";
import { auditReleaseCompleteness, defaultExec, makeFetcher, verify, type CompletenessFetcher } from "../release-completeness.ts";
import { repairReleaseCompleteness as repairBuiltPackage } from "../dist/release-repair.js";
import { committedReleaseNotes, evidenceFromAudit, makeRepairClient, releaseNotesFor, repairReleaseCompleteness, verifyReleaseSource, type NpmEvidence, type ProvenanceStatement, type RepairClient, type RepairExecutor } from "../release-repair.ts";
import { runIfMain } from "../scripts/verify-release-completeness.ts";

const tag = "v2026.08.28";
const version = "2026.8.28";
const slug = "example/sample-package";
const name = "sample-package";
/** Registry integrity of the synthetic tarball named by the fixture's provenance subject. */
const integrity = "sha512-Kk6OxbU5i0ZZwaNkazRPhtPAMasZfSjXeL0CYunbXMdo1rLofByZ+zmZOHHLkGqrrOyealLfu+6t4h6sHJhSAg==";
const changelog = "# Changelog\n\n## 2026.8.28 - 2026-08-28\n\n### Fixed\n\n- Committed recovery notes.\n\n## 2026.8.27 - 2026-08-27\n\n- Earlier release.\n";
const recorded = JSON.parse(readFileSync(new URL("./fixtures/release-provenance.json", import.meta.url), "utf8")) as {
  name: string; version: string; gitHead: string; invalid: unknown[];
  verified: { name: string; version: string; registry: string; attestationBundles: { predicateType: string; bundle: { dsseEnvelope: { payload: string } } }[] }[];
  statement: ProvenanceStatement & { subject: { name: string; digest: { sha512: string } }[] };
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

/** Bind synthetic signed registry metadata to a real archive and real npm/tar execution. */
function realArchiveClient(commit: string, registry: string, integrity: string, execute: RepairExecutor = defaultExec): RepairClient {
  return makeRepairClient((command, args, options = {}) => {
    if (command === "npm") {
      switch (args[0]) {
        case "view": return JSON.stringify({ name, version, gitHead: commit, dist: { integrity } });
        case "install": return "";
        case "audit": return auditOutput(commit, (record) => { record.statement.subject[0]!.digest.sha512 = Buffer.from(integrity.slice(7), "base64").toString("hex"); });
        case "pack": if (args[1] === `${name}@${version}`) return execute(command, ["pack", registry, ...args.slice(2)], options);
      }
    }
    return execute(command, args, options);
  });
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
  // A fixed identity keeps fixture commits independent of the runner's git configuration.
  const env = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
  const git = (args: string[]): string => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
  git(["add", "package.json", "CHANGELOG.md"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "release fixture"]);
  const commit = git(["rev-parse", "HEAD"]);
  git(["push", "-q", "origin", "HEAD:main"]);
  if (options.tag !== false) { git(["tag", tag]); git(["push", "-q", "origin", `refs/tags/${tag}`]); }
  const versions = [version];
  const releases = new Set(options.release ? [tag] : []);
  const writes: string[] = [];
  const bodies: string[] = [];
  const evidence: NpmEvidence = evidenceFromAudit(name, version, commit, auditOutput(commit), integrity);
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
    verifyTarball: () => {},
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

test("a drift-window release commit without its own section recovers notes from the audit-time committed changelog", async () => {
  // The 2026.10.20 shape: the release commit was created during the
  // changelog generation-drift window, so its own changelog has no section
  // for the released version, while a later commit restored the section.
  const drifted = "# Changelog\n\n## 2026.8.27 - 2026-08-27\n\n- Earlier release.\n";
  const f = await fixture({ changelog: drifted });
  try {
    writeFileSync(join(f.cwd, "CHANGELOG.md"), changelog);
    f.git(["add", "CHANGELOG.md"]);
    f.git(["commit", "-qm", "restore the drifted changelog sections"]);
    // Uncommitted working-tree state is never a note source, on either path.
    writeFileSync(join(f.cwd, "CHANGELOG.md"), "uncommitted notes must not be used");
    const repaired = repairReleaseCompleteness(f.cwd, f.fetcher, f.client);
    assert.deepEqual(repaired.failures, [], JSON.stringify(repaired));
    assert.deepEqual(f.writes, [`release ${tag}`]);
    assert.deepEqual(f.bodies, ["### Fixed\n\n- Committed recovery notes.\n"]);
    // The resolver returns the same committed notes for this drift shape, and
    // the working-tree edit above was never read on either path.
    assert.equal(releaseNotesFor(f.cwd, f.commit, version, f.client), "### Fixed\n\n- Committed recovery notes.\n");
  } finally { f.cleanup(); }
});

test("a release missing its section in both committed changelogs still refuses before writes", async () => {
  const f = await fixture({ changelog: "# no notes" });
  try {
    const result = repairReleaseCompleteness(f.cwd, f.fetcher, f.client);
    assert.match(result.failures[0]!, /release repair refused: committed changelog must have exactly one section for 2026\.8\.28/);
    assert.match(result.failures[0]!, /the release commit's changelog/);
    assert.match(result.failures[0]!, /the audit-time committed changelog/);
    assert.deepEqual(f.writes, []);
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
      // A failed create call is never reported as a repair this run made.
      assert.ok(!result.notes.some((note) => note.startsWith("repaired ")), result.notes.join("; "));
      if (succeeds) {
        assert.ok(result.notes.includes(`tag ${tag} confirmed at the planned commit after a failed create call`), result.notes.join("; "));
        assert.ok(result.notes.includes(`GitHub Release ${tag} confirmed present after a failed create call`), result.notes.join("; "));
      }
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
  assert.equal(evidenceFromAudit(name, version, commit, auditOutput(commit), integrity).commit, commit);
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
    (f: typeof recorded) => { f.statement.predicate.buildDefinition.resolvedDependencies = []; },
    (f: typeof recorded) => { delete f.statement.predicate.buildDefinition.externalParameters; },
    (f: typeof recorded) => { f.statement.subject = []; },
    (f: typeof recorded) => { f.statement.subject.push(structuredClone(f.statement.subject[0]!)); },
    (f: typeof recorded) => { f.statement.subject[0]!.name = "pkg:npm/other-package@2026.8.28"; },
    (f: typeof recorded) => { f.statement.subject[0]!.digest.sha512 = "0".repeat(128); },
    (f: typeof recorded) => { f.statement.predicate.buildDefinition.externalParameters!.workflow!.path = ".github/workflows/other.yml"; },
    (f: typeof recorded) => { f.statement.predicate.buildDefinition.externalParameters!.workflow!.ref = "refs/heads/feature"; },
    (f: typeof recorded) => { delete f.statement.predicate.buildDefinition.externalParameters!.workflow!.repository; },
    (f: typeof recorded) => { f.statement.predicate.buildDefinition.externalParameters!.workflow!.repository = "https://github.com/example/other-package"; },
    (f: typeof recorded) => { f.statement.predicate.buildDefinition.resolvedDependencies.push(structuredClone(f.statement.predicate.buildDefinition.resolvedDependencies[0]!)); },
  ]) assert.throws(() => evidenceFromAudit(name, version, commit, auditOutput(commit, change), integrity));
  assert.throws(() => evidenceFromAudit(name, version, "short", auditOutput(commit), integrity));
  assert.throws(() => evidenceFromAudit(name, version, commit, "not JSON", integrity));
  assert.throws(() => evidenceFromAudit(name, version, commit, auditOutput(commit), ""), /provenance subject/);
  assert.throws(() => evidenceFromAudit(name, version, commit, auditOutput(commit), integrity.replace("sha512-", "sha1-")), /provenance subject/);
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
      if (args[0] === "view") return JSON.stringify({ name, version, gitHead: commit, dist: { integrity } });
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

test("scoped packages bind the percent-encoded purl subject", () => {
  const commit = "a".repeat(40);
  const scoped = "@example/sample-package";
  /** Rename the audited coordinate and its subject to the scoped package. */
  const rename = (subject: string) => (f: typeof recorded) => { f.verified[0]!.name = scoped; f.statement.subject[0]!.name = subject; };
  assert.equal(evidenceFromAudit(scoped, version, commit, auditOutput(commit, rename(`pkg:npm/%40example/sample-package@${version}`)), integrity).commit, commit);
  assert.throws(() => evidenceFromAudit(scoped, version, commit, auditOutput(commit, rename(`pkg:npm/@example/sample-package@${version}`)), integrity), /provenance subject/);
});

test("adapter refuses bad coordinate, unreadable tags and cleans up failing process calls", () => {
  const commit = "a".repeat(40);
  assert.throws(() => makeRepairClient(() => "{}").npmEvidence(name, version), /coordinate mismatch/);
  const directories: string[] = [];
  const failing = makeRepairClient((command, args, options = {}) => {
    if (command === "npm" && args[0] === "view") return JSON.stringify({ name, version, gitHead: commit, dist: { integrity } });
    if (options.cwd) directories.push(options.cwd);
    throw new Error("process failed");
  });
  assert.throws(() => failing.npmEvidence(name, version), /process failed/);
  // Registry metadata without dist.integrity cannot satisfy the tarball-digest binding.
  const withoutIntegrity = makeRepairClient((command, args) => {
    if (command === "npm" && args[0] === "view") return JSON.stringify({ name, version, gitHead: commit });
    return command === "npm" && args[0] === "audit" ? auditOutput(commit) : "";
  });
  assert.throws(() => withoutIntegrity.npmEvidence(name, version), /provenance subject/);
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


test("recorded historical npm audit retains distinct signed source and registry release commits", () => {
  const output = readFileSync(new URL("./fixtures/npm-signature-audit.json", import.meta.url), "utf8");
  const signed = "c7da4bf04039c3e0543026d003e9ee7bcd8615cd";
  // Registry dist.integrity of pm-ops@2026.8.28; the recorded subject digest is its hex form.
  const registryIntegrity = "sha512-NQXbnyrCj0is2vHKjBTMisFIVFjMdDdulzlsz1dEW1UphdwPpeoraJeO10DF5oTy/i15eORQvbwdsDGpV1Cw2w==";
  assert.deepEqual(evidenceFromAudit("pm-ops", version, signed, output, registryIntegrity), {
    name: "pm-ops", version, gitHead: signed, commit: signed, repository: "unbraind/pm-ops",
  });
  const publishedGitHead = "5b6fbe73b7072d49c41d5cb3cad4d44142f3fe4a";
  assert.equal(evidenceFromAudit("pm-ops", version, publishedGitHead, output, registryIntegrity).commit, signed);
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
    assert.match(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures[0]!, /local tag and npm gitHead mismatch/);
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

test("release audit accepts an attested ancestor and refuses a planted unrelated commit before repair", async () => {
  const f = await fixture();
  try {
    f.git(["commit", "--allow-empty", "-qm", "release metadata", "--author=Fixture <fixture@example.test>"]);
    const release = f.git(["rev-parse", "HEAD"]);
    f.git(["tag", "-f", tag]);
    f.git(["push", "-q", "origin", `+refs/tags/${tag}`]);
    Object.assign(f.evidence, evidenceFromAudit(name, version, release, auditOutput(f.commit), integrity));
    let comparisons = 0; f.client.verifyTarball = () => { comparisons++; };
    assert.deepEqual(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures, []);
    assert.equal(comparisons, 1); assert.deepEqual(f.writes, [`release ${tag}`]);
    const unrelated = f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit-tree", "HEAD^{tree}", "-m", "unrelated source"]);
    f.evidence.commit = unrelated; f.releases.clear(); f.writes.length = 0;
    assert.throws(() => verifyReleaseSource(f.cwd, release, f.evidence, f.client));
    assert.equal(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures.length, 1);
    assert.equal(comparisons, 1); assert.deepEqual(f.writes, []);
    const sibling = f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit-tree", "HEAD^{tree}", "-p", f.commit, "-m", "sibling source"]);
    assert.throws(() => verifyReleaseSource(f.cwd, release, { ...f.evidence, commit: sibling }, f.client), /not an ancestor/);
    f.evidence.commit = f.commit; f.client.verifyTarball = () => { throw new Error("published tarball does not match release tag tree"); };
    assert.match(repairReleaseCompleteness(f.cwd, f.fetcher, f.client).failures[0]!, /tarball does not match/);
    assert.deepEqual(f.writes, []);
  } finally { f.cleanup(); }
});

test("tarball comparison binds verified integrity and complete real archive manifests and cleans every refusal", () => {
  const commit = "a".repeat(40);
  for (const mode of ["ok", "no-evidence", "empty", "filename", "digest", "unsafe", "dotdot", "bytes", "members", "mode", "integrity"] as const) {
    const directories = new Set<string>();
    const original = tarball([{ path: "package/package.json", body: Buffer.from([255, 0, 65]) }]);
    const signedIntegrity = `sha512-${createHash("sha512").update(original).digest("base64")}`;
    const client = makeRepairClient((command, args, options = {}) => {
      if (options.cwd && options.cwd !== ".") directories.add(options.cwd);
      if (command === process.execPath) return defaultExec(command, args, options);
      if (command === "npm") {
        if (args[0] === "view") return JSON.stringify({ name, version, gitHead: commit, dist: { integrity: signedIntegrity } });
        if (args[0] === "audit") return auditOutput(commit, (f) => { f.statement.subject[0]!.digest.sha512 = Buffer.from(signedIntegrity.slice(7), "base64").toString("hex"); });
        if (args[0] === "pack") {
          assert.ok(args.includes("--ignore-scripts"));
          const actual = args[1] === `${name}@${version}`;
          const members: TarMember[] = [{ path: mode === "unsafe" ? "/bad" : mode === "dotdot" ? "package/../bad" : "package/package.json",
            body: actual && mode === "bytes" ? Buffer.from([255, 0, 66]) : Buffer.from([255, 0, 65]), mode: actual && mode === "mode" ? 493 : 420 }];
          if (actual && mode === "members") members.push({ path: "package/extra.txt" });
          const bytes = actual && mode === "integrity" ? tarball([{ path: "package/other" }]) : tarball(members);
          const filename = "sample.tgz"; writeFileSync(join(options.cwd!, filename), bytes);
          return JSON.stringify(mode === "empty" ? [] : [{ filename: mode === "filename" ? "../bad.tgz" : filename,
            integrity: mode === "digest" ? "sha512-wrong" : `sha512-${createHash("sha512").update(bytes).digest("base64")}` }]);
        }
      }
      return "";
    });
    if (mode === "no-evidence") assert.throws(() => client.verifyTarball(".", commit, { name, version, gitHead: commit, commit, repository: slug }), /requires verified/);
    else {
      const evidence = client.npmEvidence(name, version);
      if (mode === "ok") client.verifyTarball(".", commit, evidence);
      else assert.throws(() => client.verifyTarball(".", commit, evidence), /unreadable|invalid_tarball|integrity mismatch|does not match/);
    }
    for (const directory of directories) assert.equal(existsSync(directory), false);
  }
});


for (const mismatch of [false, true]) {
  test(mismatch ? "real tarball refuses a mismatching 5 MiB member before repair" : "real tarball accepts a matching 5 MiB member without capturing its bytes", async () => {
    const f = await fixture();
    try {
      writeFileSync(join(f.cwd, "large.bin"), Buffer.alloc(5 * 1024 * 1024, 0xa5));
      writeFileSync(join(f.cwd, "package.json"), JSON.stringify({ name, version, repository: `https://github.com/${slug}`, files: ["large.bin", "CHANGELOG.md"] }));
      const sentinel = join(f.root, "sentinel"); writeFileSync(sentinel, "unchanged fixture bytes");
      symlinkSync(sentinel, join(f.cwd, "member-bytes"));
      f.git(["add", "large.bin", "package.json", "member-bytes"]); f.git(["commit", "-qm", "large member fixture"]);
      const commit = f.git(["rev-parse", "HEAD"]);
      if (mismatch) writeFileSync(join(f.cwd, "large.bin"), Buffer.alloc(5 * 1024 * 1024, 0x5a));
      const [packed] = JSON.parse(defaultExec("npm", ["pack", ".", "--ignore-scripts", "--json"], { cwd: f.cwd })) as { filename: string; integrity: string }[];
      const tarball = join(f.root, "registry.tgz"); copyFileSync(join(f.cwd, packed.filename), tarball);
      let streamedMembers = 0; let capturedMembers = 0;
      const client = realArchiveClient(commit, tarball, packed.integrity, (command, args, options = {}) => {
        if (command === process.execPath) {
          if (options.stdoutFd === undefined) capturedMembers++;
          else streamedMembers++;
        }
        return defaultExec(command, args, options);
      });
      const evidence = client.npmEvidence(name, version);
      if (mismatch) assert.throws(() => client.verifyTarball(f.cwd, commit, evidence), /published tarball does not match/);
      else client.verifyTarball(f.cwd, commit, evidence);
      assert.equal(readFileSync(sentinel, "utf8"), "unchanged fixture bytes", "staging never follows a source-tree symlink");
      assert.equal(capturedMembers, 0, "member data must never enter a capture buffer");
      assert.equal(streamedMembers, 2, "both complete archives must be decompressed through file descriptors");
      assert.deepEqual(f.writes, []);
    } finally { f.cleanup(); }
  });
}

test("seeded real npm tarball mutation fuzz refuses every class before repair (4 seeds)", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.cwd, "empty"), "");
    writeFileSync(join(f.cwd, "payload.bin"), Buffer.from([0, 255, 1, 254]));
    writeFileSync(join(f.cwd, "package.json"), JSON.stringify({ name, version, files: ["empty", "payload.bin", "CHANGELOG.md"] }));
    f.git(["add", "empty", "payload.bin", "package.json"]); f.git(["commit", "-qm", "canonical manifest fixture"]);
    const commit = f.git(["rev-parse", "HEAD"]);
    const [packed] = JSON.parse(defaultExec("npm", ["pack", ".", "--ignore-scripts", "--json"], { cwd: f.cwd })) as { filename: string }[];
    const original = readFileSync(join(f.cwd, packed.filename));
    const uncompressed = gunzipSync(original);
    const members: TarMember[] = [];
    for (let offset = 0; uncompressed[offset] !== 0; ) {
      const header = uncompressed.subarray(offset, offset + 512);
      const path = header.subarray(0, 100).toString().split("\0")[0]!;
      const size = Number.parseInt(header.subarray(124, 136).toString(), 8);
      assert.equal(header[156], 48, "npm baseline consists of regular files");
      members.push({ path, mode: Number.parseInt(header.subarray(100, 108).toString(), 8), body: uncompressed.subarray(offset + 512, offset + 512 + size) });
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    const registry = join(f.root, "registry.tgz");
    for (let seed = 1; seed <= 4; seed++) {
      const empty = members.findIndex((entry) => entry.path === "package/empty");
      const payload = members.findIndex((entry) => entry.path === "package/payload.bin");
      const body = Buffer.from(members[payload]!.body!); body[(Math.imul(seed, 1664525) >>> 0) % body.length] ^= 0xff;
      const mutations: [string, TarMember[]][] = [
        ["unmutated", members],
        ["type swap", members.map((entry, i) => i === empty ? { ...entry, type: "2", link: "target-a" } : entry)],
        ["link target change", members.map((entry, i) => i === empty ? { ...entry, type: "2", link: `target-${seed}` } : entry)],
        ["mode change", members.map((entry, i) => i === empty ? { ...entry, mode: 0o755 } : entry)],
        ["extra entry", [...members, { path: `package/extra-${seed}` }]],
        ["missing entry", members.filter((_, i) => i !== payload)],
        ["duplicate path", [...members, members[empty]!]],
        ["path traversal", [...members, { path: "package/../escape" }]],
        ["normalization collision", [...members, { path: "package/EMPTY" }]],
        ["content change at equal size", members.map((entry, i) => i === payload ? { ...entry, body } : entry)],
        ["empty vs missing", members.filter((_, i) => i !== empty)],
      ];
      for (const [kind, changed] of mutations) {
        const bytes = tarball(changed); writeFileSync(registry, bytes);
        const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
        const client = realArchiveClient(commit, registry, integrity);
        const evidence = client.npmEvidence(name, version);
        if (kind === "unmutated") client.verifyTarball(f.cwd, commit, evidence);
        else assert.throws(() => client.verifyTarball(f.cwd, commit, evidence), (error: unknown) => error instanceof TarballRefusal || /published tarball does not match/.test(String(error)), `seed ${seed}: ${kind}`);
        assert.deepEqual(f.writes, [], "verification never writes tags or releases");
      }
    }
  } finally { f.cleanup(); }
});

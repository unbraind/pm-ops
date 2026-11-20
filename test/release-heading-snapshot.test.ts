/** Verify disposable release candidates preserve the reviewed source snapshot. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "../subprocess.ts";
import { mirrorTrackedSnapshot } from "./release-heading-snapshot-fixture.ts";

/** Seed independent source and candidate checkouts with the same committed files. */
function snapshotFixture(t: TestContext, files: string[]) {
  const root = mkdtempSync(join(tmpdir(), "heading-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), candidate = join(root, "candidate");
  const env = { ...process.env, GIT_AUTHOR_DATE: "2026-11-06T12:00:00Z", GIT_COMMITTER_DATE: "2026-11-06T12:00:00Z" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env });
  mkdirSync(source);
  git(source, "init", "--quiet");
  for (const file of files) {
    const path = join(source, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "committed\n");
  }
  git(source, "add", "--", ...files);
  git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Snapshot fixture");
  git(root, "clone", "--quiet", "--shared", source, candidate);
  return { source, candidate, env, git };
}

test("candidate snapshot removes staged and unstaged deletions and copies existing tracked edits", t => {
  const { source, candidate, env, git } = snapshotFixture(t, ["staged.txt", "unstaged.txt", "index-only.txt", "kept.txt"]);
  git(source, "rm", "--quiet", "--", "staged.txt");
  git(source, "rm", "--quiet", "--cached", "--", "index-only.txt");
  rmSync(join(source, "unstaged.txt"));
  writeFileSync(join(source, "kept.txt"), "reviewed edit\n");
  const added = ".github/workflows/added.yml";
  mkdirSync(join(source, dirname(added)), { recursive: true });
  writeFileSync(join(source, added), "staged addition\n");
  git(source, "add", "--", added);
  mirrorTrackedSnapshot(source, candidate, env);
  assert.equal(existsSync(join(candidate, "staged.txt")), false);
  assert.equal(existsSync(join(candidate, "unstaged.txt")), false);
  assert.equal(existsSync(join(source, "index-only.txt")), true);
  assert.equal(existsSync(join(candidate, "index-only.txt")), false);
  assert.equal(readFileSync(join(candidate, "kept.txt"), "utf8"), "reviewed edit\n");
  assert.equal(readFileSync(join(candidate, added), "utf8"), "staged addition\n");
  assert.deepEqual(git(candidate, "ls-files", "-z").toString().split("\0").filter(Boolean), [added, "kept.txt"]);
});

test("candidate snapshot replaces a tracked directory with a staged regular file", t => {
  const { source, candidate, env, git } = snapshotFixture(t, ["replaced/child.txt"]);
  git(source, "rm", "--quiet", "--", "replaced/child.txt");
  writeFileSync(join(source, "replaced"), "new contents\n");
  git(source, "add", "--", "replaced");
  mirrorTrackedSnapshot(source, candidate, env);
  assert.equal(readFileSync(join(candidate, "replaced"), "utf8"), "new contents\n");
});

test("a tracked child under a directory replaced by an untracked file is absent", t => {
  const { source, candidate, env, git } = snapshotFixture(t, ["replaced/child.txt", "keep.txt"]);
  rmSync(join(source, "replaced"), { recursive: true });
  writeFileSync(join(source, "replaced"), "untracked replacement\n");
  mirrorTrackedSnapshot(source, candidate, env);
  assert.deepEqual(git(candidate, "ls-files", "-z").toString().split("\0").filter(Boolean), ["keep.txt"]);
  assert.equal(existsSync(join(candidate, "replaced/child.txt")), false);
  assert.equal(readFileSync(join(source, "replaced"), "utf8"), "untracked replacement\n");
});

test("an untracked directory replacing an indexed file is absent from the candidate", t => {
  const { source, candidate, env } = snapshotFixture(t, ["item"]);
  rmSync(join(source, "item"));
  mkdirSync(join(source, "item"));
  writeFileSync(join(source, "item/local.txt"), "untracked");
  mirrorTrackedSnapshot(source, candidate, env);
  assert.equal(existsSync(join(candidate, "item")), false);
  assert.equal(readFileSync(join(source, "item/local.txt"), "utf8"), "untracked");
});

test("candidate snapshot refuses a staged dangling symlink", t => {
  const { source, candidate, env, git } = snapshotFixture(t, ["keep.txt"]);
  symlinkSync("missing-target", join(source, "link"), "file");
  git(source, "add", "--", "link");
  assert.throws(() => mirrorTrackedSnapshot(source, candidate, env), /Cannot mirror tracked symbolic link: link/);
  assert.equal(git(candidate, "status", "--porcelain").toString(), "");
});

test("candidate snapshot refuses an unstaged symlink replacing a tracked ancestor", t => {
  const file = "replaced/nested/child.txt";
  const { source, candidate, env, git } = snapshotFixture(t, [file, "keep.txt"]);
  const replacement = join(dirname(source), "replacement");
  mkdirSync(join(replacement, "nested"), { recursive: true });
  writeFileSync(join(replacement, "nested/child.txt"), "replacement contents\n");
  rmSync(join(source, "replaced"), { recursive: true });
  symlinkSync(replacement, join(source, "replaced"), "junction");
  writeFileSync(join(source, "keep.txt"), "reviewed edit\n");
  assert.throws(() => mirrorTrackedSnapshot(source, candidate, env), /Cannot mirror tracked symbolic link: replaced/);
  assert.equal(readFileSync(join(candidate, file), "utf8"), "committed\n");
  assert.equal(git(candidate, "status", "--porcelain").toString(), "");
});

test("invalid UTF-8 in either index aborts before the candidate changes", t => {
  for (const checkout of ["source", "candidate"] as const) {
    const fixture = snapshotFixture(t, ["keep.txt"]);
    const cwd = fixture[checkout];
    const blob = fixture.git(cwd, "rev-parse", "HEAD:keep.txt").toString().trim();
    execFileSync("git", ["update-index", "-z", "--index-info"], {
      cwd, env: fixture.env, input: Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from([0xff, 0])]),
    });
    assert.deepEqual(fixture.git(fixture[checkout], "ls-files", "-z").subarray(-2), Buffer.from([0xff, 0]));
    assert.equal(readdirSync(fixture[checkout], { encoding: "buffer" }).some(name => name.includes(0xff)), false);
    writeFileSync(join(fixture.source, "keep.txt"), "new contents");
    assert.throws(() => mirrorTrackedSnapshot(fixture.source, fixture.candidate, fixture.env), /utf-8/i);
    assert.equal(readFileSync(join(fixture.candidate, "keep.txt"), "utf8"), "committed\n");
  }
});

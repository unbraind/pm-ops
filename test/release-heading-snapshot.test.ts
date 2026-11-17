/** Verify disposable release candidates preserve the reviewed source snapshot. */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "../subprocess.ts";
import { mirrorTrackedSnapshot } from "./release-heading-snapshot-fixture.ts";

test("candidate snapshot removes staged and unstaged deletions and copies existing tracked edits", () => {
  const root = mkdtempSync(join(tmpdir(), "heading-snapshot-"));
  const source = join(root, "source"), candidate = join(root, "candidate");
  const env = { ...process.env, GIT_AUTHOR_DATE: "2026-11-06T12:00:00Z", GIT_COMMITTER_DATE: "2026-11-06T12:00:00Z" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env });
  try {
    mkdirSync(source);
    git(source, "init", "--quiet");
    for (const file of ["staged.txt", "unstaged.txt", "kept.txt"]) writeFileSync(join(source, file), "committed\n");
    git(source, "add", "--", "staged.txt", "unstaged.txt", "kept.txt");
    git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Snapshot fixture");
    git(root, "clone", "--quiet", "--shared", source, candidate);
    git(source, "rm", "--quiet", "--", "staged.txt");
    rmSync(join(source, "unstaged.txt"));
    writeFileSync(join(source, "kept.txt"), "reviewed edit\n");
    writeFileSync(join(source, "added.txt"), "staged addition\n");
    git(source, "add", "--", "added.txt");
    mirrorTrackedSnapshot(source, candidate, env);
    assert.equal(existsSync(join(candidate, "staged.txt")), false);
    assert.equal(existsSync(join(candidate, "unstaged.txt")), false);
    assert.equal(readFileSync(join(candidate, "kept.txt"), "utf8"), "reviewed edit\n");
    assert.equal(readFileSync(join(candidate, "added.txt"), "utf8"), "staged addition\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

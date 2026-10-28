/** Release-window cardinality properties and real CLI policy integration. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createChangelog, resolveReleaseTagWindows, type PmItem } from "pm-changelog";
import { execFileSync } from "../subprocess.ts";
import { committedReleaseNotes } from "../release-repair.ts";
import { describeEmptyReleases, runChangelog } from "../scripts/pm-changelog.ts";
import { verify as verifySections } from "../scripts/verify-release-changelog-sections.ts";

/** Read the actual repository commands so reverting their policy breaks the proof. */
const scripts = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
/** Tags deliberately include consecutive empty windows and a same-day suffix. */
const tags = ["v2026.10.18", "v2026.10.19", "v2026.10.20", "v2026.10.20-1", "v2026.10.21", "v2026.10.22"];
/** CLI path remains pinned even when the fixture has no node_modules. */
const pm = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
/** Read tag headings without counting the independent Unreleased window. */
function versions(markdown: string): string[] {
  return [...markdown.matchAll(/^## (\d[^ ]*) - /gm)].map(match => match[1]!);
}

/** Initialize a real tracker outside Git, with explicit isolated CLI settings. */
function tracker(): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "changelog-sections-"));
  const env = { ...process.env, PM_PATH: join(root, ".agents/pm"), PM_AUTHOR: "fixture-agent", GIT_CEILING_DIRECTORIES: dirname(root) };
  execFileSync(process.execPath, [pm, "init", "--defaults", "--agent-guidance", "skip", "--prefix", "sample"], { cwd: root, env });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sample-changelog", version: "2026.10.22" }));
  return { root, env };
}

/** Create real, chronologically ordered Git release windows without touching the source repository. */
function releaseTags(root: string, env: NodeJS.ProcessEnv): void {
  execFileSync("git", ["init", "-q"], { cwd: root, env });
  tags.forEach((tag, index) => {
    const dated = { ...env, GIT_AUTHOR_DATE: `2026-10-${18 + index}T12:00:00Z`, GIT_COMMITTER_DATE: `2026-10-${18 + index}T12:00:00Z` };
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Release fixture"], { cwd: root, env: dated });
    execFileSync("git", ["tag", tag], { cwd: root, env });
  });
}

/** Reuse configured generator arguments while locating the pinned CLI in the source checkout. */
function args(name: string): string[] {
  return scripts[name]!.split(" ").slice(2).map(arg => arg === "./node_modules/.bin/pm" ? pm : arg);
}

test("all 64 item-presence combinations retain one ordered section per real tag and satisfy repair's note check", () => {
  const { root, env } = tracker();
  try {
    releaseTags(root, env);
    const releaseWindows = resolveReleaseTagWindows({ cwd: root, pendingVersion: "2026.10.22" });
    for (let mask = 0; mask < 2 ** tags.length; mask++) {
      const items: PmItem[] = tags.flatMap((tag, index) => mask & (1 << index)
        ? [{ id: `sample-${index}`, title: `Tracked change ${index}`, status: "closed", release: tag, completed_at: "2026-10-25T00:00:00Z" }]
        : []);
      const generated = createChangelog({ items, releaseWindows, includeEmpty: args("changelog:full").includes("--include-empty"), respectItemRelease: true });
      const markdown = describeEmptyReleases(generated.markdown);
      assert.deepEqual(versions(markdown), [...tags].reverse().map(tag => tag.slice(1)), `mask ${mask}`);
      tags.forEach((tag, index) => {
        const notes = committedReleaseNotes(markdown, tag.slice(1));
        if (mask & (1 << index)) assert.match(notes, new RegExp(`Tracked change ${index}`));
        else assert.equal(notes, "No tracked changes.\n");
      });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("full, check, prepend, pending release and notes share the policy over a real tracker", () => {
  const { root, env } = tracker();
  try {
    releaseTags(root, env);
    for (const [id, release] of [["a", tags[0]!], ["b", tags[3]!]]) {
      execFileSync(process.execPath, [pm, "create", "task", `Tracked release ${id}`, "--id", `sample-${id}`, "--status", "closed", "--close-reason", "Fixture complete", "--release", release], { cwd: root, env });
    }
    assert.equal(runChangelog(args("changelog:full"), root, env), 0);
    const output = join(root, "CHANGELOG.md");
    const generated = readFileSync(output, "utf8");
    assert.deepEqual(versions(generated), [...tags].reverse().map(tag => tag.slice(1)));
    assert.equal(committedReleaseNotes(generated, "2026.10.19"), "No tracked changes.\n");
    assert.match(committedReleaseNotes(generated, "2026.10.20-1"), /Tracked release b/);
    assert.equal(runChangelog(args("changelog:check"), root, env), 0);
    writeFileSync(output, generated + "drift\n");
    assert.equal(runChangelog(args("changelog:check"), root, env), 1);
    assert.equal(readFileSync(output, "utf8"), generated + "drift\n", "check must not write");
    writeFileSync(output, generated);
    assert.equal(runChangelog(args("changelog"), root, env), 0);
    assert.equal(runChangelog(args("changelog"), root, env), 0);
    assert.equal(readFileSync(output, "utf8"), generated, "prepend must be idempotent");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sample-changelog", version: "2026.10.23" }));
    assert.equal(runChangelog(args("changelog:full"), root, env), 0);
    assert.equal(committedReleaseNotes(readFileSync(output, "utf8"), "2026.10.23"), "No tracked changes.\n");
    const summary = join(root, "summary.md");
    const script = resolve("scripts/pm-changelog.ts");
    const notes = execFileSync(process.execPath, [script, ...args("release:notes")], { cwd: root, env: { ...env, GITHUB_STEP_SUMMARY: summary }, encoding: "utf8" });
    assert.equal(committedReleaseNotes(notes, "2026.10.23"), "No tracked changes.\n");
    assert.equal(readFileSync(summary, "utf8"), notes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tag generation refuses a plain tracker clearly while item generation works with no Git on PATH", () => {
  const { root, env } = tracker();
  try {
    assert.throws(() => runChangelog(args("changelog:full"), root, env), /need a git repository.*Generate from tracker items/);
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    const noGit = { ...env, PATH: bin };
    assert.throws(() => runChangelog(args("changelog:full"), root, noGit), /need a git repository/);
    assert.equal(runChangelog(["--pm-root", ".agents/pm", "--pm-bin", pm, "--include-empty", "--version", "2026.10.22"], root, noGit), 0);
    assert.equal(committedReleaseNotes(readFileSync(join(root, "CHANGELOG.md"), "utf8"), "2026.10.22"), "No tracked changes.\n");
    assert.deepEqual(verifySections(root, []).failures, [], "an explicit empty historical inventory still checks the pending version without Git");
    assert.match(verifySections(root).failures[0]!, /git repository/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release commits stay current after tagging, including empty and same-day releases", () => {
  const { root, env } = tracker();
  try {
    releaseTags(root, env);
    for (const [version, completed, committed] of [
      ["2026.10.23", "2026-10-23T13:00:00Z", "2026-10-23T14:00:00Z"],
      ["2026.10.23-1", "2026-10-23T15:00:00Z", "2026-10-23T16:00:00Z"],
      ["2026.10.24", "", "2026-10-24T12:00:00Z"],
    ]) {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sample-changelog", version }));
      if (completed) execFileSync(process.execPath, [pm, "create", "task", `Shipped in ${version}`, "--id", `sample-${version!.replaceAll(".", "-")}`, "--status", "closed", "--close-reason", "Fixture complete", "--completed-at", completed], { cwd: root, env });
      assert.equal(runChangelog(args("changelog:full"), root, env), 0);
      const before = readFileSync(join(root, "CHANGELOG.md"), "utf8");
      const dated = { ...env, GIT_AUTHOR_DATE: committed, GIT_COMMITTER_DATE: committed };
      execFileSync("git", ["add", "--", "package.json", "CHANGELOG.md", ".agents/pm"], { cwd: root, env });
      execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Release fixture"], { cwd: root, env: dated });
      execFileSync("git", ["tag", `v${version}`], { cwd: root, env });
      assert.equal(runChangelog(args("changelog:check"), root, env), 0, `${version} must pass after tagging`);
      assert.equal(runChangelog(args("changelog:full"), root, env), 0);
      assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), before, "tagging must not change generated bytes");
      const expected = [...tags.map(tag => tag.slice(1)), "2026.10.23", "2026.10.23-1", "2026.10.24"];
      assert.deepEqual(versions(before), expected.slice(0, expected.indexOf(version!) + 1).reverse());
      assert.doesNotMatch(before, /^## Unreleased$/m);
      assert.match(committedReleaseNotes(before, version!), completed ? /Shipped in/ : /^No tracked changes\.\n$/);
    }
    execFileSync(process.execPath, [pm, "create", "task", "Work completed after the tag", "--id", "sample-later", "--status", "closed", "--close-reason", "Fixture complete", "--completed-at", "2026-10-24T13:00:00Z"], { cwd: root, env });
    assert.equal(runChangelog(args("changelog:full"), root, env), 0);
    const later = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    assert.match(later, /^## Unreleased\n\n### Other\n\n- Work completed after the tag/m);
    assert.equal(runChangelog(args("changelog:check"), root, env), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release workflow uses the same npm policy for generation, drift checking and notes", () => {
  const workflow = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  const step = workflow.slice(workflow.indexOf("- name: Generate changelog"), workflow.indexOf("- name: Run release checks"));
  assert.match(step, /npm run changelog:full -- --github-step-summary/);
  assert.match(step, /npm run changelog:check/);
  assert.match(step, /npm run --silent release:notes > RELEASE_NOTES.md/);
});

test("empty wording leaves tracked prose alone and invalid adapter options fail before writing", () => {
  assert.equal(describeEmptyReleases("# Changelog\n\n## 1.0.0 - 2026-01-01\n\n- No changes.\n"), "# Changelog\n\n## 1.0.0 - 2026-01-01\n\n- No changes.\n");
  for (const invalid of [["--output"], ["--mode", "--check"], ["--mode", "invalid"]]) assert.throws(() => runChangelog(invalid));
  assert.throws(() => runChangelog(["--github-step-summary"], process.cwd(), {}), /requires GITHUB_STEP_SUMMARY/);
});

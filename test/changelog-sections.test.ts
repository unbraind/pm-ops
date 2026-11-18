/** Release-window cardinality properties and real CLI policy integration. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createChangelog, resolveReleaseTagWindows, type PmItem } from "pm-changelog";
import { execFileSync, spawnSync } from "../subprocess.ts";
import { committedReleaseNotes } from "../release-repair.ts";
import { describeEmptyReleases, runChangelog } from "../scripts/pm-changelog.ts";
import { verify as verifySections } from "../scripts/verify-release-changelog-sections.ts";
import { parse } from "yaml";
import { decideDailyRelease } from "../daily-release.ts";
import { runBashFixture } from "./bash-fixture.ts";
import { assertReleaseHeadingDate, includeEmptyReleaseSections, rewriteReleaseHeadingDate } from "../release-changelog-options.ts";

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

/** Match fixture tag and completion days to the date policy selected by preparation. */
function headingDay(version: string, command: string[]): string {
  const fallback = fallbackDateIndex(command);
  if (fallback >= 0) return command[fallback]!.split("=")[1] ?? command[fallback + 1]!;
  return version.split("-")[0]!.split(".").map((part, index) => part.padStart(index === 0 ? 4 : 2, "0")).join("-");
}

/** Find the first inline or separate fallback-date option in a fixture's arguments. */
function fallbackDateIndex(command: readonly string[]): number {
  return command.findIndex(arg => arg === "--date-fallback" || arg.startsWith("--date-fallback="));
}

/** Restore the standing date policy while each option is still a separate argument. */
function restoreFixtureDatePolicy(command: string[]): string[] {
  const fallback = fallbackDateIndex(command);
  if (fallback >= 0) command.splice(fallback, command[fallback] === "--date-fallback" ? 2 : 1, "--date-from-version");
  return command;
}

/** Encode one argument for the fixture's shell, including literal apostrophes. */
function quoteFixtureArgument(argument: string): string {
  return "'" + argument.replaceAll("'", "'\\''") + "'";
}

/** The workflow step this suite executes, read straight from the YAML so reverting its policy breaks the proof. */
function changelogStepScript(): string {
  const workflow = parse(readFileSync(resolve(".github/workflows/daily-release.yml"), "utf8")) as { jobs: { prepare: { steps: { name?: string; run?: string }[] } } };
  const script = workflow.jobs.prepare.steps.find(step => step.name === "Generate changelog and release notes")?.run;
  assert.ok(script);
  return script;
}

/** Fixture npm scripts that call this repository's generator with the standing policy. */
function releaseCommands(generator = resolve("scripts/pm-changelog.ts"), node = process.execPath): Record<string, string> {
  const commands = Object.fromEntries(["changelog:full", "changelog:check", "release:notes"].map(name => [name,
    [node, generator, ...restoreFixtureDatePolicy(args(name).filter(arg => arg !== "--include-empty"))].map(quoteFixtureArgument).join(" ")
  ]));
  commands["release:check"] = "npm run changelog:check";
  return commands;
}

/** Release-step environment over one fixture tracker, with the resumed heading date when given. */
function releaseStepEnv(root: string, env: NodeJS.ProcessEnv, headingDate = ""): NodeJS.ProcessEnv {
  return { ...env, IS_RUST: "false", CONTINUATION_SCRIPT: resolve("scripts/release-continuation.ts"), CHANGELOG_SCRIPT: "changelog:full", CHANGELOG_CHECK_SCRIPT: "changelog:check", NOTES_SCRIPT: "release:notes", RELEASE_HEADING_DATE: headingDate, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: join(root, "summary.md"), NPM_CONFIG_USERCONFIG: "/dev/null" };
}

/** Commit the prepared release files and tag the candidate on the given day. */
function commitAndTag(root: string, env: NodeJS.ProcessEnv, tag: string, day: string): void {
  execFileSync("git", ["add", "--", "package.json", "CHANGELOG.md"], { cwd: root, env });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Release fixture"], { cwd: root, env: { ...env, GIT_AUTHOR_DATE: day, GIT_COMMITTER_DATE: day } });
  execFileSync("git", ["tag", tag], { cwd: root, env });
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
    for (const [version, completedTime, committedTime] of [
      ["2026.10.23", "13:00:00Z", "14:00:00Z"],
      ["2026.10.23-1", "15:00:00Z", "16:00:00Z"],
      ["2026.10.24", "", "18:00:00Z"],
    ]) {
      const completed = completedTime ? `${headingDay(version!, args("changelog:full"))}T${completedTime}` : "";
      const committed = `${headingDay(version!, args("changelog:full"))}T${committedTime}`;
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
    execFileSync(process.execPath, [pm, "create", "task", "Work completed after the tag", "--id", "sample-later", "--status", "closed", "--close-reason", "Fixture complete", "--completed-at", `${headingDay("2026.10.24", args("changelog:full"))}T19:00:00Z`], { cwd: root, env });
    assert.equal(runChangelog(args("changelog:full"), root, env), 0);
    const later = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    assert.match(later, /^## Unreleased\n\n### Other\n\n- Work completed after the tag/m);
    assert.equal(runChangelog(args("changelog:check"), root, env), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release workflow uses the same npm policy for generation, drift checking and notes", () => {
  const workflow = readFileSync(resolve(".github/workflows/daily-release.yml"), "utf8");
  const step = workflow.slice(workflow.indexOf("- name: Generate changelog"), workflow.indexOf("- name: Run release checks"));
  assert.match(step, /npm run "\$CHANGELOG_SCRIPT"$/m);
  assert.match(step, /npm run "\$CHANGELOG_CHECK_SCRIPT"$/m);
  assert.match(step, /npm run --silent "\$NOTES_SCRIPT" > /);
});

test("dependency-only release windows pass release:check when all three hooks forward to one generator", () => {
  const { root, env } = tracker();
  try {
    releaseTags(root, env);
    const last = tags.at(-1)!;
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env, encoding: "utf8" }).trim();
    writeFileSync(join(root, "dependency-lock.txt"), "Updated dependency integrity\n");
    execFileSync("git", ["add", "dependency-lock.txt"], { cwd: root, env });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "build(deps): update dependency"], { cwd: root, env });
    const mainSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env, encoding: "utf8" }).trim();
    const hasChanges = execFileSync("git", ["diff", "--name-only", last, "HEAD"], { cwd: root, env, encoding: "utf8" }).trim() !== "";
    const facts = { today: "2026.10.23", mainSha, lastRelease: { tag: last, sha: baseSha }, existingPrs: [], hasChanges, releaseTags: tags };
    assert.equal(decideDailyRelease(facts).should_release, true);
    assert.equal(decideDailyRelease({ ...facts, hasChanges: false }).should_release, false);
    assert.equal(decideDailyRelease({ ...facts, publishedToday: true }).should_release, false);
    const commands = {
      "changelog:full": "npm --if-present run before-changelog && npm run changes",
      "changelog:check": "npm run --silent changes -- --check",
      "release:notes": "npm --loglevel=silent run-script changes -- --stdout",
      "release:check": "npm run changelog:check",
      changes: releaseCommands()["changelog:full"]!,
    };
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sample-changelog", version: "2026.10.23", scripts: commands }));
    const script = changelogStepScript();
    const releaseEnv = releaseStepEnv(root, env);
    const result = runBashFixture(script, { cwd: root, env: releaseEnv, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const file of ["CHANGELOG.md", "RELEASE_NOTES.md"]) assert.match(committedReleaseNotes(readFileSync(join(root, file), "utf8"), "2026.10.23"), /^No (?:tracked )?changes\.\n$/);
    execFileSync("npm", ["run", "release:check"], { cwd: root, env: releaseEnv });
    const prepared = readFileSync(join(root, "package.json"), "utf8");
    assert.deepEqual(JSON.parse(prepared).scripts, { ...commands, changes: commands.changes + " --include-empty" });
    const invalidDate = runBashFixture(script, { cwd: root, env: { ...releaseEnv, RELEASE_HEADING_DATE: "tomorrow" }, encoding: "utf8" });
    assert.notEqual(invalidDate.status, 0);
    assert.match(invalidDate.stderr, /Release heading date must be YYYY-MM-DD/);
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), prepared);
    assert.equal(runBashFixture(script, { cwd: root, env: releaseEnv, encoding: "utf8" }).status, 0);
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), prepared, "preparation is idempotent");
    for (const value of [undefined, "", " ", 42]) {
      const invalid = JSON.parse(prepared) as { scripts: Record<string, unknown> };
      invalid.scripts["release:notes"] = value;
      writeFileSync(join(root, "package.json"), JSON.stringify(invalid));
      const before = readFileSync(join(root, "package.json"), "utf8");
      const refused = runBashFixture(script, { cwd: root, env: releaseEnv, encoding: "utf8" });
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /Missing changelog hook: release:notes/);
      assert.equal(readFileSync(join(root, "package.json"), "utf8"), before, "invalid hooks fail before the policy is written");
    }
    writeFileSync(join(root, "package.json"), prepared);
    commitAndTag(root, env, "v2026.10.23", "2026-10-23T14:00:00Z");
    execFileSync("npm", ["run", "release:check"], { cwd: root, env: releaseEnv });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prepare commits the heading its tag produces, for same-day and resumed releases", () => {
  const script = changelogStepScript();
  // The fixture starts from this repository's standing scripts, exactly as a
  // release candidate on main does: the workflow step rewrites the date
  // policy in place, and the release PR's own CI runs the rewritten scripts
  // while the candidate is untagged, then main runs them again once tagged.
  for (const [version, headingDate, tagDay] of [
    ["2026.10.23", "", "2026-10-23T14:00:00Z"],
    ["2026.10.23", "2026-10-24", "2026-10-26T12:00:00Z"],
  ] as const) {
    const { root, env } = tracker();
    try {
      const checkout = join(root, "generator's checkout");
      const bin = join(root, "node bin");
      const node = join(bin, "node");
      symlinkSync(resolve("."), checkout, "junction");
      mkdirSync(bin);
      symlinkSync(process.execPath, node);
      const commands = releaseCommands(join(checkout, "scripts", "pm-changelog.ts"), node);
      releaseTags(root, env);
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sample-changelog", version, scripts: commands }));
      const releaseEnv = releaseStepEnv(root, env, headingDate);
      const result = runBashFixture(script, { cwd: root, env: releaseEnv, encoding: "utf8" });
      assert.equal(result.status, 0, `${version} ${headingDate}: ` + result.stdout + result.stderr);
      const prepared = readFileSync(join(root, "CHANGELOG.md"), "utf8");
      assert.match(prepared, new RegExp(`^## ${version} - ${headingDate || "2026-10-23"}$`, "m"));
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
      for (const name of ["changelog:full", "changelog:check", "release:notes"]) {
        assert.equal(pkg.scripts[name]!.includes("--date-fallback"), Boolean(headingDate), `${name} keeps the ${headingDate ? "pinned" : "standing"} date policy`);
        assert.ok(!pkg.scripts[name]!.includes("--date-from-version") || !headingDate, `${name} must not carry both date policies`);
      }
      if (headingDate) {
        // Retry the same untagged version after a day rolls over.
        const nextDay = tagDay.slice(0, 10);
        const quotedHooks = Object.fromEntries(Object.entries(pkg.scripts).map(([name, command]) => [
          name, command.replace("--date-fallback " + headingDate, name === "changelog:check"
            ? `'--date-fallback'="${headingDate}"` : `"--date-fallback" '${headingDate}'`),
        ]));
        writeFileSync(join(root, "package.json"), JSON.stringify({ ...pkg, version, scripts: quotedHooks }));
        const refreshed = runBashFixture(script, { cwd: root, env: { ...releaseEnv, RELEASE_HEADING_DATE: nextDay }, encoding: "utf8" });
        assert.equal(refreshed.status, 0, refreshed.stdout + refreshed.stderr);
        assert.match(committedReleaseNotes(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version), /^No tracked changes/);
        assert.match(readFileSync(join(root, "CHANGELOG.md"), "utf8"), /^## 2026\.10\.23 - 2026-10-26$/m);
      }
      // The release PR's gate runs while the candidate is untagged.
      execFileSync("npm", ["run", "release:check"], { cwd: root, env: releaseEnv });
      commitAndTag(root, env, `v${version}`, tagDay);
      // Main after tagging: the gate passes with no follow-up regeneration.
      execFileSync("npm", ["run", "release:check"], { cwd: root, env: releaseEnv });
      const committed = readFileSync(join(root, "CHANGELOG.md"), "utf8");
      execFileSync("npm", ["run", "changelog:full"], { cwd: root, env: releaseEnv });
      assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), committed, `${version} ${headingDate}: post-tag regeneration must equal the prepared bytes`);
      if (headingDate) {
        // A later same-day release restores the standing policy, so a stale
        // pin never survives the next release commit.
        const restored = runBashFixture(script, { cwd: root, env: { ...releaseEnv, RELEASE_HEADING_DATE: "" }, encoding: "utf8" });
        assert.equal(restored.status, 0, restored.stdout + restored.stderr);
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
        for (const name of ["changelog:full", "changelog:check", "release:notes"]) {
          assert.ok(pkg.scripts[name]!.includes("--date-from-version"), `${name} must be restored to the standing policy`);
          assert.ok(!pkg.scripts[name]!.includes("--date-fallback"), `${name} must not keep a stale pin`);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("preparation and continuation audit the generator reached through Bun and pnpm forwards", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-hook-forward-"));
  try {
    const day = "2026-10-24";
    const filename = join(root, "package.json");
    const hooks = {
      "changelog:full": "env bun run changes",
      "changelog:check": "bun --if-present run missing && bun run --if-present check",
      "release:notes": "pnpm run --if-present absent && pnpm run --if-present notes",
      changes: "pm-changelog --date-from-version",
      check: "pm-changelog --date-from-version --check",
      notes: "pm-changelog --date-from-version --stdout",
    };
    const env = { ...releaseStepEnv(root, process.env, day), NPM_PROJECT_PATH: root };
    writeFileSync(filename, JSON.stringify({ version: "2026.10.23", scripts: hooks }));
    execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts")], { cwd: root, env });
    const prepared = JSON.parse(readFileSync(filename, "utf8")) as { version: string; scripts: Record<string, string> };
    assert.deepEqual(prepared.scripts, {
      ...hooks,
      changes: "pm-changelog --date-fallback 2026-10-24 --include-empty",
      check: "pm-changelog --date-fallback 2026-10-24 --check --include-empty",
      notes: "pm-changelog --date-fallback 2026-10-24 --stdout --include-empty",
    });
    execFileSync("git", ["init", "-q"], { cwd: root, env });
    writeFileSync(join(root, "CHANGELOG.md"), "");
    commitAndTag(root, env, "v2026.10.23", day + "T12:00:00Z");
    const verify = [resolve("scripts/release-continuation.ts"), "heading-date"];
    execFileSync(process.execPath, verify, { cwd: root, env });
    for (const script of ["changes", "check", "notes"] as const) {
      writeFileSync(filename, JSON.stringify({
        ...prepared,
        scripts: { ...prepared.scripts, [script]: prepared.scripts[script]!.replace(day, "2026-10-23") },
      }));
      const result = spawnSync(process.execPath, verify, { cwd: root, env, encoding: "utf8" });
      assert.notEqual(result.status, 0, script);
      assert.match(result.stderr, /2026-10-23 differs from verified merge commit day 2026-10-24/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("empty wording leaves tracked prose alone and invalid adapter options fail before writing", () => {
  assert.equal(describeEmptyReleases("# Changelog\n\n## 1.0.0 - 2026-01-01\n\n- No changes.\n"), "# Changelog\n\n## 1.0.0 - 2026-01-01\n\n- No changes.\n");
  for (const invalid of [["--output"], ["--mode", "--check"], ["--mode", "invalid"]]) assert.throws(() => runChangelog(invalid));
  assert.throws(() => runChangelog(["--github-step-summary"], process.cwd(), {}), /requires GITHUB_STEP_SUMMARY/);
});


test("fixture heading days use the explicitly selected date policy", () => {
  assert.equal(headingDay("2026.10.23", ["--date-from-version"]), "2026-10-23");
  assert.equal(headingDay("2026.10.23", ["--date-fallback", "2026-10-24"]), "2026-10-24");
  assert.equal(headingDay("2026.10.23", ["--date-fallback=2026-10-25"]), "2026-10-25");
  for (const policy of [["--date-fallback", "2026-10-24"], ["--date-fallback=2026-10-24"], ["--date-from-version"]]) {
    assert.deepEqual(restoreFixtureDatePolicy([...policy, "--stdout"]), ["--date-from-version", "--stdout"]);
  }
});

test("preparation rewrites every date policy without consuming a following flag", () => {
  const step = changelogStepScript();
  const script = step.split("\n").filter(line =>
    line.includes("RELEASE_TOOLS=") || line.includes('node "$RELEASE_TOOLS/')).join("\n");
  assert.match(script, /prepare-release-changelog\.ts/);
  for (const [policy, heading, expected] of [
    ["--date-from-version", "2026-10-24", "--date-fallback 2026-10-24"],
    ["--date-fallback 2026-10-22", "2026-10-24", "--date-fallback 2026-10-24"],
    ["--date-fallback=2026-10-22", "", "--date-from-version"],
    [`"--date-fallback" '2026-10-22'`, "2026-10-24", "--date-fallback 2026-10-24"],
    [`'--date-fallback'="2026-10-22"`, "", "--date-from-version"],
    [`"--date-fallback=2026-10-22"`, "2026-10-24", "--date-fallback 2026-10-24"],
    [`"--date-from-version"`, "2026-10-24", "--date-fallback 2026-10-24"],
    [`--item-url-base "https://example.test/ --date-fallback=2026-10-22" --date-from-version`, "2026-10-24",
      `--item-url-base "https://example.test/ --date-fallback=2026-10-22" --date-fallback 2026-10-24`],
    ...["&&true", ";true"].flatMap(suffix => [
      ["--date-fallback 2026-10-23" + suffix, "2026-10-24", "--date-fallback 2026-10-24" + suffix],
      ["--date-fallback 2026-10-23" + suffix, "", "--date-from-version" + suffix],
    ]),
    ...['"', "'"].flatMap(quote => [" ", "="].flatMap(separator => [
      [`--date-fallback${separator}${quote}2026-10-22${quote}`, "2026-10-24", "--date-fallback 2026-10-24"],
      [`--date-fallback${separator}${quote}2026-10-22${quote}`, "", "--date-from-version"],
    ])),
  ]) {
    const root = mkdtempSync(join(tmpdir(), "hook-policy-"));
    try {
      const call = (flag: string) => `timeout --signal=KILL 5m pm-changelog --release-version-from-package --include-empty ${flag}`;
      const hooks = {
        "changelog:full": `${call(policy!)} && ${call(policy!)}`,
        "changelog:check": `${call("--date-from-version")} && ${call(policy!)}`,
        "release:notes": `${call(policy!)} --date-fallback --include-empty`,
      };
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: hooks }));
      const result = runBashFixture(script, { cwd: root, env: releaseStepEnv(root, process.env, heading), encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const prepared = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: typeof hooks };
      assert.equal(prepared.scripts["changelog:full"], `${call(expected!)} && ${call(expected!)}`);
      assert.equal(prepared.scripts["changelog:check"], `${call(heading ? "--date-fallback " + heading : "--date-from-version")} && ${call(expected!)}`);
      assert.equal(prepared.scripts["release:notes"], `${call(expected!)} --date-fallback --include-empty`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("date rewrites preserve redirections, substitutions and shell text surrounding the option", () => {
  const script = 'heading=$(pm-changelog "--date-fallback" 2>/dev/null "2026-10-23"); echo "$heading"';
  assert.equal(rewriteReleaseHeadingDate(script, "2026-10-24"),
    'heading=$(pm-changelog --date-fallback 2026-10-24 2>/dev/null ); echo "$heading"');
  assert.throws(() => rewriteReleaseHeadingDate(`eval 'pm-changelog "--date-fallback"=2026-10-23'`, "2026-10-24"),
    /needs an editable shell word/);
});

test("preparation refreshes and restores the date policy of a version-qualified generator", () => {
  const command = "npx --yes pm-changelog@2026.11.6 --release-version-from-package";
  assert.equal(rewriteReleaseHeadingDate(`${command} "--date-from-version"`, "2026-11-17"),
    `${command} --date-fallback 2026-11-17`);
  const pinned = `${command} '--date-fallback'="2026-11-16"`;
  assert.equal(rewriteReleaseHeadingDate(pinned, "2026-11-17"), `${command} --date-fallback 2026-11-17`);
  assert.equal(rewriteReleaseHeadingDate(pinned, ""), `${command} --date-from-version`);
});

test("preparation pins and restores wrapped changelog hooks", () => {
  for (const wrapper of ["timeout 60", "timeout --signal=KILL 5m", "nice -n 5"]) {
    const command = `${wrapper} pm-changelog --release-version-from-package`;
    const standing = `${command} --date-from-version`;
    const pinned = `${command} --date-fallback 2026-11-17`;
    assert.equal(rewriteReleaseHeadingDate(standing, "2026-11-17"), pinned);
    assert.equal(rewriteReleaseHeadingDate(pinned, ""), standing);
  }
  assert.throws(() => rewriteReleaseHeadingDate("custom-wrapper pm-changelog --date-from-version", "2026-11-17"),
    /unrecognized wrapper/i);
});

test("preparation skips changelog lookup guards while preserving executing wrappers", () => {
  const bin = "./node_modules/.bin/pm-changelog";
  for (const guard of [
    `test -x ${bin}`, `[ -x ${bin} ]`, `[[ -x ${bin} ]]`, "command -v pm-changelog", "command -p -V pm-changelog",
    "which pm-changelog", "type pm-changelog", `ls ${bin}`,
  ]) {
    const prefix = `${guard} && command pm-changelog`;
    assert.equal(rewriteReleaseHeadingDate(`${prefix} --date-from-version`, "2026-11-17"),
      `${prefix} --date-fallback 2026-11-17`);
    assert.equal(includeEmptyReleaseSections(`${prefix} --date-from-version`),
      `${prefix} --date-from-version --include-empty`);
  }
  assert.throws(() => includeEmptyReleaseSections("command -p custom-wrapper pm-changelog"), /unrecognized wrapper/i);
  assert.equal(includeEmptyReleaseSections("command -p"), "command -p");
});

test("preparation adds empty-section policy to each generator and preserves shell text", () => {
  const root = mkdtempSync(join(tmpdir(), "hook-empty-policy-"));
  try {
    const path = join(root, "package.json");
    const hooks = {
      "changelog:full": "pm-changelog --date-from-version 2> log && echo done",
      "changelog:check": "node scripts/pm-changelog.ts --check&&pm-changelog; echo '--include-empty'",
      "release:notes": 'pm-changelog --stdout "--include-empty" && echo done',
    };
    writeFileSync(path, JSON.stringify({ scripts: hooks }));
    execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts")], { cwd: root, env: releaseStepEnv(root, process.env) });
    const prepared = readFileSync(path, "utf8");
    assert.deepEqual(JSON.parse(prepared).scripts, {
      "changelog:full": "pm-changelog --date-from-version --include-empty 2> log && echo done",
      "changelog:check": "node scripts/pm-changelog.ts --check --include-empty&&pm-changelog --include-empty; echo '--include-empty'",
      "release:notes": hooks["release:notes"],
    });
    execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts")], { cwd: root, env: releaseStepEnv(root, process.env) });
    assert.equal(readFileSync(path, "utf8"), prepared);
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.equal(includeEmptyReleaseSections("out=$(pm-changelog --stdout); echo \"$out\""),
    "out=$(pm-changelog --stdout --include-empty); echo \"$out\"");
  assert.throws(() => includeEmptyReleaseSections("eval 'pm-changelog --stdout'"), /needs an editable shell word/);
});

test("preparation follows two forwards and keeps an already-flagged shared generator unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "hook-forward-policy-"));
  try {
    const path = join(root, "package.json");
    const env = releaseStepEnv(root, process.env);
    const prepare = [resolve("scripts/prepare-release-changelog.ts")];
    const hooks = {
      "changelog:full": "command -p; npm run before-full --if-present && bun run forward && echo done",
      "changelog:check": 'npm --no-if-present=false run before-check && npm run --if-present true before-check && pnpm run "pm-changelog" -- --check',
      "release:notes": "npm -s run-script --loglevel warn --if-present forward -- --stdout",
      forward: "pnpm run pm-changelog",
      "pm-changelog": "pm-changelog --date-from-version && echo done",
      unrelated: "pm-changelog --stdout",
    };
    writeFileSync(path, JSON.stringify({ scripts: hooks }));
    execFileSync(process.execPath, prepare, { cwd: root, env });
    const prepared = readFileSync(path, "utf8");
    assert.deepEqual(JSON.parse(prepared).scripts, {
      ...hooks,
      "pm-changelog": "pm-changelog --date-from-version --include-empty && echo done",
    });
    execFileSync(process.execPath, prepare, { cwd: root, env });
    assert.equal(readFileSync(path, "utf8"), prepared);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preparation refuses unresolved, cyclic and overlong forwards before writing the manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "hook-forward-refusal-"));
  try {
    const path = join(root, "package.json");
    const env = releaseStepEnv(root, process.env);
    const script = changelogStepScript();
    const forwards = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
      `hop${index}`, `npm run hop${index + 1}`,
    ]));
    const generator = "pm-changelog --date-from-version";
    const hooks = { "changelog:full": generator, "release:notes": generator };
    for (const [check, extra, diagnostic] of [
      ["npm run changes", { changes: "npm run changelog:check" }, /forward cycle: changelog:check -> changes -> changelog:check/],
      ["npm run changes", {}, /Cannot resolve changelog script forward changelog:check -> changes: missing or empty/],
      ['npm run "$CHANGELOG_TARGET"', {}, /Cannot resolve changelog script forward.*expected a literal/],
      ["npm run", {}, /Cannot resolve changelog script forward.*expected a literal/],
      ["npm run --loglevel", {}, /Cannot resolve changelog script forward.*expected a literal/],
      ["npm run --loglevel loud changes", {}, /Cannot resolve changelog script forward.*expected a literal/],
      ["npm run --loglevel=loud changes", {}, /Cannot resolve changelog script forward.*expected a literal/],
      ["npm run --prefix elsewhere changes", {}, /Cannot resolve changelog script forward.*expected a literal/],
      ["npm run -- --check", {}, /Cannot resolve changelog script forward.*expected a literal/],
      ["npm --if-present run --no-if-present changes", {}, /Cannot resolve changelog script forward.*missing or empty/],
      ["npm --if-present false run changes", {}, /Cannot resolve changelog script forward.*missing or empty/],
      ["npm run changes -- --if-present", {}, /Cannot resolve changelog script forward.*missing or empty/],
      ['npm --if-present run "$CHANGELOG_TARGET"', {}, /Cannot resolve changelog script forward.*expected a literal/],
      ["npm --if-present run changes", { changes: "" }, /Cannot resolve changelog script forward.*missing or empty/],
      ["npm run hop0", { ...forwards, hop8: generator }, /forward depth exceeds 8/],
      ["npm run hop0", { ...forwards, hop8: generator, "changelog:full": "npm run hop1" }, /forward depth exceeds 8/],
    ] as const) {
      const before = JSON.stringify({ scripts: { ...hooks, "changelog:check": check, ...extra } });
      writeFileSync(path, before);
      const result = runBashFixture(script, { cwd: root, env, encoding: "utf8" });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, diagnostic);
      assert.equal(readFileSync(path, "utf8"), before);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the publication heading check validates standing calendar coordinates without changing pinned hooks", () => {
  const standing = "pm-changelog --release-version-from-package --date-from-version";
  assert.doesNotThrow(() => assertReleaseHeadingDate([standing], "2026-01-02", "2026.1.2-3"));
  for (const version of [undefined, "1.0.0", "0099.1.2", "2026.2.30"]) {
    assert.throws(() => assertReleaseHeadingDate([standing], "2026-01-02", version), /valid calendar version/);
  }
  assert.doesNotThrow(() => assertReleaseHeadingDate(["pm-changelog --date-fallback"], "2026-01-02"));
  assert.doesNotThrow(() => assertReleaseHeadingDate(["pm-changelog --date-fallback 2026-01-02"], "2026-01-02"));
});

test("preparation refuses an unresolved option instead of erasing the substitution", () => {
  const command = 'pm-changelog --release-version-from-package --date-fallback$(printf x) 2026-11-16';
  for (const day of ["2026-11-17", ""]) {
    assert.throws(() => rewriteReleaseHeadingDate(command, day), /unresolved option word/i);
  }
});

test("preparation preserves a quoted expansion in a non-date option value", () => {
  const prefix = 'pm-changelog --release-version-from-package --item-url-base="$ITEM_URL_BASE"';
  assert.equal(rewriteReleaseHeadingDate(`${prefix} --date-from-version`, "2026-11-17"),
    `${prefix} --date-fallback 2026-11-17`);
});

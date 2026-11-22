/** Release-window cardinality properties and real CLI policy integration. */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { createChangelog, resolveReleaseTagWindows, type PmItem } from "pm-changelog";
import { execFileSync, spawnSync } from "../subprocess.ts";
import { committedReleaseNotes } from "../release-repair.ts";
import { describeEmptyReleases, runChangelog } from "../scripts/pm-changelog.ts";
import { npmCli } from "../scripts/release-runtime.ts";
import { verify as verifySections } from "../scripts/verify-release-changelog-sections.ts";
import { parse } from "yaml";
import { decideDailyRelease } from "../daily-release.ts";
import { runBashFixture } from "./bash-fixture.ts";
import { parseReleaseHook } from "../release-hook-grammar.ts";
import { withoutRedirections } from "../shell-scan.ts";
import { assertReleaseHeadingDate, includeEmptyReleaseSections, resolveChangelogHooks, rewriteReleaseHeadingDate, rewriteReleaseHookDates } from "../release-changelog-options.ts";

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
    execFileSync("git", ["tag", "--no-sign", tag], { cwd: root, env });
  });
}

/** Reuse configured generator arguments while locating the pinned CLI in the source checkout. */
function args(name: string, command = scripts[name]!): string[] {
  const { commands } = parseReleaseHook(command);
  assert.equal(commands.length, 1, name + " must be one direct generator command");
  return withoutRedirections(commands[0]!).slice(2).map(({ value }) => value === "./node_modules/.bin/pm" ? pm : value);
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
  const first = fallbackDateIndex(command);
  if (first < 0) return command;
  for (let fallback = first; fallback >= 0; fallback = fallbackDateIndex(command)) {
    command.splice(fallback, command[fallback] === "--date-fallback" ? 2 : 1);
  }
  if (!command.includes("--date-from-version")) command.splice(first, 0, "--date-from-version");
  return command;
}

/** Encode one argument for the fixture's shell, including literal apostrophes. */
function quoteFixtureArgument(argument: string): string {
  return "'" + argument.split(sep).join("/").replaceAll("'", "'\\''") + "'";
}

/** The workflow step this suite executes, read straight from the YAML so reverting its policy breaks the proof. */
function changelogStepScript(source = readFileSync(resolve(".github/workflows/daily-release.yml"), "utf8")): string {
  const workflow = parse(source) as { jobs: { prepare: { steps: { name?: string; id?: string; run?: string; env?: Record<string, string> }[] } } };
  const steps = workflow.jobs.prepare.steps;
  const preparation = steps.find(step => step.name === "Prepare npm changelog hooks");
  const generation = steps.find(step => step.name === "Generate changelog and release notes");
  assert.ok(preparation?.id && preparation.run);
  assert.ok(generation?.run);
  assert.equal(preparation.env?.RELEASE_HEADING_DATE, "${{ steps.decide.outputs.heading_date }}", "RELEASE_HEADING_DATE");
  for (const [key, output] of [["PREPARED_NPM_LIFECYCLE", "npm_lifecycle"],
    ["PREPARED_NPM_LIFECYCLE_CONFIGURED", "npm_lifecycle_configured"]]) {
    assert.equal(generation.env?.[key], "${{ steps." + preparation.id + ".outputs." + output + " }}", key);
  }
  return preparation.run + `\nexport PREPARED_NPM_LIFECYCLE="$(sed -n 's/^npm_lifecycle=//p' "$GITHUB_OUTPUT" | tail -n 1)"
export PREPARED_NPM_LIFECYCLE_CONFIGURED="$(sed -n 's/^npm_lifecycle_configured=//p' "$GITHUB_OUTPUT" | tail -n 1)"\n` + generation.run;
}

test("the generation fixture requires both lifecycle outputs to be wired in the workflow", () => {
  const source = readFileSync(resolve(".github/workflows/daily-release.yml"), "utf8");
  assert.doesNotThrow(() => changelogStepScript(source));
  for (const [key, output] of [["PREPARED_NPM_LIFECYCLE", "npm_lifecycle"],
    ["PREPARED_NPM_LIFECYCLE_CONFIGURED", "npm_lifecycle_configured"]]) {
    const mapping = key + ": ${{ steps.changelog.outputs." + output + " }}";
    assert.ok(source.includes(mapping));
    assert.throws(() => changelogStepScript(source.replace(mapping, mapping.replace(key, "UNUSED_POLICY"))), new RegExp(key));
    assert.throws(() => changelogStepScript(source.replace(mapping, mapping.replace(output + " }}", "another_output }}"))), new RegExp(key));
  }
});

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
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_config_script[-_]shell$/i.test(key)));
  return { ...clean, IS_RUST: "false", GITHUB_OUTPUT: join(root, "step-outputs"), CONTINUATION_SCRIPT: resolve("scripts/release-continuation.ts"), CHANGELOG_SCRIPT: "changelog:full", CHANGELOG_CHECK_SCRIPT: "changelog:check", NOTES_SCRIPT: "release:notes", RELEASE_HEADING_DATE: headingDate, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: join(root, "summary.md"), NPM_CONFIG_USERCONFIG: devNull, npm_config_script_shell: fixtureScriptShell() };
}

/** Override the active policy and isolate the config that a nested npm call reloads. */
function isolatedNpmReleaseEnv(root: string, env: NodeJS.ProcessEnv, headingDate = ""): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_config_/i.test(key)));
  return { ...releaseStepEnv(root, clean, headingDate), NPM_CONFIG_USERCONFIG: join(root, "user.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: devNull, npm_config_ignore_scripts: "true" };
}

/** Use the same POSIX script shell for workflow steps and direct npm calls. */
function fixtureScriptShell(): string {
  return process.platform === "win32"
    ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe")
    : "/bin/sh";
}

test("workflow npm uses the fixture shell even with inherited script-shell aliases", t => {
  const root = mkdtempSync(join(tmpdir(), "release-fixture-shell-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { reset: "echo root" } }));
  for (const name of ["NPM_CONFIG_SCRIPT_SHELL", "npm_config_script-shell", "NpM_CoNfIg_ScRiPt_ShElL"]) {
    const env = releaseStepEnv(root, { ...process.env, [name]: "./missing-script-shell" });
    assert.deepEqual(Object.keys(env).filter(key => /^npm_config_script[-_]shell$/i.test(key)), ["npm_config_script_shell"]);
    const result = runBashFixture("npm run --silent reset", { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "root");
  }
});

/** Invoke npm through Node while retaining the fixture shell through nested scripts. */
function npmRunArgs(hook: string, ...flags: string[]): string[] {
  return [npmCli(), "run", "--script-shell=" + fixtureScriptShell(), ...flags, hook];
}

/** Commit the prepared release files with a controlled committer timestamp. */
function commitPreparedRelease(root: string, env: NodeJS.ProcessEnv, day: string): void {
  execFileSync("git", ["add", "--", "package.json", "CHANGELOG.md"], { cwd: root, env });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Release fixture"], { cwd: root, env: { ...env, GIT_AUTHOR_DATE: day, GIT_COMMITTER_DATE: day } });
}

/** Commit and tag the prepared release on the given day. */
function commitAndTag(root: string, env: NodeJS.ProcessEnv, tag: string, day: string): void {
  commitPreparedRelease(root, env, day);
  execFileSync("git", ["tag", "--no-sign", tag], { cwd: root, env });
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

test("the adapter writes short and long output options to the same targets used by lifecycle detection", () => {
  const { root, env } = tracker();
  try {
    const generatorArgs = ["--pm-root", ".agents/pm", "--pm-bin", pm, "--include-empty", "--version", "2026.10.22"];
    const changelog = join(root, "CHANGELOG.md");
    writeFileSync(changelog, "original");
    for (const [filename, options] of [
      ["preview.md", ["-o", "preview.md"]],
      ["-o=preview.md", ["--output", "-o=preview.md"]],
      ["inline.md", ["-o=inline.md"]],
      ["last.md", ["--output=unused.md", "--output", "other.md", "-o", "last.md"]],
    ] as const) {
      const prehook = ["node scripts/pm-changelog.ts --date-from-version", ...options].join(" ");
      assert.ok(resolveChangelogHooks({ hook: "echo done", prehook }, ["hook"]).has("prehook"));
      assert.equal(runChangelog([...generatorArgs, ...options], root, env), 0);
      assert.match(readFileSync(join(root, filename), "utf8"), /^# Changelog/);
      assert.equal(runChangelog([...generatorArgs, ...options, "--check"], root, env), 0);
      writeFileSync(join(root, filename), "stale preview");
      assert.equal(runChangelog([...generatorArgs, ...options, "--check"], root, env), 1);
      assert.equal(readFileSync(join(root, filename), "utf8"), "stale preview");
      assert.equal(readFileSync(changelog, "utf8"), "original");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stdout JSON and step reports identify the selected file without changing it", t => {
  const { root, env } = tracker();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const step = join(root, "outputs");
  for (const [file, options] of [["preview.md", ["-o", "preview.md"]], ["-o=preview.md", ["--output", "-o=preview.md"]], ["CHANGELOG.md", []]] as const) {
    const path = join(root, file);
    writeFileSync(path, "previous contents");
    writeFileSync(step, "");
    const report = execFileSync(process.execPath, [resolve("scripts/pm-changelog.ts"), "--pm-root", ".agents/pm",
      "--pm-bin", pm, "--include-empty", "--version", "2026.10.22", ...options, "--stdout", "--json", "--github-output"],
    { cwd: root, env: { ...env, GITHUB_OUTPUT: step }, encoding: "utf8" });
    assert.equal(JSON.parse(report).output, path);
    assert.ok(readFileSync(step, "utf8").split("\n").includes("output=" + path));
    assert.equal(readFileSync(path, "utf8"), "previous contents");
  }
});

test("prepend stdout preserves JSON reports and the plain Markdown policy", t => {
  const { root, env } = tracker();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync(process.execPath, [pm, "create", "task", "Fixture summary item", "--id", "sample-summary"], { cwd: root, env });
  const path = join(root, "preview.md");
  const history = "# Changelog\n\n## 2026.1.1 - 2026-01-01\n\nPreview history.\n";
  writeFileSync(path, history);
  const common = ["--pm-root", ".agents/pm", "--pm-bin", pm, "--include-empty", "--version", "2026.10.22", "--stdout"];
  const run = (cli: string, flags: string[]) => execFileSync(process.execPath, [resolve(cli), ...common, ...flags],
    { cwd: root, env, encoding: "utf8" });
  for (const mode of [["--mode", "prepend"], ["--mode=prepend"]]) {
    const adapter = "scripts/pm-changelog.ts";
    const markdown = run(adapter, [...mode, "-o", "preview.md"]);
    assert.match(markdown, /No tracked changes\./);
    assert.match(markdown, /Preview history\./);
    const expected = run("node_modules/pm-changelog/dist/cli.js", [...mode, "--output", path, "--json"]);
    assert.equal(JSON.parse(expected).mode, "prepend");
    assert.match(JSON.parse(expected).markdown, /Preview history\./);
    assert.equal(run(adapter, [...mode, "-o", "preview.md", "--json"]), expected);
    for (const report of [["--changelog-json"], ["--format=json"], ["--format", "json"], ["--format", " JSON "], ["--format= Json "]]) {
      const document = run("node_modules/pm-changelog/dist/cli.js", [...mode, "--output", path, ...report]);
      assert.ok(Array.isArray(JSON.parse(document).releases));
      assert.equal(run(adapter, [...mode, "-o", "preview.md", ...report]), document);
    }
    const summaryFlags = [...mode, "--summary", "--title", "Fixture report", "--status", "open"];
    const summary = run("node_modules/pm-changelog/dist/cli.js", [...summaryFlags, "--output", path]);
    assert.match(summary, /Fixture summary item/);
    assert.doesNotMatch(summary, /Preview history\./);
    assert.equal(run(adapter, [...summaryFlags, "-o", "preview.md"]), summary);
    assert.equal(run(adapter, [...mode, "-o", "preview.md", "--format=json", "--format", " MD "]), markdown);
    assert.equal(readFileSync(path, "utf8"), history);
  }
});

test("inline and separate prepend mode preserve the selected output history", () => {
  const { root, env } = tracker();
  try {
    const defaultHistory = "# Changelog\n\n## 2026.1.1 - 2026-01-01\n\nDefault history.\n";
    const previewHistory = defaultHistory.replace("Default history.", "Preview history.");
    writeFileSync(join(root, "CHANGELOG.md"), defaultHistory);
    for (const mode of [["--mode", "prepend"], ["--mode=prepend"]]) {
      const preview = join(root, "preview.md");
      writeFileSync(preview, previewHistory);
      runChangelog([...mode, "-o", "preview.md", "--pm-root", ".agents/pm", "--pm-bin", pm, "--include-empty", "--version", "2026.10.22"], root, env);
      const result = readFileSync(preview, "utf8");
      assert.match(result, /^## 2026\.10\.22$/m);
      assert.match(result, /Preview history/);
      assert.doesNotMatch(result, /Default history/);
      assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), defaultHistory);
    }
    assert.throws(() => runChangelog(["--mode="], root, env), /--mode requires a value/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prepend uses the last requested title when history has no level-one heading", t => {
  const { root, env } = tracker();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "CHANGELOG.md");
  const history = "## 2026.1.1 - 2026-01-01\n\nExisting history.\n";
  const cli = ["--mode=prepend", "--pm-root", ".agents/pm", "--pm-bin", pm, "--include-empty", "--version", "2026.10.22"];
  for (const option of [["--title", "Release Notes"], ["--title=Release Notes"]]) {
    for (const heading of ["", "# Existing title\n\n"]) {
      writeFileSync(path, heading + history);
      assert.equal(runChangelog([...cli, "--title=Earlier title", ...option], root, env), 0);
      const markdown = readFileSync(path, "utf8");
      assert.ok(markdown.startsWith(heading || "# Release Notes\n\n"), markdown);
      assert.match(markdown, /Existing history\./);
    }
  }
});

test("Round GI prepend checks retained links before writing, while replace checks its own output", t => {
  const { root, env } = tracker();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = "https://example.invalid/tracker";
  const path = join(root, "preview.md");
  const history = "# Changelog\n\n## 2026.1.1 - 2026-01-01\n\n[history](" + base + "/sample-history.toon)\n";
  const cliArgs = ["--pm-root", ".agents/pm", "--pm-bin", pm, "--include-empty", "--version", "2026.10.22",
    "--date-from-version", "--item-url-base", base, "--check-links", "-o", "preview.md"];
  writeFileSync(path, history);
  assert.throws(() => runChangelog([...cliArgs, "--mode=prepend"], root, env), /sample-history\.toon/);
  assert.equal(readFileSync(path, "utf8"), history);
  assert.equal(runChangelog([...cliArgs, "--mode=replace"], root, env), 0);
  assert.doesNotMatch(readFileSync(path, "utf8"), /sample-history/);
  writeFileSync(join(root, ".agents/pm/sample-history.toon"), "fixture link target\n");
  writeFileSync(path, history);
  assert.equal(runChangelog([...cliArgs, "--mode", "prepend"], root, env), 0);
  assert.match(readFileSync(path, "utf8"), /sample-history\.toon/);
  const implicitEnv = { ...env };
  delete implicitEnv.PM_PATH;
  const implicitArgs = cliArgs.slice(2);
  assert.equal(runChangelog([...implicitArgs, "--mode=prepend", "--check"], root, implicitEnv), 0);
  assert.equal(runChangelog([...implicitArgs, "--mode=prepend", "--check"], root, env), 0);
  assert.equal(runChangelog([...implicitArgs, "--mode=prepend", "--check", "--pm-cwd=.", "--pm-arg=--pm-path=.agents/pm"], root, implicitEnv), 0);
  rmSync(join(root, ".agents/pm/sample-history.toon"));
  const stdout = spawnSync(process.execPath, [resolve("scripts/pm-changelog.ts"), ...cliArgs, "--mode=prepend", "--stdout"],
    { cwd: root, env, encoding: "utf8" });
  assert.equal(stdout.status, 1);
  assert.equal(stdout.stdout, "");
  assert.match(stdout.stderr, /sample-history\.toon/);
});

test("Round GI the resumed heading fixture depends on the workflow's planner mapping", () => {
  const source = readFileSync(resolve(".github/workflows/daily-release.yml"), "utf8");
  const mapping = "RELEASE_HEADING_DATE: ${{ steps.decide.outputs.heading_date }}";
  assert.doesNotThrow(() => changelogStepScript(source));
  assert.ok(source.includes(mapping));
  assert.throws(() => changelogStepScript(source.replace(mapping, "UNUSED_HEADING_DATE: ''")), /RELEASE_HEADING_DATE/);
  assert.throws(() => changelogStepScript(source.replace(mapping, mapping.replace("heading_date", "other_date"))), /RELEASE_HEADING_DATE/);
});

test("each explicit adapter mode must be valid before the last valid mode wins", () => {
  const { root, env } = tracker();
  try {
    const path = join(root, "CHANGELOG.md");
    const history = "# Changelog\n\n## 2026.1.1 - 2026-01-01\n\nPrevious release.\n";
    const common = ["--pm-root", ".agents/pm", "--pm-bin", pm, "--include-empty", "--version", "2026.10.22"];
    writeFileSync(path, history);
    for (const invalid of [["--mode=typo"], ["--mode", "typo"]]) {
      assert.throws(() => runChangelog([...common, ...invalid, "--mode", "replace"], root, env), /--mode must be replace or prepend/);
      assert.equal(readFileSync(path, "utf8"), history);
    }
    assert.equal(runChangelog([...common, "--mode=replace", "--mode", "prepend"], root, env), 0);
    assert.match(readFileSync(path, "utf8"), /Previous release/);
    assert.equal(runChangelog([...common, "--mode", "prepend", "--mode=replace"], root, env), 0);
    assert.doesNotMatch(readFileSync(path, "utf8"), /Previous release/);
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
      execFileSync("git", ["tag", "--no-sign", `v${version}`], { cwd: root, env });
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
  assert.match(step, /verify_lifecycle\s+npm run "\$CHANGELOG_SCRIPT"$/m);
  assert.match(step, /verify_lifecycle\s+npm run "\$CHANGELOG_CHECK_SCRIPT"$/m);
  assert.match(step, /verify_lifecycle\s+npm run --silent "\$NOTES_SCRIPT" > [^\n]+\n\s+verify_lifecycle/);
});

test("dependency-only release windows support forwarded generators and custom notes hooks", () => {
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
    const facts = { today: "2026.10.23", expectedCommitTimestamp: "2026-10-23T12:00:00Z", mainSha, lastRelease: { tag: last, sha: baseSha }, existingPrs: [], hasChanges, releaseTags: tags };
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
    execFileSync(process.execPath, npmRunArgs("release:check"), { cwd: root, env: releaseEnv });
    const prepared = readFileSync(join(root, "package.json"), "utf8");
    assert.deepEqual(JSON.parse(prepared).scripts, { ...commands, changes: commands.changes + " --include-empty" });
    const invalidDate = runBashFixture(script, { cwd: root, env: { ...releaseEnv, RELEASE_HEADING_DATE: "tomorrow" }, encoding: "utf8" });
    assert.notEqual(invalidDate.status, 0);
    assert.match(invalidDate.stderr, /Release heading date must be YYYY-MM-DD/);
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), prepared);
    assert.equal(runBashFixture(script, { cwd: root, env: releaseEnv, encoding: "utf8" }).status, 0);
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), prepared, "preparation is idempotent");
    mkdirSync(join(root, "tools"));
    writeFileSync(join(root, "tools", "notes.mjs"),
      'if (process.argv.includes("--include-empty")) console.log("Dependency update.");\n');
    const custom = { ...commands, "release:notes": "node tools/notes.mjs" };
    const manifest = join(root, "package.json");
    writeFileSync(manifest, JSON.stringify({ name: "sample-changelog", version: "2026.10.23", scripts: custom }));
    const customResult = runBashFixture(script, { cwd: root, env: releaseEnv, encoding: "utf8" });
    assert.equal(customResult.status, 0, customResult.stdout + customResult.stderr);
    assert.equal(readFileSync(join(root, "RELEASE_NOTES.md"), "utf8"), "Dependency update.\n");
    const customPrepared = readFileSync(manifest, "utf8");
    assert.deepEqual(JSON.parse(customPrepared).scripts, {
      ...custom,
      "release:notes": custom["release:notes"] + " --include-empty",
      changes: commands.changes + " --include-empty",
    });
    assert.equal(runBashFixture(script, { cwd: root, env: releaseEnv, encoding: "utf8" }).status, 0);
    assert.equal(readFileSync(manifest, "utf8"), customPrepared, "the custom hook keeps one saved flag");
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
    execFileSync(process.execPath, npmRunArgs("release:check"), { cwd: root, env: releaseEnv });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("custom notes keep the saved option before shell terminators and comments", t => {
  const root = mkdtempSync(join(tmpdir(), "custom-notes-shell-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = join(root, "package.json");
  const env = releaseStepEnv(root, process.env);
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  if (process.platform === "win32") {
    const inheritedKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
    const searchPath = env[inheritedKey];
    delete env[inheritedKey];
    env[pathKey] = searchPath;
  }
  const blocked = join(root, "no-launcher");
  mkdirSync(blocked);
  writeFileSync(join(blocked, "npm"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  writeFileSync(join(blocked, "npm.cmd"), "@exit /b 97\r\n");
  const launchEnv = { ...env, [pathKey]: [blocked, env[pathKey]].join(delimiter) };
  const prepare = [resolve("scripts/prepare-release-changelog.ts")];
  writeFileSync(join(root, "notes.mjs"), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  for (const suffix of [";", "\n", "; # notes end\n"]) {
    const hooks = {
      "changelog:full": "# No changelog generation needed.",
      "changelog:check": "# No changelog check needed.",
      "release:notes": "node notes.mjs" + suffix,
    };
    writeFileSync(manifest, JSON.stringify({ scripts: hooks }));
    execFileSync(process.execPath, prepare, { cwd: root, env });
    const prepared = readFileSync(manifest, "utf8");
    assert.deepEqual(JSON.parse(prepared).scripts, { ...hooks, "release:notes": "node notes.mjs --include-empty" + suffix });
    for (const npmEnv of [env, launchEnv]) {
      assert.equal(execFileSync(process.execPath, npmRunArgs("release:notes", "--silent"), { cwd: root, env: npmEnv, encoding: "utf8" }), '["--include-empty"]\n');
    }
    execFileSync(process.execPath, prepare, { cwd: root, env });
    assert.equal(readFileSync(manifest, "utf8"), prepared);
  }
});

test("custom notes receive the saved argument through npm independently of pre/post generators", t => {
  const root = mkdtempSync(join(tmpdir(), "custom-notes-argv-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = join(root, "package.json");
  const env = { ...releaseStepEnv(root, process.env), npm_config_ignore_scripts: "false" };
  const prepare = [resolve("scripts/prepare-release-changelog.ts")];
  writeFileSync(join(root, "notes.mjs"), 'console.log(JSON.stringify(process.argv.slice(2)));');
  writeFileSync(join(root, "pm-changelog.ts"), 'const args = process.argv.slice(2); require("node:fs").writeFileSync(args[args.indexOf("--output") + 1], JSON.stringify(args));');
  const preview = "node pm-changelog.ts --version=2026.11.17 --date-from-version --output preview.md";
  for (const [main, expected, argv] of [
    [preview + "; node notes.mjs", preview + " --include-empty; node notes.mjs --include-empty", ["--include-empty"]],
    [preview.replace("preview.md", "CHANGELOG.md") + "; node notes.mjs",
      preview.replace("preview.md", "CHANGELOG.md") + " --include-empty; node notes.mjs --include-empty", ["--include-empty"]],
    ["npm run mixed", "npm run mixed -- --include-empty", ["--include-empty"]],
    ["node notes.mjs", "node notes.mjs --include-empty", ["--include-empty"]],
    ["npm run render", "npm run render -- --include-empty", ["--include-empty"]],
    ["npm run relay", "npm run relay -- -- --include-empty", ["--include-empty"]],
    ["npm run relay -- --include-empty", "npm run relay -- -- --include-empty", ["--include-empty"]],
    ["npm run ready", "npm run ready -- --include-empty", ["--include-empty"]],
    ["npm run render -- --title", "npm run render -- --title --include-empty", ["--title", "--include-empty"]],
    ["npm run render --include-empty", "npm run render -- --include-empty", ["--include-empty"]],
    ["npm run render --include-empty -- --title Notes", "npm run render -- --title Notes --include-empty", ["--title", "Notes", "--include-empty"]],
    ['npm run render "--include-empty" -- --include-empty', "npm run render -- --include-empty", ["--include-empty"]],
    ["npm run relay --include-empty -- --include-empty", "npm run relay -- -- --include-empty", ["--include-empty"]],
  ] as const) {
    const lifecycleHook = main.startsWith("npm") ? "prerender" : "prerelease:notes";
    const embedded = main.startsWith("node pm-changelog.ts") || main === "npm run mixed";
    const previewFile = join(root, main.includes("--output CHANGELOG.md") ? "CHANGELOG.md" : "preview.md");
    const scripts = { "changelog:full": "# skip", "changelog:check": "# skip", ...(embedded ? {} : { [lifecycleHook]: preview }),
      "release:notes": main, mixed: preview + "; node notes.mjs", relay: "npm run render", ready: "npm run render --", render: "node notes.mjs" };
    writeFileSync(manifest, JSON.stringify({ scripts }));
    execFileSync(process.execPath, prepare, { cwd: root, env });
    const prepared = readFileSync(manifest, "utf8");
    assert.equal(JSON.parse(prepared).scripts["release:notes"], expected);
    rmSync(previewFile, { force: true });
    const output = execFileSync(process.execPath, npmRunArgs("release:notes", "--silent"), { cwd: root, env, encoding: "utf8" });
    assert.deepEqual(JSON.parse(output.trim().split("\n").at(-1)!), argv);
    assert.ok(JSON.parse(readFileSync(previewFile, "utf8")).includes("--include-empty"));
    if (main === "node notes.mjs") {
      rmSync(join(root, "preview.md"));
      execFileSync(process.execPath, npmRunArgs("release:notes", "--silent", "--ignore-scripts"), { cwd: root, env });
      assert.equal(existsSync(join(root, "preview.md")), false);
    }
    execFileSync(process.execPath, prepare, { cwd: root, env });
    assert.equal(readFileSync(manifest, "utf8"), prepared);
  }
});

test("preparation keeps a status-only changelog check and routes the flag to a renderer", t => {
  const root = mkdtempSync(join(tmpdir(), "status-only-changelog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = isolatedNpmReleaseEnv(root, process.env);
  const prepare = [resolve("scripts/prepare-release-changelog.ts")];
  const status = "git diff --check -- CHANGELOG.md";
  const generator = "node pm-changelog.ts --release-version-from-package --date-from-version";
  const manifest = join(root, "package.json");
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const file of ["pm-changelog.ts", "check.cjs"]) {
    writeFileSync(join(root, file), 'if (!process.argv.includes("--include-empty")) process.exitCode = 1;');
  }
  for (const [check, expected] of [
    [status, status], ["npm run status", "npm run status"],
    [generator + " && " + status, generator + " --include-empty && " + status],
    ["node check.cjs && " + status, "node check.cjs --include-empty && " + status],
  ]) {
    const scripts = { "changelog:full": generator, "changelog:check": check, "release:notes": generator, status };
    writeFileSync(manifest, JSON.stringify({ name: "fixture", version: "2026.11.17", scripts }));
    execFileSync(process.execPath, prepare, { cwd: root, env, stdio: "pipe" });
    const prepared = JSON.parse(readFileSync(manifest, "utf8")).scripts;
    assert.equal(prepared["changelog:check"], expected);
    assert.equal(prepared.status, status);
    assert.match(prepared["changelog:full"], /--include-empty/);
    execFileSync(process.execPath, npmRunArgs("changelog:check", "--silent"), { cwd: root, env });
  }
});

test("a notes generator pipes its output through filters without forwarding generator options to them", t => {
  const root = mkdtempSync(join(tmpdir(), "notes-pipeline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = releaseStepEnv(root, process.env);
  const generator = "node pm-changelog.ts --release-version-from-package --date-from-version --stdout";
  const pipeline = generator + " | cat | head -n 1";
  writeFileSync(join(root, "pm-changelog.ts"), 'console.log(JSON.stringify(process.argv.slice(2)));');
  for (const main of [pipeline, "npm run writer"]) {
    const scripts = { "release:notes": main, "changelog:full": "# skip", "changelog:check": "# skip", writer: pipeline };
    const manifest = join(root, "package.json");
    writeFileSync(manifest, JSON.stringify({ scripts }));
    execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts")], { cwd: root, env });
    const prepared = JSON.parse(readFileSync(manifest, "utf8")).scripts;
    const changed = pipeline.replace(generator, generator + " --include-empty");
    assert.equal(prepared["release:notes"], main === pipeline ? changed : main);
    const result = runBashFixture(main === pipeline ? prepared["release:notes"] : prepared.writer,
      { cwd: root, encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [...generator.split(" ").slice(2), "--include-empty"]);
  }
});

test("prepare commits the heading its tag produces, for same-day and resumed releases", () => {
  const script = changelogStepScript();
  // The fixture starts from this repository's standing scripts, exactly as a
  // release candidate on main does: the workflow step rewrites the date
  // policy in place, and the release PR's own CI runs the rewritten scripts
  // while the candidate is untagged, then main runs them again once tagged.
  for (const [version, headingDate, tagDay] of [
    ["2026.10.23", "", "2026-10-23T14:00:00Z"],
    ["2026.10.23", "2026-10-24", "2026-10-26T23:30:00Z"],
  ] as const) {
    const { root, env } = tracker();
    try {
      const checkout = join(root, "generator's checkout");
      const bin = join(root, "node bin");
      const node = join(bin, "node.exe");
      symlinkSync(resolve("."), checkout, "junction");
      mkdirSync(bin);
      copyFileSync(process.execPath, node);
      assert.equal(lstatSync(node).isFile(), true);
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
        const heading = readFileSync(join(root, "CHANGELOG.md"), "utf8").split("\n").find(line => line.startsWith(`## ${version} -`));
        assert.equal(heading, `## ${version} - ${nextDay}`, "use the committer day across Vienna midnight");
      }
      // The release PR's gate runs while the candidate is untagged.
      execFileSync(process.execPath, npmRunArgs("release:check"), { cwd: root, env: releaseEnv });
      commitAndTag(root, env, `v${version}`, tagDay);
      const changelog = join(root, "CHANGELOG.md");
      const committed = execFileSync("git", ["show", "v" + version + ":CHANGELOG.md"], { cwd: root, env });
      // Main after tagging: the gate passes with no follow-up regeneration.
      execFileSync(process.execPath, npmRunArgs("release:check"), { cwd: root, env: releaseEnv });
      assert.deepEqual(readFileSync(changelog), committed, "the post-tag gate preserves the tagged changelog bytes");
      const timestamp = execFileSync("git", ["show", "-s", "--format=%cI", `v${version}`], { cwd: root, env, encoding: "utf8" });
      assert.ok(committed.toString("utf8").split("\n").includes(`## ${version} - ${timestamp.slice(0, 10)}`));
      execFileSync(process.execPath, npmRunArgs("changelog:full"), { cwd: root, env: releaseEnv });
      assert.deepEqual(readFileSync(changelog), committed, `${version} ${headingDate}: post-tag regeneration must equal the prepared bytes`);
      if (headingDate) {
        // The old fallback differs from the tag date. The tag must take precedence.
        const manifest = join(root, "package.json");
        const taggedManifest = readFileSync(manifest, "utf8");
        const taggedPackage = JSON.parse(taggedManifest);
        taggedPackage.scripts["changelog:full"] = taggedPackage.scripts["changelog:full"].replace(
          tagDay.slice(0, 10), headingDate,
        );
        assert.ok(taggedPackage.scripts["changelog:full"].includes("--date-fallback"));
        assert.ok(taggedPackage.scripts["changelog:full"].includes(headingDate));
        writeFileSync(manifest, JSON.stringify(taggedPackage));
        execFileSync(process.execPath, npmRunArgs("changelog:full"), { cwd: root, env: releaseEnv });
        assert.deepEqual(readFileSync(changelog), committed, "the tag date takes precedence over the older fallback");
        writeFileSync(manifest, taggedManifest);
        // A later same-day release restores the standing policy.
        const nextVersion = "2026.10.27";
        assert.equal(execFileSync("git", ["tag", "--list", "v" + nextVersion], { cwd: root, env, encoding: "utf8" }), "");
        writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: nextVersion }));
        const restored = runBashFixture(script, { cwd: root, env: { ...releaseEnv, RELEASE_HEADING_DATE: "" }, encoding: "utf8" });
        assert.equal(restored.status, 0, restored.stdout + restored.stderr);
        assert.ok(readFileSync(join(root, "CHANGELOG.md"), "utf8").split("\n").includes("## " + nextVersion + " - 2026-10-27"));
        const restoredScripts: Record<string, string> = JSON.parse(readFileSync(manifest, "utf8")).scripts;
        for (const name of ["changelog:full", "changelog:check", "release:notes"]) {
          assert.ok(restoredScripts[name]!.includes("--date-from-version"), `${name} must be restored to the standing policy`);
          assert.ok(!restoredScripts[name]!.includes("--date-fallback"), `${name} must not keep a stale pin`);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("a resumed release passes preparation, continuation and post-tag checks across the Vienna midnight boundary", () => {
  const { root, env } = tracker();
  try {
    releaseTags(root, env);
    const preparation = "2026-10-24T23:30:00Z";
    const merge = "2026-10-24T23:40:00Z";
    const timezone = "Europe/Vienna";
    const releaseCalendar = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, dateStyle: "short" });
    const today = releaseCalendar.format(new Date(preparation)).replaceAll("-", ".");
    assert.equal(today, "2026.10.25");
    assert.equal(releaseCalendar.format(new Date(merge)), "2026-10-25");
    const plan = decideDailyRelease({
      today, expectedCommitTimestamp: preparation, mainSha: "main", lastRelease: null,
      existingPrs: [], hasChanges: true, releaseTags: tags, currentPackageVersion: "2026.10.23",
    });
    assert.equal(plan.heading_date, "2026-10-24");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sample-changelog", version: plan.npm_version, scripts: {
      ...releaseCommands(), "prerelease:notes": "pm-changelog --release-version-from-package --date-fallback 2026-10-23",
    } }));
    const releaseEnv: NodeJS.ProcessEnv = { ...isolatedNpmReleaseEnv(root, env, plan.heading_date), NPM_PROJECT_PATH: root, RELEASE_TIMEZONE: timezone };
    if (process.platform !== "win32") {
      const selectedNpm = npmCli();
      const [active, shadow] = ["active-npm", "shadow-npm"].map(dir => join(root, dir));
      for (const dir of [active, shadow]) mkdirSync(dir);
      symlinkSync(selectedNpm, join(active, "npm"));
      writeFileSync(join(shadow, "npm"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
      releaseEnv.PATH = [active, shadow, env.PATH].join(delimiter);
    }
    const prepared = runBashFixture(changelogStepScript(), { cwd: root, env: releaseEnv, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    assert.match(readFileSync(join(root, "CHANGELOG.md"), "utf8"), /^## 2026\.10\.23 - 2026-10-24$/m);
    commitPreparedRelease(root, env, merge);
    const receipt = readFileSync(releaseEnv.GITHUB_OUTPUT!, "utf8").trim().split("\n");
    assert.deepEqual(receipt, ["npm_lifecycle=false", "npm_lifecycle_configured=unknown"]);
    const live: NodeJS.ProcessEnv = { ...releaseEnv, npm_config_ignore_scripts: "false" };
    delete live.PREPARED_NPM_LIFECYCLE;
    const verify = [releaseEnv.CONTINUATION_SCRIPT!, "heading-date"];
    execFileSync(process.execPath, verify, { cwd: root, env: {
      ...live, PREPARED_NPM_LIFECYCLE: receipt[0].split("=")[1], PREPARED_NPM_LIFECYCLE_CONFIGURED: receipt[1].split("=")[1],
    } });
    const refused = spawnSync(process.execPath, verify, { cwd: root, env: live, encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /2026-10-23 differs from verified merge commit day 2026-10-24/);
    execFileSync("git", ["tag", "--no-sign", plan.tag], { cwd: root, env });
    execFileSync(process.execPath, npmRunArgs("changelog:check"), { cwd: root, env: releaseEnv });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preparation and continuation audit the generator reached through Bun and pnpm forwards", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-hook-forward-"));
  try {
    const day = "2026-10-24";
    const filename = join(root, "package.json");
    const hooks = {
      "changelog:full": "env bun run changes",
      "changelog:check": "bun --if-present run missing && bun run --silent --if-present check",
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

test("Bun execution switches preserve direct generator detection and package script resolution", () => {
  const hooks = {
    "changelog:full": "bun run --silent pm-changelog --date-from-version",
    "changelog:check": "bun run --bun ./scripts/pm-changelog.ts --date-from-version --check",
    "release:notes": "bun --silent run -b --if-present changes",
    changes: "pm-changelog --date-from-version --stdout",
  };
  const resolved = resolveChangelogHooks(hooks, ["changelog:full", "changelog:check", "release:notes"]);
  assert.deepEqual(Object.fromEntries(resolved), hooks);
  const day = "2026-10-24";
  for (const name of ["changelog:full", "changelog:check", "changes"] as const) {
    const pinned = rewriteReleaseHeadingDate(resolved.get(name)!, day);
    assert.equal(pinned, hooks[name].replace("--date-from-version", "--date-fallback " + day));
    assert.throws(() => assertReleaseHeadingDate([pinned], "2026-10-23"), /2026-10-24 differs.*2026-10-23/);
  }
  assert.throws(() => resolveChangelogHooks({ hook: 'bun run --silent "$TARGET"' }, ["hook"]), /expected a literal/);
  assert.throws(() => resolveChangelogHooks({ hook: "bun run --cwd elsewhere changes", changes: hooks.changes }, ["hook"]), /context change --cwd.*Use a direct/);
});

test("prepare pins forwarded options and continuation refuses their stale merge day", () => {
  const root = mkdtempSync(join(tmpdir(), "forwarded-heading-"));
  try {
    const day = "2026-11-17";
    const filename = join(root, "package.json");
    const env = { ...releaseStepEnv(root, process.env, day), NPM_PROJECT_PATH: root };
    const scripts = {
      "changelog:full": 'npm run preflight && npm run changes -- "--date-from-version"',
      "changelog:check": "bun run changes -- --date-from-version --check",
      "release:notes": "pnpm run notes -- --date-from-version",
      preflight: "# No preparation needed in this package.",
      notes: "npm run changes -- --stdout",
      changes: "echo ready && pm-changelog --release-version-from-package",
    };
    const write = (scripts: Record<string, string>) =>
      writeFileSync(filename, JSON.stringify({ version: "2026.11.16", scripts }));
    write(scripts);
    execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts")], { cwd: root, env });
    const prepared = JSON.parse(readFileSync(filename, "utf8")).scripts as Record<string, string>;
    assert.deepEqual(prepared, {
      ...scripts,
      "changelog:full": `npm run preflight && npm run changes -- --date-fallback ${day}`,
      "changelog:check": `bun run changes -- --date-fallback ${day} --check`,
      "release:notes": `pnpm run notes --date-fallback ${day}`,
      changes: scripts.changes + " --include-empty",
    });
    execFileSync("git", ["init", "-q"], { cwd: root, env });
    writeFileSync(join(root, "CHANGELOG.md"), "");
    commitAndTag(root, env, "v2026.11.16", day + "T12:00:00Z");
    const verify = [resolve("scripts/release-continuation.ts"), "heading-date"];
    execFileSync(process.execPath, verify, { cwd: root, env });
    write({ ...prepared, "release:notes": prepared["release:notes"].replace(day, "2026-11-16") });
    const result = spawnSync(process.execPath, verify, { cwd: root, env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /2026-11-16 differs from verified merge commit day 2026-11-17/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preparation refuses a stale all-tags cutoff without writing any hooks", () => {
  const { root, env: trackerEnv } = tracker();
  try {
    const hooksPath = join(root, "hostile-hooks");
    const config = join(root, "hostile.gitconfig");
    mkdirSync(hooksPath);
    for (const name of ["pre-push", "pre-receive"]) {
      writeFileSync(join(hooksPath, name), "#!/bin/sh\necho unexpected fixture hook >&2\nexit 79\n", { mode: 0o755 });
    }
    execFileSync("git", ["config", "--file", config, "core.hooksPath", hooksPath]);
    const env = { ...trackerEnv, GIT_CONFIG_GLOBAL: config };
    releaseTags(root, env);
    const day = "2026-11-17";
    const stale = "2026-11-16";
    const filename = join(root, "package.json");
    const version = "2026.11.16";
    const hooks = releaseCommands();
    hooks["changelog:full"] += " --until " + stale;
    hooks["changelog:check"] += " --until=" + stale;
    const original = JSON.stringify({ version, scripts: hooks });
    writeFileSync(filename, original);
    const changelog = join(root, "CHANGELOG.md");
    const fallback = restoreFixtureDatePolicy(args("changelog:full")).filter(arg => arg !== "--date-from-version");
    assert.equal(runChangelog([...fallback, "--date-fallback", day, "--until", stale], root, env), 0);
    const rendered = readFileSync(changelog, "utf8");
    assert.match(rendered, /^## 2026\.11\.16 - 2026-11-16$/m);
    const prepare = [resolve("scripts/prepare-release-changelog.ts")];
    const releaseEnv = releaseStepEnv(root, env, day);
    const result = spawnSync(process.execPath, prepare, { cwd: root, env: releaseEnv, encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /--until day 2026-11-16.*heading day 2026-11-17.*Remove --until or set it to 2026-11-17/);
    assert.equal(readFileSync(filename, "utf8"), original);
    assert.equal(readFileSync(changelog, "utf8"), rendered);
    const compatible = Object.fromEntries(Object.entries(hooks).map(([name, command]) => [name, command.replace(stale, day)]));
    writeFileSync(filename, JSON.stringify({ version, scripts: compatible }));
    execFileSync(process.execPath, prepare, { cwd: root, env: releaseEnv });

    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
    const create = (id: string, title: string, hour: string) => execFileSync(process.execPath, [
      pm, "create", "task", title, "--id", id, "--status", "closed", "--close-reason", "Fixture complete",
      "--completed-at", day + "T" + hour + ":00:00Z",
    ], { cwd: root, env });
    create("sample-ready", "Included before preparation", "09");
    execFileSync(process.execPath, npmRunArgs("changelog:full"), { cwd: root, env: releaseEnv });
    execFileSync(process.execPath, npmRunArgs("changelog:check"), { cwd: root, env: releaseEnv });
    const prepared = readFileSync(changelog, "utf8");
    assert.match(prepared, /^## 2026\.11\.16 - 2026-11-17$/m);
    assert.match(committedReleaseNotes(prepared, version), /Included before preparation/);
    git("add", "--", ".agents/pm");
    commitPreparedRelease(root, env, day + "T10:00:00Z");
    const candidate = git("rev-parse", "HEAD");
    const tree = git("rev-parse", "HEAD^{tree}");

    create("sample-late", "Completed after preparation", "11");
    git("add", "--", ".agents/pm");
    const tagTime = day + "T12:00:00Z";
    const dated = { ...env, GIT_AUTHOR_DATE: tagTime, GIT_COMMITTER_DATE: tagTime };
    const commit = (message: string) => execFileSync("git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--no-gpg-sign", "--allow-empty", "-qm", message], { cwd: root, env: dated });
    commit("Release tree changed after preparation");
    const changed = git("rev-parse", "HEAD");
    const remote = join(root, "origin.git");
    git("init", "--quiet", "--bare", remote);
    const emptyHooks = join(root, "empty-hooks");
    mkdirSync(emptyHooks);
    git("config", "--local", "core.hooksPath", emptyHooks);
    git("--git-dir", remote, "config", "--local", "core.hooksPath", emptyHooks);
    git("remote", "add", "origin", remote);
    git("-c", "push.gpgSign=false", "push", "--quiet", "origin", "HEAD:refs/heads/main");
    assert.equal(git("ls-remote", "--heads", "origin", "main"), changed + "\trefs/heads/main");

    const workflow = parse(readFileSync(resolve(".github/workflows/daily-release.yml"), "utf8"));
    const verify = workflow.jobs.release.steps.find((step: { name?: string }) => step.name === "Verify merged release");
    const verifyTree = (sha: string) => runBashFixture(verify.run, { cwd: root, encoding: "utf8",
      env: { ...env, MERGED_SHA: sha, VERIFIED_TREE: tree } });
    assert.equal(verifyTree(changed).status, 1, "a tracked update after preparation changes the verified tree");
    git("tag", "--no-sign", "v" + version);
    execFileSync(process.execPath, npmRunArgs("changelog:full"), { cwd: root, env: releaseEnv });
    assert.match(committedReleaseNotes(readFileSync(changelog, "utf8"), version), /Completed after preparation/);
    git("tag", "-d", "v" + version);

    git("checkout", "--detach", "--force", candidate);
    commit("Release merge retains the prepared tree");
    const merged = git("rev-parse", "HEAD");
    const verification = verifyTree(merged);
    assert.equal(verification.status, 0, verification.stdout + verification.stderr);
    git("tag", "--no-sign", "v" + version);
    const committed = git("show", "v" + version + ":CHANGELOG.md");
    execFileSync(process.execPath, npmRunArgs("changelog:check"), { cwd: root, env: releaseEnv });
    execFileSync(process.execPath, npmRunArgs("changelog:full"), { cwd: root, env: releaseEnv });
    assert.equal(committedReleaseNotes(readFileSync(changelog, "utf8"), version), committedReleaseNotes(committed, version));
    assert.doesNotMatch(committedReleaseNotes(committed, version), /Completed after preparation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preparation keeps custom fallback renderers with an existing empty-section option", t => {
  const root = mkdtempSync(join(tmpdir(), "release-prepared-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = isolatedNpmReleaseEnv(root, process.env);
  const manifest = join(root, "package.json");
  const prepare = [resolve("scripts/prepare-release-changelog.ts")];
  const primary = "node primary.mjs --include-empty";
  const fallback = "node fallback.mjs";
  writeFileSync(join(root, "primary.mjs"), "console.log(JSON.stringify(process.argv.slice(2))); process.exit(1);");
  writeFileSync(join(root, "fallback.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));");
  for (const [notes, accepted] of [
    [primary + " || " + fallback + ' "--include-empty" > result', true],
    [primary + " || " + fallback + " -- --include-empty", false],
    [primary + " || " + fallback, false],
    ["node primary.mjs || " + fallback + " --include-empty", false],
  ] as const) {
    const original = JSON.stringify({ scripts: { "changelog:full": "# skip", "changelog:check": "# skip", "release:notes": notes } });
    writeFileSync(manifest, original);
    const result = spawnSync(process.execPath, prepare, { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, accepted ? 0 : 1, result.stderr);
    assert.equal(readFileSync(manifest, "utf8"), original);
    if (!accepted) {
      assert.match(result.stderr, /alternative renderers/);
      continue;
    }
    assert.equal(execFileSync(process.execPath, npmRunArgs("release:notes", "--silent"), { cwd: root, env, encoding: "utf8" }).trim(), '["--include-empty"]');
    assert.equal(readFileSync(join(root, "result"), "utf8").trim(), '["--include-empty"]');
  }
});

test("date edits retain source ownership when a caller supplies the fallback operand", () => {
  const scripts = new Map([
    ["hook", "pnpm run relay -- 2026-11-16 --check"],
    ["relay", "npm run changes"],
    ["changes", "pm-changelog --date-fallback"],
  ]);
  assert.deepEqual(Object.fromEntries(rewriteReleaseHookDates(scripts, ["hook"], "2026-11-17")), {
    hook: "pnpm run relay -- 2026-11-17 --check",
    relay: scripts.get("relay"),
    changes: "pm-changelog --date-fallback",
  });
  scripts.set("hook", "eval 'pnpm run changes -- --date-from-version'");
  scripts.set("changes", "pm-changelog");
  assert.throws(() => rewriteReleaseHookDates(scripts, ["hook"], ""), /Unrecognized wrapper.*eval.*Use a direct/);
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
  assert.deepEqual(restoreFixtureDatePolicy(["--date-fallback", "2026-10-24", "--stdout", "--date-fallback=2026-10-25"]),
    ["--date-from-version", "--stdout"]);
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
        "release:notes": `${call(policy!)} --stdout`,
      };
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: hooks }));
      const result = runBashFixture(script, { cwd: root, env: releaseStepEnv(root, process.env, heading), encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const prepared = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: typeof hooks };
      assert.equal(prepared.scripts["changelog:full"], `${call(expected!)} && ${call(expected!)}`);
      assert.equal(prepared.scripts["changelog:check"], `${call(heading ? "--date-fallback " + heading : "--date-from-version")} && ${call(expected!)}`);
      assert.equal(prepared.scripts["release:notes"], `${call(expected!)} --stdout`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("date edits preserve redirections and explicitly refuse evaluated shell", () => {
  const command = 'pm-changelog "--date-fallback" 2>/dev/null "2026-10-23"';
  assert.equal(rewriteReleaseHeadingDate(command, "2026-10-24"), 'pm-changelog --date-fallback 2026-10-24 2>/dev/null ');
  for (const source of [`heading=$(${command})`, `eval '${command}'`]) {
    assert.throws(() => rewriteReleaseHeadingDate(source, "2026-10-24"), /Use a direct pm-changelog/);
  }
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
  assert.throws(() => includeEmptyReleaseSections("out=$(pm-changelog --stdout)"), /substitution.*Use a direct/i);
  assert.throws(() => includeEmptyReleaseSections("eval 'pm-changelog --stdout'"), /Unrecognized wrapper.*Use a direct/);
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
  assert.throws(() => resolveChangelogHooks(undefined, ["changelog:full"]), /Missing changelog hook: changelog:full/);
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
      ["npm run --prefix elsewhere changes", {}, /context change --prefix.*Use a direct/],
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
  assert.throws(() => assertReleaseHeadingDate(["pm-changelog --date-fallback"], "2026-01-02"), /Invalid --date-fallback/);
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

test("shared date restoration distinguishes printed forwards from executable callers", () => {
  const base = { release: "npm run changes -- 2026-11-16", changes: "pm-changelog --date-fallback" };
  const restore = (help: string) => rewriteReleaseHookDates(new Map(Object.entries({ ...base, help })), ["release"], "");
  for (const help of ["echo npm run changes", 'env TITLE=x printf "%s" "npm run changes"', "command -v npm run changes", "TITLE=example"]) {
    assert.equal(restore(help).get("changes"), "pm-changelog --date-from-version");
  }
  for (const caller of ["command npm run changes", "echo npm run changes; npm run changes", 'echo "$(npm run changes)"']) {
    assert.throws(() => restore(caller), /argument contract/);
  }
});

test("shared writers keep preview date operands and refuse an incompatible restore before writing", () => {
  const root = mkdtempSync(join(tmpdir(), "shared-heading-"));
  try {
    const manifest = join(root, "package.json");
    const scripts = { release: "npm run changes -- 2026-11-16", preview: "npm run changes -- 2026-10-01", changes: "pm-changelog --date-fallback" };
    writeFileSync(manifest, JSON.stringify({ scripts }));
    const env = { ...process.env, CHANGELOG_SCRIPT: "release", CHANGELOG_CHECK_SCRIPT: "release", NOTES_SCRIPT: "release", RELEASE_HEADING_DATE: "2026-11-17" };
    const prepare = [resolve("scripts/prepare-release-changelog.ts")];
    execFileSync(process.execPath, prepare, { cwd: root, env });
    const before = readFileSync(manifest, "utf8");
    const prepared = JSON.parse(before).scripts;
    assert.equal(prepared.changes, "pm-changelog --include-empty --date-fallback");
    assert.equal(prepared.preview, scripts.preview);
    assert.equal(prepared.release, "npm run changes -- 2026-11-17");
    const failed = spawnSync(process.execPath, prepare, { cwd: root, env: { ...env, RELEASE_HEADING_DATE: "" }, encoding: "utf8" });
    assert.match(failed.stderr, /forwarded date operand/i);
    assert.equal(failed.status, 1);
    assert.equal(readFileSync(manifest, "utf8"), before);
    for (const preview of ["bun changes", "npm run \"$SCRIPT\"", "npm run relay -- 2026-10-01"]) {
      const withPreview = { ...prepared, preview };
      if (preview.includes("relay")) {
        withPreview.release = "npm run relay -- 2026-11-17";
        withPreview.relay = "npm run changes --";
      }
      writeFileSync(manifest, JSON.stringify({ scripts: withPreview }));
      assert.throws(() => execFileSync(process.execPath, prepare, { cwd: root, env: { ...env, RELEASE_HEADING_DATE: "" } }), /forwarded date operand/);
    }
    delete prepared.preview;
    prepared.unrelated = null;
    prepared.other = "npm run helper";
    prepared.helper = "echo ready";
    writeFileSync(manifest, JSON.stringify({ scripts: prepared }));
    execFileSync(process.execPath, prepare, { cwd: root, env: { ...env, RELEASE_HEADING_DATE: "" } });
    assert.match(JSON.parse(readFileSync(manifest, "utf8")).scripts.changes, /--date-from-version$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("mixed generation and check hooks deliver the saved option to their finishing program", t => {
  const root = mkdtempSync(join(tmpdir(), "mixed-release-hooks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = releaseStepEnv(root, process.env);
  const generator = "node pm-changelog.ts --release-version-from-package --date-from-version";
  const scripts = { "changelog:full": generator + " && node finish.mjs", "changelog:check": generator + " && node finish.mjs", "release:notes": generator };
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(root, "pm-changelog.ts"), "console.log(JSON.stringify(process.argv.slice(2)))");
  writeFileSync(join(root, "finish.mjs"), "console.log(JSON.stringify(process.argv.slice(2)))");
  execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts")], { cwd: root, env });
  for (const name of Object.keys(scripts)) {
    const lines = execFileSync(process.execPath, npmRunArgs(name, "--silent"), { cwd: root, env, encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(JSON.parse(lines[0]), ["--release-version-from-package", "--date-from-version", "--include-empty"]);
    if (name !== "release:notes") assert.deepEqual(JSON.parse(lines[1]), ["--include-empty"]);
    else assert.equal(lines.length, 1);
  }
});

test("prepared lifecycle and notes hooks pass include-empty to a caller-supplied generator entrypoint", t => {
  const root = mkdtempSync(join(tmpdir(), "forwarded-generator-entry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = join(root, "package.json");
  const env = { ...isolatedNpmReleaseEnv(root, process.env), npm_config_ignore_scripts: "false" };
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "pm-changelog.ts"), "console.log(JSON.stringify(process.argv.slice(2)))");
  const generator = "scripts/pm-changelog.ts --release-version-from-package --date-from-version --stdout";
  const hooks = {
    "changelog:full": "npm run complete",
    "changelog:check": "npm run writer -- " + generator + " --include-empty",
    "prerelease:notes": "npm run relay -- " + generator,
    "release:notes": "npm run writer -- " + generator,
    complete: "node " + generator,
    relay: "npm run writer --",
    writer: "node",
  };
  writeFileSync(manifest, JSON.stringify({ scripts: hooks }));
  const prepare = () => execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts")], { cwd: root, env });
  prepare();
  const prepared = readFileSync(manifest, "utf8");
  assert.equal(JSON.parse(prepared).scripts.writer, "node");
  assert.equal(JSON.parse(prepared).scripts["changelog:full"], hooks["changelog:full"]);
  assert.equal(JSON.parse(prepared).scripts.complete, hooks.complete + " --include-empty");
  assert.equal(JSON.parse(prepared).scripts["changelog:check"], hooks["changelog:check"]);
  prepare();
  assert.equal(readFileSync(manifest, "utf8"), prepared);
  for (const hook of ["changelog:full", "changelog:check", "release:notes"]) {
    const lines = execFileSync(process.execPath, npmRunArgs(hook, "--silent"), { cwd: root, env, encoding: "utf8" }).trim().split(/\r?\n/);
    assert.equal(lines.length, hook === "release:notes" ? 2 : 1);
    for (const line of lines) {
      const argv = JSON.parse(line) as string[];
      assert.deepEqual(argv.sort(), [...generator.split(" ").slice(1), "--include-empty"].sort(), hook);
    }
  }
  const commented = { ...hooks, "changelog:check": "# intentionally empty" };
  writeFileSync(manifest, JSON.stringify({ scripts: commented }));
  prepare();
  assert.equal(JSON.parse(readFileSync(manifest, "utf8")).scripts["changelog:check"], commented["changelog:check"]);
  const { "changelog:check": _absent, ...missing } = commented;
  const incomplete = JSON.stringify({ scripts: missing });
  writeFileSync(manifest, incomplete);
  assert.throws(prepare, /Missing changelog hook: changelog:check/);
  assert.equal(readFileSync(manifest, "utf8"), incomplete);
});

test("generation refuses lifecycle drift and preserves nested npm behavior under a stable policy", t => {
  const root = mkdtempSync(join(tmpdir(), "prepared-notes-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "user.npmrc");
  const env = releaseStepEnv(root, { ...process.env, "NpM_cOnFiG_Ignore-Scripts": "true", NPM_CONFIG_IGNORE_SCRIPTS: "true" });
  for (const name of Object.keys(env)) if (/^npm_config_(?:ignore[-_]scripts|userconfig)$/i.test(name)) delete env[name];
  env.NPM_CONFIG_USERCONFIG = config;
  env.NPM_CONFIG_GLOBALCONFIG = devNull;
  writeFileSync(join(root, "flip.mjs"), 'import fs from "node:fs"; const p = process.env.NPM_CONFIG_USERCONFIG; fs.writeFileSync(p, fs.readFileSync(p, "utf8").includes("true") ? "ignore-scripts=false\\n" : "ignore-scripts=true\\n");');
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {
    "changelog:full": "node flip.mjs", "changelog:check": "node check.mjs", "release:notes": "npm run --silent nested",
    "prerelease:notes": "node before.mjs", prenested: "node before.mjs", nested: "node notes.mjs",
  } }));
  writeFileSync(join(root, "check.mjs"), "");
  writeFileSync(join(root, "notes.mjs"), 'console.log("main")');
  writeFileSync(join(root, "before.mjs"), 'console.log("before")');
  const changer = readFileSync(join(root, "flip.mjs"), "utf8");
  for (const skip of [true, false, undefined]) {
    const setting = skip === undefined ? "" : "ignore-scripts=" + skip + "\n";
    const notes = join(root, "RELEASE_NOTES.md");
    rmSync(notes, { force: true });
    writeFileSync(config, setting);
    writeFileSync(join(root, "flip.mjs"), changer);
    const changed = runBashFixture(changelogStepScript(), { cwd: root, env, encoding: "utf8" });
    assert.notEqual(changed.status, 0);
    assert.match(changed.stdout + changed.stderr, /npm lifecycle policy changed/);
    assert.equal(existsSync(notes), false);

    writeFileSync(config, setting);
    writeFileSync(join(root, "flip.mjs"), "");
    const stable = runBashFixture(changelogStepScript(), { cwd: root, env, encoding: "utf8" });
    assert.equal(stable.status, 0, stable.stdout + stable.stderr);
    assert.equal(readFileSync(notes, "utf8").trim(), skip ? "main" : "before\nbefore\nmain");
  }
});

test("generation detects drift in the nested npm fallback with the active setting held fixed", t => {
  const root = mkdtempSync(join(tmpdir(), "prepared-npm-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = isolatedNpmReleaseEnv(root, process.env);
  const config = env.NPM_CONFIG_USERCONFIG!;
  if (process.platform !== "win32") {
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(npmCli(), join(bin, "npm"));
    env.PATH = [bin, env.PATH].join(delimiter);
  }
  writeFileSync(join(root, "check.mjs"), "");
  writeFileSync(join(root, "notes.mjs"), 'if (process.argv.includes("--include-empty")) console.log("ready")');
  writeFileSync(join(root, "before.mjs"), 'console.log("unexpected prewriter")');
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: {
    "changelog:full": "node change.mjs", "changelog:check": "node check.mjs",
    "release:notes": "npm --ignore-scripts=false --silent run bridge",
    bridge: "npm --silent run writer", writer: "node notes.mjs", prewriter: "node before.mjs",
  } }));
  const notes = join(root, "RELEASE_NOTES.md");
  for (const changed of [true, false]) {
    const next = changed ? "false" : "true";
    writeFileSync(config, "ignore-scripts=true\n");
    writeFileSync(join(root, "change.mjs"), 'import fs from "node:fs"; fs.writeFileSync(process.env.NPM_CONFIG_USERCONFIG, "ignore-scripts=' + next + '\\n");');
    rmSync(notes, { force: true });
    const result = runBashFixture(changelogStepScript(), { cwd: root, env, encoding: "utf8" });
    if (changed) {
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /npm lifecycle policy changed/);
      assert.equal(existsSync(notes), false);
    } else {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(readFileSync(notes, "utf8").trim(), "ready");
    }
  }
});

test("notes preparation requires a definite nested lifecycle after a helper runs", t => {
  const root = mkdtempSync(join(tmpdir(), "prepared-notes-nested-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = isolatedNpmReleaseEnv(root, process.env);
  writeFileSync(join(root, ".npmrc"), "ignore-scripts=true\n");
  writeFileSync(join(root, "check.mjs"), "");
  writeFileSync(join(root, "refresh.mjs"), "");
  writeFileSync(join(root, "notes.mjs"), 'if (process.argv.includes("--include-empty")) console.log("ready")');
  writeFileSync(join(root, "before.mjs"), 'console.log("before")');
  const scripts = {
    "changelog:full": "node check.mjs", "changelog:check": "node check.mjs",
    "release:notes": "npm --ignore-scripts=false --silent run bridge",
    writer: "node notes.mjs", prewriter: "node before.mjs",
  };
  const manifest = join(root, "package.json");
  const prepare = (bridge: string) => {
    const original = JSON.stringify({ name: "fixture", scripts: { ...scripts, bridge } });
    writeFileSync(manifest, original);
    const result = runBashFixture(changelogStepScript(), { cwd: root, env, encoding: "utf8" });
    return { result, original };
  };
  const refused = prepare("node refresh.mjs; npm --silent run writer");
  assert.notEqual(refused.result.status, 0);
  assert.match(refused.result.stdout + refused.result.stderr, /Cannot verify.*npm lifecycle.*writer/);
  assert.equal(readFileSync(manifest, "utf8"), refused.original);
  const notes = join(root, "RELEASE_NOTES.md");
  assert.equal(existsSync(notes), false);
  for (const [bridge, output] of [
    ["npm --silent run writer", "ready"],
    ["node refresh.mjs; npm --ignore-scripts=true --silent run writer", "ready"],
    ["node refresh.mjs; npm --ignore-scripts=false --silent run writer", "before\nready"],
  ]) {
    const { result } = prepare(bridge);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(notes, "utf8").trim(), output);
  }
});

test("Round GQ fixture commands decode quoted flags and operands", () => {
  const entry = "node scripts/pm-changelog.ts ";
  for (const options of [
    `"--date-fallback" '2026-10-24' --title "Release notes" "./node_modules/.bin/pm"`,
    `--date-fallback=2026-10-24 --title Release\\ notes ./node_modules/.bin/pm`,
  ]) {
    const decoded = args("release:notes", entry + options);
    assert.equal(headingDay("2026.10.23", decoded), "2026-10-24");
    assert.deepEqual(restoreFixtureDatePolicy(decoded), ["--date-from-version", "--title", "Release notes", pm]);
  }
});

test("Round GQ GitHub file outputs report the written changelog", t => {
  const { root, env } = tracker();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const destination = join(root, "CHANGELOG.md");
  const step = join(root, "step-outputs");
  const history = "# Changelog\n\n## 2026.1.1 - 2026-01-01\n\nRetained history.\n";
  const cli = ["--pm-root", ".agents/pm", "--pm-bin", pm, "--include-empty", "--version", "2026.10.22"];
  for (const [mode, flag] of [["replace", "--github-output"], ["prepend", "--github-output"], ["prepend", "--set-output"]]) {
    writeFileSync(destination, history);
    writeFileSync(step, "");
    assert.equal(runChangelog([...cli, "--mode=" + mode, flag], root, { ...env, GITHUB_OUTPUT: step }), 0);
    const markdown = readFileSync(destination, "utf8");
    assert.equal(markdown.includes("Retained history."), mode === "prepend");
    assert.deepEqual(Object.fromEntries(readFileSync(step, "utf8").trim().split("\n").map(line => line.split("="))), {
      output: destination, mode, action: mode === "prepend" ? "inserted" : "replaced",
      changed: "true", item_count: "0", excluded_non_change_count: "0", bytes: String(Buffer.byteLength(markdown)),
    });
  }
  const previous = readFileSync(destination, "utf8");
  const report = execFileSync(process.execPath, [resolve("scripts/pm-changelog.ts"), ...cli, "--mode=prepend",
    "--json", "--github-output", "--check"], { cwd: root, env: { ...env, GITHUB_OUTPUT: step }, encoding: "utf8" });
  const { mode, action, changed, bytes, check } = JSON.parse(report);
  assert.deepEqual({ mode, action, changed, bytes, check }, {
    mode: "prepend", action: "unchanged", changed: false, bytes: Buffer.byteLength(previous), check: true,
  });
  assert.match(readFileSync(step, "utf8"), /mode=prepend\naction=unchanged\nchanged=false/);
  const { GITHUB_OUTPUT: _output, ...withoutOutput } = env;
  assert.throws(() => runChangelog([...cli, "--github-output"], root, withoutOutput), /requires GITHUB_OUTPUT/);
  assert.equal(readFileSync(destination, "utf8"), previous);
  const created = execFileSync(process.execPath, [resolve("scripts/pm-changelog.ts"), ...cli,
    "--json", "--output", "new.md"], { cwd: root, env: withoutOutput, encoding: "utf8" });
  assert.equal(JSON.parse(created).action, "created");
  assert.match(readFileSync(join(root, "new.md"), "utf8"), /No tracked changes\./);
});

test("Round GQ forwarded custom renderers receive exactly one include-empty option", t => {
  const root = mkdtempSync(join(tmpdir(), "release-custom-renderer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = join(root, "package.json");
  const env = isolatedNpmReleaseEnv(root, process.env);
  writeFileSync(join(root, "notes.mjs"), 'const flags = process.argv.slice(2); if (flags.length !== 1 || flags[0] !== "--include-empty") process.exit(1);');
  const prepare = () => {
    execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts")], { cwd: root, env });
    return readFileSync(manifest, "utf8");
  };
  for (const [writerSuffix, callerSuffix, preparedSuffix] of [
    ["", "", " -- --include-empty"],
    [" --include-empty", "", ""],
    [" --include-empty", " --include-empty", " --include-empty"],
    [" --include-empty && true", "", ""],
  ]) {
    const writer = "node notes.mjs" + writerSuffix;
    const original = "npm run writer" + callerSuffix;
    writeFileSync(manifest, JSON.stringify({ scripts: {
      "changelog:full": "echo generated", "changelog:check": "true", "release:notes": original, writer,
    } }));
    const prepared = prepare();
    assert.equal(JSON.parse(prepared).scripts["release:notes"], "npm run writer" + preparedSuffix);
    assert.equal(JSON.parse(prepared).scripts.writer, writer);
    execFileSync(process.execPath, npmRunArgs("release:notes", "--silent"), { cwd: root, env });
    assert.equal(prepare(), prepared);
  }
});

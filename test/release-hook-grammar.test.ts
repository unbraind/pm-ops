/** Exercise the release hook language at the same boundaries as npm and GitHub Actions. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { execFileSync } from "../subprocess.ts";
import {
  assertReleaseHookHeadingDate, includeEmptyReleaseSections, resolveChangelogHooks, rewriteReleaseHookDates,
} from "../release-changelog-options.ts";
import { fixedOptionName, tokenizeCommands, commandName, packageScriptCommand } from "../shell-scan.ts";
import { auditInvocations } from "../scripts/verify-release-changelog-date.ts";

const standing = "--release-version-from-package --date-from-version";
const day = "2026-11-17";

/** Build an actual Actions workflow with independent run scalars and incidental metadata. */
function workflow(...commands: string[]) {
  return { file: ".github/workflows/release.yml", text: stringify({ jobs: {
    prepare: { steps: commands.map(run => ({ name: "pm-changelog --version", run })) },
  } }, { blockQuote: "literal" }) };
}

test("npm runs the prepared pre/main/post hooks with separate argument lists", t => {
  const root = mkdtempSync(join(tmpdir(), "release-hook-npm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = {
    "prechangelog:full": "npm run writer -- CHANGELOG.md",
    "changelog:full": "npm run render -- --stdout",
    "postchangelog:full": "npm run --ignore-scripts relay",
    writer: "node ./pm-changelog.ts " + standing + " --output",
    prerender: "node ./pm-changelog.ts " + standing + " --title pre",
    render: "node ./pm-changelog.ts " + standing + " --title main",
    postrender: "node ./pm-changelog.ts " + standing + " --title post",
    relay: "npm run disabled",
    predisabled: "node ./pm-changelog.ts " + standing + " --title disabled",
    disabled: "node ./pm-changelog.ts " + standing + " --title relay",
  };
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts }));
  writeFileSync(join(root, "pm-changelog.ts"), [
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'fs.appendFileSync("calls", JSON.stringify(args) + "\\n");',
    'if (args.includes("--output")) fs.writeFileSync(args[args.indexOf("--output") + 1], "generated");',
  ].join("\n"));
  const hook = "changelog:full";
  const env = { ...process.env, CHANGELOG_SCRIPT: hook, CHANGELOG_CHECK_SCRIPT: hook, NOTES_SCRIPT: hook, RELEASE_HEADING_DATE: day };
  execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts")], { cwd: root, env });
  execFileSync("npm", ["run", hook], { cwd: root, env });
  const calls: string[][] = readFileSync(join(root, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.map(args => args.includes("--title") ? args[args.indexOf("--title") + 1] : "writer"),
    ["writer", "pre", "main", "post", "relay"]);
  for (const args of calls) {
    assert.equal(args[args.indexOf("--date-fallback") + 1], day);
    assert.ok(args.includes("--include-empty"));
    assert.equal(args.includes("--date-from-version"), false);
  }
  assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), "generated");
  assert.deepEqual(calls.filter(args => args.includes("--stdout")), [calls[2]]);
  const prepared = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  assert.equal(prepared.predisabled, scripts.predisabled);
  const hooks = resolveChangelogHooks(prepared, [hook]);
  assertReleaseHookHeadingDate(hooks, [hook], day);
  hooks.set("writer", scripts.writer);
  assert.throws(() => assertReleaseHookHeadingDate(hooks, [hook], day, "2026.11.16"), /Manually dispatch.*retire-unpublished/);
});

test("conflicting policies fail once across forwarded argv before either date can be rewritten", () => {
  const scripts = { hook: "npm run writer -- --date-fallback " + day, writer: "pm-changelog " + standing };
  const map = resolveChangelogHooks(scripts, ["hook"]);
  for (const check of [
    () => rewriteReleaseHookDates(map, ["hook"], day), () => assertReleaseHookHeadingDate(map, ["hook"], day),
  ]) assert.throws(check, /Mutually exclusive --date-from-version and --date-fallback.*Use a direct/);
  const result = auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts }) }]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /Mutually exclusive/);
});

test("workflow run scalars retain multiline arguments and cannot borrow options from another step", () => {
  const body = 'pm-changelog --title "first line\nsecond # line; still one title" ';
  assert.deepEqual(auditInvocations([workflow(body + standing, "echo done")]).failures, []);
  const missing = auditInvocations([workflow(body + "--release-version-from-package", "echo --date-from-version")]);
  assert.equal(missing.failures.length, 1);
  assert.match(missing.failures[0], /neither --date-from-version/);
  const malformed = auditInvocations([workflow('pm-changelog ' + standing + ' "open', 'echo close"')]);
  assert.equal(malformed.failures.length, 1);
  assert.match(malformed.failures[0], /unterminated quote.*Use a direct/);
  const manifest = { file: "package.json", text: JSON.stringify({ scripts: { writer: "pm-changelog --version v2026.11.16" } }) };
  assert.deepEqual(auditInvocations([workflow("npm run writer -- --date-from-version"), manifest]).failures, []);
});

test("nonexecuting guards, unrelated forwards and unversioned commands contribute no date failures", () => {
  const scripts = { unrelated: "echo done", checks: [
    "npm install pm-changelog", "test -x ./node_modules/.bin/pm-changelog", "command -p -v pm-changelog",
    'eval "npm run unrelated"', "SECTION=type; pm-changelog --stdout --section-by=$SECTION",
    "pm-changelog " + standing,
  ].join(" && ") };
  assert.deepEqual(auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts }) }]).failures, []);
});

test("uncertain generator commands name their unsupported construct and a direct replacement", () => {
  for (const [command, diagnostic] of [
    ["wrapper pm-changelog " + standing, /wrapper/],
    ['sh -c "pm-changelog ' + standing + '"', /"sh"/],
    ["pm-changelog --release-version-from-package --op$NAME=value", /Unresolved option word/],
    ["pm-changelog " + standing + " \\", /Incomplete shell escape/],
    ["pm-changelog " + standing + ">out", /Attached shell redirection/],
    ["out=`pm-changelog " + standing + "`", /substitution/],
    ["timeout pm-changelog", /Incomplete wrapper/],
  ] as const) {
    const result = auditInvocations([workflow(command, "pm-changelog " + standing)]);
    assert.equal(result.failures.length, 1, command);
    assert.match(result.failures[0], diagnostic);
    assert.match(result.failures[0], /Use a direct pm-changelog/);
  }
});

test("option-shaped pm arguments stay data and trailing operands retain their positions", () => {
  for (const option of ["--title", "--output", "-o", "--section-by"]) {
    assert.equal(includeEmptyReleaseSections("pm-changelog " + option), "pm-changelog --include-empty " + option);
  }
  assert.equal(includeEmptyReleaseSections("pm-changelog --pm-arg --include-empty"), "pm-changelog --pm-arg --include-empty --include-empty");
  assert.match(auditInvocations([workflow("pm-changelog --version 2026.11.16 --pm-arg --date-from-version")]).failures[0], /neither/);
});

test("the shared shell scanner decodes quoted timeout switches and records fixed option names", () => {
  const commands = tokenizeCommands('timeout "--signal" TERM 60 pm-changelog --title="$TITLE"');
  assert.equal(commandName(commands[0]), "pm-changelog");
  assert.equal(packageScriptCommand(tokenizeCommands("bun run changes")[0])?.[0].value, "bun");
  assert.equal(packageScriptCommand(tokenizeCommands("command")[0]), undefined);
  assert.equal(fixedOptionName(commands[0].at(-1)!), "--title");
  assert.equal(fixedOptionName(commands[0][0]), undefined);
});

test("release grammar retains escaped and quoted words, continuation and comment boundaries", () => {
  const escaped = 'pm-changelog --title "a\\qb \\"quote\\" \\$cash" --ver\\\nsion 2026.11.16 \\\n  --date-from-version # ignored\n# final';
  assert.deepEqual(auditInvocations([workflow(escaped)]).failures, []);
  assert.deepEqual(auditInvocations([workflow("", "pm-changelog " + standing)]).failures, []);
  for (const command of ["command", "npm install pm-changelog", "npm --silent install pm-changelog", "echo pm-changelog", "npm run loop"]) {
    const scripts = { hook: 'wrapper npm run auxiliary', auxiliary: command, loop: "npm run auxiliary" };
    assert.doesNotThrow(() => resolveChangelogHooks(scripts, ["hook"]));
  }
  const scripts = { hook: 'wrapper npm run --if-present relay', relay: "npm run changes", changes: "pm-changelog " + standing };
  assert.throws(() => resolveChangelogHooks(scripts, ["hook"]), /Unrecognized wrapper.*Use a direct/);
  assert.throws(() => resolveChangelogHooks({ hook: 12 }, ["hook"]), /Missing changelog hook/);
  assert.throws(() => resolveChangelogHooks({ hook: "npm run bad", bad: false }, ["hook"]), /missing or empty/);
  assert.throws(() => assertReleaseHookHeadingDate(new Map([["hook", "pm-changelog --version v2026.11.16"]]), ["hook"], day), /without a date policy/);
});

test("npm lifecycle controls respect option order and stop at the argument delimiter", () => {
  const fixture = { hook: "", target: "echo main", pretarget: "echo pre", posttarget: "echo post" };
  for (const [source, enabled] of [
    ["npm --ignore-scripts run target", false],
    ["npm run --ignore-scripts true target", false],
    ["npm run target --ignore-scripts=false", true],
    ["npm run --ignore-scripts target --no-ignore-scripts", true],
    ["npm run target -- --ignore-scripts", true],
  ] as const) {
    const hooks = resolveChangelogHooks({ ...fixture, hook: source }, ["hook"]);
    assert.equal(hooks.has("pretarget"), enabled, source);
    assert.equal(hooks.has("posttarget"), enabled, source);
  }
});

test("opaque argv expansion and descriptor operators cannot conceal a versioned generator", () => {
  for (const arg of ["--da*", "--title=\"$@\"", "--date-from-version 2>&1 --date-fallback 2026-11-17"]) {
    const result = auditInvocations([workflow("pm-changelog " + standing + " " + arg)]);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /Use a direct pm-changelog/);
  }
  assert.deepEqual(auditInvocations([workflow("pm-changelog " + standing, "pm-changelog --stdout --section-by=$(echo type)")]).failures, []);
});

test("continuation compares the version actually supplied to the generator", () => {
  const check = (version: string) => assertReleaseHookHeadingDate(new Map([["hook", "pm-changelog --date-from-version " + version]]), ["hook"], day, "2026.11.17");
  for (const version of ["--version=2026.11.16", "--release-version 2026.11.16"]) {
    assert.throws(() => check(version), /2026-11-16 differs.*retire-unpublished/);
  }
  assert.throws(() => check("--version"), /valid calendar version/);
  assert.throws(() => check('--version "$TAG"'), /valid calendar version/);
  assert.throws(() => check("--title $TITLE --release-version-from-package"), /multiword expansion/);
});

test("indirect executable and argv bindings cannot hide a release command behind a passing sibling", () => {
  for (const [body, diagnostic] of [
    ['GEN=pm-changelog; "$GEN" --version 2026.11.17', /Indirect pm-changelog executable/],
    ['pm-changelog "$OPTIONS"', /Unresolved option word/],
  ] as const) {
    const result = auditInvocations([workflow(body, "pm-changelog " + standing)]);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], diagnostic);
  }
  assert.deepEqual(auditInvocations([workflow('GEN=pm-changelog; echo "$GEN"', "pm-changelog " + standing)]).failures, []);
});

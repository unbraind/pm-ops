/** Exercise the release hook language at the same boundaries as npm and GitHub Actions. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { execFileSync } from "../subprocess.ts";
import {
  assertReleaseHeadingDate, assertReleaseHookHeadingDate, includeEmptyCustomHook, includeEmptyReleaseSections, npmLifecycle, resolveChangelogHooks, rewriteReleaseHeadingDate, rewriteReleaseHookDates, visitChangelogScriptCommands,
} from "../release-changelog-options.ts";
import { fixedOptionName, tokenizeCommands, tokenizeCommandsWithSpans, commandName, packageScriptCommand, releaseHookCommand } from "../shell-scan.ts";
import { parseReleaseHook } from "../release-hook-grammar.ts";
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
  writeFileSync(join(root, ".npmrc"), "ignore-scripts=false\n");
  writeFileSync(join(root, "pm-changelog.ts"), [
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'fs.appendFileSync("calls", JSON.stringify(args) + "\\n");',
    'if (args.includes("--output")) fs.writeFileSync(args[args.indexOf("--output") + 1], "generated");',
  ].join("\n"));
  const hook = "changelog:full";
  const env = { ...process.env, CHANGELOG_SCRIPT: hook, CHANGELOG_CHECK_SCRIPT: hook, NOTES_SCRIPT: hook, RELEASE_HEADING_DATE: day };
  execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts")], { cwd: root, env });
  execFileSync("npm", ["run", "--ignore-scripts=false", hook], { cwd: root, env: { ...env, npm_config_ignore_scripts: "false" } });
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
  const hooks = resolveChangelogHooks(prepared, [hook], true);
  assertReleaseHookHeadingDate(hooks, [hook], day, undefined, true);
  hooks.set("writer", scripts.writer);
  assert.throws(() => assertReleaseHookHeadingDate(hooks, [hook], day, "2026.11.16", true), /Manually dispatch.*retire-unpublished/);
});

test("preparation and npm agree when the project disables lifecycle hooks", t => {
  const root = mkdtempSync(join(tmpdir(), "release-hook-npmrc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = join(root, "package.json");
  const scripts = {
    hook: "node ./pm-changelog.ts " + standing + " --stdout",
    prehook: "node ./pm-changelog.ts " + standing,
  };
  const npmrc = join(root, ".npmrc");
  writeFileSync(npmrc, "ignore-scripts=true\n");
  writeFileSync(join(root, "pm-changelog.ts"),
    'if (!process.argv.includes("--stdout")) require("node:fs").writeFileSync("CHANGELOG.md", "ran");');
  const env = { ...process.env, CHANGELOG_SCRIPT: "hook", CHANGELOG_CHECK_SCRIPT: "hook", NOTES_SCRIPT: "hook", RELEASE_HEADING_DATE: day };
  for (const name of Object.keys(env).filter(key => /^npm_config_ignore_scripts$/i.test(key))) delete (env as NodeJS.ProcessEnv)[name];
  for (const override of [false, true]) {
    writeFileSync(manifest, JSON.stringify({ name: "fixture", scripts }));
    const runEnv = override ? { ...env, npm_config_ignore_scripts: "false" } : env;
    execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts")], { cwd: root, env: runEnv });
    const prepared = JSON.parse(readFileSync(manifest, "utf8")).scripts;
    if (override) assert.match(prepared.prehook, /--date-fallback 2026-11-17/);
    else assert.equal(prepared.prehook, scripts.prehook);
    execFileSync("npm", ["run", "hook"], { cwd: root, env: runEnv });
    assert.equal(existsSync(join(root, "CHANGELOG.md")), override);
  }
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
    ["pm-changelog " + standing + " --date-from-version=true", /Unexpected value on the boolean/],
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
  assert.equal(commandName(tokenizeCommands("command -p -v pm-changelog")[0]), "command");
  assert.equal(releaseHookCommand(tokenizeCommands("env TZ=UTC")[0]), undefined);
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

test("custom notes delimiters follow explicit forwards and refuse unreachable argv", () => {
  const scripts = new Map([["render", "node notes.js"], ["cycle", "npm run cycle"], ["comment", "node notes.js # no argv"],
    ["bun-render", "bun run render"]]);
  assert.equal(includeEmptyCustomHook("npm run --if-present missing", scripts), "npm run --if-present missing -- --include-empty");
  assert.equal(includeEmptyCustomHook("npm run bun-render", scripts), "npm run bun-render -- --include-empty");
  assert.equal(includeEmptyCustomHook(">", scripts), ">");
  assert.throws(() => includeEmptyCustomHook("npm run comment", scripts), /cannot receive forwarded arguments/);
  assert.throws(() => includeEmptyCustomHook("npm run cycle", scripts), /forward depth exceeds/);
});

test("npm lifecycle controls respect option order and stop at the argument delimiter", () => {
  const fixture = { hook: "", target: "echo main", pretarget: "echo pre", posttarget: "echo post" };
  for (const [source, enabled] of [
    ["npm --ignore-scripts run target", false],
    ["npm run --ignore-scripts true target", false],
    ["npm run target --ignore-scripts=false", true],
    ["npm run --ignore-scripts target --no-ignore-scripts", true],
    ["npm run target -- --ignore-scripts", true],
    ["> 'npm_config_ignore_scripts=true' npm run --no-ignore-scripts target", true],
    ["env NPM_CONFIG_IGNORE_SCRIPTS=true npm run target", false],
    ["npm_config_ignore_scripts=false npm run target", true],
    ["env npm_config_ignore_scripts=true npm run --ignore-scripts=false target", true],
  ] as const) {
    const hooks = resolveChangelogHooks({ ...fixture, hook: source }, ["hook"]);
    assert.equal(hooks.has("pretarget"), enabled, source);
    assert.equal(hooks.has("posttarget"), enabled, source);
  }
});

test("a redirection filename cannot disable an npm pre-hook", () => {
  const scripts = {
    hook: "> 'npm_config_ignore_scripts=true' npm run writer",
    writer: "node notes.js", prewriter: "pm-changelog " + standing,
  };
  const hooks = resolveChangelogHooks(scripts, ["hook"], true);
  assert.ok(hooks.has("prewriter"));
  assert.match(rewriteReleaseHookDates(hooks, ["hook"], day, true).get("prewriter")!, /--date-fallback 2026-11-17/);
});

test("npm lifecycle follows workflow env, project config and explicit options", () => {
  const writer = "pm-changelog " + standing;
  const scripts = { hook: "npm run target", target: writer, prehook: writer, posttarget: writer };
  const manifest = new Map(Object.entries(scripts));
  for (const [config, env, enabled] of [
    ["ignore-scripts=true", {}, false],
    ["ignore-scripts=true\r\n'ignore-scripts' = 'false'", {}, true],
    ["ignore-scripts=false # comment\n[section]\nignore-scripts=true", {}, true],
    ["ignore-scripts", {}, false],
    ["# ignored\nignore-scripts=true", { npm_config_ignore_scripts: "false" }, true],
    ["ignore-scripts=false", { NPM_CONFIG_IGNORE_SCRIPTS: true }, false],
    ["ignore-scripts=false", { npm_config_ignore_scripts: "" }, true],
  ] as const) {
    const lifecycle = npmLifecycle(config, env);
    assert.equal(lifecycle, enabled);
    const resolved = resolveChangelogHooks(scripts, ["hook"], lifecycle);
    assert.equal(resolved.has("prehook"), enabled);
    assert.equal(resolved.has("posttarget"), enabled);
    const rewritten = rewriteReleaseHookDates(manifest, ["hook"], day, lifecycle);
    assert.equal(rewritten.has("prehook"), enabled);
    assert.equal(rewritten.has("posttarget"), enabled);
    assert.doesNotThrow(() => assertReleaseHookHeadingDate(rewritten, ["hook"], day, undefined, lifecycle));
  }
  for (const lifecycle of [
    npmLifecycle(undefined), npmLifecycle("ignore-scripts = ${EXTERNAL}"),
    npmLifecycle("ignore-scripts=false\nignore-scripts[]=true"), npmLifecycle("ignore-scripts = 'false' # uncertain"),
    npmLifecycle("ignore-scripts=false", { npm_config_ignore_scripts: "${{ vars.IGNORE_SCRIPTS }}" }),
    npmLifecycle(undefined, { NPM_CONFIG_IGNORE_SCRIPTS: "true", npm_config_ignore_scripts: "false" }),
  ]) {
    assert.equal(lifecycle, "unknown");
    assert.throws(() => resolveChangelogHooks(scripts, ["hook"], lifecycle), /ignore-scripts.*prehook.*user\/global/);
  }
  const nested = { hook: "npm run --ignore-scripts=false target", target: writer, posttarget: writer };
  assert.ok(resolveChangelogHooks(nested, ["hook"], false).has("posttarget"));
  nested.hook = "npm_config_ignore_scripts=true npm run target";
  assert.ok(!resolveChangelogHooks(nested, ["hook"], true).has("posttarget"));
  nested.hook = 'env npm_config_ignore_scripts="$EXTERNAL" npm run target';
  assert.throws(() => resolveChangelogHooks(nested, ["hook"], true), /ignore-scripts.*posttarget/);
});

test("uncertain npm lifecycle refuses possible changelog writes but permits read-only hooks", () => {
  const writer = "pm-changelog " + standing;
  for (const prehook of [writer, writer + " --output", writer + " -o CHANGELOG.md", writer + " --output=./CHANGELOG.md",
    writer + " --output=\"$DEST\"", "printf heading &>CHANGELOG.md", "printf heading >> ./CHANGELOG.md", "printf heading >| \"CHANGELOG.md\"", "npm run writer"]) {
    assert.throws(() => resolveChangelogHooks({ hook: writer, prehook, writer }, ["hook"]), /ignore-scripts.*prehook/, prehook);
  }
  for (const prehook of [writer + " --stdout", writer + " --check", writer + " --output other.md", writer + " --output=other.md",
    "printf heading > other.md", "printf heading >", "printf '%s' '>CHANGELOG.md'", 'printf %s 2">CHANGELOG.md"',
    "printf heading > '$DEST'", writer + " --output='$DEST'", "echo done"]) {
    assert.ok(resolveChangelogHooks({ hook: writer, prehook }, ["hook"]).has("prehook"), prehook);
  }
});

test("uncertain npm lifecycle refuses unresolved redirection destinations", () => {
  const hook = "pm-changelog " + standing;
  for (const prehook of ['printf heading > "$DEST"', 'printf heading >>"$DEST"', 'printf heading > CHANGELOG.[m]d']) {
    assert.throws(() => resolveChangelogHooks({ hook, prehook }, ["hook"]), /ignore-scripts.*prehook/, prehook);
  }
});

test("bracket patterns in release hook words can expand into multiple arguments", () => {
  const command = "pm-changelog " + standing;
  const pattern = "--title [ab].md";
  const word = parseReleaseHook(command + " " + pattern).commands[0].at(-1);
  assert.equal(word?.unresolved, true);
  assert.equal(word?.multipleWords, true);
  assert.match(auditInvocations([workflow(command + " " + pattern)]).failures[0], /multiword expansion/);
  for (const literal of ["'[ab].md'", '"[ab].md"', "\\[ab].md"]) {
    assert.deepEqual(auditInvocations([workflow(command + " --title " + literal)]).failures, []);
  }
});

test("uncertain npm lifecycle sees effective argv through nested forwards", () => {
  const changes = "pm-changelog " + standing;
  const scripts = { hook: "echo main", prehook: "", relay: "npm run changes --", changes };
  for (const flag of ["--stdout", "--check", "--output=release.log", "-o=release.log"]) {
    scripts.prehook = "npm run relay -- " + flag;
    assert.ok(resolveChangelogHooks(scripts, ["hook"]).has("changes"), flag);
  }
  for (const prehook of ["npm run relay", "npm run relay -- --stdout > CHANGELOG.md", "npm run relay -- --pm-arg --check"]) {
    assert.throws(() => resolveChangelogHooks({ ...scripts, prehook }, ["hook"]), /ignore-scripts.*prehook/, prehook);
  }
  assert.throws(() => resolveChangelogHooks({
    ...scripts, prehook: "npm run relay -- --stdout", prechanges: changes,
  }, ["hook"]), /ignore-scripts.*prehook/);
  assert.ok(resolveChangelogHooks({
    ...scripts, prehook: "npm run --ignore-scripts relay -- --stdout", prechanges: changes,
  }, ["hook"]).has("changes"));
  assert.ok(resolveChangelogHooks({
    ...scripts, prehook: "bun run changes -- --check",
  }, ["hook"]).has("changes"));
  assert.throws(() => resolveChangelogHooks({
    ...scripts, prehook: "npm run changes -- --check; npm run changes",
  }, ["hook"]), /ignore-scripts.*prehook/);
  assert.throws(() => resolveChangelogHooks({
    ...scripts, prehook: "npm run changes || echo alternative # --stdout",
  }, ["hook"]), /ignore-scripts.*prehook/);
});

test("script traversal without an npm configuration refuses an implicit writer", () => {
  const scripts = new Map([["hook", "echo main"], ["prehook", "pm-changelog " + standing]]);
  assert.throws(() => visitChangelogScriptCommands(scripts, () => {}, ["hook"]), /ignore-scripts.*prehook/);
});

test("the date verifier uses workflow, job and step npm environment precedence", () => {
  const manifest = { file: "package.json", text: JSON.stringify({ scripts: {
    target: "pm-changelog " + standing, pretarget: "pm-changelog " + standing,
  } }) };
  const file = { file: ".github/workflows/release.yml", text: stringify({
    env: { npm_config_ignore_scripts: "${{ vars.EXTERNAL }}" },
    jobs: {
      configured: { env: { npm_config_ignore_scripts: "false" }, steps: [
        { run: "npm run target" }, { env: { npm_config_ignore_scripts: "true" }, run: "npm run target" },
      ] },
      unresolved: { steps: [{ run: "npm run target" }] },
    },
  }) };
  const result = auditInvocations([manifest, file, { file: ".npmrc", text: "ignore-scripts=true" }]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /ignore-scripts.*pretarget.*external env/);
});

test("release hooks preserve date options after joined and split redirections", () => {
  for (const redirect of ["&>out", "&>>out", "&> out", "&>> out", "2>1", "2>>1", "2> 1", ">| release.log", ">|release.log", "2>| release.log"]) {
    const hook = `pm-changelog ${redirect} ${standing}`;
    assert.deepEqual(auditInvocations([workflow(hook)]).failures, [], redirect);
    assert.equal(rewriteReleaseHookDates(new Map([["hook", hook]]), ["hook"], day).get("hook"),
      `pm-changelog ${redirect} --release-version-from-package --date-fallback ${day}`);
    assert.equal(releaseHookCommand(parseReleaseHook(hook).commands[0])?.[1].value, "--release-version-from-package");
  }
});

test("Bun global switches preserve source generator argv on both sides of run", () => {
  for (const prefix of ["bun --silent run", "bun run --silent", "bun --silent run --smol", "bun --silent"]) {
    const hook = `${prefix} ./scripts/pm-changelog.ts ${standing}`;
    assert.equal(rewriteReleaseHookDates(new Map([["hook", hook]]), ["hook"], day).get("hook"),
      `${prefix} ./scripts/pm-changelog.ts --release-version-from-package --date-fallback ${day}`);
  }
});

test("shell builtin and command prefixes preserve release directory changes", () => {
  for (const change of ["builtin cd", "builtin -- pushd", "command cd", "command -p pushd", "command builtin cd", "builtin command cd"]) {
    const hook = `${change} docs && pm-changelog ${standing}`;
    assert.throws(() => resolveChangelogHooks({ hook }, ["hook"]), /context change.*(?:cd|pushd)/i, change);
  }
  assert.doesNotThrow(() => resolveChangelogHooks({ hook: "command -v cd && pm-changelog " + standing }, ["hook"]));
});

test("a descriptor duplication stays with its command before an output-filter pipeline", () => {
  const valid = "pm-changelog " + standing + " 2>&1 | grep Release";
  assert.deepEqual(auditInvocations([workflow(valid)]).failures, []);
  assert.equal(rewriteReleaseHookDates(new Map([["hook", valid]]), ["hook"], day).get("hook"),
    "pm-changelog --release-version-from-package --date-fallback 2026-11-17 2>&1 | grep Release");
  assert.deepEqual(auditInvocations([workflow(valid.replace(standing + " 2>&1", "2>&10 " + standing))]).failures, []);
  const conflicting = valid.replace("2>&1", "2>&1 --date-fallback 2026-11-17");
  assert.match(auditInvocations([workflow(conflicting)]).failures[0], /Mutually exclusive/);
  assert.match(auditInvocations([workflow("pm-changelog " + standing + " & grep Release")]).failures[0], /background/);
});

test("a traversing redirection is classified as a CHANGELOG write", () => {
  const writer = "pm-changelog " + standing;
  const traversal = 'printf heading > "docs/../CHANGELOG.md"';
  const scripts = { hook: writer, prehook: traversal };
  const reason = /path traversal.*CHANGELOG\.md.*script file/i;
  assert.throws(() => resolveChangelogHooks(scripts, ["hook"]), reason);
  assert.ok(resolveChangelogHooks(scripts, ["hook"], true).has("prehook"));
  assert.throws(() => resolveChangelogHooks({ ...scripts, prehook: "npm run helper", helper: traversal }, ["hook"]),
    /ignore-scripts.*prehook.*CHANGELOG\.md/);
  const configured = { "changelog:full": writer, "prechangelog:full": traversal, "release:notes": writer };
  assert.match(auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts: configured }) }]).failures[0], reason);
  assert.ok(resolveChangelogHooks({ ...scripts, prehook: traversal.replace("CHANGELOG.md", "other.md") }, ["hook"]).has("prehook"));
});

test("a directory change in a loop condition is refused before rewriting", () => {
  const writer = "pm-changelog " + standing;
  const reason = /directory change (?:cd|pushd) in a loop condition.*script file/i;
  for (const condition of ["while cd docs; do", "until true; builtin pushd docs; do", "while if true; then cd docs; fi; do"]) {
    const hook = condition + " :; break; done; " + writer;
    assert.throws(() => resolveChangelogHooks({ hook }, ["hook"]), reason);
    assert.throws(() => rewriteReleaseHeadingDate(hook, day), reason);
    assert.match(auditInvocations([workflow(hook)]).failures[0], reason);
  }
  assert.doesNotThrow(() => resolveChangelogHooks({ hook: "while false; do echo cd; done; " + writer }, ["hook"]));
  assert.doesNotThrow(() => resolveChangelogHooks({ hook: "\\while cd docs; " + writer }, ["hook"]));
});

test("a descriptor duplication joins a continuation before it is refused", () => {
  const writer = "pm-changelog " + standing;
  const continuation = "\\" + "\n";
  const reason = /continued descriptor redirection.*script file/i;
  for (const redirect of ["2>" + continuation + "&1", "2" + continuation + ">&1", "2>&" + continuation + "1"]) {
    const hook = writer + " " + redirect + " | grep Release";
    const [command] = parseReleaseHook(hook).commands;
    assert.equal(command.at(-1)?.value, "2>&1");
    assert.throws(() => resolveChangelogHooks({ hook }, ["hook"]), reason);
    assert.throws(() => assertReleaseHeadingDate([hook], day, "2026.11.17"), reason);
    assert.match(auditInvocations([workflow(hook)]).failures[0], reason);
  }
  assert.doesNotThrow(() => resolveChangelogHooks({ hook: writer + " " + continuation + "--title release" }, ["hook"]));
});

test("versioned generator options refuse unquoted brace expansion", () => {
  const writer = "pm-changelog " + standing;
  const reason = /unquoted brace expansion.*versioned generator options.*script file/i;
  for (const arg of ["--{date-from-version,date-fallback}=2026-11-17", "--title=release-{1..3}", "--title={'one',two}"]) {
    const hook = writer + " " + arg;
    assert.throws(() => resolveChangelogHooks({ hook }, ["hook"]), reason);
    assert.match(auditInvocations([workflow(hook)]).failures[0], reason);
    const forwarded = "npm run writer -- " + arg;
    assert.throws(() => rewriteReleaseHookDates(new Map([["hook", forwarded], ["writer", writer]]), ["hook"], day), reason);
  }
  for (const arg of ["--title='{one,two}'", '--title="{one,two}"', "--title=\\{one,two}", "--title={one}", "--title={one..two}"]) {
    assert.doesNotThrow(() => resolveChangelogHooks({ hook: writer + " " + arg }, ["hook"]));
  }
  assert.throws(() => resolveChangelogHooks({ hook: "pm-changelog --date-from-version --title={one,two}" }, ["hook"]), reason);
  assert.doesNotThrow(() => resolveChangelogHooks({ hook: "pm-changelog --stdout --title={one,two}" }, ["hook"]));
});

test("a generator assignment cannot cross an npm run forward", () => {
  const scripts = { "changelog:full": 'GEN="pm-changelog" npm run writer', writer: '"$GEN" ' + standing };
  const reason = /generator binding through variable assignment GEN.*npm run forward.*script file/i;
  assert.throws(() => resolveChangelogHooks(scripts, ["changelog:full"]), reason);
  assert.throws(() => assertReleaseHookHeadingDate(new Map(Object.entries(scripts)), ["changelog:full"], day), reason);
  assert.match(auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts }) }]).failures[0], reason);
  assert.throws(() => resolveChangelogHooks({ ...scripts, "changelog:full": "env 'GEN=pm-changelog' npm run writer" },
    ["changelog:full"]), reason);
  for (const hook of ["TZ=UTC npm run writer", "GEN= npm run writer", "exec -a GEN=pm-changelog npm run writer"]) {
    assert.doesNotThrow(() => resolveChangelogHooks({ hook, writer: "pm-changelog " + standing }, ["hook"]));
  }
});

test("opaque argv expansion cannot conceal a versioned generator", () => {
  for (const arg of ["--da*", "--title=\"$@\""]) {
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
  for (const version of ['--version "$TAG"', '--version="$TAG"', '--release-version "$TAG"']) {
    assert.throws(() => check(version), /Unresolved .* operand.*--release-version-from-package/);
  }
  assert.throws(() => check("--title $TITLE --release-version-from-package"), /multiword expansion/);
});

test("the date audit keeps a title containing a quoted redirection character", () => {
  const command = 'pm-changelog --title 2">" --release-version-from-package';
  assert.match(auditInvocations([workflow(command)]).failures[0], /neither --date-from-version/);
  assert.deepEqual(auditInvocations([workflow(command + " --date-from-version")]).failures, []);
});

test("continuation binds heading date policies to the release coordinate", () => {
  const version = "2026.1.2-1";
  const check = (policy: string, selection: string) => assertReleaseHookHeadingDate(
    new Map([["hook", "npm run changes -- " + selection], ["changes", "pm-changelog " + policy]]),
    ["hook"], "2026-01-02", version);
  for (const policy of ["--date-fallback 2026-01-02", "--date-from-version"]) {
    for (const selection of ["--release-version-from-package", "--version=v2026.01.02-1", "--release-version 2026.1.2-1"]) {
      assert.doesNotThrow(() => check(policy, selection));
    }
    assert.throws(() => check(policy, "--release-version-from-package --version=2026.1.2"), /release version .* does not match.*2026\.1\.2-1.*retire-unpublished/);
  }
  assert.throws(() => check("--date-fallback 2026-01-02", "--release-version 2026.1.1"), /release version .* does not match/);
});

test("continuation checks the pending heading cutoff for versioned all-release-tags hooks", () => {
  const command = `pm-changelog --all-release-tags --release-version-from-package --date-fallback ${day}`;
  const check = (script: string) => assertReleaseHookHeadingDate(new Map([["hook", script]]), ["hook"], day);
  for (const cutoff of [`--until '${day}'`, `"--until"="${day}"`]) {
    assert.doesNotThrow(() => check(`${command} ${cutoff}`));
  }
  for (const cutoff of ["--until", "--until=", "--until=2026-02-30", '--until "$CUTOFF"', '--until="$CUTOFF"']) {
    assert.throws(() => check(`${command} ${cutoff}`), /Invalid --until operand.*real YYYY-MM-DD.*retire-unpublished/);
  }
  const conflict = /--until day 2026-11-16.*heading day 2026-11-17.*Remove --until.*retire-unpublished/;
  assert.throws(() => check(`${command} --until 2026-11-16`), conflict);
  assert.throws(() => assertReleaseHookHeadingDate(new Map([
    ["hook", "npm run writer -- --until 2026-11-16"], ["writer", command],
  ]), ["hook"], day), conflict);
  assert.throws(() => assertReleaseHeadingDate([
    "pm-changelog --all-release-tags " + standing + " --until=2026-11-16",
  ], day, "2026.11.17"), conflict);
  assert.doesNotThrow(() => check(`${command.replace(" --all-release-tags", "")} --until 2026-11-16`));
  assert.doesNotThrow(() => check(`${command} --pm-arg --until=2026-11-16`));
  assert.doesNotThrow(() => check(`${command.replace("--all-release-tags", "--pm-arg --all-release-tags")} --until 2026-11-16`));
});

test("preparation checks the all-tags cutoff against the version day when a pin is unnecessary", () => {
  const command = "pm-changelog --all-release-tags " + standing;
  const rewrite = (cutoff: string) => rewriteReleaseHookDates(new Map([["hook", command + " " + cutoff]]),
    ["hook"], "", false, "2026.11.17");
  assert.equal(rewrite("--until=" + day).get("hook"), command + " --until=" + day);
  assert.throws(() => rewrite("--until 2026-11-16"), /Remove --until or set it to 2026-11-17/);
  assert.throws(() => rewrite('--until="$DAY"'), /Invalid --until operand.*Remove --until or set it to 2026-11-17/);
});

test("preparation and continuation refuse date overrides and alternate npm exec projects", () => {
  for (const [command, diagnostic] of [
    ["pm-changelog " + standing + " --date 2026-11-16", /Explicit --date overrides/],
    ["pm-changelog --version 2026.11.16 --date-fallback 2026-11-17 --date=2026-11-16", /Explicit --date overrides/],
    ['pm-changelog --version "$npm_package_version" --date-fallback 2026-11-17', /Unresolved --version operand/],
    ["npm exec --workspace=docs -- pm-changelog " + standing, /context change npm exec --workspace/],
    ["npm exec -w docs -- pm-changelog " + standing, /context change npm exec -w/],
    ["npm exec --prefix=docs -- pm-changelog " + standing, /context change npm exec --prefix/],
    ["npm exec --workspaces -- pm-changelog " + standing, /context change npm exec --workspaces/],
    ["npm exec --script-shell sh -- pm-changelog " + standing, /Unsupported npm exec options/],
  ] as const) {
    const scripts = new Map([["hook", command]]);
    assert.throws(() => rewriteReleaseHookDates(scripts, ["hook"], day), diagnostic);
    assert.throws(() => assertReleaseHookHeadingDate(scripts, ["hook"], day, "2026.11.17"), diagnostic);
    assert.match(auditInvocations([workflow(command)]).failures[0], diagnostic);
  }
  assert.doesNotThrow(() => assertReleaseHookHeadingDate(
    new Map([["hook", "npm exec -- pm-changelog " + standing]]), ["hook"], day, "2026.11.17"));
});

test("release hook context changes are refused once at the entry point and after two forwards", () => {
  const hook = "changelog:full";
  const generator = "pm-changelog " + standing;
  const writers = { relay: "npm run writer", writer: generator, "writer@docs": generator };
  for (const [command, construct] of [
    ["nohup npm run relay", "nohup"],
    ["nohup npm run writer@docs", "nohup"],
    ["nohup sh -c 'npm run writer@docs'", "nohup"],
    ["nohup sh -c 'sh -c \"npm run writer@docs\"'", "nohup"],
    ["timeout 60 nohup npm run relay", "nohup"],
    ["env -u npm_config_ignore_scripts npm run relay", "env -u"],
    ["env --unset=npm_config_ignore_scripts npm run relay", "env --unset"],
    ["env -i npm run relay", "env -i"],
    ["env 'PM_PATH=docs' npm run relay", "env PM_PATH"],
    ["PM_PATH=docs npm run relay", "PM_PATH assignment"],
    ["PM_PATH=docs; npm run relay", "PM_PATH assignment"],
    ["exec -c npm run relay", "exec -c"],
    ["exec -lc npm run relay", "exec -lc"],
    ["export npm_config_ignore_scripts=true; npm run relay", "export npm_config_ignore_scripts"],
    ["unset NPM_CONFIG_IGNORE_SCRIPTS; npm run relay", "unset NPM_CONFIG_IGNORE_SCRIPTS"],
    ["cd docs && npm run relay", "cd"],
    ["CDPATH=docs cd docs && npm run relay", "cd"],
    ["command cd docs && npm run missing-locally", "cd"],
    ["export PM_PATH=docs; cd docs; npm run missing-locally", "cd"],
    ["pushd docs >/dev/null; npm run relay", "pushd"],
    ["npm --prefix docs run relay", "--prefix"],
    ["npm run relay --prefix=docs", "--prefix"],
    ["npm run --workspace docs relay", "--workspace"],
    ["pnpm -Cdocs run relay", "-Cdocs"],
    ["env -C docs npm run relay", "env -C"],
    ["npm --prefix docs exec -- " + generator, "--prefix"],
    [generator + " --pm-cwd docs", "--pm-cwd"],
    ["npm run relay -- --pm-cwd=docs", "--pm-cwd"],
  ]) {
    for (const nested of [false, true]) {
      const scripts = nested
        ? { [hook]: "npm run first", first: "npm run second", second: command, ...writers }
        : { [hook]: command, ...writers };
      const map = new Map(Object.entries(scripts));
      const checkRefusal = (error: unknown) => error instanceof Error
        && error.message.includes(construct) && error.message.includes("Use a direct pm-changelog");
      assert.throws(() => resolveChangelogHooks(scripts, [hook]), checkRefusal, command);
      assert.throws(() => rewriteReleaseHookDates(map, [hook], day), checkRefusal, command);
      assert.throws(() => assertReleaseHookHeadingDate(map, [hook], day, "2026.11.17"), checkRefusal, command);
      const result = auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts }) }]);
      assert.equal(result.failures.length, 1, command);
      assert.ok(checkRefusal(new Error(result.failures[0])), result.failures[0]);
    }
  }
});

test("canonical hook paths retain their directory, generator arguments and modeled lifecycle settings", () => {
  const writer = "pm-changelog " + standing + " --pm-arg --pm-cwd --title cd";
  for (const second of [
    "env TZ=UTC timeout 60 npm run --ignore-scripts writer",
    "env npm_config_ignore_scripts=true npm run writer",
    "exec -l npm run writer",
    "exec -a release-hook npm run writer",
    "npm run writer -- --title=--prefix",
    "echo 'export PM_PATH=docs'; npm run writer",
    "npm run writer; cd docs",
    "if true\nthen\nnpm run writer\nfi",
    "env -u PM_PATH echo helper; npm run writer",
  ]) {
    const scripts = { hook: "npm run first", first: "npm run second", second, writer };
    const map = resolveChangelogHooks(scripts, ["hook"]);
    assertReleaseHookHeadingDate(map, ["hook"], day, "2026.11.17");
    assert.match(rewriteReleaseHookDates(map, ["hook"], day).get("writer")!, /--date-fallback 2026-11-17/);
    assert.deepEqual(auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts }) }]).failures, []);
  }
});

test("standalone option rewriting also refuses a changed execution context", () => {
  assert.throws(() => includeEmptyReleaseSections("cd docs && pm-changelog " + standing), /context change cd.*Use a direct/);
});

test("release hooks refuse shell modes and builtins that can invalidate the parsed commands", () => {
  const writer = "pm-changelog " + standing;
  for (const [prefix, construct] of [
    ["shopt -s lastpipe; cd docs | true", "shopt"],
    ["shopt -s lastpipe; printf docs | cd docs", "shopt"],
    ["shopt -u extglob", "shopt"],
    ["set -o posix", "set -o posix"],
    ["set +o allexport", "set +o allexport"],
    ["set -euo pipefail +o noglob", "set +o noglob"],
    ["set -f", "set -f"],
    ['set "$SWITCHES"', 'set $SWITCHES'],
    ["set -o \"$OPTION\"", "set -o"],
    ["enable -n cd", "enable"],
    ["alias cd='echo cd'", "alias"],
    ["command source ./settings.sh", "source"],
    ["builtin shopt -s lastpipe", "shopt"],
    ["builtin command shopt -s lastpipe", "shopt"],
    ["builtin -- . ./settings.sh", "."],
  ]) {
    const refuses = (error: unknown) => error instanceof Error
      && error.message.includes("context change " + construct + ".") && error.message.includes("Use a direct pm-changelog");
    const hook = prefix + "; " + writer;
    const scripts = { "changelog:full": "npm run hook", hook };
    const map = new Map(Object.entries(scripts));
    assert.throws(() => resolveChangelogHooks(scripts, ["changelog:full"]), refuses, hook);
    assert.throws(() => rewriteReleaseHookDates(map, ["changelog:full"], day), refuses, hook);
    assert.throws(() => assertReleaseHookHeadingDate(map, ["changelog:full"], day), refuses, hook);
    assert.throws(() => assertReleaseHeadingDate([hook], day), refuses, hook);
    assert.throws(() => includeEmptyReleaseSections(hook), refuses, hook);
    const result = auditInvocations([workflow(hook)]);
    assert.equal(result.failures.length, 1, hook);
    assert.ok(refuses(new Error(result.failures[0])), result.failures[0]);
  }
  assert.throws(() => resolveChangelogHooks({ "changelog:full": ". ./writer.sh" }, ["changelog:full"]), /context change \./);
  assert.deepEqual(auditInvocations([workflow("source ./settings.sh; echo ready", writer)]).failures, []);
  assert.equal(includeEmptyReleaseSections("source ./settings.sh; echo ready"), "source ./settings.sh; echo ready");
});

test("directory changes remain local to pipeline stages and subshells", () => {
  const writer = "pm-changelog " + standing;
  const pinned = writer.replace("--date-from-version", "--date-fallback " + day);
  for (const prefix of [
    "cd docs | true; ",
    "cd docs | cat; ",
    "cd docs |& cat; ",
    "printf docs |\ncd docs; ",
    "(cd docs); ",
    "(echo prepare; cd docs; (echo nested); echo done); ",
    "if (echo prepare; cd docs; echo done); then echo ready; fi; ",
    "set -euo pipefail; cd docs | true; ",
    "set -eu +u; ",
    "set -o errexit -o nounset +o pipefail; ",
    "set -o; ",
    "set -- -o posix; ",
    "builtin || true; ",
  ]) {
    const hook = prefix + writer;
    const map = resolveChangelogHooks({ hook }, ["hook"]);
    assert.equal(rewriteReleaseHookDates(map, ["hook"], day).get("hook"), prefix + pinned);
    assertReleaseHookHeadingDate(map, ["hook"], day, "2026.11.17");
    assertReleaseHeadingDate([hook], day, "2026.11.17");
    assert.equal(includeEmptyReleaseSections(hook), hook + " --include-empty");
    assert.deepEqual(auditInvocations([workflow(hook)]).failures, [], hook);
  }
  for (const prefix of ["cd docs && ", "cd docs; echo helper | cat; ", "cd docs; (echo helper); "]) {
    const hook = prefix + writer;
    assert.throws(() => resolveChangelogHooks({ hook }, ["hook"]), /context change cd/);
    assert.throws(() => assertReleaseHeadingDate([hook], day, "2026.11.17"), /context change cd/);
  }
  const piped = `cd docs | ${writer} | cat`;
  assertReleaseHeadingDate([piped], day, "2026.11.17");
  assert.deepEqual(auditInvocations([workflow(piped)]).failures, []);
  assert.throws(() => resolveChangelogHooks({ hook: `(echo start; ${writer}; echo done)` }, ["hook"]), /Shell grouping/);
});

test("opaque wrappers can reach a writer through other opaque forwards", () => {
  const scripts = { hook: "nohup npm run first", first: "npm run second", second: "nohup npm run writer", writer: "pm-changelog " + standing };
  assert.throws(() => resolveChangelogHooks(scripts, ["hook"]), /"nohup".*Use a direct/);
  assert.throws(() => resolveChangelogHooks({ ...scripts, second: "cd docs && npm run nested-only" }, ["hook"]), /"nohup".*Use a direct/);
});

test("implicit empty lifecycle scripts are skipped at release roots and in forwards", () => {
  const hook = "changelog:full";
  const scripts = { [hook]: "npm run writer", ["pre" + hook]: "", ["post" + hook]: "", writer: "pm-changelog " + standing, prewriter: "", postwriter: "" };
  const map = resolveChangelogHooks(scripts, [hook]);
  assert.deepEqual([...map.keys()], [hook, "writer"]);
  assert.match(rewriteReleaseHookDates(new Map(Object.entries(scripts)), [hook], day).get("writer")!, /--date-fallback 2026-11-17/);
  assertReleaseHookHeadingDate(new Map(Object.entries(scripts)), [hook], day, "2026.11.17");
  assert.throws(() => resolveChangelogHooks(scripts, ["pre" + hook]), /Missing changelog hook/);
});

test("preparation refuses invalid days and version mismatches before changing any manifest script", t => {
  const root = mkdtempSync(join(tmpdir(), "release-hook-invalid-date-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = { hook: "pm-changelog " + standing };
  const manifest = join(root, "package.json");
  const before = JSON.stringify({ version: "2026.11.17", scripts });
  writeFileSync(manifest, before);
  const env = { ...process.env, CHANGELOG_SCRIPT: "hook", CHANGELOG_CHECK_SCRIPT: "hook", NOTES_SCRIPT: "hook" };
  const command = [resolve("scripts/prepare-release-changelog.ts")];
  assert.throws(() => execFileSync(process.execPath, command, { cwd: root, env: { ...env, RELEASE_HEADING_DATE: "2026-02-30" }, stdio: "pipe" }), /real calendar day/);
  assert.equal(readFileSync(manifest, "utf8"), before);
  execFileSync(process.execPath, command, { cwd: root, env: { ...env, RELEASE_HEADING_DATE: day } });
  assert.match(JSON.parse(readFileSync(manifest, "utf8")).scripts.hook, /--date-fallback 2026-11-17/);
  const wrong = JSON.stringify({ version: "2026.11.17", scripts: {
    hook: "npm run changes -- --version=2026.11.16",
    changes: "pm-changelog --date-fallback 2026-11-16",
  } });
  writeFileSync(manifest, wrong);
  assert.throws(() => execFileSync(process.execPath, command, { cwd: root, env: { ...env, RELEASE_HEADING_DATE: day }, stdio: "pipe" }),
    /release version "2026.11.16" does not match package release version "2026.11.17"/);
  assert.equal(readFileSync(manifest, "utf8"), wrong);
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

test("Bun includes pre/post writers and pnpm refuses configuration-dependent lifecycle writers", () => {
  const fixture = { writer: "pm-changelog " + standing, prewriter: "npm run before", before: "pm-changelog " + standing, postwriter: "pm-changelog " + standing };
  const hooks = resolveChangelogHooks({ ...fixture, hook: "bun run writer" }, ["hook"]);
  for (const writer of ["before", "writer", "postwriter"]) {
    assert.match(rewriteReleaseHookDates(hooks, ["hook"], day).get(writer)!, /--date-fallback 2026-11-17/);
  }
  for (const run of ["pnpm run", "pnpm run-script"]) {
    assert.throws(() => resolveChangelogHooks({ ...fixture, hook: run + " writer" }, ["hook"]), /Configuration-dependent pnpm lifecycle/);
    assert.ok(resolveChangelogHooks({ writer: fixture.writer, hook: run + " writer" }, ["hook"]).has("writer"));
  }
  for (const hook of ["env -C elsewhere npm run writer", "env --chdir=elsewhere npm run writer", "npm run writer --prefix elsewhere", "bun run-script writer"]) {
    assert.throws(() => resolveChangelogHooks({ ...fixture, hook }, ["hook"]), /Use a direct pm-changelog/, hook);
  }
  const scripts = resolveChangelogHooks({ hook: "npm run unrelated flag", unrelated: "echo done" }, ["hook"]);
  assert.ok(scripts.has("unrelated"));
});

test("the public shell scanner still returns editable spans in literal substitution bodies", () => {
  const text = 'heading=$(pm-changelog "--date-from-version")';
  const { commands, spans } = tokenizeCommandsWithSpans(text);
  const option = commands.flat().find(word => word.value === "--date-from-version")!;
  const { start, end } = spans.get(option)!;
  assert.equal(text.slice(start, end), '"--date-from-version"');
});

test("literal here-document data is never rewritten and opaque executable bodies are refused", () => {
  const body = "pm-changelog --version v2026.11.16";
  const sibling = "pm-changelog " + standing;
  for (const opener of ["cat <<'END'", "cat <<'END' # ignore <<BAD pm-changelog"]) {
    const data = opener + "\n" + body + "\nEND";
    assert.deepEqual(auditInvocations([workflow(data + "\n" + sibling)]).failures, []);
    assert.equal(includeEmptyReleaseSections(data), data);
  }
  for (const script of ["sh <<'END'\n" + body + "\nEND", "cat <<END\n$(" + body + ")\nEND"]) {
    assert.throws(() => includeEmptyReleaseSections(script), /Here-document.*Use a direct/);
  }
  const title = 'pm-changelog --title "first\ncat <<END\n' + body + '\nEND\nlast" ' + standing;
  assert.deepEqual(auditInvocations([workflow(title)]).failures, []);
});

test("a computed lifecycle switch or opaque runner cannot conceal an implicit-only writer", () => {
  const scripts = { main: "echo done", premain: "pm-changelog " + standing };
  for (const hook of ['env npm_config_ignore_scripts="$SETTING" npm run main', "wrapper npm run main"]) {
    assert.throws(() => resolveChangelogHooks({ hook, ...scripts }, ["hook"]), /Use a direct pm-changelog/);
  }
});

test("generator text piped to an opaque executable is refused while ordinary output filters remain data", () => {
  const generator = "pm-changelog " + standing;
  for (const sink of ["sh", "cat | bash", '"$SINK"', "env"]) {
    assert.throws(() => includeEmptyReleaseSections("printf '%s' '" + generator + "' | " + sink), /Pipeline to an opaque executable.*Use a direct/);
  }
  assert.equal(includeEmptyReleaseSections("echo pm-changelog | grep pm-changelog"), "echo pm-changelog | grep pm-changelog");
  const scripts = { writer: generator, hook: "sh <<'END'\nnpm run writer\nEND" };
  assert.throws(() => resolveChangelogHooks(scripts, ["hook"]), /Here-document.*Use a direct/);
});

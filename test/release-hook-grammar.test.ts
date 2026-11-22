/** Exercise the release hook language at the same boundaries as npm and GitHub Actions. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { executableShellBodies } from "../attestation.ts";
import { projectNpmLifecyclePolicy } from "../scripts/project-npm-lifecycle.ts";
import { npmCli } from "../scripts/release-runtime.ts";
import { execFileSync } from "../subprocess.ts";
import {
  assertReleaseHeadingDate, assertReleaseHookHeadingDate, includeEmptyCustomHook, includeEmptyReleaseSections, npmLifecycle, resolveChangelogHooks, rewriteReleaseHeadingDate, rewriteReleaseHookDates, visitChangelogScriptCommands,
} from "../release-changelog-options.ts";
import { fixedOptionName, tokenizeCommands, tokenizeCommandsWithSpans, commandName, packageScriptCommand, releaseHookCommand, shellRedirection } from "../shell-scan.ts";
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

test("the date audit skips only a literal false workflow step", () => {
  const audit = (condition: boolean | string) => auditInvocations([{
    file: ".github/workflows/release.yml", text: stringify({ jobs: { release: { steps: [
      { if: condition, run: "pm-changelog --release-version-from-package" },
      { run: "pm-changelog " + standing },
    ] } } }),
  }]).failures;
  assert.deepEqual(audit(false), []);
  for (const condition of [true, "${{ inputs.generate }}"]) {
    assert.match(audit(condition)[0] ?? "", /neither --date-from-version/);
  }
});

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
  for (const name of Object.keys(env).filter(key => /^npm_config_ignore_scripts$/i.test(key))) delete (env as NodeJS.ProcessEnv)[name];
  Object.assign(env, { npm_config_ignore_scripts: "false" });
  execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts")], { cwd: root, env });
  execFileSync(process.execPath, [npmCli(), "run", "--ignore-scripts=false", hook], { cwd: root, env });
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
    const output = join(root, "outputs");
    writeFileSync(output, "");
    const runEnv = { ...env, GITHUB_OUTPUT: join(root, "outer-job-outputs"), ...(override ? { npm_config_ignore_scripts: "false" } : {}) };
    execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts"), output], { cwd: root, env: runEnv });
    const prepared = JSON.parse(readFileSync(manifest, "utf8")).scripts;
    assert.equal(existsSync(runEnv.GITHUB_OUTPUT), false);
    assert.equal(readFileSync(output, "utf8"), "npm_lifecycle=" + override + "\nnpm_lifecycle_configured=false\n");
    if (override) assert.match(prepared.prehook, /--date-fallback 2026-11-17/);
    else assert.equal(prepared.prehook, scripts.prehook);
    execFileSync(process.execPath, [npmCli(), "run", "hook"], { cwd: root, env: runEnv });
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
    ["pm-changelog " + standing + ">out &", /Shell background/],
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

test("package version selection uses a bare boolean and explicit versions accept inline values", () => {
  const verify = (selector: string) => auditInvocations([workflow(`pm-changelog ${selector} --date-from-version`)]).failures;
  for (const selector of ["--release-version-from-package", "--version=2026.11.17", "--release-version=2026.11.17"]) {
    assert.deepEqual(verify(selector), [], selector);
  }
  for (const selector of ["--release-version-from-package=true", "--release-version-from-package=false", "--release-version-from-package="]) {
    assert.match(verify(selector).join("\n"), /Unexpected value on the boolean --release-version-from-package/, selector);
  }
  assert.match(verify('--release-version-from-package="$VALUE"').join("\n"), /Unresolved option word/);
  assert.deepEqual(verify('--release-version-from-package --title="$VALUE"'), []);
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
  const mixedPipeline = "pm-changelog --output preview.md; node notes.mjs | cat";
  assert.equal(includeEmptyCustomHook(mixedPipeline, scripts, true), mixedPipeline.replace("notes.mjs", "notes.mjs --include-empty"));
  for (const filter of ["cat", "awk", "sed", "grep", "head", "tail", "cut", "tr", "sort", "uniq", "wc"]) {
    const pipeline = "pm-changelog --stdout --include-empty | " + filter;
    assert.equal(includeEmptyCustomHook(pipeline, scripts, true), pipeline);
    scripts.set("pipeline", pipeline);
    assert.equal(includeEmptyCustomHook("npm run pipeline", scripts, true), "npm run pipeline");
  }
  for (const tail of ["true --stdout", "false", ":", "git add CHANGELOG.md", "git diff --exit-code"]) {
    const script = "pm-changelog --stdout && " + tail;
    assert.equal(includeEmptyCustomHook(script, scripts, true), script);
  }
  for (const text of ["# no command", ">"]) {
    scripts.set("empty", text);
    assert.throws(() => includeEmptyCustomHook("npm run empty", scripts), /cannot receive forwarded arguments/);
  }
  assert.equal(includeEmptyCustomHook("npm run --if-present missing", scripts, true), "npm run --if-present missing");
  scripts.set("generate", "pm-changelog --stdout; # done");
  assert.equal(includeEmptyCustomHook("npm run generate", scripts, true), "npm run generate");
  assert.throws(() => includeEmptyCustomHook("npm run comment", scripts, true), /cannot receive forwarded arguments/);
  assert.equal(includeEmptyCustomHook("npm run bun-render", scripts), "npm run bun-render -- --include-empty");
  assert.equal(includeEmptyCustomHook(">", scripts), ">");
  assert.throws(() => includeEmptyCustomHook("npm run comment", scripts), /cannot receive forwarded arguments/);
  assert.throws(() => includeEmptyCustomHook("npm run cycle", scripts), /forward depth exceeds/);
});

test("notes preparation routes options before tee and refuses an opaque pipeline", () => {
  const render = "node notes.mjs";
  for (const suffix of [" | tee /dev/null", " | tee preview.md | head -n 1", " | tee '>(sh)'"]) {
    assert.equal(includeEmptyCustomHook(render + suffix, new Map()), render + " --include-empty" + suffix);
  }
  for (const suffix of [" | node sink.mjs", " | node sink.mjs | tee preview.md", " | tee preview.md | node sink.mjs", " | tee >(sh)"]) {
    const script = render + suffix;
    assert.throws(() => includeEmptyCustomHook(script, new Map()), /Pipeline to an opaque executable/);
    assert.throws(() => includeEmptyCustomHook("npm run render", new Map([["render", script]])), /Pipeline to an opaque executable/);
  }
});

test("background notes pipelines are refused through direct and forwarded hooks", () => {
  for (const producer of ["pm-changelog " + standing + " --stdout", "node notes.mjs"]) {
    for (const pipeline of [producer + " | cat &", producer + " | tee notes.md | head -n 1 &"]) {
      for (const tail of ["", " true"]) {
        for (const script of [pipeline + tail, "npm run writer"]) {
          assert.throws(() => includeEmptyCustomHook(script, new Map([["writer", pipeline + tail]]), producer.startsWith("pm-changelog")),
            /background/, script);
        }
      }
    }
    const foreground = producer + " | cat";
    const hasGenerator = producer.startsWith("pm-changelog");
    const expected = hasGenerator ? foreground : producer + " --include-empty | cat";
    assert.equal(includeEmptyCustomHook(foreground, new Map(), hasGenerator), expected);
    const quoted = producer + ' --title "&"';
    assert.equal(includeEmptyCustomHook(quoted + " | cat", new Map(), hasGenerator),
      quoted + (hasGenerator ? "" : " --include-empty") + " | cat");
  }
});

test("an unversioned lifecycle generator can select CHANGELOG.md through brace expansion", () => {
  const hooks = ["changelog:full"];
  const inspect = (output: string, flags = "", lifecycle = npmLifecycle(undefined)) =>
    resolveChangelogHooks({ "changelog:full": "pm-changelog " + standing,
      "postchangelog:full": "pm-changelog " + output + flags }, hooks, lifecycle);
  for (const option of ["--output ", "--output=", "-o "]) {
    assert.throws(() => inspect(option + "CHANGELOG.m{d..d}"), /ignore-scripts.*postchangelog:full/);
    assert.doesNotThrow(() => inspect(option + "'CHANGELOG.m{d..d}'"));
    assert.doesNotThrow(() => inspect(option + "preview.md"));
    assert.doesNotThrow(() => inspect(option + "CHANGELOG.m{d..d}", " --stdout"));
    assert.doesNotThrow(() => inspect(option + "CHANGELOG.m{d..d}", "", npmLifecycle("ignore-scripts=false")));
    assert.equal(inspect(option + "CHANGELOG.m{d..d}", "", npmLifecycle("ignore-scripts=true")).size, 1);
  }
  assert.doesNotThrow(() => inspect("--output=CHANGELOG.m{d..d} --output preview.md"));
});

test("unquoted generator operands cannot hide a runtime version option", () => {
  const writer = "pm-changelog " + standing;
  for (const option of ["--title ", "--section-by ", "--pm-arg ", "--output "]) {
    const candidate = "pm-changelog " + option;
    const check = (value: string) => auditInvocations([workflow(writer, candidate + value)]).failures;
    assert.match(check("$TITLE")[0] ?? "", /Unquoted or multiword expansion.*--/);
    assert.deepEqual(check('"$TITLE"'), []);
    const scripts = new Map([["hook", candidate + "$TITLE"]]);
    assert.throws(() => rewriteReleaseHookDates(scripts, ["hook"], day), /Unquoted or multiword expansion/);
    assert.throws(() => assertReleaseHookHeadingDate(scripts, ["hook"], day, "2026.11.17"), /Unquoted or multiword expansion/);
  }
  assert.deepEqual(auditInvocations([workflow(writer, "pm-changelog --stdout --section-by=$SECTION")]).failures, []);
  assert.match(auditInvocations([workflow(writer + " --title=$TITLE")]).failures[0] ?? "", /Unresolved option word/);
  assert.deepEqual(auditInvocations([workflow(writer + ' --title="$TITLE"')]).failures, []);
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

test("an exec argv zero operand cannot disable npm lifecycle writers", () => {
  const hooks = ["changelog:full"];
  const writer = "pm-changelog " + standing;
  const prewriter = writer + " --title pre";
  for (const [command, enabled] of [
    ["env npm_config_ignore_scripts=true npm run writer", false],
    ["exec -a npm_config_ignore_scripts=true npm run writer", true],
  ] as const) {
    const scripts = { "changelog:full": command, writer, prewriter };
    const graph = resolveChangelogHooks(scripts, hooks, true);
    assert.equal(graph.has("prewriter"), enabled, command);
    assert.equal(rewriteReleaseHookDates(graph, hooks, day, true).get("prewriter"),
      enabled ? prewriter.replace("--date-from-version", "--date-fallback " + day) : undefined, command);
    const stale = new Map(Object.entries({ ...scripts, prewriter: prewriter.replace("--date-from-version", "--date-fallback 2026-11-16") }));
    const verify = () => assertReleaseHookHeadingDate(stale, hooks, day, "2026.11.17", true);
    if (enabled) assert.throws(verify, /2026-11-16.*2026-11-17/);
    else assert.doesNotThrow(verify);
    const { failures } = auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts }) }]);
    assert.equal(failures.length, Number(enabled), command);
    if (enabled) assert.match(failures[0], /Cannot determine npm ignore-scripts.*prewriter/);
  }
});

test("npm lifecycle follows workflow env, project config and explicit options", () => {
  const writer = "pm-changelog " + standing;
  const scripts = { hook: "npm run target", target: writer, prehook: writer, posttarget: writer };
  const manifest = new Map(Object.entries(scripts));
  for (const [config, env, enabled] of [
    ["ignore-scripts=true", {}, false],
    ["fund=false\n# project preference\nignore-scripts=false", {}, true],
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
    npmLifecycle(undefined), npmLifecycle("fund=false\n# no lifecycle policy"), npmLifecycle("ignore-scripts = ${EXTERNAL}"),
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

test("default hook lifecycle follows each workflow invocation that actually reaches it", () => {
  const entry = "changelog:full";
  const manifest = { file: "package.json", text: JSON.stringify({ scripts: {
    [entry]: "pm-changelog " + standing, ["pre" + entry]: "printf heading >CHANGELOG.md", relay: "npm run " + entry,
  } }) };
  const source = (run: string, setting: string) => ({ file: ".github/workflows/release.yml", text: stringify({
    env: { npm_config_ignore_scripts: setting }, jobs: { release: { steps: [{ run }] } },
  }) });
  for (const setting of ["false", "true"]) {
    assert.deepEqual(auditInvocations([manifest, source("npm run relay", setting)]).failures, []);
  }
  for (const step of [source("npm run relay", "${{ vars.CONFIG }}"), source("echo unrelated", "false")]) {
    assert.match(auditInvocations([manifest, step]).failures.join("\n"), /ignore-scripts.*prechangelog:full/);
  }
  const conflicting = source("npm run relay", "${{ vars.CONFIG }}");
  assert.match(auditInvocations([manifest, source("npm run relay", "false"), conflicting]).failures.join("\n"), /ignore-scripts.*prechangelog:full/);
});

test("consecutive redirections retain their separate destinations", () => {
  const hooks = (redirect: string) => ({ hook: "echo main", prehook: "printf heading " + redirect });
  for (const redirect of [">preview.md>CHANGELOG.md", ">preview.md<in>>CHANGELOG.md", '>"pre>view">CHANGELOG.md', "> preview.md>CHANGELOG.md"]) {
    assert.throws(() => resolveChangelogHooks(hooks(redirect), ["hook"]), /ignore-scripts.*prehook/, redirect);
    assert.doesNotThrow(() => resolveChangelogHooks(hooks(redirect), ["hook"], true));
  }
  for (const redirect of [">preview.md", "2>>preview.md", '>"pre>view.md"', ">a>b"]) {
    assert.doesNotThrow(() => resolveChangelogHooks(hooks(redirect), ["hook"]));
  }
});

test("combined output redirections stay on their shared scanner command", () => {
  for (const op of ["&>", "&>>"]) {
    for (const gap of ["", " "]) {
      const [command, ...rest] = tokenizeCommands("printf hi " + op + gap + "out");
      assert.deepEqual(rest, []);
      assert.deepEqual(shellRedirection(command[2]), { operator: op, joined: !gap });
      assert.deepEqual(releaseHookCommand(command)?.map(word => word.value), ["printf", "hi"]);
    }
  }
  assert.deepEqual(tokenizeCommands("printf hi & echo done").map(words => words[0].value), ["printf", "echo"]);
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
  const piped = "while cd docs | cat; do break; done; " + writer;
  assert.doesNotThrow(() => resolveChangelogHooks({ hook: piped }, ["hook"]));
  assert.doesNotThrow(() => rewriteReleaseHeadingDate(piped, day));
  assert.deepEqual(auditInvocations([workflow(piped)]).failures, []);
});

test("redirections and assignments cannot hide a directory change before a forwarded writer", () => {
  const writer = "pm-changelog --release-version-from-package --date-fallback " + day;
  const reason = /release hook context change cd/i;
  for (const prefix of ["2>&1 cd docs", "2> log FIXTURE=1 command cd docs", "FIXTURE=1 2>&1 builtin cd docs"]) {
    const hook = prefix + "; npm run writer";
    const scripts = { hook, writer };
    assert.throws(() => resolveChangelogHooks(scripts, ["hook"]), reason);
    assert.throws(() => assertReleaseHookHeadingDate(new Map(Object.entries(scripts)), ["hook"], day), reason);
  }
  const hook = "2>&1; npm run writer";
  assert.ok(resolveChangelogHooks({ hook, writer }, ["hook"]).has("writer"));
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
  for (const candidate of [scripts, { "changelog:full": "GEN=dist/cli.js npm run writer", writer: 'node "$GEN" ' + standing }]) {
    const entries = new Map(Object.entries(candidate));
    assert.throws(() => resolveChangelogHooks(candidate, ["changelog:full"]), reason);
    assert.throws(() => rewriteReleaseHookDates(entries, ["changelog:full"], day), reason);
    assert.throws(() => assertReleaseHookHeadingDate(entries, ["changelog:full"], day), reason);
    assert.match(auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts: candidate }) }]).failures[0], reason);
  }
  assert.throws(() => resolveChangelogHooks({ ...scripts, "changelog:full": "env 'GEN=pm-changelog' npm run writer" },
    ["changelog:full"]), reason);
  assert.throws(() => resolveChangelogHooks({ ...scripts, "changelog:full": "GEN=./node_modules/pm-changelog/dist/cli.js npm run writer" },
    ["changelog:full"]), reason);
  for (const hook of ["TZ=UTC npm run writer", "GEN= npm run writer", "exec -a GEN=pm-changelog npm run writer"]) {
    assert.doesNotThrow(() => resolveChangelogHooks({ hook, writer: "pm-changelog " + standing }, ["hook"]));
  }
  const unrelated = { "changelog:full": "pm-changelog " + standing, smoke: "BIN=dist/cli.js npm run test:cli", "test:cli": "node scripts/smoke.mjs" };
  assert.doesNotThrow(() => resolveChangelogHooks(unrelated, ["smoke"]));
  assert.deepEqual(auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts: unrelated }) }]).failures, []);
});

test("inherited npm bindings distinguish ordinary data from executable and policy positions", () => {
  const hook = "TITLE=Release npm run writer";
  const entry = "changelog:full";
  const inspect = (writer: string) => {
    const scripts = { [entry]: hook, writer };
    const resolved = resolveChangelogHooks(scripts, [entry]);
    const prepared = rewriteReleaseHookDates(resolved, [entry], day);
    assertReleaseHookHeadingDate(prepared, [entry], day, "2026.11.17");
    assert.deepEqual(auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts }) }]).failures, []);
  };
  for (const value of ['--title "$TITLE"', '--title="$TITLE"', '--pm-arg "${TITLE}"', '--output "$TITLE"']) {
    inspect("pm-changelog " + standing + " " + value);
  }
  for (const writer of [
    '"$TITLE" --until 2026-11-17', 'bun --silent run --smol "$TITLE" ' + standing,
    'pm-changelog --release-version-from-package --date-fallback "$TITLE"',
    'node dist/cli.js --date-fallback="$TITLE" --release-version-from-package',
    'pm-changelog ' + standing + ' --until "$TITLE"', 'pm-changelog ' + standing + ' --until="$TITLE"',
    'pm-changelog --release-version-from-package "$TITLE"',
  ]) assert.throws(() => inspect(writer), /binding through variable assignment TITLE/i, writer);
  inspect('node helper.mjs --date-fallback "$TITLE"; pm-changelog ' + standing);
});

test("npm forwards inherited title data separately from inherited policy selection", () => {
  const hook = "env TITLE=Release npm run relay";
  const writer = "pm-changelog " + standing;
  const inspect = (tail: string) => resolveChangelogHooks({ hook, relay: "npm run writer -- " + tail, writer }, ["hook"]);
  for (const title of ['--title "$TITLE"', '"--title=${TITLE}"', '--pm-arg "$TITLE"']) {
    assert.equal(inspect(title).get("writer"), writer);
  }
  for (const option of ['"$TITLE"', '--release-version-from-package="$TITLE"', '--date-from-version="$TITLE"', '--date-fallback "$TITLE"', '--until "$TITLE"']) {
    assert.throws(() => inspect(option), /binding through variable assignment TITLE/i, option);
  }
});

test("the forwarded generator check uses the child's argv and actual variable expansions", () => {
  const hook = "GEN=entrypoint npm run delegate";
  const reason = /generator binding through variable assignment GEN.*npm run forward/i;
  for (const flag of ["--release-version-from-package", "--date-from-version", "--date-fallback=2026-11-17"]) {
    const scripts = { hook, delegate: "npm run writer -- " + flag, writer: 'node "${GEN}"' };
    assert.throws(() => resolveChangelogHooks(scripts, ["hook"]), reason);
  }
  for (const entry of ['"$G\\\nEN"', '"${!GEN}"']) {
    assert.throws(() => resolveChangelogHooks({ hook, delegate: "node " + entry + " " + standing }, ["hook"]), reason);
  }
  for (const writer of [
    "LOCAL=only",
    'echo "$GEN" ' + standing,
    'node "$GEN_SUFFIX" ' + standing,
    'node "\\$GEN$OTHER" ' + standing,
    "node '$GEN' " + standing,
    'node "$GEN" --pm-arg --date-from-version',
    'node "$GEN"; node other.mjs ' + standing,
  ]) {
    assert.doesNotThrow(() => resolveChangelogHooks({ hook, delegate: "npm run writer", writer }, ["hook"]));
  }

  const scripts = { hook, delegate: "node smoke.mjs", predelegate: 'node "$GEN" ' + standing };
  assert.doesNotThrow(() => resolveChangelogHooks(scripts, ["hook"], false));
  assert.throws(() => resolveChangelogHooks(scripts, ["hook"], true), reason);

  const shared = { hook: "OTHER=entrypoint npm run writer; " + hook, delegate: "npm run writer", writer: '"$GEN" ' + standing };
  assert.match(auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts: shared }) }]).failures[0], reason);
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
  assert.throws(() => check("--version"), /--version requires a value/);
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
  assert.doesNotThrow(() => check(`${command} --pm-arg=--until=2026-11-16`));
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

test("backquoted commands expose source spans only for a verbatim child body", () => {
  const prefix = "value=`";
  const operand = "\\".repeat(4);
  const body = "printf " + operand;
  const changed = tokenizeCommandsWithSpans(prefix + body + "`");
  const child = changed.commands.find(words => words[0]?.value === "printf")!;
  assert.equal(child[1].value, "\\");
  assert.equal(changed.spans.get(child[1]), undefined);
  assert.equal(changed.spans.get(child[0]), undefined);
  const literal = "printf '%s' heading";
  const original = prefix + literal + "`";
  const intact = tokenizeCommandsWithSpans(original);
  const program = intact.commands.find(words => words[0]?.value === "printf")!;
  const { start, end } = intact.spans.get(program[1])!;
  assert.equal(original.slice(start, end), "'%s'");
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

test("literal cat file redirects preserve here-document data without allowing execution", () => {
  const body = "pm-changelog --version v2026.11.16";
  const next = "pm-changelog " + standing;
  for (const opener of ["cat <<'END' >preview.txt", 'cat > "preview file" <<- \'END\'', "cat <<'END' 2>>preview.err &>preview.txt"]) {
    const script = opener + "\n$(" + body + ")\nEND\n" + next;
    assert.deepEqual(auditInvocations([workflow(script)]).failures, [], opener);
    assert.equal(includeEmptyReleaseSections(script), script + " --include-empty", opener);
  }
  for (const [opener, data] of [
    ["cat <<END >preview.txt", "$(" + body + ")"],
    ["sh <<'END' >preview.txt", body],
    ["cat <<'END' >preview.txt | sh", body],
    ["cat <<'END' >$TARGET", body],
    ["cat <<'END' >preview{1,2}.txt", body],
    ["cat <<'END' preview.txt", body],
    ["cat <<'END' >", body],
    ["cat <<'END' > >preview.txt", body],
  ]) {
    assert.throws(() => includeEmptyReleaseSections(opener + "\n" + data + "\nEND\n" + next), /Here-document/);
  }
});

test("release hooks refuse to execute a file written by an earlier redirect", () => {
  const body = "pm-changelog " + standing;
  const heredoc = `cat <<'END' >generate.sh\n${body}\nEND\n`;
  const refuse = /generated release hook file .*commit the script to the repository/i;
  for (const [write, execute] of [
    [heredoc, "sh generate.sh"],
    [heredoc, "/fixture/bin/sh generate.sh"],
    [heredoc, "bash -e ./generate.sh"],
    [heredoc, "bash -o errexit ./generate.sh"],
    [heredoc, "sh <generate.sh"],
    [heredoc, "bash -s ignored 0<generate.sh"],
    [heredoc, "./generate.sh"],
    [heredoc, "source generate.sh"],
    [heredoc, "source -- generate.sh"],
    [heredoc, ". ./generate.sh"],
    ["printf script >> 'generate script.js' && ", "node -- './generate script.js'"],
    ["printf script &>scripts/generate.js; ", "env node --enable-source-maps ./scripts/generate.js"],
    ["printf script>generate.sh; ", "sh generate.sh"],
    ["printf script >preview.txt>>generated.sh; ", "bash generated.sh"],
    ["printf script >&generate.sh; ", "sh generate.sh"],
    ["printf script 3<>generate.sh; ", "sh generate.sh"],
    ["printf script >generate.js; ", "node --import ./setup.js generate.js"],
    ["printf script >generate.js; ", "node - <generate.js"],
    ["printf script >node; ", "./node ignored.js"],
    ["printf script >/fixture/bin/node; ", "/fixture/bin/node ignored.js"],
    ['printf script >"$TARGET"; ', 'sh "${TARGET}"'],
  ]) {
    const hook = write + execute;
    const scripts = new Map([["changelog:full", hook]]);
    assert.throws(() => rewriteReleaseHookDates(scripts, ["changelog:full"], day), refuse, hook);
    assert.throws(() => assertReleaseHookHeadingDate(scripts, ["changelog:full"], day), refuse, hook);
    assert.throws(() => rewriteReleaseHeadingDate(hook, day), refuse, hook);
    const manifest = { file: "package.json", text: JSON.stringify({ scripts: Object.fromEntries(scripts) }) };
    assert.match(auditInvocations([manifest]).failures[0] ?? "", refuse, hook);
    assert.match(auditInvocations([workflow(hook + "\npm-changelog " + standing)]).failures[0] ?? "", refuse, hook);
  }
});

test("forwarded release hooks share possible writes across the call and lifecycle sequence", () => {
  const writer = "sh generate.sh; pm-changelog " + standing;
  const write = "printf 'fixture script' >./generate.sh";
  const cases: [string, Record<string, string>][] = [
    [write + "; npm run writer", { writer }],
    ["npm run relay; npm run writer", { relay: write, writer }],
    ["npm run writer; " + write + "; npm run writer", { writer }],
    ["npm run writer", { prewriter: write, writer }],
    ["npm run relay; " + writer, { relay: write }],
    [write + "; npm run relay", { relay: "npm run writer", writer }],
  ];
  for (const [hook, scripts] of cases) {
    const manifest = new Map(Object.entries({ "changelog:full": hook, ...scripts }));
    const entry = ["changelog:full"];
    const refuse = /generated release hook file "generate\.sh"/;
    assert.throws(() => resolveChangelogHooks(Object.fromEntries(manifest), entry, true), refuse, hook);
    assert.throws(() => rewriteReleaseHookDates(manifest, entry, day, true), refuse, hook);
    assert.throws(() => assertReleaseHookHeadingDate(manifest, entry, day, "2026.11.17", true), refuse, hook);
  }
  const shared = { check: "npm run relay", "changelog:full": "npm run relay; " + writer, relay: write };
  assert.throws(() => resolveChangelogHooks(shared, ["check", "changelog:full"], true), /generated release hook file/);
  assert.doesNotThrow(() => resolveChangelogHooks({ ...shared, relay: "printf data >preview.txt" }, ["check", "changelog:full"], true));
  for (const hook of ["npm run writer", "printf 'fixture data' >preview.txt; npm run writer"]) {
    const scripts = new Map([["changelog:full", hook], ["writer", writer]]);
    assert.equal(resolveChangelogHooks(Object.fromEntries(scripts), ["changelog:full"], true).get("writer"), writer);
    assert.doesNotThrow(() => assertReleaseHookHeadingDate(scripts, ["changelog:full"], day, "2026.11.17", true));
  }
});

test("forwarded file writes stay separate across alternatives and survive the join", () => {
  const entry = ["changelog:full"];
  const writer = "pm-changelog " + standing;
  const commands = { preview: "printf data >generate.sh", helper: "sh generate.sh" };
  const inspect = (hook: string) => {
    const scripts = { "changelog:full": hook + "; " + writer, ...commands };
    const resolved = resolveChangelogHooks(scripts, entry, true);
    const prepared = rewriteReleaseHookDates(resolved, entry, day, true);
    assertReleaseHookHeadingDate(prepared, entry, day, "2026.11.17", true);
  };
  for (const hook of [
    "if test -f preview; then npm run preview; else npm run helper; fi",
    "if test -f preview; then npm run preview; elif test -f other; then npm run helper; fi",
    "if test -f preview; then npm run preview; else if true; then npm run helper; fi; fi",
    "{ true; }; if test -f preview; then { npm run preview; }; else npm run helper; fi",
  ]) assert.doesNotThrow(() => inspect(hook), hook);
  for (const hook of [
    "if test -f preview; then npm run preview; else npm run helper; fi; npm run helper",
    "if test -f preview; then npm run preview; npm run helper; fi",
    "if npm run preview; then true; elif test -f other; then npm run helper; fi",
    "if false; then true; elif npm run preview; then true; else npm run helper; fi",
    "while test -f preview; do if test -f other; then npm run preview; else npm run helper; fi; done",
  ]) assert.throws(() => inspect(hook), /generated release hook file "generate\.sh"/, hook);
});

test("only release hook paths may refuse a script that executes redirected output", () => {
  const smoke = "printf 'console.log(1)' >smoke.js; node smoke.js";
  const writer = "pm-changelog " + standing;
  const audit = (generate: string) => auditInvocations([
    { file: "package.json", text: JSON.stringify({ scripts: { "changelog:full": generate, "changelog:check": writer, smoke } }) },
    workflow("npm run smoke", smoke),
  ]).failures;
  assert.deepEqual(audit(writer), []);
  assert.match(audit("npm run smoke")[0] ?? "", /generated release hook file "smoke\.js"/);
});

test("redirected release data and committed script invocations remain usable", () => {
  const writer = "pm-changelog " + standing;
  const heredoc = `cat <<'END' >preview.txt\n${writer}\nEND\n`;
  for (const prefix of [
    heredoc + "cat ./preview.txt; ",
    heredoc + "sh scripts/committed.sh ./preview.txt; ",
    heredoc + "bash -c 'echo example' ./preview.txt; ",
    heredoc + "bash -n ./preview.txt; ",
    heredoc + "sh 0<preview.txt <scripts/committed.sh; ",
    heredoc + "sh <&0; ",
    heredoc + "sh; ",
    heredoc + "node --eval 'console.log(1)' ./preview.txt; ",
    heredoc + "node --check ./preview.txt; ",
    heredoc + "node - <scripts/committed.js; ",
    heredoc + "./scripts/committed.sh ./preview.txt; ",
    heredoc + "./node preview.txt; ",
    "sh generate.sh; printf data >generate.sh; ",
    "printf data >preview.txt; sh scripts/committed.sh; ",
    "cat <generate.sh; sh generate.sh; ",
    "printf data >&2; sh 2; ",
    "printf data >preview.txt; >other.txt; sh scripts/committed.sh; ",
  ]) {
    const hook = prefix + writer;
    const scripts = new Map([["changelog:full", hook]]);
    const prepared = prefix + "pm-changelog --release-version-from-package --date-fallback " + day;
    assert.equal(rewriteReleaseHookDates(scripts, ["changelog:full"], day).get("changelog:full"), prepared, hook);
    assert.doesNotThrow(() => assertReleaseHookHeadingDate(new Map([["changelog:full", prepared]]), ["changelog:full"], day), hook);
    assert.equal(rewriteReleaseHeadingDate(hook, day), prepared, hook);
    assert.deepEqual(auditInvocations([workflow(hook)]).failures, [], hook);
  }
});

test("continued list operators preserve synchronous release commands", () => {
  const generator = "pm-changelog " + standing;
  const continuation = "\\\n";
  for (const operator of ["&" + continuation + "&", "|" + continuation.repeat(2) + "|"]) {
    const script = generator + " " + operator + " echo done";
    assert.deepEqual(auditInvocations([workflow(script)]).failures, []);
    assert.equal(includeEmptyReleaseSections(script), generator + " --include-empty " + operator + " echo done");
  }
  assert.equal(includeEmptyReleaseSections(generator + ";"), generator + " --include-empty;");
  assert.throws(() => includeEmptyReleaseSections(generator + " &" + continuation + " echo done"), /background/);
  assert.throws(() => includeEmptyReleaseSections(generator + " |" + continuation + " node sink.mjs"), /opaque executable/);
});

test("punctuation in a literal cat here-document delimiter preserves data and the next command", () => {
  const body = "$(pm-changelog --version v2026.11.16)";
  const next = "pm-changelog " + standing;
  for (const [redirect, indent] of [
    ["<<'END-LOG'", ""], ['<<"END-LOG"', ""], ["<<END\\-LOG", ""], ["<<- 'END-LOG'", "\t"],
  ]) {
    const data = "cat " + redirect + "\n" + indent + body + "\n" + indent + "END-LOG\n";
    assert.deepEqual(auditInvocations([workflow(data + next)]).failures, [], redirect);
    assert.equal(includeEmptyReleaseSections(data + next), data + next + " --include-empty", redirect);
  }
});

test("punctuation in a here-document delimiter does not hide executable generator text", () => {
  const body = "pm-changelog --version v2026.11.16";
  for (const [opener, data] of [
    ["sh <<'END-LOG'", body],
    ["cat <<'END-LOG' | sh", body],
    ["cat <<'END-LOG' | sh;", body],
    ["cat <<END-LOG", "$(" + body + ")"],
  ]) {
    const script = opener + "\n" + data + "\nEND-LOG";
    assert.throws(() => includeEmptyReleaseSections(script), /Here-document.*Use a direct/, opener);
  }
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

test("GITHUB_ENV lifecycle writes apply to later steps within their job", () => {
  const entry = "changelog:full";
  const manifest = { file: "package.json", text: JSON.stringify({ scripts: {
    [entry]: "pm-changelog " + standing, ["pre" + entry]: "printf heading > CHANGELOG.md",
  } }) };
  const consume = { run: "npm run " + entry };
  const write = { run: 'echo "npm_config_ignore_scripts=true" >> "$GITHUB_ENV"' };
  const audit = (steps: object[], jobs = {}) => auditInvocations([manifest, {
    file: ".github/workflows/release.yml", text: stringify({ jobs: { release: { "runs-on": "ubuntu-latest", steps }, ...jobs } }, { aliasDuplicateObjects: false }),
  }]).failures;
  const observed = (steps: object[], job: object = {}, defaults = {}) => executableShellBodies({ file: ".github/workflows/release.yml",
    text: stringify({ defaults, env: { npm_config_ignore_scripts: "false" }, jobs: { release: { "runs-on": "ubuntu-latest", ...job, steps } } }, { aliasDuplicateObjects: false }),
  }).map(body => npmLifecycle(undefined, body.environment));
  const read = { run: "true" };
  const reset = { run: "printf 'npm_config_ignore_scripts=%s\\n' false >> $GITHUB_ENV" };
  assert.deepEqual(observed([write, read, reset, consume]), [true, false, false, true]);
  assert.deepEqual(observed([write, { ...read, env: { npm_config_ignore_scripts: "false" } }, consume]), [true, true, false]);
  assert.deepEqual(observed([write, { run: 'cat settings >> "$GITHUB_ENV"' }, consume]), [true, false, "unknown"]);
  assert.deepEqual(observed([write, { run: 'echo npm_config_ignore_scripts=false | tee -a "$GITHUB_ENV"' }, consume]), [true, false, "unknown"]);
  assert.deepEqual(observed([write, { run: 'cat "$GITHUB_ENV"' }, consume]), [true, false, false]);
  assert.deepEqual(observed([write, { run: 'echo "EXAMPLE=1" >> "$GITHUB_ENV"' }, consume]), [true, false, false]);
  assert.deepEqual(observed([write, { run: "printf 'OTHER=yes\\nnpm_config_ignore_scripts=false\\n' >> $GITHUB_ENV" }, consume]), [true, false, "unknown"]);
  assert.deepEqual(observed([{ run: "# lifecycle\n\nset -euo pipefail\necho ready\n" + write.run + " # next step" }, consume]), [true, false]);
  assert.deepEqual(observed([{ run: "printf 'npm_config_ignore_scripts=true\\n' >> $GITHUB_ENV" }, consume]), [true, false]);
  assert.deepEqual(observed([write, { ...reset, if: false }, consume]), [true, false, false]);
  assert.deepEqual(observed([{ ...write, shell: "python" }, consume]), [true, "unknown"]);
  assert.deepEqual(observed([write, consume], { "runs-on": "windows-latest" }), [true, "unknown"]);
  assert.deepEqual(observed([write, consume], { "runs-on": ["self-hosted", "Linux"] }), [true, false]);
  assert.deepEqual(observed([write, consume], { "runs-on": "windows-latest", defaults: { run: { shell: "bash" } } }), [true, false]);
  assert.deepEqual(observed([write, consume], {}, { run: { shell: "pwsh" } }), [true, "unknown"]);
  assert.deepEqual(observed([{ run: 'echo "npm_config_ignore_scripts=true" > "$GITHUB_ENV"' }, consume]), [true, false]);
  assert.deepEqual(observed([{ run: write.run + '\necho OTHER=yes > "$GITHUB_ENV"' }, consume]), [true, true]);
  assert.deepEqual(audit([write, consume]), []);
  assert.deepEqual(audit([{ run: 'printf \'%s\\n\' npm_config_ignore_scripts=true >> "${GITHUB_ENV}"' }, consume]), []);
  assert.deepEqual(audit([write, { run: 'echo npm_config_ignore_scripts=false >> $GITHUB_ENV' }, consume]), []);
  assert.deepEqual(audit([write, { ...consume, env: { npm_config_ignore_scripts: "false" } }]), []);
  assert.match(audit([write, consume], { separate: { steps: [consume] } })[0], /Cannot determine npm ignore-scripts/);
  assert.match(audit([{ run: write.run + "\n" + consume.run }])[0], /Cannot determine npm ignore-scripts/);
  const computed = { run: 'echo "npm_config_ignore_scripts=$SETTING" >> "$GITHUB_ENV"' };
  for (const env of [{}, { SETTING: "true\nOTHER=yes" }, { SETTING: "${{ inputs.policy }}" }]) {
    assert.match(audit([{ ...computed, env }, consume])[0], /Cannot determine npm ignore-scripts/);
    assert.deepEqual(audit([{ ...computed, env }, { ...consume, env: { npm_config_ignore_scripts: "true" } }]), []);
    assert.deepEqual(audit([{ ...computed, env }, { run: "npm --ignore-scripts run " + entry }]), []);
  }
  for (const uncertain of [
    { run: 'echo "npm_config_ignore_scripts=$SETTING" >> "$GITHUB_ENV"', env: { SETTING: "unresolved" } },
    { ...write, if: "${{ inputs.skip }}" },
    { run: "if test -f optional; then\n" + write.run + "\nfi" },
    { run: "cat <<'TEXT'\n" + write.run + "\nTEXT" },
  ]) {
    assert.match(audit([uncertain, consume])[0], /Cannot determine npm ignore-scripts.*consuming step.*npm --/);
    assert.deepEqual(audit([uncertain, { ...consume, env: { npm_config_ignore_scripts: "true" } }]), []);
    assert.deepEqual(audit([uncertain, { run: "npm --ignore-scripts run " + entry }]), []);
  }
});

test("Bun shorthand cannot bypass a local generator's heading policy", () => {
  const hooks = ["hook"];
  const scripts = { hook: "bun changes", changes: "pm-changelog " + standing };
  assert.throws(() => resolveChangelogHooks(scripts, hooks), /bun run changes/);
  assert.throws(() => resolveChangelogHooks({ ...scripts, hook: "bun relay", relay: "bun --silent changes" }, hooks), /bun run relay/);
  assert.throws(() => resolveChangelogHooks({ ...scripts, hook: "wrapper bun changes" }, hooks), /Unrecognized wrapper/);
  assert.doesNotThrow(() => resolveChangelogHooks({ ...scripts, hook: "bun helper", helper: "echo ready" }, hooks));
  for (const builtin of ["build", "test", "install"]) {
    assert.doesNotThrow(() => resolveChangelogHooks({ hook: "bun " + builtin, [builtin]: scripts.changes }, hooks));
  }
  assert.throws(() => resolveChangelogHooks({ hook: "bun explain", explain: scripts.changes }, hooks), /bun run explain/);
  const explicit = resolveChangelogHooks({ ...scripts, hook: "bun run changes" }, hooks);
  const prepared = rewriteReleaseHookDates(explicit, hooks, day);
  assert.match(prepared.get("changes")!, /--date-fallback 2026-11-17/);
  assertReleaseHookHeadingDate(prepared, hooks, day);
});

test("release hooks retain the pending heading while published-history commands may omit it", () => {
  const version = "2026.11.17";
  const roots = ["changelog:full", "changelog:check"];
  const generator = "pm-changelog --all-release-tags " + standing;
  const configured = (options: string) => new Map(roots.map(name => [name, generator + options]));
  for (const action of [
    (scripts: Map<string, string>) => rewriteReleaseHookDates(scripts, roots, day, true, version),
    (scripts: Map<string, string>) => assertReleaseHookHeadingDate(scripts, roots, day, version),
  ]) {
    assert.throws(() => action(configured(" --no-pending-release")), /--no-pending-release/);
    const pinned = new Map(roots.map(name => [name, generator.replace("--date-from-version", "--date-fallback " + day) + " --no-pending-release"]));
    assert.throws(() => action(pinned), /--no-pending-release/);
    action(configured(" --pm-arg --no-pending-release"));
    action(new Map(roots.map(name => [name, "pm-changelog --all-release-tags --no-pending-release"])));
  }
  const scripts = { ...Object.fromEntries(configured("")), history: generator + " --no-pending-release" };
  assert.deepEqual(auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts }) }]).failures, []);
});

test("shell here-document input is refused even when its text only names a helper", () => {
  const data = "\nnpm --silent run changes\nEND\n";
  const audit = (opener: string) => auditInvocations([workflow(opener + data + "pm-changelog " + standing)]).failures;
  for (const opener of ["sh <<'END'", "sh<<END", "if sh <<END; then", "env bash <<END", "cat <<END | sh", "cat <<END | cat | /bin/sh;"]) {
    assert.match(audit(opener)[0] ?? "", /Here-document/, opener);
  }
  assert.match(audit("sh <<FIRST; cat <<END\nhelper\nFIRST")[0] ?? "", /Here-document/);
  for (const opener of ["cat <<'END'", "cat <<END | head", "echo sh; cat <<END", "<<'END'"]) assert.deepEqual(audit(opener), [], opener);
});

test("release fixtures can invoke npm without a platform launcher on PATH", t => {
  const root = mkdtempSync(join(tmpdir(), "release-npm-launcher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { ready: "echo ready" } }));
  const options = { cwd: root, encoding: "utf8" as const, env: { ...process.env, PATH: "", npm_config_script_shell: process.env.ComSpec || "/bin/sh", npm_config_cache: join(root, "cache") } };
  const cli = npmCli();
  assert.match(execFileSync(process.execPath, [cli, "run", "ready"], options), /ready/);
  assert.throws(() => execFileSync(process.execPath, [cli, "run", "absent"], options), /Missing script/);
});

test("conditional hook bodies resolve the writer and keep closing keywords intact", () => {
  const writer = "pm-changelog " + standing;
  const hook = "if true; then npm run writer; fi";
  const scripts = resolveChangelogHooks({ hook, writer }, ["hook"]);
  assert.equal(scripts.get("writer"), writer);
  assert.doesNotThrow(() => assertReleaseHookHeadingDate(rewriteReleaseHookDates(scripts, ["hook"], day), ["hook"], day));
  assert.throws(() => resolveChangelogHooks({ hook: hook.replace("then ", "then wrapper "), writer }, ["hook"]), /wrapper/);
  for (const kw of ['"then"', "\\then"]) {
    assert.throws(() => resolveChangelogHooks({ hook: kw + " npm run writer", writer }, ["hook"]), /wrapper/);
  }
});

test("conditional notes keep their generator and custom argument recipients", () => {
  const notes = "if true\nthen\npm-changelog --stdout\nfi";
  const prepared = includeEmptyReleaseSections(notes);
  assert.equal(includeEmptyCustomHook("fi", new Map(), true), "fi");
  assert.equal(includeEmptyCustomHook("npm run nested", new Map([["nested", prepared]]), true), "npm run nested");
  assert.throws(() => includeEmptyCustomHook("npm run nested", new Map([["nested", notes.replace("pm-changelog --stdout", "node notes.js")]])), /cannot receive forwarded arguments/);
  const inline = "if true; then node notes.js; fi";
  assert.equal(includeEmptyCustomHook(inline, new Map()), inline.replace("notes.js", "notes.js --include-empty"));
  assert.equal(includeEmptyCustomHook(prepared, new Map(), true), notes.replace("--stdout", "--stdout --include-empty"));
  assert.equal(includeEmptyCustomHook(notes.replace("pm-changelog --stdout", "node notes.js"), new Map()),
    notes.replace("pm-changelog --stdout", "node notes.js --include-empty"));
});

test("environment-file matching handles padding, comments and other destinations", () => {
  const pad = " ".repeat(128);
  const prefix = "echo npm_config_ignore_scripts=true" + pad;
  const policy = (run: string) => npmLifecycle(undefined, executableShellBodies({ file: ".github/workflows/env.yml", text: stringify({ jobs: { prepare: { "runs-on": "ubuntu-latest", steps: [{ run }, { run: "true" }] } } }) })[1].environment);
  for (const file of ['$GITHUB_ENV', '"${GITHUB_ENV}"']) {
    assert.equal(policy(prefix + ">>" + pad + file + pad + "# comment >"), false);
    assert.equal(policy(prefix + ">>" + pad + file + ".other"), "unknown");
  }
});

test("intervening actions and environment file replacements invalidate the lifecycle policy", () => {
  const known = { run: 'echo npm_config_ignore_scripts=true >> "$GITHUB_ENV"' };
  const observed = (...steps: object[]) => {
    const source = { file: ".github/workflows/env.yml", text: stringify({ jobs: { release: {
      "runs-on": "ubuntu-latest", steps: [known, ...steps, { run: "npm run hook" }],
    } } }) };
    return npmLifecycle("ignore-scripts=true", executableShellBodies(source).at(-1)!.environment);
  };
  for (const step of [{ uses: "./example" }, { uses: "example/action@v1" }, { run: 'cp settings "$GITHUB_ENV"' }, { run: "node helper.js" }]) {
    assert.equal(observed(step), "unknown");
    assert.equal(observed({ ...step, if: false }), false);
  }
  const conditionalReplace = 'echo npm_config_ignore_scripts=false >> "$GITHUB_ENV"\nif test -f optional; then\necho OTHER=yes > "$GITHUB_ENV"\nfi';
  assert.equal(observed({ run: conditionalReplace }), "unknown");
  assert.equal(observed({ run: 'echo "$RECORD" >> "$GITHUB_ENV"' }), "unknown");
  for (const run of ['cat "$GITHUB_ENV"', "echo ready", "true"]) assert.equal(observed({ run }), false);
});

test("POSIX lifecycle environment records preserve distinct keys through empty overrides", () => {
  const lower = "npm_config_ignore_scripts", upper = lower.toUpperCase();
  const observed = (writes: string[], env: object) => {
    const steps = [...writes.map(record => ({ run: "echo " + record + " >> $GITHUB_ENV" })), { run: "npm run hook", env }];
    const source = { file: ".github/workflows/env.yml", text: stringify({ jobs: { release: { "runs-on": "ubuntu-latest", steps } } }) };
    return npmLifecycle("ignore-scripts=true", executableShellBodies(source).at(-1)!.environment);
  };
  assert.equal(observed([lower + "=false"], { [upper]: "" }), true);
  assert.equal(observed([upper + "=false"], { [lower]: "" }), true);
  assert.equal(observed([lower + "=true", upper + "=false"], {}), "unknown");
  assert.equal(observed([upper + "=false"], { [upper]: "true" }), false);
});

test("summary is read-only for the direct CLI and a possible write through the repository adapter", () => {
  for (const invocation of ["pm-changelog", "npx pm-changelog@1", "node dist/cli.js"]) {
    assert.doesNotThrow(() => resolveChangelogHooks({ hook: "true", prehook: invocation + " --summary" }, ["hook"]));
  }
  for (const prehook of ["node scripts/pm-changelog.ts --summary", "pm-changelog --pm-arg --summary", "pm-changelog --summary >CHANGELOG.md"]) {
    assert.throws(() => resolveChangelogHooks({ hook: "true", prehook }, ["hook"]), /ignore-scripts/);
  }
});

test("each explicit release version requires its own operand", () => {
  for (const flag of ["--version", "--release-version"]) {
    for (const missing of [flag, flag + "=", flag + " ''"]) {
      const script = "pm-changelog " + missing + " --release-version 2026.11.17 --date-from-version";
      assert.throws(() => rewriteReleaseHeadingDate(script, day), /requires a value/);
    }
    for (const joiner of [" ", "="]) {
      const script = "pm-changelog " + flag + joiner + "2026.11.16 --release-version 2026.11.17 --date-from-version";
      assert.doesNotThrow(() => assertReleaseHeadingDate([script], day, "2026.11.17"));
    }
  }
});

test("expandable here-documents refuse command substitution and preserve literal text", () => {
  for (const literal of [String.raw`\$(printf fixture)`, "plain text"]) {
    const script = "cat <<END\n" + literal + "\nEND";
    assert.equal(includeEmptyReleaseSections(script), script);
  }
  for (const body of ["$(printf fixture)", "`printf fixture`", "$\\\n(printf fixture)"]) {
    assert.throws(() => includeEmptyReleaseSections("cat <<END\n" + body + "\nEND"), /Here-document/);
    const quoted = "cat <<'END'\n" + body + "\nEND";
    assert.equal(includeEmptyReleaseSections(quoted), quoted);
  }
});

test("joined combined redirects belong to their command in both scanners", () => {
  for (const op of ["&>", "&>>"]) {
    const operator = "&\\\n\\\n" + op.slice(1);
    for (const gap of ["", " "]) {
      const text = "pm-changelog --stdout" + gap + operator + "log & echo done";
      for (const commands of [parseReleaseHook(text).commands, tokenizeCommands(text)]) {
        assert.equal(commands.length, 2);
        assert.deepEqual(releaseHookCommand(commands[0])?.map(word => word.value), ["pm-changelog", "--stdout"]);
        assert.deepEqual(shellRedirection(commands[0].at(-1)!), { operator: op, joined: true });
      }
    }
  }
});

test("workflow env maps and shell templates carry only definite lifecycle settings", () => {
  const policy = (workflowEnv: unknown, jobEnv: unknown, stepEnv: unknown, shell = "bash") => {
    const source = { file: ".github/workflows/env.yml", text: stringify({ env: workflowEnv, jobs: { release: {
      env: jobEnv, steps: [{ shell, run: 'echo npm_config_ignore_scripts=true >> "$GITHUB_ENV"' }, { env: stepEnv, run: "true" }],
    } } }) };
    return npmLifecycle("ignore-scripts=true", executableShellBodies(source)[1].environment);
  };
  const expression = "${{ fromJSON(vars.RELEASE_ENV) }}";
  for (const layers of [[expression, {}, {}], [{}, expression, {}], [{}, {}, expression]] as const) {
    assert.equal(policy(layers[0], layers[1], layers[2]), "unknown");
  }
  assert.equal(policy({}, {}, { npm_config_ignore_scripts: "false" }), true);
  for (const shell of ["bash -n {0}", "bash -c {0}", "sh -nv {0}"]) assert.equal(policy({}, {}, {}, shell), "unknown");
  for (const shell of ["bash", "sh", "bash --noprofile --norc -eo pipefail {0}", "sh -e {0}"]) assert.equal(policy({}, {}, {}, shell), false);
});

test("tee file operands distinguish possible changelog writes from preview output", () => {
  const inspect = (args: string) => resolveChangelogHooks({ hook: "echo ready", posthook: "printf preview | tee " + args }, ["hook"]);
  for (const args of ["CHANGELOG.md", "-a preview.md ./CHANGELOG.md", '-- "$OUTPUT"', "CHANGE{LOG,X}.md"]) {
    assert.throws(() => inspect(args), /ignore-scripts/);
  }
  for (const args of ["-- preview.md", "-a other.md preview.md", "CHANGELOG.md.bak", ""]) assert.doesNotThrow(() => inspect(args));
});

test("custom notes choose one renderer across conditional branches", () => {
  const branches = "if test -f notes.json; then node notes.mjs; else node fallback.mjs; fi";
  for (const body of [branches, branches.replace("else", "elif true; then"), branches.replace("node fallback.mjs", "pm-changelog --stdout --include-empty")]) {
    assert.throws(() => includeEmptyCustomHook(body, new Map(), body.includes("pm-changelog")), /single script entry point/);
    assert.throws(() => includeEmptyCustomHook("npm run render", new Map([["render", body]])), /single script entry point/);
  }
  const generated = branches.replace("node notes.mjs", "pm-changelog --stdout --include-empty")
    .replace("node fallback.mjs", "node scripts/pm-changelog.ts --stdout --include-empty");
  assert.equal(includeEmptyCustomHook(generated, new Map(), true), generated);
  assert.equal(includeEmptyCustomHook("npm run render", new Map([["render", generated]]), true), "npm run render");
  const tail = branches + "; node final.mjs";
  assert.equal(includeEmptyCustomHook(tail, new Map()), tail + " --include-empty");
  assert.equal(includeEmptyCustomHook("node notes.mjs 'else'", new Map()), "node notes.mjs 'else' --include-empty");
});

test("continued heredoc delimiters preserve body bytes and the command after the terminator", () => {
  const writer = "pm-changelog " + standing;
  for (const opener of ["cat <<'EO'\\\n'F'", "cat <<- 'EO'\\\n'F'", "cat <<E\\\nOF", "cat <<EOF"]) {
    const prefix = opener + "\n" + writer + "\nEOF\n";
    assert.equal(rewriteReleaseHeadingDate(prefix + writer, day), prefix + writer.replace("--date-from-version", "--date-fallback " + day));
    assert.throws(() => assertReleaseHeadingDate([prefix + writer], day, "2026.11.16"), /retire-unpublished/);
  }
});

test("timeout preserve-status aliases take a duration and leave generator policy intact", () => {
  for (const option of ["-p", "--preserve-status"]) {
    const script = "timeout " + option + " 60 pm-changelog " + standing;
    assert.equal(rewriteReleaseHeadingDate(script, day), script.replace("--date-from-version", "--date-fallback " + day));
    assert.throws(() => rewriteReleaseHeadingDate(script.replace(option, "-Z"), day), /wrapper/);
  }
});

test("workspace preparation records only a resolved npm lifecycle setting", t => {
  const root = mkdtempSync(join(tmpdir(), "release-hook-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const member = join(root, "member");
  mkdirSync(member);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", workspaces: ["member"] }));
  const manifest = join(member, "package.json");
  const scripts = { hook: "node ./pm-changelog.ts " + standing, prehook: "node ./pm-changelog.ts " + standing };
  const user = join(root, "user.npmrc");
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  Object.assign(env, { npm_config_userconfig: user, npm_config_globalconfig: devNull,
    CHANGELOG_SCRIPT: "hook", CHANGELOG_CHECK_SCRIPT: "hook", NOTES_SCRIPT: "hook", RELEASE_HEADING_DATE: day });
  const prepare = (project: string, userSetting: string, overrides = {}) => {
    writeFileSync(manifest, JSON.stringify({ name: "member", scripts }));
    writeFileSync(join(member, ".npmrc"), "ignore-scripts=true\n");
    writeFileSync(join(root, ".npmrc"), project);
    writeFileSync(user, userSetting);
    const output = join(root, "outputs");
    writeFileSync(output, "");
    execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts"), output], { cwd: member, env: { ...env, ...overrides } });
    return [readFileSync(output, "utf8").trim(), JSON.parse(readFileSync(manifest, "utf8")).scripts.prehook];
  };
  const enabled = ["npm_lifecycle=true\nnpm_lifecycle_configured=true", scripts.prehook.replace("--date-from-version", "--date-fallback " + day) + " --include-empty"];
  const disabled = ["npm_lifecycle=false\nnpm_lifecycle_configured=false", scripts.prehook];
  assert.deepEqual(prepare("ignore-scripts=false", "ignore-scripts=true"), enabled);
  assert.deepEqual(prepare("ignore-scripts=true", "ignore-scripts=false"), disabled);
  assert.deepEqual(prepare("", "ignore-scripts=false"), enabled);
  assert.deepEqual(prepare("", "", { NPM_CONFIG_IGNORE_SCRIPTS: "true" }), disabled);
  for (const config of ["", "ignore-scripts=${UNRESOLVED_RELEASE_SETTING}", "ignore-scripts[]=false"]) {
    assert.throws(() => prepare(config, ""), /ignore-scripts.*prehook/);
  }
  assert.deepEqual(projectNpmLifecyclePolicy(join(root, "absent")), { active: "unknown", configured: "unknown" });
  assert.throws(() => prepare("", "", { npm_config_ignore_scripts: "true", "npm_config_ignore-scripts": "false" }), /ignore-scripts.*prehook/);
  assert.throws(() => prepare("", "", { npm_config_userconfig: root }), /ignore-scripts.*prehook/);
  const native = process.platform === "win32";
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
  const lookup = native ? { MSYSTEM: "", PATHEXT: ".CMD" } : {};
  assert.throws(() => prepare("ignore-scripts=true", "", { ...lookup, [pathKey]: member }), /ignore-scripts.*prehook/);
  writeFileSync(join(member, native ? "npm.cmd" : "npm"), native ? "@exit /b 97\r\n" : "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  assert.throws(() => prepare("ignore-scripts=true", "", { ...lookup, [pathKey]: [member, env[pathKey]].join(delimiter) }), /ignore-scripts.*prehook/);
});

test("a copied Node executable in a spaced path keeps its generator and script entry point", () => {
  const node = "'/fixture/node bin/node.exe'";
  const generator = node + " scripts/pm-changelog.ts " + standing;
  assert.equal(rewriteReleaseHeadingDate(generator, day), generator.replace("--date-from-version", "--date-fallback " + day));
  assert.throws(() => rewriteReleaseHeadingDate(generator.replace("node.exe", "other.exe"), day), /Unrecognized wrapper/);
  const before = "printf data > helper.js; " + node;
  const check = (command: string) => resolveChangelogHooks({ hook: command + "; pm-changelog " + standing }, ["hook"]);
  assert.throws(() => check(before + " helper.js"), /generated release hook file/);
  assert.doesNotThrow(() => check(before + " committed.js helper.js"));
});

test("conditional notes accept prepared script forwards only when every branch ends in a generator", () => {
  const generator = "pm-changelog " + standing + " --stdout";
  const notes = "if test -f preview; then npm run first; else npm run second; fi";
  const scripts = new Map([["first", generator], ["second", "npm run next"], ["next", generator]]);
  for (const next of [generator, "if true; then npm run first; else " + generator + "; fi"]) {
    scripts.set("next", next);
    assert.equal(includeEmptyCustomHook(notes, scripts, true), notes);
  }
  for (const next of ["node notes.mjs", "npm run next", "npm run --if-present missing", "# no renderer", ">preview.md"]) {
    scripts.set("next", next);
    assert.throws(() => includeEmptyCustomHook(notes, scripts, true), /single script entry point/);
  }
});

test("standalone workflows check executed generated changelog scripts and preserve smoke scripts and data", () => {
  const audit = (body: string, final: string) => auditInvocations([workflow(
    "cat <<'END' >generate.sh\n" + body + "\nEND\n" + final, "pm-changelog " + standing,
  )]).failures;
  assert.deepEqual(audit("printf ready", "sh generate.sh"), []);
  assert.deepEqual(audit("pm-changelog --release-version-from-package", "cat generate.sh"), []);
  assert.match(audit("pm-changelog --release-version-from-package", "sh generate.sh")[0] ?? "", /generated release hook file/);
});

test("only a literal false job disables its steps for the heading audit", () => {
  for (const condition of [false, true, "${{ inputs.enabled }}"]) {
    const source = { file: ".github/workflows/release.yml", text: stringify({ jobs: {
      generate: { if: condition, steps: [{ run: "pm-changelog --release-version-from-package" }] },
      active: { steps: [{ run: "pm-changelog " + standing }] },
    } }) };
    assert.equal(executableShellBodies(source)[0].text, "pm-changelog --release-version-from-package");
    assert.equal(auditInvocations([source]).failures.length, condition === false ? 0 : 1);
  }
});

test("a complete env-file overwrite recovers the policy after branches or opaque data", () => {
  const policy = (run: string, condition: boolean | string = true) => npmLifecycle(undefined, executableShellBodies({
    file: ".github/workflows/env.yml", text: stringify({ jobs: { prepare: { "runs-on": "ubuntu-latest", steps: [
      { if: condition, run }, { run: "npm run hook" },
    ] } } }),
  })[1].environment);
  const overwrite = 'echo npm_config_ignore_scripts=true > "$GITHUB_ENV"';
  const branch = "if test -f optional; then\n";
  const opaque = 'cat settings >> "$GITHUB_ENV"';
  const opposite = 'echo npm_config_ignore_scripts=false >> "$GITHUB_ENV"';
  for (const first of [branch + opposite + "\nfi", opaque]) {
    assert.equal(policy(first), "unknown");
    assert.equal(policy(first + "\n" + overwrite), false);
    assert.equal(policy(first + "\n" + overwrite, "${{ inputs.enabled }}"), "unknown");
    assert.equal(policy(first + "\n" + branch + overwrite + "\nfi"), "unknown");
  }
  for (const alternative of ["else", "elif test -f second; then"]) {
    const branches = branch + opposite + "\n" + alternative + "\n" + overwrite + "\nfi";
    assert.equal(policy(branches), "unknown");
    assert.equal(policy(branches + "\n" + overwrite), false);
  }
  assert.equal(policy(branch + branch + opposite + "\nfi\n" + overwrite + "\nfi"), "unknown");
  assert.equal(policy(opaque + "\n" + overwrite.replace(" > ", " >> ")), "unknown");
  assert.equal(policy("exit 0\n" + overwrite), "unknown");
});

test("attached redirects terminate generator argv while quoted and escaped operators remain data", () => {
  for (const operator of [">", ">>", ">|", "<"]) {
    const script = "pm-changelog " + standing + operator + "preview.log";
    assert.equal(rewriteReleaseHeadingDate(script, day), script.replace("--date-from-version", "--date-fallback " + day));
  }
  for (const title of ["'a>b'", "a\\>b"]) {
    assert.equal(rewriteReleaseHeadingDate("pm-changelog --date-from-version --title " + title, day),
      "pm-changelog --date-fallback " + day + " --title " + title);
  }
});

test("npm start forwards to the package script with its own lifecycle and date policy", () => {
  const scripts = new Map([["hook", "npm start"], ["start", "pm-changelog " + standing], ["prestart", "pm-changelog --release-version-from-package"]]);
  const roots = ["hook"];
  assert.match(rewriteReleaseHookDates(scripts, roots, day, false).get("start") ?? "", /--date-fallback 2026-11-17/);
  assert.throws(() => assertReleaseHookHeadingDate(scripts, roots, day, undefined, "unknown"), /ignore-scripts/);
  scripts.set("hook", "npm --ignore-scripts start");
  assert.doesNotThrow(() => resolveChangelogHooks(Object.fromEntries(scripts), roots));
  assert.throws(() => resolveChangelogHooks({ hook: "npm start" }, roots), /missing|start/i);
});

test("custom renderer arguments precede its terminator and trailing Git checks stay intact", () => {
  const scripts = new Map([["render", "node notes.mjs"]]);
  for (const tail of ["", " && git diff --cached --quiet"]) {
    for (const [command, expected] of [
      ["node notes.mjs -- draft.md", "node notes.mjs --include-empty -- draft.md"],
      ["npm run render -- -- draft.md", "npm run render -- --include-empty -- draft.md"],
    ]) {
      assert.equal(includeEmptyCustomHook(command + tail, scripts), expected + tail);
      assert.equal(includeEmptyCustomHook(expected + tail, scripts), expected + tail);
    }
  }
  assert.throws(() => includeEmptyCustomHook("git diff --cached --quiet", scripts), /single script entry point/);
  assert.throws(() => includeEmptyCustomHook("node one.mjs && node two.mjs && git diff --quiet", scripts), /single script entry point/);
});

test("re-preparation guidance covers an expired all-tags cutoff", () => {
  const guide = readFileSync(resolve("docs/reusable-release.md"), "utf8");
  assert.match(guide, /remove `--until` or update it to the new planned heading day/i);
  for (const cutoff of ["", " --until " + day]) {
    assert.doesNotThrow(() => assertReleaseHeadingDate(["pm-changelog " + standing + " --all-release-tags" + cutoff], day, "2026.11.17"));
  }
});

test("generated-script provenance follows the executed file in nested workflow projects", () => {
  const inspect = (payload: string, execute: string) => {
    const steps = [{ "working-directory": "nested", run: "cat <<'END' >render.sh\n" + payload + "\nEND\n" + execute },
      { run: "pm-changelog " + standing }];
    return auditInvocations([{ file: ".github/workflows/release.yml", text: stringify({ jobs: { release: { steps } } }) }]).failures;
  };
  assert.deepEqual(inspect("echo ready", "sh render.sh"), []);
  assert.deepEqual(inspect("pm-changelog --release-version-from-package", "cat render.sh"), []);
  assert.match(inspect("pm-changelog --release-version-from-package", "sh render.sh")[0] ?? "", /working-directory/);
});

test("custom forwards respect option boundaries in shared renderer scripts", () => {
  const scripts = new Map([["render", "node notes.mjs -- draft.md"]]);
  assert.throws(() => includeEmptyCustomHook("npm run render", scripts), /single script entry point/);
  scripts.set("render", "node notes.mjs && git diff --quiet");
  assert.throws(() => includeEmptyCustomHook("npm run render", scripts), /cannot receive forwarded arguments/);
  scripts.set("render", "node notes.mjs --include-empty -- draft.md");
  assert.equal(includeEmptyCustomHook("npm run render", scripts), "npm run render");
  assert.equal(includeEmptyCustomHook("node notes.mjs -- --include-empty", scripts),
    "node notes.mjs --include-empty -- --include-empty");
});

test("quoted and escaped descriptor-like operands retain their adjacent redirect boundary", () => {
  for (const word of ["'2'", "'>'", "\\>", "''"]) {
    const script = "pm-changelog --date-from-version --title " + word + ">preview";
    const { commands } = parseReleaseHook(script);
    assert.equal(commands[0].at(-1)?.value, ">preview");
    assert.equal(releaseHookCommand(commands[0])?.at(-1)?.value, word.replace(/['\\]/g, ""));
  }
});

test("a reset after opaque echo data is independent of that record", () => {
  const observe = (suffix: string) => npmLifecycle(undefined, executableShellBodies({ file: ".github/workflows/env.yml", text: stringify({
    jobs: { release: { "runs-on": "ubuntu-latest", steps: [{ run: 'echo "$RECORD" >> "$GITHUB_ENV"\n' + suffix }, { run: "true" }] } },
  }) })[1].environment);
  assert.equal(observe('echo npm_config_ignore_scripts=true >> "$GITHUB_ENV"'), "unknown");
  assert.equal(observe('echo npm_config_ignore_scripts=true > "$GITHUB_ENV"'), false);
});

test("nounset preserves uncertainty about an overwrite for consumers that can run after failure", t => {
  const root = mkdtempSync(join(tmpdir(), "release-env-nounset-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "environment");
  const run = [
    'echo npm_config_ignore_scripts=false >> "$GITHUB_ENV"',
    'echo "$RECORD" >> "$GITHUB_ENV"',
    'echo npm_config_ignore_scripts=true > "$GITHUB_ENV"',
  ].join("\n");
  const policy = (flags: string, condition: string, record?: string) => npmLifecycle(undefined, executableShellBodies({
    file: ".github/workflows/env.yml",
    text: stringify({ jobs: { release: { "runs-on": "ubuntu-latest", steps: [
      { shell: "bash {0}", run: "set " + flags + "\n" + run, env: record === undefined ? undefined : { RECORD: record } },
      { run: "true", if: condition },
    ] } } }),
  })[1].environment);
  for (const flags of ["-e", "-u", "-eu"]) {
    if (process.platform !== "win32") {
      const env = { ...process.env, GITHUB_ENV: file };
      delete (env as NodeJS.ProcessEnv).RECORD;
      writeFileSync(file, "");
      const execute = () => execFileSync("bash", ["-c", "set " + flags + "\n" + run], { cwd: root, env, stdio: "pipe" });
      if (flags.includes("u")) assert.throws(execute, /unbound variable/);
      else execute();
      assert.equal(readFileSync(file, "utf8"), "npm_config_ignore_scripts=" + !flags.includes("u") + "\n");
    }
    assert.equal(policy(flags, "always()"), flags.includes("u") ? "unknown" : false);
    assert.equal(policy(flags, "success()"), false);
  }
  assert.equal(policy("-eu", "always()", "OTHER=value"), false);
  assert.equal(policy("-eu", "always()", "${{ vars.RECORD }}"), "unknown");
});

test("npm start cannot skip its implicit server entry when the manifest has no start script", () => {
  for (const target of ["start", "restart"]) {
    assert.throws(() => resolveChangelogHooks({ hook: "npm --if-present " + target }, ["hook"]), /missing or empty/);
  }
  for (const target of ["stop", "test"]) {
    assert.doesNotThrow(() => resolveChangelogHooks({ hook: "npm --if-present " + target }, ["hook"]));
  }
  assert.doesNotThrow(() => resolveChangelogHooks({ hook: "npm --if-present run missing" }, ["hook"]));
});

test("npm run cannot skip an implicit start or restart target", () => {
  const start = "pm-changelog " + standing;
  for (const command of ["run", "run-script"]) {
    const hook = "npm " + command + " --if-present ";
    for (const target of ["start", "restart"]) {
      const scripts = target === "restart" ? { start } : {};
      assert.throws(() => resolveChangelogHooks({ ...scripts, hook: hook + target }, ["hook"]), /missing or empty/);
      assert.equal(resolveChangelogHooks({ hook: hook + target, [target]: start }, ["hook"]).get(target), start);
    }
    assert.deepEqual([...resolveChangelogHooks({ hook: hook + "missing", start }, ["hook"]).keys()], ["hook"]);
  }
});

test("standalone literal script writes retain local generator forwards until the file is executed", () => {
  const scripts = { writer: "pm-changelog " + standing, smoke: "echo ready" };
  const manifest = { file: "package.json", text: JSON.stringify({ scripts }) };
  const inspect = (write: string, use: string) => auditInvocations([manifest, workflow(write + "\n" + use)]).failures;
  for (const payload of ["npm run writer", "pm-changelog --release-version-from-package", "npm run smoke"]) {
    for (const write of ["cat <<'END' >runner.sh\n" + payload + "\nEND", "printf '%s\\n' '" + payload + "' >runner.sh"]) {
      assert.deepEqual(inspect(write, "cat runner.sh"), []);
      const result = inspect(write, "sh runner.sh");
      if (payload === "npm run smoke") assert.deepEqual(result, []);
      else assert.match(result[0] ?? "", /generated release hook file/);
    }
  }
});

test("status guards and pipeline sinks do not become renderer candidates before Git checks", () => {
  const tail = " && git diff --quiet";
  const guard = "test -f package.json && ";
  const scripts = new Map<string, string>();
  for (const prefix of ["", guard]) {
    const renderer = prefix + "node notes.mjs | cat";
    assert.equal(includeEmptyCustomHook(renderer + tail, scripts), renderer.replace("notes.mjs", "notes.mjs --include-empty") + tail);
    for (const generator of ["pm-changelog --stdout", "pm-changelog --check && pm-changelog --stdout"]) {
      assert.equal(includeEmptyCustomHook(prefix + generator + tail, scripts, true), prefix + generator + tail);
    }
  }
});

test("npm lifecycle commands forward generator arguments and respect the pre-hook policy", () => {
  for (const target of ["start", "test", "stop", "restart"]) {
    const entries = new Map([["hook", "npm " + target + " -- --date-from-version"], [target, "pm-changelog --release-version-from-package"],
      ["pre" + target, "pm-changelog " + standing + " --output CHANGELOG.md"]]);
    const disabled = rewriteReleaseHookDates(entries, ["hook"], day, false);
    assert.equal(disabled.get("hook"), "npm " + target + " -- --date-fallback " + day);
    assert.equal(disabled.has("pre" + target), false);
    assert.throws(() => resolveChangelogHooks(Object.fromEntries(entries), ["hook"]), /ignore-scripts/);
    const enabled = rewriteReleaseHookDates(entries, ["hook"], day, true);
    assert.match(enabled.get("pre" + target) ?? "", /--date-fallback 2026-11-17/);
    assert.doesNotThrow(() => assertReleaseHookHeadingDate(enabled, ["hook"], day, "2026.11.17", true));
    assert.throws(() => assertReleaseHookHeadingDate(enabled, ["hook"], "2026-11-18", "2026.11.17", true), /differs/);
    for (const cmd of ["npm --prefix other " + target, "npm --color=false " + target, "sh -c 'npm " + target + "'"]) {
      assert.throws(() => resolveChangelogHooks({ hook: cmd, [target]: "pm-changelog " + standing }, ["hook"]), /context change|wrapper/);
    }
    assert.doesNotThrow(() => resolveChangelogHooks({ hook: "npm install " + target, [target]: "pm-changelog " + standing }, ["hook"]));
    assert.deepEqual(auditInvocations([workflow("npm " + target), {
      file: "package.json", text: JSON.stringify({ scripts: { [target]: "node smoke.mjs", "changelog:full": "pm-changelog " + standing } }),
    }]).failures, []);
  }
});


test("environment-file overwrites after a failed read require a successful producer", t => {
  const root = mkdtempSync(join(tmpdir(), "release-env-overwrite-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "environment");
  const previous = { run: 'echo npm_config_ignore_scripts=false >> "$GITHUB_ENV"' };
  const overwrite = 'echo npm_config_ignore_scripts=true > "$GITHUB_ENV"';
  const producer = { run: 'cat settings >> "$GITHUB_ENV"\n' + overwrite };
  const consume = { run: "npm run changelog:full" };
  const manifest = { file: "package.json", text: JSON.stringify({ scripts: {
    "changelog:full": "pm-changelog " + standing,
    "prechangelog:full": "printf heading > CHANGELOG.md",
  } }) };
  const audit = (...steps: object[]) => auditInvocations([manifest, {
    file: ".github/workflows/env.yml", text: stringify({ jobs: { release: { "runs-on": "ubuntu-latest", steps } } }),
  }]).failures;
  if (process.platform !== "win32") {
    for (const present of [false, true]) {
      if (present) writeFileSync(join(root, "settings"), "OTHER=value\n");
      writeFileSync(file, "OTHER=before\n");
      const run = () => execFileSync("bash", ["-ec", producer.run], { cwd: root, env: { ...process.env, GITHUB_ENV: file }, stdio: "pipe" });
      if (present) assert.doesNotThrow(run);
      else assert.throws(run, /settings/);
      assert.equal(readFileSync(file, "utf8"), present ? "npm_config_ignore_scripts=true\n" : "OTHER=before\n");
    }
  }
  for (const condition of ["${{ always() }}", "failure()", "!success()"]) {
    assert.match(audit(previous, producer, { ...consume, if: condition })[0] ?? "", /Cannot determine npm ignore-scripts/);
  }
  assert.deepEqual(audit(previous, producer, consume), []);
  assert.deepEqual(audit(previous, producer, { ...consume, if: "${{ success() }}" }), []);
  assert.deepEqual(audit(previous, { ...producer, shell: "bash {0}" }, { ...consume, if: "always()" }), []);
  for (const flags of ["-e", "-ueo pipefail"]) {
    assert.match(audit(previous, { run: "set " + flags + "\n" + producer.run, shell: "bash {0}" },
      { ...consume, if: "always()" })[0] ?? "", /Cannot determine npm ignore-scripts/);
  }
  assert.deepEqual(audit(previous, { run: "set -u\n" + producer.run, shell: "bash {0}" }, { ...consume, if: "always()" }), []);
  assert.deepEqual(audit(previous, { run: 'echo "$RECORD" >> "$GITHUB_ENV"\n' + overwrite },
    { ...consume, if: "${{ always() }}" }), []);
});

test("an unquoted runner environment read can stop a producer before it writes", t => {
  const root = mkdtempSync(join(tmpdir(), "release-env-read-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "runner environment");
  const overwrite = 'echo npm_config_ignore_scripts=true > "$GITHUB_ENV"';
  for (const quoted of [false, true]) {
    const read = quoted ? '"$GITHUB_ENV"' : '$GITHUB_ENV';
    const run = "cat " + read + "\n" + overwrite;
    if (process.platform !== "win32") {
      writeFileSync(file, "");
      const execute = () => execFileSync("bash", ["-ec", run], { cwd: root, env: { ...process.env, GITHUB_ENV: file }, stdio: "pipe" });
      if (quoted) assert.doesNotThrow(execute);
      else assert.throws(execute, /No such file/);
      assert.equal(readFileSync(file, "utf8"), quoted ? "npm_config_ignore_scripts=true\n" : "");
    }
    const audit = (condition: string, producer = run, shell = "bash") => auditInvocations([
      { file: "package.json", text: JSON.stringify({ scripts: {
        "changelog:full": "pm-changelog " + standing, "prechangelog:full": "printf heading > CHANGELOG.md",
      } }) },
      { file: ".github/workflows/env.yml", text: stringify({ jobs: { release: {
        "runs-on": "ubuntu-latest", env: { npm_config_ignore_scripts: "false" },
        steps: [{ shell, run: producer }, { if: condition, run: "npm run changelog:full" }],
      } } }) },
    ]).failures;
    const afterFailure = audit("always()");
    if (quoted) assert.deepEqual(afterFailure, []);
    else assert.match(afterFailure[0] ?? "", /Cannot determine npm ignore-scripts/);
    assert.deepEqual(audit("success()"), []);
    assert.deepEqual(audit("always()", run, "bash {0}"), []);
    assert.deepEqual(audit("always()", overwrite + "\ncat " + read), []);
  }
});

test("the step's explicit npm setting wins over unknown writes by an earlier action", () => {
  const audit = (env: unknown, action: { uses: string; if?: boolean } = { uses: "./local-action" },
    jobEnv?: string) => auditInvocations([
    { file: "package.json", text: JSON.stringify({ scripts: {
      "changelog:full": "pm-changelog " + standing, "prechangelog:full": "printf heading > CHANGELOG.md",
    } }) },
    { file: ".github/workflows/env.yml", text: stringify({ env: { npm_config_ignore_scripts: "true" }, jobs: {
      release: { "runs-on": "ubuntu-latest", env: jobEnv, steps: [action, { run: "npm run changelog:full", env }] },
    } }) },
  ]).failures;
  assert.deepEqual(audit({ npm_config_ignore_scripts: "true" }), []);
  assert.deepEqual(audit({ npm_config_ignore_scripts: "false" }), []);
  for (const env of [{}, { npm_config_ignore_scripts: "" }, { npm_config_ignore_scripts: "${{ inputs.policy }}" }]) {
    assert.match(audit(env)[0] ?? "", /Cannot determine npm ignore-scripts/);
  }
  const disabled = { uses: "./local-action", if: false };
  assert.deepEqual(audit({}, disabled), []);
  const generated = "${{ fromJSON(vars.RELEASE_ENV) }}";
  assert.deepEqual(audit({ npm_config_ignore_scripts: "true" }, disabled, generated), []);
  assert.match(audit({}, disabled, generated)[0] ?? "", /Cannot determine npm ignore-scripts/);
});

test("a computed command basename without lookup arguments cannot abort generator inspection", () => {
  const writer = "pm-changelog " + standing;
  assert.equal(rewriteReleaseHeadingDate('"$TOOLS"/command; ' + writer, day),
    '"$TOOLS"/command; pm-changelog --release-version-from-package --date-fallback ' + day);
  assert.equal(rewriteReleaseHeadingDate("command -v pm-changelog && " + writer, day),
    "command -v pm-changelog && pm-changelog --release-version-from-package --date-fallback " + day);
  for (const args of ["", "-v "]) {
    assert.throws(() => rewriteReleaseHeadingDate('"$TOOLS"/command ' + args + writer, day), /Unrecognized wrapper/);
  }
});

test("npm restores the configured setting after a parent overrides ignore-scripts back to the default", () => {
  const hook = "changelog:full";
  const script = "npm --ignore-scripts=false run relay";
  const source = (relay: string) => ({ [hook]: script, relay, prerelay: "pm-changelog " + standing,
    writer: "pm-changelog " + standing, prewriter: "pm-changelog --release-version-from-package" });
  const plain = source("npm run writer");
  assert.deepEqual([...resolveChangelogHooks(plain, [hook], false).keys()], [hook, "prerelay", "relay", "writer"]);
  assert.doesNotThrow(() => assertReleaseHookHeadingDate(new Map(Object.entries(plain)), [hook], day, "2026.11.17", false));
  assert.equal(rewriteReleaseHookDates(new Map(Object.entries(plain)), [hook], day, false).has("prewriter"), false);
  const pinned = { ...plain, prerelay: `pm-changelog --release-version-from-package --date-fallback=${day} --include-empty` };
  assert.equal(resolveChangelogHooks(pinned, [hook], false).has("prewriter"), false);
  assert.equal(resolveChangelogHooks({ ...plain, relay: "true; npm run writer" }, [hook], false).has("prewriter"), false);
  assert.throws(() => resolveChangelogHooks({ ...plain, prerelay: plain.prerelay + " --output custom-config" }, [hook], false),
    /Cannot verify nested npm lifecycle.*writer/);
  const enabled = source("npm --ignore-scripts=false run writer");
  assert.equal(resolveChangelogHooks(enabled, [hook], false).has("prewriter"), true);
  assert.throws(() => rewriteReleaseHookDates(new Map(Object.entries(enabled)), [hook], day, false), /without a date policy/);
  assert.equal(resolveChangelogHooks(plain, [hook], true).has("prewriter"), true);
  assert.throws(() => resolveChangelogHooks(plain, [hook]), /Cannot determine npm ignore-scripts.*prewriter/);
  assert.equal(resolveChangelogHooks({ ...plain, [hook]: "npm --ignore-scripts=true run relay" }, [hook], true).has("prewriter"), false);
});

test("npm preserves invocation-local aliases when clearing its canonical lifecycle key", { skip: process.platform === "win32" }, t => {
  const root = mkdtempSync(join(tmpdir(), "release-npm-local-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const npm = npmCli(true);
  const manifest = join(root, "package.json");
  const env = isolatedNpmConfig(root);
  writeFileSync(join(root, ".npmrc"), "ignore-scripts=true\n");
  const options = ["--ignore-scripts=false", "run", "--silent", "relay"];
  const hookScripts = (assignments: string) => ({
    hook: "env " + assignments + " npm " + options.join(" "), relay: "npm run middle", middle: "npm run writer",
    writer: "pm-changelog " + standing, prewriter: "pm-changelog --release-version-from-package",
  });
  const policy = { active: false, configured: false } as const;
  for (const [assignments, enabled] of [
    ["NPM_CONFIG_IGNORE_SCRIPTS=false npm_config_ignore_scripts=true", true],
    ["npm_config_ignore_scripts=true", false],
    ["npm_config_ignore_scripts=true NPM_CONFIG_IGNORE_SCRIPTS=true", false],
    ["NPM_CONFIG_IGNORE_SCRIPTS=false npm_config_ignore_scripts=true NPM_CONFIG_IGNORE_SCRIPTS=", false],
  ] as const) {
    writeFileSync(manifest, JSON.stringify({ name: "fixture", scripts: {
      relay: "npm run --silent middle", middle: "npm run --silent writer", writer: "echo writer", prewriter: "echo prewriter",
    } }));
    const output = execFileSync("env", [...assignments.split(" "), process.execPath, npm, ...options], { cwd: root, env, encoding: "utf8" });
    assert.deepEqual(output.trim().split(/\r?\n/), enabled ? ["prewriter", "writer"] : ["writer"], assignments);
    const scripts = hookScripts(assignments);
    const resolved = resolveChangelogHooks(scripts, ["hook"], policy);
    assert.equal(resolved.has("prewriter"), enabled, scripts.hook);
    const all = new Map(Object.entries(scripts));
    const heading = () => assertReleaseHookHeadingDate(all, ["hook"], day, "2026.11.17", policy);
    const prepare = () => rewriteReleaseHookDates(all, ["hook"], day, policy);
    if (enabled) {
      assert.throws(prepare, /without a date policy/);
      assert.throws(heading, /without a date policy/);
    } else {
      assert.doesNotThrow(prepare);
      assert.doesNotThrow(heading);
    }
  }
  const hyphenated = (value: string) => hookScripts("npm_config_ignore-scripts=" + value + " npm_config_ignore_scripts=true");
  assert.throws(() => resolveChangelogHooks(hyphenated("false"), ["hook"], policy), /ignore-scripts.*prewriter/);
  assert.equal(resolveChangelogHooks(hyphenated("true"), ["hook"], policy).has("prewriter"), false);
});

test("a conditional notes hook without else keeps the preceding renderer", () => {
  const branch = "if test -f preview.json; then node render.mjs; fi";
  assert.throws(() => includeEmptyCustomHook("node fallback.mjs; " + branch, new Map()), /alternative renderers/);
  assert.equal(includeEmptyCustomHook(branch, new Map()), branch.replace("render.mjs", "render.mjs --include-empty"));
  const complete = "node setup.mjs; if test -f preview.json; then pm-changelog --stdout; else node dist/cli.js --stdout; fi";
  assert.equal(includeEmptyCustomHook(complete, new Map(), true), complete);
  const nested = "node fallback.mjs; if test -f preview.json; then if test -f other.json; then node render.mjs; fi; fi";
  assert.throws(() => includeEmptyCustomHook(nested, new Map()), /alternative renderers/);
});

test("npm cannot forward a custom renderer flag to a trailing status command", () => {
  for (const tail of ["true", "false", ":", "test -s notes.txt", "[ -s notes.txt ]", "git diff --quiet"]) {
    const scripts = new Map([["render", "node notes.mjs && " + tail]]);
    assert.throws(() => includeEmptyCustomHook("npm run render", scripts), /cannot receive forwarded arguments/);
  }
  assert.equal(includeEmptyCustomHook("npm run render", new Map([["render", "node notes.mjs"]])), "npm run render -- --include-empty");
  assert.equal(includeEmptyCustomHook("npm run render", new Map([["render", "pm-changelog --stdout && true"]]), true), "npm run render");
});


test("release fixture paths preserve the inherited Windows key and executable directories", () => {
  for (const key of ["PATH", "Path", "path"]) {
    const env = { [key]: "system-path" };
    prependFixturePath(env, "fixture-bin", true);
    assert.deepEqual(env, { [key]: ["fixture-bin", "system-path"].join(delimiter) });
  }
  const env = { PATH: "system-path", Path: "untouched" };
  prependFixturePath(env, "fixture-bin", false);
  assert.deepEqual(env, { PATH: ["fixture-bin", "system-path"].join(delimiter), Path: "untouched" });
});

/** Prepend the fixture launcher while retaining the inherited lookup path. */
function prependFixturePath(env: NodeJS.ProcessEnv, bin: string, windows = process.platform === "win32"): void {
  const key = (windows && Object.keys(env).find(name => name.toLowerCase() === "path")) || "PATH";
  env[key] = [bin, env[key]].join(delimiter);
}

test("preparation and real npm reload project policy when a nested override clears the inherited env setting", t => {
  const root = mkdtempSync(join(tmpdir(), "release-npm-cli-default-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const cli = npmCli();
  if (process.platform !== "win32") symlinkSync(cli, join(bin, "npm"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  prependFixturePath(env, bin);
  Object.assign(env, { npm_config_ignore_scripts: "true",
    NPM_CONFIG_USERCONFIG: join(root, "user.npmrc"), NPM_CONFIG_GLOBALCONFIG: join(root, "global.npmrc"),
    CHANGELOG_SCRIPT: "hook", CHANGELOG_CHECK_SCRIPT: "hook", NOTES_SCRIPT: "hook", RELEASE_HEADING_DATE: day });
  const scripts = {
    hook: "npm --ignore-scripts=false run relay", relay: "npm run writer",
    writer: "node pm-changelog.ts " + standing + " --stdout",
    prewriter: "node pm-changelog.ts --release-version-from-package",
  };
  const manifest = join(root, "package.json");
  const prepare = () => execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts")], { cwd: root, env, stdio: "pipe" });
  writeFileSync(join(root, "pm-changelog.ts"), String.raw`require("node:fs").appendFileSync("calls", process.argv.includes("--stdout") ? "writer\n" : "prewriter\n");`);
  for (const hook of [
    scripts.hook, "env npm_config_ignore_scripts= npm run relay",
    "npm_config_ignore_scripts='' npm run relay",
  ]) for (const ignore of [false, true]) {
    writeFileSync(manifest, JSON.stringify({ name: "fixture", scripts: { ...scripts, hook } }));
    writeFileSync(join(root, ".npmrc"), "ignore-scripts=" + ignore + "\n");
    const calls = join(root, "calls");
    rmSync(calls, { force: true });
    execFileSync(process.execPath, [cli, "run", "hook"], { cwd: root, env });
    assert.equal(readFileSync(calls, "utf8"), ignore ? "writer\n" : "prewriter\nwriter\n");
    if (ignore) assert.doesNotThrow(prepare);
    else assert.throws(prepare, /without a date policy/);
  }
  const writer = { hook: "env npm_config_ignore_scripts= npm run writer", writer: "pm-changelog " + standing,
    prewriter: "pm-changelog " + standing };
  assert.throws(() => resolveChangelogHooks(writer, ["hook"], { active: false, configured: "unknown" }), /ignore-scripts.*prewriter/);
  assert.equal(resolveChangelogHooks({ ...writer, hook: "env npm_config_ignore_scripts=true npm run writer" }, ["hook"],
    { active: false, configured: "unknown" }).has("prewriter"), false);
});


test("empty npm settings preserve remaining aliases and refuse a fallback that may have changed", () => {
  const writer = "pm-changelog " + standing;
  const policy = { active: false, configured: false } as const;
  const inspect = (hook: string, prewriter = writer) => resolveChangelogHooks({ hook, writer, prewriter }, ["hook"], policy);
  assert.equal(inspect("env npm_config_ignore_scripts= NPM_CONFIG_IGNORE_SCRIPTS=false npm run writer").get("prewriter"), writer);
  assert.equal(inspect("env npm_config_ignore_scripts= NPM_CONFIG_IGNORE_SCRIPTS=true npm run writer").has("prewriter"), false);
  assert.throws(() => inspect("env NPM_CONFIG_IGNORE_SCRIPTS= npm run writer"), /ignore-scripts.*prewriter/);
  assert.doesNotThrow(() => inspect("env NPM_CONFIG_IGNORE_SCRIPTS= npm run writer", "true"));
  assert.throws(() => inspect("env npm_config_ignore_scripts= NPM_CONFIG_IGNORE_SCRIPTS= npm run writer"), /ignore-scripts.*prewriter/);
  assert.doesNotThrow(() => inspect("env npm_config_ignore_scripts= NPM_CONFIG_IGNORE_SCRIPTS= npm run writer", "true"));
  const prefix = "node refresh.mjs; env npm_config_ignore_scripts= npm";
  assert.throws(() => inspect(prefix + " run writer"), /ignore-scripts.*prewriter/);
  assert.equal(inspect(prefix + " --ignore-scripts=true run writer").has("prewriter"), false);
});

test("conditional status checks preserve the previous notes renderer", () => {
  const status = "if test -f notes.txt; then test -s notes.txt; fi";
  const generator = "pm-changelog " + standing + " --stdout; " + status;
  assert.equal(includeEmptyCustomHook(generator, new Map(), true), generator);
  const custom = "node notes.mjs; " + status;
  assert.equal(includeEmptyCustomHook(custom, new Map()), "node notes.mjs --include-empty; " + status);
  const alternative = "node fallback.mjs; if test -f notes.txt; then node render.mjs; test -s notes.txt; fi";
  assert.throws(() => includeEmptyCustomHook(alternative, new Map()), /alternative renderers/);
});

test("literal standalone redirects leave the renderer and its forwarding boundary intact", () => {
  for (const redirect of [">preview.log", '2>> "preview log"', "<input >output", "2>&1"]) {
    const hook = "node notes.mjs; " + redirect;
    assert.equal(includeEmptyCustomHook(hook, new Map()), "node notes.mjs --include-empty; " + redirect);
    assert.throws(() => includeEmptyCustomHook("npm run render", new Map([["render", hook]])), /cannot receive forwarded arguments/);
  }
  const generator = "pm-changelog " + standing + " --stdout; >preview.log";
  assert.equal(includeEmptyCustomHook(generator, new Map(), true), generator);
  assert.equal(includeEmptyCustomHook("npm run render", new Map([["render", generator]]), true), "npm run render");
  const ambiguous = "node primary.mjs; if test -f input; then node alternative.mjs; fi; >preview.log";
  assert.throws(() => includeEmptyCustomHook(ambiguous, new Map()), /alternative renderers/);
  const unresolved = "if test -f input; then " + generator + '; else >"$DYNAMIC"; fi';
  assert.throws(() => includeEmptyCustomHook(unresolved, new Map(), true), /alternative renderers/);
  const status = "node notes.mjs; if test -f input; then >preview.log; fi";
  assert.equal(includeEmptyCustomHook(status, new Map()), status.replace("notes.mjs", "notes.mjs --include-empty"));
  assert.equal(includeEmptyCustomHook("node notes.mjs; >\"$DYNAMIC\"", new Map()), "node notes.mjs; >\"$DYNAMIC\"");
});

test("an uncertain npm lifecycle refuses copies into CHANGELOG.md and permits copies out", () => {
  const target = "changelog:full";
  const manifests = (copy: string) => ({ [target]: "pm-changelog " + standing, ["post" + target]: copy });
  for (const copy of ["cp preview.md CHANGELOG.md", "command cp -f -- preview.md ./CHANGELOG.md"]) {
    assert.throws(() => resolveChangelogHooks(manifests(copy), [target]), /ignore-scripts.*postchangelog:full/);
    assert.equal(resolveChangelogHooks(manifests(copy), [target], false).has("post" + target), false);
    assert.equal(resolveChangelogHooks(manifests(copy), [target], true).get("post" + target), copy);
  }
  for (const copy of ['cp preview.md "$DESTINATION"', "cp preview.md CHANGELOG.{md,txt}"]) {
    assert.throws(() => resolveChangelogHooks(manifests(copy), [target]), /ignore-scripts.*postchangelog:full/);
  }
  for (const copy of ["cp CHANGELOG.md preview.md", "cp preview.md other/CHANGELOG.md", "cp -t previews CHANGELOG.md",
    "cp --target-directory=previews CHANGELOG.md", "cp CHANGELOG.md", "echo cp preview.md CHANGELOG.md"]) {
    assert.doesNotThrow(() => resolveChangelogHooks(manifests(copy), [target]), copy);
  }
});

test("directory-form copies audit the source basename at the effective destination", () => {
  const audit = (copy: string) => resolveChangelogHooks({ hook: "pm-changelog " + standing, posthook: copy }, ["hook"]);
  for (const copy of ["cp -t . generated/CHANGELOG.md", "cp --target-directory ./ generated/CHANGELOG.md",
    "cp --target-directory=generated/.. generated/preview.md generated/CHANGELOG.md", "cp -ft. -- generated/CHANGELOG.md",
    'cp -t "$TARGET" generated/CHANGELOG.md', 'cp -t . "generated/$FILE"', "cp -t . generated/CHANGE{LOG,X}.md",
    "cp --target-dir=. generated/CHANGELOG.md", "cp --targ ./ generated/CHANGELOG.md",
    "cp generated/CHANGELOG.md ."]) {
    assert.throws(() => audit(copy), /ignore-scripts.*posthook/, copy);
  }
  for (const copy of ["cp -t . generated/preview.md", "cp --target-directory=previews generated/CHANGELOG.md",
    'cp -t previews "generated/$FILE"', "cp generated/CHANGELOG.md previews", "cp -S-t. generated/CHANGELOG.md preview.md",
    "cp -T generated/CHANGELOG.md .", "cp --no-target-directory generated/CHANGELOG.md .", "cp --target-directory= generated/CHANGELOG.md",
    "cp -t", "cp -t . --suffix backup.txt generated/preview.md",
    "cp --target-dir=previews generated/CHANGELOG.md", "cp --targ . generated/preview.md"]) {
    assert.doesNotThrow(() => audit(copy), copy);
  }
});

test("copy lifecycle auditing includes possible simple backup destinations", () => {
  const audit = (copy: string) => resolveChangelogHooks({ hook: "pm-changelog " + standing, posthook: copy }, ["hook"]);
  for (const copy of [
    "cp --backup=simple --suffix=LOG.md draft.md CHANGE",
    "cp --back=simple --su=LOG.md draft.md CHANGE",
    "cp --backup --suffix LOG.md draft.md ./CHANGE",
    "cp --backup=simple -SLOG.md -t . generated/CHANGE",
    "cp -fS LOG.md generated/CHANGE .",
    "cp --suffix=LOG.md draft.md CHANGE",
    "cp --backup=simple draft.md CHANGE",
    "cp -b draft.md CHANGE",
    'cp -S "$SUFFIX" draft.md CHANGE',
  ]) assert.throws(() => audit(copy), /ignore-scripts.*posthook/, copy);
  for (const copy of [
    "cp --backup=numbered --suffix=LOG.md draft.md CHANGE",
    "cp --suffix=LOG.md --backup=off draft.md CHANGE",
    "cp --backup=simple --suffix=.bak draft.md CHANGE",
    "cp --suffix= draft.md CHANGE",
    "cp CHANGE draft.md -S",
    "cp --backup=simple --suffix=LOG.md -t elsewhere generated/CHANGE",
    "cp draft.md CHANGE",
  ]) assert.doesNotThrow(() => audit(copy), copy);
});

test("an AND-list status check retains either possible notes renderer", () => {
  const preferred = "node preferred.mjs && test -s notes.txt";
  const alternative = preferred + " || node fallback.mjs";
  assert.throws(() => includeEmptyCustomHook(alternative, new Map()), /alternative renderers/);
  assert.throws(() => includeEmptyCustomHook("npm run render", new Map([["render", alternative]])), /alternative renderers/);
  assert.throws(() => includeEmptyCustomHook(preferred + " && test -r notes.txt || node fallback.mjs", new Map()), /alternative renderers/);
  assert.equal(includeEmptyCustomHook(preferred + " || true", new Map()), "node preferred.mjs --include-empty && test -s notes.txt || true");
  assert.throws(() => includeEmptyCustomHook("node one.mjs && node two.mjs && test -s notes.txt", new Map()), /single script entry point/);
  assert.equal(includeEmptyCustomHook(alternative + " && node notes.mjs", new Map()), alternative + " && node notes.mjs --include-empty");
  const generators = `pm-changelog ${standing} --stdout && test -s notes.txt || node dist/cli.js ${standing} --stdout`;
  assert.equal(includeEmptyCustomHook(generators, new Map(), true), generators);
});

test("an OR-list status fallback cannot hide a renderer skipped by an AND-list", () => {
  const primary = "node primary.mjs";
  const secondary = "node secondary.mjs";
  const list = primary + " && test -f use-secondary && " + secondary;
  for (const fallback of [" || true", " || : && true", " || false || true", " || > status.log"]) {
    const hook = list + fallback;
    assert.throws(() => includeEmptyCustomHook(hook, new Map()), /single script entry point/, hook);
    assert.throws(() => includeEmptyCustomHook("npm run render", new Map([["render", hook]])), /single script entry point/);
  }
  assert.equal(includeEmptyCustomHook(list, new Map()), list + " --include-empty");
  assert.equal(includeEmptyCustomHook(list + " || false", new Map()), list + " --include-empty || false");
  assert.equal(includeEmptyCustomHook(primary + " && test -f marker || true", new Map()),
    primary + " --include-empty && test -f marker || true");
  const prepared = "pm-changelog --stdout --include-empty";
  const generators = prepared + " && test -f use-secondary && " + prepared + " || true";
  assert.equal(includeEmptyCustomHook(generators, new Map(), true), generators);
  const scripts = new Map([["relay", "npm run writer --"], ["writer", "node"]]);
  const forwarded = generators.replace("&& " + prepared, "&& npm run relay -- scripts/" + prepared.replace("pm-changelog", "pm-changelog.ts"));
  assert.equal(includeEmptyCustomHook(forwarded, scripts, true), forwarded);
  assert.throws(() => includeEmptyCustomHook(forwarded.replace("scripts/pm-changelog.ts", "notes.mjs"), scripts, true),
    /alternative renderers/);
});

test("a pipeline after OR can recover a skipped notes renderer", () => {
  const primary = "node primary.mjs";
  const list = primary + " && test -f use-secondary && node secondary.mjs";
  for (const pipeline of ["false | cat", "false | cat | cat", "true | cat"]) {
    assert.throws(() => includeEmptyCustomHook(list + " || " + pipeline, new Map()), /alternative renderers/);
    assert.equal(includeEmptyCustomHook(primary + " || " + pipeline, new Map()),
      primary + " --include-empty || " + pipeline);
  }
  assert.equal(includeEmptyCustomHook(list + " || false", new Map()), list + " --include-empty || false");
});

test("trailing status pipelines keep the notes renderer", () => {
  const notes = "node notes.mjs";
  for (const suffix of ["; false | cat", " && test -s notes.md | cat"]) {
    assert.equal(includeEmptyCustomHook(notes + suffix, new Map()), notes + " --include-empty" + suffix);
  }
  assert.equal(includeEmptyCustomHook(notes + " | cat", new Map()), notes + " --include-empty | cat");
});

test("a for header is not a notes renderer", () => {
  const notes = "node notes.mjs";
  for (const trailing of ["for turn in first second; do true; done", "for turn; do :; done",
    "for turn in first second; do true; done; test -s notes.md"]) {
    assert.equal(includeEmptyCustomHook(notes + "; " + trailing, new Map()), notes + " --include-empty; " + trailing);
  }
  const writer = "pm-changelog " + standing;
  for (const kind of ["while", "until"]) {
    const loop = kind + " " + writer + "; do true; done";
    assert.equal(includeEmptyCustomHook(includeEmptyReleaseSections(loop), new Map(), true),
      kind + " " + writer + " --include-empty; do true; done");
  }
  const ordinary = 'node notes.mjs "for"';
  assert.equal(includeEmptyCustomHook(ordinary, new Map()), ordinary + " --include-empty");
});

test("existing options on forwarded custom alternatives need no new arguments", () => {
  const scripts = new Map([["fallback", "node fallback.mjs"]]);
  const notes = "node primary.mjs --include-empty || npm run fallback --";
  assert.equal(includeEmptyCustomHook(notes + " --include-empty", scripts), notes + " --include-empty");
  for (const missing of [notes, notes + " -- --include-empty", notes + " --pm-arg --include-empty"]) {
    assert.throws(() => includeEmptyCustomHook(missing, scripts), /alternative renderers/);
  }
  assert.throws(() => includeEmptyCustomHook(notes.replace("fallback", '"$TARGET"') + " --include-empty", scripts),
    /alternative renderers/);
});

test("env passes hyphenated npm lifecycle keys but shell prefixes require identifiers", () => {
  const scripts = { hook: "", prewriter: "pm-changelog " + standing + " --title before", writer: "pm-changelog " + standing };
  const audit = (command: string) => resolveChangelogHooks({ ...scripts, hook: command }, ["hook"], true);
  for (const prefix of ["env npm_config_ignore-scripts=true", "env 'NPM_CONFIG_IGNORE-SCRIPTS=true'", "env -- npm_config_ignore-scripts=true"]) {
    assert.equal(audit(prefix + " npm run writer").get("writer"), scripts.writer);
    assert.equal(audit(prefix + " npm run writer").has("prewriter"), false);
    assert.equal(audit(prefix + " npm --ignore-scripts=false run writer").get("prewriter"), scripts.prewriter);
  }
  assert.equal(audit("env npm_config_ignore-scripts=false npm run writer").get("prewriter"), scripts.prewriter);
  assert.equal(audit("env 'note-label=available' npm run writer").get("prewriter"), scripts.prewriter);
  assert.equal(releaseHookCommand(parseReleaseHook("npm_config_ignore-scripts=true npm run writer").commands[0])?.[0].value,
    "npm_config_ignore-scripts=true");
  assert.throws(() => audit('env "npm_config_ignore-scripts=$MODE" npm run writer'), /ignore-scripts.*prewriter/);
});

test("the selected npm honors a hyphenated lifecycle environment key", t => {
  const root = mkdtempSync(join(tmpdir(), "hyphenated-npm-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { prewriter: "echo before", writer: "echo main" } }));
  writeFileSync(join(root, ".npmrc"), "ignore-scripts=false\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name)));
  Object.assign(env, { NPM_CONFIG_USERCONFIG: join(root, "user.npmrc"), NPM_CONFIG_GLOBALCONFIG: devNull });
  const run = (setting: string) => execFileSync(process.execPath, [npmCli(true), "run", "--silent", "writer"], {
    cwd: root, env: { ...env, "npm_config_ignore-scripts": setting }, encoding: "utf8",
  }).trim().split(/\r?\n/);
  assert.deepEqual(run("true"), ["main"]);
  assert.deepEqual(run("false"), ["before", "main"]);
});

test("the date audit requires a definite nested lifecycle after an earlier command", () => {
  const scripts = { "release:notes": "npm --ignore-scripts=false run relay", writer: "pm-changelog " + standing,
    prewriter: "pm-changelog " + standing, prerelay: "node refresh.mjs", relay: "npm run writer" };
  const inspect = (relay: string, prerelay = scripts.prerelay, configured = "ignore-scripts=true") => auditInvocations([
    { file: "package.json", text: JSON.stringify({ scripts: { ...scripts, relay, prerelay } }) },
    { file: ".npmrc", text: configured },
  ]).failures;
  assert.match(inspect(scripts.relay)[0], /Cannot verify.*nested npm lifecycle.*writer/);
  assert.deepEqual(inspect("npm --ignore-scripts=true run writer"), []);
  assert.deepEqual(inspect(scripts.relay, ""), []);
  assert.deepEqual(inspect(scripts.relay, scripts.prerelay, "ignore-scripts=false"), []);
  const enabled = { ...scripts, "release:notes": "npm run relay" };
  assert.equal(resolveChangelogHooks(enabled, ["release:notes"], true).get("prewriter"), scripts.prewriter);
});

test("GITHUB_ENV writes expand the producer's effective literal environment", () => {
  const use = { run: "npm run changelog:full" };
  const write = { run: 'echo "npm_config_ignore_scripts=$SETTING" >> "$GITHUB_ENV"' };
  const inspect = (job: object, steps: object[], env = {}) => {
    const workflow = { file: ".github/workflows/release.yml", text: stringify({ env, jobs: {
      release: { "runs-on": "ubuntu-latest", ...job, steps: [...steps, use] },
    } }) };
    const pkg = { file: "package.json", text: JSON.stringify({ scripts: {
      "changelog:full": "pm-changelog " + standing, "prechangelog:full": "echo preview > CHANGELOG.md",
    } }) };
    return { policy: npmLifecycle(undefined, executableShellBodies(workflow).at(-1)?.environment), failures: auditInvocations([pkg, workflow]).failures };
  };
  assert.deepEqual(inspect({ env: { SETTING: "true" } }, [write]), { policy: false, failures: [] });
  assert.deepEqual(inspect({}, [write], { SETTING: "true" }), { policy: false, failures: [] });
  assert.deepEqual(inspect({ env: { SETTING: "false" } }, [{ ...write, env: { SETTING: "true" } }]), { policy: false, failures: [] });
  assert.deepEqual(inspect({ env: { SETTING: "false" } }, [{ run: 'echo "SETTING=true" >> "$GITHUB_ENV"' }, write]), { policy: false, failures: [] });
  for (const [job, steps] of [
    [{ env: { SETTING: "${{ inputs.setting }}" } }, [write]],
    [{ env: { SETTING: "true" } }, [{ uses: "./action" }, write]],
    [{ env: { SETTING: "true" } }, [{ if: "inputs.change", run: 'echo "SETTING=false" >> "$GITHUB_ENV"' }, write]],
  ] as const) {
    const result = inspect(job, [...steps]);
    assert.equal(result.policy, "unknown");
    assert.match(result.failures[0], /Cannot determine npm ignore-scripts/);
  }
  for (const name of ["GITHUB_SETTING", "RUNNER_SETTING", "NODE_OPTIONS"]) {
    const store = { run: `echo "${name}=true" >> "$GITHUB_ENV"` };
    const expand = { run: write.run.replace("$SETTING", "$" + name) };
    assert.equal(inspect({}, [store, expand]).policy, "unknown");
  }
  assert.equal(inspect({ env: { SETTING: "false" } }, [write]).policy, true);
});

test("runner exports restore only the names definitely written after an opaque step", () => {
  const opaque = { uses: "actions/checkout@v4" };
  const setting = { run: 'echo "SETTING=true" >> "$GITHUB_ENV"' };
  const copy = { run: 'echo "npm_config_ignore_scripts=$SETTING" >> "$GITHUB_ENV"' };
  const consume = { run: "npm run changelog:full" };
  const pkg = { file: "package.json", text: JSON.stringify({ scripts: {
    "changelog:full": "pm-changelog " + standing, "prechangelog:full": "echo preview > CHANGELOG.md",
  } }) };
  const inspect = (steps: object[]) => {
    const workflow = { file: ".github/workflows/release.yml", text: stringify({
      jobs: { release: { "runs-on": "ubuntu-latest", steps: [...steps, consume] } },
    }) };
    return {
      policy: npmLifecycle(undefined, executableShellBodies(workflow).at(-1)?.environment),
      failures: auditInvocations([pkg, workflow]).failures,
    };
  };
  assert.deepEqual(inspect([opaque, setting, { run: 'echo OTHER=true >> "$GITHUB_ENV"' }, copy]), { policy: false, failures: [] });
  const enabled = inspect([opaque, setting, { ...copy, env: { SETTING: "false" } }]);
  assert.equal(enabled.policy, true);
  assert.deepEqual(enabled.failures, []);
  for (const steps of [[setting, opaque, copy], [opaque, setting, { run: "node helper.js" }, copy],
    [opaque, { ...setting, if: "${{ inputs.write }}" }, copy],
    [opaque, setting, { run: copy.run.replace("$SETTING", "$OTHER") }],
    [opaque, setting, { ...copy, if: "always()" }]]) {
    const observed = inspect(steps);
    assert.equal(observed.policy, "unknown");
    assert.match(observed.failures[0] ?? "", /ignore-scripts.*prechangelog:full/);
  }
});

test("copy backup suffixes are consumed before identifying the last file operand", () => {
  const target = "changelog:full";
  for (const options of ['--suffix "$BACKUP_SUFFIX"', '-S "$BACKUP_SUFFIX"', '-fS "$BACKUP_SUFFIX"',
    '--suffix="$BACKUP_SUFFIX"', "-Sstyle.txt", '-fS"$BACKUP_SUFFIX"']) {
    const hook = (source: string, destination: string) => ({
      [target]: "pm-changelog " + standing,
      ["post" + target]: "cp --backup " + source + " " + destination + " " + options,
    });
    assert.doesNotThrow(() => resolveChangelogHooks(hook("CHANGELOG.md", "preview.md"), [target]), options);
    assert.throws(() => resolveChangelogHooks(hook("preview.md", "CHANGELOG.md"), [target]), /ignore-scripts.*postchangelog:full/, options);
  }
});

test("an OR list preserves alternative custom notes renderers, including through script forwards", () => {
  const ambiguous = ["node preferred.mjs || node fallback.mjs", "node preferred.mjs | cat | sed -n p ||\n node fallback.mjs | cat",
    "true && node preferred.mjs || node fallback.mjs", "if test -f input; then node preferred.mjs || node fallback.mjs; else node last.mjs; fi"];
  for (const hook of ambiguous) {
    assert.throws(() => includeEmptyCustomHook(hook, new Map()), /alternative renderers/, hook);
    assert.throws(() => includeEmptyCustomHook("npm run render", new Map([["render", hook]])), /alternative renderers/, hook);
  }
  for (const [hook, expected] of [
    ["node notes.mjs", "node notes.mjs --include-empty"],
    ["node notes.mjs || true", "node notes.mjs --include-empty || true"],
    ["true || node notes.mjs | cat", "true || node notes.mjs --include-empty | cat"],
    ["node one.mjs || node two.mjs && node notes.mjs", "node one.mjs || node two.mjs && node notes.mjs --include-empty"],
    ['node notes.mjs --title "a || b"', 'node notes.mjs --title "a || b" --include-empty'],
  ]) assert.equal(includeEmptyCustomHook(hook, new Map()), expected);
  const generators = `pm-changelog ${standing} --stdout || node dist/cli.js ${standing} --stdout`;
  assert.equal(includeEmptyCustomHook(generators, new Map(), true), generators);
});

test("continuation independently reloads the npm fallback with only a recorded active setting", t => {
  const root = mkdtempSync(join(tmpdir(), "continued-npm-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  if (process.platform !== "win32") symlinkSync(npmCli(), join(bin, "npm"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name)));
  prependFixturePath(env, bin);
  Object.assign(env, {
    NPM_CONFIG_USERCONFIG: join(root, "user.npmrc"), NPM_CONFIG_GLOBALCONFIG: join(root, "global.npmrc"),
    NPM_PROJECT_PATH: root, CHANGELOG_SCRIPT: "hook", CHANGELOG_CHECK_SCRIPT: "hook", NOTES_SCRIPT: "hook", PREPARED_NPM_LIFECYCLE: "true",
    GIT_AUTHOR_DATE: day + "T12:00:00Z", GIT_COMMITTER_DATE: day + "T12:00:00Z",
  });
  const options = { cwd: root, env, stdio: "pipe" as const };
  execFileSync("git", ["init", "-q"], options);
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--no-gpg-sign", "--allow-empty", "-qm", "Continuation"], options);
  const scripts = {
    hook: "npm --ignore-scripts=true run relay",
    relay: "npm --ignore-scripts=false run bridge",
    bridge: "npm run writer",
    writer: "pm-changelog " + standing,
    prewriter: "pm-changelog --release-version-from-package --date-fallback 2026-11-16",
  };
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "2026.11.17", scripts }));
  const verify = () => execFileSync(process.execPath, [resolve("scripts/release-continuation.ts"), "heading-date"], options);
  writeFileSync(join(root, ".npmrc"), "ignore-scripts=true\n");
  assert.doesNotThrow(verify);
  writeFileSync(join(root, ".npmrc"), "ignore-scripts=false\n");
  assert.throws(verify, /differs from verified merge commit day/);
});

test("environment-file writes reflect redirect quoting and the producer's success condition", t => {
  const root = mkdtempSync(join(tmpdir(), "release env file "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "environment");
  const inspect = (steps: object[], condition?: string) => {
    const source = { file: ".github/workflows/release.yml", text: stringify({ jobs: { release: {
      "runs-on": "ubuntu-latest", steps: [...steps, { run: "npm run changelog:full", if: condition }],
    } } }) };
    const manifest = { file: "package.json", text: JSON.stringify({ scripts: {
      "changelog:full": "pm-changelog " + standing, "prechangelog:full": "echo preview > CHANGELOG.md",
    } }) };
    return { policy: npmLifecycle(undefined, executableShellBodies(source).at(-1)?.environment), failures: auditInvocations([manifest, source]).failures };
  };
  const prior = { run: 'echo npm_config_ignore_scripts=false >> "$GITHUB_ENV"' };
  for (const target of ["$GITHUB_ENV", "${GITHUB_ENV}", '"$GITHUB_ENV"', '"${GITHUB_ENV}"']) {
    const quoted = target.startsWith('"');
    for (const redirect of [">", ">>"]) {
      const run = `echo npm_config_ignore_scripts=false >> "$GITHUB_ENV"\necho npm_config_ignore_scripts=true ${redirect} ${target}\ntrue`;
      if (process.platform !== "win32") {
        writeFileSync(file, "");
        execFileSync("bash", ["-c", run], { env: { ...process.env, GITHUB_ENV: file }, stdio: "pipe" });
        const lines = readFileSync(file, "utf8").trim().split("\n");
        assert.equal(lines.at(-1), "npm_config_ignore_scripts=" + quoted);
      }
      const observed = inspect([prior, { run, shell: "bash {0}" }]);
      if (quoted) assert.deepEqual(observed, { policy: false, failures: [] });
      else {
        assert.equal(observed.policy, "unknown");
        assert.match(observed.failures[0] ?? "", /Cannot determine npm ignore-scripts/);
        const withErrexit = [prior, { run, shell: "bash" }];
        assert.deepEqual(inspect(withErrexit), { policy: false, failures: [] });
        assert.equal(inspect(withErrexit, "always()").policy, "unknown");
      }
    }
  }
  const conditionalErrexit = "if test -f opt-in; then\n  set -e\nfi";
  for (const [setup, destination, enabled] of [
    [conditionalErrexit, "$GITHUB_ENV", false],
    [conditionalErrexit, '"$GITHUB_ENV"', true],
    ["set -e", "$GITHUB_ENV", false],
  ] as const) {
    const run = setup + "\necho npm_config_ignore_scripts=true >> " + destination + "\ntrue";
    if (process.platform !== "win32") {
      writeFileSync(file, "");
      const execute = () => execFileSync("bash", ["-c", run], { cwd: root, env: { ...process.env, GITHUB_ENV: file }, stdio: "pipe" });
      if (setup === "set -e") assert.throws(execute, /ambiguous redirect/);
      else assert.doesNotThrow(execute);
      assert.equal(readFileSync(file, "utf8"), enabled ? "npm_config_ignore_scripts=true\n" : "");
    }
    const observed = inspect([prior, { run, shell: "bash {0}" }]);
    if (setup === conditionalErrexit && !enabled) {
      assert.equal(observed.policy, "unknown");
      assert.match(observed.failures[0] ?? "", /Cannot determine npm ignore-scripts/);
    } else assert.deepEqual(observed, { policy: false, failures: [] });
  }
  const overwrite = {
    shell: "bash {0}",
    run: conditionalErrexit + '\necho OTHER=ready >> $GITHUB_ENV\necho npm_config_ignore_scripts=true >> "$GITHUB_ENV"',
  };
  assert.deepEqual(inspect([prior, overwrite]), { policy: false, failures: [] });
  assert.equal(inspect([prior, overwrite], "always()").policy, "unknown");
  const run = 'echo npm_config_ignore_scripts=true >> "$GITHUB_ENV"';
  for (const condition of [undefined, true, "success()", "${{ SUCCESS ( ) }}"]) {
    assert.deepEqual(inspect([prior, { run, if: condition }]), { policy: false, failures: [] });
  }
  for (const step of [{ if: "${{ success() && inputs.enabled }}" }, { if: "success()", "continue-on-error": true }]) {
    const observed = inspect([prior, { run, ...step }]);
    assert.equal(observed.policy, "unknown");
    assert.match(observed.failures[0] ?? "", /Cannot determine npm ignore-scripts/);
  }
});

/** Keep project configuration tests independent of the parent npm invocation. */
function isolatedNpmConfig(root: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  return { ...env, NPM_CONFIG_USERCONFIG: join(root, "user.npmrc"), NPM_CONFIG_GLOBALCONFIG: devNull };
}

test("repeated npm lifecycle assignments preserve environment entry order", { skip: process.platform === "win32" }, t => {
  const root = mkdtempSync(join(tmpdir(), "release-npm-assignment-order-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const name = "npm_config_ignore_scripts", alias = "npm_config_ignore-scripts";
  const env = isolatedNpmConfig(root);
  const npm = npmCli(true);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { prewriter: "echo before", writer: "echo main" } }));
  for (const [assignments, enabled] of [
    [[`${name}=true`, `${alias}=false`, `${name}=true`], true],
    [[`${name}=false`, `${alias}=true`, `${name}=false`], false],
    [[`${name}=true`, `${name}=false`], true],
    [[`${name}=false`, `${alias}=`, `${name}=true`], false],
    [[`${name}=false`, `${alias}=true`, `${alias}=`], true],
  ] as const) {
    const output = execFileSync("env", [...assignments, process.execPath, npm, "run", "--silent", "writer"], { cwd: root, env, encoding: "utf8" });
    assert.deepEqual(output.trim().split(/\r?\n/), enabled ? ["before", "main"] : ["main"]);
    const scripts = { hook: `env ${assignments.join(" ")} npm run writer`, writer: "pm-changelog " + standing,
      prewriter: "pm-changelog " + standing };
    const resolved = resolveChangelogHooks(scripts, ["hook"], false);
    assert.equal(resolved.has("prewriter"), enabled, scripts.hook);
  }
});

test("the pinned changelog CLI splits a separate equal-sign option passed as pm-arg data", () => {
  const cli = resolve("node_modules/pm-changelog/dist/cli.js");
  for (const [operand, raw, rejected] of [
    ["--pm-arg '--title=example'", ["--pm-arg", "--title=example"], true],
    ["--pm-arg --until=2026-11-16", ["--pm-arg", "--until=2026-11-16"], true],
    ["--pm-arg=--title=example", ["--pm-arg=--title=example"], false],
    ["--pm-arg --output-budget=unbounded", ["--pm-arg", "--output-budget=unbounded"], false],
    ["--pm-arg --title", ["--pm-arg", "--title"], false],
    ["--pm-arg --date-from-version", ["--pm-arg", "--date-from-version"], false],
  ] as const) {
    const run = () => execFileSync(process.execPath, [cli, ...standing.split(" "), ...raw, "--help"], { stdio: "pipe" });
    if (rejected) assert.throws(run, /Unknown option/);
    else assert.doesNotThrow(run);
    for (const generator of ["pm-changelog", "node scripts/pm-changelog.ts"]) {
      const script = `${generator} ${standing} ${operand}`;
      const report = auditInvocations([workflow(script)]).failures;
      if (rejected) {
        assert.match(report[0] ?? "", /--pm-arg.*separate.*=/);
        assert.throws(() => rewriteReleaseHeadingDate(script, day), /--pm-arg.*separate.*=/);
      } else {
        assert.deepEqual(report, []);
        assert.match(rewriteReleaseHeadingDate(script, day), /--date-fallback 2026-11-17/);
      }
    }
  }
});

test("pm-arg requires a value but a caller can forward an option-shaped value", () => {
  const writer = "pm-changelog " + standing + " --pm-arg";
  const hook = "npm run writer -- --title";
  for (const script of [writer, writer + " ''", writer + "=", writer + "=''"]) {
    assert.match(auditInvocations([workflow(script)]).failures[0] ?? "", /--pm-arg requires a value/);
    assert.throws(() => rewriteReleaseHeadingDate(script, day), /--pm-arg requires a value/);
  }
  const inline = writer + "=--title";
  assert.deepEqual(auditInvocations([workflow(inline)]).failures, []);
  assert.equal(rewriteReleaseHeadingDate(inline, day), inline.replace("--date-from-version", "--date-fallback " + day));
  const rewritten = rewriteReleaseHookDates(new Map([["hook", hook], ["writer", writer]]), ["hook"], day);
  assert.equal(rewritten.get("hook"), hook);
  assert.equal(rewritten.get("writer"), writer.replace("--date-from-version", "--date-fallback " + day));
});

test("a final AND-list status check keeps the terminal notes renderer", () => {
  for (const suffix of ["test -s notes.txt", "test -s notes.txt && true", "git diff --quiet", "test -s notes.txt || true"]) {
    const hook = "node setup.mjs; node notes.mjs && " + suffix;
    assert.equal(includeEmptyCustomHook(hook, new Map()), hook.replace("notes.mjs", "notes.mjs --include-empty"));
  }
  for (const hook of [
    "node setup.mjs && node check.mjs; node notes.mjs && test -s notes.txt",
    "node setup.mjs; node notes.mjs | cat && test -s notes.txt",
    "node notes.mjs; true && test -s notes.txt",
  ]) assert.equal(includeEmptyCustomHook(hook, new Map()), hook.replace("notes.mjs", "notes.mjs --include-empty"));
  for (const hook of [
    "node setup.mjs; node preferred.mjs || node fallback.mjs && test -s notes.txt",
    "node setup.mjs; node preferred.mjs && test -s notes.txt || node fallback.mjs",
    "node setup.mjs; node first.mjs && node second.mjs && test -s notes.txt",
  ]) assert.throws(() => includeEmptyCustomHook(hook, new Map()), /single script entry point/);
});

test("preparation rejects npm configuration that selects workspace hooks", t => {
  const root = mkdtempSync(join(tmpdir(), "release-root-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const member = join(root, "member");
  mkdirSync(member);
  const env = { ...isolatedNpmConfig(root), CHANGELOG_SCRIPT: "hook", CHANGELOG_CHECK_SCRIPT: "hook", NOTES_SCRIPT: "hook", RELEASE_HEADING_DATE: day };
  const npm = npmCli(true);
  const manifest = join(root, "package.json");
  const source = JSON.stringify({ name: "root", workspaces: ["member"], scripts: { hook: "echo root" } });
  writeFileSync(join(member, "package.json"), JSON.stringify({ name: "member", scripts: { hook: "echo member" } }));
  for (const [config, override, expected] of [
    ["workspace=member", {}, "member"], ["workspaces=true", {}, "member"], ["", { npm_config_workspace: "member" }, "member"],
    ["workspace=member\nworkspaces=false", {}, /Cannot use.*at the same time/], ["workspace=", {}, /No workspaces found/],
    ["workspaces=false", {}, "root"], ["include-workspace-root=true", {}, "root"], ["", {}, "root"],
  ] as const) {
    writeFileSync(manifest, source);
    writeFileSync(join(root, ".npmrc"), config + "\nignore-scripts=true\n");
    const options = { cwd: root, env: { ...env, ...override }, encoding: "utf8" as const, stdio: "pipe" as const };
    const output = join(root, "outputs");
    writeFileSync(output, "");
    const run = () => execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts"), output], options);
    const npmRun = () => execFileSync(process.execPath, [npm, "run", "hook"], options).trim().split(/\r?\n/).at(-1);
    if (expected instanceof RegExp) assert.throws(npmRun, expected);
    else assert.equal(npmRun(), expected, config);
    if (expected !== "root") {
      assert.throws(run, /npm workspace selectors/);
      assert.equal(readFileSync(manifest, "utf8"), source);
      assert.equal(readFileSync(output, "utf8"), "");
    } else {
      assert.doesNotThrow(run);
      assert.match(readFileSync(manifest, "utf8"), /echo root --include-empty/);
    }
  }
});

test("implicit member selection rejects root inclusion while allowing a member-only run", t => {
  const root = mkdtempSync(join(tmpdir(), "release-implicit-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const member = join(root, "member");
  mkdirSync(member);
  const manifest = join(member, "package.json");
  const source = JSON.stringify({ name: "member", scripts: { hook: "echo member" } });
  writeFileSync(manifest, source);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["member"], scripts: { hook: "echo root" } }));
  const env = { ...isolatedNpmConfig(root), CHANGELOG_SCRIPT: "hook", CHANGELOG_CHECK_SCRIPT: "hook", NOTES_SCRIPT: "hook" };
  const options = { cwd: member, env, encoding: "utf8" as const, stdio: "pipe" as const };
  const run = () => execFileSync(process.execPath, [resolve("scripts/prepare-release-changelog.ts")], options);
  const npm = () => execFileSync(process.execPath, [npmCli(true), "run", "--silent", "hook"], options).trim().split(/\r?\n/);
  writeFileSync(join(root, ".npmrc"), "include-workspace-root=true\nignore-scripts=true\n");
  assert.deepEqual(npm(), ["root", "member"]);
  assert.throws(run, /npm workspace selectors/);
  assert.equal(readFileSync(manifest, "utf8"), source);
  writeFileSync(join(root, ".npmrc"), "include-workspace-root=false\nignore-scripts=true\n");
  assert.deepEqual(npm(), ["member"]);
  assert.doesNotThrow(run);
  assert.deepEqual(npm(), ["member --include-empty"]);
});

test("preparation uses npm's parsed lifecycle boolean for one environment spelling", t => {
  const root = mkdtempSync(join(tmpdir(), "release-npm-parsed-boolean-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = join(root, "package.json");
  const scripts = { hook: "echo main", posthook: "cp draft.md CHANGELOG.md" };
  writeFileSync(manifest, JSON.stringify({ name: "fixture", scripts }));
  writeFileSync(join(root, "draft.md"), "post-hook output");
  const env = { ...isolatedNpmConfig(root), CHANGELOG_SCRIPT: "hook", CHANGELOG_CHECK_SCRIPT: "hook", NOTES_SCRIPT: "hook" };
  const output = join(root, "outputs");
  const prepare = [resolve("scripts/prepare-release-changelog.ts"), output];
  for (const [value, lifecycle] of [[" true ", false], [" false ", true]] as const) {
    const options = { cwd: root, env: { ...env, npm_config_ignore_scripts: value }, encoding: "utf8" as const };
    writeFileSync(output, "");
    assert.equal(execFileSync(process.execPath, [npmCli(true), "config", "get", "ignore-scripts"], options).trim(), String(!lifecycle));
    execFileSync(process.execPath, prepare, options);
    assert.equal(readFileSync(output, "utf8"), "npm_lifecycle=" + lifecycle + "\nnpm_lifecycle_configured=unknown\n");
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).scripts.posthook, scripts.posthook);
  }
  const invalid = { cwd: root, env: { ...env, npm_config_ignore_scripts: "ambiguous" }, encoding: "utf8" as const };
  const prepared = readFileSync(manifest, "utf8");
  writeFileSync(output, "");
  assert.throws(() => execFileSync(process.execPath, prepare, invalid), /ignore-scripts.*posthook/);
  assert.equal(readFileSync(output, "utf8"), "");
  assert.equal(readFileSync(manifest, "utf8"), prepared);
});


test("Round GI forwarded writes can reach another branch on a later loop iteration", () => {
  const entry = ["changelog:full"];
  const writer = "pm-changelog " + standing;
  const choose = "if test -f marker; then npm run emit; else npm run execute; fi";
  const reason = /generated release hook file "generate\.sh"/;
  const inspect = (forward: string, accepted: boolean, branch = choose) => {
    const scripts = new Map(Object.entries({
      "changelog:full": forward + "; " + writer,
      relay: "npm run choose",
      choose: branch,
      emit: "printf '%s\\n' 'pm-changelog " + standing + "' >generate.sh; rm marker",
      execute: "sh generate.sh",
    }));
    const checks = [
      () => resolveChangelogHooks(Object.fromEntries(scripts), entry, true),
      () => rewriteReleaseHookDates(scripts, entry, day, true),
      () => assertReleaseHookHeadingDate(scripts, entry, day, "2026.11.17", true),
    ];
    for (const check of checks) {
      if (accepted) assert.doesNotThrow(check);
      else assert.throws(check, reason);
    }
    const manifest = { file: "package.json", text: JSON.stringify({ scripts: Object.fromEntries(scripts) }) };
    const failures = auditInvocations([manifest]).failures;
    if (accepted) assert.deepEqual(failures, []);
    else assert.match(failures[0] ?? "", reason);
  };
  inspect("npm run relay", true);
  inspect("for turn in first second; do true; done; npm run relay", true);
  inspect("for turn in first second; do npm run relay; done", false);
  const reversed = "if test -f marker; then npm run execute; else npm run emit; fi";
  inspect("npm run relay", true, reversed);
  inspect("for turn in first second; do npm run relay; done", false, reversed);
  inspect("while npm run relay; do true; done", false);
});

test("Round GI standalone preparation separates alternatives and checks their joined writes", () => {
  const conditional = "if test -f marker; then printf preview >preview.sh; else sh preview.sh; fi";
  const writer = "pm-changelog " + standing;
  const safe = conditional + "; " + writer;
  assert.equal(includeEmptyReleaseSections(safe), safe + " --include-empty");
  assert.doesNotThrow(() => rewriteReleaseHeadingDate(safe, day));
  assert.doesNotThrow(() => assertReleaseHeadingDate([safe], day, "2026.11.17"));
  const joined = conditional + "; sh preview.sh; " + writer;
  const recurring = "for turn in first second; do " + conditional + "; done; " + writer;
  for (const source of [joined, recurring]) {
    const reason = /generated release hook file "preview\.sh"/;
    assert.throws(() => includeEmptyReleaseSections(source), reason);
    assert.throws(() => rewriteReleaseHeadingDate(source, day), reason);
    assert.throws(() => assertReleaseHeadingDate([source], day, "2026.11.17"), reason);
  }
});

test("Round GI uncertain lifecycle accounts for unquoted brace-expanded redirects", () => {
  const hook = "pm-changelog " + standing;
  for (const destination of [" > CHANGELOG.m{d..d}", ">./CHANGELOG.m{d..d}"]) {
    assert.throws(() => resolveChangelogHooks({ hook, posthook: "printf heading " + destination }, ["hook"]),
      /ignore-scripts.*posthook/, destination);
  }
  for (const destination of [" > 'CHANGELOG.m{d..d}'", '> "./CHANGELOG.m{d..d}"', " > CHANGELOG.m\\{d..d\\}"]) {
    assert.ok(resolveChangelogHooks({ hook, posthook: "printf heading " + destination }, ["hook"]).has("posthook"), destination);
  }
  assert.throws(() => resolveChangelogHooks({ hook, posthook: 'printf heading > "previews/$SUBDIR/../CHANGELOG.md"' }, ["hook"]),
    error => /ignore-scripts/.test(String(error)) && !/traversal/.test(String(error)));
});

test("Round GI runner OS controls case-equivalent lifecycle environment precedence", () => {
  const manifest = { file: "package.json", text: JSON.stringify({ scripts: {
    "changelog:full": "pm-changelog " + standing, "prechangelog:full": "printf heading >CHANGELOG.md",
  } }) };
  const source = (runner: string | string[], value: string) => ({ file: ".github/workflows/case.yml", text: stringify({
    env: { NpM_CoNfIg_IgNoRe_ScRiPtS: "false" },
    jobs: { release: {
      "runs-on": runner, env: { npm_config_ignore_scripts: "false" },
      steps: [{ env: { NPM_CONFIG_IGNORE_SCRIPTS: value }, run: "npm run changelog:full" }],
    } },
  }) });
  for (const runner of ["windows-latest", ["self-hosted", "Windows", "X64"]]) {
    const one = source(runner, "true");
    assert.deepEqual(auditInvocations([manifest, one]).failures, []);
    assert.equal(npmLifecycle(undefined, executableShellBodies(source(runner, "false"))[0].environment), true);
  }
  assert.match(auditInvocations([manifest, source("ubuntu-latest", "true")]).failures[0] ?? "", /ignore-scripts.*prechangelog:full/);
  const exported = { file: ".github/workflows/exported.yml", text: stringify({ jobs: { release: {
    "runs-on": "windows-latest", env: { NPM_CONFIG_IGNORE_SCRIPTS: "false" },
    steps: [
      { shell: "bash", run: 'echo NPM_CONFIG_IGNORE_SCRIPTS=false >> "$GITHUB_ENV"\necho npm_config_ignore_scripts=true >> "$GITHUB_ENV"' },
      { run: "npm run changelog:full" },
      { env: { NPM_CONFIG_IGNORE_SCRIPTS: "false" }, run: "npm run changelog:full" },
    ],
  } } }) };
  assert.deepEqual(executableShellBodies(exported).map(body => npmLifecycle(undefined, body.environment)), [true, false, true]);
  const indirect = (variable: string) => ({ file: ".github/workflows/indirect.yml", text: stringify({ jobs: { release: {
    "runs-on": "windows-latest",
    steps: [
      { shell: "bash", run: 'echo SETTING=true >> "$GITHUB_ENV"' },
      { shell: "bash", run: 'echo "npm_config_ignore_scripts=$' + variable + '" >> "$GITHUB_ENV"' },
      { run: "npm run changelog:full" },
    ],
  } } }) });
  assert.deepEqual(auditInvocations([manifest, indirect("SETTING")]).failures, []);
  assert.match(auditInvocations([manifest, indirect("setting")]).failures[0] ?? "", /ignore-scripts.*prechangelog:full/);
});

test("Round GI ordinary inherited argv stays valid with literal release policy", () => {
  const hook = "TITLE=Release npm run writer";
  const inspect = (writer: string) => {
    const scripts = { "changelog:full": hook, writer };
    const entry = ["changelog:full"];
    const resolved = resolveChangelogHooks(scripts, entry, true);
    const prepared = rewriteReleaseHookDates(resolved, entry, day, true);
    assertReleaseHookHeadingDate(prepared, entry, day, "2026.11.17", true);
    assert.deepEqual(auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts }) }]).failures, []);
  };
  const writer = "pm-changelog " + standing;
  assert.doesNotThrow(() => inspect(writer + ' --title "$TITLE" --item-url-base "$TITLE"'));
  for (const selected of ['node "$TITLE" ' + standing, writer.replace("--date-from-version", '--date-fallback "$TITLE"'),
    writer + ' --all-release-tags --until="$TITLE"']) {
    assert.throws(() => inspect(selected), /binding through variable assignment TITLE/i);
  }
});

test("Round GI wrapped false keeps the successful renderer requirement", () => {
  const hook = "node primary.mjs && test -f use-secondary && node secondary.mjs";
  for (const status of ["false", "command false", "command -- false"]) {
    assert.equal(includeEmptyCustomHook(hook + " || " + status, new Map()), hook + " --include-empty || " + status);
  }
  for (const status of ["true", "command true"]) {
    assert.throws(() => includeEmptyCustomHook(hook + " || " + status, new Map()), /alternative renderers/);
  }
});

test("Round GI custom notes refuse a later renderer after shell replacement", () => {
  for (const prefix of ["exec", "command exec", "command -- exec", "command -p exec", "exec -a notes"]) {
    const hook = prefix + " node notes.mjs; node cleanup.mjs";
    assert.throws(() => includeEmptyCustomHook(hook, new Map()), /exec replaces the shell/);
    assert.throws(() => includeEmptyCustomHook("npm run render", new Map([["render", hook]])), /exec replaces the shell/);
    assert.equal(includeEmptyCustomHook(prefix + " node notes.mjs", new Map()), prefix + " node notes.mjs --include-empty");
  }
  for (const hook of ["node setup.mjs; node notes.mjs", "exec >notes.log; node notes.mjs"]) {
    assert.equal(includeEmptyCustomHook(hook, new Map()), hook + " --include-empty");
  }
  const piped = "exec node setup.mjs | cat; node notes.mjs";
  assert.equal(includeEmptyCustomHook(piped, new Map()), piped + " --include-empty");
  const generator = "exec pm-changelog " + standing + " --stdout";
  const prepare = (body: string) => includeEmptyCustomHook(includeEmptyReleaseSections(body), new Map(), true);
  const exclusive = "if test -f marker; then " + generator + "; else " + generator + "; fi";
  assert.equal(prepare(exclusive), exclusive.replaceAll(generator, generator + " --include-empty"));
  assert.throws(() => prepare(exclusive.replace("; else", "; node cleanup.mjs; else")), /exec replaces the shell/);
  assert.throws(() => prepare(exclusive + "; node cleanup.mjs"), /exec replaces the shell/);
});

test("a definite lifecycle export supersedes an earlier opaque action", () => {
  const exportTrue = { run: 'echo "npm_config_ignore_scripts=true" >> "$GITHUB_ENV"' };
  const action = { uses: "./example" };
  const consume = { run: "npm run hook" };
  const manifest = { file: "package.json", text: JSON.stringify({ scripts: {
    hook: "pm-changelog " + standing,
    prehook: "pm-changelog " + standing,
  } }) };
  const observe = (steps: object[]) => ({
    file: ".github/workflows/env.yml", text: stringify({ jobs: { release: {
      "runs-on": "ubuntu-latest", steps,
    } } }),
  });
  const definite = observe([action, exportTrue, consume]);
  assert.equal(npmLifecycle(undefined, executableShellBodies(definite).at(-1)!.environment), false);
  assert.deepEqual(auditInvocations([manifest, definite]).failures, []);
  const enable = observe([action, { run: exportTrue.run.replace("=true", "=false") }, consume]);
  assert.equal(npmLifecycle(undefined, executableShellBodies(enable).at(-1)!.environment), true);
  for (const steps of [[exportTrue, action, consume], [action, { ...exportTrue, if: "${{ inputs.write }}" }, consume],
    [action, { run: 'echo OTHER=true >> "$GITHUB_ENV"' }, consume], [action, exportTrue, { ...consume, if: "always()" }]]) {
    const source = observe(steps);
    assert.equal(npmLifecycle(undefined, executableShellBodies(source).at(-1)!.environment), "unknown");
    assert.match(auditInvocations([manifest, source]).failures[0] ?? "", /ignore-scripts.*prehook/);
  }
});

test("Bash declarations of lifecycle variables cannot hide implicit npm writers", () => {
  const writer = "pm-changelog " + standing;
  const audit = (declaration: string, main = writer) => auditInvocations([
    { file: "package.json", text: JSON.stringify({ scripts: { forward: declaration + "; npm run writer", writer: main, prewriter: writer } }) },
    { file: ".npmrc", text: "ignore-scripts=true" },
  ]).failures;
  for (const declaration of ["declare -x npm_config_ignore_scripts=false", "builtin typeset -x npm_config_ignore_scripts=false",
    "readonly npm_config_ignore_scripts=false", "declare -x NPM_CONFIG_IGNORE_SCRIPTS"]) {
    assert.match(audit(declaration)[0] ?? "", /context change .*npm_config_ignore_scripts/i, declaration);
  }
  assert.match(audit("declare -x npm_config_ignore_scripts=false", "echo done")[0] ?? "", /context change declare npm_config_ignore_scripts/);
  for (const declaration of ["declare -x TITLE=Release", "declare -p npm_config_ignore_scripts", "echo declare -x npm_config_ignore_scripts=false"]) {
    assert.deepEqual(audit(declaration), [], declaration);
  }
});

test("loop conditions preserve the renderer that can run before a zero-iteration body", t => {
  const root = mkdtempSync(join(tmpdir(), "release-loop-renderer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "fallback.mjs"), 'console.log("fallback");');
  writeFileSync(join(root, "notes.mjs"), 'import { unlinkSync } from "node:fs"; unlinkSync("marker"); console.log("notes");');
  for (const condition of ["while test -f marker", "until test ! -f marker"]) {
    const hook = "node fallback.mjs; " + condition + "; do node notes.mjs --include-empty; done";
    assert.throws(() => includeEmptyCustomHook(hook, new Map()), /alternative renderers/);
    if (process.platform !== "win32") {
      assert.equal(execFileSync("bash", ["-ec", hook], { cwd: root, encoding: "utf8" }), "fallback\n");
      writeFileSync(join(root, "marker"), "");
      assert.equal(execFileSync("bash", ["-ec", hook], { cwd: root, encoding: "utf8" }), "fallback\nnotes\n");
    }
    const after = hook + "; node final.mjs";
    assert.equal(includeEmptyCustomHook(after, new Map()), after + " --include-empty");
    const generator = "pm-changelog " + standing;
    const known = generator + "; " + condition + "; do " + generator + "; test ! -f marker; done";
    assert.equal(includeEmptyCustomHook(includeEmptyReleaseSections(known), new Map(), true),
      known.replaceAll(generator, generator + " --include-empty"));
  }
  const sequential = "node fallback.mjs; node notes.mjs";
  assert.equal(includeEmptyCustomHook(sequential, new Map()), sequential + " --include-empty");
});

test("terminal exit keeps its argv and refuses a later reachable renderer candidate", () => {
  for (const exit of ["exit 0", "command -- exit 0", "builtin exit 0"]) {
    assert.equal(includeEmptyCustomHook("node notes.mjs; " + exit, new Map()), "node notes.mjs --include-empty; " + exit);
    assert.throws(() => includeEmptyCustomHook(exit + "; node notes.mjs", new Map()), /exit terminates the shell/);
    assert.throws(() => includeEmptyCustomHook("if test -f marker; then " + exit + "; fi; node notes.mjs", new Map()),
      /exit terminates the shell/);
  }
  assert.equal(includeEmptyCustomHook("node notes.mjs exit 0", new Map()), "node notes.mjs exit 0 --include-empty");
  const setup = './setup-"$PROFILE".sh; node notes.mjs';
  assert.equal(includeEmptyCustomHook(setup, new Map()), setup + " --include-empty");
  assert.equal(includeEmptyCustomHook("node old.mjs; node notes.mjs; exit 0", new Map()), "node old.mjs; node notes.mjs --include-empty; exit 0");
  assert.throws(() => includeEmptyCustomHook("node notes.mjs; (exit 0)", new Map()), /renderer inside shell grouping/);
  assert.equal(includeEmptyCustomHook("(exit 0); node notes.mjs", new Map()), "(exit 0); node notes.mjs --include-empty");
  assert.equal(includeEmptyCustomHook("npm run render", new Map([["render", "pm-changelog --stdout --include-empty; exit 0"]]), true),
    "npm run render");
  assert.throws(() => includeEmptyCustomHook("npm run render", new Map([["render", "node notes.mjs; exit 0"]])),
    /cannot receive forwarded arguments/);
});

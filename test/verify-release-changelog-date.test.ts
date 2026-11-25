/**
 * Executes the changelog-date verifier's rules against fixtures.
 *
 * The verifier's own repository satisfies its rules, so running it here would
 * only prove that today's tree is fine. What these cases prove is that each
 * rule still FAILS on the defect it exists to catch -- including the two shapes
 * that defeated the previous line-oriented implementation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  DATE_FLAG,
  VERSION_INPUTS,
  auditHeadings,
  auditInvocations,
  stripComment,
  invocationsIn,
  generateHeading,
  isRealCalendarDay,
  main,
  runIfMain,
  report,
  resolveGenerator,
  verify,
} from "../scripts/verify-release-changelog-date.ts";
import { joinContinuations } from "../scripts/shell-command-scan.ts";

const FLAGGED = `pm-changelog --pm-root .agents/pm --release-version-from-package ${DATE_FLAG}`;

/** Encode actual script values so tests exercise the manifest boundary. */
function manifest(command: string): string {
  return JSON.stringify({ scripts: { changelog: command } });
}

/** Embed shell in a real GitHub Actions literal scalar, including physical newlines. */
function workflowRun(command: string): string {
  return "jobs:\n  release:\n    steps:\n      - name: Check pm-changelog\n        run: |\n"
    + command.split("\n").map(line => "          " + line).join("\n");
}

test("every version-input spelling is recognised, because pm-changelog accepts all three", () => {
  for (const input of VERSION_INPUTS) {
    const found = invocationsIn({ file: "package.json", text: manifest(`pm-changelog ${input} v2026.1.2`) });
    assert.equal(found.length, 1, `${input} must be recognised as a version input`);
  }
});

test("only generator commands with a version input are audited", () => {
  const command = [
    "GENERATOR=pm-changelog",
    "pm-changelog --stdout",
    "echo pm-changelog --version",
    "pm-changelog --version=v2026.11.16 --date-fallback 2026-11-16",
  ].join("\n");
  const source = { file: "package.json", text: manifest(command) };
  assert.equal(invocationsIn(source).length, 1);
  assert.deepEqual(auditInvocations([source]).failures, []);
});

test("an invocation naming the pending tag is caught, not skipped", () => {
  // An unresolved release coordinate must produce a refusal before a PR is prepared.
  const result = auditInvocations([{
    file: ".github/workflows/release.yml",
    text: workflowRun('pm-changelog --pm-root .agents/pm --all-release-tags --version "$RELEASE_TAG" --mode replace'),
  }]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /Unresolved --version operand.*--release-version-from-package/);
});

test("a resumed release's pinned --date-fallback day is accepted, and only with an explicit day", () => {
  const pinned = "pm-changelog --pm-root .agents/pm --release-version-from-package --date-fallback 2026-11-16";
  const result = auditInvocations([{ file: "package.json", text: manifest(pinned) }]);
  assert.deepEqual(result.failures, []);
  assert.match(result.notes[0]!, /a release date policy \(.*--date-from-version or a pinned --date-fallback day\)/);
  // The resumed spelling the release commit writes is quoted the same way in
  // every script, but the scan must not let the flag through without a day:
  // that is the clock again, just spelled differently.
  for (const invalid of ["--date-fallback", "--date-fallback=", "--date-fallback 16-11-2026", "--date-fallback=2026-11-16T12:00:00Z"]) {
    const failed = auditInvocations([{ file: "package.json", text: manifest(`pm-changelog --release-version-from-package ${invalid}`) }]);
    assert.equal(failed.failures.length, 1, `${invalid} must be rejected`);
  }
});

test("date-fallback text inside another shell argument cannot supply the pin", () => {
  for (const value of [
    "https://example.test/--date-fallback=2026-11-16",
    '"https://example.test/ --date-fallback=2026-11-16"',
    '"https://example.test/; --date-fallback=2026-11-16"',
  ]) {
    const command = `pm-changelog --release-version-from-package --item-url-base ${value}`;
    const result = auditInvocations([{ file: "package.json", text: manifest(command) }]);
    assert.equal(result.failures.length, 1, value);
    assert.match(result.failures[0], /neither --date-from-version nor a pinned --date-fallback/);
  }
});

test("every date-fallback option must pin a real day", () => {
  const command = "pm-changelog --release-version-from-package --date-fallback 2026-11-16";
  const audit = (suffix: string) => auditInvocations([{ file: "package.json", text: manifest(`${command} ${suffix}`) }]);
  for (const suffix of ["--date-fallback", "--date-fallback= --date-from-version", '--date-fallback "$RELEASE_DAY"']) {
    const result = audit(suffix);
    assert.equal(result.failures.length, 1, suffix);
  }
  assert.match(audit("--date-fallback=2026-02-30").failures[0], /does not exist on the calendar/);
  assert.deepEqual(audit(`"--date-fallback" '2026-11-17' --date-fallback="2026-11-18"`).failures, []);
});

test("the date policy belongs to the command that runs the generator", () => {
  for (const launcher of [
    "npx pm-changelog", "npx --yes pm-changelog@2026.11.6", "npm exec -- pm-changelog@2026.11.6", "bun x pm-changelog",
    "bunx pm-changelog@latest", "./dist/cli.js", "node --enable-source-maps dist/cli.js",
  ]) {
    const command = `${launcher} --version=v2026.11.16 --item-url-base 'https://example.test/a;b'`;
    const audit = (suffix: string) => auditInvocations([{ file: "package.json", text: manifest(`${command} ${suffix}`) }]);
    assert.equal(audit("&& echo --date-fallback=2026-11-16").failures.length, 1, launcher);
    assert.deepEqual(audit('--date-fallback="2026-11-16"').failures, [], launcher);
  }
});

test("the verifier audits changelog hooks behind supported wrappers", () => {
  for (const wrapper of [
    "timeout 60", "timeout --signal=KILL 5m", 'timeout "--signal" TERM 60', "timeout --signal KILL 5m", "nice -n 5",
    'timeout -- "$LIMIT"', "env TZ=UTC", 'env "TZ=UTC"', "command", "exec", "exec -a alias",
    "stdbuf -oL", "npx", "bunx", "npm exec --", "time",
    "time timeout 1.5s nice -n 5 env TZ=UTC npm exec --",
  ]) {
    const text = `${wrapper} pm-changelog --release-version-from-package`;
    const audit = (command: string) => auditInvocations([{ file: "package.json", text: manifest(command) }]);
    assert.deepEqual(audit(`${text} ${DATE_FLAG}`).failures, [], wrapper);
    assert.match(audit(`${FLAGGED}\n${text}`).failures[0] ?? "", /carries a version input but neither/);
  }
});

test("workflow step labels and printf arguments are data", () => {
  const text = workflowRun('printf "%s" pm-changelog\n' + FLAGGED);
  const result = auditInvocations([{ file: ".github/workflows/release.yml", text }]);
  assert.deepEqual(result.failures, []);
  assert.equal(result.notes.length, 1);
});

test("the verifier names an unrecognized wrapper even when another hook is valid", () => {
  for (const command of [
    `custom-wrapper ./node_modules/.bin/pm-changelog --version 2026.11.16 ${DATE_FLAG}`,
    `timeout 60 custom-wrapper 'pm-changelog --version 2026.11.16 ${DATE_FLAG}'`,
  ]) {
    const result = auditInvocations([{ file: "package.json", text: manifest(`${FLAGGED}\n${command}`) }]);
    assert.equal(result.failures.length, 1, command);
    assert.match(result.failures[0], /unrecognized wrapper.*custom-wrapper.*pm-changelog/i);
  }
});

test("the verifier refuses unresolved option words even with a literal date policy", () => {
  for (const flag of ['--date-fallback$(printf x) 2026-11-16', '--date-fallback=2026-11-16$(printf x)',
    '--date-from-version$(printf x)', '--date-from-version="$VALUE"', '--other$(printf x)',
    '--item-url-base$(printf x)="$ITEM_URL_BASE"', '--item-url-base="$@"', '--item-url-base=$ITEM_URL_BASE']) {
    const result = auditInvocations([{ file: "package.json", text: manifest(`${FLAGGED} ${flag}`) }]);
    assert.equal(result.failures.length, 1, flag);
    assert.match(result.failures[0], /unresolved option word/i);
  }
});

test("an unresolved version option name cannot bypass the date audit", () => {
  const audit = (command: string) => auditInvocations([{ file: "package.json", text: manifest(command + "; " + FLAGGED) }]);
  for (const name of ['--release-$SELECTOR=2026.11.16', '--ver${SUFFIX} 2026.11.16', '--release-$(printf version)=2026.11.16']) {
    assert.match(audit(`pm-changelog ${name}`).failures[0] ?? "", /unresolved option.*--(?:release-|ver).*--date-from-version.*--date-fallback <YYYY-MM-DD>/i);
  }
  for (const command of ['pm-changelog --title "$TITLE"', 'pm-changelog --release-version=2026.11.16 --date-from-version --title "$TITLE"',
    'echo --release-$SELECTOR=2026.11.16']) {
    assert.deepEqual(audit(command).failures, [], command);
  }
});

test("package administration and quoted values on fixed non-date options are accepted", () => {
  const text = [
    'npm install --save-dev pm-changelog',
    'pnpm add --save-dev pm-changelog',
    'yarn add --dev pm-changelog',
    'bun add --dev pm-changelog',
    `${FLAGGED} --item-url-base="$ITEM_URL_BASE" && npm`,
  ].join("\n");
  assert.deepEqual(auditInvocations([{ file: "package.json", text: manifest(text) }]).failures, []);
  for (const command of ['npm$(printf x) install pm-changelog', 'npm install$(printf x) pm-changelog', 'npm run pm-changelog']) {
    assert.match(auditInvocations([{ file: "package.json", text: manifest(`${FLAGGED}\n${command}`) }]).failures[0],
      /unrecognized wrapper|substitution/i);
  }
});

test("the date verifier audits a declared generator script and refuses ambiguous forwards", () => {
  const manifest = (check: string, generator: string) => ({
    file: "package.json",
    text: JSON.stringify({ scripts: { check, "pm-changelog": generator, blank: " ", ignored: 1 } }),
  });
  assert.deepEqual(auditInvocations([manifest('npm run --silent "pm-changelog" -- --check', FLAGGED)]).failures, []);
  assert.deepEqual(auditInvocations([manifest("bun run pm-changelog", FLAGGED)]).failures, []);
  assert.equal(auditInvocations([manifest("bun --if-present run pm-changelog", "pm-changelog --release-version-from-package")]).failures.length, 1);
  for (const command of ["bun run ./scripts/pm-changelog.ts", "bun run pm-changelog"]) {
    assert.deepEqual(auditInvocations([manifest(`${command} --release-version-from-package --date-from-version`, "")]).failures, []);
  }
  assert.deepEqual(auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts: {
    check: `npm --if-present run pm-changelog && ${FLAGGED}`,
  } }) }]).failures, []);
  assert.equal(auditInvocations([manifest("npm run && pm-changelog", FLAGGED)]).failures.length, 0);
  assert.match(auditInvocations([manifest('npm run "pm-changelog-$TARGET"', FLAGGED)]).failures[0], /unrecognized wrapper/i);
  assert.match(auditInvocations([manifest("npm run pm-changelog", " ")]).failures[0], /unrecognized wrapper/i);
  assert.equal(auditInvocations([manifest("npm run pm-changelog", "pm-changelog --release-version-from-package")]).failures.length, 1);
});

test("Round GS audits reusable release hooks with both project and preview lifecycle settings", () => {
  const audit = (project: boolean, preview: boolean, prehook = "cd docs; npm run nested-only", name = "render", caller = true) =>
    auditInvocations([
      { file: "package.json", text: JSON.stringify({ scripts: { [name]: FLAGGED, ["pre" + name]: prehook } }) },
      { file: ".npmrc", text: "ignore-scripts=" + project },
      { file: ".github/workflows/preview.yml", text: workflowRun("npm --ignore-scripts=" + preview + " run " + name) },
      ...(caller ? [{ file: ".github/workflows/release.yml", text: [
        "jobs:",
        "  release:",
        "    uses: owner/package/.github/workflows/daily-release.yml@main",
        ...(name === "changelog:full" ? [] : ["    with:", "      changelog-script: " + name]),
      ].join("\n") }] : []),
    ]).failures;
  for (const name of ["render", "changelog:full"]) {
    assert.match(audit(false, true, undefined, name)[0] ?? "", /pre.*context change.*cd/);
    assert.match(audit(true, false, undefined, name)[0] ?? "", /pre.*context change.*cd/);
    assert.deepEqual(audit(true, true, undefined, name), []);
    assert.deepEqual(audit(false, true, FLAGGED, name), []);
  }
  assert.deepEqual(audit(false, true, undefined, "changelog:full", false), []);
});

test("configured release hooks are audited when called without another script's arguments", () => {
  const source = (name: string, policy = "") => ({ file: "package.json", text: JSON.stringify({ scripts: {
    preview: `npm run ${name} -- --date-from-version`,
    [name]: "pm-changelog --release-version-from-package" + policy,
  } }) });
  assert.match(auditInvocations([source("changelog:full")]).failures[0], /neither --date-from-version/);
  assert.deepEqual(auditInvocations([source("render")]).failures, []);
  const caller = { file: ".github/workflows/release.yml", text: [
    "jobs:",
    "  release:",
    "    uses: owner/package/.github/workflows/daily-release.yml@main",
    "    with:",
    "      changelog-script: render",
  ].join("\n") };
  for (const project of [undefined, ".", "././", ".//", ".//.///", "${{ inputs.project }}", "./${{ inputs.project }}",
    "${{ inputs.project }}/", "${{ inputs.project || '.' }}"]) {
    const text = project === undefined ? caller.text : caller.text + "\n      npm-project-dir: " + project;
    assert.match(auditInvocations([source("render"), { ...caller, text }]).failures[0], /neither --date-from-version/);
    assert.deepEqual(auditInvocations([source("render", " --date-from-version"), { ...caller, text }]).failures, []);
  }
  for (const rust of ["true", "false", "${{ inputs.rust }}"]) {
    const failures = auditInvocations([source("render"), { ...caller, text: caller.text + "\n      rust: " + rust }]).failures;
    if (rust === "true") assert.deepEqual(failures, []);
    else assert.match(failures[0] ?? "", /neither --date-from-version/);
  }
  for (const [condition, checked] of [["false", false], ["true", true], ["${{ inputs.release }}", true]] as const) {
    const text = caller.text.replace("  release:\n", "  release:\n    if: " + condition + "\n");
    const failures = auditInvocations([source("render"), { ...caller, text }]).failures;
    if (checked) assert.match(failures[0] ?? "", /neither --date-from-version/);
    else assert.deepEqual(failures, []);
  }
  for (const project of ["docs", ".//docs", "/", "tools/${{ inputs.package }}", "./tools/${{ inputs.package }}", "tools-${{ inputs.package }}",
    "${{ inputs.namespace }}/tools", "./${{ inputs.namespace }}/tools-${{ inputs.package }}"]) {
    assert.deepEqual(auditInvocations([source("render"), { ...caller, text: caller.text + "\n      npm-project-dir: " + project }]).failures, []);
  }
});

test("a direct workflow generator accepts repeated current-directory separators", () => {
  for (const directory of [".//", ".//.///", "docs", "/"]) {
    const workflow = { file: ".github/workflows/release.yml", text: `jobs:
  release:
    steps:
      - working-directory: ${directory}
        run: ${FLAGGED}
` };
    const failures = auditInvocations([workflow]).failures;
    if (directory.startsWith(".")) assert.deepEqual(failures, []);
    else assert.match(failures[0] ?? "", /working-directory/);
  }
});

test("directory changes are refused on release hook paths and ignored in unrelated scripts", () => {
  for (const [command, diagnostic] of [
    ["npm --prefix docs run build", /context change --prefix/],
    ["cd docs && npm run build", /context change cd/],
  ] as const) {
    const scripts = {
      "changelog:full": FLAGGED,
      "changelog:check": FLAGGED + " --check",
      "release:notes": FLAGGED + " --stdout",
      docs: command,
      site: "npm run docs",
    };
    const audit = () => auditInvocations([
      { file: "package.json", text: JSON.stringify({ scripts }) },
      { file: ".github/workflows/docs.yml", text: workflowRun("npm run site") },
    ]);
    assert.deepEqual(audit().failures, []);
    scripts["changelog:full"] = "npm run site && " + FLAGGED;
    const { failures } = audit();
    assert.equal(failures.length, 1);
    assert.match(failures[0], diagnostic);
  }
});

test("a forwarded script name can put a directory change on the generator path", () => {
  const results = auditInvocations([{
    file: "package.json",
    text: JSON.stringify({ scripts: {
      preview: "npm run relay -- writer",
      relay: "cd docs && npm run",
      writer: FLAGGED,
    } }),
  }]);
  assert.equal(results.failures.length, 1);
  assert.match(results.failures[0], /context change cd/);
});

test("non-root workflow steps refuse local forwards and direct generators without resolving the root manifest", () => {
  const file = ".github/workflows/release.yml";
  const source = { file: "package.json", text: JSON.stringify({ scripts: {
    changes: FLAGGED, first: "npm run second", second: "npm run changes",
  } }) };
  const step = workflowRun("npm run changes").replace("        run:", "        working-directory: docs\n        run:");
  const wrapped = step.replace("npm run changes", "nohup npm run first");
  const payload = step.replace("npm run changes", "sh -c 'npm run first'");
  const jobDefault = workflowRun("npm run nested-only").replace("    steps:", "    defaults: { run: { working-directory: docs } }\n    steps:");
  const workflowDefault = "defaults: { run: { working-directory: docs } }\n" + workflowRun(FLAGGED);
  for (const text of [step, wrapped, payload, jobDefault, workflowDefault]) {
    const result = auditInvocations([source, { file, text }]);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /working-directory "docs".*root package directory/);
  }
  for (const text of [workflowRun("npm run changes"), step.replace("working-directory: docs", "working-directory: ./")]) {
    assert.deepEqual(auditInvocations([source, { file, text }]).failures, []);
  }
  assert.deepEqual(auditInvocations([source, { file, text: step.replace("npm run changes", "echo done") }]).failures, []);
});

test("expression-valued run defaults require an explicit root working directory", () => {
  const file = ".github/workflows/release.yml";
  const source = { file: "package.json", text: JSON.stringify({ scripts: { "release:notes": FLAGGED } }) };
  const run = workflowRun("npm run release:notes");
  const expression = "${{ fromJSON(vars.RUN_DEFAULTS) }}";
  const defaults = "defaults:\n  run: " + expression + "\n";
  const jobDefault = run.replace("    steps:", defaults.replace(/^(.+)/gm, "    $1") + "    steps:");
  assert.deepEqual(auditInvocations([source, { file, text: run }]).failures, []);
  for (const text of [jobDefault, defaults + run]) {
    const override = text.replace("        run:", "        working-directory: ./\n        run:");
    assert.deepEqual(auditInvocations([source, { file, text: override }]).failures, []);
    const { failures } = auditInvocations([source, { file, text }]);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /working-directory.*RUN_DEFAULTS.*root package directory/);
  }
});

test("a pinned --date-fallback day must exist on the calendar, not merely be shaped like one", () => {
  // The regression CodeRabbit found: `2026-02-30` passes the shape regex and
  // therefore the audit, yet no calendar ever produces that heading. Both
  // spellings -- space and `=` -- are held to the same rule.
  for (const day of ["2026-02-30", "2026-13-01", "2026-04-31", "2026-02-29"]) {
    for (const spelling of [`--date-fallback ${day}`, `--date-fallback=${day}`]) {
      const result = auditInvocations([{ file: "package.json", text: manifest(`pm-changelog --release-version-from-package ${spelling}`) }]);
      assert.equal(result.failures.length, 1, `${spelling} pins a day that must be rejected`);
      assert.match(result.failures[0], new RegExp(`does not exist on the calendar \\(${day}\\)`));
      assert.equal(isRealCalendarDay(day), false, `${day} must not be a calendar day`);
    }
  }

  // A leap year's February 29 is a real day and stays accepted: rejecting it
  // would break the resumed release this pinned spelling exists for.
  const leap = "2028-02-29";
  assert.equal(isRealCalendarDay(leap), true);
  for (const spelling of [`--date-fallback ${leap}`, `--date-fallback=${leap}`]) {
    const result = auditInvocations([{ file: "package.json", text: manifest(`pm-changelog --release-version-from-package ${spelling}`) }]);
    assert.deepEqual(result.failures, [], `${spelling} pins a real day and must be accepted`);
    assert.equal(result.notes.length, 1);
  }
});

test("a pinned final argument before another JSON script is audited after decoding", () => {
  const text = JSON.stringify({
    description: "pm-changelog --version ignored outside scripts",
    scripts: {
      changelog: "pm-changelog --release-version-from-package --date-fallback 2026-11-16",
      next: "echo next",
    },
  }, null, 2);
  assert.match(text, /--date-fallback 2026-11-16",/);
  assert.deepEqual(auditInvocations([{ file: "package.json", text }]).failures, []);
  assert.equal(invocationsIn({ file: "package.json", text }).length, 1);
  assert.throws(() => invocationsIn({ file: "package.json", text: "invalid JSON" }), /package\.json: invalid JSON/);
});

test("one line holding two invocations is judged per invocation, spaced or not", () => {
  const unflagged = "pm-changelog --pm-root . --release-version-from-package";
  for (const separator of [" && ", "&&", " || ", "||", "; ", ";"]) {
    const result = auditInvocations([{ file: "package.json", text: manifest(`${FLAGGED}${separator}${unflagged}`) }]);
    assert.equal(
      result.failures.length,
      1,
      `the unflagged half must be reported across ${JSON.stringify(separator)}`,
    );
  }
});

test("an unspaced pipe is treated as part of an argument, not as a separator", () => {
  // Splitting there would separate a version input from its own flag and
  // report a defect that is not present.
  const piped = `pm-changelog --release-version-from-package ${DATE_FLAG} --tag-pattern "^v(2026|2027)"`;
  assert.deepEqual(auditInvocations([{ file: "package.json", text: manifest(piped) }]).failures, []);
});

test("a mention of the flag on a non-invoking line cannot cover for an unflagged invocation", () => {
  const result = auditInvocations([{
    file: "package.json",
    text: manifest(`pm-changelog --release-version-from-package\necho "the date comes from ${DATE_FLAG}"`),
  }]);
  assert.equal(result.failures.length, 1);
});

test("a mention inside a comment is not an invocation", () => {
  const result = auditInvocations([
    { file: ".github/workflows/release.yml", text: "  # pm-changelog --release-version-from-package explains the flag" },
    { file: "package.json", text: manifest(FLAGGED) },
  ]);
  assert.deepEqual(result.failures, []);
  assert.equal(result.notes.length, 1, "the comment-only file must not be reported as verified");
});

test("finding no invocation anywhere is a failure, not a silent pass", () => {
  const result = auditInvocations([{ file: "package.json", text: "{}" }]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /looking in the wrong place/);
});

test("the generator is resolved from node_modules, then dist, then the registry", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-generator-"));
  try {
    // Nothing to find: fall back to the registry rather than silently doing
    // nothing, so the failure names a missing generator.
    assert.deepEqual(resolveGenerator(root), { bin: "npx", lead: ["pm-changelog"] });

    // pm-changelog's own repository builds the generator it verifies with, so
    // the built entry point is used when there is no installed dependency.
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist/cli.js"), "");
    assert.deepEqual(resolveGenerator(root), { bin: process.execPath, lead: [join(root, "dist/cli.js")] });

    // An installed dependency wins: it is the version the package actually runs.
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(root, "node_modules/.bin/pm-changelog"), "");
    assert.deepEqual(resolveGenerator(root), { bin: join(root, "node_modules/.bin/pm-changelog"), lead: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shell segment that runs something else is not judged as a generator invocation", () => {
  // The release workflow pipes the generator's output through awk and sed; only
  // the segment that runs the generator carries the contract this gate audits.
  const text = `pm-changelog --release-version-from-package ${DATE_FLAG} --stdout | awk '/^## /' | sed -n '1p'`;
  assert.deepEqual(auditInvocations([{ file: ".github/workflows/release.yml", text: workflowRun(text) }]).failures, []);
  assert.equal(auditInvocations([{ file: ".github/workflows/release.yml", text: workflowRun(text) }]).notes.length, 1);
});

test("the behavioural half passes only when the flag changes the heading", () => {
  const good = auditHeadings("2026.1.2", "2026-08-27", (flagged) =>
    ({ ok: true, text: flagged ? "## 2026.1.2 - 2026-01-02" : "## 2026.1.2 - 2026-08-27" }));
  assert.deepEqual(good.failures, []);
  assert.equal(good.notes.length, 2);
});

test("a control that fails is a failure, not a note", () => {
  // Previously `|| true` swallowed this and the script exited 0 having never
  // made the comparison that gives it meaning.
  const result = auditHeadings("2026.1.2", "2026-08-27", (flagged) =>
    flagged ? { ok: true, text: "## 2026.1.2 - 2026-01-02" } : { ok: false, text: "the run failed: exit 2" });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /so the comparison proves nothing/);
});

test("a control identical to the flagged run fails, because then the flag discriminates nothing", () => {
  const result = auditHeadings("2026.1.2", "2026-08-27", () => ({ ok: true, text: "## 2026.1.2 - 2026-01-02" }));
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /the flag is changing nothing/);
});

test("a control derived some other way still passes, because the contract is that the flag changes the heading", () => {
  // Deliberately NOT today's date. Asserting the control equals today would pin
  // the generator's current default -- a compatible dependency update that
  // changed it would fail this gate with no defect -- and today's date is
  // sampled once for two subprocess runs, so a run crossing UTC midnight would
  // fail for no defect either.
  const result = auditHeadings("2026.1.2", "2026-08-27", (flagged) =>
    ({ ok: true, text: flagged ? "## 2026.1.2 - 2026-01-02" : "## 2026.1.2 - 2030-12-31" }));
  assert.deepEqual(result.failures, []);
  assert.match(result.notes[1], /derived some other way/);
});

test("a flagged run that fails, or that derives the wrong date, both fail", () => {
  const failed = auditHeadings("2026.1.2", "2026-08-27", (flagged) =>
    flagged ? { ok: false, text: "the run failed: exit 1" } : { ok: true, text: "## 2026.1.2 - 2026-08-27" });
  assert.equal(failed.failures.length, 1);

  const wrong = auditHeadings("2026.1.2", "2026-08-27", (flagged) =>
    ({ ok: true, text: flagged ? "## 2026.1.2 - 2020-01-02" : "## 2026.1.2 - 2026-08-27" }));
  assert.equal(wrong.failures.length, 1);
  assert.match(wrong.failures[0], /expected '## 2026\.1\.2 - 2026-01-02'/);
});

test("verify runs both halves against this checkout and reports through the process streams", () => {
  const result = verify(resolve(import.meta.dirname, ".."), new Date().toISOString().slice(0, 10));
  assert.deepEqual(result.failures, [], result.failures.join("\n"));
  const previous = process.exitCode;
  report(result);
  assert.equal(process.exitCode, 0);
  report({ failures: ["a failure"], notes: [] });
  assert.equal(process.exitCode, 1);
  process.exitCode = previous;
});

test("a generator that cannot run is reported as a failed run, not as a missing heading", () => {
  const failed = generateHeading(process.execPath, ["-e", "process.exit(2)"], import.meta.dirname);
  assert.equal(failed.ok, false);
  assert.match(failed.text, /^the run failed: /);

  const silent = generateHeading(process.execPath, ["-e", "console.log('no heading here')"], import.meta.dirname);
  assert.equal(silent.ok, false);
  assert.match(silent.text, /produced no '## ' heading/);

  const good = generateHeading(process.execPath, ["-e", "console.log('## 1.2.3 - 2026-01-02')"], import.meta.dirname);
  assert.deepEqual(good, { ok: true, text: "## 1.2.3 - 2026-01-02" });
});

test("runIfMain runs only when argv names this module, and refuses otherwise", () => {
  const url = import.meta.resolve("../scripts/verify-release-changelog-date.ts");
  assert.equal(runIfMain(["node", fileURLToPath(import.meta.url)], url, ".", "2026-01-01"), false,
    "a process entered through some other script must not run the verifier");
});

test("main verifies this checkout and reports through the process streams", () => {
  const savedExit = process.exitCode;
  const out = process.stdout.write;
  const err = process.stderr.write;
  const written: string[] = [];
  process.stdout.write = ((chunk: string) => { written.push(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { written.push(chunk); return true; }) as typeof process.stderr.write;
  let ran = false;
  try {
    ran = runIfMain(
      ["node", fileURLToPath(import.meta.resolve("../scripts/verify-release-changelog-date.ts"))],
      import.meta.resolve("../scripts/verify-release-changelog-date.ts"),
      resolve(import.meta.dirname, ".."),
      new Date().toISOString().slice(0, 10),
    );
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  assert.equal(ran, true, "argv naming this module must run the verifier");
  assert.equal(process.exitCode, 0, written.join(""));
  assert.ok(written.some((line) => line.startsWith("ok - ")), "main must report what it checked");
  process.exitCode = savedExit;
});

test("an unquoted trailing comment cannot supply the flag the command is missing", () => {
  // A substring check cannot tell a comment from an argument, so a comment
  // mentioning the flag satisfies the very check it complains about.
  const commented = `pm-changelog --release-version-from-package --stdout  # ${DATE_FLAG} belongs here`;
  const result = auditInvocations([{ file: "package.json", text: manifest(commented) }]);
  assert.equal(result.failures.length, 1, "the comment must not stand in for the flag");

  // A `#` inside quotes is an argument: these invocations pass URLs with one.
  const quoted = `pm-changelog --release-version-from-package ${DATE_FLAG} --item-url-base "https://example.test/#anchor"`;
  assert.deepEqual(auditInvocations([{ file: "package.json", text: manifest(quoted) }]).failures, []);

  assert.equal(stripComment('cmd --flag "a # b" # trailing'), 'cmd --flag "a # b" ');
  assert.equal(stripComment("cmd --flag 'a # b'"), "cmd --flag 'a # b'");
  assert.equal(stripComment("cmd --flag\\# not-a-comment"), "cmd --flag\\# not-a-comment");
  assert.equal(stripComment("#leading"), "");
});

test("array expansions cannot silently supply or replace a release policy", () => {
  const command = 'common=(--date-from-version)\npm-changelog "${common[@]}"';
  for (const text of [command, command + " --release-version-from-package", command + "\ncommon=()"]) {
    const result = auditInvocations([{ file: ".github/workflows/release.yml", text: workflowRun(text) }]);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /array expansion.*Use a direct pm-changelog/i);
  }
});

test("a backslash continuation is one logical command, not fragments", () => {
  const text = `pm-changelog \\\n  --release-version-from-package \\\n  ${DATE_FLAG}`;
  assert.equal(joinContinuations(text).split("\n").length, 1);
  assert.deepEqual(auditInvocations([{ file: "package.json", text: manifest(text) }]).failures, []);
});

test("decoded scripts retain multiline quoted arguments and report the JSON script key line", () => {
  const command = 'echo ready\npm-changelog --item-url-base "line one\nline two" --release-version-from-package';
  const source = { file: "package.json", text: manifest(command + " " + DATE_FLAG) };
  assert.deepEqual(auditInvocations([source]).failures, []);
  assert.equal(invocationsIn(source)[0]?.args[1].value, "line one\nline two");
  const missing = { ...source, text: manifest(command) };
  assert.match(auditInvocations([missing]).failures[0], /^package\.json:1 \(script "changelog"\): .*neither/);
  const unclosed = { ...source, text: manifest(`echo ready\n${FLAGGED} "line one\nline two`) };
  assert.match(auditInvocations([unclosed]).failures[0], /^package\.json:1 \(script "changelog"\): malformed/);
  const firstStep = workflowRun(FLAGGED);
  const malformedWorkflow = { file: ".github/workflows/release.yml",
    text: firstStep + '\n      - name: Another generator\n        run: |\n          ' + FLAGGED + ' "unclosed' };
  const workflowAudit = auditInvocations([malformedWorkflow]);
  assert.equal(workflowAudit.failures.length, 1);
  assert.match(workflowAudit.failures[0], /release\.yml:8: malformed/);
  assert.deepEqual(invocationsIn(malformedWorkflow).map(invocation => invocation.line), [5, 8]);
  assert.deepEqual(auditInvocations([{ ...malformedWorkflow, text: firstStep }]).failures, []);
});

test("the date verifier uses the generator arguments supplied by package script forwards", () => {
  for (const runner of ["npm", "bun", "pnpm"]) {
    const source = (options: string) => ({
      file: "package.json",
      text: JSON.stringify({ scripts: {
        check: `${runner} run changes ${runner === "pnpm" ? "" : "-- "}${options}`,
        changes: "echo ready && pm-changelog --release-version-from-package",
      } }),
    });
    assert.deepEqual(auditInvocations([source(DATE_FLAG)]).failures, [], runner);
    if (runner === "pnpm") assert.match(auditInvocations([source("-- " + DATE_FLAG)]).failures[0] ?? "", /delimiter --/);
    assert.match(auditInvocations([source("--date-fallback 2026-02-30")]).failures[0], /does not exist on the calendar/);
  }
});

test("a nested npm runner consumes pnpm's delimiter before the generator receives its options", () => {
  const scripts = {
    hook: "pnpm run relay -- --date-from-version",
    relay: "npm run changes",
    changes: "pm-changelog --release-version-from-package",
  };
  const audit = () => auditInvocations([{ file: "package.json", text: JSON.stringify({ scripts }) }]).failures;
  assert.deepEqual(audit(), []);
  scripts.relay += " --";
  assert.match(audit()[0], /delimiter --/);
});

test("a forwarded policy only covers the command that receives the new arguments", () => {
  const source = (changes: string) => ({
    file: "package.json",
    text: JSON.stringify({ scripts: { check: `npm run changes -- ${DATE_FLAG}`, changes } }),
  });
  const unflagged = "pm-changelog --release-version-from-package";
  for (const suffix of [" && echo done", " # trailing comment", "\n"]) {
    assert.match(auditInvocations([source(unflagged + suffix)]).failures[0], /neither --date-from-version/);
  }
  const mixed = { file: "package.json", text: JSON.stringify({ scripts: {
    check: `npm run changes -- ${DATE_FLAG}`, notes: "npm run changes", changes: unflagged,
  } }) };
  assert.equal(auditInvocations([mixed]).failures.length, 1);
});

test("disconnected and deep script dependencies do not conceal their generator commands", () => {
  const chain = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
    `hop${index}`, `npm run hop${index + 1}`,
  ]));
  const source = { file: "package.json", text: JSON.stringify({ scripts: {
    ...chain, hop10: FLAGGED, cyclic: "npm run other", other: `npm run cyclic && ${FLAGGED}`,
  } }) };
  assert.equal(invocationsIn(source).length, 2);
  assert.deepEqual(auditInvocations([source]).failures, []);
});

test("manifest scripts must be an object and only string commands are scanned", () => {
  for (const scripts of [null, 42, "invalid", [], true]) {
    assert.throws(() => invocationsIn({ file: "package.json", text: JSON.stringify({ scripts }) }), /package\.json: scripts must be an object/);
  }
  for (const value of [null, [], 42, "invalid"]) {
    assert.throws(() => invocationsIn({ file: "package.json", text: JSON.stringify(value) }), /package\.json: manifest must be an object/);
  }
  const text = JSON.stringify({ scripts: { valid: FLAGGED, number: 42, nested: [FLAGGED], object: { command: FLAGGED }, nil: null } });
  assert.equal(invocationsIn({ file: "package.json", text }).length, 1);
});

test("fallback dates accept matching shell quotes and adjacent separators", () => {
  for (const nameQuote of ["", "'", '"']) for (const valueQuote of ["", "'", '"']) {
    for (const assignment of [" ", "="]) for (const suffix of ["", "&&true", ";true", "|head"]) {
      const flag = `${nameQuote}--date-fallback${nameQuote}${assignment}${valueQuote}2026-10-23${valueQuote}${suffix}`;
      const result = auditInvocations([{ file: "package.json", text: manifest(`pm-changelog --release-version-from-package ${flag}`) }]);
      assert.deepEqual(result.failures, [], flag);
    }
  }
  for (const flag of ["--date-fallback '2026-02-30'", `--date-fallback '2026-10-23"`, `--date-fallback "2026-10-23'`, "--date-fallback '2026-10-23", '--date-fallback 2026-10-23"']) {
    const result = auditInvocations([{ file: "package.json", text: manifest(`pm-changelog --release-version-from-package ${flag}`) }]);
    assert.equal(result.failures.length, 1, flag);
  }
});

test("a forwarded manifest diagnostic names the script and its JSON key line", () => {
  const text = String.raw`{
  "metadata": { "changes": "placeholder" },
  "scripts": {
    "release:notes": "npm run changes",
    "chan\u0067es": "echo setup\npm-changelog --release-version-from-package"
  }
}`;
  const result = auditInvocations([{ file: "package.json", text }]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /^package\.json:5 \(script "changes"\): .*neither --date-from-version/);
});

test("Round GU unresolved reusable hook names fail closed for root projects", () => {
  const source = { file: "package.json", text: JSON.stringify({ scripts: {
    preview: "npm run render -- --date-from-version", render: "pm-changelog --release-version-from-package",
  } }) };
  const file = ".github/workflows/release.yml";
  const call = (name: string, project = ".") => ({ file, text: [
    "jobs:",
    "  release:",
    "    uses: owner/package/.github/workflows/daily-release.yml@main",
    "    with:",
    "      changelog-script: " + name,
    "      npm-project-dir: " + project,
  ].join("\n") });
  for (const project of [".", "${{ inputs.project }}"]) {
    const failures = auditInvocations([source, call("${{ vars.CHANGELOG_HOOK }}", project)]).failures;
    assert.equal(failures.length, 1);
    assert.match(failures[0], /release\.yml:5: release_hook_unsupported_construct:.*literal.*changelog-script.*script file/);
  }
  const nonScalar = auditInvocations([source, call("[render]")]).failures;
  assert.equal(nonScalar.length, 1);
  assert.match(nonScalar[0], /release\.yml: release_hook_unsupported_construct:.*changelog-script/);
  assert.throws(() => auditInvocations([source, { file, text: "jobs: [\n" }]), { name: "YAMLParseError" });
  assert.match(auditInvocations([source, call("render")]).failures[0], /neither --date-from-version/);
  assert.deepEqual(auditInvocations([source, call("${{ vars.CHANGELOG_HOOK }}", "docs")]).failures, []);
});

test("Round GW workflow case arms expose generator argv and preserve its controls", () => {
  const file = ".github/workflows/release.yml";
  const body = (command: string) => ({
    file, text: "jobs:\n  verify:\n    steps:\n      - shell: bash\n        run: |\n"
      + ['case "$MODE" in', '  (fast|normal) ' + command + ' ;;', '  ("slow)") echo "pm-changelog --release-version-from-package" ;;', 'esac']
        .map(line => "          " + line).join("\n"),
  });
  assert.deepEqual(auditInvocations([body(FLAGGED)]).failures, []);
  assert.match(auditInvocations([body(FLAGGED.replace(DATE_FLAG, ""))]).failures[0] ?? "", /neither --date-from-version/);
  const nested = { ...body(FLAGGED), text: body(FLAGGED).text.replace("shell: bash", "working-directory: docs\n        shell: bash") };
  assert.match(auditInvocations([nested]).failures[0] ?? "", /working-directory/);
});

test("Round GW the date audit applies the package hook grammar to configured and default notes", () => {
  const caller = { file: ".github/workflows/release.yml", text: [
    "jobs:", "  release:", "    uses: owner/package/.github/workflows/daily-release.yml@main",
    "    with:", "      notes-script: notes",
  ].join("\n") };
  for (const [name, workflows] of [["release:notes", []], ["notes", [caller]]] as const) {
    const manifest = (body: string) => ({ file: "package.json", text: JSON.stringify({ scripts: {
      "changelog:check": FLAGGED, [name]: body,
    } }) });
    const unsupported = 'case "$MODE" in fast) node notes.mjs ;; esac';
    assert.match(auditInvocations([manifest(unsupported), ...workflows]).failures[0] ?? "",
      new RegExp("release_hook_unsupported_construct:.*case arms.*" + name + ".*script file"));
    assert.deepEqual(auditInvocations([manifest('node notes.mjs "case"'), ...workflows]).failures, []);
  }
});

test("Round GW only enabled reusable calls require their explicit root selectors", () => {
  const file = ".github/workflows/release.yml";
  const caller = (selector: string, enabled?: string) => ({
    file, text: ["jobs:", "  release:", "    uses: owner/package/.github/workflows/daily-release.yml@main",
      "    with:", "      changelog-script: " + selector, ...(enabled === undefined ? [] : ["      release-enabled: " + enabled])].join("\n"),
  });
  const manifest = (scripts: Record<string, string>) => ({ file: "package.json", text: JSON.stringify({ scripts }) });
  const minimal = { "changelog:check": FLAGGED };
  const audit = (selector: string, enabled?: string, scripts: Record<string, string> = minimal) => auditInvocations([caller(selector, enabled), manifest(scripts)]).failures;
  const dynamic = "${{ vars.CHANGELOG_HOOK }}";
  assert.deepEqual(audit(dynamic, "false"), []);
  assert.deepEqual(audit("render", "false"), []);
});

test("Round GW explicit root selectors require an existing nonblank script", () => {
  const file = ".github/workflows/release.yml";
  const audit = (selector: string, enabled?: string, scripts: Record<string, string> = { "changelog:check": FLAGGED }) => auditInvocations([
    { file, text: ["jobs:", "  release:", "    uses: owner/package/.github/workflows/daily-release.yml@main",
      "    with:", "      changelog-script: " + selector, ...(enabled === undefined ? [] : ["      release-enabled: " + enabled])].join("\n") },
    { file: "package.json", text: JSON.stringify({ scripts }) },
  ]).failures;
  const dynamic = "${{ vars.CHANGELOG_HOOK }}";
  const minimal = { "changelog:check": FLAGGED };
  for (const enabled of [undefined, "true", "${{ inputs.release }}", "'false'"]) {
    assert.match(audit(dynamic, enabled)[0] ?? "", /release\.yml:5:.*unresolved selector/);
    assert.match(audit("render", enabled)[0] ?? "", /release\.yml:5:.*release_hook_unsupported_construct:.*missing or blank.*render.*changelog-script/i);
  }
  assert.match(audit("render", "true", { ...minimal, render: " " })[0] ?? "", /missing or blank/);
  assert.deepEqual(audit("render", "true", { ...minimal, render: FLAGGED }), []);
});

test("Round GW workflow case metadata cannot hide executable substitutions", () => {
  const file = ".github/workflows/release.yml";
  const audit = (subject: string, pattern: string) => auditInvocations([{
    file, text: "jobs:\n  verify:\n    steps:\n      - run: |\n"
      + ['case ' + subject + ' in', '  ' + pattern + ') ' + FLAGGED + ' ;;', 'esac']
        .map(line => "          " + line).join("\n"),
  }]).failures;
  const command = "pm-changelog --release-version-from-package";
  assert.match(audit('"$(' + command + ')"', "fast")[0] ?? "", /Shell command substitution/);
  assert.match(audit('"$MODE"', '"$(' + command + ')"')[0] ?? "", /Shell command substitution/);
  assert.deepEqual(audit("'$(" + command + ")'", "'$(" + command + ")'"), []);
});

test("Round GW workflow esac patterns leave case arms executable", () => {
  const file = ".github/workflows/release.yml";
  const audit = (pattern: string, command: string) => auditInvocations([{
    file, text: "jobs:\n  verify:\n    steps:\n      - run: |\n"
      + '          case "$MODE" in ' + pattern + ' ' + command + ' ;; esac\n',
  }]).failures;
  for (const pattern of ["(esac)", "(esac | fast)", "(fast | esac)", "fast | esac)"]) {
    assert.deepEqual(audit(pattern, FLAGGED), []);
    assert.match(audit(pattern, FLAGGED.replace(DATE_FLAG, ""))[0] ?? "", /neither --date-from-version/);
  }
  assert.deepEqual(audit("fast)", FLAGGED), []);
});

test("Round HA configured all-tags cutoffs use the effective real calendar day", () => {
  const audit = (command: string) => auditInvocations([{ file: "package.json",
    text: JSON.stringify({ name: "fixture", version: "2026.2.28", scripts: { "changelog:full": command } }) }]).failures;
  const base = "pm-changelog --release-version-from-package --date-from-version";
  assert.match(audit(base + " --all-release-tags --until 2026-02-30")[0] ?? "", /Invalid --until.*real YYYY-MM-DD/);
  assert.deepEqual(audit(base + " --all-release-tags --until 2026-02-30 --until 2026-02-28"), []);
  assert.deepEqual(audit(base + " --until 2026-02-30"), []);
});

test("Round HG cat pipelines are workflow forms and refused in configured package hooks", () => {
  const body = FLAGGED + "|cat";
  const pkg = (hook: string) => ({ file: "package.json", text: JSON.stringify({ scripts: { "release:notes": hook } }) });
  assert.deepEqual(auditInvocations([{ file: ".github/workflows/release.yml", text: workflowRun(body) }]).failures, []);
  assert.match(auditInvocations([pkg(body)]).failures[0] ?? "", /release_hook_unsupported_construct: cat in hook "release:notes".*script file/);
  assert.deepEqual(auditInvocations([pkg(FLAGGED + "|head")]).failures, []);
});

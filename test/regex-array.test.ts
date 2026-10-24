/** Bash-backed paired controls for issue #172's non-command word contexts. */
import assert from "node:assert/strict";
import { spawnSync } from "../subprocess.ts";
import test from "node:test";
import { auditPublishAttestation } from "../attestation.ts";
import { isolateShellChildren, tokenizeCommands } from "../shell-scan.ts";

/** Exact workflow lines, including the full multiline pathspec assignment. */
const fleetConstructs = [
  String.raw`if [[ "$current_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-[0-9]+)?$ ]]; then`,
  '[[ "${PM_GITHUB_VERSION}" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9]+)?$ ]] || { echo "::error::pm-github-version must be an exact numeric version: N.N.N or N.N.N-N."; exit 1; }',
  'sync_scope=(":(top,literal)${PM_SYNC_TRACKER}" \':(top,literal)CHANGELOG.md\'\n  ":(top,exclude,literal)${PM_SYNC_TRACKER}/extensions"\n  ":(top,exclude,literal)${PM_SYNC_TRACKER}/locks"\n  ":(top,exclude,literal)${PM_SYNC_TRACKER}/checkpoints"\n  ":(top,exclude,literal)${PM_SYNC_TRACKER}/settings.json"\n  ":(top,exclude,literal)${PM_SYNC_TRACKER}/history/_workspace.jsonl")',
];

/** Audit the same body in a shell script and a literal workflow run block. */
function outcomes(body: string) {
  const script = `npm publish --provenance\n${body}`;
  return [
    { file: "scripts/release.sh", text: script },
    { file: ".github/workflows/release.yml", text: `jobs:\n  release:\n    steps:\n      - run: |\n${script.split("\n").map(/** Keep Bash's original line boundaries. */ (line) => `          ${line}`).join("\n")}\n` },
  ].map(/** Both executable formats must agree. */ (source) => auditPublishAttestation([source]));
}

/** Execute real Bash with an inert, observable npm function and synthetic values. */
function bash(body: string): string {
  const script = `npm() { printf 'npm:%s\\n' "$*" >&2; }\nx=1\ncurrent_version=1.2.3\nPM_GITHUB_VERSION=1.2.3-4\nPM_SYNC_TRACKER=.agents/pm\nnpm publish --provenance\n${body}`;
  const syntax = spawnSync("bash", ["--noprofile", "--norc", "-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", `${script}\nwait`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stderr;
}

for (const operator of ["<", ">"]) {
  for (const [context, wrap] of [
    ["array", (child: string) => `values=( ${child} )`],
    ["conditional", (child: string) => `[[ -n ${child} ]] || :`],
    ["case", (child: string) => `case "$x" in ${child}) : ;; esac`],
    ["argument", (child: string) => `: ${child}`],
    ["command", (child: string) => `${child} || :`],
  ] as const) {
    test(`process substitution child: ${context} ${operator}`, () => {
      const child = `${operator}(npm publish)`;
      const body = wrap(child);
      const start = body.indexOf(child);
      assert.deepEqual(isolateShellChildren(body), {
        parent: body.replace(child, "$(:)"),
        children: [{ start, end: start + child.length, text: "npm publish", arithmetic: false }],
      });
    });
    for (const nested of [false, true]) {
      test(`process substitution refusal: ${context} ${operator} nested=${nested}`, () => {
        const child = `${operator}(npm publish)`;
        const body = wrap(nested ? `$( : ${child} )` : child);
        assert.equal(bash(body).split("npm:").length - 1, 2, "Bash executes the unattested publisher");
        for (const result of outcomes(body)) {
          if (context !== "command") assert.deepEqual(result.recognition, { count: 2, kind: "recognized" });
          assert.match(result.failures.join("\n"), /unattested artifact: npm publish/u);
        }
      });
    }
  }
}

test("a process substitution containing a subshell is executable rather than arithmetic", () => {
  const body = 'values=( <((npm publish)) >((npm publish)) )';
  assert.equal(bash(body).split("npm:").length - 1, 3);
  assert.ok(isolateShellChildren(body).children.every(/** Process children do not inherit arithmetic mode. */ (child) => !child.arithmetic));
  for (const result of outcomes(body)) {
    assert.deepEqual(result.recognition, { count: 3, kind: "recognized" });
    assert.match(result.failures.join("\n"), /unattested artifact: npm publish/u);
  }
});

for (const body of [
  'values=("<(npm publish)" ">(npm publish)")',
  "values=('<(npm publish)' '>(npm publish)')",
  'values=(\\<\\(npm\\ publish\\) \\>\\(npm\\ publish\\))',
  '[[ -n "<(npm publish)" ]]',
  'case "$x" in "<(npm publish)") : ;; esac',
  ': "<(npm publish)" ">(npm publish)"',
]) {
  test(`process substitution literal acceptance: ${body}`, () => {
    assert.equal(bash(body).split("npm:").length - 1, 1, "Bash does not execute the literal text");
    for (const result of outcomes(body)) assert.deepEqual(result.failures, []);
  });
}

for (const [index, construct] of fleetConstructs.entries()) {
  test(`fleet acceptance ${index + 1}: exact issue #172 construct`, () => {
    const body = index === 0 ? `${construct}\n  :\nfi` : construct;
    assert.equal(bash(body).split("npm:").length - 1, 1);
    for (const result of outcomes(body)) assert.deepEqual(result.failures, []);
  });
}

for (const body of [
  '[[ $x =~ ^(1|2)?[0-9]*[a-z]+$ ]] || :',
  '[[ $x =~ "(a|b)?$" ]] || :',
  '[[ $x =~ \'$(npm publish)\' ]] || :',
  '[[ $x =~ \\$(npm\\ publish) ]] || :',
  '[[ $x =~ ^$ ]] || :',
  '[[ $x =~ $x ]]',
  '[[ $x == 1 && ( $x == 1 || $x == 2 ) ]]',
  'values=("${x}(literal)" \'(quoted)\' "npm publish")',
  'values+=("${x}(literal)" \'(quoted)\')',
  'values=(\\(literal\\))',
  'values=(); values+=("${x}")',
  'values=("$(printf %s ")")" "${x}")',
  'values=(\'$(npm publish)\' \'`npm publish`\')',
  'values=("${x}"); npm publish --provenance',
  '[[ $x =~ 1 ]] && npm publish --provenance',
]) {
  test(`word acceptance: ${body}`, () => {
    assert.ok(bash(body));
    for (const result of outcomes(body)) assert.deepEqual(result.failures, []);
  });
}

for (const body of [
  '[[ $x =~ $(npm publish) ]]',
  '[[ $x =~ `npm publish` ]]',
  '[[ $x =~ "$(npm publish)" ]]',
  '[[ $x =~ 1 ]] && npm publish',
  '[[ $x =~ 2 ]] || npm publish',
  '[[ $x =~ 1 ]]; npm publish',
  '[[ $x =~ 1 ]]\nnpm publish',
  'values=("$(npm publish)")',
  'values=("`npm publish`")',
  'values=($(npm publish))',
  'values=(`npm publish`)',
  'values+=("$(npm publish)")',
  'values+=("`npm publish`")',
  'values=("first)" "$(npm publish)" "${x}(last)")',
  'values=("${x}(literal)")\nnpm publish',
]) {
  test(`word refusal: ${body}`, () => {
    assert.equal(bash(body).split("npm:").length - 1, 2, "Bash executes the unattested publisher");
    for (const result of outcomes(body)) {
      assert.deepEqual(result.recognition, { count: 2, kind: "recognized" });
      const missingFlag = result.failures.filter(/** A hidden publisher must be enumerated concretely. */ (message) => message.includes("unattested artifact: npm publish"));
      assert.equal(missingFlag.length, 1, JSON.stringify(result));
    }
  });
}

for (const body of ['[[ $x =~ ^(1|2)?$', '[[ $x =~ x', 'values=("${x}(literal)"', 'values+=("${x}"']) {
  test(`incomplete word context: ${body}`, () => {
    const syntax = spawnSync("bash", ["--noprofile", "--norc", "-n"], { input: body, encoding: "utf8" });
    assert.notEqual(syntax.status, 0);
    for (const result of outcomes(body)) assert.ok(result.failures.length > 0);
  });
}

test("regex anchor is literal but parameter expansions remain unresolved operands", () => {
  const command = tokenizeCommands('[[ $x =~ ^(1|2)?$ ]]')[0]!;
  assert.equal(command.at(-2)!.value, "^(1|2)?$");
  assert.equal(command.at(-2)!.unresolved, undefined);
  assert.equal(tokenizeCommands('[[ $x =~ $pattern ]]')[0]!.at(-2)!.unresolved, true);
});

for (const body of [
  'case "$x" in "${PM_SYNC_TRACKER}"/extensions|"${PM_SYNC_TRACKER}"/extensions/*|"${PM_SYNC_TRACKER}"/locks|"${PM_SYNC_TRACKER}"/locks/*|"${PM_SYNC_TRACKER}"/checkpoints|"${PM_SYNC_TRACKER}"/checkpoints/*) ;; "${PM_SYNC_TRACKER}"/*|CHANGELOG.md) : ;; esac',
  'case "$x" in "${PM_SYNC_TRACKER}"/*|"${PM_SYNC_TRACKER}"/*/*.toon) : ;; esac',
  'case "$x" in ("${PM_SYNC_TRACKER}"/*) : ;; (1) : ;; esac',
  'case "$x" in "${x}") : ;; esac; npm publish --provenance',
  'case "$x" in 1) case "$x" in "${x}") : ;; esac ;; esac',
  'case "$x" in 1) : ;& "${x}") : ;; esac',
  'case "$x" in 1) : ;;& "${x}") : ;; esac',
  'case "$x" in esac',
  'case "$x" in 1) :\nesac',
  'case "$x" in 1) printf "%s" esac ;; esac',
  'if true; then case "$x" in "${x}") : ;; esac; fi',
  'printf "%s" case; case "$x" in "npm publish") : ;; esac',
  'case "$x" in "$(printf %s 1)") : ;; esac',
]) {
  test(`case pattern acceptance: ${body}`, () => {
    assert.ok(bash(body));
    for (const result of outcomes(body)) assert.equal(result.failures.length, 0, JSON.stringify(result));
  });
}

for (const body of [
  'case "$x" in "${x}") npm publish ;; esac',
  'case "$x" in 1) :\nesac; npm publish',
  'case "$x" in 1) printf "%s" esac; npm publish ;; esac',
  'case "$x" in "${x}") : ;; esac; npm publish',
  'case "$x" in "$(npm publish)") : ;; esac',
  'case "$x" in "`npm publish`") : ;; esac',
  'case "$(npm publish)" in *) : ;; esac',
  'case "$x" in "${x}") case "$x" in "${x}") npm publish ;; esac ;; esac',
  'case "$x" in "${x}") : ;& *) npm publish ;; esac',
  'case "$x" in "${x}") : ;;& *) npm publish ;; esac',
  'case "$x" in "${x}") (npm publish) ;; esac',
  'case "$x" in "${x}") printf "%s" "$(npm publish)" ;; esac',
]) {
  test(`case pattern refusal: ${body}`, () => {
    assert.match(bash(body), /npm:publish\n/u);
    for (const result of outcomes(body)) {
      assert.match(result.failures.join("\n"), /unattested artifact: npm publish/u);
    }
  });
}

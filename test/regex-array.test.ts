/** Bash-backed paired controls for issue #172's non-command word contexts. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { auditPublishAttestation } from "../attestation.ts";
import { tokenizeCommands } from "../shell-scan.ts";

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
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stderr;
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

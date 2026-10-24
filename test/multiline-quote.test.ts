/** Paired multiline-quote controls use real Bash with inert npm and GitHub boundaries. */
import assert from "node:assert/strict";
import { spawnSync } from "../subprocess.ts";
import test from "node:test";
import { auditPublishAttestation } from "../attestation.ts";
import { tokenizeCommands } from "../shell-scan.ts";

/** Exact issue input; only npm and gh are replaced when Bash executes it. */
const reproduction = `npm publish --provenance
ids="$(gh api graphql --jq '.nodes[]
| .id')"
gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' -F t="$ids" >/dev/null 2>&1 && echo "$ids" >> "$GITHUB_STEP_SUMMARY" || true`;

/** Later unrelated expansions expose an incorrectly consumed substitution close. */
const mutation = `gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' -F t="$ids"`;

/** Auditing shell scripts and YAML steps must agree on the same executable text. */
function audit(script: string): void {
  for (const source of [
    { file: "scripts/release.sh", text: script },
    { file: ".github/workflows/release.yml", text: `jobs:\n  release:\n    steps:\n      - run: |\n${script.split("\n").map(/** Preserve YAML's literal block line boundaries. */ (line) => `          ${line}`).join("\n")}\n` },
  ]) assert.deepEqual(auditPublishAttestation([source]).failures, [], source.file);
}

/** Run real Bash while keeping publisher and network calls inert and observable. */
function bash(script: string): string {
  const syntax = spawnSync("bash", ["--noprofile", "--norc", "-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const execution = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", `npm() { printf 'npm:%s\\n' "$*" >&2; }
gh() { printf 'gh:%q\\n' "$@" >&2; printf 'thread-id\\n'; }
${script}`], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "/dev/null" } });
  assert.equal(execution.status, 0, execution.stderr);
  return execution.stderr;
}

test("multiline acceptance: exact issue 170 reproduction", () => {
  const calls = bash(reproduction);
  assert.match(calls, /gh:\$'\.nodes\[\]\\n\| \.id'/u, "Bash passes one multiline jq argument");
  assert.equal(calls.split("npm:").length - 1, 1);
  audit(reproduction);
});

for (const quote of ["'", '"', "$'"]) {
  test(`multiline acceptance: ${quote} jq program inside substitution`, () => {
    const close = quote === '"' ? '"' : "'";
    const script = `npm publish --provenance\nids="$(gh api graphql --jq ${quote}.nodes[]\n| .id${close})"\n${mutation} >/dev/null 2>&1 && echo "$ids" >> "$GITHUB_STEP_SUMMARY" || true`;
    assert.match(bash(script), /gh:\$'\.nodes\[\]\\n\| \.id'/u);
    audit(script);
  });
  test(`multiline top-level: ${quote} keeps prose and command-looking text literal`, () => {
    const script = `npm publish --provenance\nprintf '%s' ${quote}first\nnpm publish\nlast${quote === '"' ? '"' : "'"}\n${mutation}`;
    assert.equal(bash(script).split("npm:").length - 1, 1);
    audit(script);
    assert.equal(tokenizeCommands(script).filter(/** Only executable npm words count. */ (command) => command[0]?.value === "npm").length, 1);
  });
}

for (const body of [
  'printf "%s" "first\n$(npm publish)\nlast"',
  'printf "%s" "first\n`npm publish`\nlast"',
  'ids=$(printf "%s" "first\n$(npm publish)\nlast")',
  'ids=$(printf "%s" "first\n`npm publish`\nlast")',
  "printf '%s' 'first\nlast'\nnpm publish",
  'printf "%s" "first\nlast"\nnpm publish',
  "ids=$(printf '%s' 'first\nlast')\nnpm publish",
  'ids=$(printf "%s" "first\nlast")\nnpm publish',
  "ids=$(printf '%s' 'first\nlast'; npm publish)",
  'ids=$(printf "%s" "first\nlast"; npm publish)',
  "ids=$(printf '%s' 'literal\\'\nnpm publish)",
]) {
  test(`multiline refusal: ${JSON.stringify(body)}`, () => {
    const script = `npm publish --provenance\n${body}`;
    assert.equal(bash(script).split("npm:").length - 1, 2, "Bash really executes the hidden unattested publisher");
    const result = auditPublishAttestation([{ file: "scripts/release.sh", text: script }]);
    assert.ok(result.failures.some(/** A concrete missing-provenance verdict proves enumeration. */ (failure) => failure.includes("npm publish") && !failure.includes("cannot prove")), result.failures.join("\n"));
    assert.deepEqual(result.recognition, { kind: "recognized", count: 2 });
  });
}

for (const body of ["echo 'first\nlast", 'echo "first\nlast', "ids=$(echo 'first\nlast)", 'ids=$(echo "first\nlast)', "echo $'first\nlast"]) {
  test(`multiline unterminated refusal: ${JSON.stringify(body)}`, () => {
    const script = `npm publish --provenance\n${body}`;
    const syntax = spawnSync("bash", ["--noprofile", "--norc", "-n"], { input: script, encoding: "utf8" });
    assert.notEqual(syntax.status, 0, "Bash rejects the incomplete quoted input");
    assert.match(syntax.stderr, /unexpected EOF/u);
    assert.ok(auditPublishAttestation([{ file: "scripts/release.sh", text: script }]).failures.length > 0);
  });
}

test("multiline quote scan stays bounded on hostile quoted newlines and parentheses", () => {
  const started = process.cpuUsage();
  for (const quote of ["'", '"']) {
    const script = `echo $(printf %s ${quote}${"\n)(".repeat(80_000)}${quote}); npm publish`;
    const commands = tokenizeCommands(script);
    assert.ok(commands.some(/** Quoted parens must not consume the following publisher. */ (command) => command[0]?.value === "npm"));
  }
  const used = process.cpuUsage(started);
  assert.ok((used.user + used.system) / 1000 < 2000, "multiline quote scanning exceeds the existing 2000ms CPU budget");
});

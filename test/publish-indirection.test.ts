/** Real shell executions prove that indirect publishers cannot borrow sibling evidence. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditPublishAttestation } from "../attestation.ts";
import { shellScalars, tokenizeCommands } from "../shell-scan.ts";

test("quoted expansion scanning stays bounded on hostile delimiter suffixes", /** Exercise actual malformed library input in a child with an unchanged parser deadline and exact token assertions. */ () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { tokenizeCommands } from "./shell-scan.ts";
    for (const payload of ["\u0024{" + "@".repeat(80000), "\u0024{".repeat(12000) + "@".repeat(20000), "\u0024{".repeat(12000)]) {
      const word = tokenizeCommands('echo "' + payload + '"')[0][1];
      assert.equal(word.value, payload);
      assert.equal(word.unresolved, true);
      assert.equal(word.multipleWords, undefined);
    }
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 2000 });
  assert.equal(result.error, undefined, "real malformed shell input must complete within the isolated parser budget");
  assert.equal(result.status, 0, result.stderr);
});

test("quoted scalar and list expansion provenance survives repeated delimiters", /** Preserve quoted operand metadata and downstream publisher refusal across scalar, list and repeated parameter forms. */ () => {
  for (const [word, multipleWords] of [
    ["${REGISTRY}", undefined], ["${A}${B}", undefined],
    ["${A}${B[@]}", true], ["${A[@]}${B}", true],
    ["${A[@]}${B[@]}", true], ["$@", true],
    ["${A\\@}", true], ["${A@Q}", true],
  ] as const) {
    const token = tokenizeCommands(`npm --registry "${word}" whoami`)[0]![2]!;
    assert.equal(token.value, word.replace("\\@", "@"));
    assert.equal(token.unresolved, true);
    assert.equal(token.multipleWords, multipleWords, word);
    const failures = auditPublishAttestation([{ file: "scripts/release.sh", text: `npm publish --provenance\nnpm --registry "${word}" whoami` }]).failures;
    assert.equal(failures.length === 0, multipleWords !== true, word);
  }
  const words = tokenizeCommands('echo "${A[@]}" "${B}" "${C[@]}"')[0]!;
  assert.deepEqual(words.slice(1).map(/** Inspect each real parsed operand's splitting provenance. */ (word) => word.multipleWords), [true, undefined, true]);
});

test("public token shape, arithmetic operands, ordering and depth remain stable", /** Pin the exported scanner's consumer contract while entering executable child bodies. */ () => {
  assert.equal(tokenizeCommands.length, 1);
  assert.deepEqual(tokenizeCommands("npm publish", 9), []);
  assert.deepEqual(tokenizeCommands("npm publish --provenance"), [[
    { value: "npm", quoted: false, startsQuoted: false },
    { value: "publish", quoted: false, startsQuoted: false },
    { value: "--provenance", quoted: false, startsQuoted: false },
  ]]);
  for (const [text, quoted] of [["echo $((1 + 2))", false], ['echo "$((1 + 2))"', true]] as const) {
    assert.deepEqual(tokenizeCommands(text), [[
      { value: "echo", quoted: false, startsQuoted: false },
      { value: "", quoted, unresolved: true, startsQuoted: quoted },
    ]]);
  }
  assert.deepEqual(tokenizeCommands("echo ${X:-$(npm publish)}; echo done").map(/** Compare public outer-first command ordering. */ (command) => command.map(/** Read each public token value. */ (token) => token.value)), [
    ["echo", "${X:-$(npm publish)}"], ["echo", "done"], ["npm", "publish"],
  ]);
  assert.deepEqual(tokenizeCommands("echo `printf foo\\\nbar`"), [
    [{ value: "echo", quoted: false, startsQuoted: false }, { value: "", quoted: false, unresolved: true, startsQuoted: false }],
    [{ value: "printf", quoted: false, startsQuoted: false }, { value: "foobar", quoted: false, startsQuoted: false }],
  ]);
  assert.equal(shellScalars("VALUE=$( (printf value) )").has("VALUE"), false, "nested parentheses cannot turn an unreadable assignment into a literal");
  let deep = "npm publish";
  for (let depth = 0; depth < 10; depth += 1) deep = `echo ${"${X:-$("}${deep})}`;
  assert.deepEqual(auditPublishAttestation([{ file: "release.sh", text: `npm publish --provenance\n${deep}` }]).recognition, { kind: "recognized", count: 1 }, "the inherited depth cap remains a bounded enumeration limit");
});

/** Executable scripts whose publish argument list or alias state cannot be proved. */
const unsafe = [
  "shopt -s expand_aliases\nalias deploy='npm publish'\ndeploy",
  "shopt -s expand_aliases\nalias deploy='npm publish --provenance'\ndeploy --provenance=false",
  "shopt -s expand_aliases\nalias deploy='npm'\ndeploy publish",
  "A=alias\n$A deploy='npm publish'\nshopt -s expand_aliases\ndeploy",
  'deploy() { npm "$@"; }\ndeploy publish',
  'function deploy { npm "$@"; }\ndeploy publish',
  'deploy() { npm publish --provenance "$@"; }\ndeploy --provenance=false',
  'deploy() { npm "$@" --provenance; }\ndeploy publish --no-provenance',
  'npm() { command npm "$@" --provenance=false; }\nnpm publish --provenance',
  'X=xargs\nprintf "%s\\n" publish | $X npm',
  'X=xargs\nprintf "%s\\n" --provenance=false | $X npm publish --provenance',
  'X=xargs\nprintf "%s\\n" publish | "$X" npm',
  'X=xargs\nprintf "%s\\n" publish | env "$X" npm',
  'printf "%s\\n" --provenance=false | xargs npm publish --provenance',
  'printf "%s\\n" --no-provenance | xargs -n 1 npm publish --provenance',
  'printf "%s\\n" --provenance=false | xargs -I{} npm publish --provenance {}',
  'CMD=npm\nARGS="publish --provenance=false"\n$CMD --provenance $ARGS',
  'npm publish --provenance "$OVERRIDE"',
  'npm "$VERB" --provenance=false',
  'n${MIDDLE}m publish',
  'eval "$PAYLOAD"',
  'bash -c "$PAYLOAD"',
  'E=eval\n$E "$PAYLOAD"',
  'npm --registry ""$REGISTRY whoami',
  'npm --registry="$REGISTRY"$EXTRA ping',
  'set -- https://example.invalid publish\nnpm --registry "$@" whoami',
  'OPTIONS=(https://example.invalid publish)\nnpm --registry "${OPTIONS[@]}" ping',
  'echo ${X:-$(npm publish)}',
  'echo ${X:-`npm publish`}',
  'echo ${OUTER:-${INNER:-$(npm publish)}}',
  'echo ${X:-"}$(npm publish)"}',
  'echo ${X:-$((1 + $(npm publish; printf 0)))}',
  'echo $((1 + $(npm publish; printf 0)))',
  'echo "$((1 + $(npm publish; printf 0)))"',
  'echo ${X:-`echo \\`npm publish\\``}',
  'echo $((1 + `echo \\`npm publish; printf 0\\``))',
  'echo "${X:-`echo \\`npm publish\\``}"',
  'echo "${X:-\'$(npm publish)\'}"',
  'echo ${X:-$(printf "%s" "$(npm publish)")}',
  'echo ${X:-$(echo `echo \\`npm publish\\``)}',
  'FLAG=--provenance\necho ${X:-$(unset FLAG; npm publish $FLAG)}',
  'FLAG=--provenance\necho $((1 + $(unset FLAG; npm publish $FLAG; printf 0)))',
  'FLAG=--provenance\necho "${X:-$(FLAG=--no-provenance; npm publish $FLAG)}"',
  'FLAGS=(--provenance)\necho ${X:-$(unset FLAGS; npm publish "${FLAGS[@]}")}',
  'FLAGS=(--provenance)\necho $((1 + $(FLAGS=(--no-provenance); npm publish "${FLAGS[@]}"; printf 0)))',
  'FLAGS=(--provenance)\necho "${X:-$(FLAGS=--no-provenance; npm publish "${FLAGS[@]}")}"',
  'FLAG=--provenance\n(unset FLAG; npm publish $FLAG)',
  'FLAGS=(--provenance)\n(unset FLAGS; npm publish "${FLAGS[@]}")',
  'echo ${X:-$(if false; then FLAG=--provenance; else npm publish $FLAG; fi)}',
  'echo ${X:-$(if false; then FLAGS=(--provenance); else npm publish "${FLAGS[@]}"; fi)}',
  'echo ${X:-$(if true; then npm publish "${FLAGS[@]}"; else FLAGS=(--provenance); fi)}',
  'FLAGS=(--provenance)\necho ${X:-$(FLAGS+=(--no-provenance); npm publish "${FLAGS[@]}")}',
  'FLAGS=(--provenance)\necho "${X:-$(FLAGS[0]=--no-provenance; npm publish "${FLAGS[@]}")}"',
  'FLAG=--provenance\necho $((1 + $(FLAG+=false; npm publish $FLAG; printf 0)))',
  'FLAGS=(--provenance)\nFLAGS+=(--no-provenance)\nnpm publish "${FLAGS[@]}"',
  'FLAGS=(--provenance)\nFLAGS[0]=--no-provenance\nnpm publish "${FLAGS[@]}"',
  'FLAG=--provenance\nFLAG+=false\nnpm publish $FLAG',
  'echo ${X:-$(npm publish)} # FLAGS=(--provenance)',
  '(( $(npm publish; printf 1) ))',
];

/** Scope controls share the real Bash boundary rather than duplicating its harness. */
const scopeControls = [
  { body: 'FLAG=--provenance\necho ${X:-$(unset FLAG)}\nnpm publish $FLAG', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'FLAG=--provenance\necho $((1 + $(unset FLAG; printf 0)))\nnpm publish $FLAG', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'FLAG=--provenance; echo "${X:-$(unset FLAG)}"; npm publish $FLAG', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'FLAG=--provenance\necho ${X:-`unset FLAG`}\nnpm publish $FLAG', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'FLAGS=(--provenance)\necho ${X:-$(unset FLAGS)}\nnpm publish "${FLAGS[@]}"', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'FLAGS=(--provenance)\necho $((1 + $(FLAGS=(--no-provenance); printf 0)))\nnpm publish "${FLAGS[@]}"', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'FLAG=--provenance\n(unset FLAG)\nnpm publish $FLAG', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'FLAGS=(--provenance); (FLAGS=(--no-provenance)); npm publish "${FLAGS[@]}"', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'FLAG=--provenance\necho ${X:-$(FLAG=--no-provenance)}\nnpm publish $FLAG', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'echo ${X:-$(FLAG=--provenance; npm publish $FLAG)}', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'echo $((1 + $(FLAGS=(--provenance); npm publish "${FLAGS[@]}"; printf 0)))', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'echo "${X:-$(FLAG=--provenance; npm publish $FLAG)}"', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'echo ${X:-`echo \\`npm publish --provenance\\``}', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'echo ${X:-\\`npm publish\\`}', refused: false, calls: ["publish --provenance"] },
  { body: 'echo ${X:-\'`npm publish`\'}', refused: false, calls: ["publish --provenance"] },
  { body: 'FLAGS=(\n --provenance\n)\necho "${X:-$(unset FLAGS)}"\nnpm publish "${FLAGS[@]}"', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'FLAG=--provenance\necho ${X:-$(npm publish $FLAG)}', refused: true, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'FLAGS=(--provenance)\necho "${X:-$(npm publish "${FLAGS[@]}")}"', refused: true, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'echo ${X:-$(FLAG=--provenance)}\nnpm publish $FLAG', refused: true, calls: ["publish --provenance", "publish"] },
  { body: 'FLAG=--provenance\nunset FLAG\necho ${X:-$(npm publish --provenance)}\nnpm publish $FLAG', refused: true, calls: ["publish --provenance", "publish --provenance", "publish"] },
  { body: 'FLAGS=(--provenance)\nunset FLAGS\nnpm publish "${FLAGS[@]}"', refused: true, calls: ["publish --provenance", "publish"] },
  { body: 'FLAGS=(--provenance)\nFLAGS=(--no-provenance)\nnpm publish "${FLAGS[@]}"', refused: true, calls: ["publish --provenance", "publish --no-provenance"] },
  { body: 'FLAGS=(--provenance)\nFLAGS=--no-provenance\nnpm publish "${FLAGS[@]}"', refused: true, calls: ["publish --provenance", "publish --no-provenance"] },
  { body: 'FLAGS=(--provenance); unset FLAGS; FLAGS=(--provenance); npm publish "${FLAGS[@]}"', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'FLAGS=(--provenance) # literal flags\necho "FLAGS=(--no-provenance)"\nnpm publish "${FLAGS[@]}"', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'cat <<\'EOF\'\nFLAGS=(\n --no-provenance\n)\nEOF\nFLAGS=(--provenance)\nnpm publish "${FLAGS[@]}"', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'FLAGS=(--no-provenance) && FLAGS=(--provenance); npm publish "${FLAGS[@]}"', refused: true, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'FLAGS=(--provenance)\necho ${X:-$(FLAGS+=(--no-provenance))}\nnpm publish "${FLAGS[@]}"', refused: false, calls: ["publish --provenance", "publish --provenance"] },
  { body: 'year=2026\nmonth=10\nday=10\nyear=$((10#$year)); month=$((10#$month)); day=$((10#$day))\n((10#$year))\nnpm publish --provenance', refused: false, calls: ["publish --provenance", "publish --provenance"] },
];

for (const [index, fixture] of [...unsafe.map(/** Retain all original unsafe executions and assertions. */ (body) => ({ body, refused: true, calls: undefined })), ...scopeControls].entries()) {
  const { body, refused } = fixture;
  test(index < unsafe.length ? `real indirect publish ${index + 1} is refused despite an attested sibling` : `real Bash scope control ${index - unsafe.length + 1} preserves isolated state`, /** Assert actual argv and audit behavior against an inert registry boundary. */ () => {
    const root = mkdtempSync(join(tmpdir(), "pm-ops-indirection-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      const record = join(root, "calls");
      // Stub only the registry boundary. Bash and xargs retain their actual
      // expansion, forwarding, alias and argument ordering semantics.
      writeFileSync(join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PUBLISH_RECORD"\n');
      chmodSync(join(bin, "npm"), 0o755);
      const script = `npm publish --provenance\n${body}\n`;
      const execution = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PUBLISH_RECORD: record,
          OVERRIDE: "--provenance=false", VERB: "publish", MIDDLE: "p", PAYLOAD: "npm publish",
          REGISTRY: "https://example.invalid publish", EXTRA: " publish" },
      });
      assert.equal(execution.status, 0, execution.stderr);
      const calls = readFileSync(record, "utf8").trim().split("\n");
      if (fixture.calls !== undefined) assert.deepEqual(calls, fixture.calls, body);
      else {
        assert.ok(calls.length >= 2, `fixture did not execute its hidden publisher: ${script}`);
        assert.ok(calls.slice(1).some((call) => call.includes("publish")), calls.join("\n"));
      }
      const audit = auditPublishAttestation([{ file: "scripts/release.sh", text: script }]);
      assert.equal(audit.failures.length > 0, refused, `scope verdict disagrees: ${script}\n${calls.join("\n")}\n${audit.failures.join("\n")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("sanctioned literal bindings and non-publishing shell commands remain accepted", () => {
  for (const body of [
    "FLAG=--provenance\nnpm publish $FLAG",
    'NPM=npm\n"$NPM" publish --provenance',
    'FLAGS=(--provenance --access public)\nnpm publish "${FLAGS[@]}"',
    'deploy() { npm publish --provenance; }\ndeploy',
    'npm ci\nnpm view "$PACKAGE" version\nprintf "%s" "alias deploy=npm"\nprintf "%s\\n" main | xargs git checkout',
    'npm whoami --registry "$REGISTRY"\nnpm ping --registry "$REGISTRY"',
    'echo "npm $@"\n# alias deploy="npm publish"',
    "echo ${X:-'$(npm publish)'}",
    "echo ${X:-'`npm publish`'}",
    'echo ${X:-\\`npm publish\\`}',
    'echo ${X:-$((1 + 2))}',
    'echo $((1 + 2))\necho "$((1 + 2))"',
  ]) {
    const script = `npm publish --provenance\n${body}`;
    assert.deepEqual(auditPublishAttestation([{ file: "scripts/release.sh", text: script }]).failures, [], body);
  }
});

test("read-only npm verbs follow only known options and their operands", () => {
  for (const body of [
    'npm --registry "$REGISTRY" whoami',
    'npm --registry="$REGISTRY" ping',
    'npm --registry https://example.invalid --userconfig "$CONFIG" whoami',
    'npm --ignore-scripts --global false --json=true --registry "$REGISTRY" ping',
    'npm --no-audit --fund=false --registry "$REGISTRY" -- whoami',
    'npm -g false -w "$WORKSPACE" --registry "$REGISTRY" ping',
  ]) {
    assert.deepEqual(auditPublishAttestation([{ file: "scripts/release.sh", text: `npm publish --provenance\n${body}` }]).failures, [], body);
  }
});

test("ambiguous npm option prefixes cannot hide unresolved publishers", () => {
  for (const body of [
    'npm --unknown "$VALUE" whoami',
    'npm --unknown=value whoami "$VALUE"',
    'npm --registry $REGISTRY whoami',
    'npm --registry=$REGISTRY ping',
    'npm --registry ""$REGISTRY whoami',
    'npm --registry "$REGISTRY"$EXTRA ping',
    'npm --registry="$REGISTRY"$EXTRA ping',
    'npm --registry "${REGISTRY}"${EXTRA} whoami',
    'npm --registry "$REGISTRY"$(printf " publish") whoami',
    'npm --registry "$REGISTRY"`printf " publish"` whoami',
    'npm --registry "$@" whoami',
    'npm --registry "${UNKNOWN[@]}" ping',
    'npm --registry "$REGISTRY" "$VERB"',
    'npm --registry "$REGISTRY" "whoami$(printf suffix)"',
    'npm --registry "$REGISTRY" deploy',
    'npm --registry "$REGISTRY" publish "$FLAGS"',
    'npm --registry "$REGISTRY" --',
    'npm --registry "$REGISTRY" -- "$VERB"',
    'npm --registry "$REGISTRY" --json="$BOOLEAN" whoami',
    'npm --registry "$REGISTRY" --json=invalid ping',
    'npm --registry "$REGISTRY" --json "$BOOLEAN" whoami',
    'npm --registry "$REGISTRY" --cache',
    'xargs npm --registry "$REGISTRY" whoami',
    'pnpm --registry "$REGISTRY" whoami',
  ]) {
    assert.ok(auditPublishAttestation([{ file: "scripts/release.sh", text: `npm publish --provenance\n${body}` }]).failures.length > 0, body);
  }
});

test("quoted multiword executable values cannot disappear from recognition", () => {
  for (const script of [
    'PUB="npm publish"; "$PUB" --provenance',
    'PUB="npm publish"; "${PUB}" --provenance',
    'PUB="npm publish"; "$PUB"',
    '"$UNKNOWN" --provenance',
  ]) {
    /** Actual refusal must identify unresolved expansion so an agent receives the correct recovery boundary. */
    const failures = auditPublishAttestation([{ file: "scripts/release.sh", text: `npm publish --provenance\n${script}` }]).failures;
    assert.ok(failures.length > 0);
    assert.ok(failures.some((failure) => /cannot prove .*unresolved publish path/.test(failure)), "unresolved executables must report the expansion boundary");
  }
});

test("alias and forwarding refusal applies to manifest scripts and independent workflow steps", () => {
  const sources = [
    { file: "package.json", text: JSON.stringify({ scripts: { good: "npm publish --provenance", bad: "deploy() { npm \"$@\"; }; deploy publish" } }) },
    { file: ".github/workflows/release.yml", text: "jobs:\n  release:\n    steps:\n      - run: npm publish --provenance\n      - run: |\n          alias deploy='npm publish'\n          deploy\n" },
    { file: "action.yml", text: "runs:\n  using: composite\n  steps:\n    - run: npm publish --provenance\n    - run: |\n        deploy() { npm \"$@\"; }\n        deploy publish\n" },
  ];
  for (const source of sources) assert.ok(auditPublishAttestation([source]).failures.length > 0, source.file);
});

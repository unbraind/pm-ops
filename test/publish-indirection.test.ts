/** Real shell executions prove that indirect publishers cannot borrow sibling evidence. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditPublishAttestation } from "../attestation.ts";

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
];

for (const [index, body] of unsafe.entries()) {
  test(`real indirect publish ${index + 1} is refused despite an attested sibling`, () => {
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
          OVERRIDE: "--provenance=false", VERB: "publish", MIDDLE: "p", PAYLOAD: "npm publish" },
      });
      assert.equal(execution.status, 0, execution.stderr);
      const calls = readFileSync(record, "utf8").trim().split("\n");
      assert.ok(calls.length >= 2, `fixture did not execute its hidden publisher: ${script}`);
      assert.ok(calls.slice(1).some((call) => call.includes("publish")), calls.join("\n"));
      const audit = auditPublishAttestation([{ file: "scripts/release.sh", text: script }]);
      assert.ok(audit.failures.length > 0, `unproven invocation scanned clean: ${script}\n${calls.join("\n")}`);
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
    'echo "npm $@"\n# alias deploy="npm publish"',
  ]) {
    const script = `npm publish --provenance\n${body}`;
    assert.deepEqual(auditPublishAttestation([{ file: "scripts/release.sh", text: script }]).failures, [], body);
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

/** Compose metadata must not become shell while executable fields remain audited. */
import assert from "node:assert/strict";
import test from "node:test";
import { auditPublishAttestation, isExecutableSource, publishInvocationsIn } from "../attestation.ts";

/** A real attested sibling keeps the repository-wide non-vacuity guard satisfied. */
const sibling = { file: "scripts/release.sh", text: "npm publish --provenance" };

test("compose acceptance: an apostrophe in non-executable metadata is data", () => {
  const source = {
    file: "docker-compose.yml",
    text: "name: Don't publish docs\nservices:\n  web:\n    image: example\n    command: npm --version\n",
  };
  assert.deepEqual(auditPublishAttestation([sibling, source]).failures, []);
  assert.deepEqual(publishInvocationsIn(source), []);
});

test("compose acceptance: metadata-only override fragments have no executable bodies", () => {
  const source = { file: "compose.override.yml", text: "name: Don't publish docs\n" };
  assert.deepEqual(publishInvocationsIn(source), []);
  assert.deepEqual(auditPublishAttestation([sibling, source]).failures, []);
});

/** Audit one Compose service alongside the independent attested sibling. */
function audit(service: string, file = "compose.yml"): ReturnType<typeof auditPublishAttestation> {
  return auditPublishAttestation([sibling, { file, text: `services:\n  app:\n${service.split("\n").map(/** Keep each field inside the service mapping. */ (line) => `    ${line}`).join("\n")}\n` }]);
}

for (const file of ["docker-compose.yml", "docker-compose.prod.yaml", "compose.yml", "deploy/compose.release.yaml", "compose-ci.yml"]) {
  test(`compose filenames: ${file} is enumerated and parsed`, () => {
    assert.equal(isExecutableSource(file, ""), true);
    assert.deepEqual(audit('command: ["echo", "Don\'t", "$(npm publish)"]', file).failures, []);
    assert.equal(audit('command: ["npm", "publish"]', file).failures.length, 1);
  });
}

for (const field of ["command", "entrypoint"]) {
  for (const value of ['sh -c "npm publish"', '["sh", "-c", "npm publish"]', '["npm", "publish"]', 'npm publish']) {
    test(`compose refusal: ${field}: ${value}`, () => {
      const result = audit(`${field}: ${value}`);
      assert.equal(result.failures.length, 1, result.failures.join("\n"));
      assert.match(result.failures[0]!, /unattested artifact/u);
      assert.deepEqual(result.recognition, { kind: "recognized", count: 2 });
    });
  }
  for (const value of ['sh -ec "npm publish --provenance"', '["/bin/sh", "-c", "npm publish --provenance"]', '["npm", "publish", "--provenance"]', 'npm publish --provenance']) {
    test(`compose acceptance: ${field}: ${value}`, () => {
      const result = audit(`${field}: ${value}`);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.recognition, { kind: "recognized", count: 2 });
    });
  }
}

for (const value of ['["CMD-SHELL", "npm publish"]', 'npm publish', '["CMD", "npm", "publish"]', '["CMD", "sh", "-c", "npm publish"]']) {
  test(`compose refusal: healthcheck test ${value}`, () => {
    const result = audit(`healthcheck: {test: ${value}}`);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!, /unattested artifact/u);
  });
}

for (const value of ['["CMD-SHELL", "npm publish --provenance"]', 'npm publish --provenance', '["CMD", "npm", "publish", "--provenance"]']) {
  test(`compose acceptance: healthcheck test ${value}`, () => {
    assert.deepEqual(audit(`healthcheck: {test: ${value}}`).failures, []);
  });
}

for (const hook of ["post_start", "pre_stop", "pre_start"]) {
  test(`compose lifecycle: ${hook} string and exec commands are audited independently`, () => {
    assert.equal(audit(`${hook}:\n  - command: npm publish`).failures.length, 1);
    assert.equal(audit(`${hook}:\n  - command: [sh, -c, npm publish]`).failures.length, 1);
    assert.deepEqual(audit(`${hook}:\n  - command: [npm, publish, --provenance]`).failures, []);
    assert.equal(audit(`${hook}:\n  - command: sh -c 'FLAG=--provenance'\n  - command: sh -c 'npm publish $$FLAG'`).failures.length, 1);
  });
}

test("compose acceptance: exec arguments cannot introduce shell syntax or phantom publish coverage", () => {
  for (const command of [
    ["echo", "Don't publish docs", "npm publish", "$(npm publish)", "`npm publish`", "\n", ";", "|"],
    ["npm publish"], ["sh", "script.sh", "npm publish"], ["sh", "-c", "echo ok", "npm publish"],
    ["echo", "--provenance; npm publish"], ["env", "NOTE=npm publish", "echo", "ok"],
  ]) {
    const result = audit(`command: ${JSON.stringify(command)}`);
    assert.deepEqual(result.failures, [], JSON.stringify(command));
    assert.deepEqual(result.recognition, { kind: "recognized", count: 1 });
  }
  assert.equal(audit('command: ["npm", "publish", "--provenance; echo ignored"]').failures.length, 1,
    "an argv element is one argument, so a flag substring cannot attest");
});

test("compose acceptance: only executable fields are selected, including aliases and YAML merges", () => {
  const source = { file: "compose.yaml", text: `x-common: &common
  image: example
  command: [npm, publish, --provenance]
x-message: npm publish
services:
  one:
    <<: *common
    labels: {command: npm publish, note: "Don't"}
    build:
      args: {COMMAND: "npm publish", NOTE: "Don't"}
    environment: {command: "Don't", TEST: "$(npm publish)"}
  two: *common
  three:
    command: &release npm publish --provenance
  four:
    command: *release
` };
  const result = auditPublishAttestation([source]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.recognition, { kind: "recognized", count: 4 });
});

test("compose entrypoint and command share argv, including split shell payloads", () => {
  assert.equal(audit('entrypoint: [sh, -c]\ncommand: [npm publish]').failures.length, 1);
  assert.deepEqual(audit('entrypoint: [npm]\ncommand: [publish, --provenance]').failures, []);
  assert.deepEqual(audit('entrypoint: []\ncommand: npm publish --provenance').failures, []);
  assert.equal(audit('pre_start:\n  - entrypoint: [sh, -c]\n    command: [npm publish]').failures.length, 1);
  assert.equal(audit('entrypoint: [sh, -c]\ncommand: [echo ok]\npre_start:\n  - command: [npm publish]').failures.length, 1,
    "pre_start inherits the parent entrypoint when it is not overridden");
  assert.equal(audit('command: [npm, publish]\npre_start: [{image: example}]').failures.length, 2,
    "an inherited command also runs in the init container");
});

test("compose develop: sync+exec watch commands use the same shell and argv boundaries", () => {
  for (const command of ['npm publish', '[npm, publish]', '[sh, -c, npm publish]']) {
    assert.equal(audit(`develop:\n  watch:\n    - action: sync+exec\n      exec: {command: ${command}}`).failures.length, 1);
  }
  assert.deepEqual(audit('develop:\n  watch:\n    - action: sync+exec\n      exec: {command: [npm, publish, --provenance]}').failures, []);
  assert.deepEqual(audit('develop:\n  watch:\n    - action: sync\n      exec: {command: "Don\'t publish docs"}\n    - action: sync+exec\n      exec: {command: [echo, "$(npm publish)"]}').failures, []);
});

test("compose interpolation: host variables stay uncertain while escaped shell variables retain bindings", () => {
  assert.equal(audit('command: ["${PUBLISHER}", "publish", "--provenance"]').failures.length, 1);
  assert.equal(audit('command: [npm, publish, "${FLAG}"]').failures.length, 1);
  assert.equal(audit('command: npm --tag ${TAG} view').failures.length, 1,
    "host interpolation precedes scalar splitting and could insert a publish verb");
  assert.deepEqual(audit('command: [npm, --tag, "${TAG}", view]').failures, [],
    "exec form keeps the interpolated tag in one operand");
  assert.equal(audit('command: [sh, -c, "FLAG=--provenance; npm publish $FLAG"]').failures.length, 1);
  assert.equal(audit('healthcheck: {test: "FLAG=--provenance; npm publish $FLAG"}').failures.length, 1);
  assert.deepEqual(audit('command: [sh, -c, "FLAG=--provenance; npm publish $$FLAG"]').failures, []);
  assert.deepEqual(audit('healthcheck: {test: [CMD-SHELL, "FLAG=--provenance; npm publish $$FLAG"]}').failures, []);
});

test("compose shell words: quoting splits argv without executing shell operators", () => {
  for (const value of [
    `echo 'Don\u0027\u0027t' "npm publish"`, 'echo hello\\ world', 'echo "hello\\q"', 'echo "hello\\\\world"',
    "echo '' ; npm publish", 'echo $(npm publish)', 'echo one\\\ntwo', 'echo "one\\\ntwo"',
    '   echo ok  ', 'echo "hello\\"world"',
  ]) assert.deepEqual(audit(`command: ${JSON.stringify(value)}`).failures, [], value);
});

test("compose acceptance: empty, null, absent and disabled executable values add no publishes", () => {
  for (const service of ['image: example', 'command: null\nentrypoint: null', 'command: []', 'command: ""',
    'healthcheck: {test: [NONE]}', 'healthcheck: {disable: true}', 'pre_start: [{image: example}]',
    'post_start: []', 'develop: {watch: [{}, {action: sync+exec}]}',
    'command: [sh, -c]', 'command: [sh, -e]', 'command: [eval, echo, ok]']) {
    assert.deepEqual(audit(service).failures, [], service);
  }
  assert.deepEqual(auditPublishAttestation([sibling, { file: "compose.yml", text: "services: {}" }]).failures, []);
});

for (const text of [
  'services: [', 'services:\n  app: {command: [npm, publish}', 'services:\n  app: {command: *missing}',
  'services:\n  app: {command: npm publish, command: echo ok}', 'services: []', '', 'services: {app: null}',
  'services: {app: {command: 42}}', 'services: {app: {command: [npm, 42]}}',
  'services: {app: {command: "echo \'incomplete"}}', 'services: {app: {command: "echo \\\\"}}',
  'services: {app: {healthcheck: {test: [OTHER, npm publish]}}}',
  'services: {app: {healthcheck: {test: [CMD-SHELL]}}}',
  'services: {app: {post_start: {command: npm publish}}}', 'services: {app: {pre_stop: [42]}}',
  'services: {app: {develop: {watch: {action: sync+exec}}}}', 'services: {app: {develop: {watch: [42]}}}',
  'services: {app: {develop: {watch: [{action: "${ACTION}", exec: {command: npm publish}}]}}}',
]) {
  test(`compose fail closed: ${JSON.stringify(text)}`, () => {
    const result = auditPublishAttestation([sibling, { file: "compose.yml", text }]);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!, /executable source cannot be parsed/u);
  });
}

test("compose wrapper diagnostics retain physical YAML lines", () => {
  const result = audit('command: [semantic-release]');
  assert.match(result.failures[0]!, /compose.yml:3:.*third-party publish wrapper/u);
});

test("compose evaluators: shell option operands cannot hide command-string mode", () => {
  for (const words of [
    ["bash", "-o", "errexit", "-c", "npm publish"],
    ["bash", "-c", "-e", "npm publish"], ["bash", "-eoc", "errexit", "npm publish"],
    ["sh", "-c", "--", "npm publish"],
    ["bash", "+O", "extglob", "-ec", "npm publish"],
    ["bash", "--rcfile", "config", "-c", "npm publish"],
    ["busybox", "sh", "-c", "npm publish"],
    ["env", "sh", "-c", "npm publish"], ["eval", "npm", "publish"],
    ["sh", "${OPTIONS}", "npm publish"],
  ]) assert.equal(audit(`command: ${JSON.stringify(words)}`).failures.length, 1, JSON.stringify(words));
  assert.deepEqual(audit('command: [sh, --, script.sh, "npm publish"]').failures, []);
  assert.deepEqual(audit('command: [eval]').failures, []);
});

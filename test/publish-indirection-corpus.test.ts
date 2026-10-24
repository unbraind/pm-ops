/** Behavioral provenance regressions through real shell, Git and pm fixtures. */
import { runBashFixture } from "./bash-fixture.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "../subprocess.ts";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { auditPublishAttestation, verify } from "../scripts/verify-release-publish-attestation.ts";

/** One shell construction and its conservative acceptance verdict. */
interface IndirectionCase {
  /** Assertion label identifying the construction. */
  name: string;
  /** Shell text after a correctly attested sibling. */
  script: string;
  /** True only when every publish can be proved attested. */
  accepted: boolean;
}

const cases: readonly IndirectionCase[] = [
  { name: "unquoted command variable", script: 'PUB="npm publish"; $PUB --access public', accepted: false },
  { name: "attested unquoted command variable", script: 'PUB="npm publish"; $PUB --access public --provenance', accepted: true },
  { name: "bare scalar", script: 'NPM=npm\n$NPM publish --access public', accepted: false },
  { name: "attested bare scalar", script: 'NPM=npm\n$NPM publish --provenance', accepted: true },
  { name: "quoted assignment", script: 'NPM="npm"\n$NPM publish --access public', accepted: false },
  { name: "attested quoted assignment", script: 'NPM="npm"\n$NPM publish --provenance', accepted: true },
  { name: "quoted executable variable", script: 'PUB="npm publish"; "$PUB" --access public', accepted: false },
  { name: "quoted executable remains unproved with flag", script: 'PUB="npm publish"; "$PUB" --provenance', accepted: false },
  { name: "quoted provenance scalar", script: 'FLAG=--provenance\nnpm publish "$FLAG"', accepted: true },
  { name: "exported provenance flag", script: 'export FLAG=--provenance\nnpm publish $FLAG', accepted: true },
  { name: "readonly provenance flag", script: 'readonly FLAG=--provenance\nnpm publish $FLAG', accepted: true },
  { name: "declare provenance flag", script: 'declare FLAG=--provenance\nnpm publish $FLAG', accepted: true },
  { name: "typeset provenance flag", script: 'typeset FLAG=--provenance\nnpm publish $FLAG', accepted: true },
  { name: "local provenance flag", script: 'ship() { local FLAG=--provenance; npm publish $FLAG; }\nship', accepted: true },
  { name: "literal eval", script: 'eval "npm publish --access public"', accepted: false },
  { name: "attested literal eval", script: 'eval "npm publish --provenance"', accepted: true },
  { name: "dynamic eval", script: 'PUB="npm publish"\neval "$PUB --access public"', accepted: false },
  { name: "dynamic eval remains unproved with flag", script: 'PUB="npm publish"\neval "$PUB --provenance"', accepted: false },
  { name: "shell evaluator", script: "bash -c 'npm publish --access public'", accepted: false },
  { name: "attested shell evaluator", script: "bash -c 'npm publish --provenance'", accepted: true },
  { name: "mksh shell evaluator", script: "mksh -c 'npm publish --access public'", accepted: false },
  { name: "attested mksh evaluator", script: "mksh -c 'npm publish --provenance'", accepted: true },
  { name: "mksh evaluator payload remains unproved with flag", script: 'PUB="npm publish"\nmksh -c "$PUB --provenance"', accepted: false },
  { name: "ash shell evaluator", script: "ash -c 'npm publish --access public'", accepted: false },
  { name: "attested ash evaluator", script: "ash -c 'npm publish --provenance'", accepted: true },
  { name: "ash evaluator payload remains unproved with flag", script: 'PUB="npm publish"\nash -c "$PUB --provenance"', accepted: false },
  { name: "yash shell evaluator", script: "yash -c 'npm publish --access public'", accepted: false },
  { name: "attested yash evaluator", script: "yash -c 'npm publish --provenance'", accepted: true },
  { name: "yash evaluator payload remains unproved with flag", script: 'PUB="npm publish"\nyash -c "$PUB --provenance"', accepted: false },
  { name: "posh shell evaluator", script: "posh -c 'npm publish --access public'", accepted: false },
  { name: "attested posh evaluator", script: "posh -c 'npm publish --provenance'", accepted: true },
  { name: "posh evaluator payload remains unproved with flag", script: 'PUB="npm publish"\nposh -c "$PUB --provenance"', accepted: false },
  { name: "busybox sh shell evaluator", script: "busybox sh -c 'npm publish --access public'", accepted: false },
  { name: "attested busybox sh evaluator", script: "busybox sh -c 'npm publish --provenance'", accepted: true },
  { name: "busybox sh evaluator payload remains unproved with flag", script: 'PUB="npm publish"\nbusybox sh -c "$PUB --provenance"', accepted: false },
  { name: "busybox ash shell evaluator", script: "busybox ash -c 'npm publish --access public'", accepted: false },
  { name: "attested busybox ash evaluator", script: "busybox ash -c 'npm publish --provenance'", accepted: true },
  { name: "busybox ash evaluator payload remains unproved with flag", script: 'PUB="npm publish"\nbusybox ash -c "$PUB --provenance"', accepted: false },
  { name: "BusyBox non-shell applet keeps displayed text inert", script: "busybox echo 'npm publish'", accepted: true },
  { name: "BusyBox without an applet is not a shell evaluator", script: "busybox", accepted: true },
  { name: "wrapped BusyBox shell evaluator", script: "env /usr/bin/busybox sh -c 'npm publish --access public'", accepted: false },
  { name: "direct literal publish stays non-vacuous", script: "npm publish --provenance", accepted: true },
  { name: "unquoted array", script: 'PUB=(npm publish)\n${PUB[@]} --access public', accepted: false },
  { name: "unquoted array remains unproved with flag", script: 'PUB=(npm publish --provenance)\n${PUB[@]}', accepted: false },
  { name: "quoted array", script: 'PUB=(npm publish)\n"${PUB[@]}" --access public', accepted: false },
  { name: "quoted array remains unproved with flag", script: 'PUB=(npm publish --provenance)\n"${PUB[@]}"', accepted: false },
  { name: "alias", script: 'shopt -s expand_aliases\nalias ship="npm publish"\nship --access public', accepted: false },
  { name: "alias remains unproved with flag", script: 'shopt -s expand_aliases\nalias ship="npm publish --provenance"\nship', accepted: false },
  { name: "variable-routed alias", script: 'ALIAS=alias\nshopt -s expand_aliases\n$ALIAS ship="npm publish"\nship --access public', accepted: false },
  { name: "variable-routed alias remains unproved with flag", script: 'ALIAS=alias\nshopt -s expand_aliases\n$ALIAS ship="npm publish --provenance"\nship', accepted: false },
  { name: "variable-routed eval alias", script: 'E=eval\nshopt -s expand_aliases\n$E \'alias ship="npm publish"\'\nship --access public', accepted: false },
  { name: "variable-routed builtin eval", script: 'E="builtin eval"\nshopt -s expand_aliases\n$E \'alias ship="npm publish"\'\nship --access public', accepted: false },
  { name: "export-routed evaluator remains unproved with flag", script: 'PUB="npm publish"\nexport E=eval\n$E "$PUB --provenance"', accepted: false },
  { name: "export-routed builtin evaluator remains unproved with flag", script: 'PUB="npm publish"\nexport E="builtin eval"\n$E "$PUB --provenance"', accepted: false },
  { name: "readonly-routed evaluator remains unproved with flag", script: 'PUB="npm publish"\nreadonly E=eval\n$E "$PUB --provenance"', accepted: false },
  { name: "declare-routed evaluator remains unproved with flag", script: 'PUB="npm publish"\ndeclare E=eval\n$E "$PUB --provenance"', accepted: false },
  { name: "typeset-routed evaluator remains unproved with flag", script: 'PUB="npm publish"\ntypeset E=eval\n$E "$PUB --provenance"', accepted: false },
  { name: "flagged declare still routes an evaluator", script: 'PUB="npm publish"\ndeclare -x E=eval\n$E "$PUB --provenance"', accepted: false },
  { name: "local-routed evaluator remains unproved with flag", script: 'ship() { PUB="npm publish"; local E=eval; $E "$PUB --provenance"; }\nship', accepted: false },
  { name: "variable function forwarding", script: 'ship() { NPM=npm; $NPM "$@"; }; ship publish --access public', accepted: false },
  { name: "variable forwarding remains unproved with flag", script: 'ship() { NPM=npm; $NPM "$@"; }; ship publish --provenance', accepted: false },
  { name: "variable word forwarding", script: 'ship() { NPM=npm; $NPM$@; }; ship "" publish --access public', accepted: false },
  { name: "variable word forwarding with flag", script: 'ship() { NPM=npm; $NPM$@; }; ship "" publish --provenance', accepted: false },
  { name: "evaluator word used as literal tag", script: 'PUB="npm publish --tag eval"\n$PUB --provenance', accepted: true },
  { name: "literal array-looking argument", script: "npm publish --provenance --tag '[@]'", accepted: true },
  { name: "literal function", script: 'ship() { npm publish --access public; }; ship', accepted: false },
  { name: "attested literal function", script: 'ship() { npm publish --provenance; }; ship', accepted: true },
  { name: "forwarded function arguments", script: 'ship() { npm "$@"; }; ship publish --access public', accepted: false },
  { name: "forwarding remains unproved with flag", script: 'ship() { npm "$@"; }; ship publish --provenance', accepted: false },
  { name: "unknown program function", script: 'ship() { "$@"; }; ship npm publish --access public', accepted: false },
  { name: "line continuation", script: 'PUB="npm publish"\n$PUB \\\n --access public', accepted: false },
  { name: "attested line continuation", script: 'PUB="npm publish"\n$PUB \\\n --access public --provenance', accepted: true },
  { name: "partial executable substitution", script: 'n$(printf pm) publish --access public', accepted: false },
  { name: "partial executable substitution with flag", script: 'n$(printf pm) publish --provenance', accepted: false },
  { name: "unresolved publisher path", script: '${BIN}/npm publish --provenance', accepted: false },
  { name: "literal scalar publisher path", script: 'NPM=tools/npm\n$NPM publish --provenance', accepted: true },
  { name: "xargs input can disable provenance", script: 'printf "%s\\n" "publish --no-provenance" | xargs npm --provenance', accepted: false },
  { name: "variable-routed xargs input can disable provenance", script: 'NPM=npm\nprintf "%s\\n" "publish --no-provenance" | xargs $NPM --provenance', accepted: false },
  { name: "parallel input remains unproved with flag", script: 'parallel npm --provenance ::: publish', accepted: false },
  { name: "attested literal npx invocation", script: 'npx npm publish --provenance', accepted: true },
  { name: "unknown trailing flags", script: 'npm publish --provenance $FLAGS', accepted: false },
  { name: "dynamic npm exec", script: 'npm exec "$COMMAND"', accepted: false },
  { name: "unknown subcommand", script: 'npm "$SUBCOMMAND" --provenance', accepted: false },
  { name: "later binding cannot attest earlier use", script: 'npm publish $FLAG\nFLAG=--provenance', accepted: false },
  { name: "comment cannot attest", script: '# FLAG=--provenance\nnpm publish $FLAG', accepted: false },
  { name: "scoped binding cannot attest", script: 'FLAG=--provenance true\nnpm publish $FLAG', accepted: false },
  { name: "substitution binding cannot attest", script: '$(FLAG=--provenance)\nnpm publish $FLAG', accepted: false },
  { name: "disabled flag wins", script: 'PUB="npm publish"\n$PUB --provenance --no-provenance', accepted: false },
  { name: "displayed shell text", script: 'echo \'alias ship="npm publish"\'\necho "$FLAG"', accepted: true },
];

/**
 * Initialize a real tracker and staged release source in a disposable Git tree.
 *
 * The fixture contains a real synthetic issue. CLI environments explicitly discard inherited tracker roots.
 * A copied launcher resolves the installed dependencies but discovers only the
 * fixture's staged files; no publisher is invoked by that launcher.
 *
 * @param use - Assertions to run before the fixture is removed.
 */
async function withReleaseFixture(use: (fixture: string) => Promise<void>): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const fixture = mkdtempSync(resolve(tmpdir(), "pm-ops-publish-indirection-"));
  const env: NodeJS.ProcessEnv = { ...process.env, PM_AUTHOR: "codex-sol", PM_TELEMETRY_DISABLED: "1", PM_GLOBAL_PATH: resolve(fixture, "global") };
  env.PM_PATH = resolve(fixture, ".agents/pm");
  delete env.PM_SOURCE_PM_PATH;
  delete env.PM_SOURCE_WORKSPACE_ROOT;
  const cli = resolve(root, "node_modules/@unbrained/pm-cli/dist/cli.js");
  try {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: fixture });
    writeFileSync(resolve(fixture, "package.json"), JSON.stringify({ type: "module" }));
    execFileSync(process.execPath, [cli, "init", "--pm-path", resolve(fixture, ".agents/pm"), "--defaults", "--agent-guidance", "skip", "--prefix", "attest"], { cwd: fixture, env });
    const created: unknown = JSON.parse(execFileSync(process.execPath, [cli, "create", "Synthetic release evidence", "--type", "Issue", "--json"], { cwd: fixture, env, encoding: "utf8" }));
    assert.ok(created !== null && typeof created === "object" && "id" in created && typeof created.id === "string");
    const readBack = execFileSync(process.execPath, [cli, "get", created.id, "--json"], { cwd: fixture, env, encoding: "utf8" });
    assert.match(readBack, /Synthetic release evidence/u);
    mkdirSync(resolve(fixture, ".github/workflows"), { recursive: true });
    mkdirSync(resolve(fixture, "scripts"));
    symlinkSync(resolve(root, "node_modules"), resolve(fixture, "node_modules"), "dir");
    for (const name of ["verify-release-publish-attestation.ts", "main-invocation.ts"]) {
      copyFileSync(resolve(root, "scripts", name), resolve(fixture, "scripts", name));
    }
    for (const name of ["attestation.ts", "shell-scan.ts", "invocation-audit.ts"]) {
      symlinkSync(resolve(root, name), resolve(fixture, name));
    }
    await use(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test("publish indirection verdicts survive an attested sibling through the real entry point", async (t) => {
  await withReleaseFixture(async (fixture) => {
    const file = ".github/workflows/release.yml";
    for (const scenario of cases) {
      await t.test(scenario.name, () => {
        const script = `npm publish --provenance\n${scenario.script}`;
        writeFileSync(resolve(fixture, file), `jobs:\n  release:\n    steps:\n      - run: |\n${script.split("\n").map((line) => `          ${line}`).join("\n")}\n`);
        execFileSync("git", ["add", file], { cwd: fixture });
        const result = verify(fixture);
        assert.equal(result.failures.length === 0, scenario.accepted, `${scenario.name}: ${result.failures.join("\n")}`);
        assert.equal(result.recognition.kind, "recognized", `${scenario.name}: the sibling must be recognized`);
        if (!scenario.accepted) assert.ok(result.failures.some((failure) => failure.startsWith(`${file}:`)), scenario.name);
        const cli = spawnSync(process.execPath, [resolve(fixture, "scripts/verify-release-publish-attestation.ts")], { cwd: fixture, encoding: "utf8" });
        assert.equal(cli.status, scenario.accepted ? 0 : 1, `${scenario.name}: ${cli.stdout}${cli.stderr}`);
        assert.doesNotMatch(cli.stderr, /ERR_MODULE_NOT_FOUND|SyntaxError/u, `${scenario.name}: failure must be behavioral`);
      });
    }
  });
});

test("aliases and forwarded function arguments really reach an unattested inert publisher", async (t) => {
  await withReleaseFixture(async (fixture) => {
    const log = resolve(fixture, "publisher-calls.txt");
    for (const name of ["alias", "forwarded function arguments", "unquoted command variable", "variable-routed alias", "variable-routed eval alias", "variable-routed builtin eval", "variable function forwarding", "variable word forwarding"]) {
      await t.test(name, () => {
        const scenario = cases.find((candidate) => candidate.name === name);
        assert.ok(scenario);
        writeFileSync(log, "");
        const shell = runBashFixture(`npm() { printf '%s\\n' "$*" >> "$ATTESTATION_CALLS"; }\n${scenario.script}`, {
          cwd: fixture, env: { ...process.env, ATTESTATION_CALLS: log }, encoding: "utf8",
      });
      assert.equal(shell.status, 0, `${name}: ${shell.stderr}`);
      assert.equal(readFileSync(log, "utf8"), "publish --access public\n", `${name}: no provenance reached the publisher`);
      const result = auditPublishAttestation([{ file: "scripts/release.sh", text: `#!/bin/bash\nnpm publish --provenance\n${scenario.script}` }]);
      assert.ok(result.failures.length > 0, `${name}: an attested sibling must not mask this real path`);
      });
    }
  });
});

test("indirection is refused in manifests, inline workflows and executable scripts", () => {
  const script = 'alias ship="npm publish"; ship --access public';
  for (const source of [
    { file: "package.json", text: JSON.stringify({ scripts: { good: "npm publish --provenance", bad: script } }) },
    { file: ".github/workflows/release.yaml", text: `jobs:\n  release:\n    steps:\n      - run: npm publish --provenance\n      - run: '${script}'\n` },
    { file: "scripts/release.sh", text: `#!/bin/bash\nnpm publish --provenance\n${script}` },
  ]) {
    const result = auditPublishAttestation([source]);
    assert.ok(result.failures.some((failure) => failure.startsWith(`${source.file}:`)), source.file);
  }
  for (const source of [
    { file: ".github/workflows/release.yml", text: "jobs:\n  release:\n    steps:\n      - run: FLAG=--provenance\n      - run: npm publish $FLAG\n" },
    { file: "package.json", text: "not JSON" },
    { file: "package.json", text: JSON.stringify({ scripts: { bad: 7 } }) },
    { file: ".github/workflows/release.yml", text: "jobs: [" },
    { file: ".github/workflows/release.yml", text: "jobs:\n  release:\n    steps:\n      - run: 7\n" },
  ]) {
    const result = auditPublishAttestation([source, { file: "scripts/good.sh", text: "#!/bin/bash\nnpm publish --provenance" }]);
    assert.ok(result.failures.some((failure) => failure.startsWith(`${source.file}:`)), source.file);
  }
});


test("workflow prose and cyclic YAML references do not become executable evidence", () => {
  const result = auditPublishAttestation([{
    file: ".github/workflows/release.yml",
    text: `name: 'alias ship="npm publish"'
x-cycle: &cycle {again: *cycle}
jobs:
  release:
    steps:
      - name: display "$UNKNOWN"
        run: npm publish --provenance
`,
  }]);
  assert.deepEqual(result.failures, []);
});


test("workflow shell extraction follows only jobs steps run bodies", async (t) => {
  await withReleaseFixture(async (fixture) => {
    const file = ".github/workflows/release.yml";
    const scenarios = [
      {
        name: "env run keys are data beside an attested publish",
        metadata: `env: { run: 'alias ship="npm publish"' }`,
        jobMetadata: `    env: { run: 'alias ship="npm publish"' }`,
        stepMetadata: `        env: { run: 'alias ship="npm publish"' }`,
        body: "npm publish --provenance",
        accepted: true,
      },
      {
        name: "a real unattested publish step is refused",
        metadata: "",
        jobMetadata: "",
        stepMetadata: "",
        body: "npm publish --access public",
        accepted: false,
      },
      {
        name: "a real alias step remains unprovable",
        metadata: "",
        jobMetadata: "",
        stepMetadata: "",
        body: `alias ship="npm publish"; ship --access public`,
        accepted: false,
      },
      {
        name: "workflow and job defaults run mappings are ignored",
        metadata: "defaults: { run: { shell: bash, working-directory: . } }",
        jobMetadata: "    defaults: { run: { shell: bash, working-directory: . } }",
        stepMetadata: "",
        body: "npm publish --provenance",
        accepted: true,
      },
    ];
    for (const scenario of scenarios) {
      await t.test(scenario.name, () => {
        const workflow = `${scenario.metadata}
jobs:
  release:
${scenario.jobMetadata}
    steps:
      - uses: actions/checkout@v7
      - run: npm publish --provenance
      - run: '${scenario.body}'
${scenario.stepMetadata}
`;
        writeFileSync(resolve(fixture, file), workflow);
        execFileSync("git", ["add", file], { cwd: fixture });
        const result = verify(fixture);
        assert.equal(result.recognition.kind, "recognized");
        assert.equal(result.failures.length === 0, scenario.accepted, result.failures.join("\n"));
        const cli = spawnSync(process.execPath, [resolve(fixture, "scripts/verify-release-publish-attestation.ts")], { cwd: fixture, encoding: "utf8" });
        assert.equal(cli.status, scenario.accepted ? 0 : 1, `${cli.stdout}${cli.stderr}`);
        assert.doesNotMatch(cli.stderr, /ERR_MODULE_NOT_FOUND|SyntaxError/u);
      });
    }
  });
});


test("structured executable extraction ignores missing containers and inspects composite steps", () => {
  const sibling = { file: "scripts/good.sh", text: "npm publish --provenance" };
  for (const data of [null, [], {}, { jobs: null }, { jobs: [] }, { jobs: { a: null, b: [], c: {}, d: { steps: null },
    e: { steps: [null, [], {}, { uses: "fixture/action" }] } } }]) {
    const result = auditPublishAttestation([{ file: ".github/workflows/release.yml", text: JSON.stringify(data) }, sibling]);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.recognition, { kind: "recognized", count: 1 });
  }
  for (const data of [null, [], {}, { scripts: null }, { scripts: [] }]) {
    assert.deepEqual(auditPublishAttestation([{ file: "package.json", text: JSON.stringify(data) }, sibling]).failures, []);
  }
  for (const steps of [undefined, [null, { uses: "fixture/action" }], [{ run: "npm publish --provenance" }]]) {
    assert.deepEqual(auditPublishAttestation([{ file: "nested/action.yml", text: JSON.stringify({ runs: { using: "composite", steps } }) }, sibling]).failures, []);
  }
  for (const body of ["npm publish", 'alias ship="npm publish --provenance"; ship', 7]) {
    assert.ok(auditPublishAttestation([{ file: "action.yaml", text: JSON.stringify({ runs: { using: "composite", steps: [{ run: body }] } }) }, sibling]).failures.length > 0);
  }
  assert.deepEqual(auditPublishAttestation([{ file: "action.yml", text: "null" }, sibling]).failures, []);
});


test("wrappers and scalar routing cannot conceal dynamic evaluators", () => {
  for (const body of [
    'PUB="npm publish"; sudo -u fixture eval "$PUB --provenance"',
    'PUB="npm publish"; E=eval; $E "$PUB --provenance"',
    'PUB="npm publish"; E="builtin eval"; $E "$PUB --provenance"',
    'PUB="npm publish"; E=eval; ${E} "$PUB --provenance"',
    'PUB="npm publish"; export E=eval; $E "$PUB --provenance"',
    'PUB="npm publish"; export E="builtin eval"; $E "$PUB --provenance"',
    'PUB="npm publish"; readonly E=eval; $E "$PUB --provenance"',
    'PUB="npm publish"; readonly -x E=eval; $E "$PUB --provenance"',
    'PUB="npm publish"; declare E=eval; $E "$PUB --provenance"',
    'PUB="npm publish"; declare -x E=eval; $E "$PUB --provenance"',
    'PUB="npm publish"; typeset E=eval; $E "$PUB --provenance"',
    'PUB="npm publish"; ship() { local E=eval; $E "$PUB --provenance"; }; ship',
    'PUB="npm publish"; E=echo export F=eval; $F "$PUB --provenance"',
    'PUB="npm publish"; export E=mksh; $E "$PUB --provenance"',
    'PUB="npm publish"; export E=ash; $E "$PUB --provenance"',
  ]) {
    const result = auditPublishAttestation([{ file: "scripts/release.sh", text: `npm publish --provenance\n${body}` }]);
    assert.ok(result.failures.some((failure) => failure.includes("dynamic shell evaluator payload")), body);
  }
});

test("wrapper argument arrays cannot become phantom executable arrays", () => {
  for (const body of [
    'common=(--date-from-version); npx pm-changelog "${common[@]}" --stdout',
    'common=(--date-from-version); replace=(--output CHANGELOG.md); npx pm-changelog "${common[@]}" "${replace[@]}" --check',
  ]) {
    const result = auditPublishAttestation([{ file: "scripts/release.sh", text: `npm publish --provenance\n${body}` }]);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.recognition, { kind: "recognized", count: 1 });
  }
});

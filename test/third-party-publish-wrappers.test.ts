/** Real tracked repositories exercise dependency publishers without running their commands. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { auditPublishAttestation, verify } from "../attestation.ts";

/** One known executable and its default or explicit publish arguments. */
const wrappers = [
  ["semantic-release", ""], ["np", "patch"], ["release-it", "--ci"],
  ["lerna", "publish"], ["changeset", "publish"],
] as const;

/** Package runner spellings, including explicit package selectors and binary paths. */
const runners = [
  "", "npx ", "pnpm dlx ", "bunx ", "yarn dlx ", "npm exec ", "npm exec -- ",
  "./node_modules/.bin/", "npx --yes ", "npm exec --package=fixture -- ",
  "npx --package fixture -- ", "pnpm dlx --package fixture ",
  "yarn dlx --package fixture ", "bunx --package fixture ", "npm exec --package fixture -- ",
];

/** Repository-relative executable source shapes and their expected wrapper line. */
const surfaces = ["package.json", ".github/workflows/release.yml", "scripts/release.sh", "tools/release"];

/** Construct a tracked executable body and its physical diagnostic location. */
function sourceFor(file: string, command: string): { text: string; line: number } {
  if (file === "package.json") {
    return { text: JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { release: command } }, null, 2), line: 5 };
  }
  if (file.endsWith(".yml")) {
    return { text: `name: fixture\non: workflow_dispatch\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo preparing\n          ${command}\n`, line: 9 };
  }
  return { text: `#!/bin/sh\necho preparing\n${command}\n`, line: 3 };
}

/** Audit a disposable Git repository with an attested sibling and a never-executed sentinel. */
function scratchAudit(file: string, text: string, check: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pm-ops-publish-wrapper-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), text);
    writeFileSync(join(root, "sanctioned.sh"), "npm publish --provenance\n");
    execFileSync("git", ["add", "--", file, "sanctioned.sh"], { cwd: root });
    check(root);
    assert.equal(existsSync(join(root, "execution-sentinel")), false, "auditing must never execute a source command");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const [wrapper, args] of wrappers) {
  for (const runner of runners) {
    for (const file of surfaces) {
      test(`${file}: ${runner}${wrapper} refuses dependency provenance`, /** A direct attested sibling cannot conceal a dependency publisher. */ () => {
        const { text, line } = sourceFor(file, `touch execution-sentinel; ${runner}${wrapper} ${args}`);
        scratchAudit(file, text, (root) => {
          const result = verify(root);
          assert.deepEqual(result.recognition, { kind: "recognized", count: 2 });
          assert.equal(result.failures.length, 1);
          assert.ok(result.failures[0]!.startsWith(`${file}:${line}:`), result.failures[0]);
          assert.ok(result.failures[0]!.includes(`\`${wrapper}\``));
          assert.match(result.failures[0]!, /dependency source is outside the tracked audit boundary/);
        });
      });
    }
  }
  test(`${wrapper} alone is recognized rather than a vacuous scan`, /** Without a sibling the wrapper still contributes structured recognition. */ () => {
    scratchAudit("scripts/release.sh", `${wrapper} ${args}\n`, (root) => {
      execFileSync("git", ["rm", "--cached", "-f", "--", "sanctioned.sh"], { cwd: root });
      const result = verify(root);
      assert.deepEqual(result.recognition, { kind: "recognized", count: 1 });
      assert.equal(result.failures.length, 1);
      assert.match(result.failures[0]!, /cannot certify provenance for third-party publish wrapper/);
    });
  });
}

/** Explicit informational and non-publish controls cannot turn an operand into a publisher. */
const controls = [
  "lerna run build", "changeset version", "lerna --scope publish run build", "lerna --loglevel=info run build",
  "changeset --cwd publish version", "changeset", "lerna", "np --help", "np -h", "np --version", "np -v",
  "semantic-release --help", "release-it --version",
  "npx --package np node -e 'console.log(1)'", "npm exec --package np -- node -e 'console.log(1)'",
  "yarn dlx --package np node", "pnpm dlx --package np node", "bunx --package np node",
  "git status", "node build.mjs", "echo 'semantic-release np release-it lerna publish changeset publish'",
];
for (const control of controls) {
  for (const file of surfaces) {
    test(`${file}: control ${control} passes with sanctioned publish`, /** Preserve a real non-vacuous attested path alongside each control. */ () => {
      scratchAudit(file, sourceFor(file, control).text, (root) => assert.deepEqual(verify(root).failures, []));
    });
  }
}

/** Unknown options, dynamic verbs and claimed provenance retain fail-closed behavior. */
const uncertain = [
  "np --provenance", "semantic-release --dry-run", "release-it --no-npm", "np --no-publish",
  "lerna publish --help", "changeset publish --help", "np --help $FLAGS", "xargs np --help",
  "xargs lerna run build", "lerna $VERB", "lerna --scope", "changeset --cwd $DIR version",
  "lerna --unknown version publish", "changeset $VERB", "lerna version", "lerna --scope publish publish",
  "npx semantic-release@latest", "pnpm dlx np@10 patch", "bunx release-it@19 --ci",
  "yarn dlx lerna@9 publish", "npm exec -- @changesets/cli@2 publish", "npx @changesets/cli publish",
  "echo $(np patch)", "bash -c 'release-it --ci'", "TOOL=np\n$TOOL patch",
];
for (const command of uncertain) {
  test(`uncertified wrapper: ${command}`, /** Wrapper flags and opaque argument sources cannot certify dependency publication. */ () => {
    scratchAudit("scripts/release.sh", sourceFor("scripts/release.sh", command).text, (root) => {
      assert.ok(verify(root).failures.some((failure) => failure.includes("third-party publish wrapper")));
    });
  });
}

test("source locations ignore metadata and comments and retain repeated invocations", /** Structured ranges prevent displayed and earlier metadata words from supplying locations. */ () => {
  for (const [file, text, locations] of [
    ["package.json", '{\n "description": "np",\n "scripts": {\n "release": "np patch",\n "other": "np patch"\n }\n}', [4, 5]],
    [".github/workflows/release.yml", 'name: np\njobs:\n  release:\n    steps:\n      - name: np\n        run: |\n          # np\n          np patch\n          np patch\n', [8, 9]],
    ["scripts/release.sh", '# np\nnp patch\nnp patch\n', [2, 3]],
    [".github/workflows/release.yml", 'jobs:\n  release:\n    steps:\n      - run: >\n          npx\n          np patch\n', [6]],
    [".github/workflows/release.yml", 'jobs:\n  release:\n    steps:\n      - run: "np patch"\n', [4]],
  ] as const) {
    scratchAudit(file, text, (root) => {
      const failures = verify(root).failures;
      assert.deepEqual(failures.map((failure) => Number(failure.split(":")[1])), locations);
    });
  }
});

test("sanctioned repository workflow retains its attested publish path", /** Scan the actual tracked release source as a compatibility control. */ () => {
  const text = readFileSync(".github/workflows/release.yml", "utf8");
  const result = auditPublishAttestation([{ file: ".github/workflows/release.yml", text }]);
  assert.deepEqual(result.failures, []);
  assert.equal(result.recognition.kind, "recognized");
});

test("workflow aliases with no traversable scalar extent refuse certification", /** An attested sibling cannot conceal structured commands whose location cannot be resolved. */ () => {
  scratchAudit(".github/workflows/release.yml", "template: &job\n  steps:\n    - run: np patch\njobs:\n  release: *job\n", (root) => {
    assert.match(verify(root).failures[0]!, /executable source cannot be parsed/);
  });
});

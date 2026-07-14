import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../dist/index.js";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf-8")) as { capabilities: string[] };
const OPS_COMMANDS = ["ops scan", "ops policy", "ops verify-release", "ops report", "ops status", "ops outdated", "ops audit"] as const;

// Real fleet paths used for local real-data testing. CI and other developers
// can set PM_OPS_TEST_REPOS to opt into the same checks with their own paths.
const REAL_REPOS = (process.env.PM_OPS_TEST_REPOS ?? "")
  .split(/[,:]/)
  .map((entry) => entry.trim())
  .filter(Boolean);
const REAL_REPOS_AVAILABLE = REAL_REPOS.length >= 2 && REAL_REPOS.every((p) => existsSync(join(p, "package.json")));

interface CapturedCommand {
  name: string;
  run: (ctx: any) => Promise<unknown> | unknown;
  flags: any[];
}

function createAuditFailureBin(name: string, includeGh = false, mode: "json" | "stderr" = "json"): string {
  const bin = join(tmpRoot, name);
  mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") {
    const auditFailure = mode === "json" ? 'echo {"error":{"code":"EAI_AGAIN","summary":"registry unavailable"}}' : "echo non-JSON audit failure 1>&2";
    writeFileSync(join(bin, "npm.cmd"), `@echo off\nif "%~1"=="outdated" (echo {} & exit /b 0)\nif "%~1"=="audit" (${auditFailure} & exit /b 1)\nexit /b 1\n`);
    if (includeGh) writeFileSync(join(bin, "gh.cmd"), "@echo off\necho []\n");
  } else {
    writeFileSync(join(bin, "npm"), `#!/usr/bin/env sh
case "$1" in
  outdated) printf '{}\\n'; exit 0 ;;
  audit) ${mode === "json" ? `printf '{"error":{"code":"EAI_AGAIN","summary":"registry unavailable"}}\\n'` : `printf 'non-JSON audit failure\\n' >&2`}; exit 1 ;;
esac
exit 1
`);
    chmodSync(join(bin, "npm"), 0o755);
    if (includeGh) {
      writeFileSync(join(bin, "gh"), "#!/usr/bin/env sh\nprintf '[]\\n'\n");
      chmodSync(join(bin, "gh"), 0o755);
    }
  }
  return bin;
}

function activateAndCapture(): { commands: Map<string, CapturedCommand>; renderers: Map<string, (ctx: any) => string | null> } {
  const commands = new Map<string, CapturedCommand>();
  const renderers = new Map<string, (ctx: any) => string | null>();
  const api = {
    registerCommand: (def: any) => { commands.set(def.name, { name: def.name, run: def.run, flags: def.flags ?? [] }); },
    registerRenderer: (format: string, fn: (ctx: any) => string | null) => { renderers.set(format, fn); },
    registerParser: () => {}, registerPreflight: () => {}, registerService: () => {}, registerFlags: () => {},
    registerItemFields: () => {}, registerItemTypes: () => {}, registerMigration: () => {},
    registerImporter: () => {}, registerExporter: () => {},
    registerSearchProvider: () => {}, registerVectorStoreAdapter: () => {},
    hooks: { beforeCommand: () => {}, afterCommand: () => {}, onWrite: () => {}, onRead: () => {}, onIndex: () => {} },
  };
  (extension as any).activate(api);
  return { commands, renderers };
}

async function runCommand(commands: Map<string, CapturedCommand>, name: string, options: Record<string, unknown> = {}, args: string[] = []): Promise<unknown> {
  const cmd = commands.get(name);
  assert.ok(cmd, `command ${name} should be registered`);
  return Promise.resolve(cmd.run({ args, options, global: {}, pm_root: process.cwd() }));
}

// Build a deterministic, self-contained pm repo fixture so the integration
// tests run anywhere (CI included) without depending on absolute host paths.
// The fixture's release:check is a trivial no-op so verify-release passes
// without installing toolchain dependencies.
function buildFixture(root: string): string {
  const repo = join(root, "pm-fixture");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-fixture",
    version: "2026.7.5",
    description: "fixture repo for pm-ops tests",
    type: "module",
    main: "dist/index.js",
    scripts: {
      typecheck: "node -e \"console.log('typecheck')\"",
      build: "node -e \"console.log('build')\"",
      test: "node -e \"console.log('test')\"",
      "release:check": "node -e \"console.log('release:check ok')\"",
      changelog: "node -e \"console.log('changelog')\"",
      "changelog:check": "node -e \"console.log('changelog:check')\"",
    },
    devDependencies: { "pm-changelog": "^2026.6.13" },
  }, null, 2) + "\n");
  writeFileSync(join(repo, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" } }, null, 2) + "\n");
  writeFileSync(join(repo, "tsconfig.json"), `{
  // JSONC is valid for tsconfig files and must not disable strict detection.
  "extends": ["./tsconfig.base.json"],
  "compilerOptions": {
  },
}
`);
  writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## 2026.7.5\n\n- fixture\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Daily Release\non: [schedule]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n");
  const pmCmd = process.platform === "win32" ? "pm.cmd" : "pm";
  const pmInit = spawnSync(pmCmd, ["init", "fixture", "--pm-path", join(repo, ".agents", "pm")], { encoding: "utf-8", timeout: 30_000 });
  if (pmInit.status !== 0) {
    throw new Error(`pm init fixture failed: ${pmInit.stderr}`);
  }
  const pmCreate = spawnSync(pmCmd, ["create", "--title", "Fixture task", "--type", "Task", "--pm-path", join(repo, ".agents", "pm")], { encoding: "utf-8", timeout: 30_000 });
  if (pmCreate.status !== 0) {
    throw new Error(`pm create failed: ${pmCreate.stderr}`);
  }
  return repo;
}

let tmpRoot: string;
let fixtureRepo: string;

before(() => {
  process.env.PM_OPS_OFFLINE = "1";
  tmpRoot = mkdtempSync(join(tmpdir(), "pm-ops-test-"));
  fixtureRepo = buildFixture(tmpRoot);
});

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object");
  assert.ok("name" in extension);
  assert.ok("activate" in extension);
  assert.strictEqual(typeof (extension as any).activate, "function");
  assert.strictEqual((extension as any).name, "pm-ops");
  assert.match((extension as any).version, /^2026\./, "extension version should be a calendar version");
});

test("manifest declares capabilities required by registered command metadata", () => {
  assert.ok(manifest.capabilities.includes("commands"), "commands capability is required");
  assert.ok(manifest.capabilities.includes("renderers"), "renderers capability is required");
  assert.ok(manifest.capabilities.includes("schema"), "schema capability is required for command flags metadata");
});

test("registers the ops commands and renderers", () => {
  const { commands, renderers } = activateAndCapture();
  for (const name of OPS_COMMANDS) {
    assert.ok(commands.has(name), `should register ${name}`);
  }
  assert.ok(renderers.has("toon"), "should register a toon renderer");
  assert.ok(renderers.has("json"), "should register a json renderer");
});

test("pm SDK preserves the typed repeatable --repos contract on every command", async () => {
  const harness = await createExtensionTestHarness(extension, {
    name: "pm-ops",
    capabilities: manifest.capabilities as any,
  });

  assert.deepStrictEqual(
    harness.assertCapabilityUsage({ declared: manifest.capabilities as any, extensionName: "pm-ops" }).unused,
    [],
    "manifest capabilities should match the SDK surfaces pm-ops actually uses",
  );

  for (const command of OPS_COMMANDS) {
    const contract = harness.assertCommandContract({ command, flags: ["--repos"], arguments: ["additional-repos"] });
    const reposFlag = contract.flags.find((flag) => flag.long === "--repos");
    assert.ok(reposFlag, `${command} should expose --repos through the real SDK registry`);
    assert.strictEqual(reposFlag.value_type, "string", `${command} --repos should consume string values`);
    assert.strictEqual(reposFlag.list, true, `${command} --repos should accumulate repeated and comma-list values`);
    harness.assertParserOverride({ command, extensionName: "pm-ops" });
  }

  const structured = await harness.runParserOverride({
    command: "ops status",
    args: [],
    options: { repos: ["sdk-one", "sdk-two"] },
    global: { json: true, quiet: true, noPager: true } as any,
    pm_root: "",
  });
  assert.deepStrictEqual(
    structured.context.options.repos,
    ["sdk-one", "sdk-two"],
    "the CLI compatibility parser must leave structured SDK and MCP inputs unchanged",
  );
});

test("installed pm CLI routes --repos values to every fleet command", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pm-ops-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const project = join(root, "project");
  const home = join(root, "home");
  const appData = join(root, "app-data");
  const localAppData = join(root, "local-app-data");
  const xdgConfigHome = join(root, "xdg-config");
  const xdgDataHome = join(root, "xdg-data");
  for (const directory of [project, home, appData, localAppData, xdgConfigHome, xdgDataHome]) {
    mkdirSync(directory, { recursive: true });
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "ComSpec", "WINDIR", "LANG", "LC_ALL", "LC_CTYPE"] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    APPDATA: appData,
    HOME: home,
    LOCALAPPDATA: localAppData,
    NPM_CONFIG_USERCONFIG: devNull,
    PM_GLOBAL_PATH: join(root, "global-pm"),
    PM_OPS_OFFLINE: "1",
    PM_PATH: join(project, ".agents", "pm"),
    PM_TELEMETRY_DISABLED: "1",
    TEMP: root,
    TMP: root,
    TMPDIR: root,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
  });

  const pmBin = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "pm.cmd" : "pm");
  const runPm = (args: string[]) => spawnSync(pmBin, args, {
    cwd: project,
    encoding: "utf-8",
    env,
    timeout: 30_000,
  });
  const assertClean = (result: ReturnType<typeof runPm>, operation: string) => {
    assert.strictEqual(result.error, undefined, `${operation} should launch: ${result.error?.message ?? ""}`);
    assert.strictEqual(result.status, 0, `${operation} should pass: ${result.stderr}`);
  };

  assertClean(runPm(["init", "--json"]), "pm init");
  assertClean(runPm(["install", process.cwd(), "--project", "--json"]), "pm install pm-ops");
  const doctor = runPm(["package", "doctor", "--project", "--isolated", "--json", "--detail", "deep"]);
  assertClean(doctor, "pm package doctor");
  const doctorPayload = JSON.parse(doctor.stdout);
  const installed = doctorPayload.details?.deep?.installed_extensions?.find((entry: { name?: string }) => entry.name === "pm-ops");
  assert.ok(installed, "pm-ops should appear in isolated package diagnostics");
  assert.strictEqual(installed.activation_status, "ok");
  assert.strictEqual(installed.runtime_active, true);

  const missing = join(root, "definitely-missing");
  for (const command of OPS_COMMANDS) {
    const result = runPm([...command.split(" "), "--repos", missing, "--json"]);
    const expectsFailure = command === "ops verify-release";
    assert.strictEqual(result.error, undefined, `${command} should launch`);
    assert.strictEqual(result.status, expectsFailure ? 1 : 0, `${command} exit status: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    const repos = command === "ops report" ? payload.scan?.repos : payload.repos;
    assert.deepStrictEqual(
      repos?.map((entry: { path?: string }) => entry.path),
      [resolve(missing)],
      `${command} must use --repos instead of silently scanning cwd`,
    );
  }

  const first = join(root, "missing-one");
  const second = join(root, "missing-two");
  for (const reposArgs of [
    ["--repos", first, "--repos", second],
    [`--repos=${first}`, `--repos=${second}`],
    ["--repos", `${first},${second}`],
    ["--repos", first, second],
  ]) {
    const result = runPm(["ops", "status", ...reposArgs, "--json"]);
    assertClean(result, `pm ops status ${reposArgs.join(" ")}`);
    const payload = JSON.parse(result.stdout);
    assert.deepStrictEqual(payload.repos.map((entry: { path: string }) => entry.path), [resolve(first), resolve(second)]);
  }
});

test("ops scan produces a structured readiness snapshot for the fixture", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops scan", { repos: [fixtureRepo] })) as any;
  assert.ok(result, "scan should return a result");
  assert.ok(Array.isArray(result.repos), "result.repos should be an array");
  assert.strictEqual(result.repos.length, 1);
  assert.strictEqual(result.summary.total, 1);
  assert.strictEqual(result.summary.ready + result.summary.not_ready, 1);
  const repo = result.repos[0];
  assert.strictEqual(repo.name, "pm-fixture");
  assert.strictEqual(repo.strict_ts, true, "fixture should have strict TS");
  assert.strictEqual(repo.has_changelog, true);
  assert.strictEqual(repo.has_release_workflow, true);
  assert.strictEqual(repo.has_ci, true);
  assert.strictEqual(repo.has_pm_changelog, true);
  assert.strictEqual(repo.pm_workspace, true);
  assert.strictEqual(repo.ready, true, "fixture should be ready");
});

test("ops scan --format markdown emits a well-formed table", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops scan", { repos: [fixtureRepo], format: "markdown" })) as any;
  assert.ok(result?.pmOpsRendered === true, "markdown result should be a rendered marker");
  for (const line of (result.output as string).split("\n")) {
    if (line.startsWith("|") && line.includes("---")) continue;
    if (line.startsWith("| repo |")) continue;
    if (line.startsWith("| pm-fixture |")) {
      assert.ok(line.endsWith("|"), "data row should be wrapped in pipes");
    }
  }
  assert.match(result.output, /\| pm-fixture \|/);
});

test("ops scan reports a clear error for missing repo paths", async () => {
  const { commands } = activateAndCapture();
  const missingRepo = join(tmpRoot, "pm-missing");
  const result = (await runCommand(commands, "ops scan", { repos: [missingRepo] })) as any;
  assert.strictEqual(result.repos.length, 1);
  assert.strictEqual(result.repos[0].ready, false);
  assert.deepStrictEqual(result.repos[0].errors, ["repository directory does not exist"]);
});

test("ops scan does not report ready when an online security audit is unavailable", async () => {
  const { commands } = activateAndCapture();
  const bin = createAuditFailureBin("bin-audit-unavailable", true);
  const stderrBin = createAuditFailureBin("bin-audit-unavailable-stderr", true, "stderr");

  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  try {
    const result = (await runCommand(commands, "ops scan", { repos: [fixtureRepo] })) as any;
    assert.strictEqual(result.repos[0].ready, false);
    assert.match(result.repos[0].errors.join("\n"), /audit unavailable:.*registry unavailable/);
    const markdown = (await runCommand(commands, "ops scan", { repos: [fixtureRepo], format: "markdown" })) as any;
    assert.match(markdown.output, /audit unavailable:.*registry unavailable/);
    process.env.PM_OPS_OFFLINE = "1";
    const offline = (await runCommand(commands, "ops scan", { repos: [fixtureRepo] })) as any;
    assert.strictEqual(offline.repos[0].ready, true);
    assert.strictEqual(offline.repos[0].errors.length, 0);
    delete process.env.PM_OPS_OFFLINE;
    process.env.PATH = `${stderrBin}${delimiter}${previousPath ?? ""}`;
    const stderrOnly = (await runCommand(commands, "ops scan", { repos: [fixtureRepo] })) as any;
    assert.strictEqual(stderrOnly.repos[0].ready, false);
    assert.match(stderrOnly.repos[0].errors.join("\n"), /audit unavailable:.*non-JSON audit failure/i);
  } finally {
    process.env.PM_OPS_OFFLINE = previousOffline;
    process.env.PATH = previousPath;
  }
});

test("ops scan respects later tsconfig array extends overrides", async () => {
  const { commands } = activateAndCapture();
  const repo = join(tmpRoot, "pm-tsconfig-override");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-tsconfig-override",
    version: "2026.7.6",
    scripts: {
      typecheck: "true",
      test: "true",
      build: "true",
      "release:check": "true",
      changelog: "true",
      "changelog:check": "true",
    },
    devDependencies: { "pm-changelog": "^2026.7.6" },
  }) + "\n");
  writeFileSync(join(repo, "tsconfig.strict.json"), JSON.stringify({ compilerOptions: { strict: true } }) + "\n");
  writeFileSync(join(repo, "tsconfig.loose.json"), JSON.stringify({ compilerOptions: { strict: false } }) + "\n");
  writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ extends: ["./tsconfig.strict.json", "./tsconfig.loose.json"] }) + "\n");
  writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: CI\n");
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Release\n");

  const result = (await runCommand(commands, "ops scan", { repos: [repo] })) as any;
  assert.strictEqual(result.repos[0].strict_ts, false);
  assert.strictEqual(result.repos[0].ready, false);
});

test("ops scan expands simple repo globs", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops scan", { repos: [join(tmpRoot, "pm-*")] })) as any;
  assert.ok(result.repos.some((repo: any) => repo.name === "pm-fixture"));
});

test("ops scan expands bracket character-class globs", async () => {
  const { commands } = activateAndCapture();
  const repoA = join(tmpRoot, "pm-a");
  const repoB = join(tmpRoot, "pm-b");
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  writeFileSync(join(repoA, "package.json"), JSON.stringify({ name: "pm-a", version: "2026.7.6" }) + "\n");
  writeFileSync(join(repoB, "package.json"), JSON.stringify({ name: "pm-b", version: "2026.7.6" }) + "\n");
  const result = (await runCommand(commands, "ops scan", { repos: [join(tmpRoot, "pm-[ab]")] })) as any;
  assert.deepStrictEqual(result.repos.map((repo: any) => repo.name).sort(), ["pm-a", "pm-b"]);
});

test("ops scan handles malformed bracket globs without crashing", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops scan", { repos: [join(tmpRoot, "pm-[")] })) as any;
  assert.strictEqual(result.repos.length, 1);
  assert.strictEqual(result.repos[0].ready, false);
  assert.deepStrictEqual(result.repos[0].errors, ["repository directory does not exist"]);
});

test("ops policy: naming passes for a valid pm-* repo and fails for pm-ext-foo", async () => {
  const { commands } = activateAndCapture();
  const fakeDir = join(tmpRoot, "pm-ext-foo");
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(join(fakeDir, "package.json"), JSON.stringify({
    name: "pm-ext-foo", version: "0.0.1",
    scripts: { typecheck: "true", test: "true", build: "true", "release:check": "true", changelog: "true", "changelog:check": "true" },
    devDependencies: { "pm-changelog": "1.0.0" },
  }) + "\n");
  const result = (await runCommand(commands, "ops policy", { repos: [fixtureRepo, fakeDir] })) as any;
  assert.ok(Array.isArray(result.repos));
  const fixturePolicy = result.repos.find((r: any) => r.name === "pm-fixture");
  assert.ok(fixturePolicy, "fixture policy result should exist");
  const naming = fixturePolicy.checks.find((c: any) => c.id === "naming");
  assert.strictEqual(naming.pass, true, "pm-fixture naming should pass");

  const fakePolicy = result.repos.find((r: any) => r.path === fakeDir);
  assert.ok(fakePolicy, "fake dir policy result should exist");
  const fakeNaming = fakePolicy.checks.find((c: any) => c.id === "naming");
  assert.strictEqual(fakeNaming.pass, false, "pm-ext-foo naming should fail");
  assert.match(fakeNaming.message, /pm-ext-/);
  assert.ok(result.summary.by_severity.error >= 1, "should record at least one error-severity failure");
});

test("ops policy accepts pm-changelog in dependencies", async () => {
  const { commands } = activateAndCapture();
  const repo = join(tmpRoot, "pm-changelog-runtime");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-changelog-runtime",
    version: "2026.7.6",
    scripts: {
      typecheck: "true",
      test: "true",
      build: "true",
      "release:check": "true",
      changelog: "true",
      "changelog:check": "true",
    },
    dependencies: { "pm-changelog": "^2026.7.6" },
  }) + "\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "name: CI\n");
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Release\n");
  const result = (await runCommand(commands, "ops policy", { repos: [repo] })) as any;
  const wired = result.repos[0].checks.find((check: any) => check.id === "pm-changelog-wired");
  assert.strictEqual(wired.pass, true);

  const scan = (await runCommand(commands, "ops scan", { repos: [repo] })) as any;
  assert.strictEqual(scan.repos[0].has_pm_changelog, true);
});

test("ops policy private runner check only scans the runs-on value block", async () => {
  const { commands } = activateAndCapture();
  const repo = join(tmpRoot, "pm-private-self-hosted");
  const bin = join(tmpRoot, "bin");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-private-self-hosted",
    version: "2026.7.6",
    scripts: {
      typecheck: "true",
      test: "true",
      build: "true",
      "release:check": "true",
      changelog: "true",
      "changelog:check": "true",
    },
    devDependencies: { "pm-changelog": "^2026.7.6" },
  }) + "\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), `name: CI
on: [push]
jobs:
  test:
    runs-on:
      group: ubuntu-self-hosted
      labels:
        - self-hosted
        - ubuntu-latest
    strategy:
      matrix:
        os: [ubuntu-latest]
    steps:
      - run: echo hi
`);
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Release\n");
  writeFileSync(join(bin, "gh"), "#!/usr/bin/env sh\nprintf 'true\\n'\n");
  chmodSync(join(bin, "gh"), 0o755);

  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const result = (await runCommand(commands, "ops policy", { repos: [repo] })) as any;
    const check = result.repos[0].checks.find((entry: any) => entry.id === "private-no-runners");
    assert.strictEqual(check.pass, true);
  } finally {
    process.env.PM_OPS_OFFLINE = previousOffline;
    process.env.PATH = previousPath;
  }
});

test("ops policy private runner check flags direct GitHub-hosted runners", async () => {
  const { commands } = activateAndCapture();
  const repo = join(tmpRoot, "pm-private-github-hosted");
  const bin = join(tmpRoot, "bin-gh-hosted");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-private-github-hosted",
    version: "2026.7.6",
    scripts: {
      typecheck: "true",
      test: "true",
      build: "true",
      "release:check": "true",
      changelog: "true",
      "changelog:check": "true",
    },
    devDependencies: { "pm-changelog": "^2026.7.6" },
  }) + "\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), `name: CI
on: [push]
jobs:
  test:
    runs-on:
      - ubuntu-latest
    steps:
      - run: echo hi
`);
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Release\n");
  writeFileSync(join(bin, "gh"), "#!/usr/bin/env sh\nprintf 'true\\n'\n");
  chmodSync(join(bin, "gh"), 0o755);

  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const result = (await runCommand(commands, "ops policy", { repos: [repo] })) as any;
    const check = result.repos[0].checks.find((entry: any) => entry.id === "private-no-runners");
    assert.strictEqual(check.pass, false);
    assert.match(check.message, /GitHub-hosted/);
  } finally {
    process.env.PM_OPS_OFFLINE = previousOffline;
    process.env.PATH = previousPath;
  }
});

test("ops policy private runner check flags object labels using GitHub-hosted runners", async () => {
  const { commands } = activateAndCapture();
  const repo = join(tmpRoot, "pm-private-github-hosted-labels");
  const bin = join(tmpRoot, "bin-gh-hosted-labels");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-private-github-hosted-labels",
    version: "2026.7.6",
    scripts: {
      typecheck: "true",
      test: "true",
      build: "true",
      "release:check": "true",
      changelog: "true",
      "changelog:check": "true",
    },
    devDependencies: { "pm-changelog": "^2026.7.6" },
  }) + "\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), `name: CI
on: [push]
jobs:
  test:
    runs-on: { labels: [ubuntu-latest] }
    steps:
      - run: echo hi
`);
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Release\n");
  writeFileSync(join(bin, "gh"), "#!/usr/bin/env sh\nprintf 'true\\n'\n");
  chmodSync(join(bin, "gh"), 0o755);

  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const result = (await runCommand(commands, "ops policy", { repos: [repo] })) as any;
    const check = result.repos[0].checks.find((entry: any) => entry.id === "private-no-runners");
    assert.strictEqual(check.pass, false);
    assert.match(check.message, /GitHub-hosted/);
  } finally {
    process.env.PM_OPS_OFFLINE = previousOffline;
    process.env.PATH = previousPath;
  }
});

test("ops policy private runner check accepts flow labels with self-hosted", async () => {
  const { commands } = activateAndCapture();
  const repo = join(tmpRoot, "pm-private-flow-self-hosted");
  const bin = join(tmpRoot, "bin-flow-self-hosted");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "pm-private-flow-self-hosted",
    version: "2026.7.6",
    scripts: {
      typecheck: "true",
      test: "true",
      build: "true",
      "release:check": "true",
      changelog: "true",
      "changelog:check": "true",
    },
    devDependencies: { "pm-changelog": "^2026.7.6" },
  }) + "\n");
  writeFileSync(join(repo, ".github", "workflows", "ci.yml"), `name: CI
on: [push]
jobs:
  test:
    runs-on: { labels: [self-hosted, ubuntu-latest] }
    steps:
      - run: echo hi
`);
  writeFileSync(join(repo, ".github", "workflows", "release.yml"), "name: Release\n");
  writeFileSync(join(bin, "gh"), "#!/usr/bin/env sh\nprintf 'true\\n'\n");
  chmodSync(join(bin, "gh"), 0o755);

  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const result = (await runCommand(commands, "ops policy", { repos: [repo] })) as any;
    const check = result.repos[0].checks.find((entry: any) => entry.id === "private-no-runners");
    assert.strictEqual(check.pass, true);
  } finally {
    process.env.PM_OPS_OFFLINE = previousOffline;
    process.env.PATH = previousPath;
  }
});

test("ops policy accepts additional repo paths after --repos", async () => {
  const { commands } = activateAndCapture();
  const otherRepo = join(tmpRoot, "pm-other");
  mkdirSync(join(otherRepo, ".github", "workflows"), { recursive: true });
  writeFileSync(join(otherRepo, "package.json"), JSON.stringify({
    name: "pm-other",
    version: "2026.7.6",
    type: "module",
    scripts: {
      typecheck: "true",
      test: "true",
      build: "true",
      "release:check": "true",
      changelog: "true",
      "changelog:check": "true",
    },
    devDependencies: { "pm-changelog": "^2026.7.6" },
  }) + "\n");
  const result = (await runCommand(commands, "ops policy", { repos: [fixtureRepo] }, [otherRepo])) as any;
  assert.strictEqual(result.summary.total, 2);
  assert.deepStrictEqual(result.repos.map((r: any) => r.name), ["pm-fixture", "pm-other"]);
});

test("ops policy --strict exits non-zero on failures", async () => {
  const { commands } = activateAndCapture();
  const badDir = join(tmpRoot, "pm-bad");
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, "package.json"), JSON.stringify({ name: "pm-bad", version: "0.0.1" }) + "\n");
  await assert.rejects(
    runCommand(commands, "ops policy", { repos: [badDir], strict: true }),
    /strict mode|check\(s\) failed/,
    "strict mode should throw on failures",
  );
});

test("ops verify-release runs the release gate matrix on the fixture", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops verify-release", { repos: [fixtureRepo] })) as any;
  assert.ok(result, "verify-release should return a result");
  assert.ok(Array.isArray(result.repos));
  assert.strictEqual(result.repos.length, 1);
  const repo = result.repos[0];
  assert.ok(Array.isArray(repo.checks), "checks should be an array");
  assert.ok(repo.checks.length >= 1, "at least one release check should run");
  for (const c of repo.checks) {
    assert.ok(typeof c.name === "string");
    assert.ok(typeof c.pass === "boolean");
    assert.ok(typeof c.duration_ms === "number");
  }
  assert.strictEqual(repo.failed, 0, "fixture release:check should pass");
  assert.strictEqual(result.summary.passed, 1);
  assert.strictEqual(result.summary.failed, 0);
});

test("ops verify-release fails when no release gate scripts exist", async () => {
  const { commands } = activateAndCapture();
  const repo = join(tmpRoot, "pm-no-release");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "pm-no-release", version: "2026.7.6", scripts: {} }) + "\n");
  await assert.rejects(
    runCommand(commands, "ops verify-release", { repos: [repo] }),
    /verify-release: 1 repo\(s\) failed/,
  );
});

test("ops verify-release reports missing repo paths clearly", async () => {
  const { commands } = activateAndCapture();
  const missingRepo = join(tmpRoot, "pm-missing-release");
  await assert.rejects(
    runCommand(commands, "ops verify-release", { repos: [missingRepo] }),
    /verify-release: 1 repo\(s\) failed/,
  );
});

test("ops verify-release --output writes to a file", async () => {
  const { commands } = activateAndCapture();
  const outFile = join(tmpRoot, "verify-release.md");
  const result = (await runCommand(commands, "ops verify-release", { repos: [fixtureRepo], format: "markdown", output: outFile })) as any;
  assert.ok(result?.written_to, "should return a written_to summary");
  assert.strictEqual(result.written_to, outFile);
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(outFile, "utf-8");
  assert.match(body, /pm-ops verify-release/);
  assert.match(body, /\| pm-fixture \|/);
});

test("ops verify-release --format json --output writes JSON and creates parent directories", async () => {
  const { commands } = activateAndCapture();
  const outFile = join(tmpRoot, "reports", "verify-release.json");
  const result = (await runCommand(commands, "ops verify-release", { repos: [fixtureRepo], format: "json", output: outFile })) as any;
  assert.strictEqual(result.written_to, outFile);
  const body = readFileSync(outFile, "utf-8");
  assert.doesNotThrow(() => JSON.parse(body));
  assert.match(body, /"summary"/);
});

test("ops report --format markdown combines scan + policy into a table", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops report", { repos: [fixtureRepo], format: "markdown" })) as any;
  assert.ok(result?.pmOpsRendered === true, "report markdown should be a rendered marker");
  assert.match(result.output, /pm-ops scan/);
  assert.match(result.output, /pm-ops policy/);
  assert.match(result.output, /\| repo \|/);
  assert.match(result.output, /\| pm-fixture \|/);
  // Enhanced report should include a timestamp header
  assert.match(result.output, /Generated:/);
  assert.match(result.output, /Fleet Report/);
});

test("ops report --include-release adds verify-release section", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops report", { repos: [fixtureRepo], format: "markdown", "include-release": true })) as any;
  assert.ok(result?.pmOpsRendered === true);
  assert.match(result.output, /pm-ops scan/);
  assert.match(result.output, /pm-ops policy/);
  assert.match(result.output, /pm-ops verify-release/);
});

test("ops report --output writes to a file and returns a summary", async () => {
  const { commands } = activateAndCapture();
  const outFile = join(tmpRoot, "fleet-report.md");
  const result = (await runCommand(commands, "ops report", { repos: [fixtureRepo], format: "markdown", output: outFile })) as any;
  assert.ok(result?.written_to, "should return a written_to summary");
  assert.strictEqual(result.written_to, outFile);
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(outFile, "utf-8");
  assert.match(body, /pm-ops scan/);
  assert.match(body, /pm-ops policy/);
});

test("ops report --format json --output writes JSON and creates parent directories", async () => {
  const { commands } = activateAndCapture();
  const outFile = join(tmpRoot, "reports", "fleet-report.json");
  const result = (await runCommand(commands, "ops report", { repos: [fixtureRepo], format: "json", output: outFile })) as any;
  assert.strictEqual(result.written_to, outFile);
  const body = readFileSync(outFile, "utf-8");
  const parsed = JSON.parse(body);
  assert.ok(parsed.scan, "json report should include scan section");
  assert.ok(parsed.policy, "json report should include policy section");
});

test("ops status produces a quick fleet overview", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops status", { repos: [fixtureRepo] })) as any;
  assert.ok(result, "status should return a result");
  assert.ok(Array.isArray(result.repos));
  assert.strictEqual(result.repos.length, 1);
  assert.strictEqual(result.repos[0].name, "pm-fixture");
  assert.strictEqual(result.repos[0].ready, true, "fixture should be ready");
  assert.strictEqual(result.repos[0].issues.length, 0, "fixture should have no issues");
  assert.strictEqual(result.summary.total, 1);
  assert.strictEqual(result.summary.ready, 1);
  assert.strictEqual(result.summary.not_ready, 0);
});

test("ops status reports a clear error for missing repo paths", async () => {
  const { commands } = activateAndCapture();
  const missingRepo = join(tmpRoot, "pm-missing-status");
  const result = (await runCommand(commands, "ops status", { repos: [missingRepo] })) as any;
  assert.strictEqual(result.repos.length, 1);
  assert.strictEqual(result.repos[0].name, "pm-missing-status");
  assert.strictEqual(result.repos[0].ready, false);
  assert.deepStrictEqual(result.repos[0].issues, ["repository directory does not exist"]);
  assert.strictEqual(result.summary.not_ready, 1);
});

test("ops status does not report ready when an online security audit is unavailable", async () => {
  const { commands } = activateAndCapture();
  const bin = createAuditFailureBin("bin-status-audit-unavailable");

  const previousOffline = process.env.PM_OPS_OFFLINE;
  const previousPath = process.env.PATH;
  delete process.env.PM_OPS_OFFLINE;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  try {
    const result = (await runCommand(commands, "ops status", { repos: [fixtureRepo] })) as any;
    assert.strictEqual(result.repos[0].ready, false);
    assert.match(result.repos[0].issues.join("\n"), /audit unavailable: npm audit failed: \[EAI_AGAIN\] registry unavailable/);
    process.env.PM_OPS_OFFLINE = "1";
    const offline = (await runCommand(commands, "ops status", { repos: [fixtureRepo] })) as any;
    assert.strictEqual(offline.repos[0].ready, true);
    assert.strictEqual(offline.repos[0].issues.length, 0);
  } finally {
    process.env.PM_OPS_OFFLINE = previousOffline;
    process.env.PATH = previousPath;
  }
});

test("ops status --format markdown emits a compact table", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops status", { repos: [fixtureRepo], format: "markdown" })) as any;
  assert.ok(result?.pmOpsRendered === true);
  assert.match(result.output, /pm-ops status/);
  assert.match(result.output, /\| repo \|/);
  assert.match(result.output, /\| pm-fixture \|/);
});

test("ops audit produces a vulnerability summary", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops audit", { repos: [fixtureRepo] })) as any;
  assert.ok(result, "audit should return a result");
  assert.ok(Array.isArray(result.repos));
  assert.strictEqual(result.repos.length, 1);
  assert.ok(typeof result.summary.total === "number");
  assert.ok(typeof result.summary.clean === "number");
  assert.ok(typeof result.summary.unknown === "number");
});

test("ops audit --format markdown emits a vulnerability table", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops audit", { repos: [fixtureRepo], format: "markdown" })) as any;
  assert.ok(result?.pmOpsRendered === true);
  assert.match(result.output, /pm-ops audit/);
  assert.match(result.output, /unknown/);
  assert.match(result.output, /\| repo \|/);
  assert.match(result.output, /\| pm-fixture \|/);
});

test("ops outdated produces a dependency freshness report", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops outdated", { repos: [fixtureRepo] })) as any;
  assert.ok(result, "outdated should return a result");
  assert.ok(Array.isArray(result.repos));
  assert.strictEqual(result.repos.length, 1);
  assert.ok(typeof result.summary.total === "number");
  assert.ok(typeof result.summary.total_outdated === "number");
});

test("ops outdated --format markdown emits a well-formed report", async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops outdated", { repos: [fixtureRepo], format: "markdown" })) as any;
  assert.ok(result?.pmOpsRendered === true);
  assert.match(result.output, /pm-ops outdated/);
  assert.match(result.output, /Unable to check outdated dependencies: offline mode enabled/);
  assert.doesNotMatch(result.output, /All dependencies are up to date/);
});

// ---------------------------------------------------------------------------
// Real-data tests against the live pm fleet. These run only when the real
// repos are present (local dev on Steve's machine); they skip on CI where the
// absolute host paths do not exist. The fixture tests above cover CI.
// ---------------------------------------------------------------------------

test("real-data: scan on configured pm repos reports all ready", { skip: !REAL_REPOS_AVAILABLE }, async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops scan", { repos: REAL_REPOS })) as any;
  assert.strictEqual(result.repos.length, REAL_REPOS.length);
  for (const repo of result.repos) {
    assert.strictEqual(repo.strict_ts, true, `${repo.path} should have strict TS`);
    assert.strictEqual(repo.has_release_workflow, true, `${repo.path} should have a release workflow`);
    assert.strictEqual(repo.has_pm_changelog, true, `${repo.path} should have pm-changelog wired`);
    assert.strictEqual(repo.ready, true, `${repo.path} should be ready`);
  }
});

test("real-data: verify-release on second configured pm repo passes", { skip: !REAL_REPOS_AVAILABLE }, async () => {
  const { commands } = activateAndCapture();
  const result = (await runCommand(commands, "ops verify-release", { repos: [REAL_REPOS[1]] })) as any;
  assert.strictEqual(result.repos.length, 1);
  assert.strictEqual(result.repos[0].failed, 0, `${REAL_REPOS[1]} release:check should pass`);
  assert.strictEqual(result.summary.failed, 0);
});

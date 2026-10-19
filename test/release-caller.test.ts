/** Exercise parsed caller policy and its actual command-line entry point. */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import { checkReleaseCaller, fetchCanonicalReleaseTags, inspectReleaseCaller } from "../release-caller.ts";
import { runReleaseCaller, releaseCallerMain } from "../scripts/release-caller.ts";
import { releaseCallerFixture } from "./canonical-tags-fixture.ts";
import { runCmd } from "./command-test-helpers.ts";

const { releasedSha, canonical, caller, api } = releaseCallerFixture();

test("caller provenance rejects fork-only pins, tag mismatches and a version comment on another YAML node", () => {
  const forkSha = "f".repeat(40);
  const network = { canonical: { "v2026.10.19": releasedSha }, fork: { "v2026.10.19": forkSha } };
  assert.notEqual(network.canonical["v2026.10.19"], network.fork["v2026.10.19"]);
  assert.ok(checkReleaseCaller(caller.replace(releasedSha, forkSha)).some(error => error.includes("canonical")));
  assert.ok(checkReleaseCaller(caller.replace("v2026.10.19", "v2099.1.1")).some(error => error.includes("canonical")));
  const spoofed = caller.replace(releasedSha, forkSha).replace("  release:", `  release:\n    name: |\n      uses: unbraind/pm-ops/.github/workflows/daily-release.yml@${releasedSha} # v2026.10.19`);
  assert.ok(checkReleaseCaller(spoofed).length > 0);
  assert.ok(checkReleaseCaller(caller.replace(" # v2026.10.19", " # not-a-version")).length > 0);
  assert.ok(checkReleaseCaller(caller.replace(`uses: unbraind/pm-ops/.github/workflows/daily-release.yml@${releasedSha} # v2026.10.19`, "uses: {} # v2026.10.19")).length > 0);
});

test("caller requires the alert job issues-write permission even without an alert input", () => {
  for (const source of [caller.replace("      issues: write\n", ""), caller.replace("issues: write", "issues: read")]) {
    assert.ok(checkReleaseCaller(source).some(error => error.includes("permissions")));
  }
});

test("online provenance paginates canonical refs, peels nested annotated tags and refuses malformed or cyclic objects", () => {
  const tag = "b".repeat(40), nested = "c".repeat(40), sha = "d".repeat(40);
  const calls: string[][] = [];
  const tags = fetchCanonicalReleaseTags(args => {
    calls.push(args);
    if (args.includes("--paginate")) return `refs/tags/payload\tcommit\t${sha}\nrefs/tags/v2026.10.19\ttag\t${tag}\nrefs/tags/v2026.10.18\tcommit\t${releasedSha}\n`;
    return args[1].endsWith(tag) ? `tag\t${nested}\n` : `commit\t${sha}\n`;
  });
  assert.deepEqual(tags, { "v2026.10.19": sha, "v2026.10.18": releasedSha });
  assert.deepEqual(checkReleaseCaller(caller.replace(releasedSha, sha), tags), []);
  assert.deepEqual(calls[0], ["api", "--paginate", "repos/unbraind/pm-ops/git/refs/tags", "--jq", ".[] | [.ref, .object.type, .object.sha] | @tsv"]);
  assert.deepEqual(calls.slice(1).map(args => args[1]), [`repos/unbraind/pm-ops/git/tags/${tag}`, `repos/unbraind/pm-ops/git/tags/${nested}`]);
  assert.deepEqual(fetchCanonicalReleaseTags(() => ""), {});
  for (const response of ["blob\t" + sha, "commit\tinvalid", "tag\tinvalid", "tag\t" + tag]) {
    assert.throws(() => fetchCanonicalReleaseTags(args => args.includes("--paginate") ? `refs/tags/v2026.10.19\ttag\t${tag}` : response), /Cannot verify/);
  }
});

test("online CLI checks and metadata refresh use canonical API results and fall back only when unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "release-tags-api-"));
  const beforePath = process.env.PATH;
  try {
    const gh = join(root, "gh"), path = join(root, "release.yml"), output = join(root, "metadata.json");
    writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' 'refs/tags/v2026.10.19\tcommit\t${releasedSha}'\n`);
    chmodSync(gh, 0o755);
    process.env.PATH = `${root}:${beforePath}`;
    writeFileSync(path, caller);
    assert.equal(runReleaseCaller(path, () => assert.fail("unexpected error"), true), true);
    const moduleUrl = new URL("../scripts/release-caller.ts", import.meta.url).href;
    releaseCallerMain([process.execPath, new URL(moduleUrl).pathname, "--online", path], moduleUrl);
    releaseCallerMain([process.execPath, new URL(moduleUrl).pathname, "--write-metadata", output], moduleUrl);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), { repository: "unbraind/pm-ops", tags: { "v2026.10.19": releasedSha } });
    writeFileSync(gh, "#!/bin/sh\nexit 7\n");
    assert.equal(runReleaseCaller(path, () => {}, true), true);
  } finally {
    process.env.PATH = beforePath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("release caller accepts the rendered template and refuses embedded copies, malformed YAML and unsafe triggers", () => {
  assert.deepEqual(checkReleaseCaller(caller), []);
  const bad = ["jobs: [", "null", "jobs: []", "jobs: null", "jobs: { release: null }", "jobs: { release: { uses: wrong } }", caller.replace("contents: write", "contents: read"), caller.replace("permissions: {}", "permissions: null"), caller.replace("permissions: {}", "permissions: write-all"), caller.replace("permissions: {}", "permissions: { contents: write }"), caller.replace("      contents: write", "      packages: write\n      contents: write"), caller.replace(releasedSha, "0".repeat(40)), caller + "env: { PRIVATE_LOGIC: true }\n", caller.replace("  schedule:", "  pull_request:\n  schedule:"), caller.replace("  workflow_dispatch:", ""), caller.replace("    permissions:", "    secrets: inherit\n    permissions:"), caller.replace("    permissions:", "    with: { pm-ops-version: 2026.10.19 }\n    permissions:"), caller.replace(" # v2026.10.19", ""), caller.replace("permissions: {}", "permissions: {}\npermissions: {}")];
  for (const source of bad) assert.ok(checkReleaseCaller(source).length > 0, source);
  assert.ok(checkReleaseCaller(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")).length > 0);
});

test("release-caller CLI and pm-ops policy check report real package files", async () => {
  const root = mkdtempSync(join(tmpdir(), "release-caller-"));
  const previousExit = process.exitCode;
  try {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    const path = join(root, ".github/workflows/release.yml");
    writeFileSync(path, caller);
    const lines: string[] = [];
    assert.equal(runReleaseCaller(path, line => lines.push(line)), true);
    releaseCallerMain([process.execPath, new URL(import.meta.url).pathname], new URL("../scripts/release-caller.ts", import.meta.url).href);
    const moduleUrl = new URL("../scripts/release-caller.ts", import.meta.url).href;
    releaseCallerMain([process.execPath, new URL(moduleUrl).pathname, path], moduleUrl);
    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      releaseCallerMain([process.execPath, new URL(moduleUrl).pathname], moduleUrl);
    } finally { process.chdir(originalCwd); }
    const ext = await createExtensionTestHarness(extension, { capabilities: ["commands", "renderers", "schema", "parser", "services"] });
    const policy = join(root, "policy.json");
    writeFileSync(policy, JSON.stringify({ checks: [{ id: "release-caller", severity: "error" }] }));
    /** Read one actual policy result through the real SDK dispatch engine. */
    const check = async () => runCmd<{ repos: { checks: { pass: boolean; message: string }[] }[] }>(ext, "ops policy", { repos: [root], policy });
    assert.equal((await check()).repos[0].checks[0].pass, true);
    writeFileSync(path, caller.replace(releasedSha, "f".repeat(40)));
    assert.equal(runReleaseCaller(path, line => lines.push(line)), false);
    assert.equal((await check()).repos[0].checks[0].pass, false);
    writeFileSync(path, "jobs: {}");
    assert.equal(runReleaseCaller(path, line => lines.push(line)), false);
    assert.ok(lines.some(line => line.includes("exactly one")));
    releaseCallerMain([process.execPath, new URL(moduleUrl).pathname, path], moduleUrl);
    assert.equal(process.exitCode, 1);
    assert.equal((await check()).repos[0].checks[0].pass, false);
    rmSync(path);
    assert.match((await check()).repos[0].checks[0].message, /missing/);
    assert.throws(() => runReleaseCaller(path, () => {}), /ENOENT/);
  } finally {
    process.exitCode = previousExit;
    rmSync(root, { recursive: true, force: true });
  }
});


test("newest-release pins resolve online by default in the checker, CLI and real SDK policy; fork-only pins are refused", async () => {
  const sha = "e".repeat(40), tag = "v2099.10.19";
  const newest = caller.replace(releasedSha, sha).replace("v2026.10.19", tag);
  const root = mkdtempSync(join(tmpdir(), "newest-release-"));
  api.setTags({ ...canonical, [tag]: sha });
  try {
    assert.deepEqual(inspectReleaseCaller(newest), { status: "verified", errors: [] });
    assert.deepEqual(checkReleaseCaller(newest), []);
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    const path = join(root, ".github/workflows/release.yml"), policy = join(root, "policy.json");
    writeFileSync(path, newest);
    writeFileSync(policy, JSON.stringify({ checks: [{ id: "release-caller", severity: "error" }] }));
    const ext = await createExtensionTestHarness(extension, { capabilities: ["commands", "renderers", "schema", "parser", "services"] });
    /** Dispatch the policy through the actual SDK against real package files. */
    const check = () => runCmd<{ repos: { checks: { pass: boolean; status: string }[] }[]; summary: { passed: number; failed: number } }>(ext, "ops policy", { repos: [root], policy, strict: true });
    assert.equal(runReleaseCaller(path, () => assert.fail("unexpected diagnostic")), true);
    assert.deepEqual((await check()).repos[0].checks[0].status, "verified");
    assert.equal(inspectReleaseCaller(newest.replace(sha, "f".repeat(40))).status, "refused");
    api.setTags({});
    assert.equal(inspectReleaseCaller(caller).status, "refused", "online evidence overrides a known snapshot pin");
    api.setTags(null);
    const pending = inspectReleaseCaller(newest);
    assert.equal(pending.status, "unverified-offline");
    assert.match(pending.errors[0], /unverified-offline/);
    const lines: string[] = [];
    assert.equal(runReleaseCaller(path, line => lines.push(line)), undefined);
    assert.match(lines[0], /unverified-offline/);
    const before = process.exitCode;
    const moduleUrl = new URL("../scripts/release-caller.ts", import.meta.url).href;
    releaseCallerMain([process.execPath, new URL(moduleUrl).pathname, path], moduleUrl);
    assert.equal(process.exitCode, before);
    const policyResult = await check();
    assert.equal(policyResult.repos[0].checks[0].status, "unverified-offline");
    assert.equal(policyResult.repos[0].checks[0].pass, false);
    assert.deepEqual(policyResult.summary, { total: 1, passed: 0, failed: 0, by_severity: { error: 0, warning: 0, info: 0 } });
    assert.deepEqual(inspectReleaseCaller(caller), { status: "verified", errors: [] });
    assert.equal(inspectReleaseCaller(caller.replace(releasedSha, sha)).status, "refused");
  } finally {
    api.setTags(canonical);
    rmSync(root, { recursive: true, force: true });
  }
});

test("public API fallback supports GITHUB_TOKEN and anonymous reads without gh and peels annotated tags", () => {
  const previous = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  const tagSha = "b".repeat(40);
  api.setTags(null);
  try {
    writeFileSync(api.curl, `#!/bin/sh
cat > "$CANONICAL_TAG_FIXTURE.headers"
case "$*" in
  *matching-refs/tags/*) printf '%s' '[{"ref":"refs/tags/v2026.10.19","object":{"type":"tag","sha":"${tagSha}"}}]' ;;
  *git/tags/${tagSha}*) printf '%s' '{"object":{"type":"commit","sha":"${releasedSha}"}}' ;;
  *) exit 8 ;;
esac
`);
    delete process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = "synthetic-token";
    assert.deepEqual(fetchCanonicalReleaseTags(), canonical);
    assert.equal(readFileSync(api.refs + ".headers", "utf8"), "Authorization: Bearer synthetic-token\n");
    delete process.env.GITHUB_TOKEN;
    assert.deepEqual(fetchCanonicalReleaseTags(), canonical);
    assert.equal(readFileSync(api.refs + ".headers", "utf8"), "");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    writeFileSync(api.curl, "#!/bin/sh\nexit 7\n");
    api.setTags(canonical);
  }
});

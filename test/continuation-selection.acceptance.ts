/** Prove selector admission through one packed artifact's real npm and native Bun consumers. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir, devNull } from "node:os";
import { decode } from "@toon-format/toon";
import { spawnSync } from "../subprocess.ts";
import { npmLauncher } from "./npm-launcher.ts";
import { developmentCliVersion } from "./dependency-contract.ts";
import { continuationCliCases, continuationSelectionCases } from "./continuation-selection-corpus.ts";
import { replaceFixtureOnce, withCallerInput } from "./fixture-contracts.ts";
import { candidateFixture } from "./release-continuation-fixture.ts";

const source = process.cwd(), scratch = fs.mkdtempSync(join(tmpdir(), "selection-packed-"));
const taskEnvironment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: join(scratch, "home"),
  NPM_CONFIG_USERCONFIG: devNull, NPM_CONFIG_CACHE: join(scratch, "cache"),
  GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", PM_TELEMETRY_DISABLED: "1",
  PM_OPS_OFFLINE: "1", PM_AUTHOR: "codex-agent",
};
fs.mkdirSync(taskEnvironment.HOME!);

/** Run installed tools without credentials or inherited tracker context. */
function execute(program: string, args: string[], cwd: string, context: NodeJS.ProcessEnv = {}): string {
  const childEnvironment = { ...taskEnvironment, ...context };
  const launch = program === "npm" ? npmLauncher("npm", args, childEnvironment) : { executable: program, args };
  const result = spawnSync(launch.executable, launch.args, { cwd, env: childEnvironment, encoding: "utf8", timeout: 240_000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

try {
  const selectors = continuationSelectionCases();
  const sha = "e".repeat(40), tag = "v2099.01.01";
  const template = fs.readFileSync(join(source, "templates/release-caller.yml"), "utf8");
  const caller = replaceFixtureOnce(replaceFixtureOnce(template, "0".repeat(40), sha), "v2026.10.19", tag);
  const rows = selectors.map(row => ({ ...row, source: withCallerInput(caller, "node-version", row.selection) }));
  const cliCases = continuationCliCases(rows);
  assert.equal(cliCases.length, 6);
  execute("npm", ["pack", "--ignore-scripts", "--pack-destination", scratch], source);
  const archives = fs.readdirSync(scratch).filter(name => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const archive = join(scratch, archives[0]);
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  for (const runtime of ["npm", "bun"]) {
    const cwd = join(scratch, runtime);
    fs.mkdirSync(cwd);
    const context = { PM_PATH: join(cwd, ".agents/pm"), PM_GLOBAL_PATH: join(cwd, "global") };
    fs.writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "selection-consumer", private: true, type: "module", devDependencies: {
      "pm-ops": `file:${archive}`, "@unbrained/pm-cli": developmentCliVersion(source),
    } }));
    execute(runtime, runtime === "npm" ? ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"] : ["install", "--ignore-scripts"], cwd);
    const cli = join(cwd, "node_modules/@unbrained/pm-cli/dist/cli.js");
    /** Native Bun executes the installed CLI; npm consumers use the selected Node runtime. */
    const pm = (args: string[]) => execute(runtime === "bun" ? "bun" : process.execPath, [cli, ...args], cwd, context);
    pm(["init", "--defaults", "--agent-guidance", "skip", "--prefix", "fixture"]);
    pm(["package", "install", join(cwd, "node_modules/pm-ops"), "--project", "--json"]);
    fs.writeFileSync(join(cwd, "cases.json"), JSON.stringify(rows));
    fs.writeFileSync(join(cwd, "probe.mjs"), `
import assert from "node:assert/strict";
import fs from "node:fs";
import { inspectReleaseCaller, checkReleaseCaller } from "pm-ops/release-caller";
import { auditPublishAttestation } from "pm-ops/attestation";
import { createHash } from "node:crypto";
import { releaseDigest, verifyReleaseHandoff } from "./node_modules/pm-ops/dist/release-continuation.js";
assert.equal(fs.existsSync(".git"), false);
for (let seed = 0; seed < 32; seed++) for (const npmPublish of [false, true]) {
  const bytes = Buffer.alloc(seed * 17, seed), notes = Buffer.from("notes-" + seed);
  const candidate = { ...${JSON.stringify(candidateFixture())}, npmPublish, packageSha256: releaseDigest(bytes), notesSha256: releaseDigest(notes),
    packageIntegrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") };
  verifyReleaseHandoff(candidate, JSON.stringify(candidate), notes, bytes);
  assert.throws(() => verifyReleaseHandoff(candidate, "{}", notes, bytes), /Stale candidate artifact/);
  assert.throws(() => verifyReleaseHandoff(candidate, JSON.stringify(candidate), Buffer.concat([notes, Buffer.from("tamper")]), bytes), /Stale release notes/);
  assert.throws(() => verifyReleaseHandoff(candidate, JSON.stringify(candidate), notes, Buffer.concat([bytes, Buffer.from("tamper")])), /Stale package artifact/);
  const wrong = { ...candidate, packageIntegrity: "sha512-" + Buffer.alloc(64).toString("base64") };
  assert.throws(() => verifyReleaseHandoff(wrong, JSON.stringify(wrong), notes, bytes), /Stale package integrity/);
}
for (const row of JSON.parse(fs.readFileSync("cases.json", "utf8"))) {
  const tags = { "${tag}": "${sha}" };
  const inspected = inspectReleaseCaller(row.source, () => tags);
  assert.equal(inspected.status, row.supported ? "verified" : "refused", row.selection);
  if (!row.supported) assert.match(inspected.errors.join(" "), /22\\.18\\.0.*23\\.6\\.0/, row.selection);
  assert.equal(checkReleaseCaller(row.source, tags).length === 0, row.supported, row.selection);
  const audit = auditPublishAttestation([{ file: ".github/workflows/release.yml", text: row.source }]);
  assert.equal(audit.recognition.kind, row.supported ? "unverified-offline" : "none", row.selection);
  assert.equal(audit.failures.length === 0, row.supported, row.selection);
}
`);
    execute(runtime === "bun" ? "bun" : process.execPath, ["probe.mjs"], cwd, context);
    fs.mkdirSync(join(cwd, ".github/workflows"), { recursive: true });
    fs.writeFileSync(join(cwd, "policy.json"), JSON.stringify({ checks: [{ id: "release-caller", severity: "error" }] }));
    for (const row of cliCases) {
      fs.writeFileSync(join(cwd, ".github/workflows/release.yml"), row.source);
      for (const format of ["json", "toon"]) {
        const output = pm(["ops", "policy", "--repos", ".", "--policy", "policy.json", "--format", format]);
        const result = (format === "json" ? JSON.parse(output) : decode(output)) as { repos: { checks: { status: string; message: string }[] }[] };
        assert.equal(result.repos[0].checks[0].status, row.supported ? "unverified-offline" : "refused", `${runtime}/${format}/${row.selection}`);
        if (!row.supported) assert.match(result.repos[0].checks[0].message, /22\.18\.0.*23\.6\.0/, `${runtime}/${format}/${row.selection}`);
      }
    }
    assert.equal(fs.existsSync(join(cwd, ".git")), false);
    console.log(`${runtime}: ${rows.length} SDK/caller/attestation cases, ${cliCases.length * 2} CLI JSON/TOON checks, 64 handoff cases / 256 tamper refusals, non-git tracker PASS`);
  }
  assert.equal(createHash("sha256").update(fs.readFileSync(archive)).digest("hex"), digest);
  console.log(`Exact tarball sha256 ${digest}; both consumers PASS`);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }

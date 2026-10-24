import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "../subprocess.ts";
import { fingerprint } from "./tracker-read-helpers.ts";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decode } from "@toon-format/toon";
import { tmpdir } from "node:os";
import {
  createAssuranceWorkspaceContext, evaluateAssuranceGate, putAssuranceDeclarationBundle, recordAssuranceVerdict,
  type AssuranceDocument, type AssuranceGateVerdict, type AssuranceScope,
} from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import {
  auditEvidenceExpiry, auditEvidenceExpiryFiles, evaluateEvidenceExpiry, EvidenceExpiryRefusal,
  parseEvidenceExpiryPolicy, parseEvidenceVersions, type EvidenceExpiryPolicy, type OperationalEvidenceClaim,
} from "../evidence-expiry.ts";
import extension from "../index.ts";

const captured = "2026-10-22T10:00:00.000Z";
const now = "2026-10-22T10:01:00.000Z";
const versions = { "package:sample": "1.0.0", "backend:directory": "v1", "backend:recovery": "v1" };
let root: string;
let tracker: string;
let receipt: AssuranceGateVerdict;

/** Construct one attachment with independently scoped version dependencies. */
function claim(id = "health", overrides: Partial<OperationalEvidenceClaim> = {}): OperationalEvidenceClaim {
  return { id, kind: "health", receipt: { gate_id: "operational", tree_id: "snapshot-v1", evaluated_at: captured, assertion_id: "health" },
    scope: { kind: "all" }, max_age_seconds: 3600, versions: { "backend:directory": "v1" }, ...overrides };
}
/** Valid policy used by both filesystem and backend-neutral entrypoints. */
function policy(claims: readonly OperationalEvidenceClaim[] = [claim()]): EvidenceExpiryPolicy {
  return { version: 1, claims };
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "evidence-expiry-test-"));
  tracker = join(root, ".agents", "pm");
  const env = { ...process.env, PM_PATH: tracker, PM_AUTHOR: "expiry-test", GIT_CEILING_DIRECTORIES: dirname(root) };
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  for (const args of [["init", "--defaults", "--agent-guidance", "skip", "--prefix", "expiry"], ["create", "task", "Operational evidence fixture", "--id", "expiry-owner"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
    if (result.status !== 0) assert.fail(`Tracker initialization failed: ${result.stderr} ${result.stdout}`);
  }
  const document: AssuranceDocument = {
    version: 1,
    measurements: [{ id: "population", source: { kind: "items" } }],
    assertions: ["health", "coverage", "recovery"].map((id) => ({ id, measurement_id: "population", owner_item_id: "expiry-owner",
      scope: { kind: "all" }, floor: 1, enforcement: "block", negative_control: { cases: [{ observed: 1, expected: "pass" }, { observed: 0, expected: "fail" }] } })),
    gates: [{ id: "operational", assertion_ids: ["health", "coverage", "recovery"], triggers: ["ci"] }],
  };
  await putAssuranceDeclarationBundle(tracker, document, { author: "expiry-test" });
  const context = await createAssuranceWorkspaceContext(tracker, { tree_id: "snapshot-v1", resolve_tree: false, strict_read: true });
  receipt = { ...await evaluateAssuranceGate("operational", document, context, { trigger: "ci" }), evaluated_at: captured };
  assert.equal(receipt.verdict, "pass");
  await recordAssuranceVerdict(tracker, receipt, { author: "expiry-test" });
});
after(() => { rmSync(root, { recursive: true, force: true }); });

test("package/backend changes invalidate only the claims that bind those identities", async () => {
  const input = policy([
    claim(),
    claim("coverage", { kind: "coverage", receipt: { ...claim().receipt, assertion_id: "coverage" }, versions: { "package:sample": "1.0.0" } }),
    claim("recovery", { kind: "recovery", receipt: { ...claim().receipt, assertion_id: "recovery" }, versions: { "backend:recovery": "v1" } }),
    claim("combined", { versions: { "package:sample": "1.0.0", "backend:directory": "v1" } }),
  ]);
  const baseline = await auditEvidenceExpiry(tracker, input, versions, { now });
  assert.equal(baseline.ok, true);
  assert.deepEqual(baseline.counts, { fresh: 4, revalidate: 0, unavailable: 0 });
  for (const [key, ids] of [["package:sample", ["coverage", "combined"]], ["backend:directory", ["health", "combined"]], ["backend:recovery", ["recovery"]]] as const) {
    const result = await auditEvidenceExpiry(tracker, input, { ...versions, [key]: "v2" }, { now });
    assert.equal(result.ok, false);
    assert.deepEqual(result.rows.filter((row) => row.status === "revalidate").map((row) => row.id), ids);
    assert.ok(result.rows.filter((row) => row.status === "revalidate").every((row) => row.code === "version_changed" && row.affected[0] === key));
  }
  assert.equal(evaluateEvidenceExpiry(input, { ...versions, unrelated: "new" }, [receipt], { now }).ok, true);
});

test("exclusive expiry boundary, future timestamps and unknown current versions fail closed", () => {
  const check = (time: string, current = versions) => evaluateEvidenceExpiry(policy(), current, [receipt], { now: time });
  assert.equal(check("2026-10-22T10:59:59.999Z").ok, true);
  assert.equal(check("2026-10-22T11:00:00.000Z").rows[0]!.code, "evidence_expired");
  assert.equal(check("2026-10-22T09:59:59.999Z").rows[0]!.code, "evidence_future");
  const missing = evaluateEvidenceExpiry(policy(), {}, [receipt], { now });
  assert.equal(missing.rows[0]!.status, "unavailable");
  assert.equal(missing.rows[0]!.code, "version_unavailable");
  assert.deepEqual(missing.rows[0]!.affected, ["backend:directory"]);
  assert.equal(check(now).rows[0]!.expires_at, "2026-10-22T11:00:00.000Z");
});

test("exact receipt selectors reject substitutes, duplicate evidence and absent assertions", () => {
  const inputs = [[], [null as unknown as AssuranceGateVerdict], [{ ...receipt, assertions: [null] } as unknown as AssuranceGateVerdict], [{ ...receipt, tree_id: "snapshot-v2" }], [{ ...receipt, evaluated_at: now }], [{ ...receipt, gate_id: "other" }],
    [{ ...receipt, assertions: [] }], [receipt, receipt], [{ ...receipt, assertions: [receipt.assertions[0]!, receipt.assertions[0]!] }]];
  for (const receipts of inputs) {
    const report = evaluateEvidenceExpiry(policy(), versions, receipts, { now });
    assert.equal(report.ok, false);
    assert.equal(report.rows[0]!.code, "evidence_missing");
    assert.ok(report.rows[0]!.remedy);
  }
  assert.equal(evaluateEvidenceExpiry(policy(), versions, null, { now }).rows[0]!.code, "evidence_unavailable");
});

test("unaccepted, empty-population, projected and retired receipts are never fresh", () => {
  const modify = (fields: Partial<AssuranceGateVerdict["assertions"][number]>) => ({ ...receipt, assertions: [{ ...receipt.assertions[0]!, ...fields }], assertions_total: 1 });
  for (const changed of [{ ...receipt, dry_run: true }, { ...receipt, assertions_total: 4 },
    modify({ verdict: "fail" }), modify({ verdict: "retired" }), modify({ negative_control_proven: false }), modify({ population_size: 0 }), modify({ population_size: Number.NaN })]) {
    const result = evaluateEvidenceExpiry(policy(), versions, [changed], { now });
    assert.equal(result.rows[0]!.code, "receipt_not_accepted");
    assert.equal(result.ok, false);
  }
  // A separate assertion may fail: this attachment evaluates only its named passing assertion.
  assert.equal(evaluateEvidenceExpiry(policy(), versions, [{ ...receipt, verdict: "warn" }], { now }).ok, true);
});

test("core scope requirements distinguish all, active and named filtered populations", () => {
  for (const scope of [{ kind: "active" }, { kind: "filter", measurement_id: "population" }] as const) {
    assert.equal(evaluateEvidenceExpiry(policy([claim("health", { scope })]), versions, [receipt], { now }).rows[0]!.code, "scope_mismatch");
    const scoped = { ...receipt, assertions: [{ ...receipt.assertions[0]!, scope }], assertions_total: 1 };
    assert.equal(evaluateEvidenceExpiry(policy([claim("health", { scope })]), versions, [scoped], { now }).ok, true);
    const other = { ...scoped, assertions: [{ ...scoped.assertions[0]!, scope: { kind: "filter", measurement_id: "other" } as AssuranceScope }] };
    assert.equal(evaluateEvidenceExpiry(policy([claim("health", { scope })]), versions, [other], { now }).ok, false);
  }
});

test("agent row bounds preserve full counts and prioritize actionable refusals", () => {
  const claims = Array.from({ length: 25 }, (_, index) => claim(`claim-${index}`));
  claims.push(claim("missing", { receipt: { ...claim().receipt, assertion_id: "absent" } }));
  const result = evaluateEvidenceExpiry(policy(claims), versions, [receipt], { now, limit: 2 });
  assert.deepEqual(result.counts, { fresh: 25, revalidate: 0, unavailable: 1 });
  assert.equal(result.rows[0]!.id, "missing");
  assert.equal(result.rows.length, 2);
  assert.equal(result.total, 26);
  assert.equal(result.omitted, 24);
  assert.equal(evaluateEvidenceExpiry(policy(), versions, [receipt]).total, 1);
  assert.equal(evaluateEvidenceExpiry(policy(claims), versions, [receipt], { now }).omitted, 6);
});

test("typed input refusals reject malformed policies, scope, identity maps, dates and limits", () => {
  const invalid = [null, [], {}, { version: 2, claims: [claim()] }, policy([]), policy(Array.from({ length: 1001 }, () => claim())),
    policy([claim(), claim()]), policy([claim("bad label")]), policy([claim("x", { kind: "other" as "health" })]), policy([claim("x", { kind: null as unknown as "health" })]),
    policy([claim("x", { receipt: null as unknown as OperationalEvidenceClaim["receipt"] })]),
    ...["gate_id", "tree_id", "assertion_id", "evaluated_at"].map((key) => policy([claim("x", { receipt: { ...claim().receipt, [key]: "" } })])),
    ...[undefined, 0, -1, 1.2, Number.POSITIVE_INFINITY, 315_360_001].map((age) => policy([claim("x", { max_age_seconds: age as number })])),
    policy([claim("x", { scope: { kind: "unknown" } as unknown as AssuranceScope })]), policy([claim("x", { scope: { kind: null } as unknown as AssuranceScope })]), policy([claim("x", { versions: {} })]), policy([claim("x", { versions: null as unknown as Record<string, string> })])];
  for (const input of invalid) assert.throws(() => parseEvidenceExpiryPolicy(input), (error: unknown) => error instanceof EvidenceExpiryRefusal && error.code === "invalid_policy" && error.exitCode === 2 && !!error.remedy, JSON.stringify(input));
  for (const input of [null, [], { key: 1 }, { key: "" }, { key: " " }, { key: "x".repeat(129) }, { "bad key": "v1" }, Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`v${i}`, "1"]))]) {
    assert.throws(() => parseEvidenceVersions(input), /invalid_versions/);
  }
  for (const options of [{ now: "yesterday" }, { now: "2026-02-30T10:00:00.000Z" }, { limit: 0 }, { limit: 1001 }, { limit: 1.5 }]) {
    assert.throws(() => evaluateEvidenceExpiry(policy(), versions, [receipt], options), /invalid_options/);
  }
  assert.equal(new EvidenceExpiryRefusal("evidence_unavailable", "Retry.").exitCode, 1);
});

test("read-only SDK and CLI dispatch work in a real non-git tracker without git on PATH", async () => {
  const policyFile = join(root, "policy.json");
  const versionsFile = join(root, "versions.json");
  writeFileSync(policyFile, JSON.stringify(policy())); writeFileSync(versionsFile, JSON.stringify(versions));
  const before = fingerprint(tracker);
  const expected = await auditEvidenceExpiryFiles(tracker, policyFile, versionsFile, { now });
  assert.equal(expected.ok, true);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "renderers", "schema", "parser", "services"] });
  try {
    const result = await harness.runCommand({ command: "ops evidence-expiry", pmRoot: tracker, options: { policy: policyFile, versions: versionsFile, now, limit: "1" } });
    assert.deepEqual(result.result, expected);
    const defaulted = await harness.runCommand({ command: "ops evidence-expiry", pmRoot: tracker, options: { policy: policyFile, versions: versionsFile } });
    assert.equal((defaulted.result as { total: number }).total, 1);
    await assert.rejects(harness.runCommand({ command: "ops evidence-expiry", pmRoot: tracker }), /invalid_policy/);
  } finally { await harness.deactivate(); }
  const noGitBin = join(root, "no-git-bin"); mkdirSync(noGitBin);
  if (process.platform === "win32") writeFileSync(join(noGitBin, "placeholder"), "no git");
  else symlinkSync(process.execPath, join(noGitBin, "node"));
  // A hash in a real filename exercises URL escaping on POSIX as well as Windows.
  const probeEntry = join(root, "evidence #probe.mjs");
  writeFileSync(probeEntry, `export { auditEvidenceExpiryFiles } from ${JSON.stringify(pathToFileURL(resolve("evidence-expiry.ts")).href)};`);
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `import { auditEvidenceExpiryFiles } from ${JSON.stringify(pathToFileURL(probeEntry).href)}; console.log(JSON.stringify(await auditEvidenceExpiryFiles(...process.argv.slice(1,4), {now:process.argv[4]})));`, tracker, policyFile, versionsFile, now], {
    cwd: root, env: { ...process.env, PATH: noGitBin, PM_PATH: tracker, GIT_CEILING_DIRECTORIES: dirname(root) }, encoding: "utf8",
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(JSON.parse(probe.stdout).ok, true);
  assert.equal(existsSync(join(root, ".git")), false);
  assert.equal(fingerprint(tracker), before);
  await assert.rejects(auditEvidenceExpiryFiles(tracker, "absent.json", versionsFile), /invalid_policy/);
  await assert.rejects(auditEvidenceExpiryFiles(tracker, policyFile, "absent.json"), /invalid_versions/);
});

test("unavailable, malformed and tampered history never passes or reveals content", async () => {
  const history = join(tracker, "history", "_workspace.jsonl");
  const original = readFileSync(history, "utf8");
  try {
    for (const raw of ["{broken private data", original.replace('"gate_id":"operational"', '"gate_id":"private-data"')]) {
      assert.notEqual(raw, original);
      writeFileSync(history, raw);
      const result = await auditEvidenceExpiry(tracker, policy(), versions, { now });
      assert.equal(result.rows[0]!.code, "evidence_unavailable");
      assert.ok(!JSON.stringify(result).includes("private"));
    }
    writeFileSync(history, "");
    assert.equal((await auditEvidenceExpiry(tracker, policy(), versions, { now })).rows[0]!.code, "evidence_missing");
  } finally { writeFileSync(history, original); }
});


test("a history mutation during SDK reads refuses evidence from a mixed snapshot", async (t) => {
  const history = join(tracker, "history", "_workspace.jsonl");
  const original = readFileSync(history, "utf8");
  const read = fsPromises.readFile;
  let changed = false;
  t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof read>) => {
    const result = await read(...args);
    if (String(args[0]) === history && !changed) {
      changed = true;
      writeFileSync(history, original + "\n");
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    const report = await auditEvidenceExpiry(tracker, policy(), versions, { now });
    assert.equal(changed, true);
    assert.equal(report.rows[0]!.code, "evidence_unavailable");
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); writeFileSync(history, original);
  }
});


test("installed CLI parses agent flags, renders TOON/JSON and refuses invalid inputs without Git", () => {
  const shim = join(root, "cli-extension"); mkdirSync(shim);
  writeFileSync(join(shim, "manifest.json"), JSON.stringify({ name: "pm-ops", version: "2026.10.21", pm_min_version: "2026.10.17", entry: "./index.mjs", capabilities: ["commands", "renderers", "schema", "parser", "services"] }));
  writeFileSync(join(shim, "index.mjs"), `export { default } from ${JSON.stringify(pathToFileURL(resolve("index.ts")).href)};`);
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const env = { ...process.env, PM_PATH: tracker, GIT_CEILING_DIRECTORIES: dirname(root) };
  const installed = spawnSync(process.execPath, [cli, "package", "install", shim, "--project", "--json"], { cwd: root, env, encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stderr);
  const input = ["ops", "evidence-expiry", "--policy", join(root, "policy.json"), "--versions", join(root, "versions.json"), "--now", now, "--limit", "1"];
  const emptyPath = join(root, "empty-path"); mkdirSync(emptyPath);
  for (const format of ["toon", "json"]) {
    const result = spawnSync(process.execPath, [cli, ...input, ...(format === "json" ? ["--json"] : [])], {
      cwd: root, env: { ...env, PATH: emptyPath }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const report = (format === "json" ? JSON.parse(result.stdout) : decode(result.stdout)) as { ok: boolean; total: number };
    assert.equal(report.ok, true);
    assert.equal(report.total, 1);
  }
  const refused = spawnSync(process.execPath, [cli, ...input, "--limit", "NaN", "--json"], { cwd: root, env, encoding: "utf8" });
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stdout + refused.stderr, /invalid_options/);
});

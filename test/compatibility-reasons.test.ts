/** Exact joint conflicts, native admission agreement, boundary fuzzing and observational replay. */
import assert from "node:assert/strict";
import test from "node:test";
import * as fileSystem from "node:fs";
import * as paths from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { encode, decode } from "@toon-format/toon";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { checkExtensionManifestCompatibility } from "@unbrained/pm-cli/sdk/authoring";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { explainCompatibility, parseCompatibilityInput, readCompatibilityReasons, validateCompatibilityCounts, CompatibilityRefusal, type CompatibilityInput } from "../compatibility-reasons.ts";
import extension from "../index.ts";
import { spawnSync } from "../subprocess.ts";
import { fingerprint } from "./tracker-read-helpers.ts";

/** Three pairwise compatible pins whose joint intersection is empty. */
function fixture(): CompatibilityInput {
  return { version: 1, components: [
    { id: "host", version: "2.0.0", capabilities: ["commands", "schema"] },
    { id: "alpha", version: "1.0.0", capabilities: [] },
    { id: "beta", version: "1.0.0", capabilities: [] },
    { id: "gamma", version: "1.0.0", capabilities: [] },
  ], requirements: [
    { id: "pin-a", from: "alpha", to: "host", range: "1.0.0 || 2.0.0", capabilities: ["commands"] },
    { id: "pin-b", from: "beta", to: "host", range: "2.0.0 || 3.0.0", capabilities: ["schema"] },
    { id: "pin-c", from: "gamma", to: "host", range: "1.0.0 || 3.0.0", capabilities: [] },
  ] };
}

test("three incompatible pins return the exact minimum joint conflict and surviving compatible ranges", () => {
  const input = fixture(); const report = explainCompatibility(input);
  assert.equal(report.ok, false); assert.equal(report.preview, true);
  assert.deepEqual(report.rows[0]!.conflicts, [{ code: "joint_range_conflict", requirements: ["pin-a", "pin-b", "pin-c"], detail: "No version satisfies these declarations together." }]);
  assert.deepEqual(report.rows[0]!.compatible_ranges, []);
  assert.deepEqual(report.rows[0]!.chains, [["pin-a"], ["pin-b"], ["pin-c"]]);
  for (const [removed, witness] of [[0, "3.0.0"], [1, "1.0.0"], [2, "2.0.0"]] as const) {
    const pair = structuredClone(input); pair.requirements.splice(removed, 1); pair.components[0]!.version = witness;
    const result = explainCompatibility(pair); assert.equal(result.ok, true); assert.equal(result.rows[0]!.compatible_ranges!.length, 1);
  }
  assert.deepEqual(report.commands, [["pm", "--version"], ["pm", "extension", "list", "--json"]]);
  assert.deepEqual(parseCompatibilityInput(input), input); assert.deepEqual(decode(encode(report)), report);
  const incomplete = structuredClone(input);
  incomplete.requirements.push({ id: "unknown-extra", from: "alpha", to: "host", range: null, capabilities: [] });
  assert.deepEqual(explainCompatibility(incomplete).rows[0]!.compatible_ranges, [], "unknown metadata cannot undo a proven contradiction");
  assert.equal(Buffer.byteLength(encode(report)) < 3000, true);
});

test("known pin, capability, unknown metadata, transitive chains, cycles and prototype-shaped ids", () => {
  const input = fixture(); input.requirements = [input.requirements[0]!];
  input.components[0]!.version = "3.0.0";
  input.requirements[0]!.capabilities = ["search"];
  const bad = explainCompatibility(input).rows[0]!;
  assert.deepEqual(bad.conflicts.map((entry) => entry.code), ["installed_pin_conflict", "capability_conflict"]);
  assert.equal(bad.compatible_ranges!.length, 2);
  input.components[0]!.version = null; input.components[0]!.capabilities = null;
  input.requirements[0]!.range = "workspace:*";
  const unknown = explainCompatibility(input).rows[0]!;
  assert.equal(unknown.status, "unknown"); assert.equal(unknown.compatible_ranges, null);
  assert.deepEqual(unknown.unknown.map((entry) => entry.code), ["range_unknown", "version_unknown", "capabilities_unknown"]);
  for (const range of [null, "   ", "latest", "file:../dependency", "Infinity", "999999999999999999999999.0.0"]) {
    input.requirements[0]!.range = range; assert.equal(explainCompatibility(input).rows[0]!.status, "unknown");
  }
  input.requirements[0]!.range = "*"; input.requirements[0]!.capabilities = null; input.components[0]!.version = "garbage";
  assert.equal(explainCompatibility(input).rows[0]!.unknown.length, 2);
  input.requirements[0]!.capabilities = []; input.components[0]!.version = "1.0.0";
  assert.equal(explainCompatibility(input).ok, true, "missing support cannot make an explicitly empty requirement unknown");
  input.requirements.push({ id: "upstream", from: "beta", to: "alpha", range: "*", capabilities: [] });
  assert.deepEqual(explainCompatibility(input).rows.find((row) => row.component.id === "host")!.chains, [["upstream", "pin-a"]]);
  input.requirements.push({ id: "cycle", from: "host", to: "beta", range: "*", capabilities: [] });
  assert.deepEqual(explainCompatibility(input).rows.find((row) => row.component.id === "host")!.chains, [["pin-a"]]);
  input.components.push({ id: "constructor", version: "1.0.0", capabilities: [] });
  input.requirements.push({ id: "__proto__", from: "constructor", to: "host", range: "*", capabilities: [] });
  assert.equal(explainCompatibility(input).ok, true);
});

test("native extension bounds agree with SDK including malformed, inclusive and unknown metadata", () => {
  const input = fixture(); input.requirements = [{ ...input.requirements[0]!, range: "*" }];
  for (const version of [null, "unknown", "2026.10.19", "2026.10.20", "2026.10.27", "2026.10.28"]) {
    for (const manifest of [{ pm_min_version: "2026.10.20", pm_max_version: "2026.10.27" }, {}, { pm_min_version: "invalid" }, { pm_max_version: ">=2026.10.20" }]) {
      input.components[0]!.version = version; input.requirements[0]!.manifest = manifest;
      const expected = checkExtensionManifestCompatibility(manifest, { pmVersion: version ?? "unknown" });
      const report = explainCompatibility(input).rows[0]!;
      assert.deepEqual(report.conflicts.filter((entry) => entry.code === "extension_bound_conflict").map((entry) => entry.detail), expected.findings.filter((entry) => entry.severity === "error").map((entry) => entry.code));
      for (const finding of expected.findings.filter((entry) => entry.severity === "warning")) assert.ok(report.unknown.some((entry) => entry.code === finding.code));
    }
  }
  // Exercise a real unsupported loader configuration, without mocking the SDK.
  const moduleUrl = pathToFileURL(paths.resolve("compatibility-reasons.ts")).href;
  const program = `import { explainCompatibility } from ${JSON.stringify(moduleUrl)}; try { explainCompatibility(${JSON.stringify(input)}); process.exitCode=1; } catch (error) { console.log(JSON.stringify({code:error.code,remedy:error.remedy})); }`;
  const unsupported = spawnSync(process.execPath, ["--no-experimental-require-module", "--input-type=module", "-e", program], { encoding: "utf8" });
  assert.equal(unsupported.status, 0, unsupported.stderr);
  const failure = JSON.parse(unsupported.stdout) as { code: string; remedy: string };
  assert.equal(failure.code, "compatibility_sdk_unavailable"); assert.match(failure.remedy, /supported pm host/);
});

test("strict boundary refuses invalid structures and extremes while permitting released metadata shapes", () => {
  const input = fixture();
  for (const value of [null, [], {}, { ...input, extra: true }, { ...input, version: 2 },
    ...[null, [], Array(1), Array(17).fill(input.components[0])].map((components) => ({ ...input, components })),
    ...[null, [], Array(1), Array(13).fill(input.requirements[0])].map((requirements) => ({ ...input, requirements }))]) {
    assert.throws(() => parseCompatibilityInput(value), CompatibilityRefusal);
  }
  for (const patch of [{ id: "" }, { id: "/private" }, { id: "../private" }, { version: 1 }, { version: "" }, { version: "x".repeat(257) }, { capabilities: Array(1) }, { capabilities: ["a", "a"] }, { capabilities: ["a".repeat(97)] }, { capabilities: Array(17).fill("a") }, { extra: 1 }]) {
    assert.throws(() => explainCompatibility({ ...input, components: [{ ...input.components[0], ...patch }, ...input.components.slice(1)] }), CompatibilityRefusal);
  }
  for (const patch of [{ id: "" }, { from: 1 }, { from: "absent" }, { to: 1 }, { to: "absent" }, { range: false }, { capabilities: {} },
    { manifest: null }, { manifest: [] }, { manifest: { unsupported: "x" } }, { manifest: { pm_min_version: false } }, { extra: 1 }]) {
    assert.throws(() => explainCompatibility({ ...input, requirements: [{ ...input.requirements[0], ...patch }] }), CompatibilityRefusal);
  }
  const holeWithProperty = Object.assign(Array(1), { extra: "value" });
  assert.throws(() => parseCompatibilityInput({ ...input, components: holeWithProperty }), CompatibilityRefusal);
  assert.throws(() => explainCompatibility({ ...input, components: [...input.components, input.components[0]] }), CompatibilityRefusal);
  assert.throws(() => explainCompatibility({ ...input, requirements: [input.requirements[0], input.requirements[0]] }), CompatibilityRefusal);
  const alternatives = "1 || 2 || 3 || 4";
  const large = { ...input, requirements: Array.from({ length: 5 }, (_, index) => ({ ...input.requirements[0]!, id: `r${index}`, range: alternatives })) };
  assert.throws(() => explainCompatibility(large), CompatibilityRefusal);
  large.requirements.pop(); assert.equal(explainCompatibility(large).rows[0]!.compatible_ranges!.length, 1, "wide alternatives stay exact in a compact conjunction");
  large.requirements.push({ ...input.requirements[0]!, id: "unrestricted", range: "*" });
  assert.ok(explainCompatibility(large).rows[0]!.compatible_ranges![0]!.includes("*"));
  assert.throws(() => explainCompatibility(Object.create(input)), CompatibilityRefusal);
  assert.deepEqual(parseCompatibilityInput(Object.assign(Object.create(null), input)), input);
  const optionalUndefined = structuredClone(input); optionalUndefined.requirements[0]!.manifest = undefined;
  const canonical = parseCompatibilityInput(optionalUndefined);
  assert.deepEqual(JSON.parse(JSON.stringify(canonical)), canonical);
  assert.deepEqual(decode(encode(explainCompatibility(optionalUndefined))), explainCompatibility(optionalUndefined));
  const refusal = new CompatibilityRefusal("invalid_compatibility_input", "Supply metadata.");
  assert.equal(refusal.exitCode, 2); assert.equal(refusal.remedy, "Supply metadata.");
  for (const number of [NaN, Infinity, -Infinity, -1, 0, 0.5, 17, Number.MAX_VALUE, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => explainCompatibility({ ...input, version: number }), CompatibilityRefusal);
    assert.throws(() => validateCompatibilityCounts({ compatible: number, incompatible: 0, unknown: 0 }, 1), CompatibilityRefusal);
    assert.throws(() => validateCompatibilityCounts({ compatible: 1, incompatible: 0, unknown: 0 }, number), CompatibilityRefusal);
  }
  for (const counts of [{ compatible: 1, incompatible: 0, unknown: 0, extra: 0 }, { compatible: 1, incompatible: 0, other: 0 }, { compatible: 0, incompatible: 0, unknown: 0 }]) {
    assert.throws(() => validateCompatibilityCounts(counts as { compatible: number; incompatible: number; unknown: number }, 1), CompatibilityRefusal);
  }
  validateCompatibilityCounts({ compatible: 16, incompatible: 0, unknown: 0 }, 16);
});

test("range boundary corpus includes unions, empty ranges, prereleases, wildcard and maximum input", () => {
  const input = fixture(); input.requirements = [{ ...input.requirements[0]!, capabilities: [] }];
  for (const [range, version, status] of [
    [">=1.0.0 <=2.0.0", "2.0.0", "compatible"], [">1.0.0 <2.0.0", "2.0.0", "incompatible"],
    ["^1.2.3", "1.9.0", "compatible"], ["~1.2.3", "1.3.0", "incompatible"],
    [">=1.0.0-alpha <1.0.0", "1.0.0-beta", "compatible"], ["<0.0.0-0", "0.0.0", "incompatible"],
    [">1.0.0 >=1.0.1-alpha <1.0.1", "1.0.1-alpha", "compatible"],
    [">1.0.0-alpha.1 <1.0.0-alpha.1.1", "1.0.0-alpha.1.0", "compatible"],
    ["*", "0.0.0", "compatible"], ["<1 >2", "1.0.0", "incompatible"],
    ["1.0.0+build", "1.0.0", "compatible"], ["1 - 2", "2.9.0", "compatible"],
  ] as const) {
    input.requirements[0]!.range = range; input.components[0]!.version = version;
    assert.equal(explainCompatibility(input).rows[0]!.status, status, range);
  }
  for (const version of [`1.0.${Number.MAX_SAFE_INTEGER}`, `1.${Number.MAX_SAFE_INTEGER}.${Number.MAX_SAFE_INTEGER}`, `${Number.MAX_SAFE_INTEGER}.${Number.MAX_SAFE_INTEGER}.${Number.MAX_SAFE_INTEGER}`]) {
    input.components[0]!.version = version; input.requirements[0]!.range = `>=${version}`;
    assert.equal(explainCompatibility(input).ok, true);
  }
  input.components[0]!.version = "1.0.0-beta";
  input.requirements = [{ ...input.requirements[0]!, range: ">=1.0.0-alpha" }, { ...input.requirements[0]!, id: "stable-only", range: "*" }];
  assert.equal(explainCompatibility(input).rows[0]!.conflicts[0]!.code, "installed_pin_conflict");
  // Independent integer patch lattice exercises every inclusive/exclusive boundary exactly.
  let seed = 97241;
  for (let trial = 0; trial < 500; trial++) {
    const draw = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed; };
    const lower = draw() % 6; const upper = draw() % 6; const inclusiveLower = (draw() % 3) === 0; const inclusiveUpper = (draw() % 3) === 0;
    input.requirements = [{ ...input.requirements[0]!, range: `${inclusiveLower ? ">=" : ">"}1.0.${lower} ${inclusiveUpper ? "<=" : "<"}1.0.${upper}` }];
    input.components[0]!.version = `1.0.${draw() % 6}`;
    const exists = Array.from({ length: 6 }, (_, patch) => patch).some((patch) => (inclusiveLower ? patch >= lower : patch > lower) && (inclusiveUpper ? patch <= upper : patch < upper));
    assert.equal(explainCompatibility(input).rows[0]!.compatible_ranges!.length > 0, exists);
  }
  input.components = Array.from({ length: 16 }, (_, index) => ({ id: `c${index}`, version: "1.0.0", capabilities: [] }));
  input.requirements = Array.from({ length: 12 }, (_, index) => ({ id: `r${index}`, from: "c0", to: `c${index}`, range: "*", capabilities: [] }));
  assert.equal(explainCompatibility(input).rows.length, 12);
});

/** Independent finite-domain set model for exact-version unions, including minimum conflict cardinality. */
function verifyModel(input: CompatibilityInput): void {
  const allowed = input.requirements.map((entry) => entry.range!.trim().split(/\s*\|\|\s*/));
  const common = ["1.0.0", "2.0.0", "3.0.0", "4.0.0"].filter((version) => allowed.every((set) => set.includes(version)));
  const row = explainCompatibility(input).rows[0]!;
  assert.equal(row.compatible_ranges!.length > 0, common.length > 0);
  if (!common.length) {
    const conflict = row.conflicts.find((entry) => entry.code === "joint_range_conflict")!;
    const subsets = Array.from({ length: 2 ** allowed.length - 1 }, (_, mask) => allowed.filter((_, index) => ((mask + 1) & (1 << index)) !== 0));
    const minimum = Math.min(...subsets.filter((sets) => !["1.0.0", "2.0.0", "3.0.0", "4.0.0"].some((version) => sets.every((set) => set.includes(version)))).map((sets) => sets.length));
    assert.equal(conflict.requirements.length, minimum);
  } else assert.equal(row.status, common.includes(input.components[0]!.version!) ? "compatible" : "incompatible");
}

test("500 seeded operation sequences replay JSON/TOON/CRLF inputs and preserve all SDK-read native fields and relationships", async () => {
  const root = fileSystem.mkdtempSync(paths.join(tmpdir(), "compat-model-")); const tracker = paths.join(root, ".agents", "pm");
  const cli = paths.resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const env = { ...process.env, PM_PATH: tracker, GIT_CEILING_DIRECTORIES: paths.dirname(root) };
  try {
    for (const args of [["init", "--defaults", "--agent-guidance", "skip", "--prefix", "compat"],
      ["create", "task", "Relation target", "--id", "compat-a", "--parent", "none"],
      ["create", "task", "  exact\r\ntext  ", "--id", "compat-b", "--parent", "compat-a", "--description", " spaced\r\nbody ", "--tags", "model,synthetic", "--priority", "1"]]) {
      const initialized = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", cwd: root });
      assert.equal(initialized.status, 0, initialized.stderr);
    }
    const reader = new PmClient({ noExtensions: true, pmRoot: tracker });
    const corpus = await reader.listAllComplete();
    const referenceState = new Map(await Promise.all(corpus.items.map(async ({ id }) => [id, await reader.get(id)] as const)));
    let seed = 0xc0ffee; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const past: CompatibilityInput[] = [];
    for (let sequence = 0; sequence < 500; sequence++) {
      const before = fingerprint(tracker);
      let current = fixture(); current.components[0]!.capabilities = [];
      for (const entry of current.requirements) entry.capabilities = [];
      for (let operation = 0; operation < 6; operation++) {
        const action = Math.floor(random() * 5);
        if (action === 0 && past.length) current = structuredClone(past[Math.floor(random() * past.length)]!);
        if (action === 1) current.components[0]!.version = `${1 + Math.floor(random() * 4)}.0.0`;
        if (action === 2) current.requirements[Math.floor(random() * 3)]!.range = ["1.0.0", "2.0.0", "3.0.0", "4.0.0"].filter(() => random() > 0.4).join(" || ") || "1.0.0";
        if (action === 3) current.requirements[0]!.range = ` \r\n${current.requirements[0]!.range!.trim()} \r\n`;
        if (action === 4) current = parseCompatibilityInput(decode(encode(current)));
        verifyModel(current);
        const input = paths.join(root, "metadata.json"); fileSystem.writeFileSync(input, JSON.stringify(current, null, 2).replace(/\n/g, "\r\n"));
        const report = readCompatibilityReasons(input); assert.deepEqual(report, explainCompatibility(current));
        assert.deepEqual(decode(encode(report)), report); assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
        validateCompatibilityCounts(report.counts, report.rows.length);
      }
      past.push(structuredClone(current));
      assert.equal(fingerprint(tracker), before);
      for (const [id, expected] of referenceState) assert.deepEqual(await reader.get(id), expected);
    }
    assert.equal(fileSystem.existsSync(paths.join(root, ".git")), false);
    for (const raw of ["{", " ".repeat(65537), Buffer.from([0xff])]) {
      fileSystem.writeFileSync(paths.join(root, "metadata.json"), raw); assert.throws(() => readCompatibilityReasons(paths.join(root, "metadata.json")), /compatibility_input_unreadable/);
    }
    assert.throws(() => readCompatibilityReasons(root), CompatibilityRefusal);
    assert.throws(() => readCompatibilityReasons(paths.join(root, "absent")), CompatibilityRefusal);
  } finally { fileSystem.rmSync(root, { recursive: true, force: true }); }
});

test("CLI JSON and TOON agree with SDK outside Git with no git executable; refusals have remedies", async () => {
  const harness = await createExtensionTestHarness(extension, { name: "pm-ops", capabilities: ["commands", "renderers", "schema", "parser", "services"] });
  const root = fileSystem.mkdtempSync(paths.join(tmpdir(), "compat-cli-"));
  try {
    const input = paths.join(root, "input.json"); fileSystem.writeFileSync(input, JSON.stringify(fixture()));
    assert.deepEqual((await harness.runCommand({ command: "ops compatibility", options: { input }, global: { json: false }, pmRoot: root })).result, { pmOpsRendered: true, output: encode(explainCompatibility(fixture())) });
    assert.deepEqual((await harness.runCommand({ command: "ops compatibility", options: { input }, global: { json: true }, pmRoot: root })).result, { pmOpsRendered: true, output: JSON.stringify(explainCompatibility(fixture())) });
    await assert.rejects(harness.runCommand({ command: "ops compatibility", options: {}, pmRoot: root }), /Supply --input/);
    const cli = paths.resolve("node_modules/@unbrained/pm-cli/dist/cli.js"); const tracker = paths.join(root, ".agents", "pm");
    const env = { ...process.env, PM_PATH: tracker, GIT_CEILING_DIRECTORIES: paths.dirname(root), PATH: "" };
    const invoke = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
    assert.equal(invoke(["init", "--defaults", "--agent-guidance", "skip"]).status, 0);
    const shim = paths.join(root, "extension"); fileSystem.mkdirSync(shim);
    fileSystem.writeFileSync(paths.join(shim, "manifest.json"), JSON.stringify({ name: "pm-ops", version: "2026.10.26", entry: "./extension.mjs", capabilities: ["commands", "renderers", "schema", "parser", "services"] }));
    fileSystem.writeFileSync(paths.join(shim, "extension.mjs"), `export { default } from ${JSON.stringify(pathToFileURL(paths.resolve("dist/index.js")).href)};`);
    const install = invoke(["package", "install", shim, "--project", "--json"]); assert.equal(install.status, 0, install.stderr);
    for (const json of [true, false]) {
      const result = invoke(["ops", "compatibility", "--input", input, ...(json ? ["--json"] : [])]);
      const actualReport = json ? JSON.parse(result.stdout) : decode(result.stdout);
      assert.deepEqual(actualReport, explainCompatibility(fixture()));
      assert.equal(result.status, 0, result.stderr);
      assert.ok(Buffer.byteLength(result.stdout) < 5000);
    }
    const missing = invoke(["ops", "compatibility"]); assert.equal(missing.status, 2); assert.match(missing.stderr, /Supply --input/);
  } finally { await harness.deactivate(); fileSystem.rmSync(root, { recursive: true, force: true }); }
});

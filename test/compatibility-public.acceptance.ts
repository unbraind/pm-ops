/** Read-only public export acceptance. argv[2] is a non-Git public package export, never a live tracker. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { EXTENSION_CAPABILITIES } from "@unbrained/pm-cli/sdk/authoring";
import { encode, decode } from "@toon-format/toon";
import { auditConfiguredBackends } from "../backend-capabilities.ts";
import { explainCompatibility, type CompatibilityInput } from "../compatibility-reasons.ts";
import { fingerprint } from "./tracker-read-helpers.ts";

const exported = path.resolve(process.argv[2]!);
assert.equal(fs.existsSync(path.join(exported, ".git")), false);
const tracker = path.join(exported, ".agents", "pm");
const pkg = JSON.parse(fs.readFileSync(path.join(exported, "package.json"), "utf8")) as { name: string; version: string; peerDependencies: Record<string, string>; devDependencies: Record<string, string> };
const manifest = JSON.parse(fs.readFileSync(path.join(exported, "manifest.json"), "utf8")) as { capabilities: string[]; pm_min_version: string };
const before = fingerprint(exported);
const matrix = await auditConfiguredBackends([{ id: "public-copy", kind: "directory", root: tracker, operations: ["list", "get", "schema"] }], exported);
assert.equal(matrix.ok, true); assert.equal(matrix.counts.supported, 3);
const metadata: CompatibilityInput = { version: 1, components: [
  { id: pkg.name, version: pkg.version, capabilities: manifest.capabilities },
  { id: "host", version: pkg.devDependencies["@unbrained/pm-cli"]!, capabilities: [...EXTENSION_CAPABILITIES] },
], requirements: [
  { id: "package-peer", from: pkg.name, to: "host", range: pkg.peerDependencies["@unbrained/pm-cli"]!, capabilities: [] },
  { id: "extension-host", from: pkg.name, to: "host", range: `>=${manifest.pm_min_version}`, capabilities: manifest.capabilities,
    manifest: { pm_min_version: manifest.pm_min_version } },
] };
const report = explainCompatibility(metadata); assert.equal(report.ok, true);
assert.deepEqual(JSON.parse(JSON.stringify(report)), report); assert.deepEqual(decode(encode(report)), report);
assert.equal(fingerprint(exported), before);
console.log(JSON.stringify({ package: pkg.name, package_version: pkg.version, host_version: metadata.components[1]!.version,
  sdk_reads: matrix.rows.map(({ operation, checked }) => ({ operation, checked })), components: metadata.components.length,
  requirements: report.requirements.length, compatibility: report.counts, json_bytes: Buffer.byteLength(JSON.stringify(report)),
  toon_bytes: Buffer.byteLength(encode(report)), source_bytes_unchanged: true }));

/** Authenticate real public npm provenance and refuse forged claims and signer substitutions. */
import "./provenance-trust-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdirSync, readFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "../subprocess.ts";
import { verifyRegistryProvenance, verifySigstoreBundle, verifyCertificateSource, type ProvenanceIdentity } from "../release-provenance.ts";
import { runVerifyRegistryProvenance } from "../scripts/verify-registry-provenance.ts";
import { verifyRegistryProvenance as verifyCompiledProvenance } from "../dist/release-provenance.js";

const identity: ProvenanceIdentity = { repository: "sigstore/sigstore-js", workflow: ".github/workflows/release.yml", ref: "refs/heads/main",
  commit: "c1dc7d4778a450787fc72b083f2490ad02b714c6", integrity: "sha512-endqECJkfhozrXMK5ngu/UAA0xVcVEFdnHJCElGaExypjW+HK5i6zu3NteLoaX/iFbRUbC3+DjttQs0GARr+5w==" };

/** Read independent signed bytes afresh for each destructive mutation. */
function envelope() {
  return JSON.parse(readFileSync(new URL("fixtures/provenance/sigstore-4.1.1.json", import.meta.url), "utf8")) as {
    attestations: { predicateType: string; bundle: { dsseEnvelope: { payload: string; signatures: { sig: string }[] } } }[];
  };
}

/** Select the SLSA bundle, keeping the npm publish attestation in the full envelope. */
function slsa(value = envelope()) { return value.attestations.find(entry => entry.predicateType === "https://slsa.dev/provenance/v1")!; }

/** Read or alter claims without changing their signature, which must then fail. */
function mutateClaim(value: ReturnType<typeof envelope>, change: (claim: { predicate: { buildDefinition: { externalParameters: { workflow: Record<string, string> } } } }) => void): void {
  const entry = slsa(value), claim = JSON.parse(Buffer.from(entry.bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  change(claim); entry.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(claim)).toString("base64");
}

test("real npm Sigstore bundle verifies once and replay verifies without trusting decoded JSON alone", async () => {
  assert.equal(await verifyRegistryProvenance(envelope(), { ...identity, signerWorkflow: `${identity.repository}/${identity.workflow}@${identity.ref}` }), true);
  assert.equal(await verifyRegistryProvenance(envelope(), identity), true);
  assert.equal(await verifyCompiledProvenance(envelope(), identity), true);
  const forged = envelope(); slsa(forged).bundle.dsseEnvelope.signatures[0].sig = Buffer.alloc(70).toString("base64");
  await assert.rejects(verifyRegistryProvenance(forged, identity));
  const tampered = envelope(); mutateClaim(tampered, claim => { claim.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/other/package"; });
  await assert.rejects(verifyRegistryProvenance(tampered, { ...identity, repository: "other/package" }));
});

test("valid signatures from another repository, workflow or ref cannot authorize recovery", async () => {
  for (const change of [{ repository: "other/package" }, { workflow: ".github/workflows/foreign.yml" }, { ref: "refs/heads/foreign" }]) {
    assert.equal(await verifyRegistryProvenance(envelope(), { ...identity, ...change }), false);
    await assert.rejects(verifySigstoreBundle(slsa().bundle, { ...identity, ...change }));
  }
  await assert.rejects(verifySigstoreBundle(slsa().bundle, { ...identity, signerWorkflow: "other/shared/.github/workflows/release.yml@" + "a".repeat(40) }));
  for (const source of [{ repository: "other/package" }, { commit: "0".repeat(40) }, { ref: "refs/heads/other" }]) {
    await assert.rejects(verifySigstoreBundle(slsa().bundle, { ...identity, ...source, signerWorkflow: `${identity.repository}/${identity.workflow}@${identity.ref}` }), /certificate source/);
  }
  for (const change of [{ commit: "0".repeat(40) }, { integrity: `sha512-${Buffer.alloc(64).toString("base64")}` }]) {
    assert.equal(await verifyRegistryProvenance(envelope(), { ...identity, ...change }), false);
  }
  for (const value of [null, [], {}, { attestations: {} }, { attestations: [null, { predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: "e30=" } } }] }]) {
    assert.equal(await verifyRegistryProvenance(value, identity), false);
  }
});

test("registry verifier CLI binds the caller identity and fails closed on malformed or forged envelopes", async () => {
  const values = { GITHUB_REPOSITORY: identity.repository, CALLER_WORKFLOW: `${identity.repository}/${identity.workflow}@refs/heads/main`, EXPECTED_COMMIT: identity.commit, EXPECTED_INTEGRITY: identity.integrity };
  const saved = new Map([...Object.keys(values), "PROVENANCE_SIGNER_WORKFLOW"].map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    assert.equal(await runVerifyRegistryProvenance(envelope()), true);
    process.env.PROVENANCE_SIGNER_WORKFLOW = `${identity.repository}/${identity.workflow}@${identity.ref}`;
    assert.equal(await runVerifyRegistryProvenance(envelope()), true);
    process.env.PROVENANCE_SIGNER_WORKFLOW = "wrong"; await assert.rejects(runVerifyRegistryProvenance(envelope()), /signer identity/);
    delete process.env.PROVENANCE_SIGNER_WORKFLOW;
    for (const key of Object.keys(values)) { const value = process.env[key]; delete process.env[key]; await assert.rejects(runVerifyRegistryProvenance(envelope()), /identity/); process.env[key] = value; }
  } finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  for (const [input, status] of [[JSON.stringify(envelope()), 0], ["{}", 1]] as const) {
    const result = spawnSync(process.execPath, ["--import", new URL("provenance-trust-fixture.ts", import.meta.url).href, new URL("../scripts/verify-registry-provenance.ts", import.meta.url).pathname], { input, encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH, ...values } });
    assert.equal(result.status, status, result.stderr);
  }
  const root = mkdtempSync(join(tmpdir(), "provenance-cli-"));
  try {
    const forged = envelope(); slsa(forged).bundle.dsseEnvelope.signatures[0].sig = "broken";
    writeFileSync(join(root, "proof.json"), JSON.stringify(forged));
    const result = spawnSync(process.execPath, [new URL("../scripts/verify-registry-provenance.ts", import.meta.url).pathname], { input: readFileSync(join(root, "proof.json")), encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH, ...values } });
    assert.equal(result.status, 1); assert.notEqual(result.stderr, "");
    mkdirSync(join(root, "scripts"));
    for (const path of ["release-provenance.ts", "subprocess.ts", "scripts/verify-registry-provenance.ts", "scripts/release-runtime.ts", "scripts/main-invocation.ts"]) cpSync(new URL("../" + path, import.meta.url), join(root, path));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    const privateModules = join(root, ".github/release-runtime/node_modules"); mkdirSync(privateModules, { recursive: true });
    symlinkSync(dirname(createRequire(import.meta.url).resolve("sigstore/package.json")), join(privateModules, "sigstore"), "junction");
    /** Execute identical real verification in either supported installation layout. */
    const runIsolated = () => spawnSync(process.execPath, ["--import", new URL("provenance-trust-fixture.ts", import.meta.url).href, join(root, "scripts/verify-registry-provenance.ts")], { input: JSON.stringify(envelope()), encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH, ...values } });
    let isolated = runIsolated();
    assert.equal(isolated.status, 0, isolated.stderr);
    rmSync(join(root, ".github"), { recursive: true });
    symlinkSync(new URL("../node_modules", import.meta.url).pathname, join(root, "node_modules"), "junction");
    isolated = runIsolated();
    assert.equal(isolated.status, 0, isolated.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("authenticated source OIDs accept long repository identities and refuse missing certificate claims", () => {
  const expected = { ...identity, repository: "o".repeat(39) + "/" + "r".repeat(100) };
  const repo = "https://github.com/" + expected.repository;
  assert.equal(Buffer.byteLength(repo), 159);
  const certificate = { oids: [
    { oid: undefined, value: Buffer.alloc(0) },
    { oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, 12] }, value: Buffer.concat([Buffer.from([12, 129, 159]), Buffer.from(repo)]) },
    { oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, 13] }, value: Buffer.concat([Buffer.from([12, 40]), Buffer.from(expected.commit)]) },
    { oid: { id: [1, 3, 6, 1, 4, 1, 57264, 1, 14] }, value: Buffer.concat([Buffer.from([12, 15]), Buffer.from(expected.ref)]) },
  ] };
  verifyCertificateSource(certificate, expected);
  for (const missing of [undefined, {}, { oids: [] }, { oids: certificate.oids.slice(0, 3) }]) assert.throws(() => verifyCertificateSource(missing, expected), /certificate source/);
});

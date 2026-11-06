/** Cryptographic npm provenance verification with an exact GitHub workflow identity. */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Sigstore from "sigstore";

/** Identity required for the already-verified candidate's published artifact. */
export interface ProvenanceIdentity {
  repository: string;
  workflow: string;
  ref: string;
  commit: string;
  integrity: string;
  /** Authenticated executing reusable workflow; omitted for a legacy direct caller. */
  signerWorkflow?: string;
}

const require = createRequire(import.meta.url);
const verifiers = new Map<string, ReturnType<typeof Sigstore.createVerifier>>();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = basename(moduleDirectory) === "dist" ? dirname(moduleDirectory) : moduleDirectory;

/** Narrow remote JSON without treating arrays or missing values as records. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Decode only a JSON DSSE statement; a malformed payload is never evidence. */
function statement(entry: unknown): Record<string, unknown> {
  const payload = record(record(record(entry).bundle).dsseEnvelope).payload;
  if (typeof payload !== "string") return {};
  try { return record(JSON.parse(Buffer.from(payload, "base64").toString("utf8"))); }
  catch { return {}; }
}

/** Match digest and commit claims; callers must authenticate the bundle separately. */
export function verifyPublishedProvenance(bundle: unknown, commit: string, integrity: string): boolean {
  const attestations = record(bundle).attestations;
  if (!Array.isArray(attestations)) return false;
  const [algorithm, digest] = integrity.split("-");
  if (algorithm !== "sha512" || !digest) return false;
  const expectedDigest = Buffer.from(digest, "base64").toString("hex");
  return attestations.some((entry: unknown) => {
    if (record(entry).predicateType !== "https://slsa.dev/provenance/v1") return false;
    const claim = statement(entry);
    const subjects = claim.subject;
    const dependencies = record(record(claim.predicate).buildDefinition).resolvedDependencies;
    return Array.isArray(subjects) && subjects.some((subject: unknown) => record(record(subject).digest).sha512 === expectedDigest)
      && Array.isArray(dependencies) && dependencies.some((dependency: unknown) => record(record(dependency).digest).gitCommit === commit);
  });
}

/** Encode the DER UTF8String used by Fulcio's source repository extensions. */
function certificateString(value: string): Buffer {
  const bytes = Buffer.from(value), length: number[] = [];
  for (let size = bytes.length; size > 0; size = Math.floor(size / 256)) length.unshift(size % 256);
  const prefix = bytes.length < 128 ? [bytes.length] : [128 + length.length, ...length];
  return Buffer.concat([Buffer.from([12, ...prefix]), bytes]);
}

/** Bind authenticated certificate source claims independently of attacker-controlled signed JSON. */
export function verifyCertificateSource(certificate: { oids?: { oid: { id: number[] } | undefined; value: Buffer }[] } | undefined, expected: ProvenanceIdentity): void {
  const fields = [
    ["1.3.6.1.4.1.57264.1.12", "https://github.com/" + expected.repository],
    ["1.3.6.1.4.1.57264.1.13", expected.commit],
    ["1.3.6.1.4.1.57264.1.14", expected.ref],
  ];
  if (fields.some(([id, value]) => !certificate?.oids?.some(oid => oid.oid?.id.join(".") === id && oid.value.equals(certificateString(value))))) {
    throw new Error("Authenticated certificate source identity disagrees");
  }
}

/** Verify Fulcio identity, signature, transparency evidence and authenticated signing time. */
export async function verifySigstoreBundle(bundle: unknown, identity: ProvenanceIdentity): Promise<void> {
  const uri = "https://github.com/" + (identity.signerWorkflow ?? `${identity.repository}/${identity.workflow}@${identity.ref}`);
  const key = JSON.stringify([uri, identity.repository, identity.commit, identity.ref]);
  let verifier = verifiers.get(key);
  if (!verifier) {
    const privateClient = join(sourceRoot, ".github/release-runtime/node_modules/sigstore");
    const sigstore = require(existsSync(privateClient) ? privateClient : join(sourceRoot, "node_modules/sigstore")) as typeof Sigstore;
    verifier = sigstore.createVerifier({ certificateIssuer: "https://token.actions.githubusercontent.com",
      certificateIdentityURI: "^" + uri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
      ctLogThreshold: 1, tlogThreshold: 1, tufCachePath: join(tmpdir(), "pm-ops-sigstore"), retry: 0, timeout: 10_000 });
    verifiers.set(key, verifier);
  }
  const signer = (await verifier).verify(bundle as Parameters<Sigstore.BundleVerifier["verify"]>[0]);
  verifyCertificateSource(signer.identity, identity);
}

/** Accept only cryptographically verified SLSA from the exact repository, workflow and ref. */
export async function verifyRegistryProvenance(bundle: unknown, identity: ProvenanceIdentity,
  verify: typeof verifySigstoreBundle = verifySigstoreBundle): Promise<boolean> {
  const attestations = record(bundle).attestations;
  if (!Array.isArray(attestations)) return false;
  for (const entry of attestations) {
    if (!verifyPublishedProvenance({ attestations: [entry] }, identity.commit, identity.integrity)) continue;
    const workflow = record(record(record(statement(entry).predicate).buildDefinition).externalParameters).workflow;
    const source = record(workflow);
    if (source.repository !== `https://github.com/${identity.repository}` || source.path !== identity.workflow || source.ref !== identity.ref) continue;
    await verify(record(entry).bundle, identity);
    return true;
  }
  return false;
}

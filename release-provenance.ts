/** Cryptographic npm provenance verification with an exact GitHub workflow identity. */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const sourceRoot = dirname(fileURLToPath(import.meta.url)).replace(/[/\\]dist$/, "");

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

/** Resolve only a local private or development Sigstore installation, with a clear missing-runtime diagnostic. */
export function sigstoreRuntimePath(root = sourceRoot): string {
  const privateClient = join(root, ".github/release-runtime/node_modules/sigstore");
  const sigstorePath = [privateClient, join(root, "node_modules/sigstore")].find(existsSync);
  if (!sigstorePath) throw new Error("Sigstore runtime is not installed; call ensureReleaseRuntime() before provenance verification");
  return sigstorePath;
}

/** Verify Fulcio identity, signature, transparency evidence and authenticated signing time. */
export async function verifySigstoreBundle(bundle: unknown, identity: ProvenanceIdentity): Promise<void> {
  const uri = "https://github.com/" + (identity.signerWorkflow ?? `${identity.repository}/${identity.workflow}@${identity.ref}`);
  const key = JSON.stringify([uri, identity.repository, identity.commit, identity.ref]);
  let verifier = verifiers.get(key);
  if (!verifier) {
    const sigstore = require(sigstoreRuntimePath()) as typeof Sigstore;
    verifier = sigstore.createVerifier({ certificateIssuer: "https://token.actions.githubusercontent.com",
      certificateIdentityURI: "^" + uri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
      ctLogThreshold: 1, tlogThreshold: 1, tufCachePath: join(tmpdir(), "pm-ops-sigstore"), retry: 0, timeout: 10_000 });
    verifiers.set(key, verifier);
  }
  const signer = (await verifier).verify(bundle as Parameters<Sigstore.BundleVerifier["verify"]>[0]);
  verifyCertificateSource(signer.identity, identity);
}

/** Select matching signed claims identically for signer discovery and cryptographic verification. */
function matchingProvenance(bundle: unknown, identity: ProvenanceIdentity): unknown[] {
  const attestations = record(bundle).attestations;
  if (!Array.isArray(attestations)) return [];
  return attestations.filter(entry => {
    if (!verifyPublishedProvenance({ attestations: [entry] }, identity.commit, identity.integrity)) return false;
    const workflow = record(record(record(statement(entry).predicate).buildDefinition).externalParameters).workflow;
    const source = record(workflow);
    return source.repository === `https://github.com/${identity.repository}` && source.path === identity.workflow && source.ref === identity.ref;
  });
}

/** Resolve a reusable signer from the original publication run; decoded claims are only a read-only lookup hint. */
export async function originalPublicationSigner(bundle: unknown, identity: ProvenanceIdentity,
  readRun: (path: string) => Promise<unknown>): Promise<string> {
  const invocations = matchingProvenance(bundle, identity).map(entry => record(record(record(statement(entry).predicate).runDetails).metadata).invocationId);
  if (invocations.length === 0 || invocations.some(value => typeof value !== "string") || new Set(invocations).size !== 1) throw new Error("Missing or ambiguous publication invocation");
  const prefix = `https://github.com/${identity.repository}/actions/runs/`, invocation = invocations[0] as string;
  const match = invocation.startsWith(prefix) ? /^([1-9]\d*)(?:\/attempts\/([1-9]\d*))?$/.exec(invocation.slice(prefix.length)) : null;
  if (!match || !Number.isSafeInteger(Number(match[1])) || (match[2] !== undefined && !Number.isSafeInteger(Number(match[2])))) throw new Error("Untrusted publication invocation");
  const run = record(await readRun(`repos/${identity.repository}/actions/runs/${match[1]}${match[2] === undefined ? "" : "/attempts/" + match[2]}`));
  const paths = [identity.workflow, ...["main", identity.ref, identity.commit].map(ref => identity.workflow + "@" + ref)];
  if (record(run.repository).full_name !== identity.repository || run.head_branch !== "main" || run.head_sha !== identity.commit
    || !["schedule", "workflow_dispatch"].includes(String(run.event)) || ![...paths, ...paths.map(path => identity.repository + "/" + path)].includes(String(run.path))
    || (match[2] !== undefined && run.run_attempt !== Number(match[2]))) throw new Error("Untrusted original publication run");
  if (run.referenced_workflows !== undefined && !Array.isArray(run.referenced_workflows)) throw new Error("Unreadable original reusable workflow proof");
  const canonical = "unbraind/pm-ops/.github/workflows/daily-release.yml@";
  const references = (run.referenced_workflows ?? []).map(record).filter(ref => typeof ref.path === "string" && ref.path.startsWith(canonical));
  if (references.length === 0 && identity.repository === "unbraind/pm-ops") return canonical + "refs/heads/main";
  if (references.length !== 1) throw new Error("Missing or ambiguous original reusable signer");
  const reference = references[0], ref = String(reference.path).slice(canonical.length).replace(/^main$/, "refs/heads/main");
  if (!/^[a-f0-9]{40}$/.test(String(reference.sha)) || !/^(?:refs\/heads\/main|refs\/tags\/v\d{4}\.\d+\.\d+(?:-\d+)?|[a-f0-9]{40})$/.test(ref)
    || (/^[a-f0-9]{40}$/.test(ref) && ref !== reference.sha)) throw new Error("Untrusted original reusable signer");
  return canonical + ref;
}

/** Accept only cryptographically verified SLSA from the exact repository, workflow and ref. */
export async function verifyRegistryProvenance(bundle: unknown, identity: ProvenanceIdentity,
  verify: typeof verifySigstoreBundle = verifySigstoreBundle): Promise<boolean> {
  const [entry] = matchingProvenance(bundle, identity);
  if (entry === undefined) return false;
  await verify(record(entry).bundle, identity);
  return true;
}

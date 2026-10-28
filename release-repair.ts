/**
 * Conservative recovery of missing release tags and GitHub Releases. npm is
 * read-only: only successfully verified provenance authorizes a repair.
 * @packageDocumentation
 */
import { createHash } from "node:crypto";
import { canonicalTarManifest } from "./canonical-tar.ts";
import { readRegularText } from "./regular-input.ts";
import { closeSync, openSync, readSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditReleaseCompleteness, defaultExec, isReleaseTag, npmVersionToTag,
  repoSlugFromUrl, repositoryUrl, tagToNpmVersion, type CompletenessFetcher,
} from "./release-completeness.ts";
import type { VerifierResult } from "./shell-scan.ts";

/** Process boundary shared by the real adapter and recorded command fixtures. */
export type RepairExecutor = typeof defaultExec;

/** Verified registry identity and provenance commit for one immutable version. */
export interface NpmEvidence {
  /** Registry package name. */
  name: string;
  /** Registry version coordinate. */
  version: string;
  /** Registry release commit; the signed workflow source must be its ancestor. */
  gitHead: string;
  /** Signed source repository slug. */
  repository: string;
  /** Signed source commit, extracted only after npm verifies the bundle. */
  commit: string;
}

/** I/O contract for evidence and conditional writes; deliberately no publish API. */
export interface RepairClient {
  /** Verify npm provenance and read the coordinate's metadata. */
  npmEvidence(name: string, version: string): NpmEvidence;
  /** Read the actual remote tag's peeled commit, or null on proven absence. */
  remoteTag(root: string, tag: string): string | null;
  /** Read an immutable local commit's object or committed file. */
  git(root: string, args: string[]): string;
  /** Compare every packed file and the complete file set with the immutable release tree. */
  verifyTarball(root: string, commit: string, evidence: NpmEvidence): void;
  /** Create only an absent remote tag at the verified release commit. */
  createTag(slug: string, tag: string, commit: string): void;
  /** Create only a missing release with committed changelog notes. */
  createRelease(slug: string, tag: string, notes: string): void;
}

/** The subset of a verified SLSA v1 statement used to bind the source commit. */
export interface ProvenanceStatement {
  /** Provenance schema discriminator. */
  predicateType: string;
  /** Signed artifacts; repair requires exactly the coordinate's npm tarball. */
  subject?: { name?: string; digest?: { sha512?: string } }[];
  /** Signed build definition with source dependencies. */
  predicate: {
    buildDefinition: {
      /** The signed workflow invocation; only the approved release workflow on main may authorize repair. */
      externalParameters?: { workflow?: { path?: string; ref?: string; repository?: string } };
      resolvedDependencies: { uri: string; digest: { gitCommit: string } }[];
    };
  };
}

/** Full npm audit output, including successfully verified provenance bundles. */
interface SignatureReport {
  /** Invalid signatures or attestations fail closed even if another entry verifies. */
  invalid: unknown[];
  /** Verified coordinates and their attestation envelopes. */
  verified: {
    name: string;
    version: string;
    registry: string;
    attestationBundles: { predicateType: string; bundle: { dsseEnvelope: { payload: string } } }[];
  }[];
}

/** The only workflow file whose npm provenance may authorize tag and release repair. */
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
/** The only ref whose release builds may authorize repair. */
const RELEASE_WORKFLOW_REF = "refs/heads/main";

/** The package URL npm provenance uses as the subject name; scoped names encode the leading `@`. */
function npmPurl(name: string, version: string): string {
  return `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;
}

/** Decode a registry `sha512-<base64>` integrity to the hex digest provenance subjects carry; anything else cannot match. */
function integrityHex(integrity: string): string | null {
  return integrity.startsWith("sha512-") ? Buffer.from(integrity.slice(7), "base64").toString("hex") : null;
}

/**
 * Extract a unique source identity from npm's successful signature-audit output.
 * Raw registry metadata or a merely present attestation is never sufficient.
 */
export function evidenceFromAudit(name: string, version: string, gitHead: string, output: string, integrity: string): NpmEvidence {
  const report = JSON.parse(output) as SignatureReport;
  if (!Array.isArray(report.invalid) || report.invalid.length !== 0 || !Array.isArray(report.verified)) {
    throw new Error("npm signature audit is incomplete or contains invalid evidence");
  }
  const entries = report.verified.filter((entry) => entry.name === name && entry.version === version && entry.registry === "https://registry.npmjs.org/");
  if (entries.length !== 1) throw new Error("npm did not verify exactly one matching package coordinate");
  const sources: { repository: string; commit: string }[] = [];
  for (const attestation of entries[0]!.attestationBundles) {
    if (attestation.predicateType !== "https://slsa.dev/provenance/v1") continue;
    const statement = JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, "base64").toString("utf8")) as ProvenanceStatement;
    if (statement.predicateType !== attestation.predicateType) throw new Error("provenance schema mismatch");
    // The signed subject must be exactly this coordinate's tarball, not merely an attestation npm accepted.
    if (statement.subject?.length !== 1 || statement.subject[0]!.name !== npmPurl(name, version)
      || statement.subject[0]!.digest?.sha512 !== integrityHex(integrity)) {
      throw new Error("provenance subject does not match the package coordinate and tarball digest");
    }
    const workflow = statement.predicate.buildDefinition.externalParameters?.workflow;
    if (workflow?.path !== RELEASE_WORKFLOW_PATH || workflow.ref !== RELEASE_WORKFLOW_REF || typeof workflow.repository !== "string") {
      throw new Error("provenance was not built by the approved release workflow and ref");
    }
    const workflowRepository = repoSlugFromUrl(workflow.repository);
    for (const dependency of statement.predicate.buildDefinition.resolvedDependencies) {
      const repository = repoSlugFromUrl(dependency.uri.replace(/^git\+/, "").split("@")[0]!);
      const commit = dependency.digest.gitCommit;
      if (!repository || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("unrecognized signed source identity");
      if (repository !== workflowRepository) throw new Error("signed workflow repository differs from the signed source repository");
      sources.push({ repository, commit });
    }
  }
  if (sources.length !== 1 || !/^[a-f0-9]{40}$/.test(gitHead)) {
    throw new Error("npm gitHead or unique verified provenance is invalid");
  }
  return { name, version, gitHead, ...sources[0]! };
}

/** Hash a file in fixed chunks so tarball and member sizes never determine capture or allocation size. */
function hashFile(path: string, encoding: "hex" | "base64"): string {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha512");
    const chunk = Buffer.alloc(64 * 1024);
    let count: number;
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, count));
    return hash.digest(encoding);
  } finally { closeSync(fd); }
}

/** Bind registry integrity and a complete archive manifest, independently of npm's lossy file listing. */
function packContents(exec: RepairExecutor, spec: string, cwd: string): { integrity: string; manifest: string } {
  const [packed] = JSON.parse(exec("npm", ["pack", spec, "--ignore-scripts", "--json", "--registry=https://registry.npmjs.org/"], { cwd })) as { filename: string; integrity: string }[];
  if (!packed || !/^[^/\\]+\.tgz$/.test(packed.filename)) throw new Error("unreadable package file manifest");
  const tarball = join(cwd, packed.filename);
  const actualIntegrity = `sha512-${hashFile(tarball, "base64")}`;
  if (actualIntegrity !== packed.integrity) throw new Error("downloaded tarball integrity mismatch");
  const staging = mkdtempSync(join(cwd, ".pm-ops-manifest-"));
  try {
    const archive = join(staging, "archive.tar");
    const fd = openSync(archive, "wx");
    try {
      exec(process.execPath, ["--input-type=module", "-e",
        'import { createReadStream } from "node:fs"; import { createGunzip } from "node:zlib"; import { pipeline } from "node:stream/promises"; await pipeline(createReadStream(process.argv[1]), createGunzip(), process.stdout);', tarball], { stdoutFd: fd });
    } finally { closeSync(fd); }
    return { integrity: actualIntegrity, manifest: canonicalTarManifest(archive) };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

/** Verify signed workflow ancestry and exact package bytes at the release commit before permitting repair. */
export function verifyReleaseSource(root: string, commit: string, evidence: NpmEvidence, client: RepairClient): void {
  if (commit !== evidence.gitHead) throw new Error("tag and npm gitHead mismatch");
  if (client.git(root, ["rev-parse", `${commit}^{commit}`]) !== commit) throw new Error("release commit unavailable");
  if (client.git(root, ["merge-base", evidence.commit, commit]) !== evidence.commit) throw new Error("attested source is not an ancestor of the release tag commit");
  client.verifyTarball(root, commit, evidence);
}

/** Build the live adapter. All npm operations download/read; scripts are disabled. */
export function makeRepairClient(exec: RepairExecutor = defaultExec): RepairClient {
  const integrities = new Map<string, string>();
  return {
    /** Verify the exact registry coordinate in a disposable script-disabled install. */
    npmEvidence(name, version) {
      const metadata = JSON.parse(exec("npm", ["view", `${name}@${version}`, "--json", "--prefer-online", "--registry=https://registry.npmjs.org/"], {})) as { name: string; version: string; gitHead: string; dist?: { integrity?: string } };
      if (metadata.name !== name || metadata.version !== version) throw new Error("registry coordinate mismatch");
      const scratch = mkdtempSync(join(tmpdir(), "pm-ops-provenance-"));
      try {
        writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "release-evidence", version: "1.0.0", private: true }));
        exec("npm", ["install", `${name}@${version}`, "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps", "--registry=https://registry.npmjs.org/"], { cwd: scratch });
        const output = exec("npm", ["audit", "signatures", "--json", "--include-attestations", "--registry=https://registry.npmjs.org/"], { cwd: scratch });
        const evidence = evidenceFromAudit(name, version, metadata.gitHead, output, metadata.dist?.integrity ?? "");
        integrities.set(`${name}@${version}`, metadata.dist!.integrity!);
        return evidence;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    /** Download the signed artifact again and compare canonical packed files against the tag tree, with scripts disabled. */
    verifyTarball(root, commit, evidence) {
      const integrity = integrities.get(`${evidence.name}@${evidence.version}`);
      if (!integrity) throw new Error("tarball comparison requires verified npm evidence from this client");
      const scratch = mkdtempSync(join(tmpdir(), "pm-ops-tree-"));
      try {
        const source = join(scratch, "source"); mkdirSync(source);
        const archive = join(scratch, "source.tar");
        exec("git", ["archive", "--format=tar", `--output=${archive}`, commit], { cwd: root });
        exec("tar", ["-xf", archive, "-C", source], {});
        const expected = packContents(exec, source, source);
        const actual = packContents(exec, `${evidence.name}@${evidence.version}`, scratch);
        if (actual.integrity !== integrity || actual.manifest !== expected.manifest) {
          throw new Error("published tarball does not match the release tag tree; inspect package files before repair");
        }
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    },
    /** Inspect only the requested remote ref and its annotated-tag peel. */
    remoteTag(root, tag) {
      // Validate at the call site: only release tags ever reach git's argv.
      if (!isReleaseTag(tag)) throw new Error(`unsupported release coordinate ${tag}`);
      const output = exec("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: root }).trim();
      if (!output) return null;
      const refs = output.split("\n").map((line) => line.split(/\s+/));
      if (refs.some(([sha, ref]) => !/^[a-f0-9]{40}$/.test(sha!) || (ref !== `refs/tags/${tag}` && ref !== `refs/tags/${tag}^{}`))) throw new Error("unreadable remote tag");
      return (refs.find(([, ref]) => ref === `refs/tags/${tag}^{}`) ?? refs[0])![0]!;
    },
    /** Read commit objects and committed files through the injected git boundary. */
    git(root, args) { return exec("git", args, { cwd: root }).trim(); },
    /** Create an absent remote ref without force-updating existing refs. */
    createTag(slug, tag, commit) {
      exec("gh", ["api", `repos/${slug}/git/refs`, "--method", "POST", "-f", `ref=refs/tags/${tag}`, "-f", `sha=${commit}`], {});
    },
    /** Create a release from verified notes without changing the latest designation. */
    createRelease(slug, tag, notes) {
      const scratch = mkdtempSync(join(tmpdir(), "pm-ops-release-notes-"));
      try {
        const notesFile = join(scratch, "notes.md");
        writeFileSync(notesFile, notes);
        exec("gh", ["release", "create", tag, "--repo", slug, "--verify-tag", "--latest=false", "--title", `${slug.split("/")[1]} ${tag}`, "--notes-file", notesFile], {});
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
}

/** Extract exactly one nonempty version section from an immutable changelog. */
export function committedReleaseNotes(changelog: string, version: string): string {
  const sections = changelog.split(/^## /m).slice(1);
  const matches = sections.filter((section) => {
    // A single-character separator keeps the match linear on long runs of spaces.
    const heading = section.split("\n")[0]!;
    const separator = heading.search(/\s-\s/);
    return (separator === -1 ? heading : heading.slice(0, separator)).trim() === version;
  });
  if (matches.length !== 1) throw new Error(`committed changelog must have exactly one section for ${version}`);
  const body = matches[0]!.split("\n").slice(1).join("\n").trim();
  if (!body) throw new Error(`committed changelog section for ${version} is empty`);
  return body + "\n";
}

/**
 * Resolve one release's notes from committed changelogs, never from the working tree.
 *
 * The release commit's own changelog is the primary source: it records the
 * notes exactly as the released tree carried them. But a release whose commit
 * predates a changelog regeneration (the 2026.10.20 release commit was created
 * during this repository's generation-drift window and contains no section for
 * its own version, nor for 2026.10.16-2026.10.19) can never gain one - the
 * commit is immutable - so a single-source read refuses that repair forever
 * while every later daily release fails the same audit. The audit-time
 * committed changelog is the repository's own recovery source: it is
 * regenerated from every release tag (`changelog:full --all-release-tags`),
 * re-checked (`changelog:check`), and now guarded by the pre-release section
 * gate, so by the time a repair runs it carries exactly one section for every
 * released version. Both reads go through committed git state; uncommitted
 * working-tree edits are never release notes, and a fallback that also fails
 * still fails closed with the single-section requirement.
 *
 * @param root - Repository root the audit runs in.
 * @param commit - The verified release commit the notes describe.
 * @param version - The npm version string of the release.
 * @param client - The git boundary the repair reads committed files through.
 * @returns The nonempty release-note body for the version.
 * @throws When neither committed changelog has exactly one nonempty section.
 */
export function releaseNotesFor(root: string, commit: string, version: string, client: RepairClient): string {
  try {
    return committedReleaseNotes(client.git(root, ["show", `${commit}:CHANGELOG.md`]), version);
  } catch (history) {
    try {
      return committedReleaseNotes(client.git(root, ["show", "HEAD:CHANGELOG.md"]), version);
    } catch (current) {
      throw new Error(`committed changelog must have exactly one section for ${version}: the release commit's changelog ${String(history)} and the audit-time committed changelog ${String(current)}`);
    }
  }
}

/**
 * Preflight all incomplete triples before writing. Never infer absence from a
 * failed read, move an existing tag, overwrite a release, or publish to npm.
 * Re-read remote state before each write and after uncertain write outcomes.
 */
export function repairReleaseCompleteness(root: string, fetcher: CompletenessFetcher, client: RepairClient): VerifierResult {
  const notes: string[] = [];
  try {
    const manifest = JSON.parse(readRegularText(join(root, "package.json"))) as { name: string; repository?: string | { url?: string } };
    const name = manifest.name;
    const slug = repoSlugFromUrl(fetcher.remoteUrl(root));
    if (!name || !slug || repoSlugFromUrl(repositoryUrl(manifest.repository)) !== slug) throw new Error("package and origin repository identity mismatch");
    const tags = fetcher.tags(root).filter(isReleaseTag);
    const versions = fetcher.npmVersions(name);
    const releases = fetcher.githubReleases(slug);
    const candidates = [...new Set([...tags, ...versions.map(npmVersionToTag), ...releases])];
    const plans: { tag: string; commit: string; notes: string }[] = [];
    for (const tag of candidates) {
      if (!isReleaseTag(tag)) throw new Error(`unsupported release coordinate ${tag}`);
      const version = tagToNpmVersion(tag);
      if (!versions.includes(version)) throw new Error(`${tag} has no published npm version; publishing is never a repair`);
      const remote = client.remoteTag(root, tag);
      const exists = fetcher.githubReleaseForTag(slug, tag);
      if (remote !== null && tags.includes(tag)) {
        const local = client.git(root, ["rev-parse", `refs/tags/${tag}^{commit}`]);
        if (local !== remote) throw new Error(`local and remote tag mismatch for ${tag}`);
      }
      if (!exists) notes.push(`github_release_absent: ${tag}; confirm access and verify source and tarball before repair (the API uses HTTP 404 for absent releases).`);
      if (remote !== null && exists) continue;
      const evidence = client.npmEvidence(name, version);
      if (evidence.name !== name || evidence.version !== version || evidence.repository !== slug || !/^[a-f0-9]{40}$/.test(evidence.commit) || !/^[a-f0-9]{40}$/.test(evidence.gitHead)) throw new Error(`npm evidence mismatch for ${tag}`);
      const commit = remote ?? evidence.gitHead;
      if (tags.includes(tag) && client.git(root, ["rev-parse", `refs/tags/${tag}^{commit}`]) !== commit) throw new Error(`local tag and npm gitHead mismatch for ${tag}`);
      verifyReleaseSource(root, commit, evidence, client);
      const committed = JSON.parse(client.git(root, ["show", `${commit}:package.json`])) as { name: string; version: string; repository?: string | { url?: string } };
      if (committed.name !== name || committed.version !== version || repoSlugFromUrl(repositoryUrl(committed.repository)) !== slug) throw new Error(`committed package identity mismatch for ${tag}`);
      const body = releaseNotesFor(root, commit, version, client);
      plans.push({ tag, commit, notes: body });
    }
    for (const plan of plans) {
      let remote = client.remoteTag(root, plan.tag);
      if (remote === null) {
        // Report a repair only for a create call that succeeded; an accepted pre-existing or lost-response result is named as such.
        let created = true;
        try { client.createTag(slug, plan.tag, plan.commit); }
        catch (error) {
          created = false;
          if (client.remoteTag(root, plan.tag) !== plan.commit) throw error;
        }
        remote = client.remoteTag(root, plan.tag);
        notes.push(created ? `repaired tag ${plan.tag}` : `tag ${plan.tag} confirmed at the planned commit after a failed create call`);
      }
      if (remote !== plan.commit) throw new Error(`remote tag changed for ${plan.tag}`);
      if (!fetcher.githubReleaseForTag(slug, plan.tag)) {
        let created = true;
        try { client.createRelease(slug, plan.tag, plan.notes); }
        catch (error) {
          created = false;
          if (!fetcher.githubReleaseForTag(slug, plan.tag)) throw error;
        }
        notes.push(created ? `repaired GitHub Release ${plan.tag}` : `GitHub Release ${plan.tag} confirmed present after a failed create call`);
      }
    }
    const finalTags = [...new Set([...tags, ...candidates.filter((tag) => client.remoteTag(root, tag) !== null)])];
    const finalReleases = candidates.filter((tag) => fetcher.githubReleaseForTag(slug, tag));
    const result = auditReleaseCompleteness(finalTags, fetcher.npmVersions(name), finalReleases);
    return { failures: result.failures, notes: [...notes, ...result.notes] };
  } catch (error) {
    return { failures: [`release repair refused: ${error instanceof Error ? error.message : String(error)}`], notes };
  }
}

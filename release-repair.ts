/**
 * Conservative recovery of missing release tags and GitHub Releases. npm is
 * read-only: only successfully verified provenance authorizes a repair.
 * @packageDocumentation
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  /** Registry gitHead, required to match the signed commit. */
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
  /** Create only an absent remote tag at the attested commit. */
  createTag(slug: string, tag: string, commit: string): void;
  /** Create only a missing release with committed changelog notes. */
  createRelease(slug: string, tag: string, notes: string): void;
}

/** The subset of a verified SLSA v1 statement used to bind the source commit. */
interface ProvenanceStatement {
  /** Provenance schema discriminator. */
  predicateType: string;
  /** Signed build definition with source dependencies. */
  predicate: {
    buildDefinition: {
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

/**
 * Extract a unique source identity from npm's successful signature-audit output.
 * Raw registry metadata or a merely present attestation is never sufficient.
 */
export function evidenceFromAudit(name: string, version: string, gitHead: string, output: string): NpmEvidence {
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
    for (const dependency of statement.predicate.buildDefinition.resolvedDependencies) {
      const repository = repoSlugFromUrl(dependency.uri.replace(/^git\+/, "").split("@")[0]!);
      const commit = dependency.digest.gitCommit;
      if (!repository || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("unrecognized signed source identity");
      sources.push({ repository, commit });
    }
  }
  if (sources.length !== 1 || !/^[a-f0-9]{40}$/.test(gitHead) || sources[0]!.commit !== gitHead) {
    throw new Error("npm gitHead does not match unique verified provenance");
  }
  return { name, version, gitHead, ...sources[0]! };
}

/** Build the live adapter. All npm operations download/read; scripts are disabled. */
export function makeRepairClient(exec: RepairExecutor = defaultExec): RepairClient {
  return {
    /** Verify the exact registry coordinate in a disposable script-disabled install. */
    npmEvidence(name, version) {
      const metadata = JSON.parse(exec("npm", ["view", `${name}@${version}`, "--json", "--prefer-online", "--registry=https://registry.npmjs.org/"], {})) as { name: string; version: string; gitHead: string };
      if (metadata.name !== name || metadata.version !== version) throw new Error("registry coordinate mismatch");
      const scratch = mkdtempSync(join(tmpdir(), "pm-ops-provenance-"));
      try {
        writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "release-evidence", version: "1.0.0", private: true }));
        exec("npm", ["install", `${name}@${version}`, "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps", "--registry=https://registry.npmjs.org/"], { cwd: scratch });
        const output = exec("npm", ["audit", "signatures", "--json", "--include-attestations", "--registry=https://registry.npmjs.org/"], { cwd: scratch });
        return evidenceFromAudit(name, version, metadata.gitHead, output);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
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
 * Preflight all incomplete triples before writing. Never infer absence from a
 * failed read, move an existing tag, overwrite a release, or publish to npm.
 * Re-read remote state before each write and after uncertain write outcomes.
 */
export function repairReleaseCompleteness(root: string, fetcher: CompletenessFetcher, client: RepairClient): VerifierResult {
  const notes: string[] = [];
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; repository?: string | { url?: string } };
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
      if (remote !== null && exists) continue;
      const evidence = client.npmEvidence(name, version);
      if (evidence.name !== name || evidence.version !== version || evidence.repository !== slug || !/^[a-f0-9]{40}$/.test(evidence.commit) || evidence.gitHead !== evidence.commit) throw new Error(`npm evidence mismatch for ${tag}`);
      if (remote !== null && remote !== evidence.commit) throw new Error(`tag and attested gitHead mismatch for ${tag}`);
      if (tags.includes(tag) && client.git(root, ["rev-parse", `refs/tags/${tag}^{commit}`]) !== evidence.commit) throw new Error(`local tag and attested gitHead mismatch for ${tag}`);
      const commit = client.git(root, ["rev-parse", `${evidence.commit}^{commit}`]);
      if (commit !== evidence.commit) throw new Error(`attested commit unavailable for ${tag}`);
      const committed = JSON.parse(client.git(root, ["show", `${commit}:package.json`])) as { name: string; version: string; repository?: string | { url?: string } };
      if (committed.name !== name || committed.version !== version || repoSlugFromUrl(repositoryUrl(committed.repository)) !== slug) throw new Error(`committed package identity mismatch for ${tag}`);
      const body = committedReleaseNotes(client.git(root, ["show", `${commit}:CHANGELOG.md`]), version);
      plans.push({ tag, commit, notes: body });
    }
    for (const plan of plans) {
      let remote = client.remoteTag(root, plan.tag);
      if (remote === null) {
        try { client.createTag(slug, plan.tag, plan.commit); }
        catch (error) {
          if (client.remoteTag(root, plan.tag) !== plan.commit) throw error;
        }
        remote = client.remoteTag(root, plan.tag);
        notes.push(`repaired tag ${plan.tag}`);
      }
      if (remote !== plan.commit) throw new Error(`remote tag changed for ${plan.tag}`);
      if (!fetcher.githubReleaseForTag(slug, plan.tag)) {
        try { client.createRelease(slug, plan.tag, plan.notes); }
        catch (error) {
          if (!fetcher.githubReleaseForTag(slug, plan.tag)) throw error;
        }
        notes.push(`repaired GitHub Release ${plan.tag}`);
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

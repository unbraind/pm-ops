/**
 * Conservative recovery of missing release tags and GitHub Releases. npm is
 * read-only: only successfully verified provenance authorizes a repair.
 * @packageDocumentation
 */
import { createHash } from "node:crypto";
import { readRegularText } from "./regular-input.js";
import { closeSync, openSync, readSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditReleaseCompleteness, defaultExec, isReleaseTag, npmVersionToTag, repoSlugFromUrl, repositoryUrl, tagToNpmVersion, } from "./release-completeness.js";
/** The only workflow file whose npm provenance may authorize tag and release repair. */
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
/** The only ref whose release builds may authorize repair. */
const RELEASE_WORKFLOW_REF = "refs/heads/main";
/** The package URL npm provenance uses as the subject name; scoped names encode the leading `@`. */
function npmPurl(name, version) {
    return `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;
}
/** Decode a registry `sha512-<base64>` integrity to the hex digest provenance subjects carry; anything else cannot match. */
function integrityHex(integrity) {
    return integrity.startsWith("sha512-") ? Buffer.from(integrity.slice(7), "base64").toString("hex") : null;
}
/**
 * Extract a unique source identity from npm's successful signature-audit output.
 * Raw registry metadata or a merely present attestation is never sufficient.
 */
export function evidenceFromAudit(name, version, gitHead, output, integrity) {
    const report = JSON.parse(output);
    if (!Array.isArray(report.invalid) || report.invalid.length !== 0 || !Array.isArray(report.verified)) {
        throw new Error("npm signature audit is incomplete or contains invalid evidence");
    }
    const entries = report.verified.filter((entry) => entry.name === name && entry.version === version && entry.registry === "https://registry.npmjs.org/");
    if (entries.length !== 1)
        throw new Error("npm did not verify exactly one matching package coordinate");
    const sources = [];
    for (const attestation of entries[0].attestationBundles) {
        if (attestation.predicateType !== "https://slsa.dev/provenance/v1")
            continue;
        const statement = JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, "base64").toString("utf8"));
        if (statement.predicateType !== attestation.predicateType)
            throw new Error("provenance schema mismatch");
        // The signed subject must be exactly this coordinate's tarball, not merely an attestation npm accepted.
        if (statement.subject?.length !== 1 || statement.subject[0].name !== npmPurl(name, version)
            || statement.subject[0].digest?.sha512 !== integrityHex(integrity)) {
            throw new Error("provenance subject does not match the package coordinate and tarball digest");
        }
        const workflow = statement.predicate.buildDefinition.externalParameters?.workflow;
        if (workflow?.path !== RELEASE_WORKFLOW_PATH || workflow.ref !== RELEASE_WORKFLOW_REF || typeof workflow.repository !== "string") {
            throw new Error("provenance was not built by the approved release workflow and ref");
        }
        const workflowRepository = repoSlugFromUrl(workflow.repository);
        for (const dependency of statement.predicate.buildDefinition.resolvedDependencies) {
            const repository = repoSlugFromUrl(dependency.uri.replace(/^git\+/, "").split("@")[0]);
            const commit = dependency.digest.gitCommit;
            if (!repository || !/^[a-f0-9]{40}$/.test(commit))
                throw new Error("unrecognized signed source identity");
            if (repository !== workflowRepository)
                throw new Error("signed workflow repository differs from the signed source repository");
            sources.push({ repository, commit });
        }
    }
    if (sources.length !== 1 || !/^[a-f0-9]{40}$/.test(gitHead)) {
        throw new Error("npm gitHead or unique verified provenance is invalid");
    }
    return { name, version, gitHead, ...sources[0] };
}
/** Hash a file in fixed chunks so tarball and member sizes never determine capture or allocation size. */
function hashFile(path, encoding) {
    const fd = openSync(path, "r");
    try {
        const hash = createHash("sha512");
        const chunk = Buffer.alloc(64 * 1024);
        let count;
        while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0)
            hash.update(chunk.subarray(0, count));
        return hash.digest(encoding);
    }
    finally {
        closeSync(fd);
    }
}
/** Hash every regular packed file without extracting registry-controlled paths. npm's file list also detects missing or extra files. */
function packContents(exec, spec, cwd) {
    const [packed] = JSON.parse(exec("npm", ["pack", spec, "--ignore-scripts", "--json", "--registry=https://registry.npmjs.org/"], { cwd }));
    if (!packed || !/^[^/\\]+\.tgz$/.test(packed.filename) || !Array.isArray(packed.files) || packed.files.length === 0)
        throw new Error("unreadable package file manifest");
    const tarball = join(cwd, packed.filename);
    const actualIntegrity = `sha512-${hashFile(tarball, "base64")}`;
    if (actualIntegrity !== packed.integrity)
        throw new Error("downloaded tarball integrity mismatch");
    const files = packed.files.map((file) => {
        if (!/^[a-zA-Z0-9_.@/-]+$/.test(file.path) || file.path.split("/").some((part) => part === ".." || part === ""))
            throw new Error("unsafe package member");
        const member = join(cwd, "member-bytes");
        const fd = openSync(member, "w");
        try {
            exec("tar", ["-xOf", tarball, `package/${file.path}`], { stdoutFd: fd });
        }
        finally {
            closeSync(fd);
        }
        try {
            return [file.path, hashFile(member, "hex"), file.mode];
        }
        finally {
            rmSync(member);
        }
    }).sort(([a], [b]) => a.localeCompare(b));
    return { integrity: actualIntegrity, files };
}
/** Verify signed workflow ancestry and exact package bytes at the release commit before permitting repair. */
export function verifyReleaseSource(root, commit, evidence, client) {
    if (commit !== evidence.gitHead)
        throw new Error("tag and npm gitHead mismatch");
    if (client.git(root, ["rev-parse", `${commit}^{commit}`]) !== commit)
        throw new Error("release commit unavailable");
    if (client.git(root, ["merge-base", evidence.commit, commit]) !== evidence.commit)
        throw new Error("attested source is not an ancestor of the release tag commit");
    client.verifyTarball(root, commit, evidence);
}
/** Build the live adapter. All npm operations download/read; scripts are disabled. */
export function makeRepairClient(exec = defaultExec) {
    const integrities = new Map();
    return {
        /** Verify the exact registry coordinate in a disposable script-disabled install. */
        npmEvidence(name, version) {
            const metadata = JSON.parse(exec("npm", ["view", `${name}@${version}`, "--json", "--prefer-online", "--registry=https://registry.npmjs.org/"], {}));
            if (metadata.name !== name || metadata.version !== version)
                throw new Error("registry coordinate mismatch");
            const scratch = mkdtempSync(join(tmpdir(), "pm-ops-provenance-"));
            try {
                writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "release-evidence", version: "1.0.0", private: true }));
                exec("npm", ["install", `${name}@${version}`, "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps", "--registry=https://registry.npmjs.org/"], { cwd: scratch });
                const output = exec("npm", ["audit", "signatures", "--json", "--include-attestations", "--registry=https://registry.npmjs.org/"], { cwd: scratch });
                const evidence = evidenceFromAudit(name, version, metadata.gitHead, output, metadata.dist?.integrity ?? "");
                integrities.set(`${name}@${version}`, metadata.dist.integrity);
                return evidence;
            }
            finally {
                rmSync(scratch, { recursive: true, force: true });
            }
        },
        /** Download the signed artifact again and compare canonical packed files against the tag tree, with scripts disabled. */
        verifyTarball(root, commit, evidence) {
            const integrity = integrities.get(`${evidence.name}@${evidence.version}`);
            if (!integrity)
                throw new Error("tarball comparison requires verified npm evidence from this client");
            const scratch = mkdtempSync(join(tmpdir(), "pm-ops-tree-"));
            try {
                const source = join(scratch, "source");
                mkdirSync(source);
                const archive = join(scratch, "source.tar");
                exec("git", ["archive", "--format=tar", `--output=${archive}`, commit], { cwd: root });
                exec("tar", ["-xf", archive, "-C", source], {});
                const expected = packContents(exec, source, source);
                const actual = packContents(exec, `${evidence.name}@${evidence.version}`, scratch);
                if (actual.integrity !== integrity || JSON.stringify(actual.files) !== JSON.stringify(expected.files)) {
                    throw new Error("published tarball does not match the release tag tree; inspect package files before repair");
                }
            }
            finally {
                rmSync(scratch, { recursive: true, force: true });
            }
        },
        /** Inspect only the requested remote ref and its annotated-tag peel. */
        remoteTag(root, tag) {
            // Validate at the call site: only release tags ever reach git's argv.
            if (!isReleaseTag(tag))
                throw new Error(`unsupported release coordinate ${tag}`);
            const output = exec("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: root }).trim();
            if (!output)
                return null;
            const refs = output.split("\n").map((line) => line.split(/\s+/));
            if (refs.some(([sha, ref]) => !/^[a-f0-9]{40}$/.test(sha) || (ref !== `refs/tags/${tag}` && ref !== `refs/tags/${tag}^{}`)))
                throw new Error("unreadable remote tag");
            return (refs.find(([, ref]) => ref === `refs/tags/${tag}^{}`) ?? refs[0])[0];
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
            }
            finally {
                rmSync(scratch, { recursive: true, force: true });
            }
        },
    };
}
/** Extract exactly one nonempty version section from an immutable changelog. */
export function committedReleaseNotes(changelog, version) {
    const sections = changelog.split(/^## /m).slice(1);
    const matches = sections.filter((section) => {
        // A single-character separator keeps the match linear on long runs of spaces.
        const heading = section.split("\n")[0];
        const separator = heading.search(/\s-\s/);
        return (separator === -1 ? heading : heading.slice(0, separator)).trim() === version;
    });
    if (matches.length !== 1)
        throw new Error(`committed changelog must have exactly one section for ${version}`);
    const body = matches[0].split("\n").slice(1).join("\n").trim();
    if (!body)
        throw new Error(`committed changelog section for ${version} is empty`);
    return body + "\n";
}
/**
 * Preflight all incomplete triples before writing. Never infer absence from a
 * failed read, move an existing tag, overwrite a release, or publish to npm.
 * Re-read remote state before each write and after uncertain write outcomes.
 */
export function repairReleaseCompleteness(root, fetcher, client) {
    const notes = [];
    try {
        const manifest = JSON.parse(readRegularText(join(root, "package.json")));
        const name = manifest.name;
        const slug = repoSlugFromUrl(fetcher.remoteUrl(root));
        if (!name || !slug || repoSlugFromUrl(repositoryUrl(manifest.repository)) !== slug)
            throw new Error("package and origin repository identity mismatch");
        const tags = fetcher.tags(root).filter(isReleaseTag);
        const versions = fetcher.npmVersions(name);
        const releases = fetcher.githubReleases(slug);
        const candidates = [...new Set([...tags, ...versions.map(npmVersionToTag), ...releases])];
        const plans = [];
        for (const tag of candidates) {
            if (!isReleaseTag(tag))
                throw new Error(`unsupported release coordinate ${tag}`);
            const version = tagToNpmVersion(tag);
            if (!versions.includes(version))
                throw new Error(`${tag} has no published npm version; publishing is never a repair`);
            const remote = client.remoteTag(root, tag);
            const exists = fetcher.githubReleaseForTag(slug, tag);
            if (remote !== null && tags.includes(tag)) {
                const local = client.git(root, ["rev-parse", `refs/tags/${tag}^{commit}`]);
                if (local !== remote)
                    throw new Error(`local and remote tag mismatch for ${tag}`);
            }
            if (!exists)
                notes.push(`github_release_absent: ${tag}; confirm access and verify source and tarball before repair (the API uses HTTP 404 for absent releases).`);
            if (remote !== null && exists)
                continue;
            const evidence = client.npmEvidence(name, version);
            if (evidence.name !== name || evidence.version !== version || evidence.repository !== slug || !/^[a-f0-9]{40}$/.test(evidence.commit) || !/^[a-f0-9]{40}$/.test(evidence.gitHead))
                throw new Error(`npm evidence mismatch for ${tag}`);
            const commit = remote ?? evidence.gitHead;
            if (tags.includes(tag) && client.git(root, ["rev-parse", `refs/tags/${tag}^{commit}`]) !== commit)
                throw new Error(`local tag and npm gitHead mismatch for ${tag}`);
            verifyReleaseSource(root, commit, evidence, client);
            const committed = JSON.parse(client.git(root, ["show", `${commit}:package.json`]));
            if (committed.name !== name || committed.version !== version || repoSlugFromUrl(repositoryUrl(committed.repository)) !== slug)
                throw new Error(`committed package identity mismatch for ${tag}`);
            const body = committedReleaseNotes(client.git(root, ["show", `${commit}:CHANGELOG.md`]), version);
            plans.push({ tag, commit, notes: body });
        }
        for (const plan of plans) {
            let remote = client.remoteTag(root, plan.tag);
            if (remote === null) {
                // Report a repair only for a create call that succeeded; an accepted pre-existing or lost-response result is named as such.
                let created = true;
                try {
                    client.createTag(slug, plan.tag, plan.commit);
                }
                catch (error) {
                    created = false;
                    if (client.remoteTag(root, plan.tag) !== plan.commit)
                        throw error;
                }
                remote = client.remoteTag(root, plan.tag);
                notes.push(created ? `repaired tag ${plan.tag}` : `tag ${plan.tag} confirmed at the planned commit after a failed create call`);
            }
            if (remote !== plan.commit)
                throw new Error(`remote tag changed for ${plan.tag}`);
            if (!fetcher.githubReleaseForTag(slug, plan.tag)) {
                let created = true;
                try {
                    client.createRelease(slug, plan.tag, plan.notes);
                }
                catch (error) {
                    created = false;
                    if (!fetcher.githubReleaseForTag(slug, plan.tag))
                        throw error;
                }
                notes.push(created ? `repaired GitHub Release ${plan.tag}` : `GitHub Release ${plan.tag} confirmed present after a failed create call`);
            }
        }
        const finalTags = [...new Set([...tags, ...candidates.filter((tag) => client.remoteTag(root, tag) !== null)])];
        const finalReleases = candidates.filter((tag) => fetcher.githubReleaseForTag(slug, tag));
        const result = auditReleaseCompleteness(finalTags, fetcher.npmVersions(name), finalReleases);
        return { failures: result.failures, notes: [...notes, ...result.notes] };
    }
    catch (error) {
        return { failures: [`release repair refused: ${error instanceof Error ? error.message : String(error)}`], notes };
    }
}
//# sourceMappingURL=release-repair.js.map
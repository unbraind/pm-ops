/** Structural and canonical tag provenance checks for shared release workflow callers. */
import { isScalar, parseDocument } from "yaml";
import { execFileSync } from "node:child_process";
import metadata from "./release-metadata.json" with { type: "json" };

/** Resolve canonical release tags, or only one exact tag, including annotated tag peeling. */
export function fetchCanonicalReleaseTags(run: (args: string[]) => string = runCanonicalTagApi, tag?: string): Record<string, string> {
  const tags: Record<string, string> = {};
  const endpoint = tag === undefined ? "repos/unbraind/pm-ops/git/refs/tags" : `repos/unbraind/pm-ops/git/matching-refs/tags/${tag}`;
  const refs = run(["api", "--paginate", endpoint, "--jq", ".[] | [.ref, .object.type, .object.sha] | @tsv"]);
  for (const line of refs.trim().split("\n")) {
    const [ref, initialType, initialSha] = line.split("\t");
    if (!/^refs\/tags\/v\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/.test(ref)) continue;
    if (tag !== undefined && ref !== `refs/tags/${tag}`) continue;
    let type = initialType, sha = initialSha;
    const seen = new Set<string>();
    while (type === "tag" && /^[a-f0-9]{40}$/.test(sha) && !seen.has(sha)) {
      seen.add(sha);
      [type, sha] = run(["api", `repos/unbraind/pm-ops/git/tags/${sha}`, "--jq", "[.object.type, .object.sha] | @tsv"]).trim().split("\t");
    }
    if (type !== "commit" || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Cannot verify canonical release tag");
    tags[ref.slice("refs/tags/".length)] = sha;
  }
  return tags;
}

/** Read the public canonical API even when gh authentication or the CLI is unavailable. */
function runCanonicalTagApi(args: string[]): string {
  try {
    return execFileSync("gh", ["api", "--hostname", "github.com", ...args.slice(1)], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    const endpoint = args.find(arg => arg.startsWith("repos/"))!.replace("/git/refs/tags", "/git/matching-refs/tags/");
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    const response = execFileSync("curl", ["--fail", "--silent", "--show-error", "--max-time", "20", "--header", "Accept: application/vnd.github+json", "--header", "@-", `https://api.github.com/${endpoint}`], {
      encoding: "utf8", timeout: 25_000, stdio: ["pipe", "pipe", "pipe"],
      input: token ? `Authorization: Bearer ${token}\n` : "",
    });
    const data = JSON.parse(response) as { ref: string; object: { type: string; sha: string } }[] | { object: { type: string; sha: string } };
    return Array.isArray(data)
      ? data.map(ref => [ref.ref, ref.object.type, ref.object.sha].join("\t")).join("\n")
      : [data.object.type, data.object.sha].join("\t");
  }
}

/** Explicit provenance outcome; unavailable fresh evidence never counts as approval. */
export interface ReleaseCallerResult {
  /** Whether canonical provenance was verified, refused, or deferred offline. */
  status: "verified" | "refused" | "unverified-offline";
  /** Structural or provenance diagnostics, including an explicit offline deferral. */
  errors: string[];
}

/** Narrow arbitrary YAML nodes without assuming that a scalar is a mapping. */
function mapping(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Whether PM_OPS_OFFLINE disables every networked canonical tag lookup.
 *
 * Every path that resolves canonical release tags offline shares this check, so the
 * documented offline mode behaves identically in policy runs, attestation audits and the CLI.
 */
export function isPmOpsOffline(): boolean {
  return process.env.PM_OPS_OFFLINE === "1" || process.env.PM_OPS_OFFLINE === "true";
}

/** Default resolver: never contacts the canonical API while PM_OPS_OFFLINE is set. */
export function defaultCanonicalTagResolver(tag?: string): Readonly<Record<string, string>> {
  if (isPmOpsOffline()) throw new Error("PM_OPS_OFFLINE is set: canonical release tags are not fetched");
  return fetchCanonicalReleaseTags(runCanonicalTagApi, tag);
}

/** Verify a SHA-pinned caller with no embedded jobs, private steps, or inherited secrets. */
export function inspectReleaseCaller(source: string, resolveTags: ((tag: string) => Readonly<Record<string, string>>) = defaultCanonicalTagResolver): ReleaseCallerResult {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) return { status: "refused", errors: ["release.yml is invalid YAML"] };
  const workflow = mapping(document.toJS());
  const jobs = Object.entries(mapping(workflow.jobs));
  const errors: string[] = [];
  let pin: { tag: string; sha: string } | undefined;
  if (jobs.length !== 1) errors.push("release.yml must contain exactly one reusable release job");
  for (const [id, value] of jobs) {
    const job = mapping(value);
    if (typeof job.uses !== "string" || job.uses.includes("0".repeat(40)) || !/^unbraind\/pm-ops\/\.github\/workflows\/daily-release\.yml@[a-f0-9]{40}$/.test(job.uses)) {
      errors.push("release job must call daily-release.yml at a full commit SHA");
    }
    const uses = document.getIn(["jobs", id, "uses"], true);
    const tag = isScalar(uses) ? uses.comment?.trim() : undefined;
    if (!tag || !/^v\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/.test(tag)) {
      errors.push("release SHA needs a Dependabot version comment naming the exact canonical tag (for example # v2026.07.06 or # v2026.07.06-2)");
    } else {
      pin = { tag, sha: String(job.uses).split("@")[1] };
    }
    if (Object.keys(job).some(key => !["name", "uses", "with", "permissions"].includes(key))) {
      errors.push("release job contains private logic or secrets");
    }
    const permissions = mapping(job.permissions);
    if (["contents", "pull-requests", "actions", "id-token", "issues"].some(key => permissions[key] !== "write")
      || Object.keys(permissions).some(key => !["contents", "pull-requests", "actions", "id-token", "issues"].includes(key))) {
      errors.push("caller must grant only the reusable workflow permissions at job level");
    }
    const inputs = mapping(job.with);
    if ("pm-ops-version" in inputs) errors.push("pm-ops version must be derived from the workflow release tag");
  }
  if (workflow.permissions === null || typeof workflow.permissions !== "object" || Object.keys(workflow.permissions).length !== 0) {
    errors.push("caller workflow permissions must be empty; grants belong to the call job");
  }
  const trigger = mapping(workflow.on);
  if (!("schedule" in trigger) || !("workflow_dispatch" in trigger)) errors.push("caller must allow schedule and workflow_dispatch continuation");
  if (Object.keys(trigger).some(key => !["schedule", "workflow_dispatch"].includes(key))) errors.push("caller permits an unsafe release trigger");
  if (Object.keys(workflow).some(key => !["name", "on", "permissions", "jobs"].includes(key))) errors.push("caller contains private workflow logic");
  if (errors.length > 0 || pin === undefined) return { status: "refused", errors };
  let tags: Readonly<Record<string, string>>;
  try {
    tags = resolveTags(pin.tag);
  } catch {
    tags = metadata.tags;
    if (!(pin.tag in tags)) return { status: "unverified-offline", errors: ["unverified-offline: canonical release tag is absent from the bundled snapshot; retry online to verify SHA provenance"] };
  }
  return tags[pin.tag] === pin.sha
    ? { status: "verified", errors: [] }
    : { status: "refused", errors: ["release SHA must match the exact canonical pm-ops release tag named in its comment (including v prefix, zero padding and any -N suffix)"] };
}

/** Compatibility diagnostics; use inspectReleaseCaller to distinguish offline deferral from refusal. */
export function checkReleaseCaller(source: string, releaseTags?: Readonly<Record<string, string>>): string[] {
  return inspectReleaseCaller(source, releaseTags === undefined ? undefined : () => releaseTags).errors;
}

/** Fail-closed structural check for fleet callers of the shared release workflow. */
import { isScalar, parseDocument } from "yaml";
import { execFileSync } from "node:child_process";
import metadata from "./release-metadata.json" with { type: "json" };
/** Resolve only release tags owned by the canonical repository, including annotated tags. */
export function fetchCanonicalReleaseTags(run = args => execFileSync("gh", args, { encoding: "utf8" })) {
    const tags = {};
    const refs = run(["api", "--paginate", "repos/unbraind/pm-ops/git/refs/tags", "--jq", ".[] | [.ref, .object.type, .object.sha] | @tsv"]);
    for (const line of refs.trim().split("\n")) {
        const [ref, initialType, initialSha] = line.split("\t");
        if (!/^refs\/tags\/v\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/.test(ref))
            continue;
        let type = initialType, sha = initialSha;
        const seen = new Set();
        while (type === "tag" && /^[a-f0-9]{40}$/.test(sha) && !seen.has(sha)) {
            seen.add(sha);
            [type, sha] = run(["api", `repos/unbraind/pm-ops/git/tags/${sha}`, "--jq", "[.object.type, .object.sha] | @tsv"]).trim().split("\t");
        }
        if (type !== "commit" || !/^[a-f0-9]{40}$/.test(sha))
            throw new Error("Cannot verify canonical release tag");
        tags[ref.slice("refs/tags/".length)] = sha;
    }
    return tags;
}
/** Narrow arbitrary YAML nodes without assuming that a scalar is a mapping. */
function mapping(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
/** Verify a SHA-pinned caller with no embedded jobs, private steps, or inherited secrets. */
export function checkReleaseCaller(source, releaseTags = metadata.tags) {
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0)
        return ["release.yml is invalid YAML"];
    const workflow = mapping(document.toJS());
    const jobs = Object.entries(mapping(workflow.jobs));
    const errors = [];
    if (jobs.length !== 1)
        errors.push("release.yml must contain exactly one reusable release job");
    for (const [id, value] of jobs) {
        const job = mapping(value);
        if (typeof job.uses !== "string" || job.uses.includes("0".repeat(40)) || !/^unbraind\/pm-ops\/\.github\/workflows\/daily-release\.yml@[a-f0-9]{40}$/.test(job.uses)) {
            errors.push("release job must call daily-release.yml at a full commit SHA");
        }
        const uses = document.getIn(["jobs", id, "uses"], true);
        const tag = isScalar(uses) ? uses.comment?.trim() : undefined;
        if (!tag || !/^v\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?$/.test(tag)) {
            errors.push("release SHA needs a Dependabot version comment (# vYYYY.M.D)");
        }
        else if (releaseTags[tag] !== String(job.uses).split("@")[1]) {
            errors.push("release SHA must match its canonical pm-ops release tag; refresh release metadata or check online");
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
        if ("pm-ops-version" in inputs)
            errors.push("pm-ops version must be derived from the workflow release tag");
    }
    if (workflow.permissions === null || typeof workflow.permissions !== "object" || Object.keys(workflow.permissions).length !== 0) {
        errors.push("caller workflow permissions must be empty; grants belong to the call job");
    }
    const trigger = mapping(workflow.on);
    if (!("schedule" in trigger) || !("workflow_dispatch" in trigger))
        errors.push("caller must allow schedule and workflow_dispatch continuation");
    if (Object.keys(trigger).some(key => !["schedule", "workflow_dispatch"].includes(key)))
        errors.push("caller permits an unsafe release trigger");
    if (Object.keys(workflow).some(key => !["name", "on", "permissions", "jobs"].includes(key)))
        errors.push("caller contains private workflow logic");
    return errors;
}
//# sourceMappingURL=release-caller.js.map
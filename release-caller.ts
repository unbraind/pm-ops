/** Fail-closed structural check for fleet callers of the shared release workflow. */
import { parseDocument } from "yaml";

/** Narrow arbitrary YAML nodes without assuming that a scalar is a mapping. */
function mapping(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Verify a SHA-pinned caller with no embedded jobs, private steps, or inherited secrets. */
export function checkReleaseCaller(source: string): string[] {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) return ["release.yml is invalid YAML"];
  const workflow = mapping(document.toJS());
  const jobs = Object.values(mapping(workflow.jobs)).map(mapping);
  const errors: string[] = [];
  if (jobs.length !== 1) errors.push("release.yml must contain exactly one reusable release job");
  for (const job of jobs) {
    if (typeof job.uses !== "string" || job.uses.includes("0".repeat(40)) || !/^unbraind\/pm-ops\/\.github\/workflows\/daily-release\.yml@[a-f0-9]{40}$/.test(job.uses)) {
      errors.push("release job must call daily-release.yml at a full commit SHA");
    }
    if (Object.keys(job).some(key => !["name", "uses", "with", "permissions"].includes(key))) {
      errors.push("release job contains private logic or secrets");
    }
    const permissions = mapping(job.permissions);
    if (["contents", "pull-requests", "actions", "id-token"].some(key => permissions[key] !== "write")
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
  if (!/^\s*uses: unbraind\/pm-ops\/\.github\/workflows\/daily-release\.yml@[a-f0-9]{40} # v\d{4}\.\d{1,2}\.\d{1,2}(?:-\d+)?\s*$/m.test(source)) {
    errors.push("release SHA needs a Dependabot version comment (# vYYYY.M.D)");
  }
  return errors;
}

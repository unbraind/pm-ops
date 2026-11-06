/** Authenticate a registry envelope before publication repair or receipt completion. */
import { readFileSync } from "node:fs";
import { verifyRegistryProvenance } from "../release-provenance.ts";
import { ensureReleaseRuntime } from "./release-runtime.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** Verify the supplied envelope using the caller identity rather than a reusable workflow alias. */
export async function runVerifyRegistryProvenance(envelope: unknown): Promise<boolean> {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const workflow = (process.env.CALLER_WORKFLOW ?? "").split(repository + "/")[1]?.split("@")[0] ?? "";
  const commit = process.env.EXPECTED_COMMIT ?? "", integrity = process.env.EXPECTED_INTEGRITY ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(workflow)
    || !/^[a-f0-9]{40}$/.test(commit) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error("Missing provenance verification identity");
  const signerWorkflow = process.env.PROVENANCE_SIGNER_WORKFLOW;
  if (signerWorkflow !== undefined && !/^[\w.-]+\/[\w.-]+\/\.github\/workflows\/[\w.-]+\.ya?ml@(?:refs\/heads\/[\w./-]+|refs\/tags\/[\w.-]+|[a-f0-9]{40})$/.test(signerWorkflow)) throw new Error("Missing provenance signer identity");
  ensureReleaseRuntime();
  return verifyRegistryProvenance(envelope, { repository, workflow, ref: "refs/heads/main", commit, integrity, signerWorkflow });
}

if (isMainInvocation(process.argv, import.meta.url)) {
  runVerifyRegistryProvenance(JSON.parse(readFileSync(0, "utf8"))).then(valid => { if (!valid) process.exitCode = 1; })
    .catch((error: unknown) => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
}

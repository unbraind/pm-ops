/** Authenticate a registry envelope before publication repair or receipt completion. */
import { readFileSync } from "node:fs";
import { originalPublicationSigner, verifyRegistryProvenance, type verifySigstoreBundle } from "../release-provenance.ts";
import { ensureReleaseRuntime } from "./release-runtime.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** Read only the original caller's Actions run after its invocation URL has been scoped. */
export async function readPublicationRun(path: string): Promise<unknown> {
  if (!process.env.GH_TOKEN) throw new Error("Missing token for original publication run verification");
  const response = await fetch("https://api.github.com/" + path, { headers: { Authorization: "Bearer " + process.env.GH_TOKEN, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("Original publication run is unavailable: " + response.status);
  return response.json();
}

/** Verify the supplied envelope and, for independent repair, resolve its authenticated original signer. */
export async function runVerifyRegistryProvenance(envelope: unknown, readRun = readPublicationRun, verify?: typeof verifySigstoreBundle): Promise<boolean> {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const workflow = (process.env.CALLER_WORKFLOW ?? "").split(repository + "/")[1]?.split("@")[0] ?? "";
  const commit = process.env.EXPECTED_COMMIT ?? "", integrity = process.env.EXPECTED_INTEGRITY ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(workflow)
    || !/^[a-f0-9]{40}$/.test(commit) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error("Missing provenance verification identity");
  const signerWorkflow = process.env.PROVENANCE_SIGNER_WORKFLOW;
  if (signerWorkflow !== undefined && !/^[\w.-]+\/[\w.-]+\/\.github\/workflows\/[\w.-]+\.ya?ml@(?:refs\/heads\/[\w./-]+|refs\/tags\/[\w.-]+|[a-f0-9]{40})$/.test(signerWorkflow)) throw new Error("Missing provenance signer identity");
  ensureReleaseRuntime();
  const identity = { repository, workflow, ref: "refs/heads/main", commit, integrity, signerWorkflow };
  if (process.env.PROVENANCE_RECOVERY === "true" && signerWorkflow === undefined) {
    try { if (await verifyRegistryProvenance(envelope, identity, verify)) return true; }
    catch { /* A reusable certificate must be checked against the original trusted run, never decoded claims alone. */ }
    return verifyRegistryProvenance(envelope, { ...identity, signerWorkflow: await originalPublicationSigner(envelope, identity, readRun) }, verify);
  }
  return verifyRegistryProvenance(envelope, identity, verify);
}

if (isMainInvocation(process.argv, import.meta.url)) {
  runVerifyRegistryProvenance(JSON.parse(readFileSync(0, "utf8"))).then(valid => { if (!valid) process.exitCode = 1; })
    .catch((error: unknown) => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
}

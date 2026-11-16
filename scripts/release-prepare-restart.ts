/** Redispatch only a rejected preparation, preserving caller inputs and its bounded counter. */
import { appendFileSync } from "node:fs";
import { decidePrepareRestart } from "../release-prepare-restart.ts";
import { githubApi, type ReleaseApi } from "./release-continuation.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** Trusted workflow context, separate from untrusted package code and artifacts. */
export interface PrepareRestartOptions {
  repository: string;
  workflowRef: string;
  baseSha: string;
  config: Record<string, unknown>;
  eventInputs: Record<string, unknown>;
  timezone: string;
  now: string;
}

/** Read the calendar cap completely, then dispatch the same caller on main with one more restart. */
export async function restartPreparation(options: PrepareRestartOptions, api: ReleaseApi = githubApi): Promise<string> {
  const { repository, workflowRef, baseSha, config, eventInputs, timezone, now } = options;
  const workflow = workflowRef.slice(repository.length + 1).replace(/@refs\/heads\/main$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !workflowRef.startsWith(repository + "/")
    || !workflowRef.endsWith("@refs/heads/main") || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(workflow)
    || !/^[a-f0-9]{40}$/.test(baseSha)) throw new Error("Unexpected prepare restart identity");
  const restartCount = config["prepare-restart-count"] ?? 0;
  if (typeof restartCount !== "number" || Number(eventInputs["prepare-restart-count"] ?? 0) !== restartCount) {
    throw new Error("Caller must pass through prepare-restart-count without resetting it");
  }
  const facts = { baseSha, mainSha: baseSha, restartCount, publishedToday: false,
    reconcileOnly: config["reconcile-only"] === true, retireUnpublished: config["retire-unpublished"] === true };
  // Validate even terminal counters and recovery modes before reading or dispatching anything.
  if (decidePrepareRestart(facts) === "stop") return "Recovery mode; no preparation restart.";
  const repo = `repos/${repository}`;
  const main = await api(`${repo}/git/ref/heads/main`) as { object?: { sha?: string } } | null;
  if (!main?.object?.sha || !/^[a-f0-9]{40}$/.test(main.object.sha)) throw new Error("Unreadable current main for prepare restart");
  facts.mainSha = main.object.sha;
  const calendar = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const today = calendar.format(new Date(now));
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error("Publication evidence exceeds the bounded pagination limit");
    const releases = await api(`${repo}/releases?per_page=100&page=${page}`) as { published_at: string | null; draft: boolean }[];
    if (!Array.isArray(releases) || releases.some(release => !release || typeof release.draft !== "boolean"
      || (release.published_at !== null && (typeof release.published_at !== "string" || !Number.isFinite(Date.parse(release.published_at)))))) {
      throw new Error("Unreadable publication dates for prepare restart");
    }
    if (releases.some(release => !release.draft && release.published_at && calendar.format(new Date(release.published_at)) === today)) {
      facts.publishedToday = true;
      break;
    }
    if (releases.length < 100) break;
  }
  const action = decidePrepareRestart(facts);
  if (action === "stop") return "Already released today; no preparation restart.";
  if (action === "fail") throw new Error(`main advanced from ${baseSha} to ${facts.mainSha} while preparing the release. Retry from the new main head.`);
  await api(`${repo}/actions/workflows/${workflow.split("/").at(-1)}/dispatches`, "POST", {
    ref: "main", inputs: { ...eventInputs, "prepare-restart-count": restartCount + 1 },
  });
  return `Restart ${restartCount + 1}/2: ${baseSha} → ${facts.mainSha}; dispatched ${workflow} on main for complete fresh preparation.`;
}

if (isMainInvocation(process.argv, import.meta.url)) {
  const env = process.env;
  const message = await restartPreparation({ repository: env.GITHUB_REPOSITORY ?? "", workflowRef: env.CALLER_WORKFLOW ?? "",
    baseSha: env.RESTART_BASE_SHA ?? "", config: JSON.parse(env.RELEASE_CONFIG ?? "{}"),
    eventInputs: JSON.parse(env.RELEASE_EVENT_INPUTS ?? "null") ?? {}, timezone: env.RELEASE_TIMEZONE ?? "Europe/Vienna", now: new Date().toISOString() });
  process.stdout.write(message + "\n");
  appendFileSync(env.GITHUB_STEP_SUMMARY!, message + "\n");
}

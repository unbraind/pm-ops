/** Redispatch rejected preparation using complete daily caller run history as the bound. */
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
  timezone: string;
  now: string;
}

/** Find the first instant of today's local date, including offset changes at midnight. */
function releaseDayStart(now: string, calendar: Intl.DateTimeFormat): string {
  let end = Date.parse(now);
  let start = end - 48 * 60 * 60 * 1000;
  const today = calendar.format(new Date(end));
  while (end - start > 1) {
    const middle = Math.floor((start + end) / 2);
    if (calendar.format(new Date(middle)) < today) start = middle;
    else end = middle;
  }
  return new Date(end).toISOString();
}

/** Require complete, consistent pagination; incomplete history cannot authorize another dispatch. */
async function botDispatchesToday(path: string, api: ReleaseApi): Promise<number> {
  let total: number | undefined, count = 0;
  const seen = new Set<number>();
  // Each continuing page adds 100 unique IDs toward a stable total capped at 1000.
  // The tenth page therefore returns or refuses; no unreachable eleventh-page guard is needed.
  let page = 0;
  while (true) {
    page++;
    const result = await api(`${path}&per_page=100&page=${page}`) as {
      total_count: number;
      workflow_runs: { id: number; triggering_actor?: { login?: string } | null; actor?: { login?: string } | null }[];
    } | null;
    if (!result || !Number.isSafeInteger(result.total_count) || result.total_count < 0 || result.total_count > 1000
      || (total !== undefined && result.total_count !== total) || !Array.isArray(result.workflow_runs)
      || result.workflow_runs.length > 100) throw new Error("Unreadable or truncated caller run history");
    total = result.total_count;
    for (const run of result.workflow_runs) {
      const login = run?.actor?.login ?? run?.triggering_actor?.login;
      if (!run || !Number.isSafeInteger(run.id) || run.id < 1 || seen.has(run.id) || typeof login !== "string" || !login) {
        throw new Error("Unreadable or duplicated caller run history");
      }
      seen.add(run.id);
      if (login === "github-actions[bot]") count++;
    }
    if (seen.size === total) return count;
    if (seen.size > total || result.workflow_runs.length < 100) throw new Error("Incomplete caller run history pagination");
  }
}

/** Check live publication evidence and the daily bot bound, then dispatch without caller inputs. */
async function restartFromHistory(options: PrepareRestartOptions, api: ReleaseApi): Promise<string> {
  const { repository, workflowRef, baseSha, config, timezone, now } = options;
  const workflow = workflowRef.slice(repository.length + 1).replace(/@refs\/heads\/main$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !workflowRef.startsWith(repository + "/")
    || !workflowRef.endsWith("@refs/heads/main") || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(workflow)
    || !/^[a-f0-9]{40}$/.test(baseSha)) throw new Error("Unexpected prepare restart identity");
  const facts = { baseSha, mainSha: baseSha, botDispatchCount: 0, publishedToday: false,
    reconcileOnly: config["reconcile-only"] === true, retireUnpublished: config["retire-unpublished"] === true };
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
  if (facts.publishedToday) return "Already released today; no preparation restart.";
  const caller = `${repo}/actions/workflows/${workflow.split("/").at(-1)}`;
  const created = encodeURIComponent(">=" + releaseDayStart(now, calendar));
  facts.botDispatchCount = await botDispatchesToday(`${caller}/runs?event=workflow_dispatch&branch=main&created=${created}`, api);
  if (decidePrepareRestart(facts) !== "restart") {
    throw new Error(`main advanced from ${baseSha} to ${facts.mainSha} while preparing the release. Retry from the new main head. (${facts.botDispatchCount}/2 bot dispatches today.)`);
  }
  await api(`${caller}/dispatches`, "POST", { ref: "main" });
  return `Restart ${facts.botDispatchCount + 1}/2 today: ${baseSha} → ${facts.mainSha}; dispatched ${workflow} on main for complete fresh preparation.`;
}

/** Surface read, pagination and dispatch failures as explicit workflow errors without admitting a retry. */
export async function restartPreparation(options: PrepareRestartOptions, api: ReleaseApi = githubApi): Promise<string> {
  try { return await restartFromHistory(options, api); }
  catch (error) { throw new Error(`::error::Prepare restart refused: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Parse trusted environment and report the executable result through the supplied process ports. */
export async function runPrepareRestartCli(
  env: NodeJS.ProcessEnv = process.env,
  api: ReleaseApi = githubApi,
  io = { out: (text: string) => { process.stdout.write(text); }, err: (text: string) => { process.stderr.write(text); },
    fail: () => { process.exitCode = 1; } },
): Promise<void> {
  try {
    const message = await restartPreparation({ repository: env.GITHUB_REPOSITORY ?? "", workflowRef: env.CALLER_WORKFLOW ?? "",
      baseSha: env.RESTART_BASE_SHA ?? "", config: JSON.parse(env.RELEASE_CONFIG ?? "{}"),
      timezone: env.RELEASE_TIMEZONE ?? "Europe/Vienna", now: new Date().toISOString() }, api);
    io.out(message + "\n");
    appendFileSync(env.GITHUB_STEP_SUMMARY!, message + "\n");
  } catch (error) {
    io.err((error instanceof Error ? error.message : String(error)) + "\n");
    io.fail();
  }
}

if (isMainInvocation(process.argv, import.meta.url)) await runPrepareRestartCli();

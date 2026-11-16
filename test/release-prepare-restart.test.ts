/** Test restart admission and the real dispatch adapter against synthetic GitHub run history. */
import assert from "node:assert/strict";
import test from "node:test";
import { decidePrepareRestart, type PrepareRestartInput } from "../release-prepare-restart.ts";
import { releaseConfigDigest } from "../release-continuation.ts";
import { restartPreparation, type PrepareRestartOptions } from "../scripts/release-prepare-restart.ts";
import type { ReleaseApi } from "../scripts/release-continuation.ts";

const oldHead = "a".repeat(40), newHead = "b".repeat(40);
const facts: PrepareRestartInput = { baseSha: oldHead, mainSha: newHead, botDispatchCount: 0,
  publishedToday: false, reconcileOnly: false, retireUnpublished: false };

/** An unchanged caller has no internal restart input or event-input forwarding. */
function options(): PrepareRestartOptions {
  return { repository: "example/package", workflowRef: "example/package/.github/workflows/release.yml@refs/heads/main",
    baseSha: oldHead, config: { "verify-script": "release:check", "retire-unpublished": false },
    timezone: "Europe/Vienna", now: "2026-11-16T19:00:00Z" };
}

/** Synthetic workflow-run actor fields, including old responses without triggering_actor. */
interface Run {
  id: number;
  triggering_actor?: { login: string } | null;
  actor?: { login: string };
}

/** Execute the real adapter with fully paginated history and capture every side effect. */
function fixture(runs: Run[] = []) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const api: ReleaseApi = async (path, method = "GET", body) => {
    calls.push({ path, method, body });
    if (path.endsWith("/git/ref/heads/main")) return { object: { sha: newHead } };
    if (path.includes("/releases?")) return [];
    if (path.includes("/runs?")) {
      const page = Number(new URL("https://example.invalid/" + path).searchParams.get("page"));
      return { total_count: runs.length, workflow_runs: runs.slice((page - 1) * 100, page * 100) };
    }
    assert.equal(path, "repos/example/package/actions/workflows/release.yml/dispatches");
    assert.equal(method, "POST");
    assert.deepEqual(body, { ref: "main" });
    return {};
  };
  return { api, calls };
}

test("an advanced base restarts below the daily bot bound and stops for publication or recovery", () => {
  for (const botDispatchCount of [0, 1]) assert.equal(decidePrepareRestart({ ...facts, botDispatchCount }), "restart");
  for (const botDispatchCount of [2, 3]) assert.equal(decidePrepareRestart({ ...facts, botDispatchCount }), "fail");
  assert.equal(decidePrepareRestart({ ...facts, mainSha: oldHead }), "fail");
  assert.equal(decidePrepareRestart({ ...facts, publishedToday: true }), "stop");
  assert.equal(decidePrepareRestart({ ...facts, reconcileOnly: true }), "stop");
  assert.equal(decidePrepareRestart({ ...facts, retireUnpublished: true }), "stop");
  for (const botDispatchCount of [-1, 0.5, NaN, Infinity]) assert.throws(() => decidePrepareRestart({ ...facts, botDispatchCount }), /Invalid bot dispatch history count/);
});

test("zero or one bot dispatch permits input-free restart without changing caller configuration or digest", async () => {
  for (const count of [0, 1]) {
    const { api, calls } = fixture(Array.from({ length: count }, (_, id) => ({ id: id + 1, triggering_actor: { login: "github-actions[bot]" } })));
    const input = options(), before = structuredClone(input.config), digest = releaseConfigDigest(input.config);
    assert.match(await restartPreparation(input, api), new RegExp(`Restart ${count + 1}/2 today: ${oldHead} → ${newHead}`));
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.at(-1)?.body, { ref: "main" });
    assert.deepEqual(input.config, before);
    assert.equal(releaseConfigDigest(input.config), digest);
    const url = new URL("https://example.invalid/" + calls[2].path);
    assert.equal(url.pathname, "/repos/example/package/actions/workflows/release.yml/runs");
    assert.equal(url.searchParams.get("event"), "workflow_dispatch");
    assert.equal(url.searchParams.get("branch"), "main");
    assert.equal(url.searchParams.get("created"), ">=2026-11-15T23:00:00.000Z");
  }
});

test("two or more bot dispatches refuse with the existing main-advanced diagnostic", async () => {
  for (const count of [2, 3]) {
    const { api, calls } = fixture(Array.from({ length: count }, (_, id) => ({ id: id + 1, actor: { login: "github-actions[bot]" } })));
    await assert.rejects(restartPreparation(options(), api), new RegExp(`::error::Prepare restart refused: main advanced from ${oldHead} to ${newHead} while preparing the release`));
    assert.ok(calls.every(call => call.method === "GET"));
  }
});

test("owner dispatches are ignored, triggering_actor takes precedence, and actor is the fallback", async () => {
  const { api, calls } = fixture([
    { id: 1, triggering_actor: { login: "owner" }, actor: { login: "github-actions[bot]" } },
    { id: 2, actor: { login: "owner" } },
    { id: 3, triggering_actor: { login: "owner" } },
    { id: 4, triggering_actor: null, actor: { login: "github-actions[bot]" } },
  ]);
  assert.match(await restartPreparation(options(), api), /Restart 2\/2/);
  assert.deepEqual(calls.at(-1)?.body, { ref: "main" });
});

test("history pagination counts bots on later pages and refuses incomplete or inconsistent evidence", async () => {
  const owners = Array.from({ length: 100 }, (_, id) => ({ id: id + 1, actor: { login: "owner" } }));
  const runs = [...owners, { id: 101, actor: { login: "github-actions[bot]" } }, { id: 102, actor: { login: "github-actions[bot]" } }];
  const full = fixture(runs);
  await assert.rejects(restartPreparation(options(), full.api), /2\/2 bot dispatches today/);
  assert.equal(full.calls.filter(call => call.path.includes("/runs?")).length, 2);
  for (const result of [null, {}, { total_count: 1, workflow_runs: [] }, { total_count: 1001, workflow_runs: owners },
    { total_count: 1, workflow_runs: [{}] }, { total_count: 2, workflow_runs: [runs[0], runs[0]] }]) {
    const { api, calls } = fixture();
    await assert.rejects(restartPreparation(options(), async (path, ...args) => path.includes("/runs?") ? result : api(path, ...args)), /::error::.*(history|pagination)/);
    assert.ok(calls.every(call => call.method === "GET"));
  }
  for (const later of [{ total_count: 101, workflow_runs: [] }, { total_count: 102, workflow_runs: [runs[0], runs[1]] }]) {
    const { api, calls } = fixture(runs);
    await assert.rejects(restartPreparation(options(), async (path, ...args) => path.includes("/runs?") && path.endsWith("page=2") ? later : api(path, ...args)), /::error::.*(history|pagination)/);
    assert.ok(calls.every(call => call.method === "GET"));
  }
});

test("complete owner-only history across pages permits a restart while an unchanged head refuses", async () => {
  const owners = Array.from({ length: 101 }, (_, id) => ({ id: id + 1, actor: { login: "owner" } }));
  const full = fixture(owners);
  assert.match(await restartPreparation(options(), full.api), /Restart 1\/2/);
  assert.equal(full.calls.filter(call => call.path.includes("/runs?")).length, 2);
  const unchanged = fixture();
  await assert.rejects(restartPreparation(options(), async (path, ...args) => path.endsWith("/git/ref/heads/main")
    ? { object: { sha: oldHead } } : unchanged.api(path, ...args)), /::error::Prepare restart refused/);
  assert.ok(unchanged.calls.every(call => call.method === "GET"));
});

test("read errors including later pagination pages fail closed with an explicit workflow error", async () => {
  const owners = Array.from({ length: 101 }, (_, id) => ({ id: id + 1, actor: { login: "owner" } }));
  for (const failingPath of ["/git/ref/", "/releases?", "/runs?", "page=2"]) {
    const { api, calls } = fixture(owners);
    await assert.rejects(restartPreparation(options(), async (path, ...args) => {
      if (path.includes(failingPath)) throw new Error("API unavailable");
      return api(path, ...args);
    }), /::error::Prepare restart refused: API unavailable/);
    assert.ok(calls.every(call => call.method === "GET"));
  }
});

test("already published today stops after live release pagination without reading history or dispatching", async () => {
  const { api, calls } = fixture();
  let reads = 0;
  const result = await restartPreparation(options(), async (path, ...args) => {
    if (!path.includes("/releases?")) return api(path, ...args);
    reads++;
    return path.endsWith("page=1") ? Array.from({ length: 100 }, () => ({ draft: false, published_at: "2026-11-14T23:30:00Z" }))
      : [{ draft: true, published_at: null }, { draft: false, published_at: "2026-11-15T23:30:00Z" }];
  });
  assert.match(result, /Already released today/);
  assert.equal(reads, 2);
  assert.ok(calls.every(call => call.path.endsWith("/git/ref/heads/main")));
});

test("history starts at local midnight across DST and non-hour offsets", async () => {
  for (const [timezone, now, start] of [
    ["Europe/Vienna", "2026-03-29T15:00:00Z", "2026-03-28T23:00:00.000Z"],
    ["Europe/Vienna", "2026-10-25T15:00:00Z", "2026-10-24T22:00:00.000Z"],
    ["Asia/Kathmandu", "2026-11-16T00:00:00Z", "2026-11-15T18:15:00.000Z"],
    ["America/Los_Angeles", "2026-11-16T00:00:00Z", "2026-11-15T08:00:00.000Z"],
  ]) {
    const { api, calls } = fixture();
    await restartPreparation({ ...options(), timezone, now }, api);
    assert.equal(new URL("https://example.invalid/" + calls[2].path).searchParams.get("created"), ">=" + start);
  }
});

test("recovery and retirement remain read-free and malformed identity or publication evidence refuses restart", async () => {
  for (const mode of ["reconcile-only", "retire-unpublished"]) {
    const input = options();
    input.config[mode] = true;
    assert.match(await restartPreparation(input, async () => { throw new Error("Recovery must not read or dispatch"); }), /Recovery mode/);
  }
  await assert.rejects(restartPreparation({ ...options(), workflowRef: "foreign/package/.github/workflows/release.yml@refs/heads/main" }, async () => null), /Unexpected prepare restart identity/);
  await assert.rejects(restartPreparation(options(), async () => null), /Unreadable current main/);
  for (const releases of [null, [{}], [{ draft: false, published_at: "invalid" }]]) {
    const { api, calls } = fixture();
    await assert.rejects(restartPreparation(options(), async (path, ...args) => path.includes("/releases?") ? releases : api(path, ...args)), /Unreadable publication dates/);
    assert.ok(calls.every(call => call.method === "GET"));
  }
});

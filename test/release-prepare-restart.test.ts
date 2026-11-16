/** Test restart admission and the real dispatch adapter against synthetic GitHub evidence. */
import assert from "node:assert/strict";
import test from "node:test";
import { decidePrepareRestart, type PrepareRestartInput } from "../release-prepare-restart.ts";
import { releaseConfigDigest } from "../release-continuation.ts";
import { restartPreparation, type PrepareRestartOptions } from "../scripts/release-prepare-restart.ts";
import type { ReleaseApi } from "../scripts/release-continuation.ts";

const oldHead = "a".repeat(40), newHead = "b".repeat(40);
const facts: PrepareRestartInput = { baseSha: oldHead, mainSha: newHead, restartCount: 0,
  publishedToday: false, reconcileOnly: false, retireUnpublished: false };

/** A supported caller, with a custom dispatch input that must survive every restart. */
function options(count = 0): PrepareRestartOptions {
  return { repository: "example/package", workflowRef: "example/package/.github/workflows/release.yml@refs/heads/main",
    baseSha: oldHead, config: { "prepare-restart-count": count }, eventInputs: { custom: "unchanged", "prepare-restart-count": String(count) },
    timezone: "Europe/Vienna", now: "2026-11-16T19:00:00Z" };
}

test("an advanced base restarts before the bound, fails at the bound and never restarts after today's release", () => {
  for (const restartCount of [0, 1]) assert.equal(decidePrepareRestart({ ...facts, restartCount }), "restart");
  assert.equal(decidePrepareRestart({ ...facts, restartCount: 2 }), "fail");
  assert.equal(decidePrepareRestart({ ...facts, mainSha: oldHead }), "fail");
  for (const restartCount of [0, 1, 2]) assert.equal(decidePrepareRestart({ ...facts, restartCount, publishedToday: true }), "stop");
  assert.equal(decidePrepareRestart({ ...facts, reconcileOnly: true }), "stop");
  assert.equal(decidePrepareRestart({ ...facts, retireUnpublished: true }), "stop");
  for (const restartCount of [-1, 0.5, 3, NaN, Infinity]) assert.throws(() => decidePrepareRestart({ ...facts, restartCount }), /Invalid prepare restart counter/);
});

test("redispatch preserves all caller inputs and increments the counter through two complete preparations", async () => {
  for (const count of [0, 1]) {
    const calls: unknown[] = [];
    const api: ReleaseApi = async (path, method = "GET", body) => {
      calls.push({ path, method, body });
      if (path.endsWith("/git/ref/heads/main")) return { object: { sha: newHead } };
      if (path.includes("/releases?")) return [];
      assert.equal(path, "repos/example/package/actions/workflows/release.yml/dispatches");
      assert.equal(method, "POST");
      assert.deepEqual(body, { ref: "main", inputs: { custom: "unchanged", "prepare-restart-count": count + 1 } });
      return {};
    };
    assert.match(await restartPreparation(options(count), api), new RegExp(`Restart ${count + 1}/2: ${oldHead} → ${newHead}`));
    assert.equal(calls.length, 3);
  }
  // Scheduling metadata never strands a restarted candidate when the hourly caller resets to zero.
  for (const count of [0, 1, 2]) assert.equal(releaseConfigDigest({ "prepare-restart-count": count, "verify-script": "release:check" }), releaseConfigDigest({ "verify-script": "release:check" }));
});

test("live publication cap exhausts pages and respects timezone and drafts without dispatching", async () => {
  let reads = 0;
  const api: ReleaseApi = async (path, method = "GET") => {
    assert.equal(method, "GET");
    if (path.endsWith("/git/ref/heads/main")) return { object: { sha: newHead } };
    reads++;
    return path.endsWith("page=1") ? Array.from({ length: 100 }, () => ({ draft: false, published_at: "2026-11-14T23:30:00Z" }))
      : [{ draft: true, published_at: null }, { draft: false, published_at: "2026-11-15T23:30:00Z" }];
  };
  assert.match(await restartPreparation(options(), api), /Already released today/);
  assert.equal(reads, 2);
});

test("exhaustion retains the main-advanced diagnostic, while recovery and retirement remain read-free", async () => {
  const api: ReleaseApi = async (path, method = "GET") => {
    assert.equal(method, "GET");
    return path.includes("/releases?") ? [] : { object: { sha: newHead } };
  };
  await assert.rejects(restartPreparation(options(2), api), { message: `main advanced from ${oldHead} to ${newHead} while preparing the release. Retry from the new main head.` });
  for (const mode of ["reconcile-only", "retire-unpublished"]) {
    const input = options();
    input.config[mode] = true;
    assert.match(await restartPreparation(input, async () => { throw new Error("Recovery must not read or dispatch"); }), /Recovery mode/);
  }
});

test("malformed or reset counters and unreadable evidence fail closed instead of authorizing a restart", async () => {
  const noReads: ReleaseApi = async () => { throw new Error("Unexpected read"); };
  const reset = options(0);
  reset.eventInputs["prepare-restart-count"] = 1;
  await assert.rejects(restartPreparation(reset, noReads), /must pass through/);
  const badCount = options();
  badCount.config["prepare-restart-count"] = "1";
  await assert.rejects(restartPreparation(badCount, noReads), /must pass through/);
  await assert.rejects(restartPreparation(options(3), noReads), /Invalid prepare restart counter/);
  await assert.rejects(restartPreparation({ ...options(), workflowRef: "foreign/package/.github/workflows/release.yml@refs/heads/main" }, noReads), /Unexpected prepare restart identity/);
  await assert.rejects(restartPreparation(options(), async () => null), /Unreadable current main/);
  await assert.rejects(restartPreparation(options(), async path => path.includes("/releases?") ? null : { object: { sha: newHead } }), /Unreadable publication dates/);
  await assert.rejects(restartPreparation(options(), async path => path.includes("/releases?") ? [{}] : { object: { sha: newHead } }), /Unreadable publication dates/);
  await assert.rejects(restartPreparation(options(), async () => { throw new Error("API unavailable"); }), /API unavailable/);
});

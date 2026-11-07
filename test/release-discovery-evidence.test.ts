/** Keep migration receipts coupled to the runtime discovery budget and its refusal boundary. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { discoverCandidatePrs } from "../scripts/release-continuation.ts";
import { replaceFixtureOnce } from "./fixture-contracts.ts";

const adapter = readFileSync(new URL("../scripts/release-continuation.ts", import.meta.url), "utf8");
const guide = readFileSync(new URL("../docs/release-migration.md", import.meta.url), "utf8");

/** Extract both executable limits, refusing an inconsistent page-completion predicate. */
function discoveryBudget(source: string): { pages: number; size: number; capacity: number } {
  const pages = Number(/page <= (\d+)/.exec(source)?.[1]);
  const size = Number(/per_page=(\d+)/.exec(source)?.[1]);
  assert.ok(Number.isSafeInteger(pages) && pages > 0);
  assert.ok(Number.isSafeInteger(size) && size > 0);
  assert.equal(Number(/data.length < (\d+)/.exec(source)?.[1]), size);
  return { pages, size, capacity: pages * size };
}

/** Require measurements, a reviewable PR receipt, the real bound and its rollout consequence together. */
function assertDiscoveryEvidence(markdown: string, source: string): void {
  const budget = discoveryBudget(source);
  assert.match(markdown, /its migration PR must record the creator-filtered bot-created issue\/PR count and active receipt count, and explicitly assess the discovery total against the pagination limit\./);
  const limit = /refuse incomplete pagination at (\d+) full pages \((\d+) records per page\): ([\d,]+) records reach the bound and must block rollout until an explicit durable index is in place\./.exec(markdown);
  assert.ok(limit, "missing measured discovery budget and rollout refusal");
  assert.deepEqual(limit.slice(1).map(value => Number(value.replaceAll(",", ""))), [budget.pages, budget.size, budget.capacity]);
  assert.match(markdown, /Repositories approaching that bound require an explicit durable index before migration\./);
}

test("every creator-filtered discovery guide requires a migration PR count and executable budget assessment", () => {
  const files = ["README.md", ...readdirSync(new URL("../docs/", import.meta.url), { recursive: true, encoding: "utf8" })
    .filter(path => path.endsWith(".md")).map(path => `docs/${path}`)];
  const checked: string[] = [];
  for (const file of files) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    if (!/creator=github-actions(?:%5Bbot%5D|\[bot\])/i.test(text)) continue;
    assertDiscoveryEvidence(text, adapter);
    checked.push(file);
  }
  assert.ok(checked.includes("docs/release-migration.md"), "the migration command must remain in the audit");
});

test("discovery evidence rejects omitted receipt fields, altered budgets and missing rollout consequences", () => {
  for (const phrase of ["its migration PR", "creator-filtered bot-created issue/PR count", "active receipt count", "explicitly assess the discovery total against the pagination limit",
    "100 full pages", "100 records per page", "10,000 records", "must block rollout", "Repositories approaching that bound require an explicit durable index before migration."]) {
    const changed = replaceFixtureOnce(guide, phrase, "omitted");
    assert.throws(() => assertDiscoveryEvidence(changed, adapter));
  }
  for (const pages of [1, 99, 101, 200]) {
    const changed = replaceFixtureOnce(adapter, "page <= 100", `page <= ${pages}`);
    assert.throws(() => assertDiscoveryEvidence(guide, changed));
  }
  for (const size of [1, 99, 101, 200]) {
    const changed = replaceFixtureOnce(replaceFixtureOnce(adapter, "per_page=100", `per_page=${size}`), "data.length < 100", `data.length < ${size}`);
    assert.throws(() => assertDiscoveryEvidence(guide, changed));
  }
});

test("the real discovery index accepts counts below the documented bound and refuses a full final page", async () => {
  const budget = discoveryBudget(adapter);
  for (const count of [0, 58, budget.size - 1, budget.size, budget.capacity - 1, budget.capacity, budget.capacity + 1]) {
    let calls = 0;
    const result = discoverCandidatePrs("example/package", "main", async path => {
      assert.match(path, /\/issues\?state=all&creator=github-actions%5Bbot%5D&sort=created&direction=asc/);
      const query = new URL("https://example.invalid/" + path).searchParams;
      assert.equal(Number(query.get("per_page")), budget.size);
      const page = Number(query.get("page"));
      assert.equal(page, ++calls);
      return Array.from({ length: Math.min(budget.size, Math.max(0, count - (page - 1) * budget.size)) }, (_, index) => ({ number: (page - 1) * budget.size + index + 1, body: null }));
    });
    if (count < budget.capacity) assert.deepEqual(await result, []);
    else await assert.rejects(result, /bounded pagination limit/);
    assert.equal(calls, Math.min(budget.pages, Math.floor(count / budget.size) + 1));
  }
});

/** Keep operator-facing permission claims synchronized with every executable release job. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

/** Explicit job grants, independent of caller ceilings or repository defaults. */
interface PermissionWorkflow {
  permissions: Record<string, string>;
  jobs: Record<string, { permissions: Record<string, string> }>;
}

const guide = readFileSync(new URL("../docs/reusable-release.md", import.meta.url), "utf8");
const workflow = parse(readFileSync(new URL("../.github/workflows/daily-release.yml", import.meta.url), "utf8")) as PermissionWorkflow;

/** Read inline scope/access pairs without accepting malformed or duplicated grants. */
function grants(text: string): [string, string][] {
  const seen = new Set<string>();
  return [...text.matchAll(/`([^`]+)`/g)].map(([, token]): [string, string] => {
    const parts = token.split(": ");
    assert.equal(parts.length, 2, "permission claim must name scope and access");
    assert.match(parts[0], /^[a-z-]+$/);
    assert.ok(["read", "write", "none"].includes(parts[1]));
    assert.ok(!seen.has(parts[0]), "duplicate documented permission");
    seen.add(parts[0]);
    return [parts[0], parts[1]];
  }).sort();
}

/** Compare the entire matrix and exclusive prose claims with the workflow's actual grants. */
function assertPermissionDocumentation(markdown: string, source: PermissionWorkflow): void {
  assert.deepEqual(source.permissions, {}, "documentation assumes an empty workflow-wide grant");
  const section = markdown.split("## Job permissions\n")[1]?.split("\n## ")[0];
  assert.ok(section, "missing job permission matrix");
  const rows = [...section.matchAll(/^\| `([\w-]+)` \| ([^|]+) \| [^|]+\|$/gm)];
  const expected = new Map(Object.entries(source.jobs).map(([id, job]) => [id, Object.entries(job.permissions).sort()]));
  const seen = new Set<string>();
  assert.equal(rows.length, expected.size, "permission matrix must cover every job");
  for (const [, id, permissions] of rows) {
    assert.ok(expected.has(id), "undocumented workflow job identity");
    assert.ok(!seen.has(id), "duplicate job permission row");
    seen.add(id);
    assert.deepEqual(grants(permissions), expected.get(id), `permission matrix drift: ${id}`);
  }
  const exclusive = [...markdown.matchAll(/The `([\w-]+)` job has only ([^;]+);/g)];
  assert.ok(exclusive.some(([, id]) => id === "recover"), "recovery explanation must remain documented");
  for (const [, id, permissions] of exclusive) assert.deepEqual(grants(permissions), expected.get(id), `exclusive permission claim drift: ${id}`);
  for (const [, id, permission] of markdown.matchAll(/`([\w-]+)` job alone receives `([^`]+)`/g)) {
    const [[scope, access]] = grants("`" + permission + "`");
    assert.deepEqual([...expected].filter(([, values]) => values.some(([key, value]) => key === scope && value === access)).map(([key]) => key), [id], "exclusive grant owner drift");
  }
  assert.match(markdown, /`actions: read`[^;.]*original publication run/, "explain the recovery Actions grant");
}

test("the permission guide covers every job and its exclusive recovery and alert claims", () => {
  assertPermissionDocumentation(guide, workflow);
});

test("permission documentation rejects grant additions, omissions and access changes in any job", () => {
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const added = structuredClone(workflow);
    added.jobs[id].permissions.packages = "read";
    assert.throws(() => assertPermissionDocumentation(guide, added), /permission matrix drift/);
    for (const [scope, access] of Object.entries(job.permissions)) {
      const missing = structuredClone(workflow);
      delete missing.jobs[id].permissions[scope];
      assert.throws(() => assertPermissionDocumentation(guide, missing), /permission matrix drift/);
      const changed = structuredClone(workflow);
      changed.jobs[id].permissions[scope] = access === "write" ? "read" : "write";
      assert.throws(() => assertPermissionDocumentation(guide, changed), /permission matrix drift/);
    }
  }
});

test("permission documentation rejects stale recovery prose, missing jobs and duplicate rows", () => {
  const stale = guide.replace("The `recover` job has only `contents: write` and `actions: read` (to read the original publication run);", "The `recover` job has only `contents: write`;");
  assert.notEqual(stale, guide, "the adversarial fixture must actually remove the documented grant");
  assert.throws(() => assertPermissionDocumentation(stale, workflow), /exclusive permission claim drift/);
  const rows = [...guide.matchAll(/^\| `([\w-]+)` \| [^|]+ \| [^|]+\|$/gm)];
  assert.equal(rows.length, Object.keys(workflow.jobs).length);
  for (const [row] of rows) {
    assert.throws(() => assertPermissionDocumentation(guide.replace(row, ""), workflow), /must cover every job/);
    assert.throws(() => assertPermissionDocumentation(guide.replace(row, row + "\n" + row), workflow), /must cover every job/);
  }
});

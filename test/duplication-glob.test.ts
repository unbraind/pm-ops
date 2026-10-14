/** Filesystem contracts pinned against the previous fast-glob implementation. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test, { after, before } from "node:test";
import { globMatchedSources } from "../duplication.ts";

let root: string;
const expected = [".hidden.ts", ".private/.nested/source.cts", ".private/source.ts", "root.cts", "src/.secret.mts", "src/a.ts", "src/z.tsx", "test/unit.ts"];

before(() => {
  root = mkdtempSync(join(tmpdir(), "pm-ops-glob-"));
  const files = [
    ...expected, "src/ambient.d.ts", "src/ambient.d.mts", "src/ambient.d.cts", "src/readme.md",
    "node_modules/pkg/source.ts", "src/node_modules/pkg/source.ts", "dist/source.ts",
    "src/dist/source.ts", "dist-test/source.ts", "coverage/source.ts", ".git/source.ts",
    ".agents/pm/extensions/pkg/source.ts", "src/.agents/pm/extensions/pkg/source.ts",
  ];
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "export const value = 1;\n");
  }
  mkdirSync(join(root, "directory.ts"));
  symlinkSync(join(root, "src/a.ts"), join(root, "linked.ts"), "file");
  symlinkSync(join(root, "src"), join(root, "alias"), "dir");
  symlinkSync(join(root, "missing.ts"), join(root, "broken.ts"), "file");
});
after(() => rmSync(root, { recursive: true, force: true }));

test("pinned glob scope includes dotfiles, excludes generated/declaration paths and symlinks, and sorts", async () => {
  assert.deepEqual(await globMatchedSources(root, "**/*.{ts,tsx,mts,cts}"), expected);
});

test("pinned glob scope preserves brace unions, extglobs, overlapping includes and literal paths", async () => {
  assert.deepEqual(await globMatchedSources(root, "{src/**/*.{ts,tsx,mts,cts},test/**/*.ts,src/a.ts}"),
    expected.filter((file) => file.startsWith("src/") || file.startsWith("test/")));
  assert.deepEqual(await globMatchedSources(root, "src/!(z|ambient.d).{ts,tsx}"), ["src/a.ts"]);
  assert.deepEqual(await globMatchedSources(root, "src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(await globMatchedSources(root, "absent/**/*.ts"), []);
  assert.deepEqual(await globMatchedSources(root, "directory.ts"), []);
  await assert.rejects(async () => globMatchedSources(root, "src/a.ts/*"), { code: "ENOTDIR" });
  assert.deepEqual(await globMatchedSources(root, "{**/*.ts,src/*.ts}"), expected.filter((file) => file.endsWith(".ts")));
});

test("pinned glob scope normalizes absolute patterns and relative repository roots", async () => {
  assert.deepEqual(await globMatchedSources(root, join(root, "src/**/*.{ts,tsx,mts,cts}")),
    ["src/.secret.mts", "src/a.ts", "src/z.tsx"]);
  assert.deepEqual(await globMatchedSources(relative(process.cwd(), root), "**/*.{ts,tsx,mts,cts}"), expected);
});

test("pinned glob scope preserves negative patterns and excludes ignores even when explicitly included", async () => {
  assert.deepEqual(await globMatchedSources(root, "!src/**/*.ts"), []);
  assert.deepEqual(await globMatchedSources(root, "{src/**/*.ts,!src/a.ts,root.cts}"), ["root.cts"]);
  assert.deepEqual(await globMatchedSources(root, "{dist/source.ts,src/a.ts,src/ambient.d.ts}"), ["src/a.ts"]);
});


test("pinned glob scope follows explicitly selected symlink bases without traversing discovered symlinks", async () => {
  assert.deepEqual(await globMatchedSources(root, "alias/**/*.{ts,tsx,mts,cts}"),
    ["alias/.secret.mts", "alias/a.ts", "alias/z.tsx"]);
  assert.deepEqual(await globMatchedSources(root, "{src/**/*.ts,src/a.ts}"), ["src/a.ts"]);
});

test("pinned glob scope preserves patterns selecting sources outside the repository root", async () => {
  const scope = join(root, "test");
  assert.deepEqual(await globMatchedSources(scope, "../src/a.ts"), ["../src/a.ts"]);
  assert.deepEqual(await globMatchedSources(scope, join(root, "src/a.ts")), ["../src/a.ts"]);
});

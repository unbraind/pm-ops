/** Brace-union expansion contracts: order, literals, refusal bound and ReDoS timing. */
import assert from "node:assert/strict";
import test from "node:test";
import { expandGlobUnions, MAX_GLOB_UNION_ALTERNATIVES } from "../duplication.ts";

test("brace unions expand in the pinned left-to-right order with nested and literal braces untouched", () => {
  assert.deepEqual(expandGlobUnions("src/**/*.{ts,tsx,mts,cts}"), [
    "src/**/*.ts", "src/**/*.tsx", "src/**/*.mts", "src/**/*.cts",
  ]);
  assert.deepEqual(expandGlobUnions("src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(expandGlobUnions("{x}"), ["{x}"], "non-comma braces stay literal");
  assert.deepEqual(expandGlobUnions("{x}{a,b}"), ["{x}a", "{x}b"]);
  assert.deepEqual(expandGlobUnions("a{,}b"), ["ab", "ab"], "empty alternatives expand like the former regex");
  assert.deepEqual(expandGlobUnions("{src/**/*.ts,!src/a.ts,root.cts}"), [
    "src/**/*.ts", "!src/a.ts", "root.cts",
  ], "leading negative alternatives survive expansion");
  assert.deepEqual(expandGlobUnions("{a,{b,c},d}"), ["a", "b", "d", "a", "c", "d"]);
});

test("brace expansion refuses globs that would exceed the alternative bound", () => {
  const exactly = "{a,b}".repeat(10);
  assert.equal(expandGlobUnions(exactly).length, MAX_GLOB_UNION_ALTERNATIVES);
  assert.deepEqual(expandGlobUnions(exactly).slice(0, 4), [
    "aaaaaaaaaa", "aaaaaaaaab", "aaaaaaaaba", "aaaaaaaabb",
  ]);
  const over = "{a,b}".repeat(11);
  assert.throws(
    () => expandGlobUnions(over),
    /duplication-gate: glob brace expansion exceeds 1024 alternatives: \{a,b\}\{a,b\}/,
  );
  const wide = `{${"a,".repeat(MAX_GLOB_UNION_ALTERNATIVES - 1)}a}`;
  assert.equal(expandGlobUnions(wide).length, MAX_GLOB_UNION_ALTERNATIVES);
  const hostile = `{${"a,".repeat(MAX_GLOB_UNION_ALTERNATIVES)}a,b}`;
  assert.throws(
    () => expandGlobUnions(hostile),
    /brace expansion exceeds 1024 alternatives: \{a,a,a,a.*…$/,
    "refusal names the limit and a truncated preview of the configured glob",
  );
});

test("hostile leading-brace inputs complete in linear time instead of polynomial backtracking", () => {
  const commas = ",".repeat(50_000);
  const unterminated = `{{,${commas}`;
  const terminated = `{{,${commas}}`;
  for (let warmup = 0; warmup < 3; warmup += 1) expandGlobUnions(`{{,${",".repeat(1_000)}`);
  const started = performance.now();
  assert.deepEqual(expandGlobUnions(unterminated), [unterminated], "no brace union to expand");
  assert.throws(() => expandGlobUnions(terminated), /brace expansion exceeds 1024 alternatives/);
  assert.ok(
    performance.now() - started < 50,
    "leading '{{,' with fifty thousand commas must not backtrack polynomially",
  );
});
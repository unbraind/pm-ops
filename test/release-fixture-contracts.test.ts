/** Adversarial preconditions prevent fixture drift from silently shrinking regression coverage. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { satisfies } from "semver";
import { replaceFixtureOnce, requiredFixtureCases, withCallerInput } from "./fixture-contracts.ts";
import { continuationCliCases, continuationSelectionCases, continuationSelectionGrid, selectionGridBounds } from "./continuation-selection-corpus.ts";

/** Search every package test fixture for an unchecked literal construction pattern. */
function assertFixtureSources(pattern: RegExp): void {
  for (const file of readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith(".ts"))) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), pattern, file);
  }
}

test("fixture edits refuse absent, ambiguous and empty anchors before changing input", () => {
  for (const anchor of ["    with:\n", "marker", "😀"]) {
    for (const source of ["missing", anchor + anchor]) assert.throws(() => replaceFixtureOnce(source, anchor, "replacement"), /fixture anchor/);
    assert.equal(replaceFixtureOnce("before" + anchor + "after", anchor, "replacement"), "beforereplacementafter");
  }
  assert.throws(() => replaceFixtureOnce("source", "", "replacement"), /fixture anchor/);
  assert.throws(() => withCallerInput("jobs: {}", "node-version", "24"), /fixture anchor/);
  assert.throws(() => withCallerInput("    with:\n    with:\n", "node-version", "24"), /fixture anchor/);
  assert.match(withCallerInput("    with:\n", "node-version", "24"), /node-version: "24"/);
  assertFixtureSources(/\.replace(?:All)?\(\s*["'`]\s*with:/);
});

test("required fixture subsets reject removal, renaming, duplication and empty expectations", () => {
  const rows = continuationSelectionCases(), selected = continuationCliCases(rows);
  assert.equal(selected.length, 6);
  for (const row of selected) {
    assert.throws(() => continuationCliCases(rows.filter(candidate => candidate !== row)), /required fixture subset/);
    assert.throws(() => continuationCliCases(rows.map(candidate => candidate === row ? { ...candidate, selection: "renamed" } : candidate)), /required fixture subset/);
    assert.throws(() => continuationCliCases([...rows, row]), /required fixture subset/);
  }
  assert.throws(() => requiredFixtureCases([], [], String), /nonempty/);
  assert.throws(() => requiredFixtureCases(["a"], ["a", "a"], String), /unique/);
  assert.deepEqual(requiredFixtureCases(["after", "extra", "before"], ["before", "after"], String), ["after", "before"], "workflow execution order must remain authoritative");
  assert.deepEqual(requiredFixtureCases(["__proto__", "constructor"], ["constructor"], String), ["constructor"]);
  assertFixtureSources(/\.filter\([^\n;]*=>\s*\[[^\n;]*\.includes\([^\n;)]*\.(?:selection|name)\b/);
});

test("endpoint and witness grids stay coupled when every documented bound widens", () => {
  assert.deepEqual(selectionGridBounds, { minMajor: 20, maxMajor: 25, maxMinor: 20, maxEndpointPatch: 2 });
  for (const bounds of [selectionGridBounds, { minMajor: 19, maxMajor: 30, maxMinor: 24, maxEndpointPatch: 4 }]) {
    const { endpoints, versions } = continuationSelectionGrid(bounds);
    assert.equal(endpoints.length, (bounds.maxMajor - bounds.minMajor + 1) * (bounds.maxMinor + 1) * (bounds.maxEndpointPatch + 1));
    assert.equal(endpoints.at(-1), `${bounds.maxMajor}.${bounds.maxMinor}.${bounds.maxEndpointPatch}`);
    for (const version of endpoints) {
      const [major, minor, patch] = version.split(".").map(Number);
      if (major >= 24 || (major === 22 && minor >= 18) || (major === 23 && minor >= 6)) {
        assert.ok(versions.includes(`${major}.${minor}.${patch + 1}`), version);
      }
    }
    const generated = continuationSelectionCases(bounds).slice(-160);
    const majors = generated.flatMap(row => [...row.selection.matchAll(/(\d+)\.\d+\.\d+/g)].map(match => Number(match[1])));
    assert.equal(Math.max(...majors), bounds.maxMajor);
    for (const row of generated) assert.equal(row.supported, versions.some(version => satisfies(version, row.selection)), row.selection);
  }
});

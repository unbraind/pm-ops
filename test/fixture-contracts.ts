/** Fail closed when a fixture no longer establishes the precondition a regression needs. */
import assert from "node:assert/strict";

/** Require exactly one nonempty anchor before any fixture rewrite. */
export function requireFixtureAnchor(source: string, anchor: string): void {
  assert.notEqual(anchor, "", "fixture anchor must be nonempty");
  assert.equal(source.split(anchor).length, 2, `fixture anchor must occur exactly once: ${JSON.stringify(anchor)}`);
}

/** Apply one required fixture edit instead of silently returning unchanged input. */
export function replaceFixtureOnce(source: string, anchor: string, replacement: string): string {
  requireFixtureAnchor(source, anchor);
  return source.replace(anchor, replacement);
}

/** Inject a caller input only into an unambiguous existing with block. */
export function withCallerInput(source: string, key: string, value: unknown): string {
  return replaceFixtureOnce(source, "    with:\n", `    with:\n      ${key}: ${JSON.stringify(value)}\n`);
}

/** Require every named case exactly once, preserving source order for workflow transactions. */
export function requiredFixtureCases<T>(rows: readonly T[], expected: readonly string[], key: (row: T) => string): T[] {
  assert.ok(expected.length > 0, "required fixture subset must be nonempty");
  const names = new Set(expected);
  assert.equal(names.size, expected.length, "required fixture names must be unique");
  const selected = rows.filter(row => names.has(key(row)));
  assert.deepEqual(selected.map(key).sort(), [...expected].sort(), "required fixture subset must contain every expected member exactly once");
  return selected;
}

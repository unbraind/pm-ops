import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { GlobalOptions } from "@unbrained/pm-cli/sdk";

import extension from "../index.ts";
import {
  analyzeSource,
  analyzeDocstringCoverage,
  MIN_DOC_WORDS,
  MIN_NOVEL_WORDS,
  INTERNAL_BODY_LINES,
  type DocstringViolation,
} from "../docstrings.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Analyze a source snippet as a single file and return its violations. */
function violationsOf(source: string): DocstringViolation[] {
  return [...analyzeSource(source, "f.ts").violations];
}

/** The single violation of a snippet that must produce exactly one. */
function onlyViolation(source: string): DocstringViolation {
  const all = violationsOf(source);
  assert.equal(all.length, 1, `expected exactly one violation, got ${JSON.stringify(all)}`);
  return all[0]!;
}

/** Read a file if it exists, returning an empty string otherwise (for output assertions). */
function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// ===========================================================================
// Negative controls — the gate MUST reject each of these, for a SPECIFIC reason
// ===========================================================================

test("rejects an exported declaration with no docstring", () => {
  const v = onlyViolation(`export function alpha() {}\n`);
  assert.equal(v.symbol, "alpha");
  assert.equal(v.reason, "no docstring");
  assert.equal(v.line, 1);
});

test("rejects a docstring that only restates the identifier", () => {
  // Four meaningful words, all already present in the identifier -> restates.
  const v = onlyViolation(`/** Load user config from file. */\nexport function loadUserConfigFromFile() {}\n`);
  assert.equal(v.symbol, "loadUserConfigFromFile");
  assert.ok(v.reason.startsWith("docstring restates the identifier"), `got: ${v.reason}`);
});

test("rejects a docstring that is a line comment rather than a block", () => {
  const v = onlyViolation(`// just a line comment\nexport function beta() {}\n`);
  assert.equal(v.symbol, "beta");
  assert.equal(v.reason, "no docstring");
});

test("rejects a docstring with fewer than the minimum meaningful words", () => {
  const v = onlyViolation(`/** Computes the total. */\nexport function aggregateTotals() {}\n`);
  assert.equal(v.reason, `docstring has fewer than ${MIN_DOC_WORDS} meaningful words (got 2)`);
});

test("a JSDoc block inside a string literal cannot satisfy the gate", () => {
  const src = `const decoy = "/** fake docstring here */";\nexport function gamma() {}\n`;
  const v = onlyViolation(src);
  assert.equal(v.symbol, "gamma");
  assert.equal(v.reason, "no docstring");
});

test("a JSDoc block inside a template literal cannot satisfy the gate", () => {
  const src = "const decoy = `/** fake docstring here */`;\nexport function delta() {}\n";
  const v = onlyViolation(src);
  assert.equal(v.symbol, "delta");
  assert.equal(v.reason, "no docstring");
});

test("a JSDoc block on a commented-out declaration cannot satisfy the gate", () => {
  // The fake declaration and its JSDoc are inside a line comment; the real
  // declaration that follows is undocumented and must be flagged.
  const src = `// /** fake */ export function alpha() {}\nexport function realOne() {}\n`;
  const v = onlyViolation(src);
  assert.equal(v.symbol, "realOne");
  assert.equal(v.reason, "no docstring");
});

test("a JSDoc block separated from the declaration by another statement does not attach", () => {
  // The JSDoc attaches to the intervening const, not to the export.
  const src = `/** Far doc over here. */\nconst separator = 1;\nexport function farTarget() {}\n`;
  const v = onlyViolation(src);
  assert.equal(v.symbol, "farTarget");
  assert.equal(v.reason, "no docstring");
});

test("a public class member with no docstring is flagged inside a documented exported class", () => {
  const src = `/** A widget component rendering user interfaces. */\nexport class Widget {\n  render() {}\n}\n`;
  const v = onlyViolation(src);
  assert.equal(v.symbol, "Widget.render");
  assert.equal(v.reason, "no docstring");
});

test("a long non-exported function with no docstring is flagged", () => {
  const body = Array.from({ length: INTERNAL_BODY_LINES + 2 }, (_, i) => `  const v${i} = ${i};`).join("\n");
  const src = `function helper() {\n${body}\n}\n`;
  const v = onlyViolation(src);
  assert.equal(v.symbol, "helper");
  assert.equal(v.reason, "no docstring");
});

test("an empty source tree fails instead of passing vacuously", () => {
  const empty = mkdtempSync(join(tmpdir(), "docstrings-empty-"));
  try {
    assert.throws(() => analyzeDocstringCoverage({ root: empty }), /cannot pass vacuously/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

// ===========================================================================
// Positive controls — the gate accepts these
// ===========================================================================

test("accepts an exported function with a substantive docstring", () => {
  assert.deepEqual(violationsOf(`/** Compute the frobnicated grand total for reporting. */\nexport function frobnicateTotal() {}\n`), []);
});

test("accepts documented exported interface, type, const, and class", () => {
  const src = `
/** Shape of a parsed configuration record. */
export interface ConfigRecord { field: number; }
/** Union of every supported transport mechanism. */
export type Transport = "http" | "grpc";
/** Default retry budget used across the fleet. */
export const DEFAULT_RETRIES = 3;
/** Render the parsed configuration as a human summary. */
export class ConfigView {
  /** Format the configuration into a single readable line. */
  toLine(): string { return ""; }
}
`;
  assert.deepEqual(violationsOf(src), []);
});

test("does not flag short non-exported functions or private class members", () => {
  const src = `
function tiny() { return 1; }
/** A holder exported widely for external callers. */
export class Holder {
  /** Retrieve the stored count value for today. */
  get value() { return 0; }
  private secret() { return 1; }
  protected internal() { return 2; }
  #hidden = 3;
}
`;
  assert.deepEqual(violationsOf(src), []);
});

test("accepts documented getters, setters, and decorated members", () => {
  const src = `
/** A counter component tracking invocations over time. */
export class Counter {
  /** Current count after the most recent operation. */
  get current() { return 0; }
  /** Replace the count with a fresh starting value. */
  set current(next: number) { void next; }
  /** Decorated hook invoked once after construction finishes. */
  @hook render() {}
}
function hook(target: unknown, key: string) { void target; void key; }
`;
  assert.deepEqual(violationsOf(src), []);
});

test("checks export default function and class declarations", () => {
  const src = `
/** Default entry computing the primary result. */
export default function primary() {}
`;
  assert.deepEqual(violationsOf(src), []);
  const bad = onlyViolation(`export default function() {}\n`);
  assert.equal(bad.symbol, "default");
  assert.equal(bad.reason, "no docstring");
});

test("a docstring counts even across blank lines and ignores @tags and code fences", () => {
  const src = `
/**
 * Compute the aggregate metric over the batch window.
 *
 * @example
 * \`\`\`
 * primary(42)
 * \`\`\`
 * @returns a number
 */
export function primary(input: number) { return input; }
`;
  assert.deepEqual(violationsOf(src), []);
});

// ===========================================================================
// Fail-closed: an unrecognised declaration form is a violation, not a skip
// ===========================================================================

test("an enum declaration is reported, not skipped", () => {
  const v = onlyViolation(`enum Color { Red, Green }\n`);
  assert.equal(v.reason, "unrecognized declaration form");
});

test("a namespace declaration is reported, not skipped", () => {
  const v = onlyViolation(`namespace Shapes { export function circle() {} }\n`);
  assert.equal(v.reason, "unrecognized declaration form");
});

test("an unrecognised export form is reported, not skipped", () => {
  const v = onlyViolation(`export enum Mood { Happy }\n`);
  assert.equal(v.reason, "unrecognized declaration form");
});

// ===========================================================================
// Tokenizer robustness — the property the regex version lacked
// ===========================================================================

test("braces inside a template substitution do not corrupt brace counting", () => {
  // A template with an object literal in its substitution precedes a real
  // undocumented export; the substitution brace must not be mis-counted.
  const src = "const id = `user-${ { a: 1 } }`;\nexport function realExport() {}\n";
  const v = onlyViolation(src);
  assert.equal(v.symbol, "realExport");
  assert.equal(v.reason, "no docstring");
});

test("braces inside a regex literal do not corrupt brace counting", () => {
  const src = "const re = /a{1,3}/;\nexport function realExport() {}\n";
  const v = onlyViolation(src);
  assert.equal(v.symbol, "realExport");
  assert.equal(v.reason, "no docstring");
});

test("a division operator is not swallowed as a regex", () => {
  // `total / count` must parse as division; the export after it is still found.
  const src = "const ratio = total / count;\nexport function realExport() {}\n";
  const v = onlyViolation(src);
  assert.equal(v.symbol, "realExport");
});

test("descends into a function with an object-literal return type to find its body", () => {
  // The return type `{ ok: boolean }` must not be mistaken for the body.
  const src = `function make(): { ok: boolean } {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  const d = 4;\n  const e = 5;\n  return { ok: true };\n}\n`;
  const v = onlyViolation(src);
  assert.equal(v.symbol, "make");
  assert.equal(v.reason, "no docstring");
});

test("re-export statements and export default expressions declare nothing", () => {
  const src = `
export { alpha } from "./a";
export * from "./b";
export type { Beta } from "./c";
export default 42;
`;
  assert.deepEqual(violationsOf(src), []);
});

// ===========================================================================
// Control-flow and member-form coverage
// ===========================================================================

test("finds a long function nested inside control-flow bodies", () => {
  const body = Array.from({ length: INTERNAL_BODY_LINES + 2 }, (_, i) => `    const v${i} = ${i};`).join("\n");
  const src = `
/** Outer wrapper exercising control-flow descent thoroughly. */
function outer() {
  if (cond) {
    for (const item of items) {
      while (running) {
        try {
          function nested() {
${body}
          }
        } catch (err) {
          void err;
        }
      }
    }
  } else {
    switch (kind) {
      case "x":
        return 1;
      default:
        return 2;
    }
  }
}
`;
  const v = onlyViolation(src);
  assert.equal(v.symbol, "nested");
  assert.equal(v.reason, "no docstring");
});

test("does not descend into object literals as if they were blocks", () => {
  // The default-exported object literal contains method-shaped keys that must
  // not be treated as class members or declarations.
  const src = `
const define = (module: unknown) => module;
/** Build the extension module object for the host loader. */
export default define({
  activate(api: unknown) {
    void api;
    run({ name: "x", handler() { return 1; } });
  },
});
function run(opts: { name: string; handler(): number }) { return opts.handler(); }
`;
  assert.deepEqual(violationsOf(src), []);
});

test("flags an undocumented generator method and a documented accessor", () => {
  const src = `
/** A stream source yielding values on demand. */
export class Stream {
  /** Emit the next batch of values synchronously. */
  *batch() { yield 1; }
  async *asyncBatch() { yield 2; }
}
`;
  const v = onlyViolation(src);
  assert.equal(v.symbol, "Stream.asyncBatch");
  assert.equal(v.reason, "no docstring");
});

test("constructor, index signature, and static block members are out of scope", () => {
  const src = `
/** A keyed configuration bag for runtime lookups. */
export class Bag {
  constructor(private init: number) {}
  [key: string]: unknown;
  static { const x = 1; void x; }
  /** Look up a single keyed slot lazily on demand. */
  fetch(key: string) { return this[key as keyof Bag]; }
}
`;
  assert.deepEqual(violationsOf(src), []);
});

// ===========================================================================
// analyzeDocstringCoverage — directory walk
// ===========================================================================

test("walks a tree, skipping test/, dist/, and .d.ts files", () => {
  const root = mkdtempSync(join(tmpdir(), "docstrings-tree-"));
  try {
    writeFileSync(join(root, "index.ts"), `/** Documented exported entry point. */\nexport function main() {}\n`);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "helper.ts"), `/** Documented exported helper module. */\nexport function help() {}\n`);
    // Skipped: test fixture with an undocumented export.
    mkdirSync(join(root, "test"));
    writeFileSync(join(root, "test", "bad.test.ts"), `export function undocumented() {}\n`);
    // Skipped: dist output.
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "built.js"), `export function built() {}\n`);
    // Skipped: ambient declarations.
    writeFileSync(join(root, "types.d.ts"), `declare function ambient(): void;\n`);
    const report = analyzeDocstringCoverage({ root });
    assert.equal(report.files_scanned, 2);
    assert.equal(report.violations.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sourceDirs scopes the walk to listed subdirectories", () => {
  const root = mkdtempSync(join(tmpdir(), "docstrings-dirs-"));
  try {
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "a.ts"), `export function nope() {}\n`);
    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "b", "b.ts"), `/** Documented exported thing here. */\nexport function yep() {}\n`);
    const onlyB = analyzeDocstringCoverage({ root, sourceDirs: ["b"] });
    assert.equal(onlyB.files_scanned, 1);
    assert.equal(onlyB.violations.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// Comprehensive form coverage — one documented source touching every branch
// ===========================================================================

test("a fully documented source exercising every declaration and statement form passes", () => {
  const src = [
    `import { existsSync } from "node:fs";`,
    `import type { Thing } from "./x";`,
    `declare const AMBIENT_SETTING: number;`,
    `interface LocalShape { field: number; }`,
    `type LocalKind = "a" | "b";`,
    `const localConst = 1;`,
    `let localLet = 2;`,
    `var localVar = 3;`,
    `function shortHelper() { return 1; }`,
    `/** First overload signature carrying the shared documentation. */`,
    `export function overloaded(x: string): void;`,
    `/** Implementation of the overloaded function across all inputs. */`,
    `export function overloaded(x: string | number): void { void x; }`,
    `/** Generic exported function returning a tagged record shape. */`,
    `export function generic<T extends string>(input: T): { tag: T; value: number } {`,
    `  return { tag: input, value: 1 };`,
    `}`,
    `/** Generic function closing nested type arguments with a right-shift token. */`,
    `export function deep<A, B>(): Foo<Bar<A, B>> { return null as Foo<Bar<A, B>>; }`,
    `/** Abstract base exported for downstream concrete subclasses. */`,
    `export abstract class AbstractBase {`,
    `  /** Concrete hook subclasses must implement themselves. */`,
    `  abstract hook(): void;`,
    `  /** Shared concrete method returning a constant zero. */`,
    `  base(): number { return 0; }`,
    `}`,
    `/** Exported class exercising every public member form available. */`,
    `export class Full<T extends string> extends AbstractBase implements Iterable<string> {`,
    `  /** Mutable property holding the current session count. */`,
    `  count = 0;`,
    `  /** Readonly identity label derived at construction time. */`,
    `  readonly id: string;`,
    `  /** Public method returning the stored identity label. */`,
    `  greet(): string { return this.id; }`,
    `  /** Generic method mapping input to a wrapped pair. */`,
    `  pair<U>(input: U): [string, U] { return [this.id, input]; }`,
    `  /** Accessor exposing the count squared for callers. */`,
    `  get squared(): number { return this.count * this.count; }`,
    `  /** Mutator replacing the count with a clamped value. */`,
    `  set squared(next: number) { this.count = Math.max(0, next); }`,
    `  /** Generator yielding each identity character sequentially. */`,
    `  *chars(): Generator<string> { yield this.id[0]!; }`,
    `  /** Async generator streaming identity characters over time. */`,
    `  async *stream(): AsyncGenerator<string> { yield this.id[0]!; }`,
    `  /** Decorated lifecycle method invoked after mount completes. */`,
    `  @decorate mounted(): void {}`,
    `  /** Stash for arbitrary caller-provided extension state. */`,
    `  [key: string]: unknown;`,
    `  constructor(id: string) { super(); this.id = id; }`,
    `  private hidden(): void {}`,
    `  protected internal(): void {}`,
    `  #secret = 1;`,
    `  static { const boot = 1; void boot; }`,
    `  /** Static helper formatting a label for log lines. */`,
    `  static label(): string { return "full"; }`,
    `  /** Iterator returning this instance as the single element. */`,
    `  [Symbol.iterator](): Iterator<string> { return this.chars(); }`,
    `}`,
    `function decorate(target: unknown, key: string) { void target; void key; }`,
    `interface Foo<X> { x: X; }`,
    `interface Bar<Y> { y: Y; }`,
    `interface Iterable<T> { [Symbol.iterator](): Iterator<T>; }`,
    `interface Iterator<T> { next(): { value: T }; }`,
    `/** Exported interface describing a serializable record shape. */`,
    `export interface Serializable { data: unknown; }`,
    `/** Exported type alias over a conditional expression. */`,
    `export type Maybe<T> = T extends string ? { wrapped: T } : never;`,
    `/** Exported constant holding the default batch size everywhere. */`,
    `export const BATCH_SIZE = 16;`,
    `/** Exported let allowing runtime reconfiguration of the limit. */`,
    `export let dynamicLimit = 32;`,
    `/** Default function entry composing the primary pipeline now. */`,
    `export default function entry(): void { run(); }`,
    `/** Driver exercising every control-flow construct for coverage. */`,
    `function run(): void {`,
    `  label: for (const item of items()) {`,
    `    while (false) { break; }`,
    `    do { continue; } while (false);`,
    `    try { throw new Error("x"); } catch (e) { void e; } finally { return; }`,
    `  }`,
    `  const arrow = (): number => { function nested() { return 1; } return nested(); };`,
    `  void arrow();`,
    `  switch ("x") { case "x": break; default: return; }`,
    `  const re = /a{1,2}/; const div = 10 / 2; const tmpl = \`v\${ { ok: true } }\`;`,
    `  void re; void div; void tmpl;`,
    `}`,
    `function items(): string[] { return []; }`,
    `const cfg = {`,
    `  activate(api: unknown) { void api; },`,
    `  run(opts: { handler(): number }) { return opts.handler(); },`,
    `};`,
    `void cfg;`,
    `{ const block = 1; void block; }`,
    `;`,
  ].join("\n");
  assert.deepEqual(violationsOf(src), []);
});

test("analyzeDocstringCoverage accepts a single source file as the root", () => {
  const root = mkdtempSync(join(tmpdir(), "docstrings-file-"));
  const file = join(root, "lone.ts");
  try {
    writeFileSync(file, `/** Documented exported lone entry point. */\nexport function lone() {}\n`);
    const report = analyzeDocstringCoverage({ root: file });
    assert.equal(report.files_scanned, 1);
    assert.equal(report.violations.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("analyzeDocstringCoverage fails on a missing root just like an empty tree", () => {
  assert.throws(() => analyzeDocstringCoverage({ root: "/does/not/exist/docstrings-missing" }), /cannot pass vacuously/);
});

// ===========================================================================
// Branch coverage — declaration, export, member, and type-skip forms
// ===========================================================================

test("covers non-exported classes, ambient declares, and stray forms", () => {
  assert.deepEqual(violationsOf(`class Local { x = 1; m() {} }\n`), []);
  assert.deepEqual(violationsOf(`declare const AMBIENT: number;\n`), []);
  assert.deepEqual(violationsOf(`interface Local { field: number; }\n`), []);
  assert.deepEqual(violationsOf(`type Local = "a" | "b";\n`), []);
  assert.deepEqual(violationsOf(`const c = 1; let l = 2; var v = 3;\n`), []);
  assert.deepEqual(violationsOf(`async () => { await 1; };\n`), []);
  assert.deepEqual(violationsOf(`abstract;\n`), []);
});

test("covers every export form", () => {
  const ok = (s: string) => assert.deepEqual(violationsOf(s), [], `unexpected violations: ${s}`);
  ok(`export { alpha } from "./a";\n`);
  ok(`export * from "./b";\n`);
  ok(`export * as ns from "./d";\n`);
  ok(`export type { Beta } from "./c";\n`);
  ok(`/** Exported type alias over a primitive kind. */\nexport type Kind = number;\n`);
  ok(`/** Exported interface describing a record bag. */\nexport interface Bag { data: unknown; }\n`);
  ok(`/** Exported async function running the pipeline. */\nexport async function pipeline() {}\n`);
  ok(`/** Exported abstract base for concrete subclasses. */\nexport abstract class Base { /** Abstract hook for subclasses to define. */ abstract hook(): void; }\n`);
  ok(`/** Default async function entry point here. */\nexport default async function entry() {}\n`);
  ok(`/** Default class entry for the module. */\nexport default class Module {}\n`);
  ok(`/** Default abstract class entry for the module. */\nexport default abstract class AbstractModule {}\n`);
});

test("covers top-level decorators with dotted names", () => {
  assert.deepEqual(violationsOf(`@ns.deco("x") class Local {}\n`), []);
});

test("covers right-shift and triple-right-shift type-token closers", () => {
  // `>>` and `>>>` close nested generic argument lists in return types.
  assert.deepEqual(violationsOf(`/** Build a doubly-nested generic wrapper record. */\nexport function build<T>(): A<B<T>> { return null as A<B<T>>; }\ninterface A<X> { x: X; }\ninterface B<Y> { y: Y; }\n`), []);
  assert.deepEqual(violationsOf(`/** Build a triply-nested generic wrapper record. */\nexport function build3<T>(): A<B<C<T>>> { return null as A<B<C<T>>>; }\ninterface C<Z> { z: Z; }\n`), []);
  // Heritage clauses close generics too.
  assert.deepEqual(violationsOf([
    `/** Generic class extending a parameterized base. */`,
    `export class Derived<T> extends Base<T> implements I<T> {`,
    `  /** Concrete member returning the stored item. */`,
    `  item(): T { return null as T; }`,
    `}`,
    `interface Base<X> { x: X; }`,
    `interface I<Y> { y: Y; }`,
  ].join("\n")), []);
});

test("a docstring on the same line as preceding code does not attach (TypeScript leading-comment semantics)", () => {
  // The class docstring leads on its own line and counts; the inline `/** … */`
  // before `m` is a trailing comment of the `{`, so `m` is undocumented.
  const v = onlyViolation(`/** A container class holding a single method. */\nexport class C { /** Documented method returning a greeting. */ m() {} }\n`);
  assert.equal(v.symbol, "C.m");
  assert.equal(v.reason, "no docstring");
});

test("covers an anonymous default export declaration", () => {
  const v = onlyViolation(`export default class {}\n`);
  assert.equal(v.symbol, "default");
  assert.equal(v.reason, "no docstring");
});

// ===========================================================================
// Command wiring — pm ops docstrings via the real dispatch engine
// ===========================================================================

let tmpRoot: string;
let cleanRepo: string;
let dirtyRepo: string;
let emptyRepo: string;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pm-ops-docstrings-test-"));
  cleanRepo = mkdtempSync(join(tmpRoot, "clean"));
  writeFileSync(join(cleanRepo, "index.ts"), `/** Documented exported entry point for the suite. */\nexport function main() {}\n`);
  dirtyRepo = mkdtempSync(join(tmpRoot, "dirty"));
  writeFileSync(join(dirtyRepo, "index.ts"), `export function main() {}\n`);
  emptyRepo = mkdtempSync(join(tmpRoot, "empty"));
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function runCmd<T>(
  ext: ExtensionTestHarness,
  command: string,
  options: Record<string, unknown> = {},
  args: readonly string[] = [],
  globalOverride: Partial<GlobalOptions> = {},
): Promise<T> {
  const { result } = await ext.runCommand({
    command,
    options,
    args,
    global: { json: false, quiet: true, noPager: true, ...globalOverride },
  });
  return result as T;
}

interface DocstringsRepoResult {
  repo: string;
  name: string;
  files_scanned: number;
  declarations_checked: number;
  violation_count: number;
  violations: readonly DocstringViolation[];
}

interface DocstringsCommandResult {
  repos: readonly DocstringsRepoResult[];
  summary: { total: number; with_violations: number; total_violations: number };
}

test("pm ops docstrings reports a clean repo with zero violations", async () => {
  const ext = await createExtensionTestHarness(extension, { name: "pm-ops", capabilities: ["commands", "renderers", "schema", "parser"] });
  assert.deepEqual(ext.activation.failed, [], "activation must not fail (a host-flag collision would drop sibling commands)");
  const result = await runCmd<DocstringsCommandResult>(ext, "ops docstrings", { repos: cleanRepo });
  assert.equal(result.summary.total_violations, 0);
  assert.equal(result.repos[0]!.violation_count, 0);
});

test("pm ops docstrings exits non-zero when a repo has violations", async () => {
  const ext = await createExtensionTestHarness(extension, { name: "pm-ops", capabilities: ["commands", "renderers", "schema", "parser"] });
  await assert.rejects(() => runCmd(ext, "ops docstrings", { repos: dirtyRepo }), /repo\(s\) with violations/);
});

test("pm ops docstrings renders markdown and still fails on violations", async () => {
  const ext = await createExtensionTestHarness(extension, { name: "pm-ops", capabilities: ["commands", "renderers", "schema", "parser"] });
  await assert.rejects(() => runCmd(ext, "ops docstrings", { repos: dirtyRepo, format: "markdown" }), /repo\(s\) with violations/);
});

test("pm ops docstrings writes the report to a file before failing", async () => {
  const ext = await createExtensionTestHarness(extension, { name: "pm-ops", capabilities: ["commands", "renderers", "schema", "parser"] });
  const out = join(tmpRoot, "dirty-report.md");
  await assert.rejects(() => runCmd(ext, "ops docstrings", { repos: dirtyRepo, format: "markdown", output: out }), /repo\(s\) with violations/);
  const written = readFileSyncSafe(out);
  assert.ok(written.includes("pm-ops docstrings"), "markdown report was written before the non-zero exit");
});

test("pm ops docstrings reports a repo with no source as an error and fails", async () => {
  const ext = await createExtensionTestHarness(extension, { name: "pm-ops", capabilities: ["commands", "renderers", "schema", "parser"] });
  await assert.rejects(() => runCmd(ext, "ops docstrings", { repos: emptyRepo }), /repo\(s\) with violations/);
});

test("pm ops docstrings renders a clean repo as markdown and as a written file", async () => {
  const ext = await createExtensionTestHarness(extension, { name: "pm-ops", capabilities: ["commands", "renderers", "schema", "parser"] });
  const md = await runCmd<{ pmOpsRendered: true; output: string }>(ext, "ops docstrings", { repos: cleanRepo, format: "markdown" });
  assert.ok(md.output.includes("pm-ops docstrings"));
  const out = join(tmpRoot, "clean-report.md");
  const written = await runCmd<{ written_to: string }>(ext, "ops docstrings", { repos: cleanRepo, format: "markdown", output: out });
  assert.equal(written.written_to, out);
  assert.ok(readFileSyncSafe(out).includes("pm-ops docstrings"));
});

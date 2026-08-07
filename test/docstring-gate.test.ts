import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";

import { runDocstringGate } from "../scripts/docstring-gate.ts";

let root: string;
let clean: string;
let dirty: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "pm-ops-docstring-gate-cli-"));
  clean = join(root, "clean");
  dirty = join(root, "dirty");
  mkdirSync(clean, { recursive: true });
  mkdirSync(dirty, { recursive: true });
  writeFileSync(
    join(clean, "index.ts"),
    "/** Produce one stable numeric fixture for external consumers. */\nexport function value() { return 1; }\n",
  );
  writeFileSync(
    join(dirty, "index.ts"),
    "export function undocumented() { return 1; }\n",
  );
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Exit sentinel used to assert the gate's non-zero contract. */
class DocstringExit extends Error {}

test("docstring gate reports a documented repository and supports default package boundaries", () => {
  const messages: string[] = [];
  runDocstringGate({ root: clean, log: (message) => messages.push(message) });
  assert.match(
    messages.join("\n"),
    /1 file\(s\), 1 declaration\(s\) documented/,
  );
  runDocstringGate();
});

test("docstring gate prints actionable violations before exiting non-zero", () => {
  const messages: string[] = [];
  assert.throws(() =>
    runDocstringGate({
      root: dirty,
      error: (message) => messages.push(message),
      exit: () => {
        throw new DocstringExit();
      },
    }), DocstringExit);
  assert.match(messages.join("\n"), /index\.ts:1.*undocumented.*no docstring/s);
  assert.match(messages.join("\n"), /JSDoc block comment/);
});

test("docstring gate direct entrypoint preserves success and failure exit statuses", () => {
  const script = resolve(import.meta.dirname, "../scripts/docstring-gate.ts");
  const success = spawnSync(process.execPath, [script, clean], {
    encoding: "utf8",
  });
  assert.strictEqual(success.status, 0, success.stderr);
  assert.match(success.stdout, /documented/);

  const defaultRoot = spawnSync(process.execPath, [script], {
    encoding: "utf8",
  });
  assert.strictEqual(defaultRoot.status, 0, defaultRoot.stderr);

  const failure = spawnSync(process.execPath, [script, dirty], {
    encoding: "utf8",
  });
  assert.strictEqual(failure.status, 1);
  assert.match(failure.stderr, /undocumented/);
});

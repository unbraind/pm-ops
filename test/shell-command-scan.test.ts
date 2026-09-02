/**
 * Tests for the shared shell-text scanner and the main-invocation guard.
 *
 * These live beside the modules rather than inside a gate's suite because both
 * release gates depend on them while not every package carries both gates.
 * When these assertions belonged to the changelog-date suite, propagating the
 * scanner to a package without that gate silently dropped a branch from
 * coverage -- which is the failure this file exists to prevent.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { bashArrays, dedentRunBlocks, expandArrays, joinContinuations } from "../shell-scan.ts";
import { auditPublishAttestation } from "../attestation.ts";
import { isMainInvocation } from "../scripts/main-invocation.ts";

test("an unknown array reference is left in place rather than erased", () => {
  // Erasing it would turn "this scan does not understand the command" into
  // "this command carries no flags", which reads as a pass.
  assert.equal(expandArrays('cmd "${missing[@]}"', new Map()), 'cmd "${missing[@]}"');
  assert.equal(expandArrays('cmd "${known[@]}"', new Map([["known", "--a --b"]])), "cmd --a --b");
});

test("bashArrays collapses whitespace so a multi-line declaration is one flag string", () => {
  assert.equal(bashArrays("common=(\n  --a\n  --b\n)").get("common"), "--a --b");
});

test("the main-invocation guard answers both ways", () => {
  // Name the module under test, not a gate: not every package carries the same
  // gates, and a path that resolves nowhere makes realpathSync throw rather
  // than answer.
  const self = fileURLToPath(import.meta.resolve("../scripts/main-invocation.ts"));
  const url = import.meta.resolve("../scripts/main-invocation.ts");
  assert.equal(isMainInvocation(["node", self], url), true);
  assert.equal(isMainInvocation(["node", fileURLToPath(import.meta.url)], url), false);
  assert.equal(isMainInvocation(["node"], url), false);
});
test("a backslash continuation makes one logical command out of several lines", () => {
  assert.equal(
    joinContinuations("npm publish \\\n  --provenance \\\n  --access public\n"),
    // The joiner replaces the backslash-newline with a single space and leaves
    // the continuation line's own indentation, which the tokeniser then eats.
    "npm publish  --provenance  --access public\n",
  );
  // A backslash that does not end a line is an ordinary character.
  assert.equal(joinContinuations("printf 'a\\tb'\n"), "printf 'a\\tb'\n");
});

test("an array reference is replaced by the declaration's contents, quoted or bare", () => {
  const arrays = bashArrays('common=( --access public --provenance )\n');
  assert.equal(expandArrays('npm publish "${common[@]}"', arrays), "npm publish --access public --provenance");
  assert.equal(expandArrays("npm publish ${common[@]}", arrays), "npm publish --access public --provenance");
});

test("run-block content is dedented the way YAML delivers it to bash", () => {
  // The block's indentation is learned from its first non-blank line, a line
  // keeps any indentation beyond the block's own, and the block ends at the
  // first non-blank line indented less -- which is where YAML ends it too.
  assert.equal(
    dedentRunBlocks(["      - run: |", "          cat <<EOF", "            deeper prose", "          EOF", "          NPM=npm", "      - name: next"].join("\n")),
    ["      - run: |", "cat <<EOF", "  deeper prose", "EOF", "NPM=npm", "      - name: next"].join("\n"),
  );
  // A folded block (`>`) is dedented the same way, and blank lines stay
  // blank because YAML keeps them as empty content.
  assert.equal(
    dedentRunBlocks(["  run: >-", "", "    deep", "      deeper"].join("\n")),
    ["  run: >-", "", "deep", "  deeper"].join("\n"),
  );
  // A comment after the indicator is still a header, and a CRLF line ending
  // survives the strip.
  assert.equal(
    dedentRunBlocks("  run: | # note\r\n    x\r\n"),
    "  run: | # note\r\nx\r\n",
  );
  // A `run:`-shaped line inside another block's content is content, not a
  // header: the scan consumes each block before looking for the next.
  assert.equal(
    dedentRunBlocks(["  run: |", "    cat <<X", "    run: |", "      payload", "    X"].join("\n")),
    ["  run: |", "cat <<X", "run: |", "  payload", "X"].join("\n"),
  );
});

test("run-block dedenting refuses shapes YAML would not deliver as blocks", () => {
  // A header whose next non-blank line is indented no deeper holds an empty
  // block, so the following line is not content and is left untouched.
  assert.equal(
    dedentRunBlocks(["  run: |", "next: value"].join("\n")),
    ["  run: |", "next: value"].join("\n"),
  );
  // A header at the end of the file, or followed only by blank lines, holds
  // no content at all.
  assert.equal(dedentRunBlocks("prior\n  run: |"), "prior\n  run: |");
  assert.equal(dedentRunBlocks("  run: |\n\n"), "  run: |\n\n");
  // A `run:` value that is not a block scalar is not a header, and a block
  // scalar under any other key is data no shell runs, so both stay as written.
  assert.equal(
    dedentRunBlocks(["  run: npm publish", "  env: |", "    FOO=1"].join("\n")),
    ["  run: npm publish", "  env: |", "    FOO=1"].join("\n"),
  );
});

test("an explicit block indentation indicator (|2) is accepted and dedented", () => {
  // YAML allows `run: |2` to declare the content indentation explicitly. The
  // header must be recognised so the block is dedented; otherwise the YAML
  // indentation stays and a heredoc terminator at the start of the shell line
  // never matches, swallowing every later assignment as heredoc payload.
  assert.equal(
    dedentRunBlocks(["  run: |2", "    cat <<EOF", "      deeper prose", "    EOF", "    NPM=npm"].join("\n")),
    ["  run: |2", "cat <<EOF", "  deeper prose", "EOF", "NPM=npm"].join("\n"),
  );
  // The chomping indicator may appear before or after the indentation digit.
  assert.equal(
    dedentRunBlocks(["  run: |-2", "    cat <<EOF", "    EOF", "    NPM=npm"].join("\n")),
    ["  run: |-2", "cat <<EOF", "EOF", "NPM=npm"].join("\n"),
  );
  assert.equal(
    dedentRunBlocks(["  run: |2-", "    cat <<EOF", "    EOF", "    NPM=npm"].join("\n")),
    ["  run: |2-", "cat <<EOF", "EOF", "NPM=npm"].join("\n"),
  );
  // A folded block with an explicit indicator is dedented the same way.
  assert.equal(
    dedentRunBlocks(["  run: >2", "    echo hi"].join("\n")),
    ["  run: >2", "echo hi"].join("\n"),
  );
});

test("a dedented |2 heredoc terminator lets unset FLAG invalidate the publish (fail-open guard)", () => {
  // Without dedent the heredoc terminator `EOF` sits at the YAML indentation
  // level, not at the shell line start, so it never matches. The heredoc
  // swallows the rest of the block: `unset FLAG` is heredoc body (not processed
  // by the scope tracker), FLAG stays visible, and `$FLAG` expands to
  // `--provenance` — so `npm publish $FLAG` reads as attested and the gate
  // passes clean over an unattested publish. With dedent the terminator
  // matches, `unset FLAG` is real shell source, FLAG is removed, and `$FLAG`
  // is unresolved — the publish is correctly refused.
  const workflow = [
    "name: release",
    "on: push",
    "jobs:",
    "  release:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: |2",
    "        FLAG=--provenance",
    "        cat <<EOF",
    "          heredoc payload",
    "        EOF",
    "        unset FLAG",
    "        npm publish $FLAG",
  ].join("\n");
  const result = auditPublishAttestation([{ file: ".github/workflows/release.yml", text: workflow }]);
  assert.equal(result.failures.length, 1,
    "the unattested publish after unset FLAG must be refused");
  assert.deepEqual(result.recognition, { kind: "recognized", count: 1 });
});

test("dedenting does not refuse a publish that carries --provenance on every path (fail-closed guard)", () => {
  // Every publish in this workflow carries `--provenance` — one through an
  // indexed scalar that survives the heredoc, one directly. Dedenting must not
  // break the scan so badly that it loses the flag or invents a missing
  // publish — a fail-closed regression would refuse a release that IS attested.
  const workflow = [
    "name: release",
    "on: push",
    "jobs:",
    "  release:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: |2",
    "        FLAG=--provenance",
    "        cat <<EOF",
    "          heredoc payload",
    "        EOF",
    "        npm publish $FLAG",
    "      - run: |",
    "        npm publish --provenance",
  ].join("\n");
  const result = auditPublishAttestation([{ file: ".github/workflows/release.yml", text: workflow }]);
  assert.equal(result.failures.length, 0,
    "an attested workflow must not be refused after dedent");
  assert.deepEqual(result.recognition, { kind: "recognized", count: 2 });
});
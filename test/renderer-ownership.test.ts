import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { RendererOverrideContext } from "@unbrained/pm-cli/sdk/authoring";

import extension from "../index.ts";

/** Manifest capabilities the harness must grant for registration to be permitted. */
const CAPABILITIES = ["commands", "renderers", "schema", "parser"] as const;

/**
 * Command paths whose results pm-ops's renderer is meant to render.
 *
 * Derived from the `api.registerCommand({ name })` calls in `index.ts` — every
 * ops command can return a `pmOpsRendered`-marked result, either directly via
 * `renderedCommandResult()` or through the shared `emitResult()` helper.
 */
/**
 * The ops command paths the renderer must own.
 *
 * Kept as an independent literal on purpose: if this restated the source's
 * `OPS_COMMAND_PATHS`, the test and the code would share one mistake and prove
 * nothing. The drift guard below closes the remaining gap by comparing the
 * declared ownership against the commands the extension actually registers, so
 * a command added to the source without being added here fails the suite rather
 * than silently losing its rendering.
 */
const OWNED_COMMANDS = [
  "ops scan",
  "ops policy",
  "ops verify-release",
  "ops report",
  "ops status",
  "ops outdated",
  "ops audit",
  "ops metrics",
  "ops merge-receipts",
  "ops docstrings",
];

async function harness() {
  return createExtensionTestHarness(extension, { name: "pm-ops", capabilities: CAPABILITIES });
}

/** A result carrying pm-ops's private render marker, as the commands emit. */
const markedResult = { pmOpsRendered: true, output: "# pm ops scan\n\nbody\n" } as unknown;

/** A foreign result no pm-ops command would ever produce. */
const foreignResult = { pmChangelogRendered: true, output: "{}\n" } as unknown;

/** A bare result carrying pm-ops's output shape but no render marker. */
const bareResult = { output: "x" } as unknown;

/** A command path pm-ops does not own, used to exercise the command filter. */
const foreignCommand = "context-pack";

test("renderer ownership is registered for both toon and json formats with the package's commands", async () => {
  const ext = await harness();
  const overrides = ext.activation.renderers.overrides;
  assert.deepEqual(
    overrides.map((override) => ({ format: override.format, commands: override.commands })),
    [
      { format: "toon", commands: OWNED_COMMANDS },
      { format: "json", commands: OWNED_COMMANDS },
    ],
  );
  for (const override of overrides) {
    assert.equal(typeof override.resultDiscriminator, "function", "resultDiscriminator must be present");
  }
  await ext.deactivate();
});

test("renderer renders its own marked result for both formats", async () => {
  const ext = await harness();
  for (const format of ["toon", "json"] as const) {
    const context: RendererOverrideContext = { format, command: "ops scan", result: markedResult };
    const rendered = await ext.runRendererOverride(context);
    assert.equal(rendered.overridden, true, `${format} renderer should claim a marked result`);
    assert.equal(rendered.rendered, "# pm ops scan\n\nbody\n", `${format} should render the marked output`);
    assert.deepEqual(rendered.warnings, [], `${format} render should produce no warnings`);
  }
  await ext.deactivate();
});

test("declines a foreign result on an owned command (resultDiscriminator rejects after commands match)", async () => {
  const ext = await harness();
  // The command is one pm-ops owns, so the commands filter passes; the result
  // must be rejected by resultDiscriminator alone. Exercises the discriminator
  // after commands has already matched.
  for (const format of ["toon", "json"] as const) {
    for (const result of [foreignResult, bareResult]) {
      const context: RendererOverrideContext = { format, command: "ops scan", result };
      const rendered = await ext.runRendererOverride(context);
      assert.equal(rendered.overridden, false, `${format} renderer should decline a foreign/bare result on an owned command`);
      assert.equal(rendered.rendered, null, `${format} should leave native rendering intact`);
      assert.deepEqual(rendered.warnings, [], `${format} should produce no warnings`);
    }
  }
  await ext.deactivate();
});

test("declines its own marked result on a foreign command (commands ownership rejects)", async () => {
  const ext = await harness();
  // The result carries pm-ops's marker so resultDiscriminator would accept it,
  // but the command is one pm-ops does not own. The host's commands filter must
  // decline before the renderer runs. This is the case that protects the
  // ownership boundary the PR introduces: it fails if the commands declaration
  // is dropped, because then resultDiscriminator alone would let the renderer
  // claim a marked result emitted under a foreign command path.
  for (const format of ["toon", "json"] as const) {
    const context: RendererOverrideContext = { format, command: foreignCommand, result: markedResult };
    const rendered = await ext.runRendererOverride(context);
    assert.equal(rendered.overridden, false, `${format} renderer should decline its own marked result on a foreign command`);
    assert.equal(rendered.rendered, null, `${format} should leave native rendering intact`);
    assert.deepEqual(rendered.warnings, [], `${format} should produce no warnings`);
  }
  await ext.deactivate();
});

test("declines when both command and result are foreign (belt-and-braces)", async () => {
  const ext = await harness();
  for (const format of ["toon", "json"] as const) {
    const context: RendererOverrideContext = { format, command: foreignCommand, result: foreignResult };
    const rendered = await ext.runRendererOverride(context);
    assert.equal(rendered.overridden, false, `${format} renderer should decline a foreign result under a foreign command`);
    assert.equal(rendered.rendered, null, `${format} should leave native rendering intact`);
    assert.deepEqual(rendered.warnings, [], `${format} should produce no warnings`);
  }
  await ext.deactivate();
});

test("registered resultDiscriminator accepts the package marker and rejects a foreign marker", async () => {
  const ext = await harness();
  for (const override of ext.activation.renderers.overrides) {
    assert.equal(override.resultDiscriminator?.(markedResult), true, "discriminator must accept its own marker");
    assert.equal(override.resultDiscriminator?.(foreignResult), false, "discriminator must reject a foreign marker");
    assert.equal(override.resultDiscriminator?.({ output: "x" }), false, "discriminator must reject a bare object");
  }
  await ext.deactivate();
});
test("renderer ownership covers every command the extension registers", async () => {
  // The failure this catches: a new ops command is registered, returns a
  // pmOpsRendered result, and is missing from the renderer ownership list. The
  // host then declines the renderer for it and the command silently falls back
  // to native rendering. No build error, no type error, and an ownership test
  // that restates the same omission stays green. Comparing against what the
  // extension actually registered is the only assertion that notices.
  const ext = await harness();
  const registered = ext.activation.registrations.commands
    .map((entry) => entry.command)
    .sort((a, b) => a.localeCompare(b));
  const owned = [...OWNED_COMMANDS].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(
    registered,
    owned,
    "every registered ops command returns a pmOpsRendered result, so the renderer ownership list must match the registered command set exactly",
  );
});

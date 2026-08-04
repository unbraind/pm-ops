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

test("renderer declines a foreign result and preserves native rendering", async () => {
  const ext = await harness();
  for (const format of ["toon", "json"] as const) {
    const context: RendererOverrideContext = { format, command: "context-pack", result: foreignResult };
    const rendered = await ext.runRendererOverride(context);
    assert.equal(rendered.overridden, false, `${format} renderer should decline a foreign result`);
    assert.equal(rendered.rendered, null, `${format} should leave native rendering intact`);
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
import type { GlobalOptions } from "@unbrained/pm-cli/sdk";
import type { ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

/** Run a command through the real dispatch engine with quiet default globals. */
export async function runCmd<T>(
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

/**
 * npm `prepare` hook that installs clone-local pm merge drivers.
 *
 * Consumers copy the guarded launcher from the published template. This
 * repository keeps an `isMainInvocation` guard so importing the hook from the
 * suite cannot mutate Git config. Artifact-time prepare skips registration;
 * installation and direct invocation run the canonical installer.
 */

import { runPrepareMergeDriver } from "../merge-driver.ts";
import { isMainInvocation } from "./main-invocation.ts";

if (isMainInvocation(process.argv, import.meta.url)) {
  if (process.env.npm_command === "pack" || process.env.npm_command === "publish") {
    console.error(`npm ${process.env.npm_command}: skipping merge-driver install during artifact creation`);
  } else {
    process.exitCode = runPrepareMergeDriver();
  }
}

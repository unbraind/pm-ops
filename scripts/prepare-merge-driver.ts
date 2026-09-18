/**
 * npm `prepare` hook that installs clone-local pm merge drivers.
 *
 * Consumers copy a one-line launcher against `pm-ops/merge-driver`. This
 * repository's copy keeps an `isMainInvocation` guard so importing the hook
 * from the suite cannot mutate Git config, while `node scripts/prepare-merge-driver.ts`
 * still runs the canonical installer.
 */

import { runPrepareMergeDriver } from "../merge-driver.ts";
import { isMainInvocation } from "./main-invocation.ts";

if (isMainInvocation(process.argv, import.meta.url)) {
  process.exitCode = runPrepareMergeDriver();
}

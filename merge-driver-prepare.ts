/**
 * Executable entry that registers pm's merge drivers for a consumer's npm
 * `prepare` hook, published as `pm-ops/merge-driver/prepare`.
 *
 * Consumer launchers must not import pm-ops: it is a devDependency, so an
 * `npm install --omit=dev` checkout does not have it and a static import fails
 * before any fallback can run. The canonical launcher
 * (`templates/prepare-merge-driver.ts`) instead resolves this subpath and runs
 * it in a child process. Running it performs {@link runPrepareMergeDriver} and
 * reports its status as the process exit code.
 *
 * @packageDocumentation
 */

import { runPrepareMergeDriver } from "./merge-driver.ts";

process.exitCode = runPrepareMergeDriver();

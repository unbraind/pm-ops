/** Persist the date and empty-section policies used by release changelog hooks. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  changelogArguments, includeEmptyCustomHook, includeEmptyForwardedGenerators, includeEmptyReleaseSections, resolveChangelogHooks, rewriteReleaseHookDates,
  visitChangelogScriptCommands,
} from "../release-changelog-options.ts";
import { assertProjectNpmScriptShell, projectNpmLifecyclePolicy } from "./project-npm-lifecycle.ts";
import { appendReleaseReceipts, writeFileWithReceipts } from "./release-file-receipts.ts";

try {
  const manifest = resolve("package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  const headingDate = (process.env.RELEASE_HEADING_DATE || "").trim();
  let changed = false;
  const hooks = [process.env.CHANGELOG_SCRIPT!, process.env.CHANGELOG_CHECK_SCRIPT!, process.env.NOTES_SCRIPT!];
  const lifecycle = projectNpmLifecyclePolicy(".");
  const resolved = resolveChangelogHooks(pkg.scripts, hooks, lifecycle);
  assertProjectNpmScriptShell(".", resolved);
  const scriptNames = new Set(resolved.keys());
  const allScripts = new Map(Object.entries(pkg.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const datedHooks = rewriteReleaseHookDates(allScripts, hooks, headingDate, lifecycle, pkg.version);
  // The date visitor has no commands to edit in a comment-only hook.
  const forwardedHooks = includeEmptyForwardedGenerators(new Map([...allScripts, ...datedHooks]), hooks, lifecycle);
  const preparedScripts = new Map(resolved);
  for (const [name, script] of resolved) {
    const dated = datedHooks.get(name) ?? script;
    if (dated !== script) {
      const policy = headingDate ? "pins the heading to " + headingDate : "restores the version-derived heading policy";
      console.log(`::notice::Release commit ${policy} in package.json script "${name}".`);
    }
    const prepared = includeEmptyReleaseSections(forwardedHooks.get(name) ?? dated, scriptNames);
    if (prepared !== dated) {
      console.log(`::notice::Release commit adds --include-empty to generator invocations in package.json script "${name}" so later changelog checks agree with this dependency-only release.`);
    }
    preparedScripts.set(name, prepared);
  }
  const configured = new Set(hooks);
  const completed = new Set<string>();
  /** Prepare configured callees before selecting where the caller's flag goes. */
  function prepareCustomHook(name: string): void {
    if (completed.has(name)) return;
    completed.add(name);
    let hasGenerator = false;
    visitChangelogScriptCommands(resolved, ({ name: target, effective, names }) => {
      if (target !== name && configured.has(target)) prepareCustomHook(target);
      if (changelogArguments(effective, names, target)) hasGenerator = true;
    }, [name], undefined, undefined, { lifecycle, mainOnly: true });
    const prepared = preparedScripts.get(name)!;
    const statusOnlyCheck = name === hooks[1] && name !== hooks[2];
    const custom = includeEmptyCustomHook(prepared, preparedScripts, hasGenerator, statusOnlyCheck, name);
    if (custom !== prepared) console.log(`::notice::Release commit adds --include-empty to custom package.json script "${name}".`);
    preparedScripts.set(name, custom);
  }
  for (const hook of configured) prepareCustomHook(hook);
  for (const [name, prepared] of preparedScripts) {
    if (prepared !== resolved.get(name)) {
      pkg.scripts[name] = prepared;
      changed = true;
    }
  }
  const output = process.argv[2];
  /** Record the policy used by the saved manifest. */
  const writeReceipt = (path: string) => appendReleaseReceipts([{
    path, text: "npm_lifecycle=" + lifecycle.active + "\nnpm_lifecycle_configured=" + lifecycle.configured + "\n",
  }]);
  if (changed) {
    const prepared = JSON.stringify(pkg, null, 2) + "\n";
    if (output) writeFileWithReceipts(manifest, prepared, () => writeReceipt(output));
    else writeFileSync(manifest, prepared);
  } else if (output) writeReceipt(output);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}

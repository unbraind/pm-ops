/** Persist the date and empty-section policies used by release changelog hooks. */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  changelogArguments, includeEmptyCustomHook, includeEmptyForwardedGenerators, includeEmptyReleaseSections, resolveChangelogHooks, rewriteReleaseHookDates,
  visitChangelogScriptCommands,
} from "../release-changelog-options.ts";
import { projectNpmLifecyclePolicy } from "./project-npm-lifecycle.ts";
import { writeFileWithReceipts } from "./release-file-receipts.ts";

/** Test the main invocation and its explicit forwards independently of their lifecycle siblings. */
function usesMainGenerator(scripts: ReadonlyMap<string, string>, hook: string, lifecycle: ReturnType<typeof projectNpmLifecyclePolicy>): boolean {
  let found = false;
  visitChangelogScriptCommands(scripts, ({ effective, names }) => {
    if (changelogArguments(effective, names)) found = true;
  }, [hook], undefined, undefined, { lifecycle, mainOnly: true });
  return found;
}

try {
  const manifest = resolve("package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  const headingDate = (process.env.RELEASE_HEADING_DATE || "").trim();
  let changed = false;
  const hooks = [process.env.CHANGELOG_SCRIPT!, process.env.CHANGELOG_CHECK_SCRIPT!, process.env.NOTES_SCRIPT!];
  const lifecycle = projectNpmLifecyclePolicy(".");
  const resolved = resolveChangelogHooks(pkg.scripts, hooks, lifecycle);
  const scriptNames = new Set(resolved.keys());
  const allScripts = new Map(Object.entries(pkg.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const datedHooks = rewriteReleaseHookDates(allScripts, hooks, headingDate, lifecycle, pkg.version);
  // The date visitor has no commands to edit in a comment-only hook.
  const forwardedHooks = includeEmptyForwardedGenerators(new Map([...allScripts, ...datedHooks]), hooks, lifecycle);
  for (const [name, script] of resolved) {
    const dated = datedHooks.get(name) ?? script;
    if (dated !== script) {
      const policy = headingDate ? "pins the heading to " + headingDate : "restores the version-derived heading policy";
      console.log(`::notice::Release commit ${policy} in package.json script "${name}".`);
    }
    let prepared = includeEmptyReleaseSections(forwardedHooks.get(name) ?? dated, scriptNames);
    if (prepared !== dated) {
      console.log(`::notice::Release commit adds --include-empty to generator invocations in package.json script "${name}" so later changelog checks agree with this dependency-only release.`);
    }
    // Preserve the released workflow's saved argument for configured custom hooks.
    if (hooks.includes(name)) {
      const hasGenerator = usesMainGenerator(resolved, name, lifecycle);
      const statusOnlyCheck = name === hooks[1] && name !== hooks[2];
      const custom = includeEmptyCustomHook(prepared, resolved, hasGenerator, statusOnlyCheck, name);
      if (custom !== prepared) {
        console.log(`::notice::Release commit adds --include-empty to custom package.json script "${name}".`);
      }
      prepared = custom;
    }
    if (prepared !== script) {
      pkg.scripts[name] = prepared;
      changed = true;
    }
  }
  const output = process.argv[2];
  /** Record the policy used by the saved manifest. */
  const writeReceipt = (path: string) => appendFileSync(path,
    "npm_lifecycle=" + lifecycle.active + "\nnpm_lifecycle_configured=" + lifecycle.configured + "\n");
  if (changed) {
    const prepared = JSON.stringify(pkg, null, 2) + "\n";
    if (output) writeFileWithReceipts(manifest, prepared, () => writeReceipt(output));
    else writeFileSync(manifest, prepared);
  } else if (output) writeReceipt(output);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}

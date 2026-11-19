/** Persist the date and empty-section policies used by release changelog hooks. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  changelogArguments, includeEmptyReleaseSections, npmLifecycle, resolveChangelogHooks, rewriteReleaseHookDates,
  visitChangelogScriptCommands,
} from "../release-changelog-options.ts";
import { parseReleaseHook } from "../release-hook-grammar.ts";

/** Check whether preparation already handles empty sections through a generator reached by this hook. */
function usesGenerator(scripts: ReadonlyMap<string, string>, hook: string, lifecycle: ReturnType<typeof npmLifecycle>): boolean {
  let found = false;
  visitChangelogScriptCommands(scripts, ({ effective, names }) => {
    if (changelogArguments(effective, names)) found = true;
  }, [hook], undefined, undefined, { lifecycle });
  return found;
}

/** Save the custom flag before the final command's trailing shell syntax. */
function includeEmptyCustomHook(script: string): string {
  const { commands, spans } = parseReleaseHook(script);
  const command = commands.at(-1);
  if (!command || command.some(word => word.value === "--include-empty")) return script;
  const end = spans.get(command.at(-1)!)!.end;
  return script.slice(0, end) + " --include-empty" + script.slice(end);
}

try {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const headingDate = (process.env.RELEASE_HEADING_DATE || "").trim();
  let changed = false;
  const hooks = [process.env.CHANGELOG_SCRIPT!, process.env.CHANGELOG_CHECK_SCRIPT!, process.env.NOTES_SCRIPT!];
  const lifecycle = npmLifecycle(existsSync(".npmrc") ? readFileSync(".npmrc", "utf8") : undefined, process.env);
  const resolved = resolveChangelogHooks(pkg.scripts, hooks, lifecycle);
  const scriptNames = new Set(resolved.keys());
  const datedHooks = rewriteReleaseHookDates(resolved, hooks, headingDate, lifecycle, pkg.version);
  for (const [name, script] of resolved) {
    const dated = datedHooks.get(name) ?? script;
    if (dated !== script) {
      const policy = headingDate ? "pins the heading to " + headingDate : "restores the version-derived heading policy";
      console.log(`::notice::Release commit ${policy} in package.json script "${name}".`);
    }
    let prepared = includeEmptyReleaseSections(dated, scriptNames);
    if (prepared !== dated) {
      console.log(`::notice::Release commit adds --include-empty to generator invocations in package.json script "${name}" so later changelog checks agree with this dependency-only release.`);
    }
    // Preserve the released workflow's saved argument for configured custom hooks.
    if (hooks.includes(name) && !usesGenerator(resolved, name, lifecycle)) {
      const custom = includeEmptyCustomHook(prepared);
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
  if (changed) writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}

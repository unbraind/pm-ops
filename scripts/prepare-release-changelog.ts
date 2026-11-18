/** Persist the date and empty-section policies used by release changelog hooks. */
import { readFileSync, writeFileSync } from "node:fs";
import { includeEmptyReleaseSections, resolveChangelogHooks, rewriteReleaseHeadingDate } from "../release-changelog-options.ts";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const headingDate = (process.env.RELEASE_HEADING_DATE || "").trim();
if (headingDate && !/^\d{4}-\d{2}-\d{2}$/.test(headingDate)) {
  throw new Error("Release heading date must be YYYY-MM-DD, received " + JSON.stringify(headingDate));
}
let changed = false;
const hooks = [process.env.CHANGELOG_SCRIPT!, process.env.CHANGELOG_CHECK_SCRIPT!, process.env.NOTES_SCRIPT!];
for (const [name, script] of resolveChangelogHooks(pkg.scripts, hooks)) {
  const dated = rewriteReleaseHeadingDate(script, headingDate);
  if (dated !== script) {
    const policy = headingDate ? "pins the heading to " + headingDate : "restores the version-derived heading policy";
    console.log(`::notice::Release commit ${policy} in package.json script "${name}".`);
  }
  const prepared = includeEmptyReleaseSections(dated);
  if (prepared !== dated) {
    console.log(`::notice::Release commit adds --include-empty to generator invocations in package.json script "${name}" so later changelog checks agree with this dependency-only release.`);
  }
  if (prepared !== script) {
    pkg.scripts[name] = prepared;
    changed = true;
  }
}
if (changed) writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

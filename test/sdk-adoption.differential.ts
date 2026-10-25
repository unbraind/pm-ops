/** Compare built implementations against disposable read-only copies of public trackers, outside Git. */
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "../subprocess.ts";
import { fingerprint } from "./tracker-read-helpers.ts";

/** Relax directories before cleanup or make all copied tracker bytes read-only for the proof. */
function permissions(root: string, readonly: boolean): void {
  chmodSync(root, readonly ? 0o555 : 0o755);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) permissions(path, readonly);
    else chmodSync(path, readonly ? 0o444 : 0o644);
  }
}

/** Run both affected surfaces with no Git executable or enclosing repository. */
function inspect(build: string, tracker: string, scratch: string): unknown {
  const script = `import { auditConfiguredBackends } from ${JSON.stringify(pathToFileURL(join(build, "dist/backend-capabilities.js")).href)};
    import { runDiagnosticProbe } from ${JSON.stringify(pathToFileURL(join(build, "dist/diagnostic-probes.js")).href)};
    import { mkdirSync } from 'node:fs';
    const [tracker, scratch] = process.argv.slice(1);
    const backend = await auditConfiguredBackends([{id:'public',kind:'directory',root:tracker,operations:['list','get','schema']}], scratch);
    const probes = [];
    for (const command of ['sdk:schema:v1','sdk:items:v1','sdk:history:v1']) {
      const isolated = scratch + '/' + probes.length; mkdirSync(isolated);
      try { probes.push({command,checked:await runDiagnosticProbe(command,tracker,isolated)}); }
      catch { probes.push({command,refused:true}); }
    }
    process.stdout.write(JSON.stringify({backend,probes}));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script, tracker, scratch], {
    cwd: scratch, env: { PATH: "", SYSTEMROOT: process.env.SYSTEMROOT, GIT_CEILING_DIRECTORIES: dirname(scratch) },
    encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const [before, after, ...trackers] = process.argv.slice(2);
assert.ok(before && after && trackers.length, "Pass baseline build, candidate build, and public tracker roots.");
for (const [index, source] of trackers.entries()) {
  const root = mkdtempSync(join(tmpdir(), "ops-sdk-differential-"));
  const tracker = join(root, "tracker");
  try {
    cpSync(resolve(source), tracker, { recursive: true });
    permissions(tracker, true);
    const original = fingerprint(tracker);
    const oldScratch = join(root, "before"); const newScratch = join(root, "after");
    mkdirSync(oldScratch); mkdirSync(newScratch);
    const previous = inspect(resolve(before), tracker, oldScratch);
    const current = inspect(resolve(after), tracker, newScratch);
    assert.deepEqual(current, previous, `Public tracker ${index + 1} changed output`);
    assert.equal(fingerprint(tracker), original, "Source tracker changed");
    assert.equal(existsSync(join(root, ".git")), false);
    console.log(JSON.stringify({ tracker: index + 1, identical: true, source_unchanged: true, result: current }));
  } finally { permissions(root, false); rmSync(root, { recursive: true, force: true }); }
}

/** Read-only workflow compatibility inventory; supply the fleet directory as argv[2]. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditPublishAttestation } from "../attestation.ts";

const fleet = process.argv[2];
assert.ok(fleet, "Supply the fleet checkout directory");
const results = [];
for (const repo of readdirSync(fleet).sort()) {
  const directory = resolve(fleet, repo, ".github/workflows");
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    continue;
  }
  for (const workflow of names.filter((name) => /\.ya?ml$/u.test(name)).sort()) {
    const result = auditPublishAttestation([{ file: `.github/workflows/${workflow}`,
      text: readFileSync(resolve(directory, workflow), "utf8") }]);
    const status = result.failures.length === 0 ? "PASS"
      : result.recognition.kind === "none" && result.failures.length === 1
        && result.failures[0]!.startsWith("no npm publish") ? "NO_PUBLISH" : "FAIL";
    results.push({ repo, workflow, status, failures: result.failures });
  }
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);

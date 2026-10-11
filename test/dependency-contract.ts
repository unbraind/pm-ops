/** Validate one authoritative development pin against real installed and locked metadata. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkExtensionManifestCompatibility } from "@unbrained/pm-cli/sdk/authoring";

/** Read the host pin only after all independent dependency declarations agree. */
export function developmentCliVersion(root: string): string {
  const cli = "@unbrained/pm-cli";
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const pin = pkg.devDependencies?.[cli];
  assert.ok(pin, "development CLI pin is missing");
  assert.match(pin, /^\d+\.\d+\.\d+$/, "development CLI must be exactly pinned");
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { devDependencies?: Record<string, string>; version?: string }>;
  };
  assert.equal(lock.packages?.[""]?.devDependencies?.[cli], pin, "lock root CLI pin differs from package.json");
  assert.equal(lock.packages?.[`node_modules/${cli}`]?.version, pin, "locked CLI version differs from package.json");
  const installed = JSON.parse(readFileSync(join(root, "node_modules", cli, "package.json"), "utf8")) as { version?: string };
  assert.equal(installed.version, pin, "installed CLI version differs from package.json");
  const manifest: unknown = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.ok(manifest !== null && typeof manifest === "object" && "pm_min_version" in manifest);
  const floor = manifest.pm_min_version;
  assert.equal(typeof floor, "string", "manifest CLI floor must be a string");
  assert.match(floor as string, /^\d+\.\d+\.\d+$/, "manifest CLI floor must be exact");
  assert.equal(pkg.peerDependencies?.[cli], `>=${String(floor)}`, "peer and manifest CLI floors differ");
  const compatible = checkExtensionManifestCompatibility(manifest, { pmVersion: pin });
  assert.equal(compatible.compatible, true, "development CLI is incompatible with manifest bounds");
  assert.deepEqual(compatible.findings, [], "manifest violates the public SDK compatibility contract");
  return pin;
}

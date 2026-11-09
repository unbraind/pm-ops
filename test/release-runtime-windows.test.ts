/** Exercise native Windows npm probing, local bootstrap and locked installation. */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureReleaseRuntime } from "../scripts/release-runtime.ts";

test("native Windows installs a locked runtime without npm.cmd or lifecycle execution", () => {
  const root = mkdtempSync(join(tmpdir(), "release-windows-runtime-"));
  try {
    const runtime = join(root, ".github/release-runtime");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, "package.json"), JSON.stringify({ name: "runtime-fixture", version: "1.0.0", private: true,
      dependencies: { "locked-dependency": "file:dependency" },
      scripts: { install: 'node -e "require(\'node:fs\').writeFileSync(\'lifecycle-ran\', \'bad\')"' } }));
    mkdirSync(join(runtime, "dependency"));
    writeFileSync(join(runtime, "dependency/package.json"), JSON.stringify({ name: "locked-dependency", version: "1.0.0",
      scripts: { install: 'node -e "require(\'node:fs\').writeFileSync(\'dependency-lifecycle-ran\', \'bad\')"' } }));
    const lock = JSON.stringify({ name: "runtime-fixture", version: "1.0.0", lockfileVersion: 3, requires: true,
      packages: { "": { name: "runtime-fixture", version: "1.0.0", hasInstallScript: true, dependencies: { "locked-dependency": "file:dependency" } },
        dependency: { name: "locked-dependency", version: "1.0.0", hasInstallScript: true },
        "node_modules/locked-dependency": { resolved: "dependency", link: true } } });
    writeFileSync(join(runtime, "package-lock.json"), lock);
    ensureReleaseRuntime(root);
    assert.equal(JSON.parse(readFileSync(join(runtime, "node_modules/locked-dependency/package.json"), "utf8")).version, "1.0.0");
    assert.equal(existsSync(join(runtime, "dependency/dependency-lifecycle-ran")), false);
    assert.equal(readFileSync(join(runtime, "package-lock.json"), "utf8"), lock);
    assert.equal(existsSync(join(runtime, "lifecycle-ran")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

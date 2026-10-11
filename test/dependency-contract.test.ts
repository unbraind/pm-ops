/** Exercise dependency agreement and compatibility refusal on a real disposable tracker. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { developmentCliVersion } from "./dependency-contract.ts";

const source = resolve(import.meta.dirname, "..");

/** Metadata mutations represent inconsistent repositories, never simulated SDK behavior. */
interface Mutation {
  /** Filename under the fixture root. */
  file: string;
  /** Change decoded metadata while leaving the real SDK installed. */
  change: (document: Record<string, unknown>) => void;
  /** Expected fail-closed diagnostic. */
  diagnostic: RegExp;
}

/** Rewrite a JSON document without changing unrelated fixture state. */
function mutate(root: string, mutation: Mutation): void {
  const path = join(root, mutation.file);
  const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutation.change(document);
  writeFileSync(path, JSON.stringify(document));
}

test("dependency contract accepts the real installed pin and rejects every inconsistent declaration", /** Check the actual SDK and tracker against independent corruptions of each version declaration. */ () => {
  const root = mkdtempSync(join(tmpdir(), "pm-ops-dependency-"));
  try {
    symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "junction");
    const pmRoot = join(root, ".agents/pm");
    const env: NodeJS.ProcessEnv = { ...process.env, PM_PATH: pmRoot, PM_GLOBAL_PATH: join(root, "global"), PM_AUTHOR: "dependency-fixture", PM_TELEMETRY_DISABLED: "1" };
    delete env.NODE_TEST_CONTEXT;
    const cli = join(source, "node_modules/@unbrained/pm-cli/dist/cli.js");
    for (const args of [
      ["init", "--defaults", "--agent-guidance", "skip", "--prefix", "fixture", "--json"],
      ["create", "Synthetic dependency contract", "--type", "Task", "--json"],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args, "--pm-path", pmRoot], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
      assert.equal(result.status, 0, result.stderr + result.stdout);
    }
    const files = ["package.json", "package-lock.json", "manifest.json"];
    /** Restore only metadata under test; retain the real tracker and SDK. */
    const restore = (): void => {
      for (const file of files) copyFileSync(join(source, file), join(root, file));
    };
    restore();
    const pin = developmentCliVersion(root);
    assert.equal(pin, developmentCliVersion(source));
    mkdirSync(join(root, "test"));
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    for (const file of ["test/compatibility-floor.test.ts", "test/dependency-contract.ts", ".github/workflows/release.yml"]) {
      copyFileSync(join(source, file), join(root, file));
    }
    const suite = spawnSync(process.execPath, ["--test", "test/compatibility-floor.test.ts"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(suite.status, 0, suite.stderr + suite.stdout);
    const cases: Mutation[] = [
      { file: "package.json", change: (doc) => { delete (doc.devDependencies as Record<string, string>)["@unbrained/pm-cli"]; }, diagnostic: /pin is missing/ },
      { file: "package.json", change: (doc) => { (doc.devDependencies as Record<string, string>)["@unbrained/pm-cli"] = `^${pin}`; }, diagnostic: /exactly pinned/ },
      { file: "package-lock.json", change: (doc) => { ((doc.packages as Record<string, { devDependencies: Record<string, string> }>)[""].devDependencies)["@unbrained/pm-cli"] = "2026.8.20"; }, diagnostic: /lock root CLI pin differs/ },
      { file: "package-lock.json", change: (doc) => { (doc.packages as Record<string, { version: string }>)["node_modules/@unbrained/pm-cli"].version = "2026.8.20"; }, diagnostic: /locked CLI version differs/ },
      { file: "manifest.json", change: (doc) => { doc.pm_min_version = "2099.1.1"; }, diagnostic: /peer and manifest CLI floors differ/ },
      { file: "package.json", change: (doc) => { (doc.peerDependencies as Record<string, string>)["@unbrained/pm-cli"] = ">=2026.8.21"; }, diagnostic: /peer and manifest CLI floors differ/ },
      { file: "manifest.json", change: (doc) => { doc.pm_max_version = "2026.8.20"; }, diagnostic: /incompatible with manifest bounds/ },
      { file: "manifest.json", change: (doc) => { doc.unsupported_key = true; }, diagnostic: /public SDK compatibility contract/ },
    ];
    for (const mutation of cases) {
      restore();
      mutate(root, mutation);
      assert.throws(() => developmentCliVersion(root), mutation.diagnostic);
    }
    restore();
    mutate(root, { file: "manifest.json", change: (doc) => { doc.pm_min_version = "2099.1.1"; }, diagnostic: /unused/ });
    mutate(root, { file: "package.json", change: (doc) => { (doc.peerDependencies as Record<string, string>)["@unbrained/pm-cli"] = ">=2099.1.1"; }, diagnostic: /unused/ });
    assert.throws(() => developmentCliVersion(root), /incompatible with manifest bounds/);
    restore();
    // Keep both lock declarations consistent with a different pin: only the
    // real installed SDK is stale, so refusal must come from installed state.
    for (const file of ["package.json", "package-lock.json"]) {
      const path = join(root, file);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll(`"${pin}"`, '"2099.1.1"'));
    }
    assert.throws(() => developmentCliVersion(root), /installed CLI version differs/);
    const stale = spawnSync(process.execPath, ["--test", "test/compatibility-floor.test.ts"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(stale.status, 0, stale.stderr + stale.stdout);
    assert.match(stale.stdout, /installed CLI version differs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

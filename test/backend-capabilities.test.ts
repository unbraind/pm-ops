import assert from "node:assert/strict";
import test from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { spawnSync } from "../subprocess.ts";
import { chmodSync, existsSync, renameSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { auditBackendCapabilities, auditBackendConfigFile, auditConfiguredBackends, BackendReadRefusal, parseBackendConfig, type BackendReadAdapter } from "../backend-capabilities.ts";
import extension from "../index.ts";
import { runCmd } from "./command-test-helpers.ts";

/** Return normalized synthetic evidence through a real read port. */
function adapter(overrides: Partial<BackendReadAdapter> = {}): BackendReadAdapter {
  return { id: "sample", kind: "database", operations: ["list", "get", "schema"], read: async (operation, id) => {
    if (operation === "list") return { items: [{ id: "b" }, { id: "a" }], count: 2, complete: true };
    if (operation === "get") return { id };
    return { types: ["Task"] };
  }, ...overrides };
}

/** Fingerprint all file bytes so a read cannot hide tracker writes. */
function snapshot(root: string): string {
  return JSON.stringify(readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => { const path = join(entry.parentPath, entry.name); return [path.slice(root.length), readFileSync(path, "base64")]; }).sort());
}

/** Initialize a real plain-directory tracker through the pinned CLI. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "backend-test-"));
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  const env = { ...process.env, PM_PATH: join(root, ".agents", "pm"), GIT_CEILING_DIRECTORIES: dirname(root) };
  for (const args of [["init", "--defaults", "--agent-guidance", "skip", "--prefix", "sample"], ["create", "task", "Read contract fixture", "--id", "sample-a"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
  return root;
}

test("matrix distinguishes declarations, availability and failed invariants for all storage kinds", async () => {
  const report = await auditBackendCapabilities([
    adapter({ id: "directory", kind: "directory" }),
    adapter({ id: "database", operations: ["schema"], read: async () => { throw new Error("secret connection string"); } }),
    adapter({ id: "mcp", kind: "mcp", read: async () => ({ items: [], count: 1, complete: true }) }),
  ]);
  assert.deepEqual(report.rows.map((row) => row.status), ["supported", "supported", "supported", "unsupported", "unsupported", "unavailable", "invariant_failed", "unverified", "invariant_failed"]);
  assert.deepEqual(report.counts, { supported: 3, unsupported: 2, unavailable: 1, invariant_failed: 2, unverified: 1 });
  assert.equal(report.ok, false);
  assert.ok(!JSON.stringify(report).includes("secret"));
  assert.ok(report.rows.filter((row) => row.status !== "supported").every((row) => row.code.startsWith("backend_") && row.remedy));
});

test("list uniqueness, identity, completeness and count fail closed", async () => {
  const invalid: unknown[] = [null, [], {}, { complete: false, items: [], count: 0 }, { complete: true, items: null, count: 0 },
    { complete: true, items: [], count: "0" }, { complete: true, items: [null], count: 1 },
    { complete: true, items: [{ id: 2 }], count: 1 }, { complete: true, items: [{ id: " " }], count: 1 },
    { complete: true, items: [{ id: "a" }, { id: "a" }], count: 2 }];
  for (const value of invalid) {
    const report = await auditBackendCapabilities([adapter({ read: async () => value })]);
    assert.equal(report.rows[0]!.status, "invariant_failed");
  }
  const empty = await auditBackendCapabilities([adapter({ read: async (op) => op === "list" ? { items: [], count: 0, complete: true } : { types: ["Task"] } })]);
  assert.equal(empty.rows[0]!.checked, 0);
  assert.equal(empty.rows[1]!.status, "unverified");
});

test("get identity and schema invariants are independent and unsupported ports are never invoked", async () => {
  for (const value of [null, { id: "wrong" }]) {
    const good = adapter();
    const report = await auditBackendCapabilities([adapter({ read: async (op, id) => op === "get" ? value : good.read(op, id) })]);
    assert.equal(report.rows[1]!.status, "invariant_failed");
    assert.equal(report.rows[2]!.status, "supported");
  }
  for (const types of [null, [], [""], [3], ["Task", "Task"]]) {
    const report = await auditBackendCapabilities([adapter({ operations: ["schema"], read: async () => ({ types }) })]);
    assert.equal(report.rows[2]!.status, "invariant_failed");
  }
  const report = await auditBackendCapabilities([adapter({ operations: [], read: async () => assert.fail("unsupported read invoked") })]);
  assert.equal(report.ok, true);
  assert.equal(report.counts.unsupported, 3);
  await assert.rejects(auditBackendCapabilities([]), /invalid_adapter_ids/);
  await assert.rejects(auditBackendCapabilities(Array.from({ length: 33 }, () => adapter())), /invalid_adapter_ids/);
  await assert.rejects(auditBackendCapabilities([adapter(), adapter()]), /invalid_adapter_ids/);
  await assert.rejects(auditBackendCapabilities([adapter({ id: "private/path" })]), /invalid_adapter_ids/);
});

test("strict configuration rejects malformed declarations and credentialed endpoints", async () => {
  for (const value of [null, [], Array.from({ length: 33 }, () => ({})), [null], [{ id: 1 }],
    [{ id: "a", kind: "other", operations: [] }], [{ id: "a", kind: "directory", operations: null }],
    [{ id: "a", kind: "directory", operations: ["write"], root: "tracker" }],
    [{ id: "a", kind: "directory", operations: ["list", "list"], root: "tracker" }],
    [{ id: "a", kind: "directory", operations: [], root: "" }], [{ id: "a", kind: "mcp", operations: [] }]]) {
    assert.throws(() => parseBackendConfig(value), /invalid_backend_config/);
  }
  for (const endpoint of ["bad", "file:tracker", "http://user:password@localhost/", "https://localhost/#fragment"]) {
    assert.throws(() => parseBackendConfig([{ id: "a", kind: "mcp", operations: [], endpoint }]), /invalid_backend_endpoint/);
  }
  assert.equal(parseBackendConfig([{ id: "a", kind: "mcp", operations: [], endpoint: "https://localhost/" }]).length, 1);
  await assert.rejects(auditBackendConfigFile("missing-backends.json"), /invalid_backend_config/);
});

test("real directory snapshot and CLI work outside Git with no git executable and preserve all source bytes", async () => {
  const root = fixture();
  const tracker = join(root, ".agents", "pm");
  rmSync(join(tracker, "epics"), { recursive: true, force: true });
  const configPath = join(root, "backends.json");
  writeFileSync(configPath, JSON.stringify([{ id: "public", kind: "directory", root: ".agents/pm", operations: ["list", "get", "schema"] }]));
  const before = snapshot(tracker);
  try {
    const report = await auditBackendConfigFile(configPath);
    assert.equal(report.ok, true);
    assert.deepEqual(report.rows.map((row) => row.checked), [1, 1, 11]);
    const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "renderers", "schema", "parser", "services"] });
    try {
      assert.deepEqual(await runCmd(harness, "ops capabilities", { config: configPath }), report);
    } finally { await harness.deactivate(); }
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `import { auditBackendConfigFile } from ${JSON.stringify(resolve("backend-capabilities.ts"))}; console.log(JSON.stringify(await auditBackendConfigFile(process.argv[1])));`, configPath], {
      cwd: root, env: { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: dirname(root) }, encoding: "utf8",
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(JSON.parse(probe.stdout).counts.supported, 3);
    assert.equal(snapshot(tracker), before);
    assert.equal(existsSync(join(root, ".git")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("default command audits the host-resolved tracker independently of cwd and global path", async () => {
  const root = fixture();
  const tracker = join(root, "selected-tracker");
  renameSync(join(root, ".agents", "pm"), tracker);
  const before = snapshot(tracker);
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "renderers", "schema", "parser", "services"] });
  try {
    const expected = await auditConfiguredBackends([{ id: "tracker", kind: "directory", root: tracker, operations: ["list", "get", "schema"] }], root);
    assert.equal(expected.ok, true);
    assert.deepEqual(expected.rows.map((row) => row.checked), [1, 1, 11]);
    for (const global of [{}, { path: join(root, "missing-tracker") }]) {
      const actual = await harness.runCommand({ command: "ops capabilities", pmRoot: tracker, global });
      assert.equal(actual.handled, true);
      assert.deepEqual(actual.result, expected);
    }
    assert.equal(snapshot(tracker), before);
    assert.equal(existsSync(join(root, ".git")), false);
  } finally {
    await harness.deactivate();
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing directories and unsafe snapshot links yield safe refusals", async () => {
  const root = fixture();
  try {
    const config = (path: string) => [{ id: "dir", kind: "directory" as const, root: path, operations: ["list", "get", "schema"] as const }];
    const missing = await auditConfiguredBackends(config("missing"), root);
    assert.deepEqual(missing.rows.map((row) => row.status), ["unavailable", "unverified", "unavailable"]);
    const tracker = join(root, ".agents", "pm");
    symlinkSync(tracker, join(root, "linked"));
    assert.equal((await auditConfiguredBackends(config("linked"), root)).rows[0]!.status, "invariant_failed");
    symlinkSync(join(tracker, "tasks", "sample-a.toon"), join(tracker, "tasks", "alias.toon"));
    assert.equal((await auditConfiguredBackends(config(tracker), root)).rows[0]!.status, "invariant_failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("database and MCP read bridges send GET only and redact transport errors", async () => {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.method!);
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname === "/offline") { response.writeHead(503); response.end("private error"); return; }
    if (url.pathname === "/invalid") { response.end("invalid JSON"); return; }
    const op = url.searchParams.get("operation");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(op === "list" ? { items: [{ id: "fixture-a" }], count: 1, complete: true } : op === "get" ? { id: url.searchParams.get("id") } : { types: ["Task"] }));
  });
  await new Promise<void>((done) => { server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    const report = await auditConfiguredBackends([
      { id: "db", kind: "database", endpoint, operations: ["list", "get", "schema"] },
      { id: "mcp", kind: "mcp", endpoint: `${endpoint}/offline`, operations: ["list", "schema"] },
      { id: "bad", kind: "mcp", endpoint: `${endpoint}/invalid`, operations: ["schema"] },
    ], ".");
    assert.equal(report.counts.supported, 3);
    assert.equal(report.counts.unavailable, 2);
    assert.equal(report.counts.invariant_failed, 1);
    assert.ok(calls.every((method) => method === "GET"));
    assert.ok(!JSON.stringify(report).includes(endpoint));
    const typed = await auditBackendCapabilities([adapter({ read: async () => { throw new BackendReadRefusal("unavailable"); } })]);
    assert.equal(typed.rows[0]!.status, "unavailable");
  } finally { await new Promise<void>((done, reject) => { server.close((error) => error ? reject(error) : done()); }); }
});


test("directory parsing warnings fail list and mismatched physical identity fails get", async () => {
  const root = fixture();
  const tracker = join(root, ".agents", "pm");
  const config = [{ id: "dir", kind: "directory" as const, root: tracker, operations: ["list", "get", "schema"] as const }];
  try {
    renameSync(join(tracker, "tasks", "sample-a.toon"), join(tracker, "tasks", "different.toon"));
    const mismatched = await auditConfiguredBackends(config, root);
    assert.equal(mismatched.rows[1]!.status, "invariant_failed");
    writeFileSync(join(tracker, "tasks", "invalid.toon"), "invalid\n\tmalformed");
    const invalid = await auditConfiguredBackends(config, root);
    assert.equal(invalid.rows[0]!.status, "invariant_failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a configured nested folder blocked by a file refuses the snapshot", async () => {
  const root = fixture();
  try {
    const tracker = join(root, ".agents", "pm");
    const settingsPath = join(tracker, "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.item_types = { definitions: [{ name: "Nested", folder: "blocked/nested" }] };
    writeFileSync(settingsPath, JSON.stringify(settings));
    writeFileSync(join(tracker, "blocked"), "a file is not an item folder");
    const report = await auditConfiguredBackends([{ id: "dir", kind: "directory", root: tracker, operations: ["list", "schema"] }], root);
    assert.equal(report.rows[0]!.status, "unavailable");
    assert.equal(report.rows[2]!.status, "unavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("read-only source directories are unchanged and disposable copies are cleaned", async () => {
  const root = fixture();
  const tracker = join(root, ".agents", "pm");
  const directories = readdirSync(tracker, { recursive: true, withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(entry.parentPath, entry.name));
  const before = snapshot(tracker);
  try {
    for (const directory of directories) chmodSync(directory, 0o555);
    chmodSync(tracker, 0o555);
    const report = await auditConfiguredBackends([{ id: "readonly", kind: "directory", root: tracker, operations: ["list", "get", "schema"] }], root);
    assert.equal(report.ok, true);
    assert.equal(snapshot(tracker), before);
  } finally {
    chmodSync(tracker, 0o755);
    for (const directory of directories) chmodSync(directory, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});


test("snapshot cleanup always attempts removal and preserves evidence after filesystem failures", async (t) => {
  const root = fixture();
  const config = [{ id: "dir", kind: "directory" as const, root: ".agents/pm", operations: ["list", "get", "schema"] as const }];
  const originalMkdtemp = fsPromises.mkdtemp;
  const originalChmod = fsPromises.chmod;
  const originalReaddir = fsPromises.readdir;
  const originalRm = fsPromises.rm;
  try {
    for (const failing of ["readdir", "chmod", "rm"] as const) {
      let injected = 0;
      let allocated: string | undefined;
      let removed: string | undefined;
      t.mock.method(fsPromises, "mkdtemp", async (prefix: string) => {
        const directory = await originalMkdtemp(prefix);
        if (prefix === join(tmpdir(), "pm-backend-")) allocated = directory;
        return directory;
      });
      t.mock.method(fsPromises, "chmod", async (...args: Parameters<typeof originalChmod>) => {
        if (failing === "chmod" && String(args[0]) === allocated) { injected += 1; throw new Error("permission repair failed"); }
        return originalChmod(...args);
      });
      t.mock.method(fsPromises, "readdir", (...args: Parameters<typeof originalReaddir>) => {
        if (failing === "readdir" && String(args[0]) === allocated) { injected += 1; return Promise.reject(new Error("directory enumeration failed")); }
        return originalReaddir(...args);
      });
      t.mock.method(fsPromises, "rm", async (...args: Parameters<typeof originalRm>) => {
        if (String(args[0]) !== allocated) return originalRm(...args);
        removed = String(args[0]);
        await originalRm(...args);
        if (failing === "rm") { injected += 1; throw new Error("removal reported failure"); }
      });
      syncBuiltinESMExports();
      try {
        const report = await auditConfiguredBackends(config, root);
        assert.equal(injected, 1, `${failing}: failure was not injected`);
        assert.equal(report.ok, true, failing);
        assert.equal(report.counts.supported, 3, failing);
        assert.ok(removed, `${failing}: removal was never attempted`);
        assert.equal(existsSync(removed), false);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        if (allocated) rmSync(allocated, { recursive: true, force: true });
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Read-only backend contract assurance; never runs Git or tracker mutations. */
import { readRegularText } from "./regular-input.ts";
import { chmod, cp, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listAllItemMetadata, locateItem, readLocatedItem, readSettings, resolveItemTypeRegistry } from "@unbrained/pm-cli/sdk";

/** Fixed audited read surface. Mutations are deliberately outside this contract. */
export const BACKEND_OPERATIONS = ["list", "get", "schema"] as const;
/** One audited SDK read operation. */
export type BackendOperation = typeof BACKEND_OPERATIONS[number];
/** Outcome distinguishes lack of support, transport failure and broken evidence. */
export type BackendCapabilityStatus = "supported" | "unsupported" | "unavailable" | "invariant_failed" | "unverified";
/** A provider must expose only side-effect-free reads; results cross an untrusted boundary. */
export interface BackendReadAdapter {
  /** Public, non-sensitive adapter label. */
  id: string;
  /** Storage implementation category, independent of transport. */
  kind: "directory" | "database" | "mcp";
  /** Declared support; missing operations are never invoked. */
  operations: readonly BackendOperation[];
  /** Execute a normalized read: list -> {items:[{id}],count,complete}; get -> {id}; schema -> {types:[string]}. */
  read: (operation: BackendOperation, id?: string) => Promise<unknown>;
}
/** Typed refusal with a safe remedy; raw exceptions and backend data are excluded. */
export class BackendReadRefusal extends Error {
  /** Classify the failed probe without parsing an exception message. */
  readonly status: "unavailable" | "invariant_failed";
  /** Construct a typed provider failure. */
  constructor(status: "unavailable" | "invariant_failed") {
    super(status);
    this.name = "BackendReadRefusal";
    this.status = status;
  }
}
/** Invalid configuration is refused before any backend reads. */
export class BackendConfigurationRefusal extends Error {
  /** Stable input failure code. */
  readonly code: "invalid_adapter_ids" | "invalid_backend_config" | "invalid_backend_endpoint";
  /** Safe recovery instructions, excluding the supplied value. */
  readonly remedy: string;
  /** Build an actionable configuration failure. */
  constructor(code: BackendConfigurationRefusal["code"], remedy: string) {
    super(`${code}: ${remedy}`);
    this.name = "BackendConfigurationRefusal";
    this.code = code;
    this.remedy = remedy;
  }
}

/** Compact, data-free evidence for one adapter and operation. */
export interface BackendCapabilityRow {
  /** Adapter label, never its connection string. */
  adapter: string;
  /** Storage category. */
  kind: BackendReadAdapter["kind"];
  /** Read contract that was audited. */
  operation: BackendOperation;
  /** Independent outcome. */
  status: BackendCapabilityStatus;
  /** Stable machine-readable refusal code, or verified. */
  code: "verified" | `backend_${Exclude<BackendCapabilityStatus, "supported">}`;
  /** Count of verified rows or schema types. */
  checked: number;
  /** Action to resolve a refusal. */
  remedy: string;
}
/** Agent-sized report containing three rows per configured adapter. */
export interface BackendCapabilityMatrix {
  /** Version of this report and normalized read contract. */
  version: 1;
  /** True only when every declared operation was verified. Unsupported declarations remain visible. */
  ok: boolean;
  /** Exactly one row per adapter/operation pair. */
  rows: BackendCapabilityRow[];
  /** Totals by outcome. */
  counts: Record<BackendCapabilityStatus, number>;
}

/** Narrow a transport value to a non-array record. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate complete list evidence before selecting a deterministic get probe. */
function listIds(value: unknown): string[] {
  if (!record(value) || value.complete !== true || !Array.isArray(value.items) || value.count !== value.items.length) {
    throw new BackendReadRefusal("invariant_failed");
  }
  const ids = value.items.map((item: unknown) => {
    if (!record(item) || typeof item.id !== "string" || !item.id.trim()) throw new BackendReadRefusal("invariant_failed");
    return item.id;
  });
  if (new Set(ids).size !== ids.length) throw new BackendReadRefusal("invariant_failed");
  return ids.sort();
}

/** Verify one schema read without returning schema contents. */
function schemaCount(value: unknown): number {
  if (!record(value) || !Array.isArray(value.types) || value.types.length === 0
    || !value.types.every((type: unknown) => typeof type === "string" && type.trim().length > 0)
    || new Set(value.types).size !== value.types.length) throw new BackendReadRefusal("invariant_failed");
  return value.types.length;
}

/** Audit every configured adapter using only its declared read ports, without returning tracker data. */
export async function auditBackendCapabilities(adapters: readonly BackendReadAdapter[]): Promise<BackendCapabilityMatrix> {
  if (adapters.length === 0 || adapters.length > 32 || new Set(adapters.map((adapter) => adapter.id)).size !== adapters.length
    || adapters.some((adapter) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(adapter.id))) {
    throw new BackendConfigurationRefusal("invalid_adapter_ids", "use unique public labels of 1-64 letters, digits, underscores or hyphens");
  }
  const rows: BackendCapabilityRow[] = [];
  const counts: BackendCapabilityMatrix["counts"] = { supported: 0, unsupported: 0, unavailable: 0, invariant_failed: 0, unverified: 0 };
  for (const adapter of adapters) {
    let ids: string[] = [];
    for (const operation of BACKEND_OPERATIONS) {
      let status: BackendCapabilityStatus = "supported";
      let checked = 0;
      if (!adapter.operations.includes(operation)) status = "unsupported";
      else if (operation === "get" && ids.length === 0) status = "unverified";
      else {
        try {
          const value = await adapter.read(operation, operation === "get" ? ids[0] : undefined);
          if (operation === "list") { ids = listIds(value); checked = ids.length; }
          else if (operation === "schema") checked = schemaCount(value);
          else {
            if (!record(value) || value.id !== ids[0]) throw new BackendReadRefusal("invariant_failed");
            checked = 1;
          }
        } catch (error) {
          status = error instanceof BackendReadRefusal ? error.status : "unavailable";
        }
      }
      const remedies: Record<BackendCapabilityStatus, string> = {
        supported: "",
        unsupported: "Use an adapter declaring this read operation.",
        unavailable: "Check connection, read credentials and bridge compatibility; retry.",
        invariant_failed: "Repair the read contract or tracker integrity, then retry on a stable snapshot.",
        unverified: "Provide a nonempty complete list to verify get; no synthetic item is created.",
      };
      counts[status] += 1;
      rows.push({ adapter: adapter.id, kind: adapter.kind, operation, status, code: status === "supported" ? "verified" : `backend_${status}`, checked, remedy: remedies[status] });
    }
  }
  return { version: 1, ok: counts.unavailable + counts.invariant_failed + counts.unverified === 0, rows, counts };
}

/** Declarative CLI adapter configuration. Remote endpoints implement the normalized read bridge, not native SQL or MCP. */
export interface BackendAdapterConfig {
  /** Public adapter label. */
  id: string;
  /** Storage category. */
  kind: BackendReadAdapter["kind"];
  /** Directory tracker root, relative to the configuration file. */
  root?: string;
  /** HTTP read bridge URL; credentials must be supplied through its deployment, never URL userinfo. */
  endpoint?: string;
  /** Declared read support. */
  operations: readonly BackendOperation[];
}

/** Parse configuration without executing code or accepting ambiguous connection options. */
export function parseBackendConfig(value: unknown): BackendAdapterConfig[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new BackendConfigurationRefusal("invalid_backend_config", "configure 1-32 adapters");
  return value.map((entry: unknown) => {
    if (!record(entry) || typeof entry.id !== "string"
      || !["directory", "database", "mcp"].includes(String(entry.kind)) || !Array.isArray(entry.operations)
      || !entry.operations.every((op: unknown) => BACKEND_OPERATIONS.includes(op as BackendOperation))
      || new Set(entry.operations).size !== entry.operations.length
      || (entry.kind === "directory" ? typeof entry.root !== "string" || !entry.root : typeof entry.endpoint !== "string")) {
      throw new BackendConfigurationRefusal("invalid_backend_config", "supply id, kind, unique operations and root or endpoint");
    }
    if (entry.kind !== "directory") {
      let endpoint: URL;
      try { endpoint = new URL(entry.endpoint as string); } catch { throw new BackendConfigurationRefusal("invalid_backend_endpoint", "use an HTTP read bridge URL"); }
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
        throw new BackendConfigurationRefusal("invalid_backend_endpoint", "use HTTP(S) without URL credentials or fragments");
      }
    }
    return entry as unknown as BackendAdapterConfig;
  });
}

/** Copy only authoritative settings and registered item folders; reject links escaping the snapshot. */
async function directorySnapshot(root: string, target: string): Promise<void> {
  const settingsPath = join(root, "settings.json");
  if ((await lstat(root)).isSymbolicLink() || (await lstat(settingsPath)).isSymbolicLink()) throw new BackendReadRefusal("invariant_failed");
  await cp(settingsPath, join(target, "settings.json"));
  const settings = await readSettings(target);
  const registry = resolveItemTypeRegistry(settings);
  for (const folder of new Set(Object.values(registry.type_to_folder))) {
    try { await lstat(join(root, folder)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await cp(join(root, folder), join(target, folder), { recursive: true, filter: async (source) => {
      if ((await lstat(source)).isSymbolicLink()) throw new BackendReadRefusal("invariant_failed");
      return true;
    } });
  }
}

/** Bind isolated directory SDK reads; the original tracker is never passed to cache-writing SDK helpers. */
async function directoryRead(root: string, operation: BackendOperation, id?: string): Promise<unknown> {
  const settings = await readSettings(root);
  const registry = resolveItemTypeRegistry(settings);
  if (operation === "schema") return { types: registry.types };
  const warnings: string[] = [];
  if (operation === "list") {
    const items = await listAllItemMetadata(root, settings.item_format, registry.type_to_folder, warnings, settings.schema);
    if (warnings.length) throw new BackendReadRefusal("invariant_failed");
    return { items, count: items.length, complete: true };
  }
  const item = await locateItem(root, id!, settings.id_prefix, settings.item_format, registry.type_to_folder);
  if (!item) throw new BackendReadRefusal("invariant_failed");
  const result = await readLocatedItem(item, { schema: settings.schema });
  return result.document.metadata;
}

/** Relax owned snapshot directories before reading their children, even after a partial copy. */
async function relaxSnapshotPermissions(root: string): Promise<void> {
  try {
    await chmod(root, 0o700);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) await relaxSnapshotPermissions(join(root, entry.name));
    }
  } catch {
    // Permission repair is best effort; removal must still be attempted.
  }
}

/** Audit configured adapters, removing disposable SDK cache snapshots even when reads fail. */
export async function auditConfiguredBackends(config: readonly BackendAdapterConfig[], base: string): Promise<BackendCapabilityMatrix> {
  parseBackendConfig(config);
  const scratch = await mkdtemp(join(tmpdir(), "pm-backend-"));
  try {
    const adapters: BackendReadAdapter[] = [];
    for (const [index, entry] of config.entries()) {
      const snapshot = join(scratch, String(index));
      let failure: unknown;
      if (entry.kind === "directory") {
        try { await directorySnapshot(resolve(base, entry.root!), snapshot); } catch (error) { failure = error; }
      }
      adapters.push({ ...entry, read: async (operation, id) => {
        if (failure) throw failure;
        if (entry.kind === "directory") return directoryRead(snapshot, operation, id);
        const url = new URL(entry.endpoint!);
        url.searchParams.set("operation", operation);
        if (id !== undefined) url.searchParams.set("id", id);
        const response = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
        if (!response.ok) throw new BackendReadRefusal("unavailable");
        try { return await response.json(); } catch { throw new BackendReadRefusal("invariant_failed"); }
      } });
    }
    return await auditBackendCapabilities(adapters);
  } finally {
    try {
      await relaxSnapshotPermissions(scratch);
    } finally {
      try { await rm(scratch, { recursive: true, force: true }); } catch {
        // Cleanup failure must not replace the audit evidence or original error.
      }
    }
  }
}

/** Read a JSON adapter configuration relative to its own directory. */
export async function auditBackendConfigFile(path: string): Promise<BackendCapabilityMatrix> {
  let value: unknown;
  try { value = JSON.parse(readRegularText(path)); } catch { throw new BackendConfigurationRefusal("invalid_backend_config", "provide a regular JSON adapter file no larger than 16 MiB"); }
  return auditConfiguredBackends(parseBackendConfig(value), dirname(resolve(path)));
}

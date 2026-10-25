/** Read-only backend contract assurance; never runs Git or tracker mutations. */
import { readRegularText } from "./regular-input.js";
import { chmod, cp, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PmClient, PmCliError, readSettings, resolveItemTypeRegistry } from "@unbrained/pm-cli/sdk";
/** Fixed audited read surface. Mutations are deliberately outside this contract. */
export const BACKEND_OPERATIONS = ["list", "get", "schema"];
/** Typed refusal with a safe remedy; raw exceptions and backend data are excluded. */
export class BackendReadRefusal extends Error {
    /** Classify the failed probe without parsing an exception message. */
    status;
    /** Construct a typed provider failure. */
    constructor(status) {
        super(status);
        this.name = "BackendReadRefusal";
        this.status = status;
    }
}
/** Invalid configuration is refused before any backend reads. */
export class BackendConfigurationRefusal extends Error {
    /** Stable input failure code. */
    code;
    /** Safe recovery instructions, excluding the supplied value. */
    remedy;
    /** Build an actionable configuration failure. */
    constructor(code, remedy) {
        super(`${code}: ${remedy}`);
        this.name = "BackendConfigurationRefusal";
        this.code = code;
        this.remedy = remedy;
    }
}
/** Narrow a transport value to a non-array record. */
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Validate complete list evidence before selecting a deterministic get probe. */
function listIds(value) {
    if (!record(value) || value.complete !== true || !Array.isArray(value.items) || value.count !== value.items.length) {
        throw new BackendReadRefusal("invariant_failed");
    }
    const ids = value.items.map((item) => {
        if (!record(item) || typeof item.id !== "string" || !item.id.trim())
            throw new BackendReadRefusal("invariant_failed");
        return item.id;
    });
    if (new Set(ids).size !== ids.length)
        throw new BackendReadRefusal("invariant_failed");
    return ids.sort();
}
/** Verify one schema read without returning schema contents. */
function schemaCount(value) {
    if (!record(value) || !Array.isArray(value.types) || value.types.length === 0
        || !value.types.every((type) => typeof type === "string" && type.trim().length > 0)
        || new Set(value.types).size !== value.types.length)
        throw new BackendReadRefusal("invariant_failed");
    return value.types.length;
}
/** Audit every configured adapter using only its declared read ports, without returning tracker data. */
export async function auditBackendCapabilities(adapters) {
    if (adapters.length === 0 || adapters.length > 32 || new Set(adapters.map((adapter) => adapter.id)).size !== adapters.length
        || adapters.some((adapter) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(adapter.id))) {
        throw new BackendConfigurationRefusal("invalid_adapter_ids", "use unique public labels of 1-64 letters, digits, underscores or hyphens");
    }
    const rows = [];
    const counts = { supported: 0, unsupported: 0, unavailable: 0, invariant_failed: 0, unverified: 0 };
    for (const adapter of adapters) {
        let ids = [];
        for (const operation of BACKEND_OPERATIONS) {
            let status = "supported";
            let checked = 0;
            if (!adapter.operations.includes(operation))
                status = "unsupported";
            else if (operation === "get" && ids.length === 0)
                status = "unverified";
            else {
                try {
                    const value = await adapter.read(operation, operation === "get" ? ids[0] : undefined);
                    if (operation === "list") {
                        ids = listIds(value);
                        checked = ids.length;
                    }
                    else if (operation === "schema")
                        checked = schemaCount(value);
                    else {
                        if (!record(value) || value.id !== ids[0])
                            throw new BackendReadRefusal("invariant_failed");
                        checked = 1;
                    }
                }
                catch (error) {
                    status = error instanceof BackendReadRefusal ? error.status : "unavailable";
                }
            }
            const remedies = {
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
/** Parse configuration without executing code or accepting ambiguous connection options. */
export function parseBackendConfig(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 32)
        throw new BackendConfigurationRefusal("invalid_backend_config", "configure 1-32 adapters");
    return value.map((entry) => {
        if (!record(entry) || typeof entry.id !== "string"
            || !["directory", "database", "mcp"].includes(String(entry.kind)) || !Array.isArray(entry.operations)
            || !entry.operations.every((op) => BACKEND_OPERATIONS.includes(op))
            || new Set(entry.operations).size !== entry.operations.length
            || (entry.kind === "directory" ? typeof entry.root !== "string" || !entry.root : typeof entry.endpoint !== "string")) {
            throw new BackendConfigurationRefusal("invalid_backend_config", "supply id, kind, unique operations and root or endpoint");
        }
        if (entry.kind !== "directory") {
            let endpoint;
            try {
                endpoint = new URL(entry.endpoint);
            }
            catch {
                throw new BackendConfigurationRefusal("invalid_backend_endpoint", "use an HTTP read bridge URL");
            }
            if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
                throw new BackendConfigurationRefusal("invalid_backend_endpoint", "use HTTP(S) without URL credentials or fragments");
            }
        }
        return entry;
    });
}
/** Copy only authoritative settings and registered item folders; reject links escaping the snapshot. */
async function directorySnapshot(root, target) {
    const settingsPath = join(root, "settings.json");
    if ((await lstat(root)).isSymbolicLink() || (await lstat(settingsPath)).isSymbolicLink())
        throw new BackendReadRefusal("invariant_failed");
    await cp(settingsPath, join(target, "settings.json"));
    const settings = await readSettings(target);
    const registry = resolveItemTypeRegistry(settings);
    for (const folder of new Set(Object.values(registry.type_to_folder))) {
        try {
            await lstat(join(root, folder));
        }
        catch (error) {
            if (error.code === "ENOENT")
                continue;
            throw error;
        }
        await cp(join(root, folder), join(target, folder), { recursive: true, filter: async (source) => {
                if ((await lstat(source)).isSymbolicLink())
                    throw new BackendReadRefusal("invariant_failed");
                return true;
            } });
    }
}
/** Bind isolated directory SDK reads; the original tracker is never passed to cache-writing SDK helpers. */
async function directoryRead(root, operation, id) {
    const settings = await readSettings(root);
    const registry = resolveItemTypeRegistry(settings);
    if (operation === "schema")
        return { types: registry.types };
    const client = new PmClient({ pmRoot: root, noExtensions: true });
    if (operation === "list") {
        try {
            const result = await client.listAllComplete();
            return { items: result.items, count: result.count, complete: result.complete_list.source_complete };
        }
        catch (error) {
            if (error instanceof PmCliError && error.code === "list_source_incomplete")
                throw new BackendReadRefusal("invariant_failed");
            throw error;
        }
    }
    try {
        return (await client.get(id, { fields: "id" })).item;
    }
    catch (error) {
        if (error instanceof PmCliError && error.code !== "tracker_root_unreadable")
            throw new BackendReadRefusal("invariant_failed");
        throw error;
    }
}
/** Relax owned snapshot directories before reading their children, even after a partial copy. */
async function relaxSnapshotPermissions(root) {
    try {
        await chmod(root, 0o700);
        for (const entry of await readdir(root, { withFileTypes: true })) {
            if (entry.isDirectory())
                await relaxSnapshotPermissions(join(root, entry.name));
        }
    }
    catch {
        // Permission repair is best effort; removal must still be attempted.
    }
}
/** Audit configured adapters, removing disposable SDK cache snapshots even when reads fail. */
export async function auditConfiguredBackends(config, base) {
    parseBackendConfig(config);
    const scratch = await mkdtemp(join(tmpdir(), "pm-backend-"));
    try {
        const adapters = [];
        for (const [index, entry] of config.entries()) {
            const snapshot = join(scratch, String(index));
            let failure;
            if (entry.kind === "directory") {
                try {
                    await directorySnapshot(resolve(base, entry.root), snapshot);
                }
                catch (error) {
                    failure = error;
                }
            }
            adapters.push({ ...entry, read: async (operation, id) => {
                    if (failure)
                        throw failure;
                    if (entry.kind === "directory")
                        return directoryRead(snapshot, operation, id);
                    const url = new URL(entry.endpoint);
                    url.searchParams.set("operation", operation);
                    if (id !== undefined)
                        url.searchParams.set("id", id);
                    const response = await fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
                    if (!response.ok)
                        throw new BackendReadRefusal("unavailable");
                    try {
                        return await response.json();
                    }
                    catch {
                        throw new BackendReadRefusal("invariant_failed");
                    }
                } });
        }
        return await auditBackendCapabilities(adapters);
    }
    finally {
        try {
            await relaxSnapshotPermissions(scratch);
        }
        finally {
            try {
                await rm(scratch, { recursive: true, force: true });
            }
            catch {
                // Cleanup failure must not replace the audit evidence or original error.
            }
        }
    }
}
/** Read a JSON adapter configuration relative to its own directory. */
export async function auditBackendConfigFile(path) {
    let value;
    try {
        value = JSON.parse(readRegularText(path));
    }
    catch {
        throw new BackendConfigurationRefusal("invalid_backend_config", "provide a regular JSON adapter file no larger than 16 MiB");
    }
    return auditConfiguredBackends(parseBackendConfig(value), dirname(resolve(path)));
}
//# sourceMappingURL=backend-capabilities.js.map
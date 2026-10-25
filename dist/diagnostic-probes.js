/** Catalog probes isolate SDK caches; no source writes, extension hooks or Git. */
import { copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { effectiveItemFormatVersion, getHistoryPath, listAllItemMetadata, locateItem, readHistorySnapshot, readLocatedItem, readSettingsWithMetadata, runWithConfigurationOnlySettings, resolveItemTypeRegistry, scanItemFormatVersions, verifyHistoryEntries } from "@unbrained/pm-cli/sdk";
/** Refuse links and unexpected filesystem types instead of escaping the selected tracker. */
async function requireType(path, directory) {
    const stat = await lstat(path);
    if (directory ? !stat.isDirectory() : !stat.isFile())
        throw new Error("unsafe_scope");
}
/** Resolve a portable tracker-local path, refusing traversal and links at every ancestor. */
async function scopedPath(root, relative, directory) {
    const parts = relative.replace(/\\/g, "/").split("/");
    if (isAbsolute(relative) || win32.isAbsolute(relative) || parts.some((part) => !part || part === "." || part === ".."))
        throw new Error("unsafe_scope");
    let path = root;
    for (const [index, part] of parts.entries()) {
        path = join(path, part);
        await requireType(path, directory || index < parts.length - 1);
    }
    return path;
}
/** Hydrate core settings only in the parent-owned disposable copy, never scaffolding the source. */
async function diagnosticSettings(root, scratch) {
    await copyFile(join(root, "settings.json"), join(scratch, "settings.json"));
    const base = await runWithConfigurationOnlySettings(scratch, () => readSettingsWithMetadata(scratch));
    if (base.warnings.length)
        throw new Error("settings_invalid");
    for (const relative of Object.values(base.settings.schema.files)) {
        try {
            const source = await scopedPath(root, relative, false);
            const target = join(scratch, relative.replace(/\\/g, "/"));
            await mkdir(dirname(target), { recursive: true });
            await copyFile(source, target);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    const hydrated = await readSettingsWithMetadata(scratch);
    if (hydrated.warnings.some((warning) => !warning.startsWith("runtime_schema_bootstrap_created:")))
        throw new Error("schema_invalid");
    return hydrated.settings;
}
/** Inspect physical scope independently; SDK caches and normalized reads cannot prove link safety or file cardinality. */
async function snapshotItems(root, scratch, settings) {
    const registry = resolveItemTypeRegistry(settings);
    let count = 0;
    for (const folder of new Set(Object.values(registry.type_to_folder))) {
        let path;
        try {
            path = await scopedPath(root, folder, true);
        }
        catch (error) {
            if (error.code === "ENOENT")
                continue;
            throw error;
        }
        await mkdir(join(scratch, folder), { recursive: true });
        for (const entry of await readdir(path)) {
            if (!/\.(toon|md)$/.test(entry))
                continue;
            const itemPath = join(path, entry);
            await requireType(itemPath, false);
            if (!isUtf8(await readFile(itemPath)))
                throw new Error("items_invalid");
            await copyFile(itemPath, join(scratch, folder, entry));
            count++;
        }
    }
    return count;
}
/** Count canonical SDK rows in an isolated copy; verify history against fresh source documents before reporting evidence. */
async function readItems(root, scratch, history, settings) {
    const registry = resolveItemTypeRegistry(settings);
    if (history)
        await requireType(join(root, "history"), true);
    const physicalCount = await snapshotItems(root, scratch, settings);
    const warnings = [];
    const items = await listAllItemMetadata(scratch, settings.item_format, registry.type_to_folder, warnings, settings.schema);
    if (warnings.length)
        throw new Error("items_invalid");
    if (items.length !== physicalCount)
        throw new Error("duplicate_item");
    if (scanItemFormatVersions(items.map((item) => ({ ref: item.id, version: effectiveItemFormatVersion(item) }))).ahead.length)
        throw new Error("items_invalid");
    if (!history)
        return items.length;
    let checked = 0;
    for (const item of items) {
        const located = await locateItem(root, item.id, settings.id_prefix, settings.item_format, registry.type_to_folder);
        if (!located)
            throw new Error("items_invalid");
        const { document } = await readLocatedItem(located, { schema: settings.schema });
        const path = getHistoryPath(root, item.id);
        await requireType(path, false);
        const snapshot = await readHistorySnapshot(path, item.id);
        if (!snapshot.entries.length || !verifyHistoryEntries(snapshot.entries, document).ok)
            throw new Error("history_invalid");
        checked += snapshot.entries.length;
    }
    return checked;
}
/** Run one fixed diagnostic, returning counts only. The caller enforces its shared wall-clock deadline. */
export async function runDiagnosticProbe(command, root, scratch) {
    if (command === "http:registry-head:v1") {
        const response = await fetch("https://registry.npmjs.org/", { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(5000) });
        if (!response.ok)
            throw new Error("registry_unavailable");
        return 1;
    }
    await requireType(root, true);
    await requireType(join(root, "settings.json"), false);
    const settings = await diagnosticSettings(root, scratch);
    if (command === "sdk:schema:v1")
        return resolveItemTypeRegistry(settings).types.length;
    if (command === "sdk:items:v1" || command === "sdk:history:v1")
        return readItems(root, scratch, command === "sdk:history:v1", settings);
    throw new Error("unknown_command");
}
//# sourceMappingURL=diagnostic-probes.js.map
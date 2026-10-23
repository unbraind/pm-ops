/** Side-effect-free catalog primitives; no extension hooks, Git, caches or tracker writes. */
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { getHistoryPath, readHistorySnapshot, readLocatedItem, readSettingsWithMetadata, runWithConfigurationOnlySettings, resolveItemTypeRegistry, verifyHistoryEntries } from "@unbrained/pm-cli/sdk";
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
/** Enumerate only registered item folders and delegate every document read to the canonical SDK. */
async function readItems(root, history, settings) {
    const registry = resolveItemTypeRegistry(settings);
    const ids = new Set();
    let checked = 0;
    if (history)
        await requireType(join(root, "history"), true);
    for (const [type, folder] of Object.entries(registry.type_to_folder)) {
        let path;
        try {
            path = await scopedPath(root, folder, true);
        }
        catch (error) {
            if (error.code === "ENOENT")
                continue;
            throw error;
        }
        for (const entry of await readdir(path)) {
            const match = /^(.*)\.(toon|md)$/.exec(entry);
            if (!match)
                continue;
            const itemPath = join(path, entry);
            await requireType(itemPath, false);
            const { document } = await readLocatedItem({ id: match[1], type, itemPath, item_format: match[2] === "toon" ? "toon" : "json_markdown" }, { schema: settings.schema });
            if (ids.has(document.metadata.id))
                throw new Error("duplicate_item");
            ids.add(document.metadata.id);
            if (history) {
                const path = getHistoryPath(root, document.metadata.id);
                await requireType(path, false);
                const snapshot = await readHistorySnapshot(path, document.metadata.id);
                if (!snapshot.entries.length || !verifyHistoryEntries(snapshot.entries, document).ok)
                    throw new Error("history_invalid");
                checked += snapshot.entries.length;
            }
            else
                checked++;
        }
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
        return readItems(root, command === "sdk:history:v1", settings);
    throw new Error("unknown_command");
}
//# sourceMappingURL=diagnostic-probes.js.map
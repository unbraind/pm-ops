/** Resolve the effective, explicitly configured lifecycle policy in npm's project context. */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { npmLifecycle, npmLifecycleEnvironmentValues, releaseHookUsingPipefail } from "../release-changelog-options.js";
import { spawnSync } from "../subprocess.js";
import { isMainInvocation } from "./main-invocation.js";
import { npmLauncherRuntime } from "./release-runtime.js";
import { describeUnsupportedReleaseHook, unsupportedReleaseConstruct } from "../release-shell-constructs.js";
const WORKSPACE_SELECTION_EXIT = 2;
const WORKSPACE_SELECTION = "Release hooks cannot use npm workspace selectors. Clear workspace or workspaces settings that select another manifest";
/** Use npm's own workspace and npmrc loader, without running any package scripts. */
async function readLifecycle(cli, env) {
    const fromNpm = createRequire(cli);
    const Config = fromNpm("@npmcli/config");
    const config = new Config({ ...fromNpm("@npmcli/config/lib/definitions"), npmPath: dirname(dirname(cli)),
        argv: [process.execPath, cli, "run"], env: { ...env } });
    await config.load();
    if (config.get("workspaces") === true || config.find("workspace") !== "default"
        || (config.get("include-workspace-root") === true && config.get("workspace").length > 0))
        return "workspace";
    const key = "ignore-scripts";
    if (config.find(key) === "env") {
        if (npmLifecycleEnvironmentValues(env).length > 1)
            return npmLifecycle(undefined, env);
        const value = config.get(key, "env");
        return typeof value === "boolean" ? !value : "unknown";
    }
    for (const source of ["project", "user", "global", "builtin"]) {
        const layer = config.data.get(source);
        if (layer.loadError && layer.loadError.code !== "ENOENT")
            return "unknown";
        if (Object.hasOwn(layer.data, key)) {
            const value = config.get(key, source);
            return typeof value === "boolean" ? !value : "unknown";
        }
    }
    return "unknown";
}
/** Decode a scalar written by the npm probe or verified release receipt. */
export function parseNpmLifecycle(value) {
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    return "unknown";
}
/** Retain the config that nested npm commands reload after clearing the exported setting. */
export function projectNpmLifecyclePolicy(cwd) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--policy"], { cwd, encoding: "utf8" });
    if (result.status === WORKSPACE_SELECTION_EXIT)
        throw new Error(WORKSPACE_SELECTION);
    const [active, configured] = result.status === 0 ? result.stdout.split(":") : [];
    return { active: parseNpmLifecycle(active), configured: parseNpmLifecycle(configured) };
}
/** Resolve npm's string setting or its platform default shell name. */
export function npmScriptShell(setting, platform, comSpec) {
    if (setting !== "null")
        return setting;
    return platform === "win32" ? comSpec || "cmd.exe" : "sh";
}
/** Check the npm-selected script shell only when a reachable hook uses pipefail. */
export function assertProjectNpmScriptShell(cwd, hooks) {
    const hook = releaseHookUsingPipefail(hooks);
    if (hook === undefined)
        return;
    let supported = false;
    try {
        const { node, cli } = npmLauncherRuntime();
        const config = spawnSync(node, [cli, "config", "get", "script-shell"], { cwd, encoding: "utf8", timeout: 10_000 });
        const configured = config.stdout?.trim();
        if (config.status === 0 && configured && !/[\r\n]/.test(configured)) {
            const shell = npmScriptShell(configured, process.platform, process.env.ComSpec);
            if (/(?:^|[\\/])(?:bash|sh|dash|ash|ksh|mksh|zsh|yash|posh)(?:\.exe)?$/i.test(shell)) {
                // npm resolves the shell using the script PATH, including project bin directories.
                const fromRunScript = createRequire(createRequire(cli).resolve("@npmcli/run-script"));
                const setPath = fromRunScript("./set-path.js");
                const env = setPath(realpathSync(cwd), undefined, { ...process.env, BASH_ENV: "", ENV: "" });
                supported = spawnSync(shell, ["-c", "set -o pipefail"], { cwd, stdio: "ignore", timeout: 5000, env }).status === 0;
            }
        }
    }
    catch {
        // Unknown launchers cannot prove support for a shell option.
    }
    if (unsupportedReleaseConstruct("pipefail", "hook", supported ? "bash" : "sh")) {
        throw new Error(describeUnsupportedReleaseHook("pipefail in npm's selected script shell", hook));
    }
}
/** Model clearing npm's canonical key before a nested invocation reloads configuration. */
export function npmLifecycleFallbackEnvironment(env, platform = process.platform) {
    const key = "npm_config_ignore_scripts";
    const fallback = platform === "win32"
        ? Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== key))
        : { ...env };
    fallback[key] = "";
    return fallback;
}
/** Print the policy from the chosen npm installation under its own Node runtime. */
async function printPolicy(bundle, cli) {
    const active = cli === undefined ? "unknown" : await readLifecycle(cli, process.env).catch(() => "unknown");
    if (active === "workspace") {
        console.error(WORKSPACE_SELECTION);
        process.exitCode = WORKSPACE_SELECTION_EXIT;
    }
    else if (bundle) {
        const configured = cli !== undefined && process.env.npm_config_ignore_scripts
            ? await readLifecycle(cli, npmLifecycleFallbackEnvironment(process.env)).catch(() => "unknown")
            : active;
        process.stdout.write(active + ":" + configured);
    }
    else
        process.stdout.write(String(active));
}
/** Use Node from the stock npm shebang, whose executable path sets the default npmrc. */
async function probeLauncher(bundle) {
    let cli;
    try {
        const runtime = npmLauncherRuntime();
        if (realpathSync(runtime.node) !== realpathSync(process.execPath)) {
            // npm supports Node versions that cannot load this TypeScript entry point.
            const worker = fileURLToPath(new URL("../dist/scripts/project-npm-lifecycle.js", import.meta.url));
            const result = spawnSync(runtime.node, [worker, process.argv[2] ?? "", runtime.cli], { encoding: "utf8" });
            const policy = bundle ? /^(true|false|unknown):(true|false|unknown)$/ : /^(true|false|unknown)$/;
            if (result.status === WORKSPACE_SELECTION_EXIT || (result.status === 0 && policy.test(result.stdout))) {
                process.stdout.write(result.stdout);
                process.stderr.write(result.stderr);
                process.exitCode = result.status;
                return;
            }
        }
        else
            cli = runtime.cli;
    }
    catch {
        // An unrecognized launcher cannot supply a definite policy.
    }
    await printPolicy(bundle, cli);
}
if (isMainInvocation(process.argv, import.meta.url)) {
    const bundle = process.argv[2] === "--policy";
    const cli = process.argv[3];
    if (cli === undefined)
        await probeLauncher(bundle);
    else
        await printPolicy(bundle, cli);
}
//# sourceMappingURL=project-npm-lifecycle.js.map
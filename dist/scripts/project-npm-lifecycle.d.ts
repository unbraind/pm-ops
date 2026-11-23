import { type NpmLifecycle } from "../release-changelog-options.ts";
/** Decode a scalar written by the npm probe or verified release receipt. */
export declare function parseNpmLifecycle(value: string | undefined): NpmLifecycle;
/** Retain the config that nested npm commands reload after clearing the exported setting. */
export declare function projectNpmLifecyclePolicy(cwd: string): {
    active: NpmLifecycle;
    configured: NpmLifecycle;
};
/** Resolve npm's string setting or its platform default shell name. */
export declare function npmScriptShell(setting: string, platform: NodeJS.Platform, comSpec?: string): string;
/** Check the npm-selected script shell only when a reachable hook uses pipefail. */
export declare function assertProjectNpmScriptShell(cwd: string, hooks: ReadonlyMap<string, string>): void;
/** Model clearing npm's canonical key before a nested invocation reloads configuration. */
export declare function npmLifecycleFallbackEnvironment(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): NodeJS.ProcessEnv;
//# sourceMappingURL=project-npm-lifecycle.d.ts.map
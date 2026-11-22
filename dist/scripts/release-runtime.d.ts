/** The source checkout containing this trusted helper, never a release PR checkout. */
export declare const workflowToolsRoot: string;
/** Locate an npm CLI without executing a shell or switching the selected Node. */
export declare function npmCli(pathOnly?: boolean): string;
/** Find npm as the project's shell sees it and identify the interpreter it uses. */
export declare function npmLauncherRuntime(): {
    cli: string;
    node: string;
};
/** Install the private verifier only for a pending publication, never for an empty probe. */
export declare function ensureReleaseRuntime(root?: string, run?: (args: string[], cwd: string) => void): void;
/** Load the exact checked-out planner, even when its declared package version is unpublished. */
export declare function installReleaseTools(root: string, prefix: string, version: string): string;
//# sourceMappingURL=release-runtime.d.ts.map
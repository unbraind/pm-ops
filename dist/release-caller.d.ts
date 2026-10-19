/** Resolve only release tags owned by the canonical repository, including annotated tags. */
export declare function fetchCanonicalReleaseTags(run?: (args: string[]) => string): Record<string, string>;
/** Verify a SHA-pinned caller with no embedded jobs, private steps, or inherited secrets. */
export declare function checkReleaseCaller(source: string, releaseTags?: Readonly<Record<string, string>>): string[];
//# sourceMappingURL=release-caller.d.ts.map
/** Refuse runtimes that cannot execute the continuation's native TypeScript entry point. */
export declare function assertContinuationRuntime(version: string): void;
/** Reject caller selectors that can only select a runtime below the native TypeScript floor. */
export declare function assertContinuationSelection(value: unknown): void;
//# sourceMappingURL=continuation-runtime.d.ts.map
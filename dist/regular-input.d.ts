/** Sanitized input refusal shared by file consumers. */
export declare class InputRefusal extends Error {
    /** Stable machine-readable classification. */
    readonly code = "invalid_input";
    /** Recovery instruction independent of the supplied path. */
    readonly remedy: string;
    /** Invalid input is a usage error. */
    readonly exitCode = 2;
    /** Whether the file is unsupported or could not be inspected. */
    readonly reason: "unsupported" | "unreadable";
    /** Construct without retaining paths or operating-system diagnostics. */
    constructor(limit: number, reason?: "unsupported" | "unreadable");
}
/** Read a regular file with preflight and descriptor checks, bounded allocation and nonblocking open. */
export declare function readRegularInput(path: string, limit?: number): Buffer;
/** Decode bounded regular input as UTF-8 for existing text parsers. */
export declare function readRegularText(path: string, limit?: number): string;
//# sourceMappingURL=regular-input.d.ts.map
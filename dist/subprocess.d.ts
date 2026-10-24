/** Bounded subprocess captures with sanitized, actionable overflow refusals. */
import { execFileSync as nodeExecFileSync, spawnSync as nodeSpawnSync } from "node:child_process";
/** Default ceiling for command metadata and diagnostics, independent of Node defaults. */
export declare const CAPTURE_LIMIT: number;
/** A capture exceeded its explicit ceiling; partial output must never be parsed. */
export declare class CaptureRefusal extends Error {
    /** Stable usage-error classification. */
    readonly code = "output_limit";
    /** Oversized command output requires an explicit change in input or transport. */
    readonly exitCode = 2;
    /** Safe recovery instructions without child arguments, output or credentials. */
    readonly remedy: string;
    /** Construct a refusal that never retains raw subprocess errors. */
    constructor(limit: number);
}
/** A caller requested shell interpretation at a direct-executable boundary. */
export declare class ShellRefusal extends Error {
    /** Stable usage-error classification. */
    readonly code = "shell_not_allowed";
    /** Shell requests require a corrected invocation. */
    readonly exitCode = 2;
    /** Recovery instructions without caller-controlled arguments or shell paths. */
    readonly remedy = "Pass the executable and an argument array instead of requesting a shell.";
    /** Construct a sanitized refusal before launching any child process. */
    constructor();
}
/** Translate both synchronous and asynchronous Node overflow error codes without retaining partial output. */
export declare function refuseCaptureOverflow(error: unknown, limit: number): void;
/** Capture with a finite ceiling, preserving Node's overloads and ordinary command failures. */
export declare const execFileSync: typeof nodeExecFileSync;
/** Spawn with bounded capture and refuse overflow before a caller can consume truncated stdout. */
export declare const spawnSync: typeof nodeSpawnSync;
//# sourceMappingURL=subprocess.d.ts.map
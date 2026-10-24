/** Bounded subprocess captures with sanitized, actionable overflow refusals. */
import { execFileSync as nodeExecFileSync, spawnSync as nodeSpawnSync } from "node:child_process";
/** Default ceiling for command metadata and diagnostics, independent of Node defaults. */
export const CAPTURE_LIMIT = 16 * 1024 * 1024;
/** A capture exceeded its explicit ceiling; partial output must never be parsed. */
export class CaptureRefusal extends Error {
    /** Stable usage-error classification. */
    code = "output_limit";
    /** Oversized command output requires an explicit change in input or transport. */
    exitCode = 2;
    /** Safe recovery instructions without child arguments, output or credentials. */
    remedy;
    /** Construct a refusal that never retains raw subprocess errors. */
    constructor(limit) {
        const remedy = `Reduce or paginate command output below ${limit} bytes, or stream bulk data to a file before retrying.`;
        super(`output_limit: ${remedy}`);
        this.name = "CaptureRefusal";
        this.remedy = remedy;
    }
}
/** A caller requested shell interpretation at a direct-executable boundary. */
export class ShellRefusal extends Error {
    /** Stable usage-error classification. */
    code = "shell_not_allowed";
    /** Shell requests require a corrected invocation. */
    exitCode = 2;
    /** Recovery instructions without caller-controlled arguments or shell paths. */
    remedy = "Pass the executable and an argument array instead of requesting a shell.";
    /** Construct a sanitized refusal before launching any child process. */
    constructor() {
        super("shell_not_allowed: Pass the executable and an argument array instead of requesting a shell.");
        this.name = "ShellRefusal";
    }
}
/** Translate both synchronous and asynchronous Node overflow error codes without retaining partial output. */
export function refuseCaptureOverflow(error, limit) {
    const code = error?.code;
    if (code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
        throw new CaptureRefusal(limit);
}
/** Capture with a finite ceiling, preserving Node's overloads and ordinary command failures. */
export const execFileSync = ((command, argsOrOptions = [], supplied = {}) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = Array.isArray(argsOrOptions) ? supplied : argsOrOptions;
    if (options.shell)
        throw new ShellRefusal();
    const maxBuffer = options.maxBuffer ?? CAPTURE_LIMIT;
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0)
        throw new CaptureRefusal(CAPTURE_LIMIT);
    try {
        return nodeExecFileSync(command, args, { stdio: "pipe", ...options, maxBuffer, shell: false });
    }
    catch (error) {
        refuseCaptureOverflow(error, maxBuffer);
        throw error;
    }
});
/** Spawn with bounded capture and refuse overflow before a caller can consume truncated stdout. */
export const spawnSync = ((command, argsOrOptions = [], supplied = {}) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = Array.isArray(argsOrOptions) ? supplied : argsOrOptions;
    if (options.shell)
        throw new ShellRefusal();
    const maxBuffer = options.maxBuffer ?? CAPTURE_LIMIT;
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0)
        throw new CaptureRefusal(CAPTURE_LIMIT);
    const result = nodeSpawnSync(command, args, { ...options, maxBuffer, shell: false });
    refuseCaptureOverflow(result.error, maxBuffer);
    return result;
});
//# sourceMappingURL=subprocess.js.map
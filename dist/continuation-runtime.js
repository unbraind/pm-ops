/** Dependency-free runtime guard that also executes as committed JavaScript on older Node versions. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
/** Refuse runtimes that cannot execute the continuation's native TypeScript entry point. */
export function assertContinuationRuntime(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 18) || (Number(match[1]) === 23 && Number(match[2]) < 6)) {
        throw new Error("Release continuation requires Node.js 22.18.0 or newer");
    }
}
/** Reject caller selectors that can only select a runtime below the native TypeScript floor. */
export function assertContinuationSelection(value) {
    if (typeof value !== "string")
        throw new Error("node-version must be a string selecting Node.js 22.18.0 or newer");
    const selection = value.trim();
    if (/^lts\/(argon|boron|carbon|dubnium|erbium|fermium|gallium|hydrogen|iron)$/i.test(selection)) {
        throw new Error("node-version must select Node.js 22.18.0 or newer");
    }
    const match = /^v?(\d+)(?:\.(\d+))?/.exec(selection);
    if (match && (Number(match[1]) < 22 || (Number(match[1]) === 22 && match[2] !== undefined && Number(match[2]) < 18)
        || (Number(match[1]) === 23 && match[2] !== undefined && Number(match[2]) < 6))) {
        throw new Error("node-version must select Node.js 22.18.0 or newer");
    }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    assertContinuationRuntime(process.versions.node);
//# sourceMappingURL=continuation-runtime.js.map
/** Dependency-free runtime preflight with lazily loaded semver for caller selector admission. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
/** Minimum minor for each runtime band; the final band also admits later majors. */
const runtimeBands = [[22, 18], [23, 6]];
/** Refuse runtimes that cannot execute the continuation's native TypeScript entry point. */
export function assertContinuationRuntime(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    const band = runtimeBands.slice().reverse().find(([major]) => Number(match?.[1]) >= major);
    if (!match || band === undefined || (Number(match[1]) === band[0] && Number(match[2]) < band[1])) {
        throw new Error("Release continuation requires Node.js 22.18.0 or newer");
    }
}
/** Reject semver selectors with no supported stable runtime while retaining setup-node aliases. */
export function assertContinuationSelection(value) {
    if (typeof value !== "string")
        throw new Error("node-version must be a string selecting Node.js 22.18.0 or newer");
    const selection = value.trim();
    if (/^lts\/(argon|boron|carbon|dubnium|erbium|fermium|gallium|hydrogen|iron)$/i.test(selection)) {
        throw new Error("node-version must select Node.js 22.18.0 or newer");
    }
    // Loading a selector's semver parser must not add dependencies to the runtime preflight.
    const { Range, inc } = require("semver");
    let range;
    try {
        range = new Range(selection);
    }
    catch {
        return;
    } // setup-node aliases (including future LTS names) are resolved by setup-node.
    const candidates = new Set(runtimeBands.map(([major, minor]) => `${major}.${minor}.0`));
    // A stable interval begins at a runtime floor, a comparator's stable core or
    // its successor. Ask semver for patch/minor/major successors so exhausted
    // numeric components can carry without handwritten version arithmetic.
    for (const comparators of range.set)
        for (const comparator of comparators) {
            if (!comparator.value)
                continue;
            const version = comparator.semver;
            const stable = `${version.major}.${version.minor}.${version.patch}`;
            candidates.add(stable);
            for (const release of ["patch", "minor", "major"]) {
                const successor = inc(stable, release);
                if (successor !== null)
                    candidates.add(successor);
            }
        }
    const possible = [...candidates].some(candidate => {
        if (!range.test(candidate))
            return false;
        try {
            assertContinuationRuntime(candidate);
            return true;
        }
        catch {
            return false;
        }
    });
    if (!possible) {
        throw new Error("node-version must select Node.js 22.18.0 or newer");
    }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    assertContinuationRuntime(process.versions.node);
//# sourceMappingURL=continuation-runtime.js.map
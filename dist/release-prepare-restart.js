/** Permit at most two bot-dispatched preparations per caller and release day. */
export function decidePrepareRestart(input) {
    if (!Number.isSafeInteger(input.botDispatchCount) || input.botDispatchCount < 0) {
        throw new Error("Invalid bot dispatch history count; expected a nonnegative integer");
    }
    if (input.publishedToday || input.reconcileOnly || input.retireUnpublished)
        return "stop";
    return input.baseSha !== input.mainSha && input.botDispatchCount < 2 ? "restart" : "fail";
}
//# sourceMappingURL=release-prepare-restart.js.map
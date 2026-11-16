/** Permit two complete restarts, refusing malformed counters rather than resetting them. */
export function decidePrepareRestart(input) {
    if (!Number.isSafeInteger(input.restartCount) || input.restartCount < 0 || input.restartCount > 2) {
        throw new Error("Invalid prepare restart counter; expected an integer from 0 to 2");
    }
    if (input.publishedToday || input.reconcileOnly || input.retireUnpublished)
        return "stop";
    return input.baseSha !== input.mainSha && input.restartCount < 2 ? "restart" : "fail";
}
//# sourceMappingURL=release-prepare-restart.js.map
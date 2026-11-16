/** Bounded admission of fresh preparation; a verified artifact is never retargeted. */
export interface PrepareRestartInput {
    /** The trigger or prepared base rejected by the workflow's unchanged lease check. */
    baseSha: string;
    /** Freshly read main, used only to decide whether another preparation is needed. */
    mainSha: string;
    /** Restarts already consumed by this daily run's dispatch chain. */
    restartCount: number;
    /** Live publication dates in the configured timezone enforce the daily cap. */
    publishedToday: boolean;
    /** Recovery schedules never admit fresh preparation. */
    reconcileOnly: boolean;
    /** Explicit retirement remains a separate operator transition. */
    retireUnpublished: boolean;
}
/** Permit two complete restarts, refusing malformed counters rather than resetting them. */
export declare function decidePrepareRestart(input: PrepareRestartInput): "restart" | "fail" | "stop";
//# sourceMappingURL=release-prepare-restart.d.ts.map
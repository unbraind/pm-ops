/** Bounded admission of fresh preparation; a verified artifact is never retargeted. */
export interface PrepareRestartInput {
  /** The trigger or prepared base rejected by the workflow's unchanged lease check. */
  baseSha: string;
  /** Freshly read main, used only to decide whether another preparation is needed. */
  mainSha: string;
  /** Bot dispatches already created today for this caller workflow. */
  botDispatchCount: number;
  /** Live publication dates in the configured timezone enforce the daily cap. */
  publishedToday: boolean;
  /** Recovery schedules never admit fresh preparation. */
  reconcileOnly: boolean;
  /** Explicit retirement remains a separate operator transition. */
  retireUnpublished: boolean;
}

/** Permit at most two bot-dispatched preparations per caller and release day. */
export function decidePrepareRestart(input: PrepareRestartInput): "restart" | "fail" | "stop" {
  if (!Number.isSafeInteger(input.botDispatchCount) || input.botDispatchCount < 0) {
    throw new Error("Invalid bot dispatch history count; expected a nonnegative integer");
  }
  if (input.publishedToday || input.reconcileOnly || input.retireUnpublished) return "stop";
  return input.baseSha !== input.mainSha && input.botDispatchCount < 2 ? "restart" : "fail";
}

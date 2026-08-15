import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { type MergeDecisionReceipt } from "@unbrained/pm-cli/sdk/merge";
/**
 * Project a receipt's requested preference side for the fleet view.
 *
 * The SDK's receipt reader normalizes every receipt it returns to carry
 * `requested_preference`, folding the legacy schema-v1 `preferred` key and
 * defaulting to `"ours"` when a receipt records neither — the exact chain
 * `summarizeMergeReceipt` applies for committed-history summaries. Centralizing
 * it here keeps the fleet view's field consistent with those summaries and
 * gives the legacy/default arms a directly testable home.
 */
export declare function receiptPreferredSide(receipt: Readonly<Pick<MergeDecisionReceipt, "requested_preference" | "preferred">>): "ours" | "theirs";
interface RepoMetrics {
    path: string;
    repo: string;
    available: boolean;
    status_counts: Record<string, number>;
    type_counts: Record<string, number>;
    priority_counts: Record<string, number>;
    blocked: number | null;
    stale: number;
    throughput_7d: number;
    throughput_30d: number;
    cycle_time_p50_seconds: number | null;
    cycle_time_p90_seconds: number | null;
    backlog_age_p50_seconds: number | null;
    backlog_age_p90_seconds: number | null;
    /** Pending clone-local merge decision receipts (field-aware driver). */
    merge_receipts_pending: number;
    /** Reconciled clone-local merge decision receipts. */
    merge_receipts_reconciled: number;
    /** 1 if the clone-local merge driver is installed (not missing), else 0. */
    merge_driver_installed: number;
    /** 1 if a committed `.gitattributes` merge fence is installed (not missing), else 0. */
    merge_fence_installed: number;
}
/**
 * Guarantee unique `repo` labels within a single scrape. Two checkouts can share
 * a package.json name (e.g. a fork and its upstream, or the same repo passed
 * twice), which would emit duplicate Prometheus series and make the scrape
 * ambiguous or rejected. On collision, disambiguate with the directory basename,
 * then the full path, then a numeric suffix as a last resort.
 */
export declare function disambiguateRepoLabels(repoMetrics: RepoMetrics[]): void;
declare const _default: {
    name: string;
    version: string;
    activate(api: ExtensionApi): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map
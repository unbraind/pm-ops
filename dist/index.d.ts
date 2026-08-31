import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { type MergeDecisionReceipt, type MergeDriverConfigurationAuditResult, type MergeFenceAuditResult } from "@unbrained/pm-cli/sdk/merge";
/** One recoverable scalar decision recorded by the field-aware merge driver. */
interface MergeReceiptDecisionView {
    /** Metadata field name, or `body`. */
    field: string;
    /** Common-ancestor value. */
    base: unknown;
    /** Current-branch value. */
    ours: unknown;
    /** Other-branch value. */
    theirs: unknown;
    /** Value retained in the merged item. */
    retained: unknown;
    /** Value not retained in the merged item. */
    discarded: unknown;
}
/** Clone-local merge decision receipt projected for the fleet report. */
interface MergeReceiptView {
    /** Opaque clone-local receipt identity. */
    id: string;
    /** Item whose merge produced the receipt. */
    item_id: string;
    /** Repo-relative item path reported by the current pm SDK. */
    item_path: string;
    /** Raw `item_path` exactly as Git recorded it (quotes preserved). */
    item_path_raw: string;
    /** Whether a merge reconciliation history event consumed this receipt. */
    state: "pending" | "reconciled";
    /**
     * Side the merge requested for unresolvable scalar conflicts (the SDK's
     * `requested_preference`, folding the legacy `preferred` key). Under the
     * SDK's `stable_value_order` contract the *retained* value is the
     * direction-independent stable one, so this field reports the requested
     * side while `decisions[].retained` reports what actually won.
     */
    preferred: "ours" | "theirs";
    /** Fields selected cleanly from the other branch. */
    fields_from_theirs: string[];
    /** Collections combined from both branches. */
    union_fields: string[];
    /** Full recoverable scalar decisions, retained only in the clone. */
    decisions: MergeReceiptDecisionView[];
    /** Receipt creation timestamp. */
    created_at: string;
    /** Reconciliation timestamp, when consumed. */
    reconciled_at?: string;
}
/** Per-repo merge-receipt report combining driver/fence audit and receipts. */
interface RepoMergeReceipts {
    /** Absolute repo path. */
    path: string;
    /** Package name, else directory basename. */
    name: string | null;
    /** Whether a git workspace was found (receipts are clone-local under `.git`). */
    available: boolean;
    /** Clone-local merge-driver configuration audit, or null outside git. */
    driver: MergeDriverConfigurationAuditResult | null;
    /** Committed `.gitattributes` merge-fence audit, or null outside git. */
    fence: MergeFenceAuditResult | null;
    /** Receipts projected for the report. */
    receipts: MergeReceiptView[];
    /** Receipts in `state: "pending"`. */
    pending_count: number;
    /** Receipts in `state: "reconciled"`. */
    reconciled_count: number;
}
/** Aggregated merge-receipt report across one or many repos. */
interface MergeReceiptsResult {
    /** ISO timestamp for the report. */
    generated_at: string;
    /** Per-repo reports in the order passed on `--repos`. */
    repos: RepoMergeReceipts[];
    /** Fleet-wide rollups driving the gate. */
    summary: {
        /** Total repos scanned. */
        total: number;
        /** Repos with at least one pending receipt. */
        with_pending: number;
        /** Total pending receipts across the fleet. */
        total_pending: number;
        /** Total reconciled receipts across the fleet. */
        total_reconciled: number;
        /** Repos whose merge driver is missing from clone-local git config. */
        missing_driver: number;
        /** Repos with no committed `.gitattributes` merge fence. */
        missing_fence: number;
        /** Repos whose driver commands do not match this installation (reported, not gated — upstream #773). */
        drifted_driver: number;
        /** Repos whose committed fence drifted from the active schema in either direction (reported). */
        drifted_fence: number;
        /** Repos whose fence leaves item paths UNCOVERED, so they fall back to git's line merge (gated). */
        unprotected_fence: number;
    };
}
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
/**
 * Render the merge-receipt report as a GitHub-flavoured markdown document: a
 * fleet summary table, a per-repo driver/fence status line, and one row per
 * receipt with its state, item id, repository-relative path, preferred side, and the
 * retained/discarded values for every scalar conflict decision.
 */
export declare function renderMergeReceiptsMarkdown(result: MergeReceiptsResult): string;
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
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
    activate(api: any): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map
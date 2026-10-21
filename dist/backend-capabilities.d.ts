/** Fixed audited read surface. Mutations are deliberately outside this contract. */
export declare const BACKEND_OPERATIONS: readonly ["list", "get", "schema"];
/** One audited SDK read operation. */
export type BackendOperation = typeof BACKEND_OPERATIONS[number];
/** Outcome distinguishes lack of support, transport failure and broken evidence. */
export type BackendCapabilityStatus = "supported" | "unsupported" | "unavailable" | "invariant_failed" | "unverified";
/** A provider must expose only side-effect-free reads; results cross an untrusted boundary. */
export interface BackendReadAdapter {
    /** Public, non-sensitive adapter label. */
    id: string;
    /** Storage implementation category, independent of transport. */
    kind: "directory" | "database" | "mcp";
    /** Declared support; missing operations are never invoked. */
    operations: readonly BackendOperation[];
    /** Execute a normalized read: list -> {items:[{id}],count,complete}; get -> {id}; schema -> {types:[string]}. */
    read: (operation: BackendOperation, id?: string) => Promise<unknown>;
}
/** Typed refusal with a safe remedy; raw exceptions and backend data are excluded. */
export declare class BackendReadRefusal extends Error {
    /** Classify the failed probe without parsing an exception message. */
    readonly status: "unavailable" | "invariant_failed";
    /** Construct a typed provider failure. */
    constructor(status: "unavailable" | "invariant_failed");
}
/** Invalid configuration is refused before any backend reads. */
export declare class BackendConfigurationRefusal extends Error {
    /** Stable input failure code. */
    readonly code: "invalid_adapter_ids" | "invalid_backend_config" | "invalid_backend_endpoint";
    /** Safe recovery instructions, excluding the supplied value. */
    readonly remedy: string;
    /** Build an actionable configuration failure. */
    constructor(code: BackendConfigurationRefusal["code"], remedy: string);
}
/** Compact, data-free evidence for one adapter and operation. */
export interface BackendCapabilityRow {
    /** Adapter label, never its connection string. */
    adapter: string;
    /** Storage category. */
    kind: BackendReadAdapter["kind"];
    /** Read contract that was audited. */
    operation: BackendOperation;
    /** Independent outcome. */
    status: BackendCapabilityStatus;
    /** Stable machine-readable refusal code, or verified. */
    code: "verified" | `backend_${Exclude<BackendCapabilityStatus, "supported">}`;
    /** Count of verified rows or schema types. */
    checked: number;
    /** Action to resolve a refusal. */
    remedy: string;
}
/** Agent-sized report containing three rows per configured adapter. */
export interface BackendCapabilityMatrix {
    /** Version of this report and normalized read contract. */
    version: 1;
    /** True only when every declared operation was verified. Unsupported declarations remain visible. */
    ok: boolean;
    /** Exactly one row per adapter/operation pair. */
    rows: BackendCapabilityRow[];
    /** Totals by outcome. */
    counts: Record<BackendCapabilityStatus, number>;
}
/** Audit every configured adapter using only its declared read ports, without returning tracker data. */
export declare function auditBackendCapabilities(adapters: readonly BackendReadAdapter[]): Promise<BackendCapabilityMatrix>;
/** Declarative CLI adapter configuration. Remote endpoints implement the normalized read bridge, not native SQL or MCP. */
export interface BackendAdapterConfig {
    /** Public adapter label. */
    id: string;
    /** Storage category. */
    kind: BackendReadAdapter["kind"];
    /** Directory tracker root, relative to the configuration file. */
    root?: string;
    /** HTTP read bridge URL; credentials must be supplied through its deployment, never URL userinfo. */
    endpoint?: string;
    /** Declared read support. */
    operations: readonly BackendOperation[];
}
/** Parse configuration without executing code or accepting ambiguous connection options. */
export declare function parseBackendConfig(value: unknown): BackendAdapterConfig[];
/** Audit configured adapters, removing disposable SDK cache snapshots even when reads fail. */
export declare function auditConfiguredBackends(config: readonly BackendAdapterConfig[], base: string): Promise<BackendCapabilityMatrix>;
/** Read a JSON adapter configuration relative to its own directory. */
export declare function auditBackendConfigFile(path: string): Promise<BackendCapabilityMatrix>;
//# sourceMappingURL=backend-capabilities.d.ts.map
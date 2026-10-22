/** Operational evidence freshness over core assurance receipts; no Git or writes. */
import { readFile } from "node:fs/promises";
import { getWorkspaceHistoryPath, listAssuranceVerdicts, readHistorySnapshot, validateAssertionDefinition, verifyHistoryRecordHash, WORKSPACE_HISTORY_ID, } from "@unbrained/pm-cli/sdk";
/** Safe actionable refusal, excluding paths, receipt content and raw backend errors. */
export class EvidenceExpiryRefusal extends Error {
    /** Stable machine-readable classification. */
    code;
    /** Safe next action. */
    remedy;
    /** CLI usage failures are distinct from unavailable evidence. */
    exitCode;
    /** Construct a refusal that agents can recover from without parsing raw exceptions. */
    constructor(code, remedy) {
        super(`${code}: ${remedy}`);
        this.name = "EvidenceExpiryRefusal";
        this.code = code;
        this.remedy = remedy;
        this.exitCode = code === "evidence_unavailable" ? 1 : 2;
    }
}
/** Narrow an untrusted value to an object. */
function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Public labels have bounded agent output and no filesystem semantics. */
function label(value) {
    return typeof value === "string" && /^[a-zA-Z0-9@][a-zA-Z0-9@._:/-]{0,127}$/.test(value);
}
/** Accept canonical UTC timestamps, refusing ambiguous dates and rollover. */
function instant(value) {
    return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
/** Validate version maps without inferring or normalizing exact identity strings. */
export function parseEvidenceVersions(value) {
    if (!record(value) || Object.keys(value).length > 100 || Object.entries(value).some(([key, version]) => !label(key) || typeof version !== "string" || !version.trim() || version.length > 128)) {
        throw new EvidenceExpiryRefusal("invalid_versions", "Provide an object of at most 100 public identity keys and nonempty exact version strings.");
    }
    return { ...value };
}
/** Validate attachment policy while delegating assertion scope semantics to the core SDK. */
export function parseEvidenceExpiryPolicy(value) {
    const refuse = () => { throw new EvidenceExpiryRefusal("invalid_policy", "Provide version 1, 1-1000 uniquely named claims with kind, exact receipt, core scope, positive max_age_seconds and nonempty captured versions."); };
    if (!record(value) || value.version !== 1 || !Array.isArray(value.claims) || value.claims.length < 1 || value.claims.length > 1000)
        return refuse();
    const ids = new Set();
    const claims = value.claims.map((claim) => {
        if (!record(claim) || !label(claim.id) || ids.has(claim.id) || typeof claim.kind !== "string" || !["health", "coverage", "recovery"].includes(claim.kind)
            || !record(claim.receipt) || !label(claim.receipt.gate_id) || !label(claim.receipt.assertion_id)
            || !label(claim.receipt.tree_id) || !instant(claim.receipt.evaluated_at)
            || !record(claim.scope) || typeof claim.scope.kind !== "string" || !["all", "active", "filter"].includes(claim.scope.kind)
            || (claim.scope.kind === "filter" && !label(claim.scope.measurement_id))
            || !Number.isSafeInteger(claim.max_age_seconds) || Number(claim.max_age_seconds) < 1
            || Number(claim.max_age_seconds) > 315_360_000)
            return refuse();
        let scope;
        let versions;
        try {
            scope = validateAssertionDefinition({ id: "expiry-scope", measurement_id: "expiry-scope", owner_item_id: "expiry-scope",
                scope: claim.scope, zero: true, enforcement: "block",
                negative_control: { cases: [{ observed: 0, expected: "pass" }, { observed: 1, expected: "fail" }] }, }).scope;
            versions = parseEvidenceVersions(claim.versions);
            if (Object.keys(versions).length === 0)
                return refuse();
        }
        catch {
            return refuse();
        }
        ids.add(claim.id);
        return { id: claim.id, kind: claim.kind, receipt: { ...claim.receipt },
            scope, max_age_seconds: Number(claim.max_age_seconds), versions };
    });
    return { version: 1, claims };
}
/** Scope comparison uses only the discriminants accepted by the core validator. */
function sameScope(left, right) {
    return record(right) && left.kind === right.kind && (left.kind !== "filter" || (right.kind === "filter" && left.measurement_id === right.measurement_id));
}
/** Safe remedies do not disclose backend data or filesystem locations. */
const REMEDIES = {
    fresh: "",
    evidence_missing: "Record accepted evidence and bind its exact identity; only the newest 1000 durable gate verdicts are searched.",
    evidence_unavailable: "Restore readable, sealed core assurance history on a stable snapshot, then retry.",
    receipt_not_accepted: "Rerun the operational check and persist a complete passing assertion with proven negative controls and a nonempty population.",
    scope_mismatch: "Collect evidence for the required core population scope and update the attachment.",
    version_unavailable: "Supply current identities for every version key required by this claim.",
    version_changed: "Revalidate this claim against its changed identities, then attach the new receipt and captured versions.",
    evidence_expired: "Rerun this operational check and attach its new receipt; do not extend an old receipt timestamp.",
    evidence_future: "Correct the evaluation clock or collect evidence with a valid timestamp.",
};
/** Evaluate one exact receipt; missing or non-passing evidence cannot be promoted by a version match. */
function evaluateClaim(claim, versions, receipts, now) {
    const row = { id: claim.id, kind: claim.kind, status: "unavailable", code: "evidence_missing", affected: [], expires_at: null, remedy: "" };
    const matches = receipts?.filter((receipt) => record(receipt) && receipt.gate_id === claim.receipt.gate_id && receipt.tree_id === claim.receipt.tree_id && receipt.evaluated_at === claim.receipt.evaluated_at);
    const gate = matches?.length === 1 ? matches[0] : undefined;
    const assertions = Array.isArray(gate?.assertions) ? gate.assertions.filter((assertion) => record(assertion) && assertion.assertion_id === claim.receipt.assertion_id) : undefined;
    const assertion = assertions?.length === 1 ? assertions[0] : undefined;
    if (receipts === null)
        row.code = "evidence_unavailable";
    else if (!gate || !assertion)
        row.code = "evidence_missing";
    else if (gate.dry_run !== false || gate.assertions_total !== gate.assertions.length || assertion.verdict !== "pass"
        || assertion.negative_control_proven !== true || !Number.isSafeInteger(assertion.population_size) || assertion.population_size < 1)
        row.code = "receipt_not_accepted";
    else if (!sameScope(claim.scope, assertion.scope))
        row.code = "scope_mismatch";
    else {
        const captured = Date.parse(gate.evaluated_at);
        const expires = captured + claim.max_age_seconds * 1000;
        row.expires_at = new Date(expires).toISOString();
        const keys = Object.keys(claim.versions).sort();
        const missing = keys.filter((key) => !Object.hasOwn(versions, key));
        const changed = keys.filter((key) => Object.hasOwn(versions, key) && claim.versions[key] !== versions[key]);
        if (missing.length) {
            row.code = "version_unavailable";
            row.affected = missing;
        }
        else {
            row.status = "revalidate";
            if (captured > now)
                row.code = "evidence_future";
            else if (changed.length) {
                row.code = "version_changed";
                row.affected = changed;
            }
            else if (now >= expires)
                row.code = "evidence_expired";
            else {
                row.status = "fresh";
                row.code = "fresh";
            }
        }
    }
    row.remedy = REMEDIES[row.code];
    return row;
}
/**
 * Evaluate caller-supplied durable receipts from any backend, without I/O.
 * The caller owns receipt authenticity; use auditEvidenceExpiry for a directory tracker.
 * null represents unavailable evidence and never an empty successful observation.
 */
export function evaluateEvidenceExpiry(policy, currentVersions, receipts, options = {}) {
    const parsed = parseEvidenceExpiryPolicy(policy);
    const versions = parseEvidenceVersions(currentVersions);
    const now = options.now ?? new Date().toISOString();
    const limit = options.limit ?? 20;
    if (!instant(now) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new EvidenceExpiryRefusal("invalid_options", "Use a canonical UTC ISO timestamp and an integer row limit from 1 through 1000.");
    }
    const rows = parsed.claims.map((claim) => evaluateClaim(claim, versions, receipts, Date.parse(now)));
    const counts = { fresh: 0, revalidate: 0, unavailable: 0 };
    for (const row of rows)
        counts[row.status]++;
    const ordered = [...rows.filter((row) => row.status !== "fresh"), ...rows.filter((row) => row.status === "fresh")];
    return { version: 1, ok: counts.fresh === rows.length, evaluated_at: now, total: rows.length, counts, rows: ordered.slice(0, limit), omitted: Math.max(0, rows.length - limit) };
}
/** Read core receipts and verify record envelopes through SDK primitives, refusing concurrent history changes. */
async function readEvidence(pmRoot) {
    try {
        const path = getWorkspaceHistoryPath(pmRoot);
        const before = await readHistorySnapshot(path, WORKSPACE_HISTORY_ID);
        for (const entry of before.entries.filter((entry) => entry.op === "assurance:gate:verdict")) {
            const integrity = verifyHistoryRecordHash(entry);
            if (!integrity.ok || integrity.coverage !== "record_and_item_state")
                return null;
        }
        const receipts = await listAssuranceVerdicts(pmRoot, { limit: 1000 });
        const after = await readHistorySnapshot(path, WORKSPACE_HISTORY_ID);
        return before.raw === after.raw ? receipts : null;
    }
    catch {
        return null;
    }
}
/** Evaluate a directory tracker with side-effect-free public SDK reads; works outside Git. */
export async function auditEvidenceExpiry(pmRoot, policy, versions, options = {}) {
    return evaluateEvidenceExpiry(policy, versions, await readEvidence(pmRoot), options);
}
/** Parse a JSON input without leaking paths or raw parser diagnostics. */
async function readInput(path, code) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        throw new EvidenceExpiryRefusal(code, "Provide a readable JSON input file matching the documented schema.");
    }
}
/** CLI-friendly file inputs; the selected tracker remains host-owned. */
export async function auditEvidenceExpiryFiles(pmRoot, policyFile, versionsFile, options = {}) {
    const policy = parseEvidenceExpiryPolicy(await readInput(policyFile, "invalid_policy"));
    const versions = parseEvidenceVersions(await readInput(versionsFile, "invalid_versions"));
    return auditEvidenceExpiry(pmRoot, policy, versions, options);
}
//# sourceMappingURL=evidence-expiry.js.map
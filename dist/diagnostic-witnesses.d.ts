import { type DiagnosticCommand } from "./diagnostic-plans.ts";
/** One explicit public input value, unique within its scope and key. */
export interface DiagnosticFact {
    /** Unique portable reference. */
    id: string;
    /** Exact public environment/snapshot identity; never inferred from tracker paths. */
    scope: string;
    /** Input name, such as sdk.actual or sdk.required. */
    key: string;
    /** Exact input text, preserved without whitespace normalization. */
    value: string;
}
/** A declared failure with alternative sufficient input sets, not a causal proof. */
export interface WitnessCheck {
    /** Affected check identity. */
    id: string;
    /** Declared failure class. */
    failure: string;
    /** Exact scope matching every referenced fact. */
    scope: string;
    /** Existing canonical read-only probe to reproduce the observation. */
    command: DiagnosticCommand;
    /** Observed failure or unverified explanation; neither means proven root cause. */
    diagnosis: "observed" | "unverified";
    /** Each nonempty clause declares all facts sufficient together, not independently. */
    sufficient: string[][];
}
/** Strict input contract, capped for exhaustive minimization. */
export interface DiagnosticWitnessInput {
    /** Contract version. */
    version: 1;
    /** One through sixteen explicit facts. */
    facts: DiagnosticFact[];
    /** One through sixty-four unique affected checks, each with at most eight alternatives. */
    checks: WitnessCheck[];
}
/** One common evidence set, retaining every affected check and its epistemic level. */
export interface DiagnosticWitness extends Pick<WitnessCheck, "failure" | "scope" | "diagnosis"> {
    /** Minimal sufficient clause selected for these checks. */
    facts: string[];
    /** Sorted affected identities; none are omitted. */
    checks: Pick<WitnessCheck, "id" | "command">[];
}
/** Compact self-contained evidence; ok denotes reduction success, not diagnostic success. */
export interface DiagnosticWitnessReport {
    /** Output contract version. */
    version: 1;
    /** The complete input was accepted and reduced. */
    ok: true;
    /** Sufficiency is caller-declared and never promoted to causal verification. */
    basis: "declared_sufficiency";
    /** Exact global minimum number of distinct retained facts. */
    minimal: true;
    /** Original fact count, including facts removed by reduction. */
    input_facts: number;
    /** Complete affected check count. */
    affected_checks: number;
    /** Exact number of input facts not needed by the selected clauses. */
    omitted_facts: number;
    /** Only selected facts; all exact values remain intact. */
    facts: DiagnosticFact[];
    /** Separate failure classes, scopes and diagnosis levels never coalesce. */
    witnesses: DiagnosticWitness[];
}
/** Data-free refusal with an actionable remedy. */
export declare class WitnessRefusal extends Error {
    /** Stable classification. */
    readonly code: "invalid_witness_input" | "witness_input_unreadable" | "invalid_witness_output";
    /** Recovery instruction. */
    readonly remedy: string;
    /** Input refusals are usage failures. */
    readonly exitCode = 2;
    /** Exclude raw input, paths and parser errors. */
    constructor(code: WitnessRefusal["code"], remedy: string);
}
/** One strict schema validates every entry path before reduction. */
export declare function parseDiagnosticWitnessInput(value: unknown): DiagnosticWitnessInput;
/** Check every emitted numeric field before ok, also usable by consumers validating transport counts. */
export declare function validateDiagnosticWitnessCounts(report: Pick<DiagnosticWitnessReport, "version" | "input_facts" | "affected_checks" | "omitted_facts">): void;
/** Find the exact minimum union of declared sufficient clauses; deterministic mask order breaks ties. */
export declare function reduceDiagnosticWitnesses(input: unknown): DiagnosticWitnessReport;
/** Read bounded JSON, then pass through the same strict SDK schema exactly once. */
export declare function readDiagnosticWitnesses(path: string): DiagnosticWitnessReport;
//# sourceMappingURL=diagnostic-witnesses.d.ts.map
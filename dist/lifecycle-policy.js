/**
 * The canonical fleet lifecycle-policy contract, and a drift checker for it.
 *
 * pm-cli 2026.9.9 shipped a declarative policy engine: item-level transition
 * rules declared as data and enforced at the SDK layer. Every policy is a
 * `require_fields` rule scoped to a set of types and statuses, carrying an
 * `effect` (`advise`, `warn` or `refuse`) and a human `description` that says
 * why the rule exists. The engine really blocks — under `enforcement: refuse`
 * a `pm close` that omits a required field exits 4 with
 * `workflow_policy_refused` — but only when a repository has actually declared
 * the policies. Measured on 2026-09-10, all 23 repositories in this fleet
 * returned `policies: []` and `enforcement: "advise"`, so `--check-completeness`
 * reported zero violations over 2,371 items: a gate that measures nothing,
 * not a gate that passes.
 *
 * This module publishes the single policy set every fleet repository is
 * expected to enforce, derived from the built-in presets plus two fleet
 * additions: a `completeness-milestone` rule (no preset covers Milestone) and a
 * blanket `fleet-closed-resolution` rule (the fleet's own contract that a
 * closed item carries a resolution, so the history stream records the outcome
 * rather than only that the item stopped being open). It also exports a pure
 * `verify` function that compares a repository's installed policy document
 * against the canonical set and reports drift: missing policies, extra
 * policies, policies whose rule, effect, subject or description differs, and
 * whether the enforcement mode is at the required level. The function owns no
 * I/O, so the drift rules are driven by the suite against fixtures rather than
 * only against this repository, which happens to satisfy them.
 *
 * @packageDocumentation
 */
/**
 * The canonical fleet lifecycle-policy contract.
 *
 * Each policy is derived from a built-in preset where one exists, and carries
 * `effect: refuse` so the engine blocks rather than warns. Two policies are
 * fleet additions: `completeness-milestone` (no preset covers Milestone) and
 * `fleet-closed-resolution` (the blanket fleet rule that a closed item carries
 * a resolution). The enforcement mode is `refuse` so the per-policy `refuse`
 * effects actually bite.
 */
export const CANONICAL_FLEET_LIFECYCLE_POLICY = {
    enforcement: "refuse",
    policies: [
        {
            id: "completeness-issue",
            effect: "refuse",
            description: "An issue records a defect or gap; closing it without reproduction steps and the expected behaviour leaves no way to tell a fix from a disappearance.",
            subject: { types: ["Issue"], statuses: ["closed"] },
            rule: { kind: "require_fields", fields: ["repro_steps", "expected_result"] },
        },
        {
            id: "completeness-feature",
            effect: "refuse",
            description: "A feature is a promise of behaviour; closing it without acceptance criteria and the expected result closes a promise that was never made testable.",
            subject: { types: ["Feature"], statuses: ["closed"] },
            rule: { kind: "require_fields", fields: ["acceptance_criteria", "expected_result"] },
        },
        {
            id: "completeness-task",
            effect: "refuse",
            description: "A task is a unit of work; closing one with no description leaves a completed item indistinguishable from one that was abandoned.",
            subject: { types: ["Task"], statuses: ["closed"] },
            rule: { kind: "require_fields", fields: ["description"] },
        },
        {
            id: "completeness-epic",
            effect: "refuse",
            description: "An epic spans many items; closing it without its goal, objective and body loses the reason the work was undertaken and the scope it covered.",
            subject: { types: ["Epic"], statuses: ["closed"] },
            rule: { kind: "require_fields", fields: ["goal", "objective", "body"] },
        },
        {
            id: "completeness-chore",
            effect: "refuse",
            description: "A chore is maintenance with no acceptance criteria; closing it without a description leaves no record of what was maintained.",
            subject: { types: ["Chore"], statuses: ["closed"] },
            rule: { kind: "require_fields", fields: ["description"] },
        },
        {
            id: "completeness-decision",
            effect: "refuse",
            description: "A decision is a commitment to a course; closing it without the body that presented the options and the resolution that chose one records that a decision happened, not what was decided.",
            subject: { types: ["Decision"], statuses: ["closed"] },
            rule: { kind: "require_fields", fields: ["body", "resolution"] },
        },
        {
            id: "completeness-milestone",
            effect: "refuse",
            description: "A milestone marks a point in time; closing it without a description and acceptance criteria makes a deadline that passed indistinguishable from one that was met.",
            subject: { types: ["Milestone"], statuses: ["closed"] },
            rule: { kind: "require_fields", fields: ["description", "acceptance_criteria"] },
        },
        {
            id: "fleet-closed-resolution",
            effect: "refuse",
            description: "A closed item carries a resolution so the history stream records the outcome, not only that the item stopped being open.",
            subject: { statuses: ["closed"] },
            rule: { kind: "require_fields", fields: ["resolution"] },
        },
    ],
};
/**
 * The canonical fleet policies as a standalone array, for callers that read
 * the policy list independently of the enforcement mode.
 */
export const CANONICAL_FLEET_POLICIES = CANONICAL_FLEET_LIFECYCLE_POLICY.policies;
/**
 * Compare two field lists as sets, so a reordering does not read as drift.
 *
 * `require_fields` is a set of required field names; the canonical order is
 * stable for human readers, but an installed document that lists the same
 * fields in a different order enforces the identical contract and must not
 * be reported as drift.
 */
function sameFields(installed, canonical) {
    if (installed.length !== canonical.length)
        return false;
    const sortedInstalled = [...installed].sort();
    const sortedCanonical = [...canonical].sort();
    return sortedInstalled.every((field, index) => field === sortedCanonical[index]);
}
/** Describe a policy's subject for a drift message. */
function describeSubject(subject) {
    const types = subject.types ? subject.types.join(",") : "*";
    return `types=[${types}] statuses=[${subject.statuses.join(",")}]`;
}
/** Describe a policy's rule for a drift message. */
function describeRule(rule) {
    return `${rule.kind}(${rule.fields.join(",")})`;
}
/**
 * Report drift between one installed policy and its canonical match.
 *
 * Only enforcement-relevant aspects — `effect`, `subject` and `rule` — produce
 * failures; a differing `description` is a documentation drift reported as a
 * failure too, because the description is the part a reviewer checks against
 * the rule, and a stale one is a contract that no longer explains itself.
 */
function policyDrift(installed, canonical) {
    const failures = [];
    if (installed.effect !== canonical.effect) {
        failures.push(`policy ${canonical.id}: effect is "${installed.effect}", canonical requires "${canonical.effect}"`);
    }
    if (installed.rule.kind !== canonical.rule.kind) {
        failures.push(`policy ${canonical.id}: rule kind is "${installed.rule.kind}", canonical requires "${canonical.rule.kind}"`);
    }
    if (!sameFields(installed.rule.fields, canonical.rule.fields)) {
        failures.push(`policy ${canonical.id}: rule fields are [${installed.rule.fields.join(",")}], canonical requires [${canonical.rule.fields.join(",")}]`);
    }
    const installedTypes = installed.subject.types;
    const canonicalTypes = canonical.subject.types;
    const typesDiffer = (installedTypes === undefined) !== (canonicalTypes === undefined) ||
        (installedTypes !== undefined &&
            canonicalTypes !== undefined &&
            (installedTypes.length !== canonicalTypes.length ||
                !installedTypes.every((t, i) => t === canonicalTypes[i])));
    if (typesDiffer) {
        failures.push(`policy ${canonical.id}: subject types [${installedTypes ? installedTypes.join(",") : "*"}], canonical requires [${canonicalTypes ? canonicalTypes.join(",") : "*"}]`);
    }
    if (installed.subject.statuses.length !== canonical.subject.statuses.length ||
        !installed.subject.statuses.every((s, i) => s === canonical.subject.statuses[i])) {
        failures.push(`policy ${canonical.id}: subject statuses [${installed.subject.statuses.join(",")}], canonical requires [${canonical.subject.statuses.join(",")}]`);
    }
    if (installed.description !== canonical.description) {
        failures.push(`policy ${canonical.id}: description differs from the canonical text`);
    }
    return failures;
}
/**
 * Compare a repository's installed policy document against the canonical
 * contract and report every drift.
 *
 * Drift is reported in four categories: a canonical policy the document does
 * not declare (missing), a policy the document declares that is not canonical
 * (extra), a policy whose rule, effect, subject or description differs, and
 * an enforcement mode below the required `refuse`. The comparison is pure: it
 * reads nothing from disk, so the rules are exercised by the suite against
 * fixtures rather than only against this repository.
 *
 * @param installed - The parsed `pm schema policies --json` result document.
 * @param canonical - The canonical contract to compare against; defaults to
 *   {@link CANONICAL_FLEET_LIFECYCLE_POLICY}.
 * @returns The drift report: `failures` for every divergence, `notes` for what
 *   was checked.
 */
export function verify(installed, canonical = CANONICAL_FLEET_LIFECYCLE_POLICY) {
    const failures = [];
    const installedById = new Map();
    for (const policy of installed.policies) {
        installedById.set(policy.id, policy);
    }
    const canonicalById = new Map();
    for (const policy of canonical.policies) {
        canonicalById.set(policy.id, policy);
    }
    if (installed.enforcement !== canonical.enforcement) {
        failures.push(`enforcement is "${installed.enforcement}", canonical requires "${canonical.enforcement}"`);
    }
    for (const canonicalPolicy of canonical.policies) {
        const installedPolicy = installedById.get(canonicalPolicy.id);
        if (installedPolicy === undefined) {
            failures.push(`missing policy ${canonicalPolicy.id}: ${describeSubject(canonicalPolicy.subject)} ${describeRule(canonicalPolicy.rule)} effect=${canonicalPolicy.effect}`);
            continue;
        }
        failures.push(...policyDrift(installedPolicy, canonicalPolicy));
    }
    for (const installedPolicy of installed.policies) {
        if (!canonicalById.has(installedPolicy.id)) {
            failures.push(`extra policy ${installedPolicy.id}: ${describeSubject(installedPolicy.subject)} ${describeRule(installedPolicy.rule)} effect=${installedPolicy.effect}`);
        }
    }
    const notes = [
        `ok - checked ${canonical.policies.length} canonical polic${canonical.policies.length === 1 ? "y" : "ies"} against ${installed.policies.length} installed`,
    ];
    return { failures, notes };
}
/**
 * Print a drift report and set a failing exit code when drift was found.
 *
 * @param drift - The drift outcome from {@link verify}.
 * @param write - Sink for the report lines.
 * @param exit - Called with the process exit code when there were failures.
 */
export function report(drift, write, exit) {
    for (const note of drift.notes)
        write(note);
    for (const failure of drift.failures)
        write(`FAIL - ${failure}`);
    if (drift.failures.length > 0) {
        write(`verify-lifecycle-policy: ${drift.failures.length} drift(s).`);
        exit(1);
        return;
    }
    write("verify-lifecycle-policy: the installed lifecycle policies match the canonical fleet contract.");
}
//# sourceMappingURL=lifecycle-policy.js.map
# Cheapest valid re-verification plans

`pm ops reverify` compiles an explicit check dependency/cost map against the
existing SDK-backed evidence-expiry evaluator. It selects an exact minimum-cost
approved set, including prerequisites. It neither executes checks nor persists
evidence. A selected check supports a claim only after a successful rerun and
attachment of a new accepted receipt.

```sh
pm ops reverify --input docs/examples/reverification.json \
  --policy docs/examples/reverification-policy.json \
  --versions docs/examples/evidence-versions.json --json
```

The CLI always replaces declared claim states with current expiry observations;
a missing attachment is unavailable. Its complete JSON/TOON packet contains an
input digest, costs, unique ordered steps and one row per target. No tracker
content or paths appear in the result. `ok` means every target is already fresh
or has a repair closure; inspect `rows[].code` before claiming freshness.
Unrepairable targets have `no_supporting_check`, `approval_required` or
`dependency_unavailable` and a remedy. Other repairable targets still receive
their cheapest plan. A successful planning command can return `ok: false`.

The strict version 1 contract accepts 1-32 unique claims, 1-16 unique targets
and 0-18 unique checks. Public ids contain 1-48 ASCII letters, digits, periods,
underscores, colons or hyphens, starting with a letter or digit. Arrays must be
dense, unknown properties refuse, and set-valued arrays cannot have duplicates.
Each check declares `approved`, `requires`, `supports` and an integer `cost`
from 0 through 1000000000. Costs use one caller-chosen unit, with no fractional
ratios or floating-point decisions. Missing, unapproved or cyclic prerequisites
make that closure unavailable. A fresh claim never needs a check just because
another claim is stale. These are evidence states, independent of native item
status registries or ambient session focus.

Every subset of the bounded catalog is considered, including shared dependency
costs. All additions stay at or below 18000000000, exactly representable by
JavaScript integers. Ties prefer fewer checks, then the first subset in the
ASCII-id-sorted catalog's increasing bitmask order. Dependencies precede their
dependents, and shared prerequisites appear once. `all_cost` counts every
executable approved check once, even if irrelevant; `saved` is its exact
difference from `cost`. Unapproved or unexecutable checks do not inflate the
baseline. Larger catalogs refuse with a remedy instead of silently switching
to an approximate algorithm. Independent subplans need independently reviewed
scopes; splitting a shared catalog is not a global optimality guarantee.

```ts
import { compileReverificationPlan, parseReverificationPlan }
  from "pm-ops/reverification-plans";

const input = {
  version: 1,
  claims: [{ id: "health", status: "revalidate" }],
  targets: ["health"],
  checks: [
    { id: "schema", approved: true, cost: 2, requires: [], supports: [] },
    { id: "items", approved: true, cost: 4,
      requires: ["schema"], supports: ["health"] }
  ]
};
const plan = compileReverificationPlan(input);
const transported = JSON.parse(JSON.stringify(plan));
parseReverificationPlan(transported, input); // same compiler, no alternate preview logic
```

The backend-neutral SDK compiler trusts the caller's evidence provenance and
declared check support. It does not authenticate receipts or prove that a
declared operational check establishes health, coverage or recovery. The CLI
and `auditReverificationFiles` use the existing canonical assurance-history
reader. Its before/after SDK reads detect history interleaving; this is an
observation, not isolation. Evidence can change after a read. Regenerate against
the current target revision before acting, and re-evaluate expiry after the
runner attaches new receipts. The input digest binds evidence classifications
and the complete declared map; it is neither an idempotency key nor proof of
current tracker revision.

Use the existing approved runner with `steps` in order. If a prerequisite fails
or is skipped, skip everything depending on it in that run. Catalog ids such as
`sdk:schema:v1`, `sdk:items:v1` and `sdk:history:v1` can be mapped to existing
`createDiagnosticPlan` failure selections and run with `executeDiagnosticPlan`,
under its normal reviewed scope, selection and budgets. This compiler grants
no execution permission and adds no runner, scheduler, journal or assurance
store. Arbitrary ids describe checks in the caller's existing runner; they are
never interpreted as commands. The integration test dispatches three existing
catalog probes with one shared schema prerequisite exactly once.

The documented fixture selects schema plus one combined check for cost **6**,
versus **16** for all executable approved checks. Removing the combined check
selects both independent checks and charges schema once, total **12**. Tests
also cover unavailable targets, zero-cost checks, exact one-unit boundaries,
the maximum catalog, prototype-shaped ids, stale artifact refusals and 500
seeded operation sequences against an independent BigInt/set oracle. Every
transport path is exercised with old replays and JSON/TOON/CRLF variants while
native fields and relationships are read back through `PmClient` unchanged.
There is no native import/export/sync or mutation/recovery path to test.

Run targeted verification with:

```sh
npm run build && npm run build:test
node --test --test-concurrency=2 test/reverification-plans.test.ts
node test/reverification-public.acceptance.ts PUBLIC_TRACKER_COPY
node test/compatibility-packed.acceptance.ts
```

The public acceptance script changes permissions only on its own disposable
copy, runs the real SDK/diagnostic catalog and reports aggregate measurements.
No-git execution is supported; the planning path never invokes Git.

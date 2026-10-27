# Compatibility explanation validation

Tracked by [ops-compatibility-reasons](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/features/ops-compatibility-reasons.toon).

Overlap was rechecked against core's public SDK and the sibling starter, preset
and backend reporting paths. Version status/outdated reports and backend operation
matrices do not solve joint constraints. Diagnostic witness reduction consumes
explicit sufficient fact clauses without evaluating versions. The extension
authoring SDK's `checkExtensionManifestCompatibility` shares its implementation
with the admission loader; native bound explanations use that API. Dependency
range satisfaction uses npm semver, without duplicating tracker state logic.

## Public data

The public export is from pm-ops main commit
`75da19b971056765bb39bd18c7f17116bd281bc7`, package `2026.10.26`, host development pin `2026.10.20`.
Only the tracked public tracker, package metadata and manifest were exported.
The export was outside Git with all write permissions removed. Backend SDK reads
used the existing isolated snapshot adapter; the compatibility explanation itself
opens no tracker. Byte fingerprints before and after match across the entire export.

| Measurement | Result |
| --- | ---: |
| SDK complete list | 160 items |
| SDK canonical get | 1 item |
| SDK configured schema | 11 types |
| Package/host components | 2 |
| Joint peer/extension declarations | 2 |
| Compatible / incompatible / unknown target rows | 1 / 0 / 0 |
| JSON / TOON bytes | 847 / 887 |
| Source bytes changed | 0 |

Reproduce with `node test/compatibility-public.acceptance.ts PUBLIC_EXPORT`, where
`PUBLIC_EXPORT` is an independently exported public package directory containing
`.agents/pm`, `package.json` and `manifest.json`. Never supply a live private tracker.

## Regression scope

`node --test --test-concurrency=2 test/compatibility-reasons.test.ts test/compatibility-ranges.test.ts test/compatibility-evidence.test.ts` passes 14/14,
without failures, cancellations, skips or TODOs. The new production module measures
100% statements, branches, functions and lines. The seeded model runs 500 sequences
of six operations, including old input replay, version/range changes, CRLF and
whitespace, JSON/file/TOON paths, exact-version unions and exhaustive independent
minimum-conflict checks. After every sequence it reads every seeded item back
through the SDK and compares all native fields and relationships with the original
SDK-read state. Every production evaluation preserves the tracker fingerprint;
SDK cache maintenance is outside that observational boundary.

The three-pin fixture is pairwise satisfiable with an empty joint intersection.
Removing any one of its three minimum witnesses yields the exact compatible range.
Other tests cover known observed pin failures, capability gaps, isolated unknown
metadata, native inclusive bounds and invalid bounds, cyclic/transitive chains,
prototype-shaped ids, sparse arrays, extreme numbers, finite output counts and
semver prerelease boundaries. Wide unions retain one exact conjunction instead
of emitting more than 16 expanded alternatives; the maximum 256-combination input
exercises this compact form. The actual CLI runs outside Git with an empty PATH,
so it cannot invoke Git. Both output formats round-trip without the host's table
flattening of nested capability arrays. The three-pin example measures 933 JSON
bytes and 1007 TOON bytes. Another 500 seeded patch-interval cases verify exact
inclusive/exclusive boundaries, including maximum-safe version segments.

There are no tracker import/export/sync mutations, journaled plans, idempotency
keys, leases, outboxes, status decisions or create/update operations in this
feature. Concurrent invocations share no writable feature state. Its only input
file read uses the existing bounded regular-file descriptor guard. Suggested
commands are literal read-only argv previews and are never executed.

The expanded packed acceptance passes all 6 launch modes, 108 JSON/TOON checks and
4 installed SDK consumers with 36 SDK cases using isolated Bun 1.4.4. The branch
incorporates main's 2026.10.27 release metadata and SDK 2026.10.24 pin.

The packed acceptance script uses isolated installations and exercises npm global,
Bun global, npm project-local, Bun project-local, npx and bunx, both JSON and TOON,
plus the installed typed SDK entrypoint with native manifest checks. Native SDK
acquisition is lazy and resolves the public authoring export from the installed
package graph, independent of executable paths. A real unsupported Node loader
configuration returns a typed SDK refusal and remedy. CI runs it after both release gates.
Full-package npm/Bun release counts and behavioral revert evidence are recorded
in the linked pm item and PR; coverage/duplication thresholds remain unchanged.


Global activation uses core's supported packed archive installer. A directory
snapshot outside npm's global discovery graph can omit dependency resolution for
an external Bun global package. This existing host UX limitation is retained in
[ops-global-activation-ux](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-global-activation-ux.toon).
The global fixtures verify that the install leaves the project package metadata
unchanged; the feature command itself performs no install or configuration edit.
The no-Git CLI regression includes native manifest checks with an empty PATH.

Current focused compatibility tests pass 14/14 with no failures, cancellations
or skips; the compatibility module measures 100% in all four coverage dimensions.
Build and test typecheck pass. Renderer ownership passes 7/7 and the installed CLI
routing check passes 1/1. The artifact-reader test retains its five-second child
deadline; import-only startup took 13.721 seconds under host load, exceeding that
deadline before any input read. The related timing receipt is on
[ops-gp0d](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-gp0d.toon).
No timeout, test assertion or quality threshold was relaxed.
Full npm/Bun gate URLs and exact final counts belong to the pm item and PR.
Greptile reports an expired trial, which provides no review approval.


## Re-review: derived version representation

The re-review finding exposed a class of errors: constructing a successor string,
discarding it when semver rejects it, then treating the remaining candidate list
as proof that the range is empty. The solver no longer constructs version probes.
It uses semver comparator sets and library operations for every joint decision,
validates every library-produced version, and preserves any rejection as typed
`unrepresentable_range` evidence naming the original range/conjunction. The same
evaluator serves minimum conflict reduction, the SDK and CLI; unknown range
metadata fails independently from other target rows.

The package-wide audit found no other joint-range probe producers. Calendar tag
formatting in `release-completeness.ts` and existing-tool major detection in
`duplication.ts` are not joint-range probes and remain unchanged. Native manifest
bounds still use the host SDK's authoritative checker.

The additional seeded property test compares 500 random range pairs against a
brute-force corpus with maximum-length prerelease tags and valid observed
witnesses. Separate cases verify named conservative results for invalid
prereleases, numeric overflow and an unrepresentable derived minimum. Library-only
inference tests preserve prerelease admission without an installed witness. The
same validated minimum producer checks both conjunctions and individual
comparators, including a strict prerelease successor hidden behind a stable lower
bound. Function-only reverts of the former string-probe solver and of this
comparator-minimum check each fail the seeded property test; restoring each fix
passes all 500 pairs. The same adversarial packets run through JSON/TOON in
non-Git trackers with no Git executable, all six packed launch modes, and four
installed SDK consumers. This finite corpus is regression evidence on its stated
versions, not an exact oracle for arbitrary semver ranges.
The full test runner now explicitly uses at most two workers; coverage and
all other quality thresholds are unchanged.

The corrected source/main-merge CI run remained queued through the 30-minute
observation limit: [CI run 40517724020](https://github.com/unbraind/pm-ops/actions/runs/40517724020).
Completed npm/Bun release gates at that receipt: 0/4; fresh full-suite counts were
unavailable. The latest head and any later CI status are reported on the PR.

## Monotonic evidence during reduction

An optional refinement must not erase a proven result. Intersection evidence is
tri-state: a known empty domain, a known nonempty expression, or undecided. A
refused OR branch cannot erase a positive branch, and an empty branch cannot
turn an undecided alternative into a contradiction. Subset reduction isolates
refusals, continues searching, and retains the full-set contradiction as its
fallback. An undecided full set can still yield a proven conflicting subset.
`minimum_unproven: true` distinguishes a proven witness from a globally certified
minimum when smaller subsets remain undecided. Typed subset refusals remain
visible alongside the conflict and are bounded to one per declaration in reduction.

The new 500-sequence property has an independent exact bit-set oracle over its
explicit finite-pin grammar. Every finite constraint restricts versions to three
declared stable literals; added noise admits all three, with explicit positive
certificates even for noise-only subsets. Thus every subset's satisfiability and
minimum cardinality are exactly enumerable on this domain. Sequences add noise,
permute declarations, round-trip JSON/TOON/CRLF and replay older packets. They
retain the proven conflict and check the emitted witness against the oracle.
Additional cases cover empty singletons, mixed unknown/empty alternatives,
independent capability conflicts and a rejected library boundary before branches.

The package-wide audit also inspected diagnostic witness reduction, backend
capability aggregation, diagnostic plans and CLI rendering. The witness reducer
operates on validated bit masks without fallible probes; backend and plan failures
remain local to their operation/step. CLI and packed SDK paths use the same
compatibility evaluator. No additional substantive review findings were present.

Round 2 focused validation passes 14/14 at unchanged per-file 100% coverage
thresholds. Both the minimum-reduction and OR-branch function-only reverts fail
0/1 and pass 1/1 after restoration in disposable non-Git copies. The linked new
regression file also passes 3/3. Build, test typecheck, typecheck, lint, zero
duplication (114 sources / 33221 lines) and documentation (323 declarations /
40 files) pass. Packed and exact-head full-gate receipts are linked on the pm item
and PR; no queued check counts as a pass.

Round 2 packed acceptance passes through the linked pm test: six launch modes,
108 JSON/TOON checks and four installed SDK consumers / 36 SDK cases. Strict
clean-home health exits zero with ten passing checks and one advisory; the
production dependency audit reports zero vulnerabilities. The original three-pin
example remains 933 JSON / 1007 TOON bytes.

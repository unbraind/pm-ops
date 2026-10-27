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

`node --test --test-concurrency=2 test/compatibility-reasons.test.ts` passes 7/7,
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
semver prerelease boundaries. The actual CLI runs outside Git with an empty PATH,
so it cannot invoke Git. Both output formats round-trip without the host's table
flattening of nested capability arrays. The three-pin example measures 933 JSON
bytes and 1007 TOON bytes. Another 500 seeded patch-interval cases verify exact
inclusive/exclusive boundaries, including maximum-safe version segments.

There are no tracker import/export/sync mutations, journaled plans, idempotency
keys, leases, outboxes, status decisions or create/update operations in this
feature. Concurrent invocations share no writable feature state. Its only input
file read uses the existing bounded regular-file descriptor guard. Suggested
commands are literal read-only argv previews and are never executed.

The packed acceptance script uses isolated installations and exercises npm global,
Bun global, npm project-local, Bun project-local, npx and bunx, both JSON and TOON,
plus the installed typed SDK entrypoint with native manifest checks. Native SDK
acquisition is lazy and resolves the public authoring export from the installed
package graph, independent of executable paths. A real unsupported Node loader
configuration returns a typed SDK refusal and remedy. CI runs it after both release gates.
Full-package npm/Bun release counts and behavioral revert evidence are recorded
in the linked pm item and PR; coverage/duplication thresholds remain unchanged.

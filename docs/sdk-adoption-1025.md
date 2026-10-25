# SDK corpus reads for backend assurance and diagnostics

Tracked by [ops-sdk-adoption-1025](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-sdk-adoption-1025.toon), following the canonical-read adoption in [ops-3w9m](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-3w9m.toon).

| Audit finding | Replacement | Safety evidence |
| --- | --- | --- |
| `backend-capabilities.ts:205-216`: hand-built list/get envelopes | `PmClient.listAllComplete()` certifies the corpus; `PmClient.get()` selects canonical identity. The existing bridge only translates these results into its stable transport shape. | Source snapshot isolation, no-Git execution, byte fingerprints, parsing refusals, fresh get after list. |
| `diagnostic-probes.ts:41-57`: local folder enumeration and document parsing for counts | `listAllItemMetadata()` reads an isolated item snapshot and supplies diagnostic rows/counts. | Independent physical scope/count and UTF-8 checks; `scanItemFormatVersions()` preserves unsupported-version refusals; direct source document/history verification remains mandatory. |

Both findings are replaced. No SDK dependency pin bump or missing SDK API is required. The peer and manifest admission floor now match the existing tested SDK pin, 2026.10.20, so older hosts cannot load code requiring the complete-list API. The remaining filesystem walk inspects raw scope and copies bytes; it does not parse documents or decide the normalized item count. Comparing physical count with SDK row count prevents normalization from silently hiding duplicate documents. SDK caches are confined to disposable copies. Source trackers remain observational even when read-only and outside Git with no Git executable.

`sdk:history:v1` still calls `readHistorySnapshot()` and `verifyHistoryEntries(entries, document)` against freshly read authoritative source documents. Cached metadata or event-index rows never establish history validity. The regression primes both SDK caches, corrupts `after_hash`, and requires rejection without source writes. Removing only the verification condition makes that test fail with a missing rejection.

## Differential proof

The baseline is the built `origin/main` commit `2f28e15eba49a6883faca49d1ae4dcfab767a818`. Public tracker fixtures were exported from that same pm-ops commit and pm-context commit `9068fb15ae8c0fd03aa004e00e8e6341af8387cb`. No tracker content is committed as a fixture.

`test/sdk-adoption.differential.ts` copies each supplied tracker into a non-Git temporary directory, removes write permissions, runs both built implementations with an empty `PATH` and Git ceiling, compares the complete backend matrix and three diagnostic results, and fingerprints every source byte. Run it with the baseline build and public tracker export roots as positional arguments:

```sh
node test/sdk-adoption.differential.ts "$BASELINE_BUILD" . "$OPS_TRACKER" "$CONTEXT_TRACKER"
```

| Public tracker | Backend list / get / schema counts | Diagnostic schema / items / history counts | Result |
| --- | --- | --- | --- |
| pm-ops | 154 / 1 / 11 | 11 / 154 / 2086 | Identical; all source bytes unchanged |
| pm-context | 92 / 1 / 11 | 11 / 92 / 1040 | Identical; all source bytes unchanged |

Eight complete results match across 246 items and 3126 history entries. There are no differences on these public trackers. Invalid item documents encountered by canonical backend get now report `invariant_failed` rather than the previous generic `unavailable`; transport errors remain `unavailable`. History diagnostics now refuse an item whose metadata identity has no canonical physical location, using SDK `locateItem` before authoritative verification. Raw diagnostic parser failures now use the data-free `items_invalid` refusal; the public diagnostic receipt remains `probe_failed` with zero checked items. These are intentional SDK refusal classifications, exercised separately with synthetic corrupt input.

## Behavioral revert proofs

Each proof restores only the replaced function and necessary imports/signature adaptation, leaving the new tests and surrounding code unchanged; the candidate is restored afterward.

- Restore baseline `directoryRead`: `node --test --test-name-pattern 'canonical get classifies' test/backend-capabilities.test.ts` fails 0/1, because malformed authoritative bytes after list are reported as generic unavailability instead of failed integrity.
- Restore baseline `readItems`: `node --test --test-name-pattern 'history refuses SDK identities' test/diagnostic-plans.test.ts` fails 0/1 with a missing rejection, because it trusts a document whose metadata identity has no canonical source location. The separate SDK-enumeration refusal regression also fails 0/1 under this revert.
- Remove only `verifyHistoryEntries(...).ok`: `node --test --test-name-pattern 'history verification detects corruption' test/diagnostic-plans.test.ts` fails 0/1 with a missing rejection after both SDK caches are primed.

With the implementation restored, the focused suite passes 31/31 with no failures, cancellations, skips or TODOs, including through `pm test ops-sdk-adoption-1025 --run --progress`. Dependency and manifest compatibility tests pass 8/8. The two changed production modules measure 100% statements, branches, functions and lines. Typecheck, test typecheck, lint, duplication and docstring checks pass. Full release-gate receipts belong to the PR checks for the reviewed commit; coverage thresholds remain 100% in every dimension. Two existing opt-in real-data checks require separately configured live fleet checkouts and are skipped by the default release suite; they are not claimed as verified here.

The clean-home local `npm run release:check` also passes: 1456 passing tests, zero failures, two opt-in skips, and 100% in every coverage dimension across all 38 measured source files. It runs with an empty temporary home and `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1` to reproduce CI identity isolation. Production audit, package dry-run, changelog and release/lifecycle checks pass. The PR's npm/Bun CI checks provide the hosted full-gate evidence.

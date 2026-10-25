# Public tracker validation

Source: the public `unbraind/pm-ops` tracker at
`11607ad5e9f5a841768a8e47bb91b0970c38091d`, exported from Git into a plain
scratch directory. Only the exported copy was inspected; it was made read-only,
with a Git discovery ceiling above the scratch directory. No repository, hosted
data, credentials or operational logs were used as a test backend.

Run `node test/diagnostic-witnesses.acceptance.ts <public-tracker-snapshot>`.
The script copies the snapshot again, makes that owned copy read-only, runs the
existing canonical probes, checks complete file fingerprints, and removes only
its own scratch copy afterward. SDK probes use their existing disposable cache
isolation and an empty executable PATH. The reducer performs no subprocess I/O.

| Measurement | Result |
| --- | ---: |
| Public tracker files | 318 |
| Verified schema types | 11 |
| Verified items | 155 |
| Verified history entries | 2,104 |
| Controlled failure runs | 6 |
| Affected checks retained | 6 of 6 |
| Checks sharing the common witness | 5 |
| Distinct witnesses | 2 |
| Explicit facts / distinct retained facts | 3 / 3 |
| Expanded per-check evidence JSON | 2,024 bytes |
| Fact/check selection JSON | 1,262 bytes |
| Reduced JSON | 931 bytes |
| Reduced TOON | 797 bytes |
| Byte identity of every source-copy file | unchanged |
| Identical output on replay | yes |

Five canonical SDK item probes receive a process ceiling of zero and report
`process_budget`. An independent canonical registry probe receives a network
ceiling of zero and reports `network_budget`, without issuing an HTTP request.
The declared sufficient clauses retain the respective exhausted ceiling and the
shared deadline. They reduce to two witnesses with five and one affected checks.
This is a controlled failure exercise over real public data, not evidence that
the public tracker has an incompatible SDK or broken history. Its normal schema,
item and history probes all passed. JSON is 54.0% smaller than expanded repeated
per-check evidence; TOON is 60.6% smaller. These are byte measurements, not model
token counts or general compression guarantees.

The incompatible-SDK acceptance case is separately synthetic: five failing
checks span the canonical schema/items/history commands, declare the same two
sufficient version facts, and retain one witness with all five affected checks.
An irrelevant third fact is removed. Diagnosis stays `unverified`. Additional
cases keep independent scopes, classes, diagnoses and sufficient sets separate.

The seeded property regression runs 500 sequences of eight operations each,
including replay of older selections, changed explicit facts, changed sufficient
clauses, changed class/diagnosis, JSON/TOON round trips and CRLF/whitespace. An
independent exhaustive set model checks the minimum fact count and every
affected check. The fixture contains real SDK-created native records, a parent
relationship and exact text; every sequence compares records read back through
the SDK with the initial state and fingerprints tracker bytes around reducer
operations. SDK read caches are outside those reducer byte intervals. There is
no native record import/export/sync path or mutable reducer state.

Sparse arrays, unknown keys, dangling references, causal upgrades, malformed
UTF-8/JSON, oversized files and extreme numeric inputs/outputs refuse. The
maximum 16-fact, 64-check selection remains complete with finite counts. The
installed pinned CLI agrees with the SDK in JSON and TOON outside Git with no
Git executable. Source-only negative controls independently disable the minimum
search and common-witness grouping; the acceptance regression fails in both
cases, and the original source is restored byte-for-byte.

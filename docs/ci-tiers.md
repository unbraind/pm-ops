# CI tiers

Required checks remain `test (22)` and `test (26)`. PRs and dispatch run on
GitHub-hosted Ubuntu with quick deterministic depth and a 30-minute ceiling.
Superseded PR runs cancel across all jobs. Extra platform jobs keep their names.

| Check | Code PR 22 | Code PR 26 | Docs/tracker PR | Deep |
| --- | --- | --- | --- | --- |
| npm ci, pinned npm 11.21.0 | yes | yes | yes | all four legs |
| Strict pm health / merge drivers | — | yes | both required checks | all four legs |
| Build, build:test, tests | quick | quick coverage | applicable docs tests | full |
| Typecheck, lint, duplication, docstrings | — | yes | — | full gate |
| Coverage: 100% statements/lines/branches/functions | — | quick | — | full |
| Production and release-tool audits | — | yes | — | full gate |
| Pack file list / dry-run | — | yes | both | full gate |
| Changelog, sections, date, publish attestation | — | yes | both | full gate |
| Lifecycle policy / tracker schema | — | yes | both | full gate |
| Identity audit, reusable permission docs, release docs contracts | suite | suite | both | full suite |
| Private provenance runtime | release-lock floor | yes | — | all four legs |
| Compatibility packed npm/Bun local/global/npx/bunx | — | yes | both (docs example input) | all four legs |
| Bun graph install smoke | — | yes | — | all four legs |
| Windows consumers: pack prepare, native npm/Bun, runtime, proof history, refusal proofs | separate Windows 22/26 jobs | same | skipped | retained PR platform contract |
| Both committed release locks, exact npm install, strict floor engines | separate release-lock 22.18.0/26 | same | skipped | retained PR install contract |
| CodeQL | separate workflow | separate workflow | filtered | weekly scan + matching main pushes |

The docs path includes changelog, identity, lifecycle policy, publish attestation,
pack file-list and documentation consumers. The compatibility acceptance reads
`docs/examples/compatibility.json`, so it also runs on docs changes with Bun
available; this applicable packaging gate is intentionally more expensive. Executable tracker files select code.
Windows and lock jobs perform checkout/detection only on docs changes. Their
assertions retain exact engine floors, install ordering and native contracts.

Deep runs main pushes, dispatch and daily at 02:11 UTC, separate from release
and weekly CodeQL. Four jobs `deep (22, npm)`, `deep (22, bun)`,
`deep (26, npm)`, `deep (26, bun)` each run one original full release gate.
Each has a 120-minute ceiling, per-ref cancellation, full depth and time scale 3.
The local pool is selected unless `PM_LOCAL_DEEP=off`; its persistent npm cache
and preinstalled Bun avoid redundant WAN downloads. Hosted fallback uses setup
Bun and npm cache restoration. The Bun version is always logged.

Unset depth retains all 500 cases. Quick retains the first 50 without changing
seeds, assertions, or coverage thresholds. Watchdogs use validated positive finite
scales and integer milliseconds; product deadlines remain unchanged. Linear-time
parser regression harnesses have scaled budgets for slow instrumented hardware.
Compatibility packed acceptance explicitly proves Bun local/global and bunx paths,
so the quick tier needs only a Bun graph install smoke after npm's gate.

The previous PR tier ran four full release gates (two Node versions, npm and
Bun). Owner fleet measurements were 39,929 runner-minutes/day and 45–90 minutes
PR wall time including about 28 minutes queueing. The successful main run
43729447430 required the logs archive API after the CLI returned no content.
Its slowest tests were real tarball mutation fuzz (42.2 s), installed CLI
routing (27.2 s), publish indirection (26.6 s), and the 500-case witness
sequence (26.3 s). The quick witness sequence measured 13.2 s on this host;
these are individual test durations on different hosts, not a gate speedup.
Full depth is deliberately not run on the overloaded development host. New PR
wall time and quick coverage are recorded separately in the tracker/PR when available.
The reusable daily release and release caller/verifier files are unchanged.

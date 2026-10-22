# Evidence expiry validation

Public tracker source: `unbraind/pm-ops`, main commit
`3546c385e30d9914ab8a5690ccee7842ca38a7d9`.

The validation exported only tracked `.agents/pm` files from that commit using
`git archive`, extracted them into a disposable directory without `.git`, and
read registered item metadata through the pinned SDK. After inventory reads,
all snapshot files became read-only and directories became non-writable. The
expiry audit evaluated the three documented example attachments, first with the
example current identities and then with all three relevant identities changed.
An aggregate SHA-256 fingerprint over relative file names and bytes matched
before and after evaluation. Git was used only to export the public snapshot;
the operational audit itself never invokes it.

| Measurement | Result |
| --- | ---: |
| Public work items | 148 |
| Represented item types | 6 |
| SDK inventory warnings | 0 |
| Snapshot files including disposable SDK inventory caches | 309 |
| Recorded core assurance verdicts | 0 |
| Claims evaluated | 3 |
| Fresh / revalidate / unavailable | 0 / 0 / 3 |
| Same counts after changing all relevant identities | 0 / 0 / 3 |
| Compact JSON report size | 882 bytes |
| Tracker byte changes during evaluation | 0 |

Every example attachment reported `evidence_missing`. The public tracker has no
recorded core gate verdicts, so it cannot establish operational health, coverage
or recovery. Version changes never turned absent evidence into a pass. Positive
selective-invalidation evidence comes separately from real disposable trackers
initialized with the pinned CLI, core declaration bundles, SDK gate evaluation
and sealed durable verdict writes. These synthetic controls exercise policy
semantics; they do not certify the fleet's operational readiness.

Targeted tests cover selective package and backend invalidation, exact receipt
selectors, all/active/filtered population scopes, TTL boundaries, future time,
missing identities, absent/failed/retired/projected/empty-population receipts,
invalid input refusals, record tampering, changing history during reads, bounded
agent output and CLI rendering. SDK evaluations compare all tracker bytes and run
with no Git executable available and a Git discovery ceiling. The installed CLI
also runs in a plain tracker with Git absent from PATH.

Behavioral revert proof (source restored immediately after each check):

- Replacing the changed-version branch in `evaluateClaim` with a fresh result
  makes the package/backend selective-invalidation regression fail: 0 pass,
  1 fail, exit 1.
- Bypassing the record-integrity refusal in `readEvidence` makes the tampered
  history regression fail: 0 pass, 1 fail, exit 1.

The focused coverage run over `evidence-expiry.ts` measures 100% statements,
branches, functions and lines. Full package release evidence comes from the
unchanged npm and Bun CI gates, including their normal coverage, duplication,
docstring, audit, pack and changelog checks; see the PR for the exact run and
counts.

Implementation CI: [run 39813347953](https://github.com/unbraind/pm-ops/actions/runs/39813347953),
commit `f0b17f3f0dc9e9c80938478692bfa419b86414db`. All four CI jobs passed,
including both Windows consumer jobs. Each of the four npm/Bun release gates
(Node 22 and 26) reported **1410 tests, 1408 passed, 0 failed, 2 skipped**,
with **100% statements, branches, functions and lines over 32 sources**.
The skips are the existing opt-in configured-repository scan and second-repository
release checks; they are unavailable evidence, not passes. This feature's
18 targeted tests have zero skips, and its public tracker validation above was
run explicitly. The PR records the gate URL for the final evidence-only commit.

## Portable no-Git probe review regression

Review thread `PRRT_kwDOTOTl1M6vVDtP` identified a raw absolute ESM specifier in
`test/evidence-expiry.test.ts`. The probe now imports through a file URL. Its real
temporary entry filename includes a space and `#`, exercising URI escaping on
POSIX as well as avoiding drive-letter URL schemes on Windows. The audit call,
tracker arguments, Git-free PATH and byte-preservation assertions are retained.

Reverting only `pathToFileURL(probeEntry).href` to the raw `probeEntry`, while
keeping the new fixture and assertions, fails the focused no-Git test with
`ERR_MODULE_NOT_FOUND`: 0 passed, 1 failed, exit 1. Restoring the conversion passes:
1 passed, 0 failed, zero skips. The other generated ESM shim in the PR already
uses a file URL; Node entrypoint and filesystem path arguments remain paths.

Review-fix CI at `87c8dacb7c409f6d7134bccbc8739bbeddd8f51d`:
[run 39837214110](https://github.com/unbraind/pm-ops/actions/runs/39837214110)
passed all four jobs after a failed-job-only retry of Windows 22. Each npm and
Bun release gate on Node 22 and 26 measured 1410 tests: 1408 passed, 0 failed,
2 existing opt-in skips, with four 100% coverage dimensions across 32 sources.
The initial Windows 22 failure was the existing `ops-ilcm` packed-install null
status at its 180-second timeout site; the identical-head retry passed without
changing code, timeouts or assertions. Local linked suites passed 18/18 with no
skips or timeouts. Rebuilt tracked `dist/` remained byte-identical. The PR records
the exact CI run for the final evidence-only commit.

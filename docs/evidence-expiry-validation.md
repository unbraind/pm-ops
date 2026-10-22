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

# Re-verification validation

Public source: `unbraind/pm-ops` main at
`ba05bb8b96b313b86d25896ef40880712f295881` (2026.10.28-1).
Only the committed public tracker was exported. Validation copied it into an
owned non-git temporary directory, made that copy read-only and restored its
permissions in `finally` before cleanup. The original tracker was not opened
for writes. The new planner adds no network calls or Git subprocesses.

| Measurement | Result |
|---|---:|
| SDK-certified complete items | 162 |
| Files fingerprinted | 332 |
| Existing schema probe: registered types | 11 |
| Existing item probe: items checked | 162 |
| Existing history probe: entries checked | 2296 |
| Declared target claims | 2 |
| Selected checks / actual existing-runner processes | 3 / 3 |
| Shared schema prerequisite occurrences | 1 |
| Selected integer cost | 6 |
| Every executable approved check: integer cost | 26 |
| Saved integer cost | 20 |
| Explicit unrepairable target gaps | 0 |
| Claims still requiring new accepted receipts | 2 |
| JSON / TOON output bytes | 868 / 830 |
| Repeated plan identity | Identical |
| Tracker bytes after validation | Unchanged |

Costs are caller declarations in one integer unit, not measured durations.
The two selected targets lack the example's exact accepted receipt identities;
they remain conditional even though the actual diagnostic reads passed.
This validates selection, runner handoff and read-only behavior on real data.
It does not certify operational health, coverage or recovery.

Reproduce with an exported public tracker:

```sh
node test/reverification-public.acceptance.ts PUBLIC_TRACKER_COPY
```

The synthetic accepted-receipt fixture separately proves expiry boundaries and
the CLI's refusal to trust caller-declared freshness. The 500 seeded sequences
contain 3000 operations, including older-contract replays, approvals, dependency
changes/cycles, costs, evidence states, JSON/TOON and whitespace/CRLF variants.
An independent powerset/topological-set oracle uses BigInt costs. Native state
is compared through SDK reads, including relationships and whitespace-bearing
fields; no package-specific native normalization is used.

An isolated behavioral revert replaces minimum-cost selection with all
executable approved checks. The regression fails at cost 16 versus expected 6;
the package worktree remains untouched. The fixed regression is then rerun.

No native import/export/sync, recovery journal, idempotency key, tracker mutation
or native-status interpretation was introduced. Evidence-read interleavings
are tested at every observed workspace-history read boundary on one non-git
tracker. A change before the first observation is a stable newer snapshot;
subsequent detected changes cannot be called fresh. This is detection, with
the documented post-read window, not lock-based isolation from ordinary writers.

The existing packed-consumer acceptance also exercises this command and SDK
through six launch modes: npm/Bun local, npm/Bun global and npx/bunx. It checks
12 command format cases and four installed SDK consumers for re-verification.
CI runs the unchanged npm and Bun release gates on Node 22 and 26; exact-head
run links and pass counts are recorded in the pull request.

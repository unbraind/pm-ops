# GitHub issue sync policy

The scheduled sync mirrors GitHub issue state through the pinned importer. The
atomic transaction creates or updates the local item, then finalizes the remote
status and timestamps in an SDK mutation recorded as `import`. A closed GitHub
issue may lack structured reproduction steps, expected behavior, or a resolution.

In the pm-ops tracker, `completeness-issue` and `fleet-closed-resolution` apply to
the `create`, `update`, `close`, `restore`, and `normalize` operations. Both
rules still refuse incomplete local closures and writes that remove required
evidence from a closed item. The operation determines the scope even when a
local write uses a GitHub tag or the importer author name. Run the sync with
`--atomic --gate` so the SDK can finalize mirrored state as `import`.

`pm schema policies` reports the selectors in JSON and TOON.
`npm run verify:lifecycle-policy` and `bun run verify:lifecycle-policy` check the
same installed declaration. The SDK checks operation-scoped rules at mutation
time. The standalone completeness check audits rules that depend only on stored
state. The published fleet policy still supplies the default rules for other
trackers.

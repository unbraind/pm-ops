# Self-syncing development dependencies

`package.json` owns the exact development CLI version. The compatibility suite and packed npm/Bun acceptance read it through `developmentCliVersion` in `test/dependency-contract.ts`. A dependency-only update needs no second version edit in a test or consumer fixture.

The reader fails unless the lockfile root declaration, locked CLI package and installed CLI metadata equal that exact pin. It also requires the npm peer floor and extension manifest floor to agree and invokes the real public SDK compatibility checker for version bounds and supported manifest keys. A range, stale installation, inconsistent lock or incompatible manifest still fails. The independent numeric floor checks remain in the compatibility suite.

`test/dependency-contract.test.ts` initializes and writes a disposable tracker through the installed CLI. It links the real installed SDK rather than mocking its behavior. Ten metadata corruption cases cover missing/ranged pins, both lock mismatches, stale installation, inconsistent floors, a consistent floor above the host, an incompatible maximum and an unsupported manifest key. Child Node test runners clear `NODE_TEST_CONTEXT` so their assertions execute independently of their parent runner.

The native Windows proof previously required commits from a branch that was squashed into main, so fetching all of main's history could not make them available. `test/fixtures/historical-windows-proof.ts` (from #156) vendors the original `execute` and `run` functions and the earlier proof source, and `replaceFunction` transplants only those function bodies while keeping the current assertions and metadata checks. The remaining historical reference is main-reachable commit `3fca1f2`. When that commit is absent, `test/windows-proof-history.test.ts` checks that the proof refuses with a fetch-depth diagnostic instead of skipping. Native Windows execution remains required for Windows launcher acceptance.

PR #151 is already closed. Its SDK update from 2026.10.4 to 2026.10.5 originally failed a duplicated approved-version assertion. Main subsequently moved its SDK pin to 2026.10.10 in PR #152. Replaying the original package delta now deliberately exercises the historical SDK 2026.10.5, a downgrade from current main; it is a local compatibility experiment, not a proposed dependency change. PR #153 updates pm-changelog from 2026.10.4 to 2026.10.5 without changing the current SDK pin. Dependency overlays are restored after validation. The historical downgrade still fails the existing unaudited receipt-settlement assertion: SDK 2026.10.5 treats a state mark as reconciliation without proving its audited history. That semantic refusal remains required; removing duplicate version literals does not promise acceptance of an SDK that violates the release contract. The separate receipt-history assurance floor is tracked in `ops-sdk-settlement-floor`.

Real tracker fixtures launch the locally installed CLI with explicit tracker context. Their subprocess deadlines allow for startup and scheduling delays on a shared runner. Parser complexity checks retain their 2000ms budget but measure CPU consumed by parsing; an outer child deadline still bounds execution. Semantic assertions, incompatible-metadata refusals, stale-report invalidation and release coverage thresholds remain intact.

Validation keeps the release thresholds unchanged:

- `npm run release:check`
- `bun run release:check`
- `env HOME=$(mktemp -d) GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm run release:check`
- `node --test test/dependency-contract.test.ts test/compatibility-floor.test.ts test/windows-proof-history.test.ts`

The PM item records exact heads, replay scenarios, function reverts, pass/fail counts and remaining evidence limits.

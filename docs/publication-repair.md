# Canonical publication and consumer installation repair

Owner: `codex-sol`. Companion: `pm-cli-website-session-2026-10-10`.
Base: `fedeb7bf19241fa2e9ce3ae9d263bc1e091729a4`.

GitHub issues [148](https://github.com/unbraind/pm-ops/issues/148) and
[149](https://github.com/unbraind/pm-ops/issues/149) are independent package defects.
Artifact creation now skips merge-driver preparation before package resolution.
Install/ci retain registration and broken-install refusal. The attestation auditor
refuses aliases, unknown executable expansion, publisher argument forwarding and
spawning input that cannot prove effective provenance. A literal flag cannot
prove the result when later arguments can disable it.

## Behavioral evidence

The current review correction additionally permits read-only `npm whoami` and
`npm ping` with unresolved registry operands. The prior auditor rejects the real
regression; unknown verbs remain fail-closed. The pack/install fixture uses a
Windows cmd launcher and native PATH delimiter, invoking npm's installed CLI
through Node on Windows. Native Windows evidence is recorded below; the local
host only supplies Linux evidence. Packed acceptance verifies the ambient npm major before
claiming an npm 11 pack receipt; an actual npm 10.9.4 executable is rejected
before packing. These fixes address comments 4236402851, 4236402857 and 4236402861.

The unchanged complete release gate passes 496 tests with two pre-existing opt-in
skips and all four 100% coverage metrics over 23 authored runtime/tool/template
files. The final focused corpus/pack run passes 27 tests and typechecking. Fresh
packed npm/Node and native Bun consumers pass with the new npm-major proof.

- `node --test test/publish-indirection.test.ts test/pack-prepare.test.ts`:
  27 passed, zero failures/skips. Twenty-three Bash/xargs subprocess cases retain
  real expansion and forwarding while an inert publisher records its arguments.
  Additional checks cover sanctioned commands, quoted executable boundaries,
  manifests, workflows and composite actions. Real npm pack compares Git config
  bytes even with a held config lock; installation and ci still register, and
  broken installations fail.
- Independent fail-on-revert: restoring only the base `attestation.ts` fails
  18 of 26 corpus tests. Restoring only the template, only the local prepare hook,
  or only the exported prepare entry each fails the pack regression. Every
  repaired file was restored byte-for-byte before further validation.
- `npm config get provenance --provenance --no-provenance` returns `false`;
  reversing the two options returns `true`. No publish command was executed.
- `npm run accept:packed` installs the tarball into separate npm/Node and native
  Bun consumers with published SDK 2026.10.9. It checks synthetic tracker create,
  validation, strict merge-driver health, actual extension activation, built
  attestation refusal and Git config byte identity around npm 11 pack and
  npm 10.9.4 pack with `--ignore-scripts`. It removes all disposable state.
  The initial tested tarball SHA-256 was
  `1d6b39113d187ae64d31d09477fe080f5dfdedc415f72c5fdc879dc5e64d52e6`.
- Both focused PM-linked tests and the six compatibility checks pass. Project
  test-result tracking is disabled, so explicit owner comments retain receipts.

## SDK dependency and existing feature assessment

[Dependabot PR 151](https://github.com/unbraind/pm-ops/pull/151) fails the local
approved-version assertion: its SDK 2026.10.5 differs from hardcoded 2026.10.4.
CI recorded 468 passed, one failed and two existing opt-in skips, with full
measured coverage. This repair consolidates the published 2026.10.9 pin and keeps
both the exact-pin guard and the supported host floor. pm-changelog is unchanged.

Installed SDK declarations define `markMergeReceiptReconciled` as marking a
receipt already represented by committed merge history. The migrated consumer
test asserts that an unaudited mark stays pending, finishes the synthetic Git
merge, uses `runMergeReconcile`, then checks default and include-reconciled
classification. The targeted real-Git test passes. No new SDK implementation
bug was established; core source was never edited.

[Feature PR 150](https://github.com/unbraind/pm-ops/pull/150), assessed at
`0a04adfa2e507339ab90e0f0bf6a75b177c7173b`, remains independent. Its evidence
parser accepts absent workflow/ref fields or an unapproved workflow/ref when
injected audit output declares verification. This demonstrates a parser contract
gap, not a live signature bypass. Expected source authorization needs review.
The signed audit boundary, commit checks and conservative write preflight are
useful protections. The feature branch was not modified or executed against live
release APIs.

All available review and comment bodies were read. The renewed CodeRabbit review
posted the three findings addressed above; another final-head review is pending.
Greptile reports an ended trial; Sourcery reports
quota exhaustion and provides a guide; Cubic is neutral. Gemini/Copilot have no
receipts. Earlier CodeQL regex findings were fixed; option-shaped tag arguments
are refused at the call site. Green CI does not supply missing review approval.

## Assurance boundaries

`npm run release:check` passes: 498 tests, 496 passed, zero failed and two
pre-existing opt-in skips. Statements, branches, functions and lines each reach
100% over 23 authored source files. The configured docstring gate checks 222
declarations in 23 files; that selected denominator does not establish complete
internal documentation. Final duplication checking measures zero duplicated
lines out of 23,023, across 48 sources and zero clone pairs. Production dependency
audit reports zero vulnerabilities.
The separate full dependency audit reports five high-severity affected development
packages through the retained jscpd 4 compatibility alias; the existing
`ops-braces-audit` owner retains that work. No compatibility engine was removed
to obtain a passing audit.

The prior strict package-health receipt passes with merge drivers required.
During this continuation, full-extension local health refuses ambient host and
extension version skew: the global host is 2026.10.10 while this candidate's SDK
is 2026.10.9, and the pinned host encounters ambient pm-github 2026.10.10.
Storage-only strict health with extensions disabled passes with required merge
drivers; it does not certify extension health. Fresh packed consumers separately
pass strict health in their own isolated installation. No dependency or ambient
installation was changed to hide that boundary. Separate validation
refuses twelve pre-existing closed-item completeness violations, plus legacy
metadata, test-trust and resolution warnings. Retrospective evidence was not
fabricated. Whole-declaration documentation remains owned by `ops-0c8k`.

Coverage measures authored TypeScript runtime/tooling/template sources; tests,
declarations, dependencies and generated files are outside that denominator.
The standalone packed acceptance is test tooling and is checked separately.
Two pre-existing real-fleet opt-in tests require two repositories and remain
unavailable under this task's single-repository scope. Synthetic consumers and
local passing gates do not certify fleet rollout, hosted safety or review approval.
No merge, tag, release or registry publication was performed. PM owners remain
open for orchestrator verification.

## Orchestrator review corrections

CodeRabbit's PR #152 review identified a missing parent directory when packed
acceptance starts from a clean checkout and an obsolete SDK version in the
certification result. Both were corrected. Moving the generated coverage
directory aside reproduced the real `ENOENT`; the repaired packed npm and
native Bun acceptance passes with that directory initially absent.

The outside-diff finding also correctly identified a misleading error: an
unresolved publisher was classified as a foreign executable or an unattested
literal publisher before its unresolved evidence was checked. The auditor now
reports the unresolved publication path first. Existing expansion fixtures and
the quoted multiword executable fixture require that exact reason. The new
assertion fails against the old ordering; the repaired focused set passes
129/129. The full release gate still passes 496 tests, with two pre-existing
opt-in skips and four-dimensional 100% coverage across the same 23 sources.

The orchestrator independently verified the original 27 subprocess/pack cases,
requested external review, and is submitting these corrections for renewed
current-head review. Greptile's ended trial and any rate-limited review remain
missing evidence. The review-quorum limits above apply to the independent
feature PR #150; they do not constitute approval of this repair PR.

## Renewed Windows launcher findings

Review 5477818338 comments 4236589192 and 4236589194 both reproduce on native
Windows. [CI run 38028728667](https://github.com/unbraind/pm-ops/actions/runs/38028728667)
at `90e66071740a7c660656236697a3eb9c78744631` retains the old test launchers.
Both Node 22 and 26 fail the standalone fixture at the missing `npm_execpath`
assertion and packed acceptance at `npm --version` with a null spawn status.
These are real Windows subprocess failures, independent of constructed shim
bytes or a mocked platform.

Shared test tooling now resolves the npm/npx selected by `where.exe`, reads
the installed npm package's actual CLI entries. Bundled launchers retain their
`npm-prefix.js` precedence; generated global shims directly select the adjacent
package. Node executes those entries directly with an
argument array and no shell. npm's installed Windows launchers and package
metadata were checked against npm 11.17.0 and the
[upstream npm launcher](https://github.com/npm/cli/blob/latest/bin/npm.cmd).
`npm_execpath` is not required. Other platforms retain the original commands.
Windows consumers also receive the native system and temporary-directory
environment needed by Node, npm and Git. The standalone fixture and native proof
script explicitly normalize `process.env.PATH` before using a plain environment
object, preserving Windows' case-insensitive `Path` value when prepending bins.
CI installs npm 11 beside the selected Node executable, so ignoring the runner's
user npm configuration cannot fall back to Node 22's bundled npm 10. The guard
correctly rejected that actual npm 10.9.9 during the intermediate native run.

The existing public CI now runs standalone pack and complete packed npm/Node
and native Bun consumers on Windows Server 2025 with Node 22 and 26. Each native
job independently restores only one prior test launcher, requires its specific
failure and restores the repaired bytes. It then installs actual npm 10.9.4,
checks its version and requires the npm 11 guard to reject it before packing.
The commands use standard free public runners with the existing SHA-pinning
convention. GitHub's default PowerShell exit handling reports each command's
status; explicit PowerShell expressions are unnecessary and would trigger the
conservative shell auditor. No attestation rule was relaxed.

Local validation passes `npm run build:test`, the unchanged 27 focused
subprocess/pack tests without `npm_execpath`, both PM-linked tests and fresh
packed npm/Node and native Bun acceptance. Project test-result tracking remains
disabled; owner comments retain the receipts. Fresh final local packed npm/Node
and native Bun consumers pass independently. The actual local npm 10.9.4 control
(`npx --yes --package npm@10.9.4 -- node test/packed-consumer.acceptance.ts`)
exits 1 at the version guard before any packing.

[Green CI run 38029183548](https://github.com/unbraind/pm-ops/actions/runs/38029183548)
at source head `086b52e0a1660132b805c3695fd728eb0ccd9dc9` passes both Linux jobs
and both Windows consumer jobs. Native Windows
[Node 22](https://github.com/unbraind/pm-ops/actions/runs/38029183548/job/114146337599)
and [Node 26](https://github.com/unbraind/pm-ops/actions/runs/38029183548/job/114146337560)
each pass standalone pack without `npm_execpath`, packed npm/Node and native Bun
acceptance, both independent source-only launcher reverts and the actual npm 10
negative control. Logs identify real installed `npm-cli.js` and `npx-cli.js`
entries, each running npm 11.21.0, and record the rejected npm 10.9.4. Both native
consumer jobs produce candidate tarball SHA-256
`e6589fc9192822c8f4db09217ebc3f119de978bfadca4bbb639d13e700af0942`.
Each reverted launcher fails at its specific old diagnostic; the proof script
restores the repaired source bytes before continuing.

The final unchanged local `npm run release:check` exits 0 with 498 tests:
496 passed, zero failed, two pre-existing opt-in fleet skips. Statements,
branches, functions and lines each reach 100% over the same 23 authored
production sources. New launcher/proof files are test tooling, outside that
production denominator, and are checked by `build:test` and native CI. There
were no coverage exclusions, threshold changes, runtime SDK changes or bulk
dependency updates. The assurance and review boundaries above remain in force.
Subsequent evidence-only commits do not change the tested consumer source.

## Renewed option-prefix and historical-proof findings

Findings 4236759848, 4236759852 and 4236759854 were verified against accepted
source `b89fd6f36adf91c9bfc784c7ab643d9ce9cb7eae`. CI now installs exact
`npm@11.21.0` on Linux and Windows. The native proof checks both installed
npm/npx CLI versions against that exact version before its existing controls.
No package version, SDK pin, dependency lock or prepare implementation changed.

The auditor recognizes read-only verbs after known npm options and operands,
including separated and joined registry values, literal boolean operands and
the option terminator. Unknown options or verbs, missing operands, unresolved
verbs, foreign publishers and spawning input retain fail-closed refusal.
Unquoted expansions, mixed quoting and quoted positional/array lists cannot
prove a single operand. Minimal tokenizer metadata preserves that distinction
instead of treating any quote in a word as proof of its argument boundary.
The actual installed npm 11.21.0 configuration parser independently recognizes
`whoami` and `ping` after `--registry` and its operand, matching the
[npm configuration contract](https://docs.npmjs.com/cli/v11/using-npm/config/).
Restoring only the accepted attestation source rejects both preflights; the
repaired source accepts them. Real Bash executions also preserve refusal of
argument injection through mixed quoting and positional lists, with an inert
publisher recording the actual arguments.

Historical source-only Windows proofs still require commit
`ea29cb425a72b6729d24b00df4573e8c092c7cfa`. A Git object check now fails with
an explicit full-history recovery diagnostic before executing consumer controls.
Missing evidence is never replaced or skipped. The absence regression uses a
real empty Git object store without creating another clone. It executes the
accepted proof source independently: native Windows reaches the old generic
`git show` failure, while Linux reaches its old platform assertion. The repaired
proof fails with the requested historical-evidence diagnostic on both platforms.
Normal native Windows execution separately proves the historical object is
present, rejects each old launcher independently, restores repaired bytes and
rejects actual npm 10.9.4 before packing. All earlier receipts above are retained.

The final direct `npm run release:check` with real npm 11.21.0 passes 505 tests:
503 passed, zero failed/canceled/TODO and two unchanged opt-in fleet skips.
All 23 authored production sources reach 100% statements, branches, functions
and lines. Typecheck, lint, selected docstrings (222 declarations in 23 files),
duplication (zero of 23,162 lines across 49 sources), production audit (zero),
50-file package verification, changelog and all release verifiers pass.
`npm run build:test` and the focused 34-test corpus/pack/history set pass.
All three publication-owner PM-linked commands and the six SDK compatibility
checks pass. Test-result tracking stays disabled; owner comments hold receipts.
Actual npm 10.9.4 is again rejected before any packing receipt. The independent
five high development findings, twelve legacy completeness violations, ambient
extension skew and whole-internal documentation/review boundaries remain.

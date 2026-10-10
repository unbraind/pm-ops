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
Fresh `npm run accept:packed` passes independent npm/Node and native Bun
consumers with actual SDK activation, synthetic tracker create/validate/strict
merge-driver health and npm 11/10 config byte comparisons. The final local
candidate tarball SHA-256 is
`82e47d38acf871c9aaba4d4c8f8390c47c4bf6fadd3cba30b1963ca4ebfaffe9`.

[CI run 38033875668](https://github.com/unbraind/pm-ops/actions/runs/38033875668)
at source `c8e15db197f2834de9a0f3279224ce5cf0f9ed3f` passes
[Linux Node 22](https://github.com/unbraind/pm-ops/actions/runs/38033875668/job/114160182552),
[Linux Node 26](https://github.com/unbraind/pm-ops/actions/runs/38033875668/job/114160182581),
[native Windows Node 22](https://github.com/unbraind/pm-ops/actions/runs/38033875668/job/114160182580)
and [native Windows Node 26](https://github.com/unbraind/pm-ops/actions/runs/38033875668/job/114160182355).
[CodeQL](https://github.com/unbraind/pm-ops/actions/runs/38033875790) also passes
at that source. Each native log identifies actual npm/npx Node CLI entries at
11.21.0, proves the accepted historical-proof source lacks the missing-object
diagnostic on Windows, and proves the repaired diagnostic without skipping
historical evidence. Standalone pack, packed npm/Node and native Bun consumers,
both independent source-only launcher rejections with byte restoration, and
actual npm 10.9.4 rejection before packing all pass. Both Windows jobs produce
tarball SHA-256
`817e771bef6c9021a6a7f35ab5e9f3f05cb9a72ad2faaa801964f37c8b197397`.
The Linux lint annotation about explicit `any` comes from the existing intentional
negative-fixture assertions; both canonical lint steps pass. No new `any`,
dynamic imports or non-erasable TypeScript syntax were introduced.

Changed production scope since the accepted source is `attestation.ts` and
`shell-scan.ts`, with their generated distribution artifacts. CI and proof tests
carry the corresponding controls. Prepare hooks, shared npm launcher, packed
consumer fixture, SDK 2026.10.9, package version, lockfile and coverage configuration
remain unchanged. Final PM/evidence-only commits preserve those tested source
bytes. Owners `ops-publish-indirection`, `ops-pack-prepare` and `ops-hiee` remain
unclosed for root verification; no GitHub review replies, merge or publication
were performed.


## Quoted expansion resource repair (2026-10-10, source `158450e`)

CodeQL16 (inline4236838359) identified overlapping quantified regex terms on
caller-supplied quoted shell text. The exported tokenizer, attestation library
and tracked-source verifier reach that synchronous boundary. No remote exposure
was established. The original parser fails a real isolated-child assertion at
its unchanged2000ms budget on an unterminated expansion with80000 at-signs.
The regression also exercises12000 repeated expansion prefixes, with and
without20000 trailing at-signs. Legitimate scalar, positional/list and repeated
delimiter contracts remain measured through actual tokenization and the auditor.

The implementation uses monotone cached positions for the next closing brace
and at-sign. Each search resumes after its previous match; an absent delimiter
uses an end sentinel and is never searched repeatedly. A real closing brace is
required before multiword classification, preserving the old conservative
first-closing-brace contract without suffix slicing or regex backtracking.
The initial candidate missed that sentinel check and failed promptly rather
than timing out. An independent review independently reproduced the same added
refusal in48 of5832 structured cases; none relaxed publisher refusal. Root
corrects it and46 focused real parser/publication tests pass. The review notes
that a shared tracker diff exposed prior rationale; its source-backed regression
and direct probes, rather than an unqualified independence claim, are retained.

The complete unchanged release gate passes507 tests:505 pass, zero failures,
two existing opt-in fleet skips. Every one of23 production sources reports
four100. Root independently matches Git and LCOV inventories and confirms all
11074 line,355 function and2917 branch counters are hit. Runtime source hashes
stay frozen. Fresh packed npm/Node and native Bun consumers both pass actual
SDK9 activation, create/validate/strict merge-driver health and npm11/10 config
byte checks. Type/lint/selected docs/zero duplication/changelog/production audit
and release/lifecycle verifiers pass. No dependency/version/threshold changes.

At that source, a separate confirmed preexisting semantic gap remained with the
publication owner: an unquoted parameter default containing a command
substitution can execute an unattested publisher while an attested sibling
satisfies the verifier. The quoted equivalent is detected. This resource repair
did not close that semantic obligation. The semantic receipt below supersedes
that open-gap statement for its measured cases; whole-declaration docs, five high
development findings, twelve historical completeness gaps and required reviews
remain open.
The package owner stays unclosed; passing configured tests are not a proof of
all possible shell semantics or release readiness. Final exact-head native CI
and CodeQL are requested after the source/PM commit.


## Nested substitution semantic repair (2026-10-10)

Owner: `codex-nested-closure`, existing `ops-publish-indirection`, PR #152.
Accepted source baseline: `158450e07cc5ac3357c5d97fe3bf1281bd57c324`;
independent review PM-only commit: `12516c9`. The preserved candidate discovers
publishers in unquoted parameter defaults and arithmetic operands. Independent
review identified an escaped nested-backtick omission and child `unset` retiring
a parent provenance binding. Both findings were reproduced with actual Bash,
while only the npm registry boundary was replaced by an inert argv recorder.

The shared scanner now identifies lexical child regions before parent
segmentation or expansion. The auditor analyzes those child bodies independently,
so child unsets and assignments cannot change parent scalar/array evidence or
receive prematurely expanded parent flags. Locally declared child literals can
prove provenance; inherited child references remain explicitly unresolved.
Array evidence is acquired in source order rather than borrowed from later or
mutually exclusive declarations. Unsets, unreadable replacement, append and
indexed writes retire prior evidence. Supported multiline arrays preserve
heredoc data and physical line counts. Backticks remove one escape layer before
child parsing. Arithmetic grouping remains operand text, including the real
workflow's decimal `10#` conversions; executable substitutions inside it remain
audited. Public token shapes, outer-first order, function arity and depth cap
remain measured and unchanged.

`node --test test/publish-indirection.test.ts test/attestation-union.test.ts
test/shell-command-scan.test.ts` passes **189/189**, zero failures/skips. The
publication corpus alone passes **96/96**, including **88 actual Bash executions**
using the existing shared inert boundary. Cases include parameter/default,
quoted, arithmetic and escaped nested backticks; scalar/array unset, assignment,
append and indexed writes; sibling isolation; standalone subshells; parent-state
positives; local-child positives; inherited-state conservative refusals;
multiline arrays and workflow-shaped arithmetic. No real npm publish runs.

`node test/nested-substitution.proof.ts` replaces only production source with
accepted Git bytes, executing the current corpus and assertions unchanged.
The baseline scanner/auditor yields **12 genuine verdict assertion failures**
across the selected publisher/mutation controls. Restoring only the accepted
auditor with the repaired scanner yields **five parent-isolation assertion
failures**. Setup, import, syntax and timing failures cannot satisfy either
negative control. Both sources are restored byte-for-byte in `finally`, followed
by the passing full 96-case corpus. All **seven** existing/enriched PM-linked
commands pass through `pm test ops-publish-indirection --run --progress`;
tracking remains disabled and owner comments retain the receipts.

Two intermediate full gates failed and were not accepted. The first ran
554/556 passing tests with two existing skips, then refused incomplete branch
coverage. The second ran 565/567 passing tests and four-dimensional 100% coverage,
then the actual workflow attestation verifier rejected three arithmetic operands
incorrectly classified as child commands. Canonical LCOV was invalidated after
both failures. The final operand-mode fix is covered by actual Bash positives
and a standalone arithmetic publisher negative, with the unchanged deadline.

The final **unchanged `npm run release:check` exits 0** with **569 total,
567 passed, zero failed/canceled/TODO and two existing opt-in fleet skips**.
Each of the same **23 production TypeScript files** reports **100% statements,
branches, functions and lines**. Git and LCOV inventories match exactly, and
all **11,242 DA, 358 FNDA and 2,985 BRDA counters** are positive. All 23 source
hashes remain frozen through the complete gate. The source hash-map SHA-256 is
`14a8559a55f5b58cf08e7b391b78f1bf2ebc88cbe8367f133c9dc01ab7b03552`.
Changed source SHA-256 values:

- `attestation.ts`: `b1016f8767968abdf289598f9a8c7b0b2d7454e18fcb0378ead7f093b0e035d1`
- `shell-scan.ts`: `cd27680d99e77de23bf67da6e1af2feec49c381eff83a14b1b8335402dc2601d`

| Production source | Hit line counters | Hit function counters | Hit branch counters |
| --- | ---: | ---: | ---: |
| `assurance.ts` | 669 | 16 | 95 |
| `attestation.ts` | 886 | 18 | 221 |
| `docstrings.ts` | 1288 | 54 | 439 |
| `duplication.ts` | 577 | 24 | 114 |
| `eslint.ts` | 148 | 2 | 9 |
| `index.ts` | 3031 | 125 | 967 |
| `invocation-audit.ts` | 50 | 1 | 10 |
| `lifecycle-policy.ts` | 375 | 6 | 39 |
| `merge-driver-prepare.ts` | 22 | 0 | 4 |
| `merge-driver.ts` | 148 | 3 | 48 |
| `shell-scan.ts` | 2058 | 47 | 670 |
| `scripts/coverage-gate.ts` | 508 | 7 | 87 |
| `scripts/docstring-gate.ts` | 71 | 1 | 12 |
| `scripts/duplication-gate.ts` | 8 | 0 | 1 |
| `scripts/lint.ts` | 8 | 0 | 1 |
| `scripts/main-invocation.ts` | 63 | 3 | 8 |
| `scripts/prepare-merge-driver.ts` | 19 | 0 | 5 |
| `scripts/shell-command-scan.ts` | 9 | 0 | 1 |
| `scripts/verify-lifecycle-policy.ts` | 375 | 16 | 78 |
| `scripts/verify-release-changelog-date.ts` | 331 | 11 | 70 |
| `scripts/verify-release-completeness.ts` | 471 | 20 | 86 |
| `scripts/verify-release-publish-attestation.ts` | 53 | 4 | 6 |
| `templates/prepare-merge-driver.ts` | 74 | 0 | 14 |

Typecheck, test typecheck, lint, selected docstrings (225 declarations across
23 files), duplication (zero of 23,539 lines across 50 sources), production audit
(zero vulnerabilities), 50-file package dry run, changelog, date, publication and
lifecycle verifiers all pass. Historical release completeness independently
passes for 46 release tags. Local runtime identity is Node 24.19.0, npm 11.17.0
and Bun 1.3.5; the unchanged CI configuration pins npm 11.21.0. Selected docs
and per-file production coverage do not measure whole internal documentation.
Storage-only strict merge-driver health passes with extensions disabled.
Separate PM validation retains 12 legacy completeness errors and zero history
drift; full dependency audit retains five high development findings. SDK
2026.10.9, package/dependency versions, coverage inventory, thresholds, prepare
hooks and lifecycle configuration are unchanged.

This closes the earlier open parameter-default gap for the measured corpus.
Enumeration remains bounded at the inherited depth cap and is not an exhaustive
proof of arbitrary Bash, evaluator state, fleet or hosted readiness. Inherited
child bindings and conditional array state can be conservatively refused even
when a particular execution happens to carry provenance. Earlier performance,
Windows and CI receipts remain dated evidence of their own source heads. Required
current-head review, whole-declaration documentation, development audit and legacy
completeness work remain open. No merge, tag, release, publication, deployment or
GitHub review message was performed. The publication owner remains unclosed.


Fresh `npm run accept:packed` exits 0 for independently installed npm/Node and
native Bun consumers after the final source change. The built auditor executes
seven additional nested publisher/scope/mutation controls in each runtime,
including parent positives and inherited-child refusals, alongside the retained
alias/quoted-executable checks. Actual SDK activation, synthetic create/validate,
strict merge-driver health and npm 11/10 packing config-byte comparisons pass.
The accepted tarball SHA-256 is
`64665192cf43672ca121567a9cb78f325a1b19bca08ecc74f72c49751d064597`.
No real registry publisher was executed. The final metadata receipt names the
exact committed source after recording these gates; metadata-only follow-up
preserves all tested runtime, dist, test and package bytes.


Exact gated source commit: `df3bda1de876bc6b65a94c12b99e84c070365150`.
Post-commit identity/privacy checking passes 4/4, and every frozen production
source hash still matches after packing and committing. The final follow-up
changes only this receipt and the publication owner's PM pair, releases its
claim without closing it, and preserves all source/dist/test/package bytes.
Current-head CI and external review remain pending the final branch push;
previous green native receipts are not approval of this new source.

## Linear array declaration candidate and SDK refresh

The scanner candidate replaces the declaration regular expression with suffix
completion tables for bare, single-quoted and double-quoted operands. Each table
entry uses only later entries; the forward candidate-name index never retreats.
Malformed declarations therefore reuse completions instead of repeatedly scanning
quotes or suffixes. Three tables require linear storage; successful, non-overlapping
operand projections have total linear length. This is a source-backed complexity
argument, without resource measurements or security-test approval.

The exported helpers retain ASCII names, immediate `=(`, ECMAScript whitespace
before names, broad literal quote/escape operands, empty bodies, cross-line
completion, failed-outer recovery, duplicate ordering and UTF-16 source extents.
They still recognize candidate-shaped source inside enclosing data. Bare inner
parentheses remain unsupported; quoted substitutions remain literal operands.
Attestation retains local declaration-before-use binding and child isolation;
changelog retains its independent whole-file last-declaration map. Ordinary
assertions cover these contracts with concrete expected operands, extents and
consumer commands. No production module, exclusion, threshold or deadline was
added. The old declaration docstring overstated the substitution restriction;
the replacement describes the existing grammar.

Published SDK 2026.10.10 was confirmed in the registry before installation and is
now the exact development dependency and lock entry. The independent peer and
extension compatibility floor stays 2026.8.20. The installed metadata test uses
the actual public SDK flag type and canonical `value_type`/`list` fields; a separate
assertion checks the installed package version. Packed npm/Node and native Bun
fixtures now explicitly require SDK 2026.10.10 and exercise the built array API.
Every earlier SDK 2026.10.9 receipt above remains historical.

Phase A: the upgraded pin tests first fail against SDK 2026.10.9, then pass after
the published upgrade. Ordinary source/API and consumer tests pass 69/69; build
and test typechecking pass. The new helper contract assertions also passed the
pre-refactor source, apart from a corrected test assumption about the verifier's
string failure shape. The complete gate and fresh packed acceptance await the
independent candidate source/API review. Earlier rejected investigations were
not retried. The publication owner is released unclosed at candidate handoff.

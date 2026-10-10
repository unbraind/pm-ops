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
through Node on Windows. Native Windows execution of this fixture remains
unverified locally. Packed acceptance verifies the ambient npm major before
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

All available review and comment bodies were read: CodeRabbit reports no
final-head actionable findings; Greptile reports an ended trial; Sourcery reports
quota exhaustion and provides a guide; Cubic is neutral. Gemini/Copilot have no
receipts. Earlier CodeQL regex findings were fixed; option-shaped tag arguments
are refused at the call site. Green CI does not supply missing review approval.

## Assurance boundaries

`npm run release:check` passes: 498 tests, 496 passed, zero failed and two
pre-existing opt-in skips. Statements, branches, functions and lines each reach
100% over 23 authored source files. The configured docstring gate checks 222
declarations in 23 files; that selected denominator does not establish complete
internal documentation. Final duplication checking measures zero duplicated
lines out of 22,903, across 46 sources and zero clone pairs. Production dependency
audit reports zero vulnerabilities.
The separate full dependency audit reports five high-severity affected development
packages through the retained jscpd 4 compatibility alias; the existing
`ops-braces-audit` owner retains that work. No compatibility engine was removed
to obtain a passing audit.

Strict package health passes with merge drivers required. Separate validation
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

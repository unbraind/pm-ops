# Canonical publication regressions

Issues [#148](https://github.com/unbraind/pm-ops/issues/148) and [#149](https://github.com/unbraind/pm-ops/issues/149).

Main already includes the artifact-time prepare guards and basic alias/function/xargs refusals from PR #152. This follow-up imports the full pm-web adversarial corpus, completes its conservative evaluator/array refusals, and parses independent workflow and composite-action shell bodies as YAML data. Malformed executable sources fail closed. The existing manifestCommandLines text helper keeps its compatibility behavior.

The pack regression exercises real temporary Git repositories, config and held-lock byte identity, one artifact notice, broken-package refusal on install, and npm install/ci. The additional clone regression runs the copied canonical template through the actual pm installer and asserts all five driver registrations. No template is copied to another repository by this change.

Reproduce the read-only fleet inventory with `node test/fleet-publish-attestation.proof.ts "$FLEET_ROOT"`, where FLEET_ROOT names the fleet checkout directory. Every `.yml` and `.yaml` workflow is audited individually. NO_PUBLISH means the required non-vacuity check found no publish; it is not a passing release gate.

## Fleet compatibility

All 22 baseline-passing workflows still pass. Of 112 files, 22 pass, 84 have no publish path, and six retain pre-existing refusals. The baseline is main commit `4bcf3d49866deb99dd29a4e03720d197b917fbf4`. The comparison restores no consumer files and executes no workflows.

| Repository | PASS | NO_PUBLISH | Pre-existing FAIL |
| --- | --- | --- | --- |
| pm-ado | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-beads | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-brief | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-changelog | — | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | `release.yml` |
| pm-cli | — | `ci.yml`, `codeql.yml`, `codspeed.yml`, `docs.yml`, `nightly.yml`, `scorecard.yml` | `auto-release.yml`, `release-reliability.yml`, `release.yml`, `security.yml` |
| pm-context | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-csv | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-gantt-chart | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-github | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | `pm-github-sync.yml` |
| pm-graph | `release.yml` | `changelog.yml`, `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml`, `pm-github-sync.yml` | — |
| pm-jev | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-jira | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml`, `pm-github-sync.yml` | — |
| pm-linear | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-lint | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-ops | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-presets | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-rl | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-rust | — | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml`, `release.yml` | — |
| pm-slack | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-slack-standup | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-starter | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-todos | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml`, `pm-github-sync.yml` | — |
| pm-ts-starter | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |
| pm-vcs | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml`, `dependency-refresh.yml` | — |
| pm-web | `release.yml` | `ci.yml`, `codeql.yml`, `dependabot-auto-merge.yml` | — |

Existing refusals are scanner limits in pm-changelog/release.yml and pm-github/pm-github-sync.yml (conditional regex operands), plus four upstream-core workflows with non-shell or unresolved content. They are not introduced by this patch and remain outside these two issues.

## Mechanical rollout inventory

Identified with `grep -l` over fleet script files:

- `scripts/prepare-merge-driver.ts` template copies (21): pm-ado, pm-beads, pm-brief, pm-changelog, pm-context, pm-csv, pm-gantt-chart, pm-github, pm-graph, pm-jev, pm-jira, pm-linear, pm-presets, pm-rl, pm-slack, pm-slack-standup, pm-starter, pm-todos, pm-ts-starter, pm-vcs, pm-web.
- `scripts/verify-release-publish-attestation.ts` package auditor launchers (22): pm-ado, pm-beads, pm-brief, pm-changelog, pm-context, pm-csv, pm-gantt-chart, pm-github, pm-graph, pm-jev, pm-jira, pm-linear, pm-lint, pm-presets, pm-rl, pm-slack, pm-slack-standup, pm-starter, pm-todos, pm-ts-starter, pm-vcs, pm-web.

The pm-ops repository has its own source-relative launchers. After this PR merges and the package is released, the orchestrator can refresh the copies and remove pm-web's local indirection layer against the new canonical package. This PR performs no rollout, release or publication.

## Review round 2

The evaluator sets now include `mksh`, `ash`, `yash` and `posh`. The shared command-prefix scan recognizes `busybox sh` and `busybox ash` while preserving the shell operand for recursive scanning and dynamic-payload refusal. Non-shell BusyBox applets do not evaluate displayed shell text. The corpus includes literal unattested and dynamic evaluator rejections, literal attested evaluator controls, and a direct `npm publish --provenance` non-vacuity control.

Declaration binding scans share a prefix helper for `export`, `readonly`, `declare`, `typeset` and `local`, including option words such as `declare -x`. The opaque evaluator scan records these bindings before scalar expansion can hide a routed evaluator. The scalar scan supports literal provenance flags declared with the same builtins. Corpus fixtures reject each routed evaluator form beside an attested sibling.

The review's OpenGrep `exec` warning refers to `RegExp.exec` inspecting a shell token. The scanner does not execute the inspected shell source.

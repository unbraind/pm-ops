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

## Dependency publish wrappers

`ops-third-party-publish-wrappers` covers the publish commands implemented by
npm dependencies whose source is absent from the tracked repository. Scanning
all tracked executable sources cannot certify these dependencies. Recognition
is by command position, after the shared shell scanner consumes executable
prefixes and package runners; it does not reject unrelated programs such as
`git` or `node`.

The recognized binaries are `semantic-release`, `np`, `release-it`, `lerna` and
`changeset`. The first three publish by default. The latter two route explicit
subcommands. Binary paths such as `./node_modules/.bin/np`, versioned runner
selectors such as `np@latest`, and `@changesets/cli` selectors are recognized.
Supported runner forms include `npx`, `pnpm dlx`, `bunx`, `yarn dlx`, and binary
invocations through `npm exec` (with or without `--`). Separate package-option
operands are consumed as operands: `npm exec --package np -- node` runs `node`,
whereas `npm exec --package np -- np patch` invokes the recognized publisher.
No dependency installation, script evaluation or registry publication occurs.

| Command boundary | Verdict |
| --- | --- |
| `semantic-release`, `np [version]`, `release-it [options]` | Recognized; dependency provenance cannot be certified |
| `lerna publish`, `changeset publish` | Recognized; dependency provenance cannot be certified |
| Unknown or dynamic router verbs, unknown separated options before a verb | Refused conservatively |
| Pure literal argv made only of `--help`, `-h`, `--version`, `-v` | Informational control; no wrapper publish finding |
| `lerna run`, `list`, `ls`, `changed`, `diff`, `info` | Explicit non-publish operations; operands cannot change the selected verb |
| `changeset add`, `init`, `status`, `version`, `pre`, `tag` | Explicit non-publish operations |
| Bare `lerna` / `changeset` | Usage / changeset creation; no publish operation |
| `lerna run build`, `changeset version` | Required non-publish controls; tracked scripts are still audited separately |
| `np --help $FLAGS`, `xargs np --help`, `lerna publish --help` | Refused; pure informational argv is not established |
| Wrapper `--provenance`, dry-run, publish-disabling flags or configuration | No dependency-source certification; refused |
| Direct `npm publish --provenance` in the sanctioned workflow | Existing attested path passes unchanged |

Diagnostics name the normalized wrapper, file, physical line and rendered
command, and explain that dependency source lies outside the audit boundary.
JSON script and YAML run scalar ranges isolate location lookup from metadata.
Literal executable words within multiline source retain their physical lines;
quoted or escaped scalars, YAML aliases and expanded executable names without
a literal source word report the containing executable extent's start line.
Repeated literal invocations retain separate locations. This location policy
does not change the scanner's existing shell enumeration limits.

`test/third-party-publish-wrappers.test.ts` creates real Git repositories and
stages executable files for the canonical `verify` read. Every binary/runner
combination is exercised in a package script, workflow run block, shell script,
and extensionless shell source. Each wrapper is tested both with an attested
sibling and alone. Controls preserve non-vacuity through a sanctioned attested
sibling. A source sentinel must remain absent after auditing. Published npm and
native Bun consumers also exercise wrapper refusal and required controls through
the packed attestation export.

The behavioral revert replaces only `dependencyPublishWrapper` with a return
that recognizes no wrapper, retaining runner parsing and the fixtures. With
that change, all 300 tracked wrapper/runner/source fixtures incorrectly pass
the audit beside an attested sibling, and the 417-test regression suite reports
331 failures (86 controls still pass). Restoring recognition yields 417/417
passing regressions. The proof uses real Git indexes and never runs source
commands or publishes a package.

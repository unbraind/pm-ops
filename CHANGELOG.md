# Changelog

## 2026.9.5 - 2026-09-05

### Security

- The merge-driver test builds a shell command from an environment-controlled path, which is the pattern this repository asks every other one to stop using ([ops-6no1](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-6no1.toon))

## 2026.9.2 - 2026-09-02

### Added

- Publish the canonical attestation scanner as pm-ops exports ([ops-4b34](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/features/ops-4b34.toon))
- A release-completeness gate that requires every release tag to have a matching npm version and GitHub Release ([ops-i8yp](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/features/ops-i8yp.toon))

### Fixed

- Repaired the ops-5jp6 history drift that had blocked two stacked release pull requests ([ops-yxej](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-yxej.toon))
- A case opener sharing its first arm cleared the outer scope and refused a genuinely attested publish ([ops-cout](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-cout.toon))
- Three shell-scope and quoting fail-opens attest unproven npm publishes ([ops-p9lb](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-p9lb.toon))
- A malformed npm reply crashed the release audit, and the docstring already promised it would not ([ops-f5m7](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-f5m7.toon))
- The revert-proof test read its vulnerable fixture from origin/main, so merging it would have turned it red ([ops-9ktn](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-9ktn.toon))
- The paginated release listing was posted rather than fetched, because gh api switches to POST as soon as a parameter is present ([ops-eugo](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-eugo.toon))
- P2: GitHub Release history truncated by gh release list -L 500 (a capped read misses older releases) ([ops-ud1m](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-ud1m.toon))
- P2: exit 0 inside the retry loop instead of returning status to loop-level termination ([ops-emii](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-emii.toon))
- P1: Completeness gate makes a partial release permanent (release:check blocks repair) ([ops-94me](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-94me.toon))
- The bun install verification retried a cached negative manifest, so published versions were never observed ([ops-i3ie](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-i3ie.toon))

### Security

- Four more fail modes in the canonical gate: an arm pattern read as an opener, an escaped run key read as data, a sequence marker missing from the indent, and composite actions unscanned ([ops-cxrx](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-cxrx.toon))
- Attributing a case arm label by presence rather than position refused an attested publish, and a quoted key hid a phantom one ([ops-setc](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-setc.toon))
- An arm that opens a nested case skipped the sibling reset, so a publish could borrow a flag from a mutually exclusive arm ([ops-rsbn](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-rsbn.toon))
- Skipping the sibling-arm reset for any depth-increasing segment let a later arm borrow the previous arm's binding ([ops-narm](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-narm.toon))
- A tracked executable whose name merely ends in package.json has its publish hidden from the audit ([ops-fnbd](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-fnbd.toon))
- A case opener sharing a segment with its first arm leaks that arm's binding past esac ([ops-csop](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-csop.toon))
- Branch-local and compound-line publish bindings let an unattested npm publish pass the attestation gate ([ops-brsc](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-brsc.toon))
- Security: repository-host check matches too loosely (notgithub.com accepted as GitHub) ([ops-042o](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-042o.toon))

### Other

- Converge the pinned pm-cli on 2026.8.31 and repair history hashes ([ops-uulf](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/chores/ops-uulf.toon))

## 2026.8.31 - 2026-08-31

### Fixed

- Finish shell-accurate heredoc and unset handling in publish attestation ([ops-62d1](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-62d1.toon))
- The release changelog remained Unreleased after the release tag was created ([ops-3ete](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-3ete.toon))

### Security

- A heredoc body and a discarded binding both let an unattested publish pass the attestation gate ([ops-5jp6](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-5jp6.toon))

## 2026.8.29 - 2026-08-29

### Fixed

- Harden literal scalar assignment parsing ([ops-mjnd](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-mjnd.toon))
- Escaped shell metacharacter in scalar value bypasses the attestation gate ([ops-5mv7](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-5mv7.toon))
- Shell scalar assignments were read from raw text, so a comment could make an unattested publish pass the attestation gate ([ops-q6wi](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-q6wi.toon))
- A multi-line fixture joined with a literal backslash-n made the array-flag case pass without exercising it ([ops-xmb6](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-xmb6.toon))

## 2026.8.28 - 2026-08-28

### Fixed

- Escaping a markdown cell's pipes without its backslashes shifts every column after it ([ops-pzjp](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-pzjp.toon))
- The publish-attestation scan judged shell text with a regular expression, so real unattested publishes scanned clean ([ops-jhc8](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-jhc8.toon))
- Prevent a failed provenance publish from silently falling back to an unattested publish ([ops-w3ke](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-w3ke.toon))
- The changelog gate stamps an untagged version with the current date, so its verdict flips every midnight with no commit ([ops-vll0](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-vll0.toon))
- Canonicalize fleet metric reads and enforce the pm 2026.8.20 host contract ([ops-3w9m](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-3w9m.toon))

### Security

- The identity gate deadlocks the one remediation its own failure message prescribes ([ops-wsi9](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-wsi9.toon))

## 2026.8.17 - 2026-08-17

### Fixed

- A truncated list-all answer corrupts fleet throughput and cycle-time metrics ([ops-x3wc](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-x3wc.toon))

## 2026.8.16 - 2026-08-16

### Added

- Measure the fleet's coverage and docstring quality as audited assurance bounds via a pm-ops quality measurement provider ([ops-a367](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/features/ops-a367.toon))

### Fixed

- The pm CLI compatibility floor was declared only in peerDependencies, which only npm enforces, and not in manifest.json pm_min_version, which is the field the CLI enforces ([ops-zl7a](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-zl7a.toon))

## 2026.8.10 - 2026-08-10

### Fixed

- The docstring gate scanned installed extension artifacts, so it disagreed with itself across machines ([ops-x8fk](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-x8fk.toon))

## 2026.8.8 - 2026-08-08

### Added

- Adopt pm CLI 2026.8.7 merge fences and release tooling ([ops-8wyb](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/features/ops-8wyb.toon))
- Raise pm-ops enforced source coverage to 100/100/100/100 ([ops-q6ki](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/features/ops-q6ki.toon))

## 2026.8.7 - 2026-08-07

### Fixed

- Gate durable PM project health in CI on pm CLI 2026.8.6 ([ops-54ed](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-54ed.toon))

### Other

- Clear author-attribution health warning for \_workspace history event ([ops-whzj](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/chores/ops-whzj.toon))

## 2026.8.5 - 2026-08-05

### Other

- Declare renderer ownership so the host enforces scoping the package only applied at runtime ([ops-rozk](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-rozk.toon))

## 2026.8.4 - 2026-08-04

### Other

- Resolve pm-changelog to the release that derives release dates in UTC ([ops-70qk](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/chores/ops-70qk.toon))

## 2026.8.1 - 2026-08-01

### Added

- Docstring coverage gate: a lexer-backed, fail-closed documentation gate the fleet can share ([ops-073p](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/features/ops-073p.toon))

### Fixed

- Brace-ending initializers consume following ASI declarations and members ([ops-cqyv](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-cqyv.toon))
- Prevent symlink cycles during docstring source traversal ([ops-hkxb](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-hkxb.toon))
- Semicolon-free exported variables consume following declarations ([ops-aun4](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-aun4.toon))
- Sanitize Node test-runner context before release verification ([ops-hq5u](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-hq5u.toon))
- The docstrings command writes JSON on the failure path under the default toon format ([ops-k6wq](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-k6wq.toon))
- Semicolon-free class fields bypass docstring evaluation ([ops-6wen](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-6wen.toon))
- The docstring gate is fail-open for exported bindings it cannot decompose ([ops-f25k](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-f25k.toon))

## 2026.7.31 - 2026-07-31

### Other

- Expose the analyzer as a pm ops subcommand and a package subpath export ([ops-qvbu](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-qvbu.toon))
- Build the lexer-backed docstring analyzer and its negative controls ([ops-w8n4](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-w8n4.toon))

## 2026.7.29 - 2026-07-29

### Added

- Enforce a real coverage gate by running tests against TypeScript sources ([ops-vtit](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/features/ops-vtit.toon))

### Other

- Adopt pm-cli 2026.7.29 ([ops-j6i7](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/chores/ops-j6i7.toon))

## 2026.7.28 - 2026-07-28

### Added

- Add an ops merge-receipts gate over sdk/merge that fails while any clone-local merge decision receipt is pending ([ops-hdoy](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/features/ops-hdoy.toon))

### Fixed

- All eight ops commands fail to register on pm-cli 2026.7.27 because each redeclares the host-owned --json global ([ops-61n2](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-61n2.toon))
- The merge-receipts gate never read warn-only or include-reconciled, and failed the gate on repos with no pm tracker ([ops-rzb2](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-rzb2.toon))

### Other

- Adopt pm-cli 2026.7.28 ([ops-obv0](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/chores/ops-obv0.toon))

## 2026.7.27 - 2026-07-27

### Removed

- Adopt pm-cli 2026.7.26 typed authoring contracts and remove the any-cast defineExtension shim ([ops-l8bf](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-l8bf.toon))

## 2026.7.26 - 2026-07-26

### Other

- Enable governance duplicate-detection advisory mode and adopt pm-cli 2026.7.25 ([ops-73km](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/chores/ops-73km.toon))

## 2026.7.25 - 2026-07-25

### Other

- Adopt --respect-item-release in changelog scripts and bump pm-changelog to 2026.7.24 ([ops-g3br](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/chores/ops-g3br.toon))

## 2026.7.23 - 2026-07-23

### Fixed

- Recommend pm merge reconcile (2026.7.22) over raw history-repair in Multi-agent merge safety docs ([ops-owhy](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-owhy.toon))

### Other

- Adopt pm field-aware merge driver for multi-agent branch-merge safety ([ops-3ype](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/chores/ops-3ype.toon))

## 2026.7.19 - 2026-07-19

### Other

- pm-ops v0.1: initial production-ready package ([ops-bfg9](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/epics/ops-bfg9.toon))

## 2026.7.14-1 - 2026-07-14

### Added

- Add 'ops metrics' Prometheus exporter for pm workspace health ([ops-6p89](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/features/ops-6p89.toon))

## 2026.7.14 - 2026-07-14

### Fixed

- Restore --repos routing for every fleet command ([ops-ab8i](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/issues/ops-ab8i.toon))

## 2026.7.11-1 - 2026-07-11

### Other

- Production hardening and fleet-operations safety pass 2026-07-09 ([ops-b2aa](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-b2aa.toon))
- Address bot review feedback on PR \#1 (gemini+cubic+coderabbit) ([ops-81x9](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-81x9.toon))

## 2026.7.10-1 - 2026-07-10

### Other

- SDK 2026.7.10 alignment and production readiness pass ([ops-9zcn](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-9zcn.toon))

## 2026.7.10 - 2026-07-10

### Fixed

- Fix manifest: add schema capability so registerCommand flags load (extension failed to activate) ([ops-tg86](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-tg86.toon))
- Fix pm-ops multi-repo path parsing and toolchain alignment ([ops-f4vp](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-f4vp.toon))

## 2026.7.6 - 2026-07-06

### Other

- Align Node engine with pm CLI runtime ([ops-45xp](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-45xp.toon))
- Refresh pm-ops to latest pm CLI and changelog toolchain ([ops-xfit](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-xfit.toon))
- Output rendering via renderer-override marker ([ops-kmjq](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/decisions/ops-kmjq.toon))
- Real-data test suite against pm fleet ([ops-hadw](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-hadw.toon))
- CI + daily release workflow setup ([ops-8d93](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-8d93.toon))
- Implement ops report command ([ops-u5t3](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-u5t3.toon))
- Implement ops verify-release command ([ops-621x](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-621x.toon))
- Implement ops policy command ([ops-b9rl](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-b9rl.toon))
- Implement ops scan command ([ops-jxpd](https://github.com/unbraind/pm-ops/blob/main/.agents/pm/tasks/ops-jxpd.toon))

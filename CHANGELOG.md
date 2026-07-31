# Changelog

## Unreleased

### Fixed

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

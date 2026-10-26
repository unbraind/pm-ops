# Published pm SDK capability floor

Audited main: `1ceb53b69d4bb0eea323625744fe9200a38bb267`. Required API floor: **2026.10.2**.

Declared host floor: `2026.10.20`. npm peer: `>=2026.10.20`.

floor verified: the host declaration and the npm peer or exact runtime dependency already cover every API below. No floor change is needed.

## Artifact method and limits

The published version list was obtained with `npm view @unbrained/pm-cli versions --json`. Each capability was bisected over stable published releases, with its first providing release and adjacent previous stable release inspected. Prereleases do not satisfy these stable npm minimum ranges. Tarballs were downloaded with `npm pack @unbrained/pm-cli@VERSION --ignore-scripts` into an isolated scratch directory and inspected as data. No downloaded pm package code or lifecycle script was executed.

Public module exports were checked against both `package.json` entrypoints and the static ESM runtime export graph, then their `dist` declarations. Client methods and context members were read from the published declarations, including inherited members and static methods. A context property is attributed to the context used by this package, rather than a later base-interface refactor. TypeScript symbol resolution covers aliases, typed lazy loaders, destructuring, and clients passed through helpers. Erased interfaces do not create runtime requirements; imported function/constructor types used by loaders are retained conservatively.

This establishes API availability. It does not attest older-host runtime semantics, provider integration, or execution on the declared minimum. The current pinned SDK remains the local test host.

## API to first-version table

The machine-readable source inventory and artifact hashes are in [sdk-floor.json](sdk-floor.json). Source locations refer to the audited main commit.

| Used API | First stable release | Previous stable release lacking it | Source uses |
| --- | --- | --- | --- |
| `@unbrained/pm-cli/sdk :: effectiveItemFormatVersion` | 2026.6.21 | 2026.6.20 | [diagnostic-probes.ts:5](../diagnostic-probes.ts#L5) |
| `@unbrained/pm-cli/sdk :: getHistoryPath` | 2026.5.14 | 2026.5.12 | [diagnostic-probes.ts:5](../diagnostic-probes.ts#L5) |
| `@unbrained/pm-cli/sdk :: getWorkspaceHistoryPath` | 2026.7.24 | 2026.7.23 | [evidence-expiry.ts:3](../evidence-expiry.ts#L3) |
| `@unbrained/pm-cli/sdk :: listAllItemMetadata` | 2026.7.13 | 2026.7.12 | [diagnostic-probes.ts:5](../diagnostic-probes.ts#L5) |
| `@unbrained/pm-cli/sdk :: listAssuranceVerdicts` | 2026.8.11 | 2026.8.10 | [evidence-expiry.ts:3](../evidence-expiry.ts#L3) |
| `@unbrained/pm-cli/sdk :: locateItem` | 2026.5.14 | 2026.5.12 | [diagnostic-probes.ts:5](../diagnostic-probes.ts#L5) |
| `@unbrained/pm-cli/sdk :: PmClient` | 2026.7.6 | 2026.7.5 | [backend-capabilities.ts:6](../backend-capabilities.ts#L6) |
| `@unbrained/pm-cli/sdk :: PmCliError` | 2026.5.14 | 2026.5.12 | [backend-capabilities.ts:6](../backend-capabilities.ts#L6) |
| `@unbrained/pm-cli/sdk :: readHistorySnapshot` | 2026.9.8 | 2026.9.7 | [diagnostic-probes.ts:5](../diagnostic-probes.ts#L5), [evidence-expiry.ts:3](../evidence-expiry.ts#L3) |
| `@unbrained/pm-cli/sdk :: readLocatedItem` | 2026.5.14 | 2026.5.12 | [diagnostic-probes.ts:5](../diagnostic-probes.ts#L5) |
| `@unbrained/pm-cli/sdk :: readSettings` | 2026.5.14 | 2026.5.12 | [backend-capabilities.ts:6](../backend-capabilities.ts#L6) |
| `@unbrained/pm-cli/sdk :: readSettingsWithMetadata` | 2026.7.23 | 2026.7.22 | [diagnostic-probes.ts:5](../diagnostic-probes.ts#L5) |
| `@unbrained/pm-cli/sdk :: resolveItemTypeRegistry` | 2026.5.14 | 2026.5.12 | [backend-capabilities.ts:6](../backend-capabilities.ts#L6), [diagnostic-probes.ts:5](../diagnostic-probes.ts#L5) |
| `@unbrained/pm-cli/sdk :: runWithConfigurationOnlySettings` | 2026.10.2 | 2026.10.1 | [diagnostic-probes.ts:5](../diagnostic-probes.ts#L5) |
| `@unbrained/pm-cli/sdk :: scanItemFormatVersions` | 2026.6.21 | 2026.6.20 | [diagnostic-probes.ts:5](../diagnostic-probes.ts#L5) |
| `@unbrained/pm-cli/sdk :: validateAssertionDefinition` | 2026.8.11 | 2026.8.10 | [evidence-expiry.ts:3](../evidence-expiry.ts#L3) |
| `@unbrained/pm-cli/sdk :: verifyHistoryEntries` | 2026.7.24 | 2026.7.23 | [diagnostic-probes.ts:5](../diagnostic-probes.ts#L5) |
| `@unbrained/pm-cli/sdk :: verifyHistoryRecordHash` | 2026.9.4 | 2026.9.3 | [evidence-expiry.ts:3](../evidence-expiry.ts#L3) |
| `@unbrained/pm-cli/sdk :: WORKSPACE_HISTORY_ID` | 2026.7.24 | 2026.7.23 | [evidence-expiry.ts:3](../evidence-expiry.ts#L3) |
| `@unbrained/pm-cli/sdk/merge :: auditMergeAttributeFence` | 2026.7.26 | 2026.7.25 | [index.ts:14](../index.ts#L14) |
| `@unbrained/pm-cli/sdk/merge :: auditMergeDriverConfiguration` | 2026.7.27 | 2026.7.26 | [index.ts:14](../index.ts#L14) |
| `@unbrained/pm-cli/sdk/merge :: findGitWorkspaceRoot` | 2026.7.26 | 2026.7.25 | [index.ts:14](../index.ts#L14) |
| `@unbrained/pm-cli/sdk/merge :: listMergeReceipts` | 2026.7.27 | 2026.7.26 | [index.ts:14](../index.ts#L14) |
| `AssuranceMeasurementProviderContext.key` | 2026.8.13 | 2026.8.12 | [assurance.ts:618](../assurance.ts#L618), [assurance.ts:629](../assurance.ts#L629) |
| `CommandHandlerContext.args` | 2026.5.1 | 2026.3.12 | [index.ts:291](../index.ts#L291), [index.ts:2987](../index.ts#L2987) |
| `CommandHandlerContext.global` | 2026.5.1 | 2026.3.12 | [index.ts:292](../index.ts#L292), [index.ts:3001](../index.ts#L3001) |
| `CommandHandlerContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:206](../index.ts#L206), [index.ts:208](../index.ts#L208), [index.ts:288](../index.ts#L288), [index.ts:2646](../index.ts#L2646), [index.ts:2665](../index.ts#L2665), [index.ts:2666](../index.ts#L2666), [index.ts:2667](../index.ts#L2667), [index.ts:2668](../index.ts#L2668), [index.ts:2669](../index.ts#L2669), [index.ts:2670](../index.ts#L2670), [index.ts:2692](../index.ts#L2692), [index.ts:2710](../index.ts#L2710), [index.ts:2711](../index.ts#L2711), [index.ts:2713](../index.ts#L2713), [index.ts:2714](../index.ts#L2714), [index.ts:2877](../index.ts#L2877), [index.ts:2986](../index.ts#L2986) |
| `CommandHandlerContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:2674](../index.ts#L2674), [index.ts:2677](../index.ts#L2677), [index.ts:2694](../index.ts#L2694), [index.ts:2714](../index.ts#L2714) |
| `ExtensionApi.registerAssuranceMeasurementProvider` | 2026.8.13 | 2026.8.12 | [index.ts:2638](../index.ts#L2638) |
| `ExtensionApi.registerCommand` | 2026.5.1 | 2026.3.12 | [index.ts:2640](../index.ts#L2640), [index.ts:2652](../index.ts#L2652), [index.ts:2684](../index.ts#L2684), [index.ts:2699](../index.ts#L2699), [index.ts:2718](../index.ts#L2718), [index.ts:2746](../index.ts#L2746), [index.ts:2797](../index.ts#L2797), [index.ts:2855](../index.ts#L2855), [index.ts:2887](../index.ts#L2887), [index.ts:2913](../index.ts#L2913), [index.ts:2938](../index.ts#L2938), [index.ts:2963](../index.ts#L2963), [index.ts:3031](../index.ts#L3031), [index.ts:3102](../index.ts#L3102) |
| `ExtensionApi.registerParser` | 2026.5.1 | 2026.3.12 | [index.ts:3140](../index.ts#L3140) |
| `ExtensionApi.registerRenderer` | 2026.5.1 | 2026.3.12 | [index.ts:2615](../index.ts#L2615), [index.ts:2628](../index.ts#L2628), [index.ts:2629](../index.ts#L2629) |
| `PmClient.get` | 2026.7.6 | 2026.7.5 | [backend-capabilities.ts:219](../backend-capabilities.ts#L219) |
| `PmClient.listAllComplete` | 2026.8.18 | 2026.8.17 | [backend-capabilities.ts:211](../backend-capabilities.ts#L211) |

## Tarball provenance

SHA-256 of the exact packed `.tgz` bytes; package archives and extracted files are not committed.

| pm release | Tarball SHA-256 |
| --- | --- |
| 2026.3.12 | `4e4e6a33cb45d665f072120e9e1ce25d2e5773e738cbc914b29e8f54367747fb` |
| 2026.5.1 | `730de8b79aa0074dc2ca81a54ce37f9aaa0a4167b690c9a62b87d2121a8b37f7` |
| 2026.5.12 | `42dcaef84dc441b7792aeffa059bfe10a86ae8b12b1084472229bba03fb29910` |
| 2026.5.14 | `7f7e9131afadb891344bf2fb93b15bc157d18c532a5da4ec31677957d37b7260` |
| 2026.6.20 | `aba2e84e4f025d5f3590ab263c05d292c6c2e2f6f179252bf996b471281cbd20` |
| 2026.6.21 | `3f9f6d4aa12d32f1570a895e2499ea61d15d7b1266c5157b93d2b272b90e963c` |
| 2026.7.5 | `4a6664f68120cace5648faf48d51b08c14e969d9c7e185e592f1a0fceae57274` |
| 2026.7.6 | `0d6e446cf93a0f0660ce4e21943adf1e0c21381010ef67369f40cc9834b8d158` |
| 2026.7.12 | `a612224324e3ae91e2fc8c25f83d9a65fc13db66914aeb04ee65e16a523521be` |
| 2026.7.13 | `10d5b0f8787c643cb8caf58f656cc95097f6ac84fcdaa6ff59911780fcd894a5` |
| 2026.7.22 | `d013832d6afc97c9a5c6f4a48a497f54a216643f8c7017b9c4f807ce6607532b` |
| 2026.7.23 | `caf1a21b0b587dc55c3509654466dd1e20383e30f2d17b47678887a15a5490af` |
| 2026.7.24 | `ae7757c7e4b02bf5c0908a7bcfd487926912bc2f71332c68c9e1be4017d796ab` |
| 2026.7.25 | `20dfec2ca4ddfcebd484af686b76aebcb1f479a7b81c781380a7fe6b6f8506f5` |
| 2026.7.26 | `b10b647a7fce423106dfb964934ac2d43b8770f8f085df89a13c9a04e75569cc` |
| 2026.7.27 | `d42dc525a76d61662929adfbd3e160f6411f0991b1913c0de274d329b46495d4` |
| 2026.8.10 | `04a015fec8f2f448a0e184977c350ebfc4c409ff3025b4956770c45c90dda193` |
| 2026.8.11 | `9d330a904e73d46ceff88153c6715ecf5480d27194ad225029b4e190c148075f` |
| 2026.8.12 | `c8cb9c030106c7998e247ba1496a7e1f66a3ba30c2ef1fc97d7d1211c23466d6` |
| 2026.8.13 | `c75cdabb8b82ca219e2d669589065039f20de5ac6ac93f5fc589aa284ca621d1` |
| 2026.8.17 | `fda330eb4887031751889ef85b510d52886fa5f70b4813f3951d7eed705023f2` |
| 2026.8.18 | `b00374f0e32c98ccec03a5893d8bfbbae45650f44bd04292ceafd8d9aac059f7` |
| 2026.9.3 | `3159cb0dc1bb73be81ea44f2923f41c7cb8945d5cff6af6598a7331a466f8e90` |
| 2026.9.4 | `4e77a3ff4e20ec62dbdfe8efeb8e8816893f802dbcdb5532017731325d3daa07` |
| 2026.9.7 | `9befaac9056ce94b2dff006e0fe2329c0b0c18479bf9c9f9027684789387c7ae` |
| 2026.9.8 | `529c08a4cb65507f86dc3f9b7efd673a031c6491156ae753c0a058d0d48e10bc` |
| 2026.10.1 | `54eafd4428b5554a1860aa5311349f7dff167a63560f55e7f1315da63a775c02` |
| 2026.10.2 | `d1cc9a7c6ccc1da01788cf307be73cca81089215a88a63ce41c32803fdc45e3e` |

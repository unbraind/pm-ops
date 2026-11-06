# Private release verification runtime

The trusted workflow checkout installs this locked, script-disabled runtime only when registry provenance needs verification. Normal pm-ops package consumers do not install it. An empty reconciliation does not install anything.

Sigstore 4.1.1 preserves Node 22.18 compatibility. Glob 14.0.2 fixes [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4); the override applies at this private installation root. Root npm overrides do not propagate into downstream packages, so this graph is kept separate from the published package. CI audits this lockfile through `audit:release-tools`.

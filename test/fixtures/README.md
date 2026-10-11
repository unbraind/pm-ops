`npm-signature-audit.json` records the verified entry for the public
`pm-ops@2026.8.28` coordinate from npm 11.17.0 on 2026-10-07. It retains the
original signed bundles, removing unrelated dependency entries. Recording used
a disposable private installation with `npm install pm-ops@2026.8.28
--ignore-scripts --no-audit --no-fund --legacy-peer-deps
--registry=https://registry.npmjs.org/`, followed by `npm audit signatures
--json --include-attestations --registry=https://registry.npmjs.org/`.
No publish or GitHub write was performed. Tests read the recording offline.

A contemporaneous `npm view pm-ops@2026.8.28 name version gitHead --json
--prefer-online --registry=https://registry.npmjs.org/` returned gitHead
`5b6fbe73b7072d49c41d5cb3cad4d44142f3fe4a`. The signed SLSA source names
`c7da4bf04039c3e0543026d003e9ee7bcd8615cd`. This real mismatch must refuse
repair; signature validity alone does not bind the artifact to a release commit.

`release-provenance.json` is a synthetic normalized version of that response
schema with placeholder commit and payload fields. Tests substitute their local
fixture commit and repository, so they can exercise successful recovery with a
real git repository. These transformed envelopes are not claimed to be signed;
the injected npm audit boundary supplies verification outcomes. Production
accepts bundles only after the real npm signature-audit process succeeds.

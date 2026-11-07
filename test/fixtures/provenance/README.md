# Public signed provenance fixture

`sigstore-4.1.1.json` is the public npm attestation envelope for `sigstore@4.1.1`, retrieved from the npm registry attestation URL in that version's `dist` metadata. It contains the signed SLSA statement, Fulcio certificate and transparency evidence; it contains no package tarball or private credentials.

Source: https://registry.npmjs.org/sigstore/4.1.1

The tests authenticate it with the Sigstore client and authenticated public trust roots. Mutations of its signature, payload and expected signer must fail. This is verification only; the tests never sign or publish.

`trusted-root.json` is the authenticated public Sigstore trust target retrieved through the Sigstore TUF client from https://tuf-repo-cdn.sigstore.dev/targets/trusted_root.json. Tests replace only TUF trust-target retrieval with these fixed public keys; the production Sigstore client still verifies the actual certificate chain, signature, signer policy, SCT and transparency evidence. Production continues to retrieve authenticated trust material through TUF. This isolates the network boundary so tests do not depend on live TUF availability.

The certificate source repository, commit and ref extensions are checked independently of signed JSON, using [Fulcio source OIDs](https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md). A certificate for the shared reusable signer cannot impersonate another caller.

/** Keep independent repair compatible with direct and reusable publication certificate identities. */
import './provenance-trust-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { originalPublicationSigner, type ProvenanceIdentity, type verifySigstoreBundle } from '../release-provenance.ts';
import { readPublicationRun, runVerifyRegistryProvenance } from '../scripts/verify-registry-provenance.ts';

const identity: ProvenanceIdentity = { repository: 'sigstore/sigstore-js', workflow: '.github/workflows/release.yml', ref: 'refs/heads/main',
  commit: 'c1dc7d4778a450787fc72b083f2490ad02b714c6', integrity: 'sha512-endqECJkfhozrXMK5ngu/UAA0xVcVEFdnHJCElGaExypjW+HK5i6zu3NteLoaX/iFbRUbC3+DjttQs0GARr+5w==' };
const canonical = 'unbraind/pm-ops/.github/workflows/daily-release.yml@', sha = 'f'.repeat(40);

/** Read public signed bytes, optionally changing lookup hints solely for boundary-policy fixtures. */
function fixture(expected = identity, invocation: unknown = `https://github.com/${expected.repository}/actions/runs/26312671957/attempts/1`) {
  const bundle = JSON.parse(readFileSync(new URL('fixtures/provenance/sigstore-4.1.1.json', import.meta.url), 'utf8')) as { attestations: { predicateType: string; bundle: { dsseEnvelope: { payload: string } } }[] };
  const entry = bundle.attestations.find(value => value.predicateType === 'https://slsa.dev/provenance/v1')!;
  const claim = JSON.parse(Buffer.from(entry.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  claim.predicate.buildDefinition.externalParameters.workflow = { repository: 'https://github.com/' + expected.repository, path: expected.workflow, ref: expected.ref };
  claim.predicate.runDetails.metadata.invocationId = invocation;
  entry.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(claim)).toString('base64');
  return bundle;
}

/** Authoritative original-run fixture, independent of the current caller pin. */
function publicationRun(expected = identity) {
  return { repository: { full_name: expected.repository }, head_branch: 'main', head_sha: expected.commit, event: 'workflow_dispatch', path: expected.workflow + '@main', run_attempt: 1,
    referenced_workflows: [{ path: canonical + sha, sha }] };
}

/** Restore every workflow input after an in-process verifier fixture. */
async function withIdentity(callback: () => Promise<void>): Promise<void> {
  const values = { GITHUB_REPOSITORY: identity.repository, CALLER_WORKFLOW: identity.repository + '/' + identity.workflow + '@refs/heads/main', EXPECTED_COMMIT: identity.commit,
    EXPECTED_INTEGRITY: identity.integrity, PROVENANCE_RECOVERY: 'true' };
  const saved = new Map([...Object.keys(values), 'PROVENANCE_SIGNER_WORKFLOW', 'GH_TOKEN'].map(key => [key, process.env[key]]));
  Object.assign(process.env, values); delete process.env.PROVENANCE_SIGNER_WORKFLOW;
  try { await callback(); }
  finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('legacy direct repair still verifies real signed provenance without original-run lookup', async () => {
  await withIdentity(async () => {
    const signed = JSON.parse(readFileSync(new URL('fixtures/provenance/sigstore-4.1.1.json', import.meta.url), 'utf8'));
    assert.equal(await runVerifyRegistryProvenance(signed, async () => { throw new Error('Legacy publication must not require lookup'); }), true);
    process.env.PROVENANCE_SIGNER_WORKFLOW = identity.repository + '/' + identity.workflow + '@' + identity.ref;
    assert.equal(await runVerifyRegistryProvenance(signed, async () => { throw new Error('Explicit signer must not require lookup'); }), true);
  });
});

test('reusable repair resolves original signer before the cryptographic boundary and never accepts lookup alone', async () => {
  await withIdentity(async () => {
    const seen: (string | undefined)[] = [];
    const verify: typeof verifySigstoreBundle = async (_bundle, expected) => { seen.push(expected.signerWorkflow); if (expected.signerWorkflow !== canonical + sha) throw new Error('Fixture signer mismatch'); };
    const readRun = async (path: string) => { assert.equal(path, 'repos/sigstore/sigstore-js/actions/runs/26312671957/attempts/1'); return publicationRun(); };
    assert.equal(await runVerifyRegistryProvenance(fixture(), readRun, verify), true);
    assert.deepEqual(seen, [undefined, canonical + sha]);
    await assert.rejects(runVerifyRegistryProvenance(fixture(), readRun, async () => { throw new Error('Signature refused'); }), /Signature refused/);
    assert.equal(await runVerifyRegistryProvenance({}, readRun, verify).catch(() => false), false);
  });
});

test('original signer lookup preserves local reusable, named refs and legacy invocation forms', async () => {
  assert.equal(await originalPublicationSigner(fixture(), identity, async () => publicationRun()), canonical + sha);
  for (const ref of ['main', 'refs/heads/main', 'refs/tags/v2026.11.06']) {
    const run = publicationRun(); run.referenced_workflows[0].path = canonical + ref;
    assert.equal(await originalPublicationSigner(fixture(), identity, async () => run), canonical + (ref === 'main' ? 'refs/heads/main' : ref));
  }
  const self = { ...identity, repository: 'unbraind/pm-ops' }, run = publicationRun(self);
  assert.equal(await originalPublicationSigner(fixture(self), self, async () => ({ ...run, referenced_workflows: undefined })), canonical + 'refs/heads/main');
  const invocation = 'https://github.com/' + identity.repository + '/actions/runs/26312671957';
  assert.equal(await originalPublicationSigner(fixture(identity, invocation), identity, async path => { assert.ok(!path.includes('/attempts/')); return publicationRun(); }), canonical + sha);
  const qualified = publicationRun(); qualified.path = identity.repository + '/' + identity.workflow + '@' + identity.commit;
  assert.equal(await originalPublicationSigner(fixture(), identity, async () => qualified), canonical + sha);
});

test('original signer lookup refuses foreign, ambiguous and unsafe invocation hints before reads', async () => {
  for (const invocation of [null, 1, 'https://github.com/other/package/actions/runs/1', 'https://github.com/' + identity.repository.replace(/^./, 'x') + '/actions/runs/1', 'https://github.com/' + identity.repository + '/actions/runs/0',
    'https://github.com/' + identity.repository + '/actions/runs/9999999999999999999999', 'https://github.com/' + identity.repository + '/actions/runs/1/attempts/9999999999999999999999']) {
    await assert.rejects(originalPublicationSigner(fixture(identity, invocation), identity, async () => { throw new Error('Unsafe lookup reached the transport'); }), /invocation/);
  }
  await assert.rejects(originalPublicationSigner({}, identity, async () => null), /invocation/);
  const duplicate = fixture(), other = fixture(identity, 'https://github.com/' + identity.repository + '/actions/runs/2');
  duplicate.attestations.push(other.attestations.find(entry => entry.predicateType === 'https://slsa.dev/provenance/v1')!);
  await assert.rejects(originalPublicationSigner(duplicate, identity, async () => null), /ambiguous/);
});

test('original signer lookup binds run source, attempt and canonical reusable identity', async () => {
  const bad: unknown[] = [null];
  for (const change of [{ repository: { full_name: 'other/package' } }, { head_branch: 'feature' }, { head_sha: '0'.repeat(40) }, { event: 'push' }, { path: '.github/workflows/foreign.yml' },
    { run_attempt: 2 }, { referenced_workflows: {} }, { referenced_workflows: [] }, { referenced_workflows: [{ path: canonical + sha, sha }, { path: canonical + sha, sha }] },
    { referenced_workflows: [{ path: 'other/shared/.github/workflows/daily-release.yml@' + sha, sha }] }, { referenced_workflows: [{ path: 'x'.repeat(canonical.length) + sha, sha }] }, { referenced_workflows: [{ sha }] }, { referenced_workflows: [{ path: canonical + sha, sha: 'bad' }] },
    { referenced_workflows: [{ path: canonical + sha, sha: 'e'.repeat(40) }] }, { referenced_workflows: [{ path: canonical + 'refs/heads/feature', sha }] }]) bad.push({ ...publicationRun(), ...change });
  for (const run of bad) await assert.rejects(originalPublicationSigner(fixture(), identity, async () => run), /publication|reusable/);
});

test('original run HTTP lookup requires a token and refuses unavailable proof', async () => {
  await withIdentity(async () => {
    const original = globalThis.fetch;
    try {
      delete process.env.GH_TOKEN; await assert.rejects(readPublicationRun('repos/example/package/actions/runs/1'), /Missing token/);
      process.env.GH_TOKEN = 'synthetic-recovery-token';
      globalThis.fetch = async (url, init) => { assert.equal(String(url), 'https://api.github.com/repos/example/package/actions/runs/1'); assert.ok(init?.signal); return new Response('{"fixture":true}'); };
      assert.deepEqual(await readPublicationRun('repos/example/package/actions/runs/1'), { fixture: true });
      globalThis.fetch = async () => new Response('{}', { status: 404 });
      await assert.rejects(readPublicationRun('repos/example/package/actions/runs/1'), /unavailable: 404/);
    } finally { Object.assign(globalThis, { fetch: original }); }
  });
});

test('original publishing identity uses the recorded OIDC ref independently of its implementation SHA', async () => {
  const run = { ...publicationRun(), referenced_workflows: [{ path: canonical + sha, sha, ref: 'refs/heads/main' as unknown }] };
  assert.equal(await originalPublicationSigner(fixture(), identity, async () => run), canonical + 'refs/heads/main');
  run.referenced_workflows[0].path = canonical + 'refs/heads/main';
  assert.equal(await originalPublicationSigner(fixture(), identity, async () => run), canonical + 'refs/heads/main');
  run.referenced_workflows[0].path = canonical + sha;
  run.referenced_workflows[0].ref = sha;
  assert.equal(await originalPublicationSigner(fixture(), identity, async () => run), canonical + sha);
  for (const ref of [null, 1, 'refs/heads/foreign']) {
    run.referenced_workflows[0].ref = ref;
    await assert.rejects(originalPublicationSigner(fixture(), identity, async () => run), /Untrusted original reusable signer/);
  }
  run.referenced_workflows[0].ref = 'refs/heads/main'; run.referenced_workflows[0].path = canonical + 'refs/tags/v2026.11.06';
  await assert.rejects(originalPublicationSigner(fixture(), identity, async () => run), /Untrusted original reusable signer/);
});

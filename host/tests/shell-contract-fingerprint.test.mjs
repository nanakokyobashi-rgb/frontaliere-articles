// Guards the transported host values against drift from the main repo.
//
// host/ is a copy of the main repo's site chrome — the one place in this
// migration where a second producer could not be avoided by re-exporting,
// because the host values include content-addressed asset names owned by this
// repo. Each repo records its own scalar fingerprint: main from
// build-plugins/articlesSiteShellBootstrap.ts, this repo from
// host/siteShellBootstrap.ts. Either side drifting fails its own test.
//
// If this fails after an intentional shared-contract change, recalculate both
// repo-local digests in the same change; their values can differ because the
// corpus uses content-addressed asset names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeContractEnv } from './shell-contract-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(readFileSync(path.join(HERE, '..', 'shell-contract-fingerprint.json'), 'utf-8'));

// Il digest copre `cdnPreconnectHint`, che il bootstrap risolve quando il
// campo viene letto. Azzerare l'ambiente fissa il valore di baseline vuoto,
// indipendentemente dall'ambiente del runner. Vedi shell-contract-env.mjs.
normalizeContractEnv();

test('transported SiteShellContract scalars match the recorded fingerprint', async () => {
  const { contract } = await import('../siteShellBootstrap.ts');
  const scalars = {};
  for (const k of Object.keys(contract).sort()) {
    if (typeof contract[k] !== 'function') scalars[k] = contract[k];
  }
  assert.equal(Object.keys(scalars).length, expected.scalarFields, 'scalar field count changed');
  // RegExp has no own enumerable properties, so plain JSON.stringify serializes
  // every RegExp (e.g. contextualLinkRules[].keywordPattern) to `{}` — a source/flags
  // edit wouldn't move the digest at all. The replacer forces RegExp through
  // String(v) so regex-only drift is actually covered (main repo issue #6396).
  const sha = createHash('sha256')
    .update(JSON.stringify(scalars, (_key, value) => (value instanceof RegExp ? String(value) : value), 2))
    .digest('hex');
  assert.equal(sha, expected.sha256, 'host chrome drifted from the main repo — re-record in BOTH repos');
});

test('every contract field is populated', async () => {
  const { contract } = await import('../siteShellBootstrap.ts');
  for (const [k, v] of Object.entries(contract)) {
    assert.notEqual(v, undefined, `contract.${k} is undefined`);
  }
});

test('loop-sync scalar declaration matches the transported fingerprint', () => {
  const manifest = JSON.parse(readFileSync(path.join(HERE, '..', '..', 'scripts', 'ci', 'loop-sync-manifest.json'), 'utf8'));
  const declaration = manifest.files.find((entry) => entry.path === 'host/constants.ts')?.scalarFingerprint;
  assert.ok(declaration, 'the adapted host constants must declare their scalar contract');
  assert.equal(declaration.sha256, expected.sha256, 'update the manifest declaration, preserving the historical baseline');
  assert.equal(declaration.scalarFields, expected.scalarFields);
});

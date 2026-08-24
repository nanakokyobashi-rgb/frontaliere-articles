// Guards the transported host values against drift from the main repo.
//
// host/ is a copy of the main repo's site chrome — the one place in this
// migration where a second producer could not be avoided by re-exporting,
// because the host values are what a host owns. The mitigation is that BOTH
// repos assert the same fingerprint: main from
// build-plugins/articlesSiteShellBootstrap.ts, this repo from
// host/siteShellBootstrap.ts. Either side drifting fails its own test.
//
// If this fails after an intentional change on the main side, re-record the
// digest in BOTH repos in the same change — never in one alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(readFileSync(path.join(HERE, '..', 'shell-contract-fingerprint.json'), 'utf-8'));

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

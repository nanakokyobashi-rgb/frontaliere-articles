import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beaconCandidates } from '../../scripts/ci/check-quota-backoff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('#984: i candidati del beacon comprendono issue e PR del peer senza duplicati', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');
  assert.deepEqual(
    beaconCandidates([
      [{ number: 4, updatedAt: '2026-09-08T11:00:00Z' }],
      [
        { number: 4, updatedAt: '2026-09-08T11:30:00Z' },
        { number: 7, updatedAt: '2026-09-08T11:45:00Z' },
      ],
    ], { now, lookbackH: 24, max: 12 }),
    [7, 4],
  );
});
test('#984: la lettura del beacon è collegata a PR e commenti REST paginati', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/ci/check-quota-backoff.mjs'), 'utf8');
  assert.match(src, /listPullRequests\(scope\)/,
    'il pre-flight non deve restare cieco ai beacon scritti sui thread delle PR');
  assert.match(src, /'pr', 'list'/,
    'il peer PR deve essere interrogato con la stessa finestra bounded');
  assert.match(src, /api', '--paginate', '--slurp/,
    'i commenti devono essere letti oltre la prima pagina');
  assert.match(src, /comments\?per_page=100/);
});
test('#984: le issue hanno priorità sulle PR nel tetto dei candidati', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/ci/check-quota-backoff.mjs'), 'utf8');
  assert.match(src, /const issueCandidates = beaconCandidates\(\[/);
  assert.match(src, /const prCandidates = beaconCandidates\(\[listPullRequests\(scope\)\], opts\)/);
  assert.match(src, /const candidates = \[\.\.\.issueCandidates, \.\.\.prCandidates\]/);
});

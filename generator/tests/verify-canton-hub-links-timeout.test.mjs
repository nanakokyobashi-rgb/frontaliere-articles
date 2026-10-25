import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('il verifier degli hub limita headers e body delle sitemap', () => {
  const verifier = readFileSync(resolve(ROOT, 'generator/scripts/verify-canton-hub-links.mjs'), 'utf8');
  assert.match(verifier, /HUB_LINKS_FETCH_TIMEOUT_MS/);
  assert.match(verifier, /signal:\s*AbortSignal\.timeout\(HUB_LINKS_FETCH_TIMEOUT_MS\)/);
  assert.match(verifier, /new Error\(err\?\.message \|\| String\(err\), \{ cause: err \}\)/);
  assert.match(verifier, /Math\.min\(Math\.max\(1, Math\.floor\(raw\)\), 120_000\)/);
});

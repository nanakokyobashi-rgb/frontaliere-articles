/**
 * ticker-shadow-alert.mjs — issue #302, follow-up a #293/#166.
 * `node --test`.
 *
 * #293 ha reso `counts.tickerArticlesShadowed` visibile in `manifest.json`
 * ma deliberatamente detect-only (nessun gate blocca il publish). #302
 * chiedeva un canale di notifica per quando quel conteggio smette di essere
 * 0/5. Questa suite copre solo la logica pura (nessuna chiamata `gh`/rete):
 * `evaluateTickerShadow` e la stabilità del titolo di dedup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TITLE, evaluateTickerShadow, buildAlertBody } from '../../scripts/ci/ticker-shadow-alert.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('evaluateTickerShadow: firing when tickerArticlesShadowed > 0', () => {
  const v = evaluateTickerShadow({ counts: { tickerArticlesShadowed: 2, tickerArticles: 5 } });
  assert.deepEqual(v, { available: true, firing: true, shadowed: 2, total: 5 });
});

test('evaluateTickerShadow: not firing at exactly 0', () => {
  const v = evaluateTickerShadow({ counts: { tickerArticlesShadowed: 0, tickerArticles: 5 } });
  assert.equal(v.available, true);
  assert.equal(v.firing, false);
});

test('evaluateTickerShadow: unavailable (not "sano") when the field is missing — must not resolve a real alert', () => {
  assert.deepEqual(evaluateTickerShadow({ counts: {} }), { available: false });
  assert.deepEqual(evaluateTickerShadow({}), { available: false });
  assert.deepEqual(evaluateTickerShadow(null), { available: false });
});

test('evaluateTickerShadow: unavailable when the field is not numeric', () => {
  const v = evaluateTickerShadow({ counts: { tickerArticlesShadowed: 'oops' } });
  assert.deepEqual(v, { available: false });
});

test('evaluateTickerShadow: total falls back to null when missing/non-numeric, without affecting firing', () => {
  const v = evaluateTickerShadow({ counts: { tickerArticlesShadowed: 1 } });
  assert.equal(v.available, true);
  assert.equal(v.firing, true);
  assert.equal(v.total, null);
});

test('TITLE carries no run-specific number — it is the dedup/resolve key', () => {
  assert.equal(/\d/.test(TITLE), false);
  assert.ok(TITLE.length > 0 && TITLE.length <= 200);
});

test('buildAlertBody mentions the shadowed count and does not silently drop a null total', () => {
  const body = buildAlertBody(
    { commit: 'abc123', generatedAt: '2026-08-14T00:00:00.000Z' },
    { shadowed: 3, total: 5 },
  );
  assert.match(body, /3 su 5/);
  assert.match(body, /abc123/);

  const bodyNoTotal = buildAlertBody({}, { shadowed: 1, total: null });
  assert.match(bodyNoTotal, /\*\*1\*\*/);
});

// Regression guard for the actual wiring: a script nobody calls is not a fix.
test('publish-api.yml runs ticker-shadow-alert.mjs against the built manifest, non-blocking', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'publish-api.yml'), 'utf-8');
  assert.match(
    workflow,
    /node scripts\/ci\/ticker-shadow-alert\.mjs/,
    'publish-api.yml no longer calls ticker-shadow-alert.mjs — #302 regresses to detect-with-no-notification',
  );
});

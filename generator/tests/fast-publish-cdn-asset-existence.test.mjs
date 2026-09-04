/**
 * L'asset riscritto sul CDN deve essere verificato, non presunto. Run with `node --test`.
 *
 * IL DIFETTO (follow-up di #764, issue #788). `offload-generated-images-cdn.mjs`
 * riscrive ogni `/assets/<file>` same-origin su `${CDN_BASE}` senza guardia di
 * esistenza. Per og/data/images l'ordine del deploy la rende superflua (i byte
 * sono stati caricati prima dello script); per `/assets/` no — questo repo non
 * builda né spinge `dist/assets`, e da #764 il contratto trasporta anche
 * `/assets/partnerize-tag.js`, emesso dal SITO. Un articolo fast-published può
 * quindi puntare per un tempo indefinito a un oggetto che 404a: nessuna
 * eccezione, nessun gate rosso, zero tracking affiliato.
 *
 * La verifica è deliberatamente NON-FATALE e fail-open (un 5xx o un DNS che
 * flappa non accusa il CDN), quindi il rischio non è che rompa: è che smetta di
 * essere chiamata, o che chiami e non dica niente. Questi test difendono le due
 * cose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectCdnAssetRefs,
  verifyCdnAssetRefs,
  formatCdnAssetReport,
} from '../../scripts/lib/cdn-asset-existence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CDN = 'https://cdn.frontaliereticino.ch';

test('collectCdnAssetRefs raccoglie gli URL riscritti, distinti e in ordine', () => {
  const html = [
    `<link rel="stylesheet" href="${CDN}/assets/index-abc123.css">`,
    `<script defer src="${CDN}/assets/partnerize-tag.js"></script>`,
    `<script type="module" src="${CDN}/assets/index-abc123.css"></script>`, // duplicato
  ].join('\n');
  assert.deepEqual(collectCdnAssetRefs(html, CDN), [
    `${CDN}/assets/index-abc123.css`,
    `${CDN}/assets/partnerize-tag.js`,
  ]);
});

test('collectCdnAssetRefs ignora ciò che non è stato riscritto su QUESTO cdnBase', () => {
  const html = [
    '<script src="/assets/non-riscritto.js"></script>',
    '<script src="https://altro.example/assets/estraneo.js"></script>',
    `<img src="${CDN}/images/blog/foo.webp">`,
  ].join('\n');
  assert.deepEqual(collectCdnAssetRefs(html, CDN), []);
  // Un cdnBase vuoto non deve degenerare in una regex che matcha tutto.
  assert.deepEqual(collectCdnAssetRefs(html, ''), []);
});

test('verifyCdnAssetRefs: 200 presente, 404 mancante, 5xx e rete restano unknown', async () => {
  const answers = {
    [`${CDN}/assets/ok.js`]: { ok: true, status: 200 },
    [`${CDN}/assets/manca.js`]: { ok: false, status: 404 },
    [`${CDN}/assets/rotto.js`]: { ok: false, status: 503 },
  };
  const results = await verifyCdnAssetRefs({
    urls: [`${CDN}/assets/ok.js`, `${CDN}/assets/manca.js`, `${CDN}/assets/rotto.js`, `${CDN}/assets/giu.js`],
    fetchImpl: async (url) => {
      if (!answers[url]) throw new Error('ENOTFOUND');
      return answers[url];
    },
  });
  assert.deepEqual(
    results.map((r) => [r.url, r.state, r.status]),
    [
      [`${CDN}/assets/ok.js`, 'present', 200],
      [`${CDN}/assets/manca.js`, 'missing', 404],
      [`${CDN}/assets/rotto.js`, 'unknown', 503],
      [`${CDN}/assets/giu.js`, 'unknown', null],
    ],
  );
});

test('verifyCdnAssetRefs ripiega su GET quando HEAD non è implementata', async () => {
  const seen = [];
  const results = await verifyCdnAssetRefs({
    urls: [`${CDN}/assets/solo-get.js`],
    fetchImpl: async (_url, opts) => {
      seen.push(opts.method);
      return opts.method === 'HEAD' ? { ok: false, status: 405 } : { ok: true, status: 200 };
    },
  });
  assert.deepEqual(seen, ['HEAD', 'GET']);
  assert.equal(results[0].state, 'present');
});

test('formatCdnAssetReport avvisa SOLO sui mancanti', () => {
  const lines = formatCdnAssetReport([
    { url: `${CDN}/assets/ok.js`, state: 'present', status: 200, error: null },
    { url: `${CDN}/assets/partnerize-tag.js`, state: 'missing', status: 404, error: null },
    { url: `${CDN}/assets/rotto.js`, state: 'unknown', status: 503, error: null },
  ]);
  const warnings = lines.filter((l) => l.startsWith('::warning::'));
  assert.equal(warnings.length, 1, 'un unknown non deve produrre un avviso: è rumore di rete');
  assert.match(warnings[0], /partnerize-tag\.js/);
  assert.match(warnings[0], /404/);
  assert.ok(
    lines.some((l) => /1 presenti ; 1 mancanti ; 1 non verificabili/.test(l)),
    'manca la riga di riepilogo',
  );
});

test('publish-article-fast.mjs verifica gli asset DOPO l\'offload', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/publish-article-fast.mjs'), 'utf-8');
  const offloadAt = src.indexOf('offload-generated-images-cdn.mjs');
  const checkAt = src.indexOf('cdn-asset-existence.mjs');
  assert.ok(offloadAt > 0, 'lo step di offload è sparito da publish-article-fast.mjs');
  assert.ok(
    checkAt > 0,
    'publish-article-fast.mjs non importa più scripts/lib/cdn-asset-existence.mjs: ' +
      'i /assets/ riscritti sul CDN tornano a essere presunti esistenti (#788).',
  );
  assert.ok(
    checkAt > offloadAt,
    'la verifica gira PRIMA dell\'offload: lì gli URL CDN non esistono ancora nell\'HTML e ' +
      'la verifica non guarda niente.',
  );
});

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
  hasSameOriginAssetRef,
  verifyCdnAssetRefs,
  formatCdnAssetReport,
  formatOffloadCoverageReport,
} from '../../scripts/lib/cdn-asset-existence.mjs';
import { ASSET_EXT_ALTERNATION } from '../../host/shared/cdnAssetOffloadRx.mjs';

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

// ═══════════════════════════════════════════════════════════════════════════
// #817 item 1 — «offload fallito» non deve leggersi come «niente da riscrivere»
// ═══════════════════════════════════════════════════════════════════════════

test('hasSameOriginAssetRef distingue il ref non riscritto da quello riscritto', () => {
  assert.equal(hasSameOriginAssetRef('<link rel="stylesheet" href="/assets/index-abc.css">'), true);
  assert.equal(hasSameOriginAssetRef('<script src="assets/partnerize-tag.js"></script>'), true);
  assert.equal(hasSameOriginAssetRef(`<script src="${CDN}/assets/partnerize-tag.js"></script>`), false);
  assert.equal(hasSameOriginAssetRef('<p>nessun asset</p>'), false);
  assert.equal(hasSameOriginAssetRef(''), false);
});

test('IL DIFETTO: offload non eseguito e «niente da riscrivere» hanno righe DIVERSE', () => {
  // Offload fallito: lo script e' non-fatale, lascia dist intatto ed esce 0.
  // Zero URL CDN — identico al caso sano, se non fosse per il same-origin.
  const rotto = formatOffloadCoverageReport({
    cdnRefCount: 0,
    sameOriginFiles: ['it/articolo/index.html', 'en/article/index.html'],
  });
  assert.ok(
    rotto.some((l) => l.startsWith('::warning::')),
    'un offload che non ha riscritto niente deve produrre un avviso: e\' l\'unico punto in cui ' +
      'quel guasto e\' osservabile, perche\' lo script esce 0',
  );
  assert.match(rotto[0], /SAME-ORIGIN/);
  assert.match(rotto[0], /it\/articolo\/index\.html/);

  // Caso sano: nessun asset da nessuna parte.
  const sano = formatOffloadCoverageReport({ cdnRefCount: 0, sameOriginFiles: [] });
  assert.equal(sano.filter((l) => l.startsWith('::warning::')).length, 0);
  assert.notDeepEqual(sano, rotto, 'i due mondi devono essere distinguibili nel log');
  assert.match(sano[0], /niente da riscrivere/);

  // Offload riuscito: parla il report delle HEAD, non la copertura.
  assert.deepEqual(formatOffloadCoverageReport({ cdnRefCount: 3, sameOriginFiles: [] }), []);
});

test('publish-article-fast.mjs raccoglie anche i same-origin superstiti', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/publish-article-fast.mjs'), 'utf-8');
  assert.ok(
    src.includes('hasSameOriginAssetRef') && src.includes('formatOffloadCoverageReport'),
    'lo step 7b non distingue piu\' un offload fallito da «niente da riscrivere» (#817)',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// #817 item 2 — un tetto sulle HEAD, e il tetto si vede
// ═══════════════════════════════════════════════════════════════════════════

test('verifyCdnAssetRefs si ferma al tetto di URL e marca il resto skipped', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { ok: true, status: 200 };
  };
  const urls = Array.from({ length: 5 }, (_, i) => `${CDN}/assets/a${i}.js`);
  const res = await verifyCdnAssetRefs({ urls, fetchImpl, maxUrls: 2 });
  assert.equal(seen.length, 2, 'il tetto non ha fermato le richieste: il costo peggiore resta non pinnato');
  assert.deepEqual(
    res.map((r) => r.state),
    ['present', 'present', 'skipped', 'skipped', 'skipped'],
  );
  assert.match(res[2].error, /tetto di 2 URL/);
});

test('verifyCdnAssetRefs si ferma al budget di tempo (CDN che pende)', async () => {
  let clock = 0;
  const fetchImpl = async () => {
    clock += 8000; // ogni HEAD costa un timeout intero
    return { ok: true, status: 200 };
  };
  const urls = Array.from({ length: 10 }, (_, i) => `${CDN}/assets/a${i}.js`);
  const res = await verifyCdnAssetRefs({ urls, fetchImpl, budgetMs: 20000, now: () => clock });
  const checked = res.filter((r) => r.state !== 'skipped');
  assert.equal(checked.length, 3, 'senza budget la verifica sarebbe costata 10 timeout in serie');
  assert.match(res[3].error, /budget di 20000ms/);
});

test('formatCdnAssetReport non conta gli skipped come verificati', () => {
  const lines = formatCdnAssetReport([
    { url: `${CDN}/assets/ok.js`, state: 'present', status: 200, error: null },
    { url: `${CDN}/assets/mai-guardato.js`, state: 'skipped', status: null, error: 'tetto di 1 URL raggiunto' },
  ]);
  assert.ok(
    lines.some((l) => /1 asset CDN distinti verificati/.test(l)),
    'lo skipped e\' finito dentro il totale dei verificati: un URL non guardato si legge come guardato',
  );
  assert.ok(lines.some((l) => /1 non guardati \(tetto\)/.test(l)));
  assert.equal(
    lines.filter((l) => l.startsWith('::warning::')).length,
    0,
    'uno skipped non e\' un difetto del CDN, non deve avvisare',
  );
});

test('l\'alfabeto delle estensioni ha UNA sorgente (AGENTS.md #6)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/cdn-asset-existence.mjs'), 'utf-8');
  assert.ok(
    src.includes('ASSET_EXT_ALTERNATION'),
    'l\'alfabeto e\' tornato a essere ricopiato: se drifta rispetto all\'offload, ' +
      'un URL riscritto smette di essere verificato senza che nulla lo dica',
  );
  // e la sorgente unica copre davvero cio' che il rewrite produce
  for (const ext of ['js', 'css', 'woff2', 'json']) {
    assert.ok(new RegExp(`\\b${ext}\\b`).test(ASSET_EXT_ALTERNATION.replace(/\|/g, ' ')));
    assert.deepEqual(collectCdnAssetRefs(`<x href="${CDN}/assets/f.${ext}">`, CDN), [`${CDN}/assets/f.${ext}`]);
  }
});

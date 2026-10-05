/**
 * Digest eventi del weekend per cantone (P9a, sezioni cantonali).
 *
 * `generate-events-digest-article.mjs` senza cantone resta il digest Ticino
 * (`eventi-weekend-ticino`, invariato); con `--canton <CODE>` o
 * `EVENTS_DIGEST_CANTON` costruisce il digest evergreen del gruppo cantonale
 * (`eventi-weekend-<slug it>`), che conta solo i suoi eventi. Nessuna rete e
 * nessuna dipendenza npm (il job unit non fa `npm ci`): il produttore importa
 * create-article.mjs, quindi qui si provano i moduli che usa — e il suo
 * cablaggio si legge dal sorgente. Il dataset e' la fixture del contratto
 * REWIRE `events-dataset`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cantonDigestSeo, digestCantonFromArgs } from '../scripts/lib/events-digest-meta.mjs';
import {
  buildWeekendDigestArticle,
  CANTON_DIGEST_ARTICLES,
  DIGEST_ARTICLE_ID,
  DIGEST_ARTICLE_SLUGS,
} from '../scripts/lib/events-digest-content.mjs';
import { loadEventsDataset } from '../scripts/lib/events-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASET = path.join(__dirname, 'fixtures', 'rewire', 'events.json');
const PRODUCER = path.join(__dirname, '..', 'scripts', 'generate-events-digest-article.mjs');
// Venerdi': il weekend della fixture e' 2026-08-15/16.
const TODAY = '2026-08-14';
const { events } = loadEventsDataset(DATASET);

describe('digestCantonFromArgs', () => {
  it('senza argomenti ne\' env resta il Ticino (undefined)', () => {
    assert.equal(digestCantonFromArgs([], {}), undefined);
  });

  it('legge --canton, --canton= e EVENTS_DIGEST_CANTON, normalizzando sul gruppo URL', () => {
    assert.equal(digestCantonFromArgs(['--canton', 'GR'], {}), 'GR');
    assert.equal(digestCantonFromArgs(['--canton=bl'], {}), 'BASILEA');
    assert.equal(digestCantonFromArgs([], { EVENTS_DIGEST_CANTON: 'VS' }), 'VS');
    assert.equal(digestCantonFromArgs(['--canton', 'TI'], {}), 'TI');
  });

  it('rifiuta un cantone sconosciuto o un --canton senza valore', () => {
    assert.throws(() => digestCantonFromArgs(['--canton', 'XX'], {}), /unknown canton/);
    assert.throws(() => digestCantonFromArgs(['--canton'], {}), /needs a canton/);
    assert.throws(() => digestCantonFromArgs(['--canton', '--dry-run'], {}), /needs a canton/);
    assert.throws(() => digestCantonFromArgs(['--canton='], {}), /needs a canton/);
    // Il flag esplicito vince sull'ambiente anche quando e' vuoto: niente ripiego silenzioso.
    assert.throws(() => digestCantonFromArgs(['--canton'], { EVENTS_DIGEST_CANTON: 'GR' }), /needs a canton/);
    assert.throws(() => digestCantonFromArgs(['--canton='], { EVENTS_DIGEST_CANTON: 'GR' }), /needs a canton/);
    assert.equal(digestCantonFromArgs(['--canton', 'BE'], { EVENTS_DIGEST_CANTON: 'GR' }), 'BE');
    assert.throws(() => digestCantonFromArgs([], { EVENTS_DIGEST_CANTON: ' ' }), /set but empty/);
  });
});

describe('digest per cantone sulla fixture events-dataset', () => {
  it('Ticino: identita\' invariata, con o senza cantone esplicito', () => {
    const ti = buildWeekendDigestArticle({ events, todayIso: TODAY });
    assert.equal(ti.id, DIGEST_ARTICLE_ID);
    assert.equal(ti.id, 'eventi-weekend-ticino');
    assert.deepEqual(ti.slugs, DIGEST_ARTICLE_SLUGS);
    assert.equal(ti.eventCount, 4);
    assert.deepEqual(buildWeekendDigestArticle({ events, todayIso: TODAY, canton: 'TI' }), ti);
  });

  it('un altro cantone: id stabile, slug dalla tabella, conteggio solo dei suoi eventi', () => {
    const sz = buildWeekendDigestArticle({ events, todayIso: TODAY, canton: 'SZ' });
    assert.equal(sz.id, 'eventi-weekend-svitto');
    assert.deepEqual(sz.slugs, CANTON_DIGEST_ARTICLES.SZ.slugs);
    assert.equal(sz.eventCount, 1);
    assert.equal(`${sz.weekendStart}..${sz.weekendEnd}`, '2026-08-15..2026-08-16');
    assert.match(sz.content.it.body1, /nel Canton Svitto ci è un evento/);
    assert.match(sz.content.it.body2, /\(\/eventi\/svitto\/einsiedeln\/\)/);
    assert.match(sz.content.de.body1, /\/de\/veranstaltungen\/schwyz\/dieses-wochenende\//);
    // Gli eventi del Ticino finiscono nella sezione "altri cantoni", non nel conteggio.
    assert.match(sz.content.it.body2, /## Eventi anche in altri cantoni/);
    assert.match(sz.content.it.body2, /\(\/eventi\/ticino\/lugano\/\)/);
  });
});

describe('metadati evergreen per cantone', () => {
  it('nominano il cantone, mai il Ticino, per tutti i 23 gruppi', () => {
    for (const group of Object.keys(CANTON_DIGEST_ARTICLES)) {
      const seo = cantonDigestSeo(group);
      const place = CANTON_DIGEST_ARTICLES[group].place.it;
      assert.equal(seo.title, `Eventi del weekend ${place}: cosa fare`);
      assert.equal(seo.headline, `Eventi del weekend ${place}: cosa fare sabato e domenica`);
      assert.doesNotMatch(JSON.stringify(seo), /Ticino|ticino/);
    }
    assert.throws(() => cantonDigestSeo('TI'), /no canton digest/);
  });

  it('il produttore passa il cantone al builder e ai metadati (cablaggio letto dal sorgente)', () => {
    const src = fs.readFileSync(PRODUCER, 'utf-8');
    assert.match(src, /const canton = digestCantonFromArgs\(\);\n\s*const data = buildData\(todayIso, \{ canton \}\);/);
    assert.match(src, /buildWeekendDigestArticle\(\{ events: dataset\.events, todayIso, canton \}\)/);
    assert.match(src, /\.\.\.staticMetaForCanton\(resolveDigestCanton\(canton\)\),/);
    assert.match(src, /if \(groupKey === 'TI'\) return STATIC_META;/);
  });
});

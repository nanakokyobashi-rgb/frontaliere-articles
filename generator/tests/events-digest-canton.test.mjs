/**
 * Digest eventi del weekend per cantone (P9a, sezioni cantonali).
 *
 * `generate-events-digest-article.mjs` senza cantone resta il digest Ticino
 * (`eventi-weekend-ticino`, invariato); con `--canton <CODE>` o
 * `EVENTS_DIGEST_CANTON` costruisce il digest evergreen del gruppo cantonale
 * (`eventi-weekend-<slug it>`), che conta solo i suoi eventi. Nessuna rete:
 * il dataset e' la fixture del contratto REWIRE `events-dataset`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildData,
  digestCantonFromArgs,
  staticMetaForCanton,
} from '../scripts/generate-events-digest-article.mjs';
import { CANTON_DIGEST_ARTICLES, DIGEST_ARTICLE_SLUGS } from '../scripts/lib/events-digest-content.mjs';
import { assertGeneratedArticleQuality, assertArticlePassesFactualityGates } from '../scripts/create-article.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATASET = path.join(__dirname, 'fixtures', 'rewire', 'events.json');
// Venerdi': il weekend della fixture e' 2026-08-15/16.
const TODAY = '2026-08-14';

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
  });
});

describe('buildData per cantone', () => {
  it('Ticino: identita\' e metadati invariati', () => {
    const ti = buildData(TODAY, { datasetPath: DATASET });
    assert.equal(ti.id, 'eventi-weekend-ticino');
    assert.deepEqual(ti.slugs, DIGEST_ARTICLE_SLUGS);
    assert.equal(ti.seo.title, 'Eventi del weekend in Ticino: cosa fare');
    assert.equal(ti.image, 'lugano-view.webp');
    assert.equal(ti._eventCount, 4);
    assert.deepEqual(buildData(TODAY, { datasetPath: DATASET, canton: 'TI' }), ti);
  });

  it('un altro cantone: id stabile, slug dalla tabella, conteggio solo dei suoi eventi', () => {
    const sz = buildData(TODAY, { datasetPath: DATASET, canton: 'SZ' });
    assert.equal(sz.id, 'eventi-weekend-svitto');
    assert.deepEqual(sz.slugs, CANTON_DIGEST_ARTICLES.SZ.slugs);
    assert.equal(sz._eventCount, 1);
    assert.equal(sz._weekend, '2026-08-15..2026-08-16');
    assert.equal(sz.seo.title, 'Eventi del weekend nel Canton Svitto: cosa fare');
    assert.match(sz.content.it.body1, /nel Canton Svitto ci è un evento/);
    assert.match(sz.content.it.body2, /\(\/eventi\/svitto\/einsiedeln\/\)/);
    assert.match(sz.content.de.body1, /\/de\/veranstaltungen\/schwyz\/dieses-wochenende\//);
    // Gli eventi del Ticino finiscono nella sezione "altri cantoni", non nel conteggio.
    assert.match(sz.content.it.body2, /## Eventi anche in altri cantoni/);
    assert.match(sz.content.it.body2, /\(\/eventi\/ticino\/lugano\/\)/);
  });

  it('i metadati evergreen nominano il cantone, mai il Ticino', () => {
    for (const group of Object.keys(CANTON_DIGEST_ARTICLES)) {
      const meta = staticMetaForCanton(group);
      const place = CANTON_DIGEST_ARTICLES[group].place.it;
      assert.equal(meta.seo.headline, `Eventi del weekend ${place}: cosa fare sabato e domenica`);
      assert.doesNotMatch(JSON.stringify(meta.seo), /Ticino|ticino/);
    }
  });

  it('il digest di un altro cantone passa gli stessi gate di qualita\' e fattualita\' del refresh', () => {
    for (const canton of ['SZ', 'GR', 'JU']) {
      const data = buildData(TODAY, { datasetPath: DATASET, canton });
      assert.doesNotThrow(() => assertGeneratedArticleQuality(data), `${canton}: gate di qualita'`);
      assert.doesNotThrow(() => assertArticlePassesFactualityGates(data), `${canton}: gate di fattualita'`);
    }
  });
});

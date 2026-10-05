/**
 * La classifica dei valichi per cantone (P9c).
 *
 * `generate-border-wait-ranking-article.mjs` era Ticino-only per identita'.
 * Ora prende `--canton`: Ticino resta l'articolo originale (stesso id, stessi
 * metadati SEO, stesso filtro per regione), ogni altro cantone di confine ha
 * il proprio id stabile e classifica solo i valichi che la finestra pubblicata
 * dal sito marca con quel `canton`.
 *
 * Sotto `node --test` puro: i `.ts` importati (borderWaitData.ts) passano dallo
 * strip dei tipi di Node 22, come in evergreen-comune-distance-cap.test.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildData,
  cantonFromArgs,
  computeSnapshot,
  staticMetaFor,
} from '../scripts/generate-border-wait-ranking-article.mjs';
import { RANKING_ARTICLE_ID, rankingArticleIdentity } from '../scripts/lib/border-wait-ranking-content.mjs';
import { freshenWindow } from './lib/rewire-contracts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TODAY = new Date().toISOString().slice(0, 10);
const fixture = () =>
  freshenWindow(
    JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/rewire/border-wait-ranking-window.json'), 'utf8')),
    TODAY,
  );

/** Il fixture registrato con un secondo valico ginevrino, per avere una classifica GE non degenere. */
function withGeneva() {
  const w = fixture();
  for (const half of ['current', 'previous']) {
    w[half].perCrossing.bardonnex = { weightedAvgMinutes: 6.4, totalSamples: 47, canton: 'GE' };
  }
  return w;
}

describe('classifica dogane per cantone', () => {
  it('Ticino resta l\'articolo originale: stesso id, stessi metadati, solo valichi ticinesi', () => {
    const data = buildData(TODAY, fixture());
    assert.equal(data.id, RANKING_ARTICLE_ID);
    assert.equal(data.id, 'classifica-dogane-ticino');
    assert.equal(data.seo.title, 'Classifica delle dogane in Ticino: le migliori e le peggiori');
    assert.equal(data.image, 'mendrisio.webp');
    // 8 ticinesi nel fixture; anieres (GE) e au-lustenau (SG) restano fuori.
    assert.equal(data._rankedCount, 8);
  });

  it('un altro cantone classifica solo i valichi col suo `canton` e ha un id proprio', () => {
    const snapshot = computeSnapshot(TODAY, withGeneva(), 'GE');
    assert.deepEqual(snapshot.ranking.map((r) => r.slug).sort(), ['anieres', 'bardonnex']);
    const data = buildData(TODAY, withGeneva(), 'GE');
    assert.equal(data.id, 'classifica-dogane-ginevra');
    assert.deepEqual(data.slugs, rankingArticleIdentity('GE').slugs);
    assert.equal(data._rankedCount, 2);
    assert.match(data.seo.title, /Canton Ginevra/);
    const text = JSON.stringify(data.content);
    assert.doesNotMatch(text, /Ticino|Tessin|ticines|tessinois/);
  });

  it('una finestra senza `canton` (pubblicata prima del campo) non classifica nessun altro cantone', () => {
    const w = withGeneva();
    for (const half of ['current', 'previous']) {
      for (const s of Object.values(w[half].perCrossing)) delete s.canton;
    }
    assert.equal(buildData(TODAY, w, 'GE')._rankedCount, 0);
    // Ticino non dipende dal campo: il filtro e' per regione, come prima.
    assert.equal(buildData(TODAY, w, 'TI')._rankedCount, 8);
  });

  it('un cantone senza foto dichiarata non puo\' essere registrato (immagine nulla)', () => {
    assert.equal(staticMetaFor('GE').image, null);
    assert.equal(staticMetaFor('TI').image, 'mendrisio.webp');
  });

  it('--canton: default TI, case-insensitive, rifiuta un cantone senza valichi', () => {
    assert.equal(cantonFromArgs(['node', 'x'], {}), 'TI');
    assert.equal(cantonFromArgs(['node', 'x', '--canton=ge'], {}), 'GE');
    assert.equal(cantonFromArgs(['node', 'x'], { BORDER_WAIT_CANTON: 'basilea' }), 'BASILEA');
    assert.throws(() => cantonFromArgs(['node', 'x', '--canton=ZG'], {}), /no border-wait ranking for this canton/);
  });
});

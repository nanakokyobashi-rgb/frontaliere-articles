/**
 * reconcile-article-shards.test.mjs — la logica pura della riconciliazione
 * «slug annunciati ↔ pagine reali sugli shard». Run with `node --test`.
 *
 * LA CLASSE DIFESA. publish-api.yml e fast-publish-article.yml partono in
 * parallelo dallo stesso push: se il secondo muore (run 31245282583, 29s,
 * ETIMEDOUT su `npm ci`) l'articolo resta ANNUNCIATO (slugs.json, sitemap,
 * hub) e 404 sugli shard — 8,5 ore per `grigioni-frontalieri-calano` il
 * 2026-08-08, con zero retry perché ogni fast-publish successivo pubblica
 * solo il proprio articolo. La riconciliazione
 * (scripts/reconcile-article-shards.mjs, orchestrata da
 * .github/workflows/reconcile-article-shards.yml) è il rimedio; queste sono
 * le proprietà che NON devono regredire:
 *
 *   - la diff usa il path shard ESATTO (it alla radice, en/de/fr col
 *     prefisso locale): sbagliare il prefisso farebbe sembrare fantasma
 *     l'intero locale en/de/fr — cioè una tempesta di ripubblicazioni;
 *   - gli id svizzeri «shadowed» sono de-listati APPOSTA: contarli come
 *     fantasmi li ripubblicherebbe per sempre (12 al primo giro reale);
 *   - il cap e l'ordinamento (più recente prima) sono l'anti-tempesta: al
 *     primo giro reale la diff conteneva 69 id, di cui 68 arretrato storico
 *     feb-apr — il fantasma fresco DEVE passare davanti;
 *   - una superficie annunciata troncata (fetch parziale, counts incoerenti)
 *     va rifiutata prima dell'uso, non riconciliata.
 *
 * Tutto puro: niente rete, niente git, niente fs oltre l'import del modulo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCALES,
  SECTIONS,
  expectedShardPath,
  validateAnnouncedSurface,
  treeLooksSane,
  computeMissing,
  orderAndCap,
} from '../../scripts/reconcile-article-shards.mjs';

// Base slug reali (scripts/lib/section-shard-slugs.json) per le due sezioni.
const SECTION_SHARD_SLUGS = {
  articolifrontaliere: {
    it: 'articoli-frontaliere',
    en: 'cross-border-articles',
    de: 'grenzgaenger-artikel',
    fr: 'articles-frontalier',
  },
  articolisvizzera: {
    it: 'articoli-svizzera',
    en: 'swiss-articles',
    de: 'schweiz-artikel',
    fr: 'articles-suisse',
  },
};

/** Tree finto e sano: tanti path di riempimento + i marker del seed. */
function saneTree(paths = []) {
  const filler = Array.from({ length: 60 }, (_, i) => `filler/${i}/index.html`);
  return new Set(['CNAME', '.nojekyll', '404.html', ...filler, ...paths]);
}

function allTrees(perShardPaths = {}) {
  const trees = {};
  for (const { shard } of SECTIONS) {
    for (const loc of LOCALES) {
      trees[`${shard}-${loc}`] = saneTree(perShardPaths[`${shard}-${loc}`] || []);
    }
  }
  return trees;
}

// ── expectedShardPath: il prefisso locale è il punto che rompe tutto ────────

test('expectedShardPath: it alla radice, en/de/fr col prefisso locale', () => {
  assert.equal(
    expectedShardPath('articoli-frontaliere', 'it', 'grigioni-frontalieri-calano'),
    'articoli-frontaliere/grigioni-frontalieri-calano/index.html',
  );
  assert.equal(
    expectedShardPath('grenzgaenger-artikel', 'de', 'grenzgaenger-graubuenden'),
    'de/grenzgaenger-artikel/grenzgaenger-graubuenden/index.html',
  );
});

// ── computeMissing: la diff vera ────────────────────────────────────────────

test('un articolo con pagina su tutti i locali non è un fantasma', () => {
  const slugs = {
    blog: { 'art-ok': { it: 's-it', en: 's-en', de: 's-de', fr: 's-fr' } },
    swiss: {},
  };
  const trees = allTrees({
    'articolifrontaliere-it': ['articoli-frontaliere/s-it/index.html'],
    'articolifrontaliere-en': ['en/cross-border-articles/s-en/index.html'],
    'articolifrontaliere-de': ['de/grenzgaenger-artikel/s-de/index.html'],
    'articolifrontaliere-fr': ['fr/articles-frontalier/s-fr/index.html'],
  });
  assert.deepEqual(
    computeMissing({ slugs, shadowedSwissIds: new Set(), sectionShardSlugs: SECTION_SHARD_SLUGS, trees }),
    [],
  );
});

test('il caso 31245282583: annunciato ovunque, assente su tutti e 4 i locali', () => {
  const slugs = {
    blog: { 'grigioni-frontalieri-calano': { it: 'a', en: 'b', de: 'c', fr: 'd' } },
    swiss: {},
  };
  const missing = computeMissing({
    slugs,
    shadowedSwissIds: new Set(),
    sectionShardSlugs: SECTION_SHARD_SLUGS,
    trees: allTrees(),
  });
  assert.deepEqual(missing, [
    {
      id: 'grigioni-frontalieri-calano',
      section: 'frontaliere',
      shard: 'articolifrontaliere',
      locales: ['it', 'en', 'de', 'fr'],
    },
  ]);
});

test('fantasma parziale: elenca SOLO i locali senza pagina (arretrato de/fr reale)', () => {
  const slugs = {
    blog: { vecchio: { it: 'v-it', en: 'v-en', de: 'v-de', fr: 'v-fr' } },
    swiss: {},
  };
  const trees = allTrees({
    'articolifrontaliere-it': ['articoli-frontaliere/v-it/index.html'],
    'articolifrontaliere-en': ['en/cross-border-articles/v-en/index.html'],
  });
  const missing = computeMissing({ slugs, shadowedSwissIds: new Set(), sectionShardSlugs: SECTION_SHARD_SLUGS, trees });
  assert.equal(missing.length, 1);
  assert.deepEqual(missing[0].locales, ['de', 'fr']);
});

test('la sezione svizzera cerca nello shard articolisvizzera, non in quello frontaliere', () => {
  const slugs = {
    blog: {},
    swiss: { 'dazi-export': { it: 'x-it', en: 'x-en', de: 'x-de', fr: 'x-fr' } },
  };
  // La pagina esiste... ma nello shard SBAGLIATO: deve restare un fantasma.
  const trees = allTrees({
    'articolifrontaliere-it': ['articoli-svizzera/x-it/index.html'],
  });
  const missing = computeMissing({ slugs, shadowedSwissIds: new Set(), sectionShardSlugs: SECTION_SHARD_SLUGS, trees });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].section, 'svizzera');
  assert.equal(missing[0].shard, 'articolisvizzera');
  assert.deepEqual(missing[0].locales, ['it', 'en', 'de', 'fr']);
});

test('gli id svizzeri shadowed sono esclusi: de-listati apposta, non fantasmi', () => {
  const slugs = {
    blog: {},
    swiss: { ombra: { it: 'o-it', en: 'o-en', de: 'o-de', fr: 'o-fr' } },
  };
  const missing = computeMissing({
    slugs,
    shadowedSwissIds: new Set(['ombra']),
    sectionShardSlugs: SECTION_SHARD_SLUGS,
    trees: allTrees(),
  });
  assert.deepEqual(missing, []);
});

test('un locale mai annunciato (slug assente) non viene preteso', () => {
  const slugs = {
    blog: { solo3: { it: 't-it', en: 't-en', de: 't-de' } }, // fr mai annunciato
    swiss: {},
  };
  const trees = allTrees({
    'articolifrontaliere-it': ['articoli-frontaliere/t-it/index.html'],
    'articolifrontaliere-en': ['en/cross-border-articles/t-en/index.html'],
    'articolifrontaliere-de': ['de/grenzgaenger-artikel/t-de/index.html'],
  });
  assert.deepEqual(
    computeMissing({ slugs, shadowedSwissIds: new Set(), sectionShardSlugs: SECTION_SHARD_SLUGS, trees }),
    [],
  );
});

test('un tree mancante è un errore, mai un «tutto fantasma»', () => {
  const slugs = { blog: { a: { it: 's' } }, swiss: {} };
  assert.throws(
    () => computeMissing({ slugs, shadowedSwissIds: new Set(), sectionShardSlugs: SECTION_SHARD_SLUGS, trees: {} }),
    /tree mancante/,
  );
});

// ── orderAndCap: l'anti-tempesta ────────────────────────────────────────────

test('ordina dal più recente e applica il cap: il fantasma fresco passa davanti', () => {
  const missing = [
    { id: 'feb', section: 'frontaliere', shard: 'articolifrontaliere', locales: ['de'] },
    { id: 'fresco', section: 'svizzera', shard: 'articolisvizzera', locales: ['it', 'en', 'de', 'fr'] },
    { id: 'marzo', section: 'frontaliere', shard: 'articolifrontaliere', locales: ['fr'] },
  ];
  const dateById = new Map([
    ['feb', '2026-02-01T08:00:00.000Z'],
    ['fresco', '2026-08-07T16:02:29.813Z'],
    ['marzo', '2026-03-10T12:00:00.000Z'],
  ]);
  const { selected, leftover } = orderAndCap(missing, dateById, 2);
  assert.deepEqual(selected.map((m) => m.id), ['fresco', 'marzo']);
  assert.deepEqual(leftover.map((m) => m.id), ['feb']);
  // La data viaggia col selezionato: il workflow la mostra nel report.
  assert.equal(selected[0].date, '2026-08-07T16:02:29.813Z');
});

test('id senza data in coda, tie-break deterministico sull\'id', () => {
  const missing = [
    { id: 'b-stesso-giorno', section: 'frontaliere', shard: 'articolifrontaliere', locales: ['it'] },
    { id: 'senza-data', section: 'frontaliere', shard: 'articolifrontaliere', locales: ['it'] },
    { id: 'a-stesso-giorno', section: 'frontaliere', shard: 'articolifrontaliere', locales: ['it'] },
  ];
  const dateById = new Map([
    ['b-stesso-giorno', '2026-05-01'],
    ['a-stesso-giorno', '2026-05-01'],
  ]);
  const { selected } = orderAndCap(missing, dateById, 10);
  assert.deepEqual(selected.map((m) => m.id), ['a-stesso-giorno', 'b-stesso-giorno', 'senza-data']);
});

test('cap 0 seleziona niente e lascia tutto in coda; cap invalido cade sul default 3', () => {
  const missing = Array.from({ length: 5 }, (_, i) => ({
    id: `m${i}`,
    section: 'frontaliere',
    shard: 'articolifrontaliere',
    locales: ['it'],
  }));
  const zero = orderAndCap(missing, new Map(), 0);
  assert.equal(zero.selected.length, 0);
  assert.equal(zero.leftover.length, 5);
  const fallback = orderAndCap(missing, new Map(), 'non-un-numero');
  assert.equal(fallback.selected.length, 3);
  assert.equal(fallback.leftover.length, 2);
});

// ── validateAnnouncedSurface: mai riconciliare su dati troncati ─────────────

function goodSurface() {
  const blog = {};
  const articles = [];
  for (let i = 0; i < 150; i++) {
    blog[`id${i}`] = { it: `s${i}` };
    articles.push({ id: `id${i}`, date: '2026-01-01' });
  }
  return {
    manifest: { counts: { articles: 150, swissArticles: 1 } },
    slugs: { blog, swiss: { sw1: { it: 'sw1' } } },
    articles,
    swissArticles: [{ id: 'sw1', date: '2026-01-01' }],
  };
}

test('una superficie coerente passa', () => {
  assert.deepEqual(validateAnnouncedSurface(goodSurface()), []);
});

test('slugs troncato rispetto al manifest viene rifiutato', () => {
  const s = goodSurface();
  delete s.slugs.blog.id0;
  const errors = validateAnnouncedSurface(s);
  assert.ok(errors.some((e) => e.includes('slugs.blog')), errors.join('; '));
});

test('un registro sotto il floor dei 100 articoli viene rifiutato', () => {
  const s = goodSurface();
  s.manifest.counts.articles = 42;
  const errors = validateAnnouncedSurface(s);
  assert.ok(errors.some((e) => e.includes('42')), errors.join('; '));
});

test('manifest senza counts viene rifiutato subito', () => {
  const errors = validateAnnouncedSurface({ manifest: {}, slugs: {}, articles: [], swissArticles: [] });
  assert.equal(errors.length, 1);
});

// ── treeLooksSane: un clone rotto non deve dichiarare fantasma il corpus ────

test('un tree minuscolo o senza marker non è credibile', () => {
  assert.equal(treeLooksSane(['CNAME', 'index.html']), false); // troppo piccolo
  assert.equal(treeLooksSane(Array.from({ length: 200 }, (_, i) => `p${i}.html`)), false); // nessun marker
  assert.equal(treeLooksSane([...saneTree()]), true);
});

// Correzione editoriale: l'incidente del 28 febbraio 2026 è avvenuto in via
// Ceresio a Porlezza, provincia di Como. Tre articoli sullo stesso fatto
// scrivevano «Porletta», un comune che non esiste, e uno di loro collocava il
// luogo nel Canton Ticino e attribuiva gli accertamenti alle autorità
// cantonali. Questo test tiene ferma la correzione sui testi pubblicati e
// tiene fermi gli indirizzi: lo slug storico con il toponimo errato resta,
// perché cambiarlo romperebbe le URL già indicizzate.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { findAllSeoEntryMatches } from '../../scripts/lib/seo-entry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const LOCALES = ['it', 'en', 'de', 'fr'];
const WRONG_TOPONYM = /porletta/i;
// Gli articoli che portavano il toponimo errato nel titolo.
const CORRECTED = {
  'tragedia-pendolare-ticino': '2026-03-01T18:45:12',
  'incidente-giovane-frontaliere': '2026-03-02T06:53:59',
};
// Il terzo articolo sullo stesso fatto aveva il toponimo giusto ovunque tranne
// che in una citazione del testo italiano.
const SAME_EVENT = [...Object.keys(CORRECTED), 'pendolarismo-fatale-frontaliere-porlezza'];
const SEO_FILE = 'content/seo/seo-blog-2.ts';
const HISTORICAL_PATH = '/articoli-frontaliere/tragedia-pendolare-frontaliere-porletta/';
const PORLEZZA_CONTENT_FIX = {
  it: {
    route: /valico di Oria e Lugano/,
    payer: /assicuratore svizzero contro gli infortuni/,
    department: /Dipartimento delle finanze e dell/,
    hospital: /ospedale di Menaggio, dove è morto poco dopo/,
  },
  en: {
    route: /Oria border crossing and Lugano/,
    payer: /Swiss accident insurer; INPS is not the paying institution/,
    department: /Department of Finance and Economy/,
    hospital: /Menaggio hospital, where he died shortly afterwards/,
  },
  de: {
    route: /Grenzübergangs Oria und Lugano/,
    payer: /Schweizer Unfallversicherer des Arbeitgebers; das INPS ist nicht die auszahlende Stelle/,
    department: /Departement für Finanzen und Wirtschaft/,
    hospital: /Krankenhaus von Menaggio, wo er kurz darauf starb/,
  },
  fr: {
    route: /poste-frontière d\\?['’]Oria et Lugano/,
    payer: /assureur-accidents suisse de l/,
    department: /Département des finances et de l/,
    hospital: /hôpital de Menaggio, où il est décédé peu après/,
  },
};
const UNSUPPORTED_PORLEZZA_PATTERNS = [
  /Mendrisiotto|Mendrisio/i,
  /primi tragitti|first commutes|ersten Wege|premiers trajets/i,
  /Associazione Frontalieri|Cross-border associations|Grenzgängerorganisationen|Association Frontalieri|Association des Frontières|Frontier Association/i,
  /attempts at resuscitation were unsuccessful|Wiederbelebungsversuche erfolglos|tentativo di rianimazione si è rivelato vano|tentative de réanimation a été vaine/i,
  /Direzione delle finanze|Directorate of Finance|Direktion für Finanzen|Direction des finances|gestion des finances/i,
  /tramite l\\?['’]INPS|through INPS|über INPS|via l\\?['’]INPS/i,
  /Polizia Cantonale intensifica controlli|The Cantonal Police regularly increase|Die Kantonspolizei verstärkt regelmäßig|La Police cantonale intensifie régulièrement/i,
];
const metaLines = (locale, id) => read(`content/blog-meta-${locale}.ts`)
  .split('\n')
  .filter((line) => line.includes(`'blog.article.${id}.`));

for (const locale of LOCALES) {
  for (const id of SAME_EVENT) {
    test(`${locale}/${id}: il corpo nomina Porlezza e mai il toponimo errato`, () => {
      const body = read(`content/blog-body/${locale}/${id}.ts`);
      assert.doesNotMatch(body, WRONG_TOPONYM);
      assert.ok(body.includes('Porlezza'), 'il corpo deve nominare il luogo dell\'incidente');
    });
  }

  for (const id of Object.keys(CORRECTED)) {
    test(`${locale}/${id}: titolo, estratto e testo alternativo sono corretti`, () => {
      const lines = metaLines(locale, id);
      const title = lines.find((line) => line.includes(`${id}.title'`));
      assert.ok(title, 'titolo non trovato nei metadati');
      assert.ok(title.includes('Porlezza'), 'il titolo deve nominare Porlezza');
      assert.doesNotMatch(lines.join('\n'), WRONG_TOPONYM);
    });
  }

  test(`${locale}: l'articolo non colloca Porlezza in Ticino né gli accertamenti presso autorità cantonali`, () => {
    const body = read(`content/blog-body/${locale}/tragedia-pendolare-ticino.ts`);
    assert.doesNotMatch(body, /Porlezza,?\s*\(?(?:Canton(?:e| of)? Ticino|Ticino\b|Kanton Tessin|Tessin\b|canton du Tessin)/i);
    assert.doesNotMatch(body, /autorità cantonali|cantonal authorities|kantonalen Behörden|autorités cantonales/i);
  });
}

for (const locale of LOCALES) {
  test(`${locale}: i passaggi non riscontrati su Porlezza sono corretti in tutte le copie`, () => {
    const tragedy = read(`content/blog-body/${locale}/tragedia-pendolare-ticino.ts`);
    const incident = read(`content/blog-body/${locale}/incidente-giovane-frontaliere.ts`);
    const expected = PORLEZZA_CONTENT_FIX[locale];
    assert.match(tragedy, expected.route, 'direzione della Via Ceresio non fissata');
    assert.match(tragedy, expected.payer, 'pagatore della rendita LAINF non fissato');
    assert.match(incident, expected.route, 'direzione della Via Ceresio non fissata');
    assert.match(incident, expected.department, 'nome del Dipartimento non fissato');
    assert.match(incident, expected.hospital, 'esito ospedaliero non fissato');
    for (const pattern of UNSUPPORTED_PORLEZZA_PATTERNS) {
      assert.doesNotMatch(`${tragedy}\n${incident}`, pattern, `passaggio residuo: ${pattern}`);
    }
  });
}

test('il titolo tedesco del terzo articolo usa il genere maschile corretto', () => {
  const meta = read('content/blog-meta-de.ts');
  assert.match(meta, /Tragödie in Porlezza: Junger Grenzpendler stirbt/);
  assert.doesNotMatch(meta, /Tragödie in Porlezza: Junge Grenzpendlerin stirbt/);
});

test('le due voci SEO sono corrette in ogni campo tranne gli indirizzi', () => {
  const source = read(SEO_FILE);
  const entries = new Map(findAllSeoEntryMatches(source, SEO_FILE).map((entry) => [entry.id, entry]));
  for (const id of Object.keys(CORRECTED)) {
    const entry = entries.get(id);
    assert.ok(entry, `voce SEO di ${id} non trovata`);
    const lines = source.slice(entry.openIdx, entry.closeIdx + 1).split('\n');
    const text = lines.filter((line) => !/canonicalPath:|"mainEntityOfPage"/.test(line));
    assert.ok(text.length > 10, 'la voce deve avere i suoi campi di testo');
    assert.doesNotMatch(text.join('\n'), WRONG_TOPONYM);
    assert.ok(text.some((line) => /^\s*title: '.*Porlezza/.test(line)), 'title senza Porlezza');
    assert.ok(text.some((line) => /^\s*ogTitle: '.*Porlezza/.test(line)), 'ogTitle senza Porlezza');
  }
});

test('gli indirizzi storici non cambiano', () => {
  const source = read(SEO_FILE);
  assert.ok(source.includes(`canonicalPath: '${HISTORICAL_PATH}',`));
  assert.ok(source.includes('"mainEntityOfPage": `${BASE_URL}' + HISTORICAL_PATH + '`,'));
  const router = read('content/routerBlogData.ts')
    .split('\n')
    .find((line) => line.includes("'tragedia-pendolare-ticino':"));
  assert.ok(router, 'slug dell\'articolo non trovati');
  for (const slug of [
    "it: 'tragedia-pendolare-frontaliere-porletta'",
    "en: 'cross-border-commuter-tragedy-porletta'",
    "de: 'grenzpendler-tragödie-porletta'",
    "fr: 'tragedie-frontalier-porletta'",
  ]) assert.ok(router.includes(slug), `slug cambiato: ${slug}`);
});

test('la correzione è registrata come modifica, la pubblicazione resta quella', () => {
  const registry = read('content/blog-articles-data.ts');
  const seo = read(SEO_FILE);
  const entries = new Map(findAllSeoEntryMatches(seo, SEO_FILE).map((entry) => [entry.id, entry]));
  for (const [id, published] of Object.entries(CORRECTED)) {
    const record = registry.match(new RegExp(`id: '${id}',([\\s\\S]*?)\\n \\},`))?.[1];
    assert.ok(record, `voce di registro di ${id} non trovata`);
    const date = record.match(/\bdate: '([^']+)'/)?.[1];
    assert.ok(date?.startsWith(published), `data di pubblicazione cambiata: ${date}`);
    const updated = record.match(/updatedAt: '([^']+)'/)?.[1];
    assert.ok(updated, 'updatedAt mancante');
    assert.ok(Number.isFinite(Date.parse(updated)));
    assert.ok(Date.parse(updated) > Date.parse(date));
    assert.ok(Date.parse(updated) <= Date.now());
    const entry = entries.get(id);
    const block = seo.slice(entry.openIdx, entry.closeIdx + 1);
    assert.ok(block.includes(`"datePublished": "${published}+00:00"`), 'datePublished cambiata');
    assert.ok(block.includes(`"dateModified": "${updated}"`), 'dateModified diversa da updatedAt');
  }
});

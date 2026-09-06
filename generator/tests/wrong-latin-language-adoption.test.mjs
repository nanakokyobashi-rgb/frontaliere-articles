/**
 * ── IL TITOLO DI LINGUA SBAGLIATA CHE IL GATE NON VEDEVA (#800) ────────────
 *
 * `classifyBody2Payload` aveva UN solo controllo di lingua, `isNonItalianScript`,
 * e quel controllo guarda la SCRITTURA: CJK, cirillico, ebraico, arabo. Un
 * titolo inglese, tedesco o francese ha ratio 0 non-latino, quindi passava.
 *
 * Il modo in cui ci arrivava e' `normalizeItalianContentFromPayload`: cerca
 * ogni campo attraverso tre candidati — `content[locale]`, `content` senza
 * locale, la radice — e da #768 il `content` locale-less ha priorita' sulla
 * radice. Su una risposta come
 *
 *     { content: { it: { title: "", excerpt: "…" },
 *                  title: "Cross-border workers in Switzerland: …" } }
 *
 * il `title` locale-less riempie il `title` vuoto di `content.it`, esce
 * `verdict:"ok"`, diventa slug e canonical, e va live SENZA rebuild del sito.
 *
 * ── PERCHE' LA MISURA ANTI-FALSO-POSITIVO E' PARTE DEL TEST ────────────────
 *
 * Su questa superficie un falso positivo non e' un fastidio: e' un articolo
 * buttato, perche' `reject` fa rigenerare. Il rilevatore va quindi misurato
 * contro il corpus VERO prima di fidarsene, ed e' esattamente cio' che fa il
 * terzo blocco: scansiona i `title` IT pubblicati e pretende zero offender
 * oltre a quelli genuini gia' noti.
 *
 * Il conteggio minimo non e' decorativo. Un checkout sparso senza `content/`
 * farebbe trovare zero titoli, zero offender, e il test passerebbe A VUOTO
 * dichiarando verde la proprieta' che non ha misurato — il modo silenzioso in
 * cui una gate smette di essere una gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyBody2Payload,
  wrongLanguageAdoptions,
  resolveContentFieldSources,
  META_ONLY_FIELDS,
} from '../scripts/lib/body2-payload-verdict.mjs';
import {
  detectWrongLatinLanguage,
  latinLanguageMarkerHits,
  vowelFinalWordRatio,
} from '../scripts/lib/itLanguageCheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const EXCERPT_IT = 'Excerpt italiano abbastanza lungo da superare il floor di plausibilita del gate.';

// ── 1. Il caso della issue: adozione da un candidato NON-locale ────────────

test('#800 — un title EN adottato da `content` senza locale finisce in missing', () => {
  const verdetto = classifyBody2Payload({
    parsed: {
      content: {
        it: { title: '', excerpt: EXCERPT_IT },
        title: 'Cross-border workers in Switzerland: the 2026 tax rules',
      },
    },
    expectedFields: META_ONLY_FIELDS,
  });

  assert.equal(verdetto.verdict, 'reject');
  assert.ok(
    verdetto.missing.some((m) => m.startsWith('title lingua')),
    `missing non nomina la lingua del title: ${JSON.stringify(verdetto.missing)}`,
  );
});

test('#800 — vale anche per DE e FR, e anche dalla radice del payload', () => {
  const casi = [
    ['Die neuen Regeln fuer Grenzgaenger in der Schweiz ab 2026', 'content'],
    ['Les nouvelles regles pour les frontaliers en Suisse des 2026', 'content'],
    ['Cross-border workers in Switzerland: the 2026 tax rules', 'root'],
  ];

  for (const [title, dove] of casi) {
    const parsed = dove === 'content'
      ? { content: { it: { title: '', excerpt: EXCERPT_IT }, title } }
      : { content: { it: { title: '', excerpt: EXCERPT_IT } }, title };

    const verdetto = classifyBody2Payload({ parsed, expectedFields: META_ONLY_FIELDS });
    assert.equal(verdetto.verdict, 'reject', `non rigettato: ${title}`);
    assert.ok(
      verdetto.missing.some((m) => m.startsWith('title lingua')),
      `missing non nomina la lingua: ${title} → ${JSON.stringify(verdetto.missing)}`,
    );
  }
});

test('#800 — il campo adottato da `content[locale]` NON viene rigiudicato', () => {
  // Stesso testo inglese, ma dichiarato dal modello nella lingua chiesta. Il
  // controllo nuovo tace apposta: li' non c'e' l'adozione silenziosa che e' la
  // causa, e rigiudicare aggiungerebbe solo rischio di falso positivo.
  const sources = resolveContentFieldSources(
    { content: { it: { title: 'Cross-border workers in Switzerland: the 2026 tax rules', excerpt: EXCERPT_IT } } },
    'it',
    META_ONLY_FIELDS,
  );
  assert.equal(sources.title.isLocale, true);
  assert.deepEqual(
    wrongLanguageAdoptions(
      { content: { it: { title: 'Cross-border workers in Switzerland: the 2026 tax rules', excerpt: EXCERPT_IT } } },
      'it',
      META_ONLY_FIELDS,
    ),
    [],
  );
});

test('#800 — nessuna regressione: un title italiano in content.it resta ok', () => {
  const verdetto = classifyBody2Payload({
    parsed: {
      content: {
        it: {
          title: 'Stipendio netto frontaliere 2026: come calcolarlo',
          excerpt: EXCERPT_IT,
        },
      },
    },
    expectedFields: META_ONLY_FIELDS,
  });

  assert.equal(verdetto.verdict, 'ok', JSON.stringify(verdetto.missing));
  assert.deepEqual(verdetto.missing, []);
});

test('#800 — un title italiano adottato da un candidato non-locale resta ok', () => {
  const verdetto = classifyBody2Payload({
    parsed: {
      content: {
        it: { title: '', excerpt: EXCERPT_IT },
        title: 'Frontalieri e telelavoro: le nuove regole del 2026',
      },
    },
    expectedFields: META_ONLY_FIELDS,
  });

  assert.equal(verdetto.verdict, 'ok', JSON.stringify(verdetto.missing));
});

// ── 2. Il rilevatore, sui suoi due segnali ────────────────────────────────

test('#800 — le liste di parole-funzione sono ESCLUSIVE fra le quattro lingue', () => {
  // `la`, `le`, `un`, `il`, `a`, `in`, `des`… esistono in piu' lingue: la
  // deduplica le toglie da tutte. Se una di queste tornasse a contare, il
  // margine fra italiano e francese si romperebbe per prima.
  for (const parola of ['la', 'le', 'un', 'il', 'a', 'in', 'des', 'qui', 'si', 'on']) {
    const hits = latinLanguageMarkerHits(parola);
    const totale = Object.values(hits).reduce((s, n) => s + n, 0);
    assert.equal(totale, 0, `"${parola}" conta ancora come marker di qualche lingua`);
  }
});

test('#800 — la morfologia separa italiano e non-italiano', () => {
  assert.ok(vowelFinalWordRatio('Stipendio netto frontaliere 2026: come calcolarlo') > 0.6);
  assert.ok(vowelFinalWordRatio('Cross-border workers in Switzerland: the 2026 tax rules') < 0.35);
  // Troppe poche parole per dire qualcosa: `null`, non un numero inventato.
  assert.equal(vowelFinalWordRatio('AVS 2026'), null);
});

test('#800 — senza evidenza il rilevatore torna null, non false', () => {
  assert.equal(detectWrongLatinLanguage('', 'it'), null);
  assert.equal(detectWrongLatinLanguage('Titolo breve', 'it'), null);
  // Locale fuori dalle quattro: nessuna competenza, nessun verdetto.
  assert.equal(detectWrongLatinLanguage('Cross-border workers in Switzerland: the rules', 'es'), null);
});

test('#800 — un titolo italiano con un prestito straniero non basta a rigettare', () => {
  // Margine 2: un colpo isolato («smart working», «Black Friday») non decide.
  for (const titolo of [
    'Smart working per frontalieri: cosa cambia nel 2026',
    'Black Friday in Ticino: le offerte per chi lavora oltre confine',
    'Home office e imposta alla fonte: la guida per i frontalieri',
  ]) {
    assert.equal(detectWrongLatinLanguage(titolo, 'it'), null, `falso positivo su: ${titolo}`);
  }
});

// ── 3. La misura anti-falso-positivo sul corpus pubblicato ────────────────

const META_IT = ['content/blog-meta-it.ts', 'content/blog-meta-ch-it.ts'];
// Il corpus pubblicato ne conta 5.682 al 2026-09-06. La soglia sta molto sotto
// per non rompersi a ogni pubblicazione, ma abbastanza sopra da rendere
// impossibile un pass a vuoto su un checkout troncato.
const MIN_TITOLI_IT = 4000;
// Gli unici flagged sui 5.682: titoli DAVVERO in lingua sbagliata, gia' live.
// Sono la prova che il difetto esisteva, non un difetto del rilevatore.
const OFFENDER_GENUINI = [
  'SBB controllers getting bonuses for fines? What frontalieri need to know',
];

function titoliPubblicati(file) {
  const sorgente = readFileSync(path.join(ROOT, file), 'utf8');
  const titoli = [];
  // Mappa i18n piatta: `'blog.article.<slug>.title': 'Titolo',`
  for (const m of sorgente.matchAll(/\.title':\s*'((?:[^'\\]|\\.)*)',/g)) {
    titoli.push(m[1].replace(/\\'/g, "'"));
  }
  return titoli;
}

test('#800 — zero falsi positivi sui title IT pubblicati', (t) => {
  const mancanti = META_IT.filter((f) => !existsSync(path.join(ROOT, f)));
  if (mancanti.length > 0) {
    t.skip(`corpus non presente in questo checkout: ${mancanti.join(', ')}`);
    return;
  }

  const titoli = META_IT.flatMap(titoliPubblicati);
  assert.ok(
    titoli.length >= MIN_TITOLI_IT,
    `letti solo ${titoli.length} title IT (minimo ${MIN_TITOLI_IT}): corpus troncato o `
    + 'regex di estrazione disallineata — questo test NON deve passare a vuoto',
  );

  const offender = titoli
    .map((titolo) => [titolo, detectWrongLatinLanguage(titolo, 'it')])
    .filter(([titolo, esito]) => esito && !OFFENDER_GENUINI.includes(titolo));

  assert.deepEqual(
    offender.map(([titolo, esito]) => `${esito.lang}/${esito.reason} :: ${titolo}`),
    [],
    `il rilevatore rigetta title italiani legittimi su ${titoli.length} misurati`,
  );
});

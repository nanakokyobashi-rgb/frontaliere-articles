/**
 * producer-refresh-guard.test.mjs — la guardia sui segnaposto del prompt gira
 * DENTRO il secondo percorso di scrittura dei produttori deterministici.
 *
 * ## Il difetto che sorveglia (follow-up #315 a #309)
 *
 * `prompt-placeholder-guard.mjs` dichiara nella propria intestazione di girare
 * «dentro `registerArticleFiles()`, cioe' sul percorso di scrittura CONDIVISO».
 * L'affermazione era vera e insufficiente: i percorsi di scrittura sono **due**.
 *
 *   prima registrazione   →  registerArticleFiles()  →  guard ✅
 *   rerun idempotente     →  refreshBodyFiles()      →  writeFileSync diretto
 *
 * Il secondo non passa dal registrar: apre i quattro file di body e ci scrive
 * sopra. Fino a #309 la sola copertura era uno **step di workflow** che gira
 * DOPO, sul corpus gia' scritto — quindi una chiamata diretta a queste funzioni
 * (o un `main()` che entra nel ramo `exists`) scriveva senza controllo. E' la
 * stessa forma dell'incidente che il guard cita nella propria intestazione: una
 * regola applicata a un punto invece che al percorso che quel punto condivide.
 *
 * ## Perche' in sandbox e non con un import
 *
 * I tre produttori importano `create-article.mjs`, le cui dipendenze statiche
 * (jsdom) esistono solo dove e' passato `npm ci` — che in questo repo non
 * accade. Si estrae quindi il sorgente REALE di `refreshBodyFiles` e lo si
 * esegue con `new Function`, iniettando le dipendenze: stesso identico
 * meccanismo di `article-meta-refresh.test.mjs` e `seo-description-cap.test.mjs`.
 *
 * Non e' un test di sottostringa: `sanitizePromptPlaceholders` iniettata e'
 * quella VERA, e l'asserzione che conta e' che il writer stub NON venga mai
 * chiamato. Togliere la riga dal produttore fa passare la scrittura e rende
 * rosso questo file — verificato per mutazione su tutti e tre i produttori.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizePromptPlaceholders } from '../scripts/lib/prompt-placeholder-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOCALES = ['it', 'en', 'de', 'fr'];

/** I tre produttori deterministici che riscrivono i body fuori dal registrar. */
const PRODUCERS = [
  'generator/scripts/generate-daily-brief-article.mjs',
  'generator/scripts/generate-events-digest-article.mjs',
  'generator/scripts/generate-border-wait-ranking-article.mjs',
];

/**
 * Estrae il sorgente di una funzione esportata e la ricostruisce con `new
 * Function`, iniettando le dipendenze che il suo corpo nomina. La chiusura si
 * trova sul primo `}` in colonna 0: le graffe interne sono tutte indentate.
 */
function extractFn(src, header, deps) {
  const start = src.indexOf(header);
  assert.ok(start > -1, `${header} non trovata — aggiornare il delimitatore di questo test`);
  const endRel = src.slice(start).search(/\n\}\n/);
  assert.ok(endRel > -1, `chiusura di ${header} non trovata`);
  const fnSrc = src.slice(start, start + endRel + 2).replace('export function', 'return function');
  const names = Object.keys(deps);
  return new Function(...names, `${fnSrc}\n`)(...names.map((n) => deps[n]));
}

/** Le dipendenze di `refreshBodyFiles`, con i writer sostituiti da spie. */
function makeHarness() {
  const writes = [];
  const mkdirs = [];
  return {
    writes,
    mkdirs,
    deps: {
      LOCALES,
      REPO_ROOT: '/fake/repo/root',
      path,
      corpusPath: (p) => p,
      mkdirSync: (d) => mkdirs.push(d),
      writeFileSync: (f, c) => writes.push({ file: f, content: c }),
      // Il body prodotto contiene i campi di `data`, cosi' un segnaposto non
      // intercettato finirebbe davvero nel contenuto scritto.
      buildBodyFile: (data, locale) => `export const body = ${JSON.stringify(data.content?.[locale] || {})};\n`,
      sanitizeText: (s) => s,
      reportStrippedControlChars: () => {},
      sanitizePromptPlaceholders,
    },
  };
}

/** Un articolo pulito: nessun segnaposto, deve passare e scrivere 4 file. */
function cleanData() {
  return {
    id: 'edizione-demo',
    content: Object.fromEntries(
      LOCALES.map((l) => [
        l,
        {
          title: 'Ristorni sospesi: cosa cambia per i frontalieri',
          excerpt: 'Il Consiglio di Stato ticinese ha sospeso i ristorni alla Lombardia: oltre 50 milioni bloccati.',
          body1: 'Testo con un tetto di spesa (max 15.000 CHF/anno) approvato dal Gran Consiglio.',
        },
      ]),
    ),
    seo: { description: 'Ristorni sospesi dal Ticino: cosa cambia per i frontalieri.' },
  };
}

/**
 * Lo stesso articolo con un segnaposto dello schema in `excerpt` — la classe
 * che il guard rifiuta di ricostruire (lancia, per non propagare il leak).
 */
function poisonedData() {
  const data = cleanData();
  data.content.it.excerpt = 'Sottotitolo con dati concreti DALLA FONTE (max 160 chars)';
  return data;
}

describe('refreshBodyFiles — la guardia sui segnaposto gira in processo, non solo nel workflow', () => {
  for (const rel of PRODUCERS) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

    it(`${rel}: un articolo pulito viene scritto su tutti e 4 i locali`, () => {
      const h = makeHarness();
      const refreshBodyFiles = extractFn(src, 'export function refreshBodyFiles(', h.deps);
      refreshBodyFiles(cleanData(), '/fake/repo/root', () => {});
      assert.equal(h.writes.length, 4, 'un articolo pulito deve produrre 4 file di body');
    });

    it(`${rel}: un segnaposto nel testo LANCIA e non scrive un solo byte`, () => {
      const h = makeHarness();
      const refreshBodyFiles = extractFn(src, 'export function refreshBodyFiles(', h.deps);
      assert.throws(
        () => refreshBodyFiles(poisonedData(), '/fake/repo/root', () => {}),
        /prompt-placeholder/,
        'la guardia non gira in processo: il rerun scrive senza controllo, e l\'offender si vede solo dopo, a corpus scritto',
      );
      assert.equal(
        h.writes.length,
        0,
        'fail-closed violato: la guardia ha lanciato ma qualche body era gia\' stato scritto',
      );
    });
  }

  it('generate-daily-brief-article.mjs: refreshMetaAndSeo rifiuta lo stesso articolo', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, PRODUCERS[0]), 'utf-8');
    const calls = [];
    const refreshMetaAndSeo = extractFn(src, 'export function refreshMetaAndSeo(', {
      LOCALES,
      REPO_ROOT: '/fake/repo/root',
      sanitizePromptPlaceholders,
      refreshDescriptiveTexts: (...args) => {
        calls.push(args);
        return { changed: false, touched: [] };
      },
    });

    // `refreshMetaAndSeo` riscrive proprio i campi descrittivi che il guard
    // tratta come non riparabili: senza la guardia in processo, il segnaposto
    // finirebbe in excerpt/seoDescription/ogDescription pubblicati.
    assert.throws(() => refreshMetaAndSeo(poisonedData()), /prompt-placeholder/);
    assert.equal(calls.length, 0, 'fail-closed violato: refreshDescriptiveTexts chiamata comunque');

    assert.doesNotThrow(() => refreshMetaAndSeo(cleanData()));
    assert.equal(calls.length, 1, 'un articolo pulito deve arrivare a refreshDescriptiveTexts');
  });
});

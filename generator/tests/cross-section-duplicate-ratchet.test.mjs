/**
 * cross-section-duplicate-ratchet.test.mjs — quanti duplicati cross-sezione ci
 * sono OGGI nel registro pubblicato (issue #251).
 *
 * ## Perché è un file a parte da cross-section-source-dedup.test.mjs
 *
 * Quello è un contratto sul SORGENTE del generatore: comportamento della
 * libreria e cablaggio in `create-article.mjs`. Questo è uno scan del REGISTRO
 * PUBBLICATO, e i due hanno bisogni opposti su DOVE girano.
 *
 * Fino al 2026-08-18 `tests.yml` aveva `branches-ignore: [main]`, e gli articoli
 * generati atterrano con un push diretto su `main`: uno scan del registro che
 * gira solo sulle PR vede il difetto solo dopo che è stato pubblicato. Questo file sta quindi
 * anche nel preflight di `publish-api.yml`, che parte su ogni push a
 * `content/**` di main — e i due ledger URL→id vengono riscritti dallo stesso
 * commit che scrive l'articolo.
 *
 * Il contratto sul sorgente NON può stare lì: `create-article.mjs` non è fra i
 * `paths` di quel workflow, quindi una sua modifica arriverebbe su main senza
 * far partire il preflight, e il primo push di contenuto successivo
 * congelerebbe l'INTERA superficie dati per una ragione che non ha niente a che
 * fare col contenuto pubblicato. È la stessa distinzione che il commento di
 * `publish-api.yml` fa già per `news-scan-quality.test.mjs`.
 *
 * ## Cosa dice il numero
 *
 * Il gate in `isSourceUrlAlreadyUsed` impedisce che ne nascano di nuovi. Questo
 * file dice se serve anche una BONIFICA di quelli vecchi, e va rosso al sesto.
 *
 * Lancia con:
 *   node --test generator/tests/cross-section-duplicate-ratchet.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listCrossSectionDuplicates } from '../scripts/lib/cross-section-dedup.mjs';
import { ledgerArticleIds, readLedgerEntry } from '../scripts/lib/source-url-ledger.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** I ledger URL→id, uno per sezione, come li scrive `recordSourceUrl`. */
const LEDGER_FILES = {
  frontaliere: 'data/article-source-urls.json',
  svizzera: 'data/swiss-article-source-urls.json',
};

/**
 * I 5 duplicati cross-sezione MISURATI su `origin/main` il 2026-08-13, prima
 * che il gate esistesse. Elencati per URL e non contati, perché un numero dice
 * «sono sei» e una lista dice QUALE è il sesto.
 *
 * Il ratchet è a sottoinsieme: un URL può USCIRE dai ledger — il trim a 500
 * voci di `saveSourceUrls`, oppure una bonifica — e il test resta verde. Non
 * possono entrarne di nuovi.
 */
const KNOWN_CROSS_SECTION_DUPLICATES_2026_08_13 = new Set([
  // frontaliere: matrimonio-aziendale-vallemaggia-100 | svizzera: un-matrimonio-che-vale-cento-posti-di-lavoro
  'https://www.tio.ch/ticino/attualita/1941660/sa-lavoro-vallemaggia-posti-matrimonio-vale',
  // frontaliere: svizzeri-fuga-alloglio-ticino | svizzera: svizzeri-fuga-estero-costo-casa
  'https://www.tio.ch/svizzera/attualita/1942044/francia-affitti-alloggio-spinge-trasferirsi',
  // frontaliere: autostrada-a2-mezzovico-interrogazione | svizzera: autostrada-riapertura-ticino
  'https://www.tio.ch/ticino/politica/1942847/davvero-servono-ore-e-ore-per-riaprire-un-autostrada',
  // frontaliere: a2-traffico-ticino-interrogazione | svizzera: a2-ancora-al-collasso
  'https://www.tio.ch/ticino/politica/1942871/a2-ancora-al-collasso-il-ticino-non-puo-essere-ostaggio-del-traffico-di-transito',
  // frontaliere: fallimenti-aziende-svizzera-1994 | svizzera: effetto-domino-fallite-aziende-svizzera
  'https://www.tio.ch/svizzera/economia/1943399/aziende-settori-fallite-effetto-svizzera',
]);

/**
 * Pavimento anti-falso-verde. Due ledger vuoti passerebbero qualunque
 * asserzione qui sotto, ed è il modo più facile di trasformare questa rete in
 * decorazione. Al 2026-08-13: 102 voci frontaliere, 190 svizzera.
 */
const MIN_LEDGER_ENTRIES = 50;

function readRawLedgers() {
  const out = {};
  for (const [section, rel] of Object.entries(LEDGER_FILES)) {
    const parsed = JSON.parse(readFileSync(path.join(ROOT, rel), 'utf-8'));
    assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${rel} non è una mappa URL→id`);
    out[section] = parsed;
  }
  return out;
}

/**
 * I ledger nella forma che `listCrossSectionDuplicates` sa leggere: valori
 * STRINGA, senza finestra temporale.
 *
 * Il passaggio da `ledgerArticleIds` non è cosmetico ed è la ragione per cui
 * questo test è stato toccato insieme alla scadenza del ledger. Dal momento in
 * cui `recordSourceUrl` scrive `{articleId, ts}`, passare la mappa GREZZA a
 * `listCrossSectionDuplicates` non produce un errore: la funzione salta ogni
 * valore che non sia una stringa, quindi avrebbe contato **zero duplicati su
 * qualunque corpus**, per sempre, restando verde. Un ratchet vacuo è peggio di
 * un ratchet assente, e il pavimento qui sotto non lo avrebbe visto perché
 * conta le CHIAVI, non i valori leggibili.
 */
function readPublishedLedgers() {
  const raw = readRawLedgers();
  const out = {};
  for (const [section, map] of Object.entries(raw)) out[section] = ledgerArticleIds(map);
  return out;
}

test('i due ledger URL→id esistono e non sono vuoti', () => {
  const ledgers = readPublishedLedgers();
  for (const [section, ledger] of Object.entries(ledgers)) {
    const n = Object.keys(ledger).length;
    assert.ok(
      n >= MIN_LEDGER_ENTRIES,
      `ledger ${section} con ${n} voci (< ${MIN_LEDGER_ENTRIES}): sotto il pavimento, lo scan passerebbe a vuoto`,
    );
  }
});

test('nessun NUOVO duplicato cross-sezione nel registro pubblicato', () => {
  const dups = listCrossSectionDuplicates(readPublishedLedgers());
  const nuovi = dups
    .filter((d) => !KNOWN_CROSS_SECTION_DUPLICATES_2026_08_13.has(d.url))
    .map((d) => `${d.url} → ${d.sections.map((s) => `${s.section}:${s.articleId}`).join(' | ')}`);
  assert.deepEqual(
    nuovi,
    [],
    'una fonte ha generato un articolo in ENTRAMBE le sezioni dopo il gate di #251. '
    + 'Verificare che `isSourceUrlAlreadyUsed` sia ancora sul percorso di pre-filtro delle headline '
    + '(generator/tests/cross-section-source-dedup.test.mjs copre il cablaggio).',
  );
});

test('ogni voce dei ledger pubblicati porta un id leggibile', () => {
  // Il pavimento che rende non-vacuo il ratchet sopra: se una forma nuova
  // entrasse nei file senza passare da `readLedgerEntry`, gli URL corrispondenti
  // uscirebbero dalla vista e i duplicati su di essi diventerebbero invisibili.
  for (const [section, map] of Object.entries(readRawLedgers())) {
    const illeggibili = Object.entries(map)
      .filter(([, v]) => !readLedgerEntry(v))
      .map(([url]) => url);
    assert.deepEqual(
      illeggibili,
      [],
      `ledger ${section}: voci che né stringa né {articleId, ts} — invisibili al dedup cross-sezione`,
    );
  }
});

test('la baseline storica non cresce', () => {
  const dups = listCrossSectionDuplicates(readPublishedLedgers());
  assert.ok(
    dups.length <= KNOWN_CROSS_SECTION_DUPLICATES_2026_08_13.size,
    `duplicati cross-sezione saliti a ${dups.length} (baseline ${KNOWN_CROSS_SECTION_DUPLICATES_2026_08_13.size})`,
  );
});

/**
 * retired-articles-fully-removed.test.mjs — un articolo ritirato è sparito da
 * TUTTE le superfici di registrazione, e il suo vincitore è ancora al suo posto
 * (issue #304 item 1).
 *
 * ## Il difetto che sorveglia
 *
 * `generator/scripts/create-article.mjs` registra un articolo su una dozzina di
 * superfici. Fino a #304 non esisteva l'operazione inversa, e la rimozione a
 * mano di una sola di esse ha una conseguenza sproporzionata:
 * `scripts/build-api.mjs` incrocia registro, mappa slug e meta, e su un id
 * presente in una ma non nell'altra fa
 *
 *     throw new Error(`news-ticker: article '<id>' has no <loc> slug — refusing to publish`)
 *
 * Non è l'articolo ritirato a degradare: **si ferma la pubblicazione dell'intera
 * superficie dati**, per tutti e 4.200 gli articoli. E si ferma al primo push di
 * `content/**` successivo, che quasi sempre è di qualcun altro e non c'entra
 * niente — `generate-article.yml` ne fa ~111 al giorno. Una rimozione parziale è
 * quindi un difetto ritardato e mal attribuito, ed è la ragione per cui questo
 * file guarda ogni superficie separatamente invece di fidarsi dello script.
 *
 * ## Perché non basta il ratchet che c'è già
 *
 * `cross-section-duplicate-ratchet.test.mjs` conta i duplicati nei due ledger
 * URL→id, ed è dichiaratamente **a sottoinsieme**: un URL può uscire dai ledger
 * e il test resta verde. È corretto per il suo scopo, ma significa che quel
 * ratchet **non distingue una bonifica da un trim** — `saveSourceUrls` taglia a
 * 500 voci, e un duplicato che esce di lì torna invisibile pur restando
 * pubblicato. Diventa verde in entrambi i casi, quindi non può essere lui a
 * dire se una bonifica è stata fatta per intero.
 *
 * Questo file parte dall'altro capo: non dai ledger, ma dall'elenco esplicito
 * dei ritiri in `data/retired-articles.json`, e verifica le superfici che
 * `build-api.mjs` incrocia davvero.
 *
 * ## Anti-falso-verde
 *
 * Un elenco vuoto renderebbe ogni asserzione qui sotto vacua, ed è il modo più
 * facile perché questa rete diventi decorazione. Quindi: l'elenco deve avere
 * almeno una voce, ogni voce deve avere i quattro slug, e ogni superficie letta
 * deve essere non vuota — se un registro si legge vuoto è il PARSER a essere
 * rotto, non il corpus a essere pulito.
 *
 * Lancia con:
 *   node --test generator/tests/retired-articles-fully-removed.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mentionsId } from '../../scripts/lib/mentions-id.mjs';
// Le superfici NON sono riscritte qui: le enumera lo stesso modulo che usa
// `scripts/retire-article.mjs`. Un secondo elenco a mano è già divergito una
// volta — mancavano `content/blogArticleIds.ts`, i file SEO e il ledger delle
// immagini, quindi un id ritirato sopravvissuto lì passava verde proprio nel
// test che esiste per accorgersene.
import { SECTIONS, leftoverSurfacesFor } from '../../scripts/lib/article-surfaces.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const RETIRED_FILE = 'data/retired-articles.json';
const LOCALES = ['it', 'en', 'de', 'fr'];

/** Il pavimento sotto cui una superficie letta è rotta, non pulita. */
const MIN_SURFACE_BYTES = 1000;

/**
 * Le superfici lette una sola volta: i file SEO stanno fra i 150 kB e i 5,7 MB
 * e vengono riletti per OGNI voce ritirata e per ogni vincitore.
 * @type {Map<string, string>}
 */
const surfaceCache = new Map();

function readSurface(rel) {
  const cached = surfaceCache.get(rel);
  if (cached !== undefined) return cached;
  const abs = path.join(ROOT, rel);
  assert.ok(existsSync(abs), `${rel}: superficie assente — il test non può dire nulla`);
  const src = readFileSync(abs, 'utf-8');
  assert.ok(
    src.length >= MIN_SURFACE_BYTES,
    `${rel}: ${src.length} byte (< ${MIN_SURFACE_BYTES}). Una superficie che si legge vuota fa passare `
    + 'ogni asserzione di assenza: è il parser a essere rotto, non il corpus a essere pulito.',
  );
  surfaceCache.set(rel, src);
  return src;
}

function readRetired() {
  const abs = path.join(ROOT, RETIRED_FILE);
  assert.ok(existsSync(abs), `${RETIRED_FILE} assente`);
  const parsed = JSON.parse(readFileSync(abs, 'utf-8'));
  assert.ok(Array.isArray(parsed.retired), `${RETIRED_FILE}: "retired" deve essere un array`);
  return parsed.retired;
}

test('l\'elenco dei ritiri non è vuoto e ogni voce è completa', () => {
  const retired = readRetired();
  assert.ok(
    retired.length >= 1,
    `${RETIRED_FILE}: elenco vuoto. Ogni asserzione di questo file itera su di esso, quindi un `
    + 'elenco vuoto lo rende verde per costruzione. Se non c\'è più nulla di ritirato, cancella '
    + 'il file invece di svuotarlo.',
  );
  for (const entry of retired) {
    assert.ok(entry.id, `${RETIRED_FILE}: una voce senza "id"`);
    assert.ok(SURFACES[entry.section], `${entry.id}: sezione sconosciuta "${entry.section}"`);
    assert.ok(entry.winnerId, `${entry.id}: senza "winnerId" — un ritiro senza vincitore è una cancellazione`);
    assert.notEqual(entry.winnerId, entry.id, `${entry.id}: dichiarato vincitore di se stesso`);
    for (const loc of LOCALES) {
      assert.ok(
        typeof entry.slugs?.[loc] === 'string' && entry.slugs[loc].length > 0,
        `${entry.id}: manca lo slug "${loc}". Dopo la rimozione non è più derivabile da nessun `
        + 'registro, e senza di esso il repo del sito non può scrivere la voce EDGE_RETIRED_PATHS '
        + 'che ritira davvero la URL.',
      );
    }
  }
});

test('ogni articolo ritirato è sparito da TUTTE le superfici', () => {
  const retired = readRetired();
  /** @type {string[]} */
  const leftovers = [];

  for (const entry of retired) {
    const s = SURFACES[entry.section];
    const { id } = entry;

    // Le superfici testuali: registro, mappa slug, meta per locale, file SEO,
    // ledger URL→id, ledger immagini, union degli id.
    for (const rel of leftoverSurfacesFor(entry.section)) {
      // `mentionsId` e non `includes(id)` nudo: gli id si annidano
      // (`frontalieri-disoccupazione-svizzera-2026` contiene
      // `disoccupazione-svizzera-2026`, ed è già così nel corpus) e i ledger
      // hanno per chiave URL i cui segmenti di path sono kebab. Un residuo
      // inventato qui non grida su un run manuale: questo file è in
      // `scripts/ci/list-pr-gate-tests.mjs`, quindi renderebbe rossa OGNI PR.
      // Stessa funzione che usa la verifica finale di
      // `scripts/retire-article.mjs`, importata dallo stesso modulo.
      if (mentionsId(readSurface(rel), id)) leftovers.push(`${rel}: contiene ancora '${id}'`);
    }

    // I corpi e il sidecar sono file interi: deve mancare il file, non il contenuto.
    for (const loc of LOCALES) {
      const rel = `${s.bodyDir}/${loc}/${id}.ts`;
      if (existsSync(path.join(ROOT, rel))) leftovers.push(`${rel}: il corpo esiste ancora`);
    }
    const sidecar = `${s.sidecarDir}/${id}.json`;
    if (existsSync(path.join(ROOT, sidecar))) leftovers.push(`${sidecar}: il sidecar esiste ancora`);
  }

  assert.deepEqual(
    leftovers,
    [],
    'Rimozione PARZIALE di un articolo ritirato.\n'
    + 'scripts/build-api.mjs incrocia registro, mappa slug e meta: un id presente in una sola di '
    + 'queste superfici NON degrada l\'articolo ritirato, fa fallire la pubblicazione dell\'intera '
    + 'superficie dati al primo push di content/** successivo.\n'
    + 'Rimedio: node scripts/retire-article.mjs <id> --winner <winner-id>\n'
    + leftovers.map((l) => `   ${l}`).join('\n'),
  );
});

test('il vincitore di ogni ritiro è ancora pubblicato', () => {
  const retired = readRetired();
  /** @type {string[]} */
  const missing = [];

  for (const entry of retired) {
    // Il vincitore può stare nell'ALTRA sezione — è il caso normale qui, visto
    // che questi ritiri nascono da duplicati cross-sezione.
    const found = Object.entries(SURFACES).some(([, s]) =>
      readSurface(s.registryFile).includes(`id: '${entry.winnerId}',`)
      && readSurface(s.slugDataFile).includes(`'${entry.winnerId}':`));
    if (!found) missing.push(`${entry.id} → vincitore '${entry.winnerId}' non è in nessun registro`);
  }

  assert.deepEqual(
    missing,
    [],
    'Un ritiro punta a un vincitore che non esiste.\n'
    + 'La voce EDGE_RETIRED_PATHS che verrà scritta dall\'altro lato diventerebbe un 301 verso un '
    + '404 — peggio del duplicato che stava riparando.\n'
    + missing.map((l) => `   ${l}`).join('\n'),
  );
});

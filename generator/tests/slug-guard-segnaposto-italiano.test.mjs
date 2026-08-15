/**
 * ── IL SEGNAPOSTO TRADOTTO E LA GUARDIA RIMASTA IN INGLESE ──────────────────
 *
 * `inspectSlugForPromptPlaceholder` decide se il valore che il modello ha messo
 * nel campo `id` (o in `slugs.*`) e' un vero slug o il SEGNAPOSTO dello schema
 * copiato pari pari. Se lascia passare un segnaposto, quella stringa diventa un
 * URL pubblicato.
 *
 * `ID_PLACEHOLDER` dice «kebab-case ASCII, 3-5 parole, max 40 char».
 * Normalizzato: `id-kebab-case-ascii-3-5-parole-max-40-char`.
 * `SCHEMA_HINT_SHAPE_RX` cercava solo `\d+-\d+-words` e `max-\d+-chars`:
 * `parole` non e' `words`, `char` non e' `chars`, quindi nessuna alternativa
 * matchava e il guard rispondeva `leaked: false` sul segnaposto piu' importante
 * che esista. La variante inglese dello stesso testo matchava — ed e' il motivo
 * per cui il difetto sembrava impossibile.
 *
 * ── PERCHE' NON E' STATO VISTO PRIMA ────────────────────────────────────────
 *
 * Due strati di invisibilita', sovrapposti:
 *
 * 1. Lo step «Guard» di `generate-article.yml` gira solo
 *    `if steps.generate.outputs.article == 'true'`. Per dodici ore, il
 *    2026-08-14, nessun articolo e' stato generato: il guard era **skipped** in
 *    ogni run, quindi il difetto era irraggiungibile. Appena la generazione e'
 *    tornata a funzionare ha bocciato OGNI articolo — sei run di fila,
 *    04:06→05:12Z del 2026-08-15, tutte rosse sullo stesso step, con il corpo
 *    generato buttato via sul runner e `main` fermo da quasi 24 ore.
 *
 * 2. Il test che avrebbe dovuto coprirlo
 *    (`prompt-placeholder-guard.test.mjs`, «i letterali delegati allo slug
 *    guard sono davvero classificati da lui») importa `create-article.mjs` e,
 *    se l'import fallisce, fa `return` — passando. In questo repo
 *    `create-article.mjs` dipende da `jsdom`, che non e' installato: in locale
 *    quel test e' **verde a vuoto**, e lo e' su ogni macchina di sviluppo.
 *    Diventa rosso solo in CI.
 *
 * Questo file esiste per chiudere il punto 2: NON importa `create-article.mjs`.
 * Estrae dal sorgente le due funzioni che servono e le esegue. Gira uguale in un
 * checkout sparse, in CI e in locale.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ID_PLACEHOLDER, SLUG_OWNED_LITERALS } from '../scripts/lib/prompt-placeholder-guard.mjs';
// Importata, non estratta: create-article.mjs la prende da qui, quindi il
// modulo e' gia' la fonte di verita' e copiarla sarebbe misurare la copia.
import { truncateSlugAtWordBoundary } from '../scripts/lib/slug-truncate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf-8');

/** Ritaglia una dichiarazione top-level fino alla sua chiusura in colonna 0. */
function cutDecl(anchor) {
  const a = SRC.indexOf(anchor);
  assert.notEqual(a, -1, `dichiarazione non trovata — aggiornare questo test: ${anchor}`);
  const rel = SRC.slice(a).indexOf('\n}\n');
  assert.notEqual(rel, -1, `chiusura non trovata per: ${anchor}`);
  return SRC.slice(a, a + rel + 3);
}

/**
 * Ritaglia da un'ancora fino a un terminatore, con guardia di lunghezza.
 * `min` e' per-ritaglio perche' `SLUG_MAX_LENGTH` e' una costante di 27
 * caratteri: una soglia unica o e' inutile per le regex o boccia le costanti.
 */
function cut(startAnchor, endAnchor, min = 40) {
  const a = SRC.indexOf(startAnchor);
  assert.notEqual(a, -1, `ancora iniziale non trovata: ${startAnchor}`);
  const b = SRC.indexOf(endAnchor, a + startAnchor.length);
  assert.notEqual(b, -1, `ancora finale non trovata: ${endAnchor}`);
  const blocco = SRC.slice(a, b + endAnchor.length);
  assert.ok(blocco.length >= min, `ritaglio troppo corto (${blocco.length} < ${min}): ancore sbagliate — ${startAnchor}`);
  return blocco;
}

// Il classificatore vero, estratto dal file che gira ed eseguito.
const harness = new Function(
  'truncateSlugAtWordBoundary',
  `${cut('const SLUG_MAX_LENGTH =', ';', 20)}
   ${cutDecl('function slugifySlugPart(')}
   ${cut('const NON_SLUG_REMAINDER_RX =', ';')}
   ${cut('const SCHEMA_HINT_UNIT =', ';')}
   ${cut('const SCHEMA_HINT_SHAPE_RX = new RegExp(', "\n);")}
   ${cut('const PROMPT_SLUG_PREFIX_RX =', ';')}
   ${cutDecl('export function inspectSlugForPromptPlaceholder(').replace('export ', '')}
   return { slugifySlugPart, inspectSlugForPromptPlaceholder };`,
)(truncateSlugAtWordBoundary);

const { slugifySlugPart, inspectSlugForPromptPlaceholder } = harness;
// La stessa domanda che si pone lo step «Guard» in CI, ma senza importare
// create-article.mjs (che qui non e' caricabile: dipende da jsdom).
const riconosciuto = (letterale) => inspectSlugForPromptPlaceholder(letterale).leaked === true;

describe('la forma dello schema e\' riconosciuta anche in italiano', () => {
  it('guardia: l\'estrazione ha prodotto codice VERO', () => {
    // Senza questa, un ritaglio sbagliato renderebbe ogni asserzione sotto
    // vacua — che e' precisamente il modo in cui il difetto e' arrivato in
    // produzione.
    assert.equal(typeof slugifySlugPart, 'function');
    assert.equal(typeof inspectSlugForPromptPlaceholder, 'function');
    assert.equal(slugifySlugPart('Economia Svizzera: crescita 2026'), 'economia-svizzera-crescita-2026');
    // e il classificatore risponde davvero, non `undefined`
    assert.equal(inspectSlugForPromptPlaceholder('economia-svizzera-crescita-2026').leaked, false);
  });

  it('ID_PLACEHOLDER, che e\' quello che il prompt mostra davvero, e\' riconosciuto', () => {
    // Parte dalla costante, non da una copia scritta a mano: se il segnaposto
    // viene riformulato, questo test lo segue invece di misurare il passato.
    assert.ok(
      riconosciuto(ID_PLACEHOLDER),
      `il guard non riconosce ID_PLACEHOLDER ("${ID_PLACEHOLDER}") → normalizzato `
      + `"${slugifySlugPart(ID_PLACEHOLDER)}"`,
    );
  });

  it('OGNI letterale delegato allo slug guard e\' classificato da lui', () => {
    // E' l'asserzione che in CI e' rossa e in locale passa a vuoto, rifatta
    // senza l'import che la rende vacua. Se un letterale sfugge, il suo testo
    // finisce in un URL pubblicato.
    assert.ok(SLUG_OWNED_LITERALS.length >= 4, `attesi >=4 letterali, trovati ${SLUG_OWNED_LITERALS.length}`);
    const scoperti = SLUG_OWNED_LITERALS.filter((l) => !riconosciuto(l));
    assert.deepEqual(scoperti, [], `letterali che lo slug guard non riconosce: ${JSON.stringify(scoperti)}`);
  });

  it('entrambe le lingue, singolare e plurale', () => {
    for (const forma of [
      '<<ID: kebab-case ASCII, 3-5 parole, max 40 char>>',
      '<<ID: kebab-case ASCII, 3-5 words, max 40 chars>>',
      'max-40-caratteri',
      '3-5-parole',
      'kebab-case-3-5-words-max-40-chars',
    ]) {
      assert.ok(riconosciuto(forma), `forma non riconosciuta: ${forma}`);
    }
  });

  it('gli slug VERI non vengono scambiati per segnaposto', () => {
    // La direzione pericolosa dell'altra: una regex troppo larga scarterebbe
    // articoli buoni, e lo farebbe in silenzio (il guard butta il corpo).
    for (const vero of [
      'economia-svizzera-crescita-2026',
      'frontalieri-ticino-imposta-fonte-2026',
      'affitti-svizzera-mercato-immobiliare-2026-canton-san-gallo',
      'bonus-200-euro-lavoratori',
      'stipendio-medio-infermiere-ticino',
      'accordo-fiscale-2026-cosa-cambia',
    ]) {
      assert.ok(!riconosciuto(vero), `slug vero scambiato per segnaposto: ${vero}`);
    }
  });
});

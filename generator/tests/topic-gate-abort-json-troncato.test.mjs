/**
 * ── IL TRONCAMENTO NON PUO' ESSERE LETTO COME UN RIFIUTO ───────────────────
 *
 * Issue #828 (item 2 di #810). Il padre sospettava che una generazione
 * TRONCATA fosse indistinguibile da un abort di REGOLA #0: se il modello
 * emette `"abort_topical_relevance": true` e poi la risposta viene tagliata,
 * e se `repairLlmJson` chiudesse il taglio, il payload riparato sarebbe un
 * abort perfetto — cioe' un verdetto TERMINALE (da #807: nessuna
 * rigenerazione, sezione chiusa senza articolo) su una risposta che il
 * modello aveva solo lasciato a meta'.
 *
 * Oggi quel percorso e' IRRAGGIUNGIBILE, ma non per una guardia: per due
 * invarianti indipendenti che nessuno aveva pinnato.
 *
 *   1. ORDINE DELLO SCHEMA — in `buildArticleJsonSchema` `content` PRECEDE
 *      `abort_topical_relevance`/`reason`, sia nello schema pieno sia nella
 *      meta' body (`ROOT_KEYS_BODY`). Un taglio DOPO il flag implica quindi
 *      il contenuto gia' serializzato: non e' un abort, e i gate lo vedono.
 *   2. NESSUNA CHIUSURA DEI TAGLI — `repairLlmJson` ripara fence, `**` fuori
 *      stringa, virgolette interne non escapate e virgole doppie, ma NON
 *      chiude un JSON troncato: il parse lancia, il chiamante lo legge da
 *      `parseErr` e rigenera con un `maxTokens` piu' alto.
 *
 * Entrambi sono a un `properties: {}` riordinato / a un ramo di chiusura in
 * piu' dalla rottura, e in quel giorno una generazione troncata verrebbe
 * accettata come rifiuto e mai rigenerata. Questo file non cambia
 * comportamento: rende i due invarianti non-regredibili.
 *
 * Misura al 2026-09-04, sui prefissi di un payload d'abort tipico:
 * riparati a JSON valido = 0, letti come abort = 0.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { repairLlmJson } from '../scripts/lib/llm-json-repair.mjs';
import {
  isTopicGateAbortVerdict,
  classifyBody2Payload,
  BODY_ONLY_FIELDS,
} from '../scripts/lib/body2-payload-verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const src = readFileSync(CREATE_ARTICLE, 'utf-8');

// `create-article.mjs` non e' importabile dalle gate (girano `node --test`
// senza `npm ci`, e quel file tira dentro jsdom via extract-article-text).
// `buildArticleJsonSchema` e' pero' una dichiarazione top-level autosufficiente:
// si ritaglia dal sorgente e si esegue, come gia' fa
// `news-prompt-token-budget.test.mjs`. Cosi' il test misura lo SCHEMA VERO e
// non una copia che diverge in silenzio.
function cutDecl(startAnchor) {
  const a = src.indexOf(startAnchor);
  assert.notEqual(a, -1, `dichiarazione non trovata — aggiornare questo test: ${startAnchor}`);
  const rel = src.slice(a).indexOf('\n}\n');
  assert.notEqual(rel, -1, `chiusura non trovata per: ${startAnchor}`);
  return src.slice(a, a + rel + 3);
}
const buildArticleJsonSchema = new Function(
  `${cutDecl('function buildArticleJsonSchema(')}\nreturn buildArticleJsonSchema;`,
)();

// ═══ 1. L'ordine dello schema: `content` prima del flag ═══════════════════
//
// L'ordine delle chiavi di `properties` e' l'ordine in cui i provider in
// strict mode serializzano la risposta. Finche' `content` viene prima, un
// taglio che ha gia' emesso `abort_topical_relevance` ha per forza emesso
// anche il contenuto — e un payload con contenuto non e' un abort.
test('#828 §1 — lo schema serializza `content` PRIMA di `abort_topical_relevance`', async (t) => {
  for (const part of ['full', 'body']) {
    await t.test(`parte ${part}`, () => {
      const keys = Object.keys(buildArticleJsonSchema('it', part).schema.properties);
      for (const flag of ['abort_topical_relevance', 'reason']) {
        assert.ok(keys.includes(flag), `lo schema '${part}' non dichiara piu' \`${flag}\``);
        assert.ok(
          keys.indexOf('content') < keys.indexOf(flag),
          `lo schema '${part}' mette \`${flag}\` prima di \`content\` (ordine: ${keys.join(', ')}). `
          + 'Con quest\'ordine una risposta troncata dopo il flag e senza contenuto e\' un abort '
          + 'sintatticamente perfetto: il taglio tornerebbe distinguibile da un rifiuto solo per '
          + 'il fatto che repairLlmJson non chiude i troncamenti (§2). Vedi issue #828.',
        );
      }
    });
  }

  await t.test('la meta\' meta non porta il flag: aborta solo chi vede la fonte intera', () => {
    const keys = Object.keys(buildArticleJsonSchema('it', 'meta').schema.properties);
    assert.ok(!keys.includes('abort_topical_relevance'), 'REGOLA #0 e\' decisa dalla chiamata body, non dalla meta');
  });
});

// ═══ 2. `repairLlmJson` non chiude i troncamenti ══════════════════════════
//
// Due basi, tagliate a OGNI prefisso:
//   - `SCHEMA_ORDER` — l'ordine che lo schema impone davvero (content prima);
//   - `FLAG_FIRST`   — il caso PEGGIORE, l'ordine che §1 esclude. Vale la pena
//     misurarlo lo stesso: e' l'unico modo perche' questo test resti utile
//     anche il giorno in cui qualcuno riordina `properties`.
const CORPO = 'Il Consiglio di Stato del Canton Ticino ha approvato il messaggio 8412 che rivede '
  + 'l\'imposta alla fonte per i frontalieri residenti in Italia. ';

const SCHEMA_ORDER = JSON.stringify({
  content: { it: { title: 'Un titolo', excerpt: 'Un excerpt', body1: CORPO.repeat(3), body2: CORPO.repeat(3), body3: CORPO.repeat(3), faq: [] } },
  abort_topical_relevance: true,
  reason: 'la fonte non ha un angolo frontaliere reale',
});

const FLAG_FIRST = '{"abort_topical_relevance": true, "reason": "no nesso", "seo": {"title": "T"}, '
  + '"content": {"it": {"title": "Un titolo", "excerpt": "Un excerpt", "body1": "corpo lungo che viene tagliato a meta';

/** Ritorna i prefissi che `repairLlmJson` riporta a JSON valido, e quanti di quelli sono letti come abort. */
function misuraPrefissi(base) {
  const riparati = [];
  let letticomeAbort = 0;
  for (let n = 40; n < base.length; n++) {
    let parsed;
    try {
      parsed = JSON.parse(repairLlmJson(base.slice(0, n)));
    } catch {
      continue; // il caso atteso: il taglio lancia, e il chiamante rigenera
    }
    riparati.push(n);
    if (isTopicGateAbortVerdict(parsed)) letticomeAbort += 1;
  }
  return { riparati, letticomeAbort };
}

test('#828 §2 — nessun prefisso troncato viene riparato in un abort', async (t) => {
  for (const [nome, base] of Object.entries({ SCHEMA_ORDER, FLAG_FIRST })) {
    await t.test(`base ${nome} (${base.length} prefissi)`, () => {
      const { riparati, letticomeAbort } = misuraPrefissi(base);
      assert.equal(
        letticomeAbort, 0,
        `${letticomeAbort} prefissi troncati di ${nome} vengono riparati in un payload letto come `
        + 'abort di REGOLA #0. Da #807 quel verdetto e\' TERMINALE: una generazione tagliata a meta\' '
        + 'verrebbe scartata come rifiuto e mai rigenerata. Vedi issue #828.',
      );
      assert.deepEqual(
        riparati, [],
        `repairLlmJson ha chiuso ${riparati.length} troncamenti di ${nome} (offset ${riparati.slice(0, 5).join(', ')}...). `
        + 'La sua intestazione dichiara il contrario ("Truncated payloads still throw — callers detect '
        + 'that via parseErr.message and retry with a larger maxTokens"): se la chiusura e\' voluta, '
        + 'i due gate d\'abort vanno resi ciechi ai payload passati per la riparazione.',
      );
    });
  }

  await t.test('controllo di non-vacuita\': la base INTERA parla', () => {
    // Senza questo, un test che asserisce «nessun prefisso parsa» resterebbe
    // verde anche se repairLlmJson tornasse spazzatura su tutto.
    const pieno = JSON.parse(repairLlmJson(SCHEMA_ORDER));
    assert.equal(pieno.abort_topical_relevance, true);
    assert.equal(
      isTopicGateAbortVerdict(pieno), false,
      'un payload col contenuto pieno non e\' un abort, per quanto alzi il flag',
    );
    const abortPuro = JSON.parse(repairLlmJson('{"content": null, "abort_topical_relevance": true, "reason": "no nesso"}'));
    assert.equal(isTopicGateAbortVerdict(abortPuro), true, 'l\'abort puro deve restare riconosciuto');
  });
});

// ═══ 3. Il taglio arriva ai gate come `reject`, non come abort ════════════
//
// L'altra meta' del contratto dell'intestazione di `llm-json-repair.mjs`:
// non basta che il parse lanci, serve che il chiamante traduca quel lancio in
// «rigenera». `classifyBody2Payload` e' il gate che lo fa, su entrambe le
// forme di chiamata (unica e meta' body dello split).
test('#828 §3 — un payload troncato e\' `reject` (rigenerabile), mai `topic-gate-abort`', async (t) => {
  const tagliato = FLAG_FIRST.slice(0, 120);
  let parseErr = null;
  let parsed;
  try {
    parsed = JSON.parse(repairLlmJson(tagliato));
  } catch (err) {
    parseErr = err;
  }
  assert.ok(parseErr, 'il troncamento deve arrivare al gate come errore di parse, non come oggetto');

  for (const expectedFields of [undefined, BODY_ONLY_FIELDS]) {
    await t.test(`campi attesi: ${expectedFields ? expectedFields.join('/') : 'articolo completo'}`, () => {
      const { verdict } = classifyBody2Payload({ parsed, parseErr, ...(expectedFields ? { expectedFields } : {}) });
      assert.equal(
        verdict, 'reject',
        'un troncamento deve restare rigenerabile: `topic-gate-abort` chiude la sezione senza articolo',
      );
    });
  }
});

/**
 * ── IL RIGETTO CHE NON SI POTEVA ATTRIBUIRE ─────────────────────────────────
 *
 * Il ciclo di rigenerazione del contenuto e' il primo consumatore di tempo di
 * parete dello step «Generate the article». Misurato il 2026-08-18 su 4 run:
 *
 *     run           step      rigenerazioni   tempo nelle rigenerazioni
 *     32134269129   1189 s    4               905 s   (76%)
 *     32140039370    468 s    3               274 s   (59%)
 *     32130136859   1008 s    1               655 s   (65%)
 *     32129609417    312 s    0                 0 s   ( 0%)
 *
 * La run senza rigenerazioni e' anche la piu' corta di tutte.
 *
 * Il messaggio che apre ogni sequenza e' sempre lo stesso, e non dice quale
 * delle due famiglie sia — troncamento dell'output (leva: il tetto di uscita)
 * o forma sbagliata (leva: prompt o normalizzatore). Le due vogliono rimedi
 * opposti, quindi «non normalizzabile» da solo manda a riparare a caso.
 *
 * QUESTO TEST E' L'OSSERVATORE. Non prova che il rigetto sia sparito: prova
 * che al PROSSIMO incidente si potra' dire quale famiglia e', senza
 * riprodurlo. Se qualcuno rimette la diagnostica dietro `if (parseErr)` —
 * cioe' il difetto originale, che rendeva muto il 76% dei rigetti della run
 * piu' cara — il test qui sotto diventa rosso.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyTruncation,
  describePayloadRejection,
} from '../scripts/lib/llm-payload-diagnostics.mjs';
import { findMatchingClose, fixJsonStringBody } from '../scripts/lib/llm-json-repair.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf-8');

/**
 * Il documento che il modello DOVEVA mandare, nella forma esatta che i log di
 * produzione mostrano (run 32140039370): metadati, `imageAlt` con i 4 locali,
 * `slugs`, poi `content.it`. La struttura conta: e' la graffa che chiude
 * `imageAlt` il punto in cui il ritaglio di `repairLlmJson()` va a sbattere.
 */
function documentoSano(body = 'Un paragrafo di corpo abbastanza lungo da superare la soglia dei quaranta caratteri.') {
  return `{
  "id": "vivere-oggebbio-lavorare-ticino-frontalieri",
  "category": "pratico",
  "image": "lugano-view.webp",
  "hasCalculator": true,
  "imagePrompt": "Un giornalista fotografisce la vista di Lugano dalla collina.",
  "imageAlt": {
    "it": "Una vista di Lugano dalla collina.",
    "en": "A view of Lugano from the hill.",
    "de": "Eine Aussicht auf Lugano vom Hügel.",
    "fr": "Une vue de Lugano depuis la colline."
  },
  "slugs": {
    "it": "a", "en": "b", "de": "c", "fr": "d"
  },
  "content": {
    "it": {
      "title": "Vivere a Oggebbio e lavorare in Ticino da frontaliere",
      "excerpt": "Il nuovo Accordo Frontalieri ha cambiato le regole per chi lavora in Ticino.",
      "body1": ${JSON.stringify(body)},
      "body2": ${JSON.stringify(body)},
      "body3": ${JSON.stringify(body)}
    }
  }
}`;
}

/** `repairLlmJson()` di create-article.mjs, ricopiato: la' non e' esportata. */
function repairLike(raw) {
  let c = raw;
  const start = c.indexOf('{');
  if (start !== -1) {
    const closeIdx = findMatchingClose(c, start, true);
    if (closeIdx !== -1) c = c.slice(start, closeIdx + 1);
    else {
      const end = c.lastIndexOf('}');
      if (end > start) c = c.slice(start, end + 1);
    }
  }
  return fixJsonStringBody(c, { fixAsterisks: true })
    .replace(/,(\s*,)+/g, ',')
    .replace(/,(\s*[}\]])/g, '$1');
}

/** Il giro completo che fa `callLLM()`: repair → parse → diagnostica. */
function diagnostica(raw, model = 'nvidia/meta/llama-3.1-8b-instruct') {
  const repaired = repairLike(raw);
  let parsed;
  let parseErr = null;
  try {
    parsed = JSON.parse(repaired);
  } catch (e) {
    parseErr = e;
  }
  return describePayloadRejection({ raw, repaired, parsed, parseErr, model });
}

describe('classifyTruncation distingue un documento chiuso da uno tagliato a meta\'', () => {
  it('un documento chiuso non e\' troncato', () => {
    const t = classifyTruncation(documentoSano());
    assert.equal(t.troncato, false);
    assert.equal(t.chiude, true);
    assert.equal(t.profondita, 0);
    assert.equal(t.inStringa, false);
  });

  it('una completion tagliata a meta\' frase e\' troncata', () => {
    // La coda esatta del raw della run 32140039370, che finiva cosi'.
    const raw = documentoSano().slice(0, 900);
    const t = classifyTruncation(raw);
    assert.equal(t.troncato, true, 'un testo che non finisce con una graffa deve risultare troncato');
    assert.ok(t.profondita > 0, `profondita attesa > 0, ottenuta ${t.profondita}`);
    assert.ok(t.coda.length > 0, 'la coda serve a far vedere DOVE si e\' fermato');
  });

  it('la graffa di chiusura vale anche dietro un code fence', () => {
    assert.equal(classifyTruncation('{"a":1}\n```').troncato, false);
  });
});

describe('la riga di rigetto attribuisce la famiglia senza riprodurre l\'incidente', () => {
  it('output troncato → famiglia=troncato, e dice quanto il repair ha buttato via', () => {
    // Riproduzione fedele dell'incidente: nella run 32140039370 il raw era di
    // 12.780 caratteri (≈ il tetto di 4000 token in italiano) e finiva a meta'
    // frase, e `repairLlmJson()` ne ha tenuti 430 — il 3,4%. L'errore riprodotto
    // in locale su questa stessa forma e' identico a quello di produzione:
    // «Expected ',' or '}' after property value in JSON at position 430
    // (line 12 column 4)».
    const raw = documentoSano('Il Nuovo Accordo Frontalieri ha modificato le regole. '.repeat(40)).slice(0, 900);
    const riga = diagnostica(raw);

    assert.match(riga, /famiglia=troncato/, riga);
    assert.match(riga, /chiudeConGraffa=no/, riga);

    const kept = Number(/kept=([\d.]+)%/.exec(riga)?.[1]);
    assert.ok(Number.isFinite(kept), `kept= assente dalla riga: ${riga}`);
    assert.ok(
      kept < 100,
      `il ritaglio ha buttato via meta' documento e kept= non lo dice (${kept}%)`,
    );
  });

  it('JSON valido ma senza i campi → famiglia=forma-sbagliata(chiavi), NON troncato', () => {
    // Il caso muto: `JSON.parse` riesce, il normalizzatore torna null. E' la
    // maggioranza dei rigetti (49 su 64 raccolti dai log) ed e' esattamente
    // cio' che un troncamento NON puo' produrre: misurato su 76 punti di
    // troncamento campionati, TUTTI danno un errore di parse.
    const riga = diagnostica('{"articolo": {"content": {"it": {"titolo": "x"}}}}');
    assert.match(riga, /famiglia=forma-sbagliata\(chiavi\)/, riga);
    assert.match(riga, /parse=ok/, riga);
    assert.match(riga, /chiaviRadice=\[articolo\]/, riga);
  });

  it('campi presenti ma vuoti → li distingue da campi assenti', () => {
    const riga = diagnostica('{"content": {"it": {"title": "", "excerpt": "ok", "body1": 3}}}');
    assert.match(riga, /title:vuoto/, riga);
    assert.match(riga, /excerpt:2ch/, riga);
    assert.match(riga, /body1:nonstringa\(number\)/, riga);
    assert.match(riga, /body2:assente/, riga);
  });

  it('ogni campo c\'e\' sempre, anche a zero', () => {
    // Un campo che compare solo quando c'e' qualcosa costringe chi legge il
    // prossimo incidente a distinguere «non e' arrivato niente» da «la
    // diagnostica non era ancora stata aggiunta». E' la stessa ambiguita' che
    // questo rigetto aveva gia'.
    const riga = diagnostica('', null);
    for (const campo of [
      'famiglia=', 'model=', 'rawChars=', 'repairedChars=', 'kept=', 'parse=',
      'tipo=', 'chiaviRadice=', 'chiaviContent=', 'chiaviIt=', 'campiIt=',
      'campiRadice=', 'chiudeConGraffa=', 'profondita=', 'inStringa=', 'coda=',
    ]) {
      assert.ok(riga.includes(campo), `campo ${campo} assente su input vuoto: ${riga}`);
    }
    assert.match(riga, /model=sconosciuto/, 'il modello ignoto va detto, non omesso');
  });

  it('nomina il modello che ha DAVVERO risposto', () => {
    // L'intestazione del log annuncia il modello preferito
    // (`🤖 [1/5] ... con gpt-4.1...`), non quello che risponde: nella run
    // 32140039370 a rispondere e' stato un llama sceso dalla cascata.
    // Attribuire il rigetto al modello annunciato manda a riparare quello
    // sbagliato.
    assert.match(diagnostica('{}', 'nvidia/meta/llama-3.1-8b-instruct'), /model=nvidia\/meta\/llama-3\.1-8b-instruct/);
  });
});

describe('il ramo di rigetto di create-article.mjs resta parlante', () => {
  /** Il blocco `if (!itContent) { … }`, ritagliato dal sorgente. */
  function ramoNonNormalizzabile() {
    const a = SRC.indexOf("missing.push('content.it non normalizzabile');");
    assert.notEqual(a, -1, 'ancora iniziale non trovata — aggiornare questo test');
    const b = SRC.indexOf('      } else {', a);
    assert.notEqual(b, -1, 'ancora finale non trovata — aggiornare questo test');
    const blocco = SRC.slice(a, b);
    assert.ok(blocco.length > 200, `ritaglio troppo corto (${blocco.length}) — ancore sbagliate`);
    return blocco;
  }

  it('la diagnostica del rigetto e\' incondizionata, non dietro `if (parseErr)`', () => {
    const blocco = ramoNonNormalizzabile();
    const chiamata = blocco.indexOf('describePayloadRejection(');
    assert.notEqual(chiamata, -1, 'il ramo non chiama describePayloadRejection: il caso muto torna muto');
    const guardia = blocco.indexOf('if (parseErr) {');
    assert.ok(
      guardia === -1 || chiamata < guardia,
      'describePayloadRejection e\' finita dentro `if (parseErr)`: e\' esattamente il difetto '
        + 'che rendeva muti 4 rigetti su 4 nella run 32134269129 (76% dello step)',
    );
  });

  it('il raw viene sempre allegato, non solo quando il parse fallisce', () => {
    const blocco = ramoNonNormalizzabile();
    const raw = blocco.indexOf('describeRawForDiagnostics(result)');
    assert.notEqual(raw, -1, 'il ramo non allega piu\' il raw');
    const guardia = blocco.indexOf('if (parseErr) {');
    assert.ok(
      guardia === -1 || raw > blocco.indexOf('}', guardia),
      'il raw e\' tornato dentro `if (parseErr)`: senza di lui la famiglia del caso muto '
        + 'resta indecidibile',
    );
  });

  it('anche il ramo «campi mancanti» dice modello e lunghezza', () => {
    const a = SRC.indexOf('output JSON incompleto: ${missing.join');
    assert.notEqual(a, -1, 'ancora non trovata — aggiornare questo test');
    const blocco = SRC.slice(a, a + 1500);
    assert.ok(
      blocco.includes('describePayloadRejection('),
      '`body1, body2, body3` senza modello ne\' lunghezza e\' compatibile sia con un '
        + 'troncamento sia con un involucro di troppo — e in una run e\' costato 655 s',
    );
  });
});

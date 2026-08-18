/**
 * ── IL VERDETTO SUL PAYLOAD DI GENERAZIONE ─────────────────────────────────
 *
 * Il ciclo `isBody2Check` dentro `callLLM()` (generator/scripts/create-article.mjs)
 * decide, per ogni risposta del modello alla generazione IT completa, se il
 * payload e' utilizzabile o se va rigenerato. Fino al 2026-08-18 quella
 * decisione era binaria — «normalizzabile» oppure «rigenera» — e conosceva
 * DUE esiti dove il contratto del prompt ne prevede TRE.
 *
 * ## Il terzo esito, che mancava
 *
 * `buildArticleJsonSchema()` dichiara due forme valide di risposta:
 *
 *   1. l'articolo pieno (`content.it` popolato, `abort_topical_relevance` null);
 *   2. l'abort di REGOLA #0: `{ "abort_topical_relevance": true, "reason": "…" }`
 *      con TUTTI i campi di contenuto a null.
 *
 * La forma 2 non e' un'invenzione del modello: e' il prompt stesso a
 * ordinargliela («torna al GATE DI RILEVANZA TOPICA (REGOLA #0) e rifiuta con
 * "abort_topical_relevance": true»), ed e' la difesa contro la classe di
 * allucinazione «Malpensa» — una fonte senza vero aggancio frontaliere da cui
 * il modello inventerebbe il nesso pur di consegnare un articolo.
 *
 * Il chiamante di `callLLM()` sa gestire quella forma: c'e' un ramo dedicato
 * («REGOLA #0 abort gate») che la classifica, la conta in `RUN_REPORT
 * .topicGateAborts` e alza `err.topicGateAbort`. Ma quel ramo non veniva MAI
 * raggiunto sul percorso della chiamata unica, perche' `callLLM()` rigettava
 * la risposta prima di restituirla: `normalizeItalianContentFromPayload()`
 * torna `null` su un payload di abort — e giustamente, il contenuto e' null —
 * e il ciclo leggeva quel `null` come «JSON malformato».
 *
 * ## Cosa costava
 *
 * Misurato sulla run 32175400548 del 2026-08-18 (19:15:09Z), sezione svizzera:
 * `claude-cli/haiku` — primo del roster e, dopo l'evaporazione del free tier,
 * l'unico percorso affidabile — ha risposto in 484 caratteri con un abort
 * perfettamente conforme:
 *
 *     {"abort_topical_relevance":true,"reason":"La fonte riguarda
 *      l'inaugurazione di una nuova ala ospedaliera a Coira (Grigioni) …",
 *      "id":null,"category":null,…,"content":null,"seo":null}
 *
 * e il ciclo ha stampato `content.it non normalizzabile (tentativo 1/5)` e ha
 * rigenerato. Quattro rigenerazioni da 60-240 s ciascuna sullo stesso modello,
 * un `recordModelContentFailure()` a ogni giro contro un modello che aveva
 * risposto correttamente, e la sezione chiusa con «no article generated».
 * Senza articolo non c'e' push su `content/**`, quindi la catena
 * auto-invocante non riparte e si aspetta il prossimo `schedule` (:07 e :37).
 *
 * Un abort legittimo deve costare UNA chiamata.
 *
 * ## Perche' questo modulo esiste, invece di due righe dentro callLLM()
 *
 * `create-article.mjs` non e' importabile dai test: le gate del generatore
 * girano `node --test` senza `npm ci` (vedi .github/workflows/tests.yml), e
 * quel file tira dentro `jsdom` per via di `extract-article-text.mjs`. Una
 * regola di classificazione lasciata inline sarebbe quindi verificabile solo
 * ricopiandola nel test — cioe' con una copia che diverge in silenzio, che e'
 * esattamente la forma di difetto che il ciclo continua a pagare (vedi
 * `SiteShellContract` e la nota sul drift check in CLAUDE.md).
 *
 * Qui invece la funzione e' PURA e dependency-free, quindi il test esegue lo
 * STESSO oggetto codice che gira in produzione, e `callLLM()` la importa.
 *
 * NOTA DI SCOPE: questo modulo classifica, non decide la politica. Non stampa,
 * non tocca il punteggio dei modelli, non lancia. Chi lo chiama traduce il
 * verdetto in comportamento.
 */

import { isNonItalianScript, nonItalianScriptRatio } from './itLanguageCheck.mjs';

/**
 * I campi di testo che una generazione IT completa DEVE portare.
 * Vive qui e non in create-article.mjs perche' e' il vocabolario del verdetto:
 * `normalizeItalianContentFromPayload` e `classifyBody2Payload` lo condividono,
 * e una terza copia nel test lo farebbe divergere.
 */
export const REQUIRED_IT_BODY_FIELDS = ['title', 'excerpt', 'body1', 'body2', 'body3'];

/**
 * Estrae il blocco di contenuto nella lingua primaria da un payload di
 * generazione, tollerando le tre forme che i modelli producono davvero:
 * `content.it.*`, `content.*` (locale saltato), o i campi alla radice.
 *
 * Torna `null` quando NESSUNO dei candidati porta almeno un campo non vuoto —
 * il che include, per costruzione, il payload di abort di REGOLA #0. Quel
 * `null` da solo NON significa «malformato»: e' `classifyBody2Payload()` a
 * distinguere i due casi.
 */
export function normalizeItalianContentFromPayload(payload, locale = 'it') {
  const content = payload?.content;
  const candidates = [];

  if (content && typeof content === 'object') {
    if (content[locale] && typeof content[locale] === 'object') candidates.push(content[locale]);
    candidates.push(content);
  }
  candidates.push(payload);

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const block = {};
    let hasAnyField = false;

    for (const field of REQUIRED_IT_BODY_FIELDS) {
      const value = typeof candidate[field] === 'string' ? candidate[field].trim() : '';
      if (value) hasAnyField = true;
      block[field] = value;
    }

    if (hasAnyField) return block;
  }

  return null;
}

/**
 * Il payload dichiara l'abort di REGOLA #0?
 *
 * Volutamente `=== true` e non truthy: lo schema modella il campo come
 * `['boolean', 'null']`, e un modello che rispondesse `"false"` (stringa) o
 * `0` non sta dichiarando un abort. Un falso positivo qui butterebbe via un
 * articolo valido senza rigenerarlo, che e' il danno peggiore dei due.
 */
export function isTopicGateAbortPayload(parsed) {
  return parsed?.abort_topical_relevance === true;
}

/**
 * Classifica una risposta di generazione IT gia' riparata e parsata.
 *
 * @param {object}  args
 * @param {unknown} args.parsed    l'oggetto uscito da JSON.parse(repairLlmJson(raw)),
 *                                 oppure undefined se il parse e' fallito.
 * @param {Error|null} args.parseErr l'errore di JSON.parse, se c'e' stato.
 * @param {string}  [args.locale]  la lingua primaria attesa.
 *
 * @returns {{ verdict: 'ok'|'topic-gate-abort'|'reject', itContent: object|null, missing: string[] }}
 *
 *   - `ok`               → il payload e' utilizzabile: `itContent` popolato, `missing` vuoto.
 *   - `topic-gate-abort` → il modello ha ESERCITATO REGOLA #0. Non e' un errore
 *                          e non e' rigenerabile: rigenerare ripropone la stessa
 *                          fonte allo stesso modello, che rifiutera' di nuovo.
 *                          `missing` e' vuoto apposta — non manca niente.
 *   - `reject`           → payload malformato o incompleto; `missing` elenca i
 *                          motivi, nella stessa forma che il log gia' stampava.
 *
 * L'ORDINE dei rami e' l'invariante che conta: l'abort si riconosce PRIMA di
 * trattare `itContent === null` come un difetto. L'ordine opposto e' il difetto
 * misurato sulla run 32175400548.
 *
 * Il caso «abort dichiarato MA contenuto pieno» NON e' un abort: torna `ok` (o
 * `reject`, se il contenuto e' davvero incompleto) e lascia intatta la guardia
 * di auto-contraddizione del chiamante, che dal 2026-07-06 sceglie il contenuto
 * sopra il flag. Fidarsi del flag li' aveva buttato un articolo valido e in
 * tema (osservato su local/fallback qwen2.5:14b).
 */
export function classifyBody2Payload({ parsed, parseErr = null, locale = 'it' } = {}) {
  const itContent = parseErr ? null : normalizeItalianContentFromPayload(parsed, locale);

  // ── Ramo 1: l'abort, riconosciuto PRIMA del ramo «non normalizzabile» ──
  // Solo quando il contenuto e' davvero assente: con `itContent` popolato il
  // modello si e' contraddetto, e la decisione spetta al chiamante.
  if (!itContent && !parseErr && isTopicGateAbortPayload(parsed)) {
    return { verdict: 'topic-gate-abort', itContent: null, missing: [] };
  }

  const missing = [];

  if (!itContent) {
    missing.push('content.it non normalizzabile');
    return { verdict: 'reject', itContent: null, missing };
  }

  for (const field of REQUIRED_IT_BODY_FIELDS) {
    if (!itContent?.[field] || itContent[field].length < 1) {
      missing.push(field);
    }
  }
  if (itContent.body2 && itContent.body2.trim().length < 40) missing.push('body2<40');
  // Language sanity — fallback models occasionally drift to CJK / Cyrillic
  // when prompted in Italian. Treat as malformed output: penalises the model,
  // chain rotates, no budget burned at the outer headline-validation layer.
  // See run 26446721285.
  for (const field of REQUIRED_IT_BODY_FIELDS) {
    const val = itContent?.[field];
    if (typeof val === 'string' && val.length > 0 && isNonItalianScript(val)) {
      const ratio = (nonItalianScriptRatio(val) * 100).toFixed(0);
      missing.push(`${field} non-IT script (${ratio}% non-Latin)`);
    }
  }

  return { verdict: missing.length > 0 ? 'reject' : 'ok', itContent, missing };
}

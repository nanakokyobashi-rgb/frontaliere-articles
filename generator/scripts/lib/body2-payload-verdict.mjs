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
 * I campi che ciascuna meta' dello split PRODUCE DAVVERO.
 *
 * Non sono un sottoinsieme arbitrario: sono la proiezione di `CONTENT_KEYS_BODY`
 * e `CONTENT_KEYS_META` (create-article.mjs, `buildArticleJsonSchema`) sui campi
 * di testo che questo modulo sa giudicare. La meta' body NON PUO' portare
 * `title`/`excerpt` — lo schema `article_body_only` non li dichiara nemmeno — e
 * la meta' meta non puo' portare i body.
 */
export const BODY_ONLY_FIELDS = ['body1', 'body2', 'body3'];
export const META_ONLY_FIELDS = ['title', 'excerpt'];

/**
 * Un modello che emette la stringa letterale `"null"` su un campo di
 * `content` sta serializzando male il `null` JSON che il payload di abort di
 * REGOLA #0 dichiara per quello stesso campo — non sta scrivendo contenuto.
 * Senza questo filtro `normalizeItalianContentFromPayload` la conta come
 * valore non vuoto, `hasAnyField` diventa `true`, e un vero abort verrebbe
 * letto come un articolo il cui corpo e' testualmente "null".
 */
const LITERAL_NULL_STRING_RE = /^null$/i;

/**
 * ── CHI DECIDE QUALI CAMPI SONO ATTESI ─────────────────────────────────────
 *
 * `callLLM()` deve sapere due cose prima di giudicare una risposta: SE questa
 * chiamata e' una generazione da validare, e QUALI campi quella generazione
 * doveva produrre. Fino al 2026-08-19 le deduceva entrambe annusando il TESTO
 * del prompt:
 *
 *     opts.jsonMode && REQUIRED_IT_BODY_FIELDS.every(f => messages.some(m => m.content?.includes(f)))
 *
 * L'euristica cerca la PRESENZA DELLA STRINGA, non la RICHIESTA DEL CAMPO — e
 * una menzione NEGATIVA la accende. L'istruzione della meta' body dello split
 * (arrivata con #430) dice testualmente:
 *
 *     «content.it (body1, body2, body3). NON produrre id, category, image,
 *      slugs, title, excerpt, faq o seo: verranno chiesti in una chiamata
 *      separata.»
 *
 * Tutti e cinque i nomi compaiono: tre chiesti, DUE VIETATI. Il predicato
 * scattava a cinque campi, e una risposta body-only PERFETTAMENTE CONFORME
 * usciva come `output JSON incompleto: title, excerpt`, veniva rigenerata 5
 * volte camminando ogni volta la cascata dei modelli, e alla fine `callLLM`
 * LANCIAVA `qualityReject`.
 *
 * MISURA (log GitHub Actions del corpus). Lo split non ha completato una sola
 * volta da #430: sulle 4 run del 2026-08-18 (32187412494, 32182923129,
 * 32176062690, 32190158524) `call=1/2` e' stampato 25 volte e `call=2/2` ZERO.
 * Sulle run del 2026-08-19 32209129247 e 32193289552 `roster_blocked` compare
 * 12 e 11 volte, e il primo tentativo di ogni run brucia ~31 minuti senza
 * produrre nulla — modelli penalizzati da `recordModelContentFailure()` per
 * aver obbedito al contratto.
 *
 * ## Perche' un'opzione del chiamante, e non un'euristica migliore
 *
 * Qualunque euristica sul testo resta una congettura sulla prosa italiana: la
 * si puo' rendere piu' furba (cercare «NON produrre», pesare le posizioni) e
 * resterebbe a un rewording di distanza dal rompersi di nuovo, in silenzio e
 * con la CI verde. Il chiamante invece SA quale meta' sta chiedendo — e' lui a
 * scegliere lo schema (`article_body_only` / `article_metadata_only`) — quindi
 * il dato esiste gia' e va solo propagato: `opts.expectedFields`.
 *
 * ## Il default resta l'euristica, ed e' deliberato
 *
 * Senza `expectedFields` il comportamento e' BYTE-IDENTICO a prima. Non e'
 * timidezza: e' cio' che tiene in piedi le due protezioni che quella riga gia'
 * dava, e che il commento originale in `callLLM()` documenta.
 *
 *   (a) `translateArticle` fa chiamate a campo singolo (`{"body2": "..."}`).
 *       Li' il prompt nomina UN campo solo, l'euristica e' falsa, e la
 *       risposta non viene giudicata come un articolo. Se il default
 *       diventasse «valida sempre», `missing` sarebbe garantito non vuoto
 *       (title/excerpt/body1/body3 non sono in quel payload per costruzione) e
 *       ogni traduzione morirebbe di `qualityReject`.
 *
 *   (b) Il percorso di esaurimento retry LANCIA invece di cadere in fondo.
 *       Se il default diventasse «non validare senza flag», un chiamante che
 *       dimentica l'opzione tornerebbe a spedire contenuto in ITALIANO sotto
 *       /en /de /fr — il baco che quel throw esiste per impedire.
 *
 * Quindi il flag puo' solo RESTRINGERE o CONFERMARE cio' che l'euristica gia'
 * decideva, mai spegnere la validazione: chi non lo passa e' esattamente dove
 * era prima.
 *
 * `jsonMode` resta la condizione necessaria, e il flag NON la scavalca: una
 * chiamata senza `jsonMode` non produce JSON da giudicare, e accenderle la
 * validazione addosso vorrebbe dire rigettare del testo libero per «campi
 * mancanti».
 *
 * @param {object}   args
 * @param {boolean}  [args.jsonMode]       `opts.jsonMode` della chiamata.
 * @param {string[]} [args.expectedFields] i campi che il chiamante SA di aver chiesto.
 * @param {Array}    [args.messages]       i messaggi spediti, per il default euristico.
 * @returns {{ enabled: boolean, fields: string[] }}
 * @throws {TypeError} se `expectedFields` c'e' ma non e' un elenco valido.
 *
 * Il throw e' voluto ed e' un errore di PROGRAMMAZIONE, non di dato: non
 * dipende da cosa risponde un modello, quindi o sbaglia a ogni run (e il test
 * lo prende) o non sbaglia mai. L'alternativa — ricadere in silenzio
 * sull'euristica — ricrearebbe esattamente la classe di difetto che questa
 * funzione esiste per chiudere: una validazione che dice di guardare una cosa
 * e ne guarda un'altra.
 */
export function resolveBody2Validation({ jsonMode = false, expectedFields = null, messages = [] } = {}) {
  if (!jsonMode) return { enabled: false, fields: [] };

  if (expectedFields != null) {
    if (!Array.isArray(expectedFields) || expectedFields.length === 0) {
      throw new TypeError(
        `opts.expectedFields deve essere un array non vuoto di REQUIRED_IT_BODY_FIELDS, ricevuto ${JSON.stringify(expectedFields)}`,
      );
    }
    const sconosciuti = expectedFields.filter((f) => !REQUIRED_IT_BODY_FIELDS.includes(f));
    if (sconosciuti.length > 0) {
      throw new TypeError(
        `opts.expectedFields nomina campi che il verdetto non sa giudicare: ${sconosciuti.join(', ')} `
        + `(ammessi: ${REQUIRED_IT_BODY_FIELDS.join(', ')})`,
      );
    }
    return { enabled: true, fields: [...expectedFields] };
  }

  const enabled = REQUIRED_IT_BODY_FIELDS.every((f) => messages.some((m) => m?.content?.includes(f)));
  return { enabled, fields: REQUIRED_IT_BODY_FIELDS };
}

/**
 * Estrae il blocco di contenuto nella lingua primaria da un payload di
 * generazione, tollerando le tre forme che i modelli producono davvero:
 * `content.it.*`, `content.*` (locale saltato), o i campi alla radice —
 * E la loro combinazione: un modello puo' scrivere ALCUNI campi in una
 * forma e gli altri in un'altra nella STESSA risposta (misurato, issue
 * #483/#546: `title`/`excerpt` assenti mentre i `body1..3` sono corretti
 * sotto `content.it`). Ogni campo e' quindi cercato indipendentemente
 * attraverso TUTTI i candidati, nello stesso ordine di priorita' — non piu'
 * «il primo candidato con ALMENO un campo vince e gli altri due candidati
 * non si guardano piu'», che perdeva in silenzio un campo genuino lasciato
 * in un candidato diverso da quello che aveva vinto sul primo campo trovato.
 *
 * Torna `null` quando NESSUN campo, in NESSUN candidato, e' non vuoto — il
 * che include, per costruzione, il payload di abort di REGOLA #0. Quel
 * `null` da solo NON significa «malformato»: e' `classifyBody2Payload()` a
 * distinguere i due casi.
 *
 * `fields` restringe sia la ricerca dei candidati sia il blocco restituito ai
 * campi che il chiamante ha davvero chiesto (vedi `resolveBody2Validation`).
 * Il default e' l'articolo completo, quindi i chiamanti a due argomenti — il
 * gate dello split e i due della normalizzazione a valle in create-article.mjs
 * — vedono esattamente cio' che vedevano prima.
 */
export function normalizeItalianContentFromPayload(payload, locale = 'it', fields = REQUIRED_IT_BODY_FIELDS) {
  const content = payload?.content;
  const candidates = [];

  if (content && typeof content === 'object') {
    if (content[locale] && typeof content[locale] === 'object') candidates.push(content[locale]);
    candidates.push(content);
  }
  candidates.push(payload);

  const block = {};
  let hasAnyField = false;

  for (const field of fields) {
    let value = '';
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      let v = typeof candidate[field] === 'string' ? candidate[field].trim() : '';
      if (LITERAL_NULL_STRING_RE.test(v)) v = '';
      if (v) { value = v; break; }
    }
    if (value) hasAnyField = true;
    block[field] = value;
  }

  return hasAnyField ? block : null;
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
 * @param {string[]} [args.expectedFields] i campi che QUESTA chiamata doveva
 *                                 produrre — vedi `resolveBody2Validation()`.
 *                                 Il default e' l'articolo completo; le due
 *                                 meta' dello split passano `BODY_ONLY_FIELDS`
 *                                 e `META_ONLY_FIELDS`. Un campo non atteso non
 *                                 e' «mancante»: non e' stato chiesto.
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
export function classifyBody2Payload({
  parsed,
  parseErr = null,
  locale = 'it',
  expectedFields = REQUIRED_IT_BODY_FIELDS,
} = {}) {
  const itContent = parseErr ? null : normalizeItalianContentFromPayload(parsed, locale, expectedFields);

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

  for (const field of expectedFields) {
    if (!itContent?.[field] || itContent[field].length < 1) {
      missing.push(field);
    }
  }
  // La soglia sul body2 vale solo dove il body2 e' stato CHIESTO. Sulla meta'
  // `meta` dello split non lo e': `itContent.body2` sarebbe `undefined` e il
  // controllo passerebbe comunque, ma tenerlo legato ai campi attesi dice
  // perche' — non e' un caso fortunato, e' il contratto.
  if (expectedFields.includes('body2') && itContent.body2 && itContent.body2.trim().length < 40) missing.push('body2<40');
  // Language sanity — fallback models occasionally drift to CJK / Cyrillic
  // when prompted in Italian. Treat as malformed output: penalises the model,
  // chain rotates, no budget burned at the outer headline-validation layer.
  // See run 26446721285.
  for (const field of expectedFields) {
    const val = itContent?.[field];
    if (typeof val === 'string' && val.length > 0 && isNonItalianScript(val)) {
      const ratio = (nonItalianScriptRatio(val) * 100).toFixed(0);
      missing.push(`${field} non-IT script (${ratio}% non-Latin)`);
    }
  }

  return { verdict: missing.length > 0 ? 'reject' : 'ok', itContent, missing };
}

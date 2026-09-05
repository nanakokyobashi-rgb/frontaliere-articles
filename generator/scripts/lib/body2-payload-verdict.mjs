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
 *
 * Una doppia serializzazione lascia le virgolette *dentro* il valore JS
 * (`'"null"'` o `"\"null\""`): dopo il trim si toglie al piu' UNA coppia
 * wrapping (single o double) e si ritesta. Testo reale tra virgolette non
 * viene svuotato ne' riscritto: lo strip serve solo al filtro.
 */
const LITERAL_NULL_STRING_RE = /^null$/i;

/**
 * La forma SERIALIZZATA, e solo quella. `String(null)` e `JSON.stringify(null)`
 * producono sempre `null` MINUSCOLO: non esiste una serializzazione che scriva
 * `Null` o `NULL`. La distinzione conta perche' `Null` con la maiuscola e' la
 * parola tedesca corrente per «zero» — e i sostantivi tedeschi sono sempre
 * maiuscoli, quindi la maiuscola non e' un caso fortunato: e' la forma NORMALE
 * della parola. Vedi `hasUsableTranslatedText`.
 */
const SERIALIZED_NULL_STRING_RE = /^null$/;

/**
 * I locali in cui `null` e' una PAROLA della lingua, e quindi in cui la sola
 * grafia serializzata (minuscola) puo' essere scartata da
 * `hasUsableTranslatedText`. Oggi: solo il tedesco — `Null` e' la parola
 * corrente per «zero», e i sostantivi tedeschi sono sempre maiuscoli.
 *
 * Non e' una congettura da mantenere a mano su tutti i locali possibili: il
 * set dei locali tradotti e' gia' enumerato letteralmente nel codice
 * (`['en','de','fr']` in `create-article.mjs`, `['it','en','de','fr']` in
 * `events-utils.mjs`), e per en/fr `Null`/`NULL` come testo INTERO di un
 * `title`/`excerpt` non e' prosa: la deroga li' cancellerebbe la recovery
 * (#822) senza salvare nessuna parola reale. Un locale non elencato — e un
 * locale ASSENTE, cioe' un chiamante che non lo passa — resta sul predicato
 * severo: si fallisce CHIUSI.
 */
const LOCALES_WITH_NULL_AS_WORD = new Set(['de']);

/**
 * Il tag di lingua, ridotto alla sola LINGUA: trim, minuscolo, subtag di
 * regione/script tagliato (`de-CH`, `de_DE`, `DE-ch` → `de`).
 *
 * E' l'unico normalizzatore di locale di questo modulo, e sta qui perche' il
 * difetto che copre e' SILENZIOSO: senza il taglio del subtag,
 * `localeHasNullAsWord('de-CH')` risponde `false`, il predicato ricade su
 * quello severo e un `Null` tedesco legittimo torna a essere letto come campo
 * mancante — cioe' #831 si riapre come testo ITALIANO pubblicato sotto `/de/`,
 * senza che nessun gate lo veda. Oggi tutti i chiamanti passano il letterale
 * nudo; questa funzione fa si' che il giorno in cui uno passa `de-CH` non
 * cambi niente.
 */
export function normalizeLocaleTag(locale) {
  return String(locale ?? '').trim().toLowerCase().split(/[-_]/)[0];
}

/** `true` se in `locale` il `null` maiuscolo e' una parola, non una serializzazione. */
export function localeHasNullAsWord(locale) {
  return LOCALES_WITH_NULL_AS_WORD.has(normalizeLocaleTag(locale));
}

/** Toglie al piu' una coppia wrapping di `'` o `"` dopo il trim. */
function stripOneWrappingQuotePair(value) {
  if (value.length < 2) return value;
  const q = value[0];
  if ((q === '"' || q === "'") && value[value.length - 1] === q) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function matchesNullLiteral(value, re) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return re.test(trimmed) || re.test(stripOneWrappingQuotePair(trimmed));
}

export function isLiteralNullString(value) {
  return matchesNullLiteral(value, LITERAL_NULL_STRING_RE);
}

/**
 * Come `isLiteralNullString`, ma sul testo di un locale TRADOTTO in cui `null`
 * e' una parola: solo la forma serializzata (minuscola) conta. Vedi
 * `hasUsableTranslatedText`.
 */
export function isSerializedNullString(value) {
  return matchesNullLiteral(value, SERIALIZED_NULL_STRING_RE);
}

/**
 * Il predicato di «null letterale» che vale per `locale`: la sola grafia
 * serializzata dove `null` e' una parola della lingua (de), tutte le grafie
 * altrove — e quando il locale non e' noto.
 */
export function isNullStringForLocale(value, locale) {
  return localeHasNullAsWord(locale) ? isSerializedNullString(value) : isLiteralNullString(value);
}

/**
 * Testo di contenuto UTILIZZABILE: stringa non vuota dopo il trim che non sia
 * la serializzazione letterale di `null`. E' il predicato con cui
 * `normalizeItalianContentFromPayload` scarta gia' `"null"`, esportato perche'
 * i gate A MONTE lo condividano invece di riscrivere un `value.trim()` nudo —
 * che la stringa `"null"` supera. Un test di vuoto nudo sul percorso di
 * assemblaggio dello split faceva vincere il RAW `"null"` sul blocco
 * normalizzato e pubblicava un paragrafo il cui testo e' `null`.
 */
export function hasUsableContentText(value) {
  return typeof value === 'string' && value.trim().length > 0 && !isLiteralNullString(value);
}

/**
 * ── QUALE DEI DUE PREDICATI, E PERCHE' LA DISCRIMINANTE E' LA PROVENIENZA ───
 *
 * `hasUsableContentText` e `hasUsableTranslatedText` non sono «severo» e
 * «permissivo» da scegliere a gusto: sono la stessa regola applicata a due
 * PROVENIENZE del valore, e la provenienza e' l'unica cosa che dice se
 * `Null`/`NULL` possa essere una parola o sia soltanto un marker.
 *
 *   PROSA DI UN MODELLO che ha letto la sorgente e scrive nella lingua target
 *   (`content.de.title` dopo `translateArticle`, il retry per-campo)
 *      → `hasUsableTranslatedText(value, locale)`.
 *      Li' `Null` PUO' essere la parola tedesca per «zero», e scartarla
 *      pubblica il testo italiano sotto `/de/` (#831).
 *
 *   USCITA DI UNA MACCHINA con un sentinella di fallimento documentato — un
 *   motore della cascata free-MT, un export CSV/DB del feed eventi dove la
 *   colonna vuota si scrive `NULL`
 *      → `hasUsableContentText(value)`, TUTTE le grafie.
 *      Li' `Null`/`NULL` non e' una parola scelta da qualcuno che sapeva cosa
 *      stava traducendo: e' cio' che la macchina emette quando NON ha una
 *      risposta. Accettarlo pubblica il marker verbatim — come titolo, come
 *      slug `/de/blog/null`, nel meta e nel feed (#868, item 3/4/5).
 *
 * L'asimmetria del costo e' quella che decide, e va nello stesso verso in
 * entrambi i rami: sul ramo «prosa» il falso negativo (scartare una parola
 * vera) pubblica la lingua sbagliata e nessun gate lo vede; sul ramo
 * «macchina» il falso positivo (accettare il sentinella) pubblica il marker e
 * nessun gate lo vede, mentre il falso negativo costa al piu' una recovery
 * per-campo — un retry, non una pubblicazione sbagliata.
 *
 * Testo UTILIZZABILE di un campo TRADOTTO da un modello (`content.de/en/fr`).
 * Stessa regola di `hasUsableContentText` tranne una, e SOLO nei locali in cui
 * `null` e' una parola della lingua (`LOCALES_WITH_NULL_AS_WORD`, oggi il solo
 * `de`): li' il `null` letterale conta solo nella forma SERIALIZZATA,
 * minuscola.
 *
 * `locale` va quindi passato da ogni chiamante. Senza — o su un locale non
 * elencato, en/fr compresi — il predicato e' identico a `hasUsableContentText`:
 * un `title` en che vale `NULL` non e' prosa inglese, resta un campo mancante,
 * e la recovery per-campo (retry mirato -> fallback IT) continua a coprirlo
 * come prima di #831.
 *
 * Perche' i due predicati divergono. `hasUsableContentText` giudica il payload
 * che il modello produce nella lingua SORGENTE (italiano): li' `null` non e'
 * una parola in nessuna grafia, quindi rifiutare anche `Null`/`NULL` non puo'
 * cancellare contenuto. Su un campo tradotto la stessa regola non e' neutra:
 * `Null` e' la parola tedesca corrente per «zero», e un titolo o un excerpt
 * DE il cui testo intero e' `Null` verrebbe letto come MANCANTE. La recovery
 * per-campo non ha niente da recuperare — il campo tradotto e' giusto — quindi
 * cade sulla sorgente e pubblica il testo ITALIANO sotto `/de/`: nel corpus,
 * nella meta del locale e nel suo feed RSS. Non e' un `null` pubblicato, e' un
 * locale sbagliato pubblicato, e nessun gate a valle lo vede.
 *
 * (I path della superficie non sono nominati qui di proposito: il censimento
 * dei choke-point di `corpus-write-atomic.test.mjs` matcha sul TESTO del file
 * e di tutti i suoi import relativi, quindi una radice pubblicata citata in un
 * commento di questo modulo marcherebbe come scrittore di artefatti pubblicati
 * ogni file che lo importa — `events-utils.mjs` per primo.)
 *
 * La forma misurata su `haiku` in #799 e' `"null"` minuscolo — la sola che una
 * serializzazione puo' produrre — quindi restringere alla grafia serializzata
 * non riapre nulla di cio' che #822 ha chiuso.
 */
export function hasUsableTranslatedText(value, locale) {
  return typeof value === 'string' && value.trim().length > 0 && !isNullStringForLocale(value, locale);
}

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
 * `content.it.*`, `content.*` (locale saltato), o i campi alla radice — E la
 * loro COMBINAZIONE nella stessa risposta. Un modello puo' scrivere alcuni
 * campi in una forma e i restanti in un'altra: misurato su `haiku`, che
 * parcheggia `title`/`excerpt` alla radice mentre i `body1..3` stanno
 * correttamente sotto `content.it` (issue #483/#546).
 *
 * Ogni campo e' quindi cercato INDIPENDENTEMENTE attraverso tutti i
 * candidati, nello stesso ordine di priorita'. La regola precedente — «il
 * primo candidato con almeno un campo non vuoto vince, gli altri non si
 * guardano piu'» — faceva sparire i campi genuini lasciati in un candidato
 * diverso da quello che aveva vinto sul primo campo trovato, e li riportava
 * a valle come `missing`: da li' l'apparenza che il modello omettesse campi
 * `required` che invece aveva prodotto.
 *
 * Torna `null` quando NESSUN campo, in NESSUN candidato, e' non vuoto — il
 * che include, per costruzione, il payload di abort di REGOLA #0. Quel
 * `null` da solo NON significa «malformato»: e' `classifyBody2Payload()` a
 * distinguere i due casi.
 *
 * `fields` restringe sia la ricerca fra i candidati sia il blocco restituito ai
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
      let raw = typeof candidate[field] === 'string' ? candidate[field].trim() : '';
      if (isLiteralNullString(raw)) raw = '';
      if (raw) { value = raw; break; }
    }
    if (value) hasAnyField = true;
    block[field] = value;
  }

  return hasAnyField ? block : null;
}

/**
 * `faq` is not a string — `normalizeItalianContentFromPayload` would
 * coerce a misplaced object/array FAQ to `''` and drop it. Walk the same
 * three candidate locations (content[locale], content, payload root) and
 * return the first present FAQ so a model that parks it outside
 * `content[primaryLocale]` does not publish a silent no-FAQ article.
 */
export function isPresentFaq(value) {
  if (value == null || value === '') return false;
  if (typeof value === 'string') {
    return hasUsableContentText(value);
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

export function recoverMisplacedFaq(payload, locale = 'it') {
  const content = payload?.content;
  const candidates = [];
  if (content && typeof content === 'object') {
    if (content[locale] && typeof content[locale] === 'object') candidates.push(content[locale]);
    candidates.push(content);
  }
  candidates.push(payload);
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && isPresentFaq(candidate.faq)) {
      return candidate.faq;
    }
  }
  return undefined;
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
 * Il payload e' un abort di REGOLA #0 *da trattare come tale*?
 *
 * `isTopicGateAbortPayload` legge il solo flag; questa legge il flag INSIEME
 * alla forma del payload, cioe' risponde alla domanda che i gate si pongono
 * davvero: «il modello ha rifiutato, o si e' contraddetto?».
 *
 * ## Il caso che mancava: i campi meta ALLA RADICE
 *
 * Lo schema impone `null` sui campi di `content`, NON alla radice del payload.
 * Un modello che esercita REGOLA #0 e INTITOLA il proprio rifiuto —
 *
 *     {"abort_topical_relevance":true,"reason":"la fonte non riguarda…",
 *      "title":"Rifiuto: fonte non pertinente",
 *      "content":{"it":{"title":null,"excerpt":null,"body1":null,…}}}
 *
 * — non viola nulla di dichiarato, ma rendeva `hasAnyField` vero in
 * `normalizeItalianContentFromPayload` (che cerca `title` anche alla radice,
 * per la forma mista di `haiku`). Il ramo dell'abort, guardato da `!itContent`,
 * non scattava: verdetto `reject` con `missing:['excerpt','body1','body2',
 * 'body3']`, CINQUE rigenerazioni contro un modello che aveva OBBEDITO, e la
 * sezione chiusa senza articolo — esattamente il costo che questo modulo
 * esiste per togliere (run 32175400548).
 *
 * ## La regola, e perche' il corpo e' l'unico testimone che conta
 *
 * Un rifiuto puo' portare un titolo; NON puo' portare l'articolo. Quindi:
 *
 *   - nessun campo atteso valorizzato        → abort (il caso puro, invariato);
 *   - campi di CORPO valorizzati             → NON abort: il modello si e'
 *     contraddetto e la guardia del chiamante sceglie il contenuto sopra il
 *     flag (decisione del 2026-07-06, run 28802314827);
 *   - solo campi META (title/excerpt), da qualunque candidato → abort.
 *
 * ## Perche' il terzo caso vale solo se il corpo era ATTESO
 *
 * Sulla meta' `meta` dello split (`expectedFields = META_ONLY_FIELDS`) il corpo
 * e' assente PER COSTRUZIONE — lo schema `article_metadata_only` non lo
 * dichiara nemmeno. Li' «niente corpo» non e' evidenza di rifiuto, e trattarlo
 * come tale butterebbe via un `title`/`excerpt` validi (con il corpo gia'
 * generato dalla 1/2) sulla sola fede di un flag che quella meta' non doveva
 * nemmeno emettere. Il falso positivo qui e' il danno peggiore dei due, come
 * per `isTopicGateAbortPayload`: quindi senza campi di corpo fra gli attesi si
 * resta al comportamento precedente, cioe' contenuto sopra flag.
 *
 * @param {unknown} parsed
 * @param {object}  [opts]
 * @param {string}  [opts.locale]         la lingua primaria attesa.
 * @param {string[]} [opts.expectedFields] i campi che la chiamata ha chiesto.
 * @returns {boolean}
 */
/**
 * ── IL CORPO CHE IL NORMALIZZATORE NON SA LEGGERE ──────────────────────────
 *
 * `normalizeItalianContentFromPayload` accetta un campo SOLO se e' una
 * stringa (`typeof === 'string'`) su una chiave DICHIARATA. Un corpo emesso
 * in un'altra forma — `body1` come array o oggetto, o il testo parcheggiato
 * su una chiave che nessuno schema nomina (`content.it.body`, `text`,
 * `content` come stringa alla radice) — per lui non esiste: torna `null`
 * esattamente come su un abort puro.
 *
 * Finche' quel `null` significava «reject», la differenza non costava niente:
 * la rigenerazione recuperava la risposta. Da quando lo stesso `null` puo'
 * significare «abort di REGOLA #0», cioe' un esito TERMINALE che chiude la
 * sezione senza articolo e senza push su `content/**`, i due casi devono
 * essere distinti PRIMA: un modello che ha scritto l'articolo in una forma
 * sbagliata non ha rifiutato la fonte, e buttarlo via senza rigenerare e' il
 * danno che l'abort esiste per non fare, applicato al payload sbagliato.
 *
 * Quindi: se c'e' TRACCIA di contenuto che il normalizzatore non legge, il
 * flag non basta piu' e il verdetto torna `reject` (rigenerabile). Un abort
 * puro — campi `null` o assenti, `reason` alla radice — non ha nessuna di
 * queste tracce e resta un abort, byte per byte come prima.
 *
 * ## Dove si guarda, e perche' NON ovunque
 *
 * Dentro `content.*` lo schema impone `null` per contratto: una chiave che
 * porti TESTO LUNGO QUANTO UN ARTICOLO li' dentro contraddice l'abort, tranne i campi META
 * (`title`/`excerpt`, «un rifiuto puo' intitolarsi`), `faq` e `reason`.
 *
 * Alla RADICE no: li' vivono `reason`, `id`, `category`, `imagePrompt` — un
 * abort conforme li porta, e leggerli come contenuto renderebbe `reject` ogni
 * rifiuto, cioe' rimetterebbe le cinque rigenerazioni che #807 ha tolto. Alla
 * radice contano solo le chiavi di FORMA corpo, e una stringa vi conta solo
 * se e' grande quanto un articolo: la spiegazione di un rifiuto sta in
 * `reason` e non arriva a `BODYISH_TEXT_MIN_CHARS` — soglia che dal 2026-09-05
 * vale anche DENTRO `content.*`, per lo stesso motivo (#869 item 2).
 *
 * ## Perche' solo il TESTO conta come sostanza
 *
 * L'evidenza richiede una stringa usabile, a qualunque profondita'. Un
 * oggetto di soli `null` (`seo:{metaTitle:null,…}`), un array vuoto o un
 * `hasCalculator:false` parcheggiati dentro `content.*` da un abort conforme
 * NON sono un articolo: contarli come contenuto rimetterebbe le
 * rigenerazioni contro un modello che ha obbedito, che e' il danno peggiore
 * dei due (stessa scelta di `isTopicGateAbortPayload`).
 */
const BODYISH_KEY_RE = /^(?:body|text|testo|content|article|articolo|paragraf[oi]|paragraphs?)(?:[_-]?\d+)?$/i;

/** Chiavi che dentro `content.*` NON contraddicono un abort. */
const ABORT_COMPATIBLE_CONTENT_KEYS = [...META_ONLY_FIELDS, 'faq', 'reason', 'abort_topical_relevance'];

/**
 * Soglia UNICA, radice e `content.*`. Sotto questa lunghezza il testo trovato
 * non e' un articolo: e' piu' probabile che sia l'eco del rifiuto.
 *
 * Fino a #869 la soglia esisteva SOLO alla radice, e solo per una stringa
 * diretta. Dentro `content.*` non c'era niente, quindi un abort conforme che
 * parcheggia la spiegazione del proprio rifiuto su una chiave non dichiarata
 * (`content.it.body = "Nessun contenuto: fonte non pertinente"`, 38 caratteri;
 * `content.it.note = "fuori tema"`) produceva evidenza e diventava `reject`:
 * le cinque rigenerazioni contro un modello che ha obbedito, cioe' esattamente
 * il costo che #807 aveva tolto, rimesso sulla classe che questo predicato
 * prometteva di non toccare. Il razionale della soglia — «la spiegazione di un
 * rifiuto non arriva a 200 caratteri, un articolo si' » — vale identico nei due
 * posti, quindi la soglia e' una sola.
 */
const BODYISH_TEXT_MIN_CHARS = 200;

/**
 * Profondita' massima della discesa.
 *
 * Era 4, e 4 lasciava TERMINALE proprio il caso per cui il predicato esiste:
 * `content.it.article.sections[0].paragraphs[0].text` — un corpo vero, scritto
 * in una forma che il normalizzatore non legge — sta a cinque livelli dal
 * candidato `content.it` e non produceva nessuna evidenza, quindi la sezione
 * si chiudeva senza articolo e senza rigenerare (#869 item 4).
 *
 * Il limite resta, e resta una scelta: oltre l'ottavo livello si continua a
 * cadere nel ramo terminale. Ma il confine ora e' ESERCITATO nei due versi dal
 * test gemello, invece di essere un numero che nessuno prova — ed e' sicuro
 * scendere piu' in basso solo perche' `BODYISH_TEXT_MIN_CHARS` si applica
 * adesso anche qui: senza la soglia, scendere di piu' avrebbe solo aumentato
 * le probabilita' di raccogliere l'eco di un rifiuto.
 */
const SUBSTANCE_MAX_DEPTH = 8;

/**
 * Caratteri di TESTO usabile che il valore porta, sommati su tutta la
 * discesa. Numeri, booleani, stringhe vuote e `"null"` non contano — vedi il
 * blocco sopra.
 *
 * La somma, e non il massimo per stringa: un corpo emesso come array di frasi
 * (`body1: ['Prima frase.', 'Seconda frase.', …]`) e' un articolo anche se
 * nessun elemento da solo arriva alla soglia, e leggerlo elemento per elemento
 * lo butterebbe via come se il modello avesse rifiutato.
 */
function textSubstanceChars(value, depth = 0) {
  if (typeof value === 'string') return hasUsableContentText(value) ? value.trim().length : 0;
  if (value == null || typeof value !== 'object') return 0;
  if (depth >= SUBSTANCE_MAX_DEPTH) return 0;
  let total = 0;
  for (const v of Object.values(value)) {
    total += textSubstanceChars(v, depth + 1);
    if (total >= BODYISH_TEXT_MIN_CHARS) return total; // corto circuito: la soglia e' gia' passata
  }
  return total;
}

/** Il valore porta abbastanza testo da essere un CORPO, e non l'eco di un rifiuto? */
function hasTextSubstance(value) {
  return textSubstanceChars(value) >= BODYISH_TEXT_MIN_CHARS;
}

/**
 * La chiave, sotto `content`, e' un TAG DI LINGUA e non un campo?
 * `content.en` accanto a `content.it` e' un secondo locale, non un corpo: va
 * guardato con lo stesso carve-out per-campo di `content.it`, non percorso
 * intero (vedi `findUnreadableContentEvidence`).
 */
const LOCALE_KEY_RE = /^[a-z]{2}(?:[-_][a-z0-9]{2,4})?$/i;

/**
 * Torna la chiave che porta contenuto NON leggibile dal normalizzatore, o
 * `null` se non ce n'e'. Esportata perche' i gate a monte (lo split in
 * create-article.mjs) possano NOMINARLA nel log invece di dedurla: la classe
 * e' invisibile se il ramo tace.
 */
export function findUnreadableContentEvidence(payload, locale = 'it') {
  if (!payload || typeof payload !== 'object') return null;

  const content = payload.content;
  const contentCandidates = [];
  const localeKeys = new Set();
  if (content && typeof content === 'object') {
    // OGNI locale presente e' un candidato a se', col carve-out per-campo —
    // non solo `content[locale]`. Lo schema (`buildArticleJsonSchema`) rende
    // `required` il solo locale primario ma non VIETA al modello di emetterne
    // un secondo, e finche' `content.en` veniva percorso intero il `title` di
    // un rifiuto INTITOLATO in inglese («Refusal: source not relevant») non
    // era piu' escluso: un abort perfettamente conforme usciva `reject` anche
    // con `locale === 'it'` (#869 item 3).
    for (const [key, value] of Object.entries(content)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      if (!LOCALE_KEY_RE.test(key)) continue;
      localeKeys.add(key);
    }
    // Il locale primario per primo: e' quello che vogliamo NOMINATO nel log
    // quando l'evidenza sta li'.
    if (localeKeys.has(locale)) contentCandidates.push([`content.${locale}`, content[locale]]);
    for (const key of localeKeys) {
      if (key !== locale) contentCandidates.push([`content.${key}`, content[key]]);
    }
    contentCandidates.push(['content', content]);
  }

  for (const [where, candidate] of contentCandidates) {
    for (const [key, value] of Object.entries(candidate)) {
      if (ABORT_COMPATIBLE_CONTENT_KEYS.includes(key)) continue;
      // Una stringa su un campo DICHIARATO la legge gia' il normalizzatore:
      // se e' arrivata qui e' vuota o `"null"`, e non e' evidenza di niente.
      if (typeof value === 'string' && REQUIRED_IT_BODY_FIELDS.includes(key)) continue;
      // I sotto-oggetti di locale sono chiavi del candidato `content`: non li
      // si conta come contenuto di se stessi, sono gia' stati guardati campo
      // per campo sopra.
      if (where === 'content' && localeKeys.has(key)) continue;
      if (hasTextSubstance(value)) return `${where}.${key}`;
    }
  }

  for (const [key, value] of Object.entries(payload)) {
    if (!BODYISH_KEY_RE.test(key) && !BODY_ONLY_FIELDS.includes(key)) continue;
    if (typeof value === 'string') {
      if (hasTextSubstance(value)) return key;
      continue;
    }
    // `content` come oggetto e' gia' stato guardato campo per campo sopra.
    if (key === 'content' && value && typeof value === 'object') continue;
    if (hasTextSubstance(value)) return key;
  }

  return null;
}

export function isTopicGateAbortVerdict(parsed, { locale = 'it', expectedFields = REQUIRED_IT_BODY_FIELDS } = {}) {
  if (!isTopicGateAbortPayload(parsed)) return false;

  const fields = Array.isArray(expectedFields) && expectedFields.length > 0
    ? expectedFields
    : REQUIRED_IT_BODY_FIELDS;

  // Il corpo emesso in una forma che il normalizzatore non legge non e' un
  // rifiuto: e' una risposta da RIGENERARE (vedi `findUnreadableContentEvidence`).
  if (findUnreadableContentEvidence(parsed, locale)) return false;

  // Abort puro: nessuno dei campi attesi e' valorizzato, in nessun candidato.
  if (!normalizeItalianContentFromPayload(parsed, locale, fields)) return true;

  const bodyAttesi = fields.filter((f) => BODY_ONLY_FIELDS.includes(f));
  if (bodyAttesi.length === 0) return false;

  return !normalizeItalianContentFromPayload(parsed, locale, bodyAttesi);
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
  // Solo quando il CORPO e' davvero assente: con i body popolati il modello si
  // e' contraddetto, e la decisione spetta al chiamante. I soli campi meta —
  // il `title` che un modello mette al proprio rifiuto, spesso alla radice del
  // payload dove lo schema non impone `null` — non sono contenuto: vedi
  // `isTopicGateAbortVerdict`.
  if (!parseErr && isTopicGateAbortVerdict(parsed, { locale, expectedFields })) {
    return { verdict: 'topic-gate-abort', itContent: null, missing: [] };
  }

  const missing = [];

  if (!itContent) {
    // Quando il payload dichiara l'abort MA porta contenuto in una forma che
    // il normalizzatore non legge, NOMINARE la chiave e' l'unica cosa che
    // distingue questo rigetto da un payload vuoto: senza, il log dice «non
    // normalizzabile» su una risposta che il modello ha scritto per intero.
    const evidenza = isTopicGateAbortPayload(parsed) ? findUnreadableContentEvidence(parsed, locale) : null;
    missing.push(evidenza
      ? `content.it non normalizzabile (abort dichiarato ma contenuto su ${evidenza})`
      : 'content.it non normalizzabile');
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

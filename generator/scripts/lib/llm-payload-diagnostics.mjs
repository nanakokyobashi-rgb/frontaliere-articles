/**
 * ── PERCHE' «non normalizzabile» NON BASTAVA ────────────────────────────────
 *
 * `callLLM()` rigetta la generazione e riprova fino a 5 volte quando
 * `normalizeItalianContentFromPayload()` torna `null`. Il messaggio che
 * finisce nel log e' sempre lo stesso:
 *
 *     ⚠️  output JSON incompleto: content.it non normalizzabile (tentativo 1/5)
 *
 * Quel rigetto e' il primo consumatore di tempo di parete dello step
 * «Generate the article» (misurato il 2026-08-18 su 4 run: 905 s su 1189,
 * 274 s su 468, 655 s su 1008 — la run senza rigenerazioni e' anche la piu'
 * corta di tutte, 312 s). Ma dal messaggio non si puo' dire quale delle due
 * famiglie sia, e le due vogliono rimedi opposti:
 *
 *   - OUTPUT TRONCATO      → il modello ha esaurito il tetto di uscita a meta'
 *                            del corpo. La leva e' `maxTokens` (oggi 4000) o la
 *                            divisione della chiamata, NON il numero di
 *                            tentativi: rigenerare con lo stesso tetto ritronca.
 *   - FORMA SBAGLIATA      → il documento e' arrivato intero ma con chiavi
 *                            diverse, un involucro di troppo, o i campi vuoti.
 *                            La leva e' il prompt o il normalizzatore, che sta
 *                            rifiutando qualcosa di recuperabile.
 *
 * MISURATO (2026-08-18), ed e' la ragione per cui questo modulo esiste:
 * entrambe le famiglie sono presenti nella stessa finestra, e la diagnostica
 * ne mostrava UNA SOLA.
 *
 *   - Il ramo rumoroso (`🔎 JSON parse fallito`) era gia' condizionato a
 *     `if (parseErr)`. Su 64 rigetti raccolti dai log, 49 sono
 *     «non normalizzabile» e la grande maggioranza NON stampa una riga di
 *     diagnostica: nella run 32134269129 — quella che ha speso il 76% dello
 *     step in rigenerazioni — 4 rigetti su 4 sono muti. Muti significa
 *     `JSON.parse` riuscito e normalizzatore a `null`: un documento
 *     sintatticamente completo. Un troncamento non puo' fare questo.
 *   - Il ramo rumoroso, quando parla, dice troncamento: nella run
 *     32140039370 il raw di `nvidia/meta/llama-3.1-8b-instruct` era di 12.780
 *     e 14.235 caratteri (≈ il tetto di 4000 token in italiano) e finiva a
 *     meta' frase — `...L'aliquota di imposta alla fonte per i contribuenti e
 *     del` — dopo un ciclo di ripetizione verbatim degli stessi tre paragrafi.
 *
 * IL SEGNALE CHE MANCAVA DEL TUTTO. Su un documento troncato,
 * `findMatchingClose()` va in desync (la catena di validazione di
 * `decideQuoteCloses` non puo' mai risolversi su un testo che finisce a
 * meta', quindi rifiuta la virgoletta di chiusura di `"imageAlt"`, la
 * scavalca, e il primo `}` che incontra porta la profondita' a zero) e
 * `repairLlmJson()` ritaglia il documento al `}` che chiude `imageAlt` —
 * cioe' tiene 430 caratteri su 12.780, il 3,4%. Riprodotto in locale: stesso
 * messaggio, stessa riga, stessa colonna di produzione
 * (`Expected ',' or '}' after property value in JSON at position 430
 * (line 12 column 4)`). Nessuna riga di log riportava quanto il repair
 * avesse buttato via, ed e' il numero che chiude la questione in un colpo.
 *
 * PERCHE' I CAMPI CI SONO SEMPRE, ANCHE A ZERO. Un campo che compare solo
 * quando c'e' qualcosa costringe chi legge il prossimo incidente a
 * distinguere «non e' arrivato niente» da «la diagnostica non c'era ancora».
 * E' la stessa ambiguita' che questo rigetto aveva gia'.
 *
 * PERCHE' `model=` E' NELLA RIGA. Il log annuncia il modello PREFERITO
 * (`🤖 [1/5] Generazione contenuto IT + metadata con gpt-4.1...`), non quello
 * che ha risposto: nella run 32140039370 l'intestazione diceva `gpt-4.1` e a
 * rispondere (male) e' stato `nvidia/meta/llama-3.1-8b-instruct`, sceso dalla
 * cascata. Attribuire il rigetto al modello annunciato e' l'errore piu' facile
 * da fare qui, e mandava a riparare il modello sbagliato.
 */

const REQUIRED_IT_BODY_FIELDS = ['title', 'excerpt', 'body1', 'body2', 'body3'];

/** Quante chiavi elencare prima di troncare l'elenco, per tenere la riga leggibile. */
const MAX_KEYS = 12;

/**
 * Il testo finisce a meta' o e' un documento chiuso?
 *
 * Il verdetto primario e' deliberatamente ingenuo e non falsificabile: una
 * completion troncata non finisce MAI con la graffa di chiusura del documento.
 * La profondita' e lo stato «dentro una stringa» sono riportati come dettaglio
 * — sono utili ma dipendono dalla parita' delle virgolette, che una virgoletta
 * interna non escapata (il difetto che `fixJsonStringBody` esiste per
 * riparare) puo' ribaltare. Riportarli senza farli decidere e' il punto.
 *
 * @param {unknown} raw completion grezza del modello
 * @returns {{ troncato: boolean, chiude: boolean, profondita: number, inStringa: boolean, coda: string }}
 */
export function classifyTruncation(raw) {
  const str = String(raw ?? '');
  const senzaFence = str.replace(/```+\s*$/, '').trimEnd();

  let inStringa = false;
  let esc = false;
  let profondita = 0;
  for (let i = 0; i < senzaFence.length; i++) {
    const ch = senzaFence[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStringa = !inStringa; continue; }
    if (inStringa) continue;
    if (ch === '{' || ch === '[') profondita++;
    else if (ch === '}' || ch === ']') profondita--;
  }

  const chiude = senzaFence.endsWith('}') || senzaFence.endsWith(']');
  return {
    troncato: !chiude,
    chiude,
    profondita,
    inStringa,
    coda: senzaFence.slice(-40).replace(/\n/g, '\\n'),
  };
}

/** Elenco compatto delle chiavi di un oggetto, o un motivo per cui non ce ne sono. */
function keysOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value !== 'object') return typeof value;
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  const shown = keys.slice(0, MAX_KEYS).join(',');
  return keys.length > MAX_KEYS ? `${shown},+${keys.length - MAX_KEYS}` : shown;
}

/** `assente` / `vuoto` / `nonstringa` / `<N>ch` per ognuno dei campi richiesti. */
function describeFields(candidate) {
  if (!candidate || typeof candidate !== 'object') return 'n/d';
  return REQUIRED_IT_BODY_FIELDS.map((f) => {
    const v = candidate[f];
    if (v === undefined || v === null) return `${f}:assente`;
    if (typeof v !== 'string') return `${f}:nonstringa(${Array.isArray(v) ? 'array' : typeof v})`;
    if (v.trim().length === 0) return `${f}:vuoto`;
    return `${f}:${v.length}ch`;
  }).join(' ');
}

/**
 * La riga unica che rende il rigetto attribuibile a una delle due famiglie
 * SENZA riprodurre l'incidente.
 *
 * Ogni campo e' sempre presente, anche a zero (vedi l'intestazione). L'ordine
 * mette per primo il verdetto, perche' e' l'unica cosa che decide dove si
 * ripara.
 *
 * @param {object} arg
 * @param {unknown} arg.raw       completion grezza (cio' che ha risposto il modello)
 * @param {unknown} arg.repaired  output di repairLlmJson() — cio' che e' finito in JSON.parse()
 * @param {unknown} arg.parsed    risultato di JSON.parse(), o undefined se ha lanciato
 * @param {Error|null} arg.parseErr errore di JSON.parse(), se c'e' stato
 * @param {string|null} arg.model  modello che ha DAVVERO risposto (modelUsedRef.model)
 * @returns {string}
 */
export function describePayloadRejection({ raw, repaired, parsed, parseErr = null, model = null } = {}) {
  const rawStr = String(raw ?? '');
  const repStr = String(repaired ?? '');
  const tronc = classifyTruncation(rawStr);

  // `kept` e' il numero che avrebbe chiuso l'incidente del 2026-08-18 da solo:
  // repairLlmJson() aveva tenuto il 3,4% di un documento da 12.780 caratteri.
  // Un valore basso accusa il RITAGLIO, non il modello.
  const kept = rawStr.length > 0 ? Math.round((repStr.length / rawStr.length) * 1000) / 10 : 0;

  // La famiglia e' un'ipotesi motivata, non un dogma: i campi grezzi che la
  // sostengono sono tutti sulla stessa riga, quindi si puo' contraddire.
  let famiglia;
  if (tronc.troncato) famiglia = 'troncato';
  else if (parseErr) famiglia = 'forma-sbagliata(json-non-valido)';
  else famiglia = 'forma-sbagliata(chiavi)';

  const content = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.content : undefined;
  const it = content && typeof content === 'object' && !Array.isArray(content) ? content.it : undefined;

  return [
    `famiglia=${famiglia}`,
    `model=${model || 'sconosciuto'}`,
    `rawChars=${rawStr.length}`,
    `repairedChars=${repStr.length}`,
    `kept=${kept}%`,
    `parse=${parseErr ? `ko(${parseErr.message})` : 'ok'}`,
    `tipo=${Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed}`,
    `chiaviRadice=[${keysOf(parsed)}]`,
    `chiaviContent=[${keysOf(content)}]`,
    `chiaviIt=[${keysOf(it)}]`,
    `campiIt={${describeFields(it)}}`,
    `campiRadice={${describeFields(parsed)}}`,
    `chiudeConGraffa=${tronc.chiude ? 'si' : 'no'}`,
    `profondita=${tronc.profondita}`,
    `inStringa=${tronc.inStringa ? 'si' : 'no'}`,
    `coda=«${tronc.coda}»`,
  ].join(' ');
}

export const REJECTION_DIAGNOSTIC_FIELDS = REQUIRED_IT_BODY_FIELDS;

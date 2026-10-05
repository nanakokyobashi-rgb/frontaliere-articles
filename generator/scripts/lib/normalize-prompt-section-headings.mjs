/**
 * normalize-prompt-section-headings.mjs — le intestazioni Markdown che sono,
 * per intero, un'etichetta di sezione del prompt di generazione scritta in
 * MAIUSCOLO (`## ESEMPIO CONCRETO`) diventano titoli normali
 * (`## Esempio concreto`). Cambia solo il casing di quelle righe.
 *
 * ── PERCHE' ESISTE ─────────────────────────────────────────────────────────
 *
 * Il prompt di espansione chiede ALLA LETTERA «esempi concreti con numeri
 * reali, …, normative con date e importi, checklist operative, confronti tra
 * scenari pratici» (`expandEnrichmentLine` in `create-article.mjs`), e quello
 * dei mestieri «stipendio requisiti … riconoscimento del titolo di studio»
 * (`buildProfessionEvergreenTopics`). Qualche body italiano pubblicato ha
 * trasformato quella scaletta in intestazioni urlate (`## ESEMPIO CONCRETO`,
 * `## CHECKLIST OPERATIVE`, `## CONCLUSIONE`…). La guardia
 * `leaked-prompt-scaffolding` (`lib/article-factuality-gates.mjs`, «marcatore
 * di sezione del prompt») segnala `ESEMPIO CONCRETO`, la pagina e' `critical` e
 * sul ramo `it` di `retranslate-blocking-bodies.mjs` non c'e' una cascata che
 * la possa rifare: lo stock non scende.
 *
 * Decisione del proprietario del 2026-10-05 («Titoli normali»): quelle
 * intestazioni si convertono in titoli normali, con un diff LIMITATO alle sole
 * righe di intestazione, come la rimozione della riga `TITOLO ARTICOLO`
 * (`strip-leaked-title-marker.mjs`). Questo modulo e' QUELLA conversione e
 * nient'altro:
 *
 *   - si tocca solo una riga `^#{2,4}[ \t]+<ETICHETTA>[ \t]*:?[ \t]*$` in cui
 *     `<ETICHETTA>` e', carattere per carattere, una voce di
 *     `PROMPT_SECTION_LABELS` (tutta maiuscola, sensibile alle maiuscole);
 *   - il testo dell'etichetta passa in sentence case italiano (prima lettera
 *     maiuscola, resto minuscolo, sigle di `PRESERVED_ACRONYMS` intatte); i
 *     `#`, gli spazi e i due punti restano byte per byte, cosi' come ogni
 *     altra riga e ogni terminatore;
 *   - un'etichetta dell'elenco in un'altra forma (senza `#`, `#` o `#####`,
 *     rientrata, senza spazio dopo i `#`) NON si tocca e finisce in `skipped`
 *     col motivo: la pagina resta intatta e si sistema a mano.
 *
 * Un'intestazione tutta maiuscola che NON e' un'etichetta del prompt (`## FAQ`,
 * `### CTA`, `## IVA`, un titolo vero urlato) non e' scaffolding e non si
 * tocca. Nessun testo viene generato o riscritto. Funzione pura: zero I/O.
 */

/**
 * Le etichette di sezione del prompt, nella forma tutta maiuscola in cui sono
 * finite nei body. `phrase` e' il testo letterale della sorgente da cui viene
 * ciascuna (il test `normalize-prompt-section-headings.test.mjs` lo cerca nel
 * file del prompt: se il prompt cambia, l'elenco va riletto, non allargato).
 * Singolare e plurale perche' il modello usa entrambi; la guardia stessa
 * accetta `(?:ESEMPIO|ESEMPI) CONCRET[OI]`.
 *
 * `INTRODUZIONE` e `CONCLUSIONE` non sono testo dei prompt: sono le due
 * etichette di scaletta che la decisione del proprietario del 2026-10-05 nomina
 * esplicitamente insieme alle altre, e le sole aggiunte fuori dai prompt.
 */
const EXPAND = 'create-article:expandEnrichmentLine';
const EVERGREEN = 'evergreen-topic-generator:buildProfessionEvergreenTopics';
const OWNER = 'decisione-proprietario-2026-10-05';

export const PROMPT_SECTION_LABELS = Object.freeze([
  { label: 'ESEMPIO CONCRETO', source: EXPAND, phrase: 'esempi concreti con numeri reali' },
  { label: 'ESEMPI CONCRETI', source: EXPAND, phrase: 'esempi concreti con numeri reali' },
  { label: 'NORMATIVA CON DATE E IMPORTI', source: EXPAND, phrase: 'normative con date e importi' },
  { label: 'NORMATIVE CON DATE E IMPORTI', source: EXPAND, phrase: 'normative con date e importi' },
  { label: 'CHECKLIST OPERATIVA', source: EXPAND, phrase: 'checklist operative' },
  { label: 'CHECKLIST OPERATIVE', source: EXPAND, phrase: 'checklist operative' },
  { label: 'CONFRONTO TRA SCENARI PRATICI', source: EXPAND, phrase: 'confronti tra scenari pratici' },
  { label: 'CONFRONTI TRA SCENARI PRATICI', source: EXPAND, phrase: 'confronti tra scenari pratici' },
  { label: 'RIFERIMENTI A COMUNI TICINESI SPECIFICI', source: EXPAND, phrase: 'riferimenti a comuni ticinesi specifici' },
  // Ramo non frontaliere della stessa riga (articoli `blog-body-ch`).
  { label: 'RIFERIMENTI A CANTONI O CITTÀ SVIZZERE PERTINENTI AL TEMA', source: EXPAND, phrase: 'riferimenti a cantoni o città svizzere pertinenti al tema' },
  { label: 'STIPENDIO E REQUISITI', source: EVERGREEN, phrase: 'ticino stipendio requisiti' },
  { label: 'RICONOSCIMENTO DEL TITOLO', source: EVERGREEN, phrase: 'riconoscimento del titolo di studio' },
  { label: 'RICONOSCIMENTO DEL TITOLO DI STUDIO', source: EVERGREEN, phrase: 'riconoscimento del titolo di studio' },
  { label: 'INTRODUZIONE', source: OWNER, phrase: null },
  { label: 'CONCLUSIONE', source: OWNER, phrase: null },
].map(Object.freeze));

const LABEL_SET = new Set(PROMPT_SECTION_LABELS.map((l) => l.label));

/** Sigle che restano maiuscole nel sentence case. */
export const PRESERVED_ACRONYMS = Object.freeze(['IVA', 'AVS', 'AI', 'LPP', 'CH', 'UE', 'SECO']);
const ACRONYM_SET = new Set(PRESERVED_ACRONYMS);

/**
 * Sentence case italiano: prima lettera maiuscola, resto minuscolo, sigle
 * note intatte. Lavora parola per parola su spazi singoli o multipli, che
 * restano come sono.
 *
 * @param {string} text
 */
export function sentenceCaseItalian(text) {
  let first = true;
  return text.split(/(\s+)/u).map((part) => {
    if (!part || /^\s+$/u.test(part)) return part;
    if (ACRONYM_SET.has(part)) { first = false; return part; }
    const lower = part.toLocaleLowerCase('it');
    if (!first) return lower;
    first = false;
    const [head, ...rest] = [...lower];
    return head.toLocaleUpperCase('it') + rest.join('');
  }).join('');
}

// Una riga, gia' senza il suo `\r` finale (lo si rimette identico).
const HEADING_RE = /^(#{2,4}[ \t]+)(.+?)([ \t]*:?[ \t]*)$/u;
// Qualunque forma con un'etichetta dell'elenco come contenuto intero della riga.
const ANY_FORM_RE = /^([ \t]*)(#*)([ \t]*)(.+?)[ \t]*:?[ \t]*$/u;

function splitCr(line) {
  return line.endsWith('\r') ? [line.slice(0, -1), '\r'] : [line, ''];
}

/** La riga convertita, oppure `null` se non e' un'intestazione-etichetta. */
function convertLine(line) {
  const [body, cr] = splitCr(line);
  const m = HEADING_RE.exec(body);
  if (!m || !LABEL_SET.has(m[2])) return null;
  return `${m[1]}${sentenceCaseItalian(m[2])}${m[3]}${cr}`;
}

/** Motivo per cui una riga con un'etichetta dell'elenco non e' convertibile. */
function skipReason(line) {
  const [body] = splitCr(line);
  const m = ANY_FORM_RE.exec(body);
  if (!m || !LABEL_SET.has(m[4])) return null;
  const [, indent, hashes, gap] = m;
  if (!hashes) return 'etichetta-senza-intestazione';
  if (indent) return 'intestazione-rientrata';
  if (hashes.length < 2 || hashes.length > 4) return 'livello-intestazione';
  if (!gap) return 'intestazione-senza-spazio';
  return null;
}

/**
 * Converte in titoli normali le intestazioni-etichetta del prompt.
 *
 * @param {string} text campo body decodificato (newline veri)
 * @returns {{ value: string, converted: Array<{ from: string, to: string }>, skipped: string[] }}
 *   `converted`: le righe convertite, prima e dopo, nell'ordine; `skipped`:
 *   `<motivo>: <riga>` per ogni etichetta lasciata intatta.
 */
export function normalizePromptSectionHeadings(text) {
  if (typeof text !== 'string' || !text) return { value: text, converted: [], skipped: [] };
  const lines = text.split('\n');
  const converted = [];
  const skipped = [];
  const out = lines.map((line) => {
    const next = convertLine(line);
    if (next !== null) {
      converted.push({ from: line, to: next });
      return next;
    }
    const reason = skipReason(line);
    if (reason) skipped.push(`${reason}: ${splitCr(line)[0].slice(0, 80)}`);
    return line;
  });
  return { value: converted.length ? out.join('\n') : text, converted, skipped };
}

/**
 * Riapplica a `old` le conversioni dichiarate, nell'ordine, e ritorna il testo
 * risultante; `null` se una conversione non e' la conversione di questo
 * modulo (riga assente o fuori ordine, `to` diverso da `convertLine(from)`)
 * o se dopo resta un'intestazione-etichetta non convertita. E' la prova che
 * fra il pubblicato e il testo convertito sono cambiate solo quelle righe, e
 * solo nel casing: il chiamante confronta poi questo testo con quello che
 * scrivera' davvero.
 *
 * @param {string} old
 * @param {Array<{ from: string, to: string }>} converted
 * @returns {string|null}
 */
export function applyConvertedHeadings(old, converted) {
  if (typeof old !== 'string') return null;
  const list = Array.isArray(converted) ? converted : [];
  for (const c of list) {
    if (!c || typeof c.from !== 'string' || typeof c.to !== 'string') return null;
    if (convertLine(c.from) !== c.to) return null;
    if (c.to.toLocaleLowerCase('it') !== c.from.toLocaleLowerCase('it')) return null;
  }
  let k = 0;
  const out = [];
  for (const line of old.split('\n')) {
    if (k < list.length && line === list[k].from) {
      out.push(list[k].to);
      k += 1;
      continue;
    }
    if (convertLine(line) !== null) return null;
    out.push(line);
  }
  if (k !== list.length) return null;
  return out.join('\n');
}

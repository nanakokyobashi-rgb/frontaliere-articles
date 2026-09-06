/**
 * key-facts-specificity.mjs — il guard sui FATTI CHIAVE VUOTI.
 *
 * ## Il difetto che chiude, e perche' non e' il guard dei segnaposto
 *
 * `lib/prompt-placeholder-guard.mjs` chiude i segnaposto DELLO SCHEMA: il
 * modello ricopia il template invece di compilarlo, quindi il testo offensivo
 * era gia' nel prompt e un letterale lo vede. Qui il testo non era nel prompt.
 * Il blocco «AI SEARCH OPTIMIZATION» (`ai-search-template.mjs`) chiede 5-8
 * coppie `Cosa/Quando/Dove/Chi/Importo` e NON dice cosa fare quando la fonte
 * non porta quel dato. Un modello a cui si chiede una riga che non puo'
 * compilare non salta la riga: la compila con un non-valore.
 *
 *   - **Cosa**: Borse di studio per gli studenti e gli apprendisti.
 *   - Quando: Non specificato.
 *   - Dove: Cantone di Sciaffusa.
 *   - Chi: Ente competente: non specificato.
 *   - Importo: Non specificato.
 *
 * Tre righe su cinque non dicono niente, e la sezione esiste apposta per essere
 * letta dai motori generativi: e' li' che «non specificato» diventa la risposta
 * pubblicata. Come il segnaposto, e per la stessa ragione, passa ogni controllo
 * di FORMA — e' una stringa, e' della lunghezza giusta, e la sezione ha il
 * numero di bullet richiesto.
 *
 * ## Due forme, e una sola e' riparabile per sottrazione
 *
 *   · `placeholder-value` — il VALORE della coppia E' il non-valore
 *     («Quando: non specificato»). Togliere la riga lascia una sezione
 *     corretta e piu' corta: e' riparabile, ed e' cio' che `stripVacuousFacts`
 *     fa.
 *   · `hedged-prose` — il non-valore e' una FRASE («Gli importi massimi non
 *     sono ancora specificati»). Qui la sottrazione non e' deterministica: la
 *     frase puo' portare un soggetto vero e togliere il bullet intero
 *     toglierebbe anche quello. Viene MISURATA e segnalata, non riparata.
 *
 * L'asimmetria e' la stessa di `sanitizePromptPlaceholders`: si ripara dove
 * una riparazione deterministica esiste, si dichiara altrove.
 *
 * ## Perche' il valore si legge dopo l'ULTIMO due punti
 *
 * La forma reale non e' sempre `- **Termine**: valore`. Il modello scrive anche
 * `* Chi: Ente competente: non specificato.`, dove il non-valore sta dopo un
 * secondo due punti. Tagliare al primo lascerebbe «Ente competente: non
 * specificato» che nessuna ancora vede; tagliare all'ultimo isola il valore.
 *
 * ## Perche' una sezione sotto la soglia si toglie invece di rifiutare
 *
 * E' la scelta gia' argomentata per la FAQ in `cleanFaqPairs`: sotto le due
 * coppie la FAQ si rimuove, perche' una FAQ assente non produce structured
 * data mentre una finta si'. Qui vale identico e costa meno: la sezione e'
 * decorazione AI-search dentro `body1`, il lead giornalistico le sopravvive, e
 * rifiutare l'articolo intero per tre bullet vuoti butterebbe via la parte
 * verificabile insieme a quella vuota.
 */

import { AI_SEARCH_SECTION_HEADINGS } from './ai-search-template.mjs';

/**
 * Sotto questa soglia la sezione non vale la pena di essere pubblicata: e' la
 * stessa soglia che `buildAiSearchMarkdown` gia' pretende in ingresso.
 */
export const MIN_FACTS_PER_SECTION = 3;

/**
 * I non-valori in forma di FRASE, nelle quattro locali del corpus. Sono
 * multi-parola, quindi restano riconoscibili anche in mezzo alla prosa: sono
 * queste — e solo queste — che alimentano il rilevatore non ancorato.
 */
export const VACUOUS_PHRASES = Object.freeze([
  // it
  "non (?:e'|è|sono|sta|stato|stati|state)?\\s*(?:ancora\\s+)?(?:stat[oaie]\\s+)?(?:specificat|indicat|precisat|definit|dichiarat|riportat|comunicat|disponibil|not)[oaie]",
  'nessun dato(?: disponibile)?',
  '(?:dato|informazione|importo|cifra) non disponibil[ei]',
  'da (?:definire|specificare|confermare)',
  // en
  'not (?:yet )?(?:specified|stated|indicated|disclosed|available|provided)',
  'to be (?:defined|confirmed|announced)',
  // de
  '(?:noch |derzeit |bislang |bisher )?nicht (?:naeher |näher )?(?:angegeben|spezifiziert|genannt|bekannt|verfuegbar|verfügbar)',
  'keine angaben?',
  // fr
  'non (?:encore )?(?:specifie|spécifié|precise|précisé|indique|indiqué|communique|communiqué|disponible)e?',
]);

/**
 * I non-valori in forma di SIGLA o parola sola. Valgono solo ANCORATI sul
 * valore intero, e non e' una sfumatura: non ancorata, `n/?a` vede ogni «na»
 * dentro una parola e `n\.?d\.?` ogni «nd». Misurato prima di separarli, il
 * rilevatore non ancorato dava 36.860 bullet su 5.119 articoli — cioe' quasi
 * tutto il corpus, che e' il modo in cui una misura sbagliata si presenta.
 */
export const VACUOUS_TOKENS = Object.freeze([
  'non applicabile',
  'sconosciut[oa]',
  'n\\s*[./]?\\s*d\\.?',
  'unspecified',
  'unknown',
  'tbd',
  'n/?a',
  'unbekannt',
  'k\\.?a\\.?',
  'inconnue?',
  'sans objet',
]);

/** Retro-compatibilita' di lettura: l'unione delle due liste. */
export const VACUOUS_VALUE_ALTERNATIVES = Object.freeze([...VACUOUS_PHRASES, ...VACUOUS_TOKENS]);

/**
 * Ancorata sull'INTERO valore, con la sola tolleranza della punteggiatura e
 * della formattazione markdown. Senza le ancore questa regola vedrebbe ogni
 * «non disponibile» dentro la prosa legittima («il servizio non e' disponibile
 * il sabato»), che e' un fatto vero e specifico.
 */
const VACUOUS_VALUE_RX = new RegExp(
  `^[\\s"'«»(\\[*_-]*(?:${VACUOUS_VALUE_ALTERNATIVES.join('|')})[\\s"'«»)\\]*_.!;,-]*$`,
  'iu',
);

/**
 * Le sole FRASI, non ancorate: riconosce il non-valore annegato in un bullet
 * («Gli importi massimi non sono ancora specificati»). Serve a MISURARE la
 * forma `hedged-prose`, mai a ripararla.
 */
const VACUOUS_ANYWHERE_RX = new RegExp(`(?:${VACUOUS_PHRASES.join('|')})`, 'iu');

/** Vero se il valore di una coppia E' il non-valore, per intero. */
export function matchesVacuousValue(value) {
  if (typeof value !== 'string') return false;
  return VACUOUS_VALUE_RX.test(value.trim());
}

const stripMarkdown = (s) => s.replace(/\*\*/g, '').replace(/^[\s*_-]+/, '').trim();

/**
 * Il valore di un bullet: il testo dopo l'ULTIMO due punti. Senza due punti il
 * bullet non e' una coppia termine→valore e il valore e' il bullet intero.
 */
export function factValueOf(item) {
  const clean = stripMarkdown(String(item));
  const idx = clean.lastIndexOf(':');
  return idx === -1 ? clean : clean.slice(idx + 1).trim();
}

const HEADING_RX = /^\s{0,3}#{1,6}\s/;
const isHeading = (line) => HEADING_RX.test(line);
const isSectionHeading = (line) =>
  AI_SEARCH_SECTION_HEADINGS.some((h) => line.trim().toLowerCase() === h.toLowerCase());

/**
 * Spezza il corpo di una sezione nei suoi bullet. Il modello non mette sempre
 * un bullet per riga — `borse-studio-sciaffusa` ne ha cinque sulla stessa —
 * quindi il separatore e' il MARCATORE di lista, non l'a capo.
 */
function splitBullets(sectionBody) {
  const out = [];
  const rx = /(?:^|\n|\s)([-*•])\s+/g;
  let m;
  let start = -1;
  while ((m = rx.exec(sectionBody)) !== null) {
    if (start !== -1) out.push({ start, end: m.index });
    start = m.index === 0 ? 0 : m.index + (m[0].length - m[0].trimStart().length);
  }
  if (start !== -1) out.push({ start, end: sectionBody.length });
  // ── IL BULLET FINISCE ALLA RIGA VUOTA, e non e' un dettaglio ────────────
  //
  // La sezione arriva fino alla prossima intestazione, ma dopo l'ultimo bullet
  // c'e' il LEAD giornalistico, che nessuna intestazione precede. Senza questo
  // taglio l'ultimo bullet inghiottiva il lead: la misura leggeva come
  // «non-valore annegato nella prosa» un bullet vuoto seguito dall'articolo, e
  // — molto peggio — `stripVacuousFacts` avrebbe cancellato il lead insieme al
  // bullet.
  return out.map(({ start, end }) => {
    const span = sectionBody.slice(start, end);
    const blank = span.search(/\n[ \t]*\n/);
    const stop = blank === -1 ? end : start + blank;
    return { start, end: stop, raw: sectionBody.slice(start, stop) };
  });
}

/**
 * Le sezioni AI-search di un corpo, con i loro bullet. Esportata perche' e' la
 * misura: uno scanner del corpus la usa per contare, il percorso di scrittura
 * per riparare.
 *
 * @param {string} body
 * @returns {Array<{heading: string, start: number, end: number, bullets: Array<{raw: string, value: string}>}>}
 */
export function parseAiSearchSections(body) {
  if (!body || typeof body !== 'string') return [];
  const lines = body.split('\n');
  const sections = [];
  let offset = 0;
  const lineStarts = lines.map((l) => {
    const at = offset;
    offset += l.length + 1;
    return at;
  });
  for (let i = 0; i < lines.length; i += 1) {
    if (!isSectionHeading(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !isHeading(lines[j])) j += 1;
    const bodyStart = lineStarts[i] + lines[i].length + 1;
    const bodyEnd = j < lines.length ? lineStarts[j] : body.length;
    const sectionBody = body.slice(bodyStart, bodyEnd);
    sections.push({
      heading: lines[i].trim(),
      headingStart: lineStarts[i],
      start: bodyStart,
      end: bodyEnd,
      bullets: splitBullets(sectionBody).map((b) => ({
        ...b,
        start: b.start + bodyStart,
        end: b.end + bodyStart,
        value: factValueOf(b.raw),
      })),
    });
    i = j - 1;
  }
  return sections;
}

/**
 * La MISURA. Ogni bullet vuoto di ogni sezione AI-search, con la sua forma.
 *
 * @param {string} body
 * @returns {Array<{heading: string, kind: 'placeholder-value'|'hedged-prose', text: string, value: string}>}
 */
export function findVacuousFacts(body) {
  const hits = [];
  for (const section of parseAiSearchSections(body)) {
    for (const bullet of section.bullets) {
      const text = bullet.raw.trim();
      if (matchesVacuousValue(bullet.value)) {
        hits.push({ heading: section.heading, kind: 'placeholder-value', text, value: bullet.value });
      } else if (VACUOUS_ANYWHERE_RX.test(bullet.value) && !/\d/.test(bullet.value)) {
        hits.push({ heading: section.heading, kind: 'hedged-prose', text, value: bullet.value });
      }
    }
  }
  return hits;
}

/**
 * La RIPARAZIONE, per sottrazione: via i bullet `placeholder-value`, e via la
 * sezione intera se cio' che resta sta sotto `MIN_FACTS_PER_SECTION` — una
 * intestazione «Fatti chiave» seguita da un bullet solo e' peggio della sua
 * assenza. I `hedged-prose` restano e vengono restituiti in `residual`.
 *
 * @param {string} body
 * @returns {{ value: string, changed: boolean, dropped: string[], sectionsRemoved: string[], residual: Array<object> }}
 */
export function stripVacuousFacts(body) {
  const empty = { value: body, changed: false, dropped: [], sectionsRemoved: [], residual: [] };
  if (!body || typeof body !== 'string') return empty;
  const sections = parseAiSearchSections(body);
  if (!sections.length) return empty;

  const dropped = [];
  const sectionsRemoved = [];
  const residual = [];
  /** @type {Array<{start: number, end: number}>} */
  const cuts = [];

  for (const section of sections) {
    const bad = section.bullets.filter((b) => matchesVacuousValue(b.value));
    for (const b of section.bullets) {
      if (bad.includes(b)) continue;
      if (VACUOUS_ANYWHERE_RX.test(b.value) && !/\d/.test(b.value)) {
        residual.push({ heading: section.heading, kind: 'hedged-prose', text: b.raw.trim() });
      }
    }
    if (!bad.length) continue;
    const survivors = section.bullets.length - bad.length;
    if (survivors < MIN_FACTS_PER_SECTION) {
      // Il taglio arriva alla fine dell'ULTIMO BULLET, non a `section.end`.
      // La sezione si estende fino alla prossima intestazione, ma fra l'ultimo
      // bullet e quell'intestazione c'e' il lead giornalistico: tagliare fino a
      // `section.end` toglierebbe l'articolo insieme all'elenco vuoto.
      const lastBulletEnd = Math.max(...section.bullets.map((b) => b.end));
      sectionsRemoved.push(section.heading);
      dropped.push(...section.bullets.map((b) => b.raw.trim()));
      cuts.push({ start: section.headingStart, end: lastBulletEnd });
    } else {
      dropped.push(...bad.map((b) => b.raw.trim()));
      cuts.push(...bad.map((b) => ({ start: b.start, end: b.end })));
    }
  }

  if (!cuts.length) return { ...empty, residual };

  cuts.sort((a, b) => b.start - a.start);
  let out = body;
  for (const cut of cuts) out = out.slice(0, cut.start) + out.slice(cut.end);
  // I tagli lasciano righe vuote e bullet appiccicati: si normalizza solo cio'
  // che il taglio ha prodotto, non il resto del corpo.
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();

  return { value: out, changed: out !== body, dropped, sectionsRemoved, residual };
}

export default {
  MIN_FACTS_PER_SECTION,
  VACUOUS_VALUE_ALTERNATIVES,
  matchesVacuousValue,
  factValueOf,
  parseAiSearchSections,
  findVacuousFacts,
  stripVacuousFacts,
};

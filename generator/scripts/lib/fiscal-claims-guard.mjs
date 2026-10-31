/**
 * fiscal-claims-guard.mjs — affermazioni fiscali che le fonti primarie smentiscono.
 *
 * ## Il difetto
 *
 * Il prompt di `create-article.mjs` dichiarava come «fatto verificato» una
 * «esenzione €7'500 per i vecchi frontalieri» e che l'imposta sia trattenuta «MAI
 * in entrambi i paesi». Il fact-checker confrontava gli articoli con quel testo,
 * quindi l'errore non solo nasceva dal prompt: veniva anche difeso. Misurato il
 * 2026-10-31: 4.684 frasi in 1.454 file, nelle quattro lingue.
 *
 * ## Cosa dicono le fonti (scheda del 2026-10-31)
 *
 * - Franchigia IRPEF: 10.000 € dal 2024 per tutti i frontalieri il cui reddito e'
 *   tassato in Italia; 7.500 € era il valore precedente (L. 83/2023 art. 4,
 *   Circ. AdE 25/E/2023 §§ 1 e 2.4.4). I vecchi frontalieri dell'art. 9 sul salario
 *   non sono tassati in Italia, quindi non hanno alcuna «esenzione».
 * - Nessuna «deduzione forfetaria sanitaria» da 3.000 € nelle norme sui frontalieri.
 * - 80% e' il tetto del prelievo svizzero (Accordo art. 3), non del credito italiano,
 *   che e' limitato dalla quota di IRPEF proporzionale (Convenzione art. 24).
 * - Il restante 20% non e' retrocesso a nessuno.
 * - Compensazione art. 9: 40% dell'imposta lorda fino all'anno fiscale 2033.
 *   Il 38,8% e' una cifra storica di atti parlamentari, non dell'Accordo 2020.
 * - Accordo in vigore dal 17/7/2023, applicato dal 1/1/2024.
 * - Quota SSN: 3-6% del salario netto, da 30 a 200 € per mese lavorato (DM 14/11/2025).
 *
 * ## Una sola definizione, due usi
 *
 * Il gate di generazione rifiuta la bozza; il test sul corpus impedisce il ritorno
 * dell'errore. `repair-fiscal-claims.mjs` usa gli stessi predicati per l'arretrato.
 * Il testo puo' essere grezzo (letterale TS con `\\n` e `\\'`) o gia' decodificato.
 *
 * Modulo puro.
 */

export const AMOUNT_7500 = String.raw`7(?:\\?['’]|[.,\u00a0 ])?500`;
const AMOUNT_7500_STANDALONE_RE = new RegExp(String.raw`(?<![\d.,'’])${AMOUNT_7500}(?!\d|[.,'’\u00a0 ]\d)`, 'g');

const EXEMPTION_WORD_RE = /(esenzion|esent|esonero|franchig|exempt|allowance|deductible|tax[- ]free|befrei|freibetrag|freigrenze|selbstbeteilig|entlastung|exon[eé]r|exempt|franchise|abbatt)/i;
const OLD_WORKER_RE = /(vecchi frontalieri|vecchio frontaliere|old (?:frontier|cross|border)|alte[nr]? grenz|bisherige grenz|anciens? frontalier)/i;
const EURO_RE = /(€|\beuro|\beur\b)/i;
const MONTHLY_RE = /(al mese|mensil|\/mese|per month|a month|monthly|pro monat|monatlich|par mois|mensuel)/i;
const HISTORIC_RE = /(fino al 2023|prima del 2024|until 2023|before 2024|bis 2023|vor 2024|jusqu.en 2023|avant 2024)/i;

const NEGATED_RETROCESSION_RE = /(?:\bnon\b|\bnessun[ao]?\b|\bnot\b|\bno\b|\bnicht\b|\bkein\w*|\bne\b|\bn['’]|\baucun\w*)[^.]{0,40}(?:retrocess|r[eé]troc[eé]d)/i;

export const CLAIM_RULES = Object.freeze([
  {
    id: 'franchigia-7500',
    source: 'L. 83/2023 art. 4; Circ. AdE 25/E/2023',
    matches: (sentence) => {
      AMOUNT_7500_STANDALONE_RE.lastIndex = 0;
      if (!AMOUNT_7500_STANDALONE_RE.test(sentence) || HISTORIC_RE.test(sentence)) return false;
      if (EXEMPTION_WORD_RE.test(sentence)) return true;
      return OLD_WORKER_RE.test(sentence) && EURO_RE.test(sentence) && !MONTHLY_RE.test(sentence);
    },
  },
  {
    id: 'deduzione-forfetaria-sanitaria',
    source: 'L. 83/2023 art. 5; L. 213/2023 cc. 237-239',
    matches: (sentence) => /(deduzione|deduction|abzug|d[eé]duction)[^.]{0,30}(forfe?t+ari|flat[- ]rate|pauschal|forfaitaire)[^.]{0,30}(sanitari|health|gesundheit|sant[eé])/i.test(sentence),
  },
  {
    id: 'ristorni-38-8',
    source: 'Accordo 2020 art. 9',
    matches: (sentence) => /38[,.]8\s?%/.test(sentence)
      && /(ristorn|retroced|compensa|comuni di|ristorni|imposta alla fonte|quellensteuer|withholding|imp[oô]t [àa] la source)/i.test(sentence)
      && !/(1985|1974|storic|histor)/i.test(sentence),
  },
  {
    id: 'credito-80',
    source: 'Accordo 2020 art. 3; Convenzione art. 24',
    matches: (sentence) => /(credito d.imposta|tax credit|steueranrechnung|steuergutschrift|cr[eé]dit d.imp[oô]t)[^.]{0,40}(fino all.80|up to 80|bis zu 80|jusqu.[àa] 80|80\s?%\s+(?:del|of the|der|du)\s+(?:prelievo|ritenuta|withh|quellen|pr[eé]l))/i.test(sentence),
  },
  {
    id: 'retrocessione-20',
    source: 'Accordo 2020 art. 3',
    matches: (sentence) => /\b20\s?%[^.]{0,40}(retrocess|r[eé]troc[eé]d)/i.test(sentence)
      && /(frontalier|grenzg|cross-border|comun|municip)/i.test(sentence)
      && !NEGATED_RETROCESSION_RE.test(sentence),
  },
  {
    id: 'mai-in-entrambi',
    source: 'Accordo 2020 artt. 3 e 5',
    matches: (sentence) => /(mai in entrambi|never in both|nie(?:mals)? in beiden|jamais dans les deux)/i.test(sentence),
  },
  {
    id: 'accordo-in-vigore-2024',
    source: 'Accordo 2020 art. 8',
    matches: (sentence) => /(accordo|agreement|abkommen|accord)[^.]{0,50}(in vigore dal|in force (?:from|since)|entered into force on|in kraft seit|en vigueur depuis)\s+(?:il\s+)?(?:1°?\s*(?:o\s+)?gennaio 2024|1\.?\s*(?:january|januar) 2024|january 1,? 2024|1er janvier 2024)/i.test(sentence),
  },
]);

const ABBREVIATION_RE = /(?:^|[\s(])(?:art|artt|Art|ca|n|nr|Nr|z\.B|d\.h|ecc|etc|vs|lett|par|prot|Prot|St|c|cc|sig|dott|bzw|Abs|al|cfr|p|pp)$/;

function isSentenceBreak(text, punctuationAt) {
  const before = text[punctuationAt - 1] ?? '';
  const after = text[punctuationAt + 2] ?? '';
  if (/\d/.test(before)) return /[A-ZÀ-Ý«*]/.test(after) && !/\d\.\s(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)/.test(text.slice(punctuationAt - 1, punctuationAt + 14));
  if (ABBREVIATION_RE.test(text.slice(Math.max(0, punctuationAt - 8), punctuationAt))) return false;
  return /[A-ZÀ-Ý«*"\d(]/.test(after);
}

/**
 * I limiti della frase che contiene `index`, per testo decodificato o letterale TS.
 *
 * @returns {{start: number, end: number}} `end` include la punteggiatura finale
 */
export function sentenceSpanAt(text, index, maxLength = 700) {
  const floor = Math.max(0, index - maxLength);
  let start = floor;
  for (let i = index; i > floor; i -= 1) {
    const char = text[i - 1];
    if (char === '\n' || char === '|') { start = i; break; }
    if (char === 'n' && text[i - 2] === '\\') { start = i; break; }
    if (char === "'" && text[i - 2] !== '\\' && !/[\p{L}\p{N}]/u.test(text[i] ?? '')) { start = i; break; }
    if (char === "'" && text[i - 2] !== '\\' && /[:\s[,]/.test(text[i - 2] ?? '')) { start = i; break; }
    if (char === '"' && /":\s?$|[,{[]\s?$/.test(text.slice(Math.max(0, i - 4), i - 1))) { start = i; break; }
    if (char === ' ' && /[.!?]/.test(text[i - 2] ?? '') && isSentenceBreak(text, i - 2)) { start = i; break; }
  }
  const ceiling = Math.min(text.length, index + maxLength);
  let end = ceiling;
  for (let i = index; i < ceiling; i += 1) {
    const char = text[i];
    if (char === '\n' || char === '|') { end = i; break; }
    if (char === '\\' && text[i + 1] === 'n') { end = i; break; }
    if (char === "'" && text[i - 1] !== '\\' && /^(?:[,\s\]})]|$)/.test(text[i + 1] ?? '')) { end = i; break; }
    if (char === '"' && /^\s?[,}\]]/.test(text.slice(i + 1, i + 3))) { end = i; break; }
    if (/[.!?]/.test(char) && text[i + 1] === ' ' && isSentenceBreak(text, i)) { end = i + 1; break; }
    if (/[.!?]/.test(char) && (text.startsWith('\\n', i + 1) || text[i + 1] === '\n')) { end = i + 1; break; }
  }
  return { start, end };
}

const CANDIDATE_RE = new RegExp(
  `${AMOUNT_7500}|forfe?t+ari|flat[- ]rate|pauschal|forfaitaire|38[,.]8|\\b80\\s?%|\\b20\\s?%`
  + '|mai in entrambi|never in both|nie(?:mals)? in beiden|jamais dans les deux'
  + '|gennaio 2024|january 2024|january 1,? 2024|januar 2024|janvier 2024',
  'gi',
);

/**
 * @param {string} text
 * @returns {Array<{id: string, source: string, start: number, end: number, sentence: string}>}
 */
export function findFiscalClaims(text) {
  if (typeof text !== 'string' || !text) return [];
  const found = [];
  const seen = new Set();
  for (const match of text.matchAll(CANDIDATE_RE)) {
    const { start, end } = sentenceSpanAt(text, match.index);
    const sentence = text.slice(start, end);
    for (const rule of CLAIM_RULES) {
      const key = `${rule.id}:${start}`;
      if (seen.has(key) || !rule.matches(sentence)) continue;
      seen.add(key);
      found.push({ id: rule.id, source: rule.source, start, end, sentence });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Una percentuale riferita alla paga: le altre (sondaggi, aumenti) non sono l'aliquota. */
const RATE_ON_PAY_RE = /(\d{1,2}(?:[.,]\d)?)(?:\s?%?\s?(?:-|–|—|a|al|to|bis|à)\s?(\d{1,2}(?:[.,]\d)?))?\s?%\s+(?:del|dello|della|von|of|of the|des|du|de|de la)\s+(?:proprio\s+|their\s+|ihres\s+)?(?:reddit|salari|stipendi|income|salary|wage|einkommen|nettoeinkommen|bruttoeinkommen|lohn|gehalt|brutto|netto|revenu|salaire|gross|net)\w*(?:\s+(?:netto|lordo|net|gross|brut|brutto))?/gi;

/**
 * Quota SSN: la base e' il salario netto e la forchetta e' 3-6%. Un'affermazione
 * che la lega al lordo o a una percentuale fuori forchetta non passa.
 */
export function findTaxHealthParameterErrors(text) {
  if (typeof text !== 'string') return [];
  const errors = [];
  const re = /(tassa (?:sulla )?salute|tassa sanitaria|quota ssn|health tax|gesundheitssteuer|gesundheitsabgabe|taxe (?:sur la )?sant[eé])/gi;
  for (const match of text.matchAll(re)) {
    const { start, end } = sentenceSpanAt(text, match.index);
    const sentence = text.slice(start, end);
    for (const percent of sentence.matchAll(RATE_ON_PAY_RE)) {
      const values = [percent[1], percent[2]].filter(Boolean).map((value) => Number(value.replace(',', '.')));
      if (/(rappresent|represent|dargestellt|repr[eé]sent)/i.test(sentence)) break;
      if (/(lordo|gross|brutto|brut)/i.test(percent[0]) || values.some((value) => value < 3 || value > 6)) {
        errors.push({ id: 'tassa-salute-parametri', source: 'DM Salute 14/11/2025 art. 1', start, end, sentence });
        break;
      }
    }
  }
  return errors;
}

/** Tutti gli errori fiscali di un testo. */
export function findFiscalErrors(text) {
  return [...findFiscalClaims(text), ...findTaxHealthParameterErrors(text)];
}

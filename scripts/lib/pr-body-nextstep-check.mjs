/**
 * pr-body-nextstep-check.mjs — validatore deterministico del **piano di
 * completamento**: le voci di `## Non implementato (ancora)` non devono
 * appoggiarsi a una scappatoia al posto di uno stato. ZERO Claude (regex pure).
 *
 * ## Il difetto che chiude (escalation #140)
 *
 * `pr-body-sections-check.mjs` verifica che la sezione ESISTA e che non sia il
 * placeholder `- ` del template. Non verifica cosa c'e' scritto dentro. Ma
 * `REVIEW.md` §98 non chiede una sezione non vuota, chiede un **piano**:
 *
 *   > Ogni voce e' lavoro ancora dovuto: verifica che dichiari uno stato
 *   > concreto (`in questa PR` / `PR concatenata #N` / `blocked: <causa
 *   > esterna reale>`), non una scappatoia (`out of scope`, `posposto`).
 *   > Scope dovuto senza piano ne' esecuzione -> 🔴 Important.
 *
 * In quello spazio — fra il «non vuota» che la macchina controllava e il «con
 * un piano» che il contratto chiede — il bucket
 * `reviewer-finding/pr-body-contract` ha continuato a ricorrere: 9 finding su
 * 40 PR mergiate nella finestra 2026-07-27 → 2026-08-10, di cui **5 sono
 * esattamente questa forma** (#124, #108, #89, #80, #75).
 *
 * ## Perche' il check e' a DUE livelli, e non uno solo
 *
 * La versione ovvia di questo gate — «ogni voce deve contenere una delle tre
 * forme letterali» — e' stata scritta e **misurata sui body reali prima di
 * decidere**. Boccia **34 PR su 40**, cioe' quasi ogni PR che il reviewer ha
 * letto e approvato. Non e' un difetto della regex: e' che il reviewer applica
 * un giudizio («questo piano c'e', anche se non nella forma letterale») che una
 * regex non ha. Un gate bloccante con quel tasso verrebbe spento in due giorni,
 * ed e' il modo tipico in cui un fix strutturale diventa un fastidio.
 *
 * Le varianti misurate, per non doverle rimisurare:
 *
 *   regola                                        PR bocciate   voci   recall
 *   ogni voce ha una forma letterale                  34/40      —      5/5
 *   nessuno stato e nessun `#N`                       33/40     111     3/5
 *   scappatoia nominata (solo REVIEW.md)               3/40       3     0/5
 *   scappatoia + nessuno stato + nessuna decisione     8/40       9     1/5   <- BLOCCANTE
 *
 * Quindi:
 *
 *   - **BLOCCANTE** (`violations`): la voce si appoggia a una scappatoia
 *     (`out of scope`, `posposto`, «un giro dedicato», «separatamente»…) E non
 *     dichiara nessuno stato E non e' una decisione motivata esplicita. Volume
 *     misurato: 9 voci su 40 PR. La rimedia una frase, e il gate la stampa.
 *   - **AVVISO** (`advisories`): la voce non ha una forma letterale ma nemmeno
 *     una scappatoia. Segnalata con la riscrittura pronta, **senza far fallire
 *     niente** — e' il caso in cui il giudizio serve davvero.
 *
 * Il valore del livello bloccante non e' teorico: le voci-scappatoia di #106 e
 * #118 sono **diventate** i finding del reviewer su #108 e #124, cioe' le due
 * PR di correzione che sono servite dopo. Prese al primo giro, quelle due PR
 * non sarebbero servite.
 *
 * ## Il riferimento nudo non e' un piano
 *
 * `#N` conta come stato solo se un sostantivo di tracciamento gli sta accanto
 * (`issue #126`, `PR concatenata #113`, `tracciata in #113`). E' la distinzione
 * che separa i body accettati da quelli bocciati: #124 («si ferma a un'analogia
 * con #97») e #75 («the sibling issue mentioned in #66 is vague») contengono
 * entrambi un `#N`, e sono stati bocciati entrambi.
 *
 * Uso:
 *   node scripts/lib/pr-body-nextstep-check.mjs "$BODY"
 *   node scripts/lib/pr-body-nextstep-check.mjs --json "$BODY"
 *
 * Returns: { ok, violations, advisories }
 */

import { extractSection, stripNonContent } from './pr-body-sections-check.mjs';

// Gli stessi header di `pr-body-sections-check.mjs`. Il corpus usa la variante
// `(ancora)`, il sito quella senza: il modulo accetta entrambe cosi' resta
// utile da tutti e due i lati senza dover sapere dove sta girando.
const NON_IMPL_ANCORA_RE = /^[ \t]{0,3}#{2,3}[ \t]+Non[ \t]+implementato[^\n]*\(ancora\)/im;
const NON_IMPL_ANY_RE = /^[ \t]{0,3}#{2,3}[ \t]+Non[ \t]+implementato\b/im;

/**
 * Le forme di stato concreto ammesse. `label` finisce nel messaggio d'errore:
 * un gate che dice «manca lo stato» senza dire quali stati esistono costringe a
 * rileggere REVIEW.md, che e' il giro che questo gate esiste per evitare.
 */
export const STATE_FORMS = [
  // REVIEW.md, forma 1 — il lavoro e' gia' in questa PR.
  { id: 'in-questa-pr', label: '`in questa PR`', re: /\bin questa PR\b/i },
  // REVIEW.md, forma 2 — c'e' una PR/issue che lo prende in carico. Il
  // sostantivo di tracciamento DEVE stare accanto al ref: e' cio' che
  // distingue un piano da una citazione di contesto.
  {
    id: 'tracking-ref',
    label: '`PR concatenata #N` / `issue #N`',
    re: /\b(?:issue|PR|ticket|follow-?up|bug)\s+(?:concatenat[ao]\s+)?#\d+/i,
  },
  // `[*_`]*` fra la preposizione e il ref: nei body reali il numero e' quasi
  // sempre in grassetto (`tracciata in **#126**`), e senza questo il ref non
  // verrebbe visto.
  {
    id: 'tracked-in',
    label: '`tracciata in #N`',
    re: /\b(?:tracciat[oa]|tracked|apert[oa]|apre|segue|seguita|copert[oa])\s+(?:in|da|con|su|come)?\s*[*_`]*#\d+/i,
  },
  // `PR concatenata` senza numero adiacente: il body di #108 la usa cosi', col
  // ref in una clausola successiva. Accettata: e' la forma letterale del
  // contratto.
  { id: 'pr-concatenata', label: '`PR concatenata #N`', re: /\bPR\s+concatenat[ao]\b/i },
  // REVIEW.md, forma 3 — bloccato da una causa esterna reale. Il due punti (o
  // il trattino) e' richiesto: `blocked` da solo non e' una causa.
  { id: 'blocked', label: '`blocked: <causa>`', re: /\b(?:blocked|bloccat[oa])\s*[:—–-]\s*\S/i },
  // Stato terminale esplicito: non e' lavoro dovuto, e lo dice. Whitelist
  // STRETTA di proposito — un generico `\bnessun\b` catturerebbe «Nessun
  // controllo che la label esista DAVVERO», che e' una lacuna dichiarata, cioe'
  // esattamente il caso che il gate deve prendere.
  {
    id: 'no-work-owed',
    label: '`Nessun lavoro dovuto`',
    re: /\bnessun(?:o|a)?\s+(?:lavoro\s+dovuto|azione(?:\s+(?:dovuta|richiesta))?|intervento\s+dovuto)\b|\bniente\s+da\s+fare\b/i,
  },
];

/**
 * Le scappatoie: `out of scope` e `posposto` sono quelle che `REVIEW.md`
 * esclude alla lettera; le altre sono le forme equivalenti osservate nei body
 * reali («vale un giro dedicato» in #118/#124, «e' in corso separatamente» in
 * #89, «prima o poi va scelto» in #89).
 */
export const ESCAPE_HATCHES = [
  { re: /\bout of scope\b/i, quote: 'out of scope' },
  { re: /\bfuori\s+(?:dallo\s+)?scope\b/i, quote: 'fuori scope' },
  { re: /\bpospost[oai]\b/i, quote: 'posposto' },
  { re: /\brimandat[oai]\b/i, quote: 'rimandato' },
  { re: /\bprima o poi\b/i, quote: 'prima o poi' },
  { re: /\b(?:un\s+)?giro\s+(?:dedicato|separato|a\s+parte)\b/i, quote: 'un giro dedicato' },
  { re: /\bPR\s+(?:dedicata|separata|a\s+parte)\b/i, quote: 'una PR separata senza numero' },
  { re: /\bseparatamente\b/i, quote: 'separatamente' },
  { re: /\bpi[uù]'?\s+avanti\b/i, quote: 'più avanti' },
  { re: /\bin\s+seguito\b/i, quote: 'in seguito' },
  { re: /\bda\s+valutare\b/i, quote: 'da valutare' },
  { re: /\bTBD\b/i, quote: 'TBD' },
];

/**
 * Una decisione motivata esplicita NON e' una scappatoia: «per scelta», «by
 * construction», «e' una decisione, non una dimenticanza» sono stati terminali
 * legittimi, e i body reali li usano. Senza questa esenzione il livello
 * bloccante prenderebbe anche loro.
 */
// Niente `\b` davanti a `è`: fuori dalla modalita' unicode `è` non e' un
// carattere di parola, quindi il confine non si comporta come ci si aspetta e
// l'alternativa non aggancia mai.
export const DECISION_RE =
  /\bby construction\b|\bper (?:scelta|costruzione|design)\b|(?:è|e')\s+una\s+decisione\b|\bdi proposito\b|\bdeliberat\w*/i;

/**
 * Estrae le voci di PRIMO livello della sezione. Le righe di continuazione e i
 * sotto-bullet rientrati appartengono alla voce che li precede: una voce il cui
 * stato sta in un sotto-bullet e' comunque una voce con lo stato.
 *
 * @param {string} sectionText
 * @returns {Array<{ index: number, text: string }>}
 */
export function topLevelBullets(sectionText) {
  const clean = stripNonContent(sectionText ?? '');
  const bullets = [];
  let current = null;
  for (const line of clean.split('\n')) {
    // Bullet di primo livello: marcatore a inizio riga con al massimo un
    // carattere di rientro (da 2 spazi in su e' un sotto-bullet).
    if (/^[ ]{0,1}[-*+][ \t]+\S/.test(line)) {
      if (current) bullets.push(current);
      current = { index: bullets.length + 1, text: line.trim() };
    } else if (current && line.trim()) {
      current.text += ' ' + line.trim();
    }
  }
  if (current) bullets.push(current);
  return bullets;
}

/**
 * True se la sezione dichiara «nessun lavoro dovuto» per l'intera PR, cioe' se
 * il suo contenuto e' sostanzialmente il solo marker `Nessuno`. Piu' stretto di
 * `hasNessuno` del modulo gemello, che cerca `nessun` ovunque nella sezione e
 * quindi sarebbe soddisfatto da una voce che dice «Nessun controllo che…».
 *
 * @param {string} sectionText
 * @returns {boolean}
 */
export function sectionIsNessuno(sectionText) {
  const clean = stripNonContent(sectionText ?? '')
    .replace(/[*_`>\-\s.]+/g, ' ')
    .trim()
    .toLowerCase();
  return /^nessun[oa]?$/.test(clean);
}

/**
 * Lo stato dichiarato da una voce, o null.
 *
 * @param {string} text
 * @returns {{ id: string, label: string } | null}
 */
export function bulletState(text) {
  const s = String(text ?? '');
  for (const f of STATE_FORMS) if (f.re.test(s)) return { id: f.id, label: f.label };
  return null;
}

/**
 * La scappatoia usata da una voce, o null.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function escapeHatchIn(text) {
  const s = String(text ?? '');
  for (const h of ESCAPE_HATCHES) if (h.re.test(s)) return h.quote;
  return null;
}

/** Prime `n` parole della voce, per identificarla senza allegare un muro di testo. */
function snippetOf(text, n = 70) {
  const flat = String(text ?? '')
    .replace(/^[-*+][ \t]*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > n ? flat.slice(0, n).trimEnd() + '…' : flat;
}

/** La riga di stato che il gate propone di appendere a una voce. */
const STATE_TEMPLATE =
  '**Stato:** `in questa PR` | `PR concatenata #N` | `blocked: <causa esterna reale>`';

/**
 * Verifica il piano di completamento.
 *
 * Non fa niente se la sezione manca: quello e' gia' il dominio di
 * `checkPrBodySections`, e due gate che segnalano lo stesso difetto con due
 * messaggi diversi sono peggio di uno.
 *
 * @param {string} body
 * @returns {{ ok: boolean, violations: Array<object>, advisories: Array<object> }}
 */
export function checkNextStepStates(body = '') {
  const s = String(body ?? '');
  const headerRe = NON_IMPL_ANCORA_RE.test(s) ? NON_IMPL_ANCORA_RE : NON_IMPL_ANY_RE;
  const section = extractSection(s, headerRe);
  if (section === null) return { ok: true, violations: [], advisories: [] };
  if (sectionIsNessuno(section)) return { ok: true, violations: [], advisories: [] };

  const violations = [];
  const advisories = [];
  for (const b of topLevelBullets(section)) {
    if (bulletState(b.text)) continue;
    const hatch = escapeHatchIn(b.text);
    const decided = DECISION_RE.test(b.text);
    if (hatch && !decided) {
      violations.push({
        type: 'escape-hatch-instead-of-state',
        section: 'Non implementato (ancora)',
        index: b.index,
        text: b.text,
        snippet: snippetOf(b.text),
        escapeHatch: hatch,
        message:
          `Voce ${b.index} («${snippetOf(b.text, 55)}») rimanda il lavoro con «${hatch}» ` +
          'senza dichiarare uno stato concreto. REVIEW.md §98 esclude nominatamente la ' +
          'scappatoia: serve `in questa PR`, `PR concatenata #N` oppure `blocked: <causa>`. ' +
          '(Se e\' una decisione motivata e non un rinvio, scrivilo: «per scelta», «by construction».)',
      });
    } else if (!hatch) {
      advisories.push({
        type: 'no-literal-state',
        section: 'Non implementato (ancora)',
        index: b.index,
        text: b.text,
        snippet: snippetOf(b.text),
        message:
          `Voce ${b.index} («${snippetOf(b.text, 55)}») non porta una delle forme letterali ` +
          'del contratto. Non blocca — ma se e\' lavoro dovuto, un `PR concatenata #N` lo rende ' +
          'tracciabile invece che affidato alla memoria.',
      });
    }
  }
  return { ok: violations.length === 0, violations, advisories };
}

/**
 * Il markdown della sezione riscritta: lo `**Stato:**` appeso alle sole voci
 * che ne sono prive, le altre invariate.
 *
 * E' la parte che rende il gate un fix strutturale invece di un allarme. Un
 * gate che dice «manca lo stato» costringe comunque a capire dove e come, ed e'
 * quel costo — non l'ignoranza della regola, che era gia' scritta in REVIEW.md
 * e citata verbatim dal reviewer a ogni occorrenza — ad aver fatto ricorrere il
 * pattern. Qui la correzione e' gia' scritta: si incolla.
 *
 * @param {string} body
 * @returns {string|null} markdown della sezione corretta, o null se non serve
 */
export function suggestedSection(body = '') {
  const { violations, advisories } = checkNextStepStates(body);
  if (!violations.length && !advisories.length) return null;
  const flagged = new Map();
  for (const v of violations) flagged.set(v.index, 'violation');
  for (const a of advisories) flagged.set(a.index, 'advisory');

  const s = String(body ?? '');
  const headerRe = NON_IMPL_ANCORA_RE.test(s) ? NON_IMPL_ANCORA_RE : NON_IMPL_ANY_RE;
  const section = extractSection(s, headerRe) ?? '';
  const header = (headerRe.exec(s) || [''])[0].trim();

  const lines = [header, ''];
  for (const b of topLevelBullets(section)) {
    const text = b.text.replace(/^[-*+][ \t]*/, '').trim();
    const kind = flagged.get(b.index);
    if (!kind) {
      lines.push(`- ${text}`);
      continue;
    }
    const punctuated = text.replace(/\s*$/, '').replace(/([^.!?:;])$/, '$1.');
    lines.push(`- ${punctuated} ${STATE_TEMPLATE}${kind === 'advisory' ? '  <!-- opzionale -->' : ''}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI (solo se invocato direttamente)
// ---------------------------------------------------------------------------
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const bodyArg = argv.filter((a) => !a.startsWith('--'))[0];
  const run = (body) => {
    const res = checkNextStepStates(body);
    if (asJson) {
      process.stdout.write(JSON.stringify({ ...res, suggestion: suggestedSection(body) }, null, 2) + '\n');
    } else {
      for (const v of res.violations) process.stderr.write(`✗ [${v.type}] ${v.message}\n`);
      for (const a of res.advisories) process.stdout.write(`· [${a.type}] ${a.message}\n`);
      if (res.ok && !res.advisories.length) {
        process.stdout.write('✓ Piano di completamento OK — nessuna voce si appoggia a una scappatoia.\n');
      } else {
        process.stdout.write('\nSezione proposta:\n\n' + suggestedSection(body) + '\n');
      }
    }
    if (!res.ok) process.exitCode = 1;
  };
  if (typeof bodyArg === 'string') {
    run(bodyArg);
  } else {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => run(buf));
  }
}

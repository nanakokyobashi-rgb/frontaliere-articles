/**
 * Il prompt `stats-bfs://` deve essere SATISFACIBILE dai gate di fedeltà.
 *
 * ## L'incidente (valerielinc-ops#5341)
 *
 * Il dataset BFS è passato a 2026-Q2 il 2026-08-08. `/statistiche/` si è
 * aggiornata, l'articolo di annuncio no — e non per il dispatch perduto in
 * coda che la issue racconta: rieseguito a mano il 2026-08-10 con i numeri
 * veri di Firestore, `create-article.mjs stats-bfs://2026-Q2` ha bruciato
 * tutti e sei i tentativi (gpt-4o, gemini-2.5-flash, gpt-4.1-nano,
 * gpt-oss-120b, gpt-4o-mini) e non ha prodotto nulla. Ogni tentativo è stato
 * respinto da `source-key-rates-dropped` + `source-fidelity-low`.
 *
 * ## La causa, che sta QUI e non nei modelli
 *
 * Per una sorgente sintetica il SOURCE CONTENT *è* il prompt, e
 * `extractSourceAnchors()` promuove ad ancora obbligatoria ogni
 * `\d[\d.,]*\s*%` che ci trova — istruzioni editoriali comprese. Il prompt ne
 * conteneva cinque, e due erano difettose per costruzione:
 *
 *  - `0,3%` veniva dalla riga «se sotto ±0.3% "stabile"», una soglia
 *    redazionale: nessun articolo la scriverà mai, quindi restava
 *    permanentemente nel denominatore di `source-fidelity-low` e fuori dal
 *    numeratore. Con 5 ancore e la soglia di `source-key-rates-dropped` a
 *    «≥2 mancanti», quell'ancora impossibile bastava a rendere il gate
 *    superabile solo con un recupero PERFETTO delle altre quattro.
 *  - Le due percentuali di variazione erano scritte col PUNTO (`0.64%`), che
 *    `matchedAnchors()` non accredita mai: accetta solo la virgola. Il writer
 *    che copiava fedelmente dalla fonte falliva lo stesso il gate che gli
 *    chiedeva quel numero.
 *
 * È la stessa classe di difetto documentata dentro `extractSourceAnchors` per
 * gli acronimi presi dall'intestazione del prompt (ARTICOLO, SEO, VALIDI):
 * un'ancora che l'articolo non può soddisfare non è un controllo, è uno stallo.
 *
 * ## Cosa pinna questo file
 *
 * Non il testo del prompt — quello cambierà. La PROPRIETÀ: ogni percentuale
 * che il prompt scrive dev'essere un DATO, mai un'istruzione, e dev'essere
 * scritta nella forma che il gate accredita. Le due metà (istruzione e
 * controllo) sono qui misurate insieme, con `extractSourceAnchors` e
 * `renderAnchorForPrompt` VERI, non riscritti.
 *
 * ## Perché estrae il sorgente invece di importarlo
 *
 * Come `seo-description-cap.test.mjs` e `blog-title-casing.test.mjs`: la
 * closure di `create-article.mjs` tira dipendenze npm che la CI di questo repo
 * non installa di proposito. `formatStatsBfsPrompt` è pura — l'I/O Firestore
 * resta in `buildStatsBfsPromptContent`, che la chiama — quindi si estrae e si
 * valuta in sandbox. Se l'estrazione si rompe, il test fallisce rumorosamente.
 */
import { describe, it } from 'node:test';
import { expect } from './lib/expect-shim.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSourceAnchors, renderAnchorForPrompt } from '../scripts/lib/article-factuality-gates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_ARTICLE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');

/** Slice from `header` to the first line that is exactly `}` at column 0. */
function sliceFn(src, header) {
  const start = src.indexOf(header);
  if (start === -1) {
    throw new Error(`"${header}" non trovato in create-article.mjs — aggiornare i delimitatori di questo test`);
  }
  const endRel = src.slice(start).search(/\n\}\n/);
  if (endRel === -1) throw new Error(`chiusura di "${header}" non trovata`);
  return src.slice(start, start + endRel + 2);
}

function extractFormatter() {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');
  const block = sliceFn(src, 'function formatStatsBfsPrompt(quarter, data) {');
  return new Function(`${block}\nreturn formatStatsBfsPrompt;`)();
}

const formatStatsBfsPrompt = extractFormatter();

/**
 * `config/bfs_stats` come si leggeva il 2026-08-10, ridotto ai campi che il
 * prompt usa. Numeri VERI: è il trimestre su cui la generazione si è piantata,
 * quindi il test misura il caso reale e non uno costruito per passare.
 */
const BFS_2026_Q2 = {
  latestQuarter: '2026-Q2',
  trend: [
    { year: '2024-Q4', frontalieri: 78960 },
    { year: '2025-Q1', frontalieri: 78994 },
    { year: '2025-Q2', frontalieri: 79578 },
    { year: '2025-Q3', frontalieri: 79608 },
    { year: '2025-Q4', frontalieri: 78698 },
    { year: '2026-Q1', frontalieri: 78616 },
    { year: '2026-Q2', frontalieri: 79121 },
  ],
  ages: [
    { name: '15-19 anni', value: 407 },
    { name: '30-34 anni', value: 9661 },
    { name: '50-54 anni', value: 11323 },
    { name: '65 anni o più', value: 1294 },
  ],
  genderSnapshot: [
    { name: 'Uomini', value: 48700, pct: '61.6' },
    { name: 'Donne', value: 30420, pct: '38.4' },
  ],
};

const PROMPT = formatStatsBfsPrompt('2026-Q2', BFS_2026_Q2);

/** Le percentuali che il prompt promuove ad ancore obbligatorie. */
function promptRates(text) {
  return [...extractSourceAnchors(text)]
    .filter((a) => a.startsWith('pct:'))
    .map((a) => Number(a.slice(4)))
    .sort((a, b) => a - b);
}

describe('formatStatsBfsPrompt — estrazione e forma', () => {
  it('estrae una funzione pura, senza toccare Firestore', () => {
    expect(typeof formatStatsBfsPrompt).toBe('function');
    expect(PROMPT).toContain('[ARTICOLO DATI BFS STATISTICA FRONTALIERI TICINO]');
  });

  it('rifiuta un documento senza serie storica invece di produrre un prompt vuoto', () => {
    let threw = '';
    try {
      formatStatsBfsPrompt('2026-Q2', { trend: [] });
    } catch (e) {
      threw = String(e.message);
    }
    expect(threw).toContain('Empty trend');
  });

  it('porta i totali del trimestre e del confronto', () => {
    expect(PROMPT).toContain('79.121');   // 2026-Q2
    expect(PROMPT).toContain('78.616');   // 2026-Q1, QoQ
    expect(PROMPT).toContain('79.578');   // 2025-Q2, YoY
  });
});

describe('nessuna ancora percentuale impossibile', () => {
  // Il cuore della regressione: `0,3%` veniva da un'istruzione, non da un dato.
  it('non promuove la soglia editoriale ±0,3% ad ancora obbligatoria', () => {
    expect(promptRates(PROMPT)).not.toContain(0.3);
  });

  it('non nomina più una soglia numerica: la direzione arriva già decisa', () => {
    expect(PROMPT).not.toMatch(/0[.,]3\s*%/);
    expect(PROMPT).toContain('in crescita');   // QoQ +0,64% sui dati veri
  });

  it('ogni percentuale del prompt corrisponde a un dato del documento', () => {
    // QoQ (79.121 vs 78.616), YoY (79.121 vs 79.578) e lo split di genere.
    // Qualunque altra è un'istruzione travestita da fatto.
    expect(promptRates(PROMPT)).toEqual([0.57, 0.64, 38.4, 61.6]);
  });
});

describe('forma decimale accreditata dal fact-checker', () => {
  it('scrive le percentuali con la virgola, la sola forma che il gate credita', () => {
    expect(PROMPT).toContain('+0,64%');
    expect(PROMPT).toContain('-0,57%');
    expect(PROMPT).toContain('61,6%');
    expect(PROMPT).toContain('38,4%');
  });

  it('nessuna percentuale col punto decimale sopravvive nel prompt', () => {
    expect(PROMPT).not.toMatch(/\d\.\d+\s*%/);
  });

  it('ogni ancora è già scritta nel prompt nella forma che il gate cercherà', () => {
    // renderAnchorForPrompt() è ciò che le remediation citano al writer:
    // se la fonte non contiene quella stringa, l'istruzione chiede una cosa
    // che il prompt stesso non mostra.
    for (const anchor of extractSourceAnchors(PROMPT)) {
      if (!anchor.startsWith('pct:')) continue;
      expect(PROMPT).toContain(renderAnchorForPrompt(anchor));
    }
  });
});

describe('istruzioni che il writer deve poter eseguire', () => {
  it('elenca alla lettera le percentuali obbligatorie', () => {
    const required = PROMPT.match(/^OBBLIGATORIO[^\n]*/m);
    expect(required).toBeTruthy();
    for (const rate of ['+0,64%', '-0,57%', '61,6%', '38,4%']) {
      expect(required[0]).toContain(rate);
    }
  });

  it('vieta esplicitamente le cifre per comune, che il dataset non ha', () => {
    // L'articolo 2026-Q1 pubblicato ne conteneva per Lugano, Chiasso e
    // Mendrisio: inventate, e uscite agli iscritti.
    expect(PROMPT).toContain('Lugano');
    expect(PROMPT).toContain('Chiasso');
    expect(PROMPT).toMatch(/NON scrivere cifre riferite a/);
  });

  it('non invita più a inferire i settori dalla serie storica', () => {
    expect(PROMPT).not.toMatch(/settori se inferibili/);
  });

  /**
   * Il gate sulla lunghezza è la seconda metà dello stallo del 2026-Q2: tre
   * tentativi su sei avevano superato TUTTI i controlli di fedeltà e sono stati
   * scartati a 194-297 parole contro un minimo adattivo di 700. Il prompt non
   * diceva quanto scrivere, e la REGOLA EDITORIALE generica dice l'opposto
   * («meglio un articolo da 400 parole onesto»).
   */
  it('dichiara il target di lunghezza e nomina il materiale che lo riempie', () => {
    const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');
    const declared = src.match(/^\s*const MIN_STATS_BFS_IT_WORDS = (\d+);$/m);
    expect(declared).toBeTruthy();
    expect(PROMPT).toContain(`superare complessivamente le ${declared[1]} parole`);
    // Il materiale citato deve esistere davvero nel prompt, altrimenti
    // l'istruzione chiede di commentare qualcosa che il writer non ha.
    expect(PROMPT).toContain('=== SERIE STORICA');
    expect(PROMPT).toContain('=== DISTRIBUZIONE PER ETÀ');
    expect(PROMPT).toContain('=== RIPARTIZIONE PER GENERE');
  });

  it('il target chiesto sta SOPRA la soglia che il gate applica (drift guard)', () => {
    const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');
    const declared = Number(src.match(/^\s*const MIN_STATS_BFS_IT_WORDS = (\d+);$/m)[1]);
    // Il gate su questa fonte è il pavimento della scala adattiva: `stats-bfs`
    // azzera la lunghezza passata alle due companion (`lengthBudgetSource`),
    // quindi computeAdaptiveMinWords restituisce il floor. Chiedere ESATTAMENTE
    // il minimo significherebbe giocarsi ogni trimestre sul filo; chiedere meno
    // significherebbe istruire il writer a fallire.
    const floor = Number(src.match(/CREATE_ARTICLE_MIN_IT_WORDS_FLOOR \|\| '(\d+)'/)[1]);
    expect(declared).toBeGreaterThan(floor);
  });
});

/**
 * L'ultimo passo prima della registrazione, e l'unico senza rete.
 *
 * `expandShortItalianContent` gira DOPO i gate deterministici e dopo il
 * fact-check LLM, e il suo output fa `break` senza ripassare da nessuno dei
 * due. Il suo prompt chiedeva alla lettera «riferimenti a comuni ticinesi
 * specifici» e «normative con date e importi»: su una fonte che è un dataset
 * chiuso di venti numeri, quella richiesta non può che essere soddisfatta dal
 * training del modello. `frontalieri-ticino-stabili-2026-q1` ne è la prova
 * pubblicata (cifre per Lugano, Chiasso, Mendrisio, aliquote, premi LAMal:
 * nessuna in `config/bfs_stats`).
 */
describe('expandEnrichmentLine — la variante legata al testo', () => {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');
  const expandEnrichmentLine = new Function(
    sliceFn(src, 'function expandEnrichmentLine(isFrontaliere, boundToText = false) {')
    + '\nreturn expandEnrichmentLine;',
  )();

  it('di default resta quella storica, per gli articoli con una fonte vera', () => {
    expect(expandEnrichmentLine(true)).toContain('riferimenti a comuni ticinesi specifici');
    expect(expandEnrichmentLine(false)).toContain('cantoni o città svizzere');
  });

  it('legata al testo, non chiede più comuni né importi', () => {
    const bound = expandEnrichmentLine(true, true);
    expect(bound).not.toContain('comuni ticinesi specifici');
    expect(bound).not.toContain('normative con date e importi');
    expect(bound).toMatch(/NON introdurre NESSUN numero, comune, aliquota, importo, data o percentuale/);
  });

  it('è la variante che stats-bfs riceve al passo di espansione', () => {
    expect(src).toContain('expandShortItalianContent(data, adaptiveMinWords, { boundToText: isStatsBfsSource })');
    // Un solo punto di costruzione: se il prompt tornasse a incorporare la
    // riga, questo test smetterebbe di misurare ciò che finisce nel prompt.
    expect(src).toContain('${expandEnrichmentLine(IS_FRONTALIERE, boundToText)}');
  });
});

/**
 * La lunghezza che le scale adattive misurano.
 *
 * `computeAdaptiveMinWords` e `computeAdaptiveMinChars` sono companion
 * dichiarate («Mirrors the word-ladder thresholds»): scavalcarne una sola
 * ricrea il caso che il commento della seconda descrive — un run adattivo da
 * 400 parole (~2400 char) che inciampa nel floor statico da 2500 e viene o
 * ri-espanso in allucinazione o rifiutato al guard finale. Questo blocco pinna
 * che l'override passa dalla LUNGHEZZA, una sola, e non dalle due scale.
 */
describe('lengthBudgetSource — le due scale restano appaiate', () => {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');

  it('azzera la lunghezza per stats-bfs invece di ramificare ogni scala', () => {
    expect(src).toMatch(/const isStatsBfsSource = String\(url \|\| ''\)\.startsWith\('stats-bfs:\/\/'\)/);
    expect(src).toMatch(/const lengthBudgetSource = isStatsBfsSource \? '' : pageContent;/);
  });

  it('nessuna delle due scale legge più pageContent direttamente', () => {
    // Il difetto sarebbe silenzioso: la soglia sulle parole scende, quella sui
    // caratteri no, e l'articolo conforme viene bocciato dal guard finale.
    expect(src).not.toContain('computeAdaptiveMinWords(pageContent)');
    expect(src).not.toContain('computeAdaptiveMinChars(pageContent)');
    expect(src).toContain('computeAdaptiveMinWords(lengthBudgetSource)');
    expect(src).toContain('computeAdaptiveMinChars(lengthBudgetSource)');
  });

  it('con lunghezza vuota entrambe le scale cadono sul proprio pavimento', () => {
    const words = new Function(sliceFn(src, 'function computeAdaptiveMinWords(sourceText) {')
      + `\nconst CREATE_ARTICLE_MIN_IT_WORDS = ${src.match(/CREATE_ARTICLE_MIN_IT_WORDS \|\| '(\d+)'/)[1]};`
      + `\nconst CREATE_ARTICLE_MIN_IT_WORDS_FLOOR = ${src.match(/CREATE_ARTICLE_MIN_IT_WORDS_FLOOR \|\| '(\d+)'/)[1]};`
      + '\nreturn computeAdaptiveMinWords;')();
    const chars = new Function(sliceFn(src, 'function computeAdaptiveMinChars(sourceText) {')
      + `\nconst MIN_BODY_CHARS = ${src.match(/^const MIN_BODY_CHARS = (\d+);/m)[1]};`
      + `\nconst MIN_BODY_CHARS_FLOOR = ${src.match(/MIN_BODY_CHARS_FLOOR \|\| '(\d+)'/)[1]};`
      + '\nreturn computeAdaptiveMinChars;')();
    expect(words('')).toBe(400);
    expect(chars('')).toBe(1800);
    // ~6 char/parola: le due soglie devono restare compatibili fra loro,
    // altrimenti una passa e l'altra boccia lo stesso articolo.
    expect(chars('')).toBeLessThan(words('') * 6);
  });
});

/**
 * follow-up(#164): un `g.pct` mancante o mal formattato non deve promuovere
 * un'ancora `pct:NaN` — la stessa classe di ancora impossibile che questo file
 * pinna sopra per la soglia editoriale ±0,3%, qui per il caso specifico del
 * genere. `String(g.pct).replace('.', ',')` senza validazione trasformava
 * "12.3.4" in "12,3.4%": testo che matcha ancora il pattern digit-led di
 * `extractSourceAnchors` ma che `parseItalianNumber` non sa risolvere.
 */
describe('genderPct — pct mancante o non numerico non genera un\'ancora impossibile', () => {
  const BROKEN_GENDER = {
    ...BFS_2026_Q2,
    genderSnapshot: [
      { name: 'Uomini', value: 48700, pct: '12.3.4' },
      { name: 'Donne', value: 30420 },
    ],
  };
  const brokenPrompt = formatStatsBfsPrompt('2026-Q2', BROKEN_GENDER);

  it('non promuove pct:NaN ad ancora obbligatoria', () => {
    expect([...extractSourceAnchors(brokenPrompt)]).not.toContain('pct:NaN');
  });

  it('non scrive "NaN%" né la stringa rotta nel prompt', () => {
    expect(brokenPrompt).not.toMatch(/NaN/);
    expect(brokenPrompt).not.toContain('12,3.4%');
  });

  it('mantiene comunque il valore assoluto del genere', () => {
    expect(brokenPrompt).toContain('Uomini (48.700)');
    expect(brokenPrompt).toContain('Donne (30.420)');
  });

  // `Number('')`, `Number('   ')` e `Number([])` valgono tutti 0 in JS, e
  // `Number.isFinite(0)` e' true: senza un guard esplicito su stringa vuota,
  // questi input pubblicano uno "0%" fabbricato — indistinguibile da uno zero
  // legittimo — invece di omettere la percentuale come per un pct assente.
  const EMPTY_GENDER = {
    ...BFS_2026_Q2,
    genderSnapshot: [
      { name: 'Uomini', value: 48700, pct: '' },
      { name: 'Donne', value: 30420, pct: '   ' },
    ],
  };
  const emptyPrompt = formatStatsBfsPrompt('2026-Q2', EMPTY_GENDER);

  it('pct stringa vuota o solo spazi non fabbrica uno 0% falso', () => {
    expect(emptyPrompt).not.toContain('Uomini 0%');
    expect(emptyPrompt).not.toContain('Donne 0%');
    expect(emptyPrompt).toContain('Uomini (48.700)');
    expect(emptyPrompt).toContain('Donne (30.420)');
  });
});

describe('buildStatsBfsPromptContent resta solo I/O', () => {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');
  const io = sliceFn(src, 'async function buildStatsBfsPromptContent(quarter) {');

  it('delega la formattazione alla funzione pura', () => {
    expect(io).toContain('formatStatsBfsPrompt(quarter,');
  });

  it('non costruisce più testo di prompt da sé', () => {
    // Se una riga di prompt torna qui dentro, torna anche fuori dal test.
    expect(io).not.toContain('=== DATI VERIFICATI');
  });
});

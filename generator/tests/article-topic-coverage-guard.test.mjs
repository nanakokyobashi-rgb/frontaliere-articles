/**
 * Gate «argomento già coperto» — lib/topic-coverage-guard.mjs
 *
 * corpus-only: non c'è un gemello sul sito. La guardia nasce da un difetto
 * osservato sul corpus pubblicato e il file che la ospita non è nel
 * loop-sync-manifest.
 *
 * La suite prova TRE cose, e la terza è quella che di solito manca:
 *
 *  1. il vero positivo, con i dati reali della coppia piastrellista del
 *     2026-08-09 (titoli e id verbatim da content/blog-meta-it.ts, date
 *     verbatim da content/blog-articles-data.ts);
 *  2. che i gate PRE-ESISTENTI non la vedevano — replicando le loro soglie di
 *     produzione, così il test dice PERCHÉ serviva un gate nuovo invece di
 *     ritarare quelli vecchi;
 *  3. l'assenza di falsi positivi sulle serie legittime, letta DAL CORPUS
 *     REALE del checkout e non da fixture scelte a mano: le serie per comune
 *     (`trasferirsi-a-…`, `vivere-…`) e i `bollettino-frontaliere-<data>`. Una
 *     fixture dimostra che il caso che ho immaginato passa; il corpus dimostra
 *     che passano quelli che non ho immaginato.
 */
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { expect } from './lib/expect-shim.mjs';
import {
  assertTopicNotRecentlyCovered,
  findRecentTopicCoverage,
  hasProfessionGuideIntent,
  professionTopicKey,
  topicCoverageKey,
} from '../scripts/lib/topic-coverage-guard.mjs';
import {
  jaccardSim,
  normalizeItWord,
  STOP_WORDS_IT,
} from '../scripts/lib/it-text-similarity.mjs';
import { computeAdaptiveEvergreenThresholds } from '../scripts/lib/scoring/constants.mjs';

const corpusUrl = (rel) => new URL(`../../content/${rel}`, import.meta.url);

// ── I tre piastrellista reali (2026-08-09), verbatim dal corpus ────────────

const PIASTRELLISTA_A = {
  id: 'frontaliere-piastrellista-ticino-stipendio-requisiti',
  title: 'Lavorare come piastrellista in Ticino: stipendio, requisiti e riconoscimento del titolo',
  excerpt: "I requisiti e il stipendio medio per i piastrellisti in Ticino da frontaliere, con informazioni sull'eventuale riconoscimento del titolo di studio e sul permesso G.",
  date: '2026-08-09T15:44:33.669Z',
};

const PIASTRELLISTA_B = {
  id: 'lavoro-piastrellista-ticino-frontaliere',
  title: 'Lavorare come piastrellista in Ticino: guida per frontalieri',
  excerpt: 'Requisiti, inquadramento salariale e fiscalità per i frontalieri che operano nel settore della posa piastrelle in Canton Ticino.',
  date: '2026-08-09T16:08:00.001Z',
};

const PIASTRELLISTA_C = {
  id: 'piastrellista-frontaliere-ticino-guadagno',
  title: 'Quanto guadagna un piastrellista frontaliere in Ticino?',
  excerpt: "I piastrellisti frontaliere in Ticino possono guadagnare tra i CHF 50.000 e i CHF 80.000 all'anno, ma le differenze di retribuzione possono variare a seconda della esperienza e della posizione lavorativa.",
  date: '2026-08-09T11:30:03.000Z',
};

const AT_B_PUBLISH = Date.parse(PIASTRELLISTA_B.date);

describe('gate argomento-già-coperto — il caso piastrellista (2026-08-09)', () => {
  it('marca B come già coperto da A, pubblicato 24 minuti prima', () => {
    const hit = findRecentTopicCoverage(PIASTRELLISTA_B, [PIASTRELLISTA_A], { now: AT_B_PUBLISH });
    expect(hit).not.toBe(null);
    expect(hit.professionId).toBe('piastrellista');
    expect(hit.existingId).toBe(PIASTRELLISTA_A.id);
    // 24 minuti = 0,0167 giorni.
    expect(hit.ageDays).toBeLessThan(0.02);
  });

  it('marca anche A contro C, la terza guida dello stesso giorno (11:30)', () => {
    const hit = findRecentTopicCoverage(PIASTRELLISTA_A, [PIASTRELLISTA_C], {
      now: Date.parse(PIASTRELLISTA_A.date),
    });
    expect(hit).not.toBe(null);
    expect(hit.professionId).toBe('piastrellista');
    expect(hit.existingId).toBe(PIASTRELLISTA_C.id);
  });

  it('assertTopicNotRecentlyCovered BLOCCA la pubblicazione di B', () => {
    const data = { id: PIASTRELLISTA_B.id, content: { it: { title: PIASTRELLISTA_B.title } } };
    let thrown = null;
    try {
      assertTopicNotRecentlyCovered(data, [PIASTRELLISTA_A], { now: AT_B_PUBLISH, log: () => {} });
    } catch (err) { thrown = err; }
    expect(thrown).not.toBe(null);
    expect(thrown.message).toContain('ARGOMENTO GIÀ COPERTO');
    expect(thrown.message).toContain('piastrellista');
    expect(thrown.message).toContain(PIASTRELLISTA_A.id);
    // qualityReject: il selettore salta il candidato invece di abortire la run.
    expect(thrown.qualityReject).toBe(true);
  });

  it('un articolo non è duplicato di se stesso (ripubblicazione)', () => {
    expect(findRecentTopicCoverage(PIASTRELLISTA_A, [PIASTRELLISTA_A], { now: AT_B_PUBLISH })).toBe(null);
  });

  it('fuori finestra non marca: la stessa coppia a 120 giorni di distanza passa', () => {
    const hit = findRecentTopicCoverage(PIASTRELLISTA_B, [PIASTRELLISTA_A], {
      now: AT_B_PUBLISH + 120 * 86_400_000,
      windowDays: 90,
    });
    expect(hit).toBe(null);
  });

  it('un esistente senza data è ignorato (fail-open), non trattato come recente', () => {
    const undated = { ...PIASTRELLISTA_A, date: null };
    expect(findRecentTopicCoverage(PIASTRELLISTA_B, [undated], { now: AT_B_PUBLISH })).toBe(null);
  });
});

// ── Perché serviva un gate NUOVO: i vecchi non la vedono ──────────────────

describe('i gate lessicali pre-esistenti non catturano la coppia', () => {
  // Replica della parte pura di checkForDuplicates (create-article.mjs), con
  // le soglie di produzione. Stessa replica usata da
  // article-duplicate-detection.test.mjs.
  const significant = (text) => text.toLowerCase()
    .replace(/[^a-zàáèéìíòóùú0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS_IT.has(w))
    .map((w) => normalizeItWord(w));
  const entities = (text) => {
    const out = new Set();
    for (const m of String(text || '').matchAll(/\d[\d.'',]*\d/g)) out.add(m[0].replace(/[.''',]/g, ''));
    for (const m of String(text || '').matchAll(/\b(\d+)[.,]?(\d*)\s*%/g)) out.add(`${m[1]}${m[2]}%`);
    return [...out];
  };
  const idWords = (id) => id.split('-').filter((w) => w.length > 1).map((w) => normalizeItWord(w));

  function lexicalCheck(a, b, corpusSize = 3794) {
    const idSim = jaccardSim(idWords(a.id), idWords(b.id));
    const titleSim = jaccardSim(significant(a.title), significant(b.title));
    const excerptSim = jaccardSim(significant(a.excerpt), significant(b.excerpt));
    const entitySim = jaccardSim(entities(`${a.title} ${a.excerpt}`), entities(`${b.title} ${b.excerpt}`));
    const combined = 0.25 * idSim + 0.30 * titleSim + 0.25 * excerptSim + 0.20 * entitySim;
    const TITLE = computeAdaptiveEvergreenThresholds(corpusSize).titleJaccard;
    const isDuplicate = (idSim >= 0.72 && titleSim >= 0.40)
      || titleSim >= TITLE
      || (excerptSim >= 0.62 && entitySim >= 0.20)
      || (entitySim >= 0.65 && combined >= 0.45)
      || combined >= 0.55;
    return { isDuplicate, idSim, titleSim, excerptSim, entitySim, combined };
  }

  it('checkForDuplicates dice NON duplicato — combinato 0,278 contro soglia 0,55', () => {
    const r = lexicalCheck(PIASTRELLISTA_B, PIASTRELLISTA_A);
    expect(r.isDuplicate).toBe(false);
    expect(r.combined).toBeLessThan(0.30);
    // Il titolo è il segnale più forte e vale un terzo della soglia: non è un
    // problema di tuning, è che Jaccard misura l'insieme INTERO e le due
    // inquadrature divergono mentre l'argomento resta identico.
    expect(r.titleSim).toBeLessThan(0.40);
    expect(computeAdaptiveEvergreenThresholds(3794).titleJaccard).toBeGreaterThan(0.80);
  });

  it('il gate nuovo la cattura sugli stessi identici dati', () => {
    expect(findRecentTopicCoverage(PIASTRELLISTA_B, [PIASTRELLISTA_A], { now: AT_B_PUBLISH })).not.toBe(null);
  });
});

// ── Estrazione della chiave: stem esatto, non prefisso ────────────────────

describe('professionTopicKey — stem esatto, senza tolleranza al prefisso', () => {
  it('riconosce il mestiere dal titolo', () => {
    expect(professionTopicKey('Lavorare come piastrellista in Ticino')).toBe('piastrellista');
    expect(professionTopicKey('Quanto guadagna un idraulico frontaliere')).toBe('idraulico');
  });

  it('NON confonde «cassa malati» con il cassiere (matchProfession invece sì)', () => {
    expect(professionTopicKey('Cassa malati, la franchigia minima potrebbe salire')).toBe(null);
  });

  it('«Corriere del Ticino» AGGANCIA il mestiere: è l\'intento-guida a salvarlo', () => {
    // Asserito com'è, non come vorrei che fosse. `corriere` è un alias di una
    // parola sola che è anche il nome di un quotidiano, e nessuna stemmatura
    // può distinguerli. È esattamente il motivo per cui topicCoverageKey è una
    // CONGIUNZIONE: presa da sola la chiave-mestiere marcherebbe la rassegna
    // stampa. Se un domani si togliesse il requisito di intento, questo test
    // dice quale porta si sta aprendo.
    expect(professionTopicKey('Corriere del Ticino: la rassegna di oggi')).toBe('corriere');
    expect(topicCoverageKey({
      id: 'rassegna-corriere-del-ticino',
      title: 'Corriere del Ticino: la rassegna di oggi',
    })).toBe(null);
  });

  it('«cassa malati» resta fuori anche dalla sola chiave-mestiere', () => {
    // Questo invece è il guadagno netto dello stem esatto: matchProfession,
    // con la sua tolleranza al prefisso di digitazione, aggancia `cassiere`
    // su «cassa» e da solo produceva 8.275 coppie in 7 giorni.
    expect(professionTopicKey('Cassa malati, la franchigia minima potrebbe salire')).toBe(null);
  });

  it('l\'intento da guida non basta senza un mestiere', () => {
    expect(topicCoverageKey({ id: 'stipendi-ticino-2026', title: 'Stipendi in Ticino: le tabelle 2026' })).toBe(null);
  });

  it('il mestiere non basta senza intento da guida', () => {
    expect(hasProfessionGuideIntent('Sciopero degli infermieri all\'ospedale di Lugano')).toBe(false);
    expect(topicCoverageKey({
      id: 'sciopero-infermieri-lugano',
      title: 'Sciopero degli infermieri all\'ospedale di Lugano',
    })).toBe(null);
  });
});

// ── Falsi positivi: misurati SUL CORPUS REALE ────────────────────────────

/** Legge id → titolo da un file di meta IT del corpus. */
function loadMetaTitles(rel) {
  const src = readFileSync(corpusUrl(rel), 'utf-8');
  const out = new Map();
  for (const m of src.matchAll(/'blog\.article\.([^.']+)\.title':\s*'((?:[^'\\]|\\.)*)'/g)) {
    out.set(m[1], m[2].replace(/\\'/g, "'"));
  }
  return out;
}

/** Legge id → data da un registro del corpus. */
function loadRegistryDates(rel) {
  const src = readFileSync(corpusUrl(rel), 'utf-8');
  const out = new Map();
  const re = /id:\s*'([^']+)',[\s\S]{0,300}?date:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) if (!out.has(m[1])) out.set(m[1], m[2]);
  return out;
}

const CORPUS = (() => {
  const titles = new Map([...loadMetaTitles('blog-meta-it.ts'), ...loadMetaTitles('blog-meta-ch-it.ts')]);
  const dates = new Map([...loadRegistryDates('blog-articles-data.ts'), ...loadRegistryDates('swiss-articles-data.ts')]);
  return [...titles].map(([id, title]) => ({ id, title, date: dates.get(id) || null }));
})();

describe('nessun falso positivo sulle serie legittime (corpus reale del checkout)', () => {
  it('il corpus si carica — se questo salta, i test sotto non provano niente', () => {
    // Guardia contro il fallimento silenzioso: un regex che smette di
    // agganciare renderebbe VERDI per vacuità tutte le asserzioni seguenti.
    expect(CORPUS.length).toBeGreaterThan(3000);
    expect(CORPUS.filter((a) => a.date).length).toBeGreaterThan(3000);
  });

  const comuneSeries = () => CORPUS.filter((a) => /^(trasferirsi-a-|vivere-)/.test(a.id));
  const bollettini = () => CORPUS.filter((a) => /^bollettino-frontaliere-/.test(a.id));

  it('le serie per comune esistono nel corpus e NESSUNA è marcabile', () => {
    const series = comuneSeries();
    expect(series.length).toBeGreaterThan(10);
    const flagged = series.filter((a) => topicCoverageKey(a) !== null);
    expect(flagged.map((a) => a.id)).toEqual([]);
  });

  it('due comuni consecutivi della stessa serie non si bloccano a vicenda', () => {
    const series = [...comuneSeries()].sort((a, b) => Date.parse(a.date || 0) - Date.parse(b.date || 0));
    expect(series.length).toBeGreaterThan(1);
    // Il caso peggiore: ogni articolo della serie contro TUTTI gli altri,
    // finestra infinita. Se il gate avesse una presa sulla serie, qui esce.
    for (const a of series) {
      expect(findRecentTopicCoverage(a, series, { now: Date.parse(a.date), windowDays: 3650 })).toBe(null);
    }
  });

  it('i bollettini quotidiani non sono mai marcabili', () => {
    const daily = bollettini();
    expect(daily.length).toBeGreaterThan(0);
    for (const b of daily) {
      expect(topicCoverageKey(b)).toBe(null);
      expect(findRecentTopicCoverage(b, daily, { now: Date.parse(b.date), windowDays: 3650 })).toBe(null);
    }
  });

  it('il gate resta selettivo: marca una minoranza netta del corpus', () => {
    const keyed = CORPUS.filter((a) => topicCoverageKey(a) !== null);
    // Misurato il 2026-08-09: 158 guide-mestiere su 3.794 articoli (4,2%).
    // Il tetto al 15% è il ratchet: se un allargamento del criterio (o della
    // tassonomia) facesse esplodere la superficie, questo test lo dice prima
    // che il gate cominci a rifiutare articoli legittimi in produzione.
    expect(keyed.length).toBeGreaterThan(50);
    expect(keyed.length).toBeLessThan(CORPUS.length * 0.15);
  });

  it('la coppia piastrellista è nel corpus e il gate la marca in condizioni reali', () => {
    const b = CORPUS.find((a) => a.id === PIASTRELLISTA_B.id);
    expect(b).not.toBe(undefined);
    const hit = findRecentTopicCoverage(b, CORPUS, { now: Date.parse(b.date) });
    expect(hit).not.toBe(null);
    expect(hit.professionId).toBe('piastrellista');
  });
});

/**
 * Gate «argomento già coperto» — lib/topic-coverage-guard.mjs
 *
 * corpus-only: non c'è un gemello sul sito. La guardia nasce da un difetto
 * osservato sul corpus pubblicato e il file che la ospita non è nel
 * loop-sync-manifest.
 *
 * La suite prova TRE cose, e la terza è quella che di solito manca:
 *
 *  1. il vero positivo, con i dati reali delle coppie del corpus (titoli e id
 *     verbatim da content/blog-meta{,-ch}-it.ts, date verbatim dai registri);
 *  2. che i gate PRE-ESISTENTI non le vedevano — replicando le loro soglie di
 *     produzione, così il test dice PERCHÉ serviva un gate nuovo invece di
 *     ritarare quelli vecchi;
 *  3. l'assenza di falsi positivi, letta DAL CORPUS REALE del checkout e non
 *     da fixture scelte a mano. Una fixture dimostra che il caso che ho
 *     immaginato passa; il corpus dimostra che passano quelli che non ho
 *     immaginato.
 *
 * ── 2026-08-10: un'asserzione di questa suite era SBAGLIATA ────────────────
 *
 * La versione precedente asseriva «le serie per comune esistono nel corpus e
 * NESSUNA è marcabile» come se fosse una proprietà desiderabile. Non lo era:
 * era la conseguenza tautologica del fatto che una chiave-MESTIERE non si
 * attiva su un nome di comune. Nel frattempo il corpus conteneva 33 coppie di
 * guide-comune duplicate entro 90 giorni — `vivere a Besano` due volte a 74
 * minuti di distanza — che quel test dichiarava sane.
 *
 * Le asserzioni qui sotto sono quindi ROVESCIATE di proposito: le serie per
 * comune ORA sono marcabili, e la proprietà che resta da difendere è più
 * stretta — comuni DIVERSI non si bloccano a vicenda, i bollettini quotidiani
 * non sono mai marcabili, e il gate resta una minoranza netta del corpus.
 */
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { expect } from './lib/expect-shim.mjs';
import {
  assertTopicNotRecentlyCovered,
  cantonThemeTopicKey,
  comuneTopicKey,
  findRecentTopicCoverage,
  hasProfessionGuideIntent,
  hasResidenceGuideIntent,
  municipalityNames,
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

/** Comodità: la coppia (kind, value) come stringa, per asserire in una riga. */
const keyOf = (article) => {
  const k = topicCoverageKey(article);
  return k ? `${k.kind}:${k.value}` : null;
};

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
    expect(hit.kind).toBe('profession-guide');
    expect(hit.value).toBe('piastrellista');
    expect(hit.existingId).toBe(PIASTRELLISTA_A.id);
    // 24 minuti = 0,0167 giorni.
    expect(hit.ageDays).toBeLessThan(0.02);
  });

  it('marca anche A contro C, la terza guida dello stesso giorno (11:30)', () => {
    const hit = findRecentTopicCoverage(PIASTRELLISTA_A, [PIASTRELLISTA_C], {
      now: Date.parse(PIASTRELLISTA_A.date),
    });
    expect(hit).not.toBe(null);
    expect(hit.value).toBe('piastrellista');
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
    // Il messaggio nomina la CLASSE di chiave, non più solo il mestiere: da
    // quando le chiavi sono tre, «Mestiere: x» e «Comune: y» sono due diagnosi
    // diverse e il log deve dire quale delle due ha bloccato.
    expect(thrown.message).toContain('Mestiere');
    expect(thrown.message).toContain('profession-guide');
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

// ══════════════════════════════════════════════════════════════════════════
// kind: 'comune-guide' — le coppie reali del 2026-08-10
// ══════════════════════════════════════════════════════════════════════════

/** Verbatim dal corpus: id, titolo e data come pubblicati. */
const TRONZANO_A = {
  id: 'trasferirsi-tronzano-lago-maggiore-frontaliere',
  title: 'trasferirsi a Tronzano Lago Maggiore da frontaliere pro e contro',
  date: '2026-08-10T15:18:13.946Z',
};
const TRONZANO_B = {
  id: 'vivere-tronzano-lago-maggiore-lavorare-ticino-da-frontaliere',
  title: 'Vivere a Tronzano Lago Maggiore e lavorare in Ticino da frontaliere',
  date: '2026-08-10T15:51:42.895Z',
};
const MASLIANICO_A = {
  id: 'vivere-maslianico-lavoro-ticino',
  title: 'Vivere a Maslianico e lavorare in Ticino da frontaliere',
  date: '2026-08-10T00:08:09.823Z',
};
const MASLIANICO_B = {
  id: 'trasferirsi-a-maslianico-da-frontaliere-pro-e-contro',
  title: 'Trasferirsi a Maslianico da frontaliere: pro e contro',
  date: '2026-08-10T00:24:42.396Z',
};
const BESANO_A = {
  id: 'vivere-besano-frontaliere-ticino',
  title: 'Vivere a Besano e lavorare in Ticino da frontaliere',
  date: '2026-08-10T04:52:17.442Z',
};
const BESANO_B = {
  id: 'vivere-besano-lavorare-ticino',
  title: 'Vivere a Besano e lavorare in Ticino: guida pratica',
  date: '2026-08-10T06:06:17.297Z',
};
const BESANO_C = {
  id: 'trasferirsi-besano-da-frontaliere',
  title: 'Trasferirsi a Besano da frontaliere: pro e contro',
  date: '2026-08-10T06:18:56.946Z',
};

describe('gate argomento-già-coperto — le coppie per comune (2026-08-10)', () => {
  it('Tronzano Lago Maggiore: la seconda a 33 minuti dalla prima è già coperta', () => {
    const hit = findRecentTopicCoverage(TRONZANO_B, [TRONZANO_A], { now: Date.parse(TRONZANO_B.date) });
    expect(hit).not.toBe(null);
    expect(hit.kind).toBe('comune-guide');
    expect(hit.value).toBe('tronzano-lago-maggiore');
    expect(hit.existingId).toBe(TRONZANO_A.id);
    expect(hit.ageDays).toBeLessThan(0.03);
  });

  it('il nome di più parole vuole la sequenza COMPLETA, non il primo token', () => {
    // Se bastasse `tronzano`, «Maccagno con Pino e Veddasca» si aggancerebbe
    // su `maccagno` e «San Fermo della Battaglia» su `san` — cioè su decine di
    // comuni diversi. Qui il valore è lo slug del nome intero.
    expect(comuneTopicKey('Vivere a Maccagno con Pino e Veddasca e lavorare in Ticino'))
      .toBe('maccagno-con-pino-e-veddasca');
    expect(comuneTopicKey('Tronzano Lago Maggiore')).toBe('tronzano-lago-maggiore');
  });

  it('Maslianico: vivere/trasferirsi a 16 minuti di distanza', () => {
    const hit = findRecentTopicCoverage(MASLIANICO_B, [MASLIANICO_A], { now: Date.parse(MASLIANICO_B.date) });
    expect(hit).not.toBe(null);
    expect(hit.value).toBe('maslianico');
    expect(hit.existingId).toBe(MASLIANICO_A.id);
  });

  it('Besano: DUE «vivere a Besano» a 74 minuti — la chiave è l\'intento, non il verbo', () => {
    // Il caso che dice come dev'essere fatta la chiave. A e B non sono la
    // coppia vivere/trasferirsi del pool: sono due «Vivere a Besano e lavorare
    // in Ticino». Una chiave «comune + verbo» li lascerebbe passare entrambi.
    const hit = findRecentTopicCoverage(BESANO_B, [BESANO_A], { now: Date.parse(BESANO_B.date) });
    expect(hit).not.toBe(null);
    expect(hit.value).toBe('besano');
    expect(hit.existingId).toBe(BESANO_A.id);
    // E il terzo, 12 minuti dopo il secondo, prende il PIÙ VICINO dei due.
    const third = findRecentTopicCoverage(BESANO_C, [BESANO_A, BESANO_B], { now: Date.parse(BESANO_C.date) });
    expect(third).not.toBe(null);
    expect(third.existingId).toBe(BESANO_B.id);
  });

  it('assertTopicNotRecentlyCovered BLOCCA la seconda guida-comune, e lo dice', () => {
    const data = { id: TRONZANO_B.id, content: { it: { title: TRONZANO_B.title } } };
    let thrown = null;
    try {
      assertTopicNotRecentlyCovered(data, [TRONZANO_A], { now: Date.parse(TRONZANO_B.date), log: () => {} });
    } catch (err) { thrown = err; }
    expect(thrown).not.toBe(null);
    expect(thrown.message).toContain('ARGOMENTO GIÀ COPERTO');
    expect(thrown.message).toContain('Comune');
    expect(thrown.message).toContain('tronzano-lago-maggiore');
    expect(thrown.message).toContain(TRONZANO_A.id);
    expect(thrown.qualityReject).toBe(true);
  });

  it('comuni DIVERSI non si bloccano a vicenda — è la serie a restare possibile', () => {
    // Questa è la proprietà che sostituisce «0/25 marcabili»: il pool per
    // comune deve poter continuare a girare, un comune dopo l'altro.
    expect(findRecentTopicCoverage(TRONZANO_A, [MASLIANICO_A, BESANO_A], { now: Date.parse(TRONZANO_A.date) })).toBe(null);
    expect(findRecentTopicCoverage(BESANO_A, [TRONZANO_A, MASLIANICO_B], { now: Date.parse(BESANO_A.date) })).toBe(null);
  });

  it('lo stesso comune OLTRE la finestra passa: l\'aggiornamento annuale resta legittimo', () => {
    const hit = findRecentTopicCoverage(TRONZANO_B, [TRONZANO_A], {
      now: Date.parse(TRONZANO_A.date) + 120 * 86_400_000,
      windowDays: 90,
    });
    expect(hit).toBe(null);
  });

  it('il comune non basta senza intento di residenza (cronaca)', () => {
    // I tre falsi positivi che `pendolarism` produceva, verbatim dal corpus.
    expect(keyOf({
      id: 'pendolarismo-fatale-frontaliere-porlezza',
      title: 'Tragedia a Porlezza: muore giovane frontaliere',
    })).toBe(null);
    expect(keyOf({
      id: 'carnago-forza-italia-pendolarismo',
      title: "Carnago: Fratelli d'Italia attacca il pendolarismo di Forza Italia",
    })).toBe(null);
    expect(keyOf({
      id: 'bicicletta-insubria-varese-2026',
      title: "Pendolarismo sostenibile in bici all'Insubria",
    })).toBe(null);
  });

  it('l\'intento di residenza non basta senza un comune', () => {
    expect(hasResidenceGuideIntent('Trasferirsi in Svizzera: cosa cambia per il permesso B')).toBe(true);
    expect(keyOf({
      id: 'trasferirsi-in-svizzera-permesso-b',
      title: 'Trasferirsi in Svizzera: cosa cambia per il permesso B',
    })).toBe(null);
  });

  it('i nomi di comune che sono parole comuni restano fuori (misurati sul corpus)', () => {
    // `mese` è un comune della Valchiavenna, e nel corpus compare 12 volte su
    // 12 come «al mese». Senza AMBIGUOUS_COMUNE_TOKENS questa frase sarebbe
    // una guida-comune su Mese.
    expect(comuneTopicKey('Trasferirsi in Ticino: quanto si guadagna al mese')).toBe(null);
    expect(comuneTopicKey('Vivere in Italia con il dazio doganale')).toBe(null);
    expect(comuneTopicKey("Trasferirsi vicino all'erba sintetica")).toBe(null);
  });

  it('l\'elenco dei comuni si carica davvero — senza, i test sopra sono vacui', () => {
    // Il file è TypeScript e viene letto come TESTO: se il regex smettesse di
    // agganciare, `comuneTopicKey` tornerebbe sempre null e metà di questa
    // suite passerebbe per vacuità.
    const names = municipalityNames();
    expect(names.length).toBeGreaterThan(500);
    expect(names).toContain('Tronzano Lago Maggiore');
    expect(names).toContain('Maccagno con Pino e Veddasca');
    expect(names).toContain("Campione d'Italia");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// kind: 'canton-theme' — la sezione svizzera (pilastro × cantone)
// ══════════════════════════════════════════════════════════════════════════

const LPP_BERN_A = {
  id: 'secondo-pilastro-lpp-svizzera-guida-2026-bern',
  title: 'Guida LPP: contributi, prelievo e pianificazione previdenziale in Svizzera',
  date: '2026-08-09T23:51:38.781Z',
};
const LPP_BERN_B = {
  id: 'secondo-pilastro-lpp-bern-2026-guida',
  title: 'Guida al secondo pilastro LPP in Svizzera',
  date: '2026-08-10T00:03:58.093Z',
};
const LAMAL_GINEVRA = {
  id: 'premi-lamal-2026-ginevra-guida',
  title: 'Premi LAMal 2026 a Ginevra: franchigia, cambio cassa e sussidi',
  date: '2026-08-07T20:56:09.960Z',
};
const LAMAL_BERNA = {
  id: 'premi-cassa-malati-lamal-2026-cantone-bern',
  title: 'LAMal nel Cantone Berna: guida ai premi e sussidi',
  date: '2026-08-09T23:13:30.885Z',
};

describe('gate argomento-già-coperto — (pilastro tematico × cantone)', () => {
  it('stesso pilastro E stesso cantone a 12 minuti: duplicato', () => {
    const hit = findRecentTopicCoverage(LPP_BERN_B, [LPP_BERN_A], { now: Date.parse(LPP_BERN_B.date) });
    expect(hit).not.toBe(null);
    expect(hit.kind).toBe('canton-theme');
    expect(hit.value).toBe('lpp:berna');
    expect(hit.existingId).toBe(LPP_BERN_A.id);
  });

  it('«bern» e «Berna» sono lo stesso cantone: la normalizzazione se le mangia', () => {
    expect(cantonThemeTopicKey('Guida al secondo pilastro LPP nel canton Bern')).toBe('lpp:berna');
    expect(cantonThemeTopicKey('Guida al secondo pilastro LPP nel Cantone Berna')).toBe('lpp:berna');
  });

  it('«svizzera» e «svizzero» non fanno due articoli diversi', () => {
    const a = 'Terzo pilastro 3a svizzera: vantaggi 2026 canton Basilea';
    const b = 'Terzo Pilastro 3a svizzero: vantaggi canton Basilea';
    expect(cantonThemeTopicKey(a)).toBe('terzo-pilastro:basilea');
    expect(cantonThemeTopicKey(b)).toBe('terzo-pilastro:basilea');
  });

  it('stesso pilastro ma cantoni DIVERSI: legittimi, il pool li genera apposta', () => {
    expect(keyOf(LAMAL_GINEVRA)).toBe('canton-theme:lamal-premi:ginevra');
    expect(keyOf(LAMAL_BERNA)).toBe('canton-theme:lamal-premi:berna');
    expect(findRecentTopicCoverage(LAMAL_BERNA, [LAMAL_GINEVRA], { now: Date.parse(LAMAL_BERNA.date) })).toBe(null);
  });

  it('un evergreen del pool senza intento-guida esplicito resta NON marcato', () => {
    // Verbatim dal corpus, e asserito com'è: la congiunzione a tre braccia
    // costa dei falsi NEGATIVI, e questo è uno. Su un gate che RIFIUTA
    // articoli è il verso giusto in cui sbagliare — l'alternativa misurata
    // (togliere il braccio intento-guida) faceva marcare la cronaca.
    expect(keyOf({
      id: 'premi-cassa-malati-lamal-2026-canton-zurigo',
      title: 'I premi cassa malati LAMal nel Canton Zurigo per il 2026',
    })).toBe(null);
  });

  it('l\'articolo nazionale non collide con la variante cantonale', () => {
    // Due target SERP diversi, e il pool emette entrambi per costruzione: la
    // base senza cantone e le otto varianti.
    const nazionale = {
      id: 'affitti-svizzera-mercato-immobiliare-2026',
      title: 'Mercato degli affitti in Svizzera: prezzi e diritti',
      date: '2026-08-10T00:58:10.142Z',
    };
    const sanGallo = {
      id: 'affitti-svizzera-mercato-immobiliare-2026-canton-san-gallo',
      title: 'Affitti in Svizzera 2026: prezzi e diritti',
      date: '2026-08-10T01:28:26.231Z',
    };
    expect(findRecentTopicCoverage(sanGallo, [nazionale], { now: Date.parse(sanGallo.date) })).toBe(null);
  });

  it('più cantoni nominati = confronto, non focus: nessuna chiave', () => {
    // Verbatim dal corpus. Prima della regola del cantone unico questo veniva
    // accoppiato alla guida-Ginevra del pool, solo perché `ginevra` era il
    // primo alias a combaciare.
    expect(keyOf({
      id: 'confronto-imposta-cantonale-svizzera-cantoni',
      title: 'Zugo e Svitto, meno costosi di Ginevra e Vaud',
    })).toBe(null);
  });

  it('la cronaca cantonale non marca l\'evergreen del pool', () => {
    // Senza il requisito di intento-guida, questa notizia (2026-06-08)
    // bloccava `premi-cassa-malati-lamal-2026-canton-zurigo` (2026-08-09).
    expect(keyOf({
      id: 'voto-zurigo-alloggi-cassa-malati',
      title: 'Voto Zurigo: alloggi e premi cassa malati',
    })).toBe(null);
  });

  it('la sigla LPP da sola non è il pilastro: serve «secondo pilastro»', () => {
    expect(keyOf({
      id: 'guida-contributi-sociali-svizzera',
      title: 'Contributi busta paga Svizzera 2026: AVS, LPP e trattenute spiegate',
    })).toBe(null);
    expect(cantonThemeTopicKey('Guida al secondo pilastro in Svizzera')).toBe('lpp:svizzera');
  });

  it('senza né cantone né «svizzera» non c\'è chiave nazionale', () => {
    // È ciò che tiene la chiave nazionale dal diventare il cestino di ogni
    // articolo della sezione frontaliere che sfiora un tema svizzero.
    expect(cantonThemeTopicKey('Guida al costo della vita a Milano')).toBe(null);
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

  it('nemmeno sulla coppia-comune: il titolo è quasi disgiunto, l\'argomento identico', () => {
    // Stessa forma, misurata sui titoli reali di Tronzano. Il gate lessicale
    // ha bisogno di 0,81 di Jaccard sul titolo (soglia adattiva a 3.800
    // articoli) e ne trova una frazione.
    const a = { ...TRONZANO_A, excerpt: '' };
    const b = { ...TRONZANO_B, excerpt: '' };
    const r = lexicalCheck(b, a);
    expect(r.isDuplicate).toBe(false);
    expect(r.titleSim).toBeLessThan(0.60);
    expect(findRecentTopicCoverage(TRONZANO_B, [TRONZANO_A], { now: Date.parse(TRONZANO_B.date) })).not.toBe(null);
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

  it('le serie per comune ORA sono marcabili — l\'asserzione opposta era il difetto', () => {
    // Fino al 2026-08-10 questo test asseriva `flagged == []` e lo chiamava
    // «immunità». Era una tautologia: una chiave-MESTIERE non si attiva su un
    // nome di comune, quindi 0/25 non diceva niente sui duplicati-comune.
    // Misurato il 2026-08-10 sul corpus (3.847 articoli): 50 guide-comune,
    // 33 coppie entro 90 giorni, 26 articoli che non sarebbero mai usciti.
    const series = comuneSeries();
    expect(series.length).toBeGreaterThan(10);
    const flagged = series.filter((a) => topicCoverageKey(a) !== null);
    expect(flagged.length).toBeGreaterThan(20);
    for (const a of flagged) expect(topicCoverageKey(a).kind).toBe('comune-guide');
  });

  it('le coppie sullo stesso comune si marcano davvero, in condizioni reali', () => {
    for (const id of [TRONZANO_B.id, MASLIANICO_B.id, BESANO_B.id]) {
      const article = CORPUS.find((a) => a.id === id);
      expect(article).not.toBe(undefined);
      const hit = findRecentTopicCoverage(article, CORPUS, { now: Date.parse(article.date) });
      expect(hit, `nessun duplicato trovato per ${id}`).not.toBe(null);
      expect(hit.kind).toBe('comune-guide');
    }
  });

  it('comuni diversi restano indipendenti anche a finestra infinita', () => {
    // La serie deve poter continuare: il gate blocca la ripetizione DELLO
    // STESSO comune, non la serie. Per ogni guida-comune del corpus, ogni
    // duplicato trovato deve avere la stessa chiave — mai quella di un altro
    // comune.
    const keyed = comuneSeries()
      .filter((a) => a.date && topicCoverageKey(a)?.kind === 'comune-guide');
    expect(keyed.length).toBeGreaterThan(20);
    for (const a of keyed) {
      const hit = findRecentTopicCoverage(a, keyed, { now: Date.parse(a.date), windowDays: 3650 });
      if (hit) expect(hit.value).toBe(topicCoverageKey(a).value);
    }
  });

  it('i bollettini quotidiani non sono mai marcabili', () => {
    const daily = bollettini();
    expect(daily.length).toBeGreaterThan(0);
    for (const b of daily) {
      expect(topicCoverageKey(b), `bollettino marcato: ${b.id}`).toBe(null);
      expect(findRecentTopicCoverage(b, daily, { now: Date.parse(b.date), windowDays: 3650 })).toBe(null);
    }
  });

  it('il gate resta selettivo: marca una minoranza netta del corpus', () => {
    const keyed = CORPUS.filter((a) => topicCoverageKey(a) !== null);
    // Misurato il 2026-08-10 sul corpus di 3.847 articoli: 251 marcati (6,5%),
    // di cui 162 guide-mestiere, 50 guide-comune e 39 tema×cantone.
    // Il tetto al 15% è il ratchet: se un allargamento del criterio (o della
    // tassonomia) facesse esplodere la superficie, questo test lo dice prima
    // che il gate cominci a rifiutare articoli legittimi in produzione.
    expect(keyed.length).toBeGreaterThan(150);
    expect(keyed.length).toBeLessThan(CORPUS.length * 0.15);
    const kinds = new Set(keyed.map((a) => topicCoverageKey(a).kind));
    expect([...kinds].sort()).toEqual(['canton-theme', 'comune-guide', 'profession-guide']);
  });

  it('ogni classe di chiave è rappresentata: nessuna è morta in silenzio', () => {
    // Senza questo, una chiave che smettesse di agganciare (un regex rotto,
    // un file dati non letto) lascerebbe tutti gli altri test verdi.
    const count = (kind) => CORPUS.filter((a) => topicCoverageKey(a)?.kind === kind).length;
    expect(count('profession-guide')).toBeGreaterThan(100);
    expect(count('comune-guide')).toBeGreaterThan(30);
    expect(count('canton-theme')).toBeGreaterThan(20);
  });

  it('la coppia piastrellista è nel corpus e il gate la marca in condizioni reali', () => {
    const b = CORPUS.find((a) => a.id === PIASTRELLISTA_B.id);
    expect(b).not.toBe(undefined);
    const hit = findRecentTopicCoverage(b, CORPUS, { now: Date.parse(b.date) });
    expect(hit).not.toBe(null);
    expect(hit.value).toBe('piastrellista');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Il nome di un COMUNE non è una prova che l'articolo parli di un MESTIERE
// ══════════════════════════════════════════════════════════════════════════

/**
 * `professionTopicKey` lavora su un SACCHETTO di stem: decide se un alias
 * compare, non DOVE. Quindi non può accorgersi che il token che l'ha convinta
 * stava dentro un toponimo — ed è la stessa cecità che
 * `AMBIGUOUS_COMUNE_TOKENS` cura nella direzione opposta.
 *
 * IL CASO REALE. `vivere-villa-guardia-lavorare-ticino`, «Villa Guardia:
 * vivere e lavorare come frontaliere», pubblicato il 2026-08-19T07:27Z.
 * «lavorare come» accende l'intento-mestiere e «guardia» — metà del nome di un
 * comune della provincia di Como — risolve sull'alias di `agente-sicurezza`.
 * L'articolo usciva `profession-guide:agente-sicurezza`: il gate avrebbe
 * potuto rifiutare una futura guida legittima sulle guardie giurate perché
 * «già coperta» da una guida su un paese, e non avrebbe protetto Villa Guardia
 * da un doppione. Ha reso ROSSO questo file su OGNI branch, main compreso, e
 * con esso ha bloccato la coda di merge del repo.
 *
 * PERCHÉ SONO TRE CASI E NON UNO. Il criterio è causale, non lessicale: si
 * toglie il nome del comune e si richiede la chiave. Un test sul solo caso
 * rotto passerebbe anche con la regola sbagliata «se c'è un comune, non è mai
 * un mestiere», che cancellerebbe le guide-mestiere ambientate in un comune.
 * Il secondo e il terzo caso sono quelli che quella regola ucciderebbe.
 */
describe('il nome di un comune non prova un mestiere', () => {
  const VILLA_GUARDIA_RESIDENZA = {
    id: 'vivere-villa-guardia-lavorare-ticino',
    title: 'Villa Guardia: vivere e lavorare come frontaliere',
  };
  const GUARDIA_A_VILLA_GUARDIA = {
    id: 'guardia-giurata-villa-guardia-stipendio',
    title: 'Fare la guardia giurata a Villa Guardia: stipendio e requisiti',
  };
  const GUARDIA_SENZA_COMUNE = {
    id: 'lavoro-guardia-giurata-ticino-frontaliere',
    title: 'Lavorare come guardia giurata in Ticino: guida per frontalieri',
  };

  it('l\'unica prova è il toponimo → non è una guida-mestiere', () => {
    expect(topicCoverageKey(VILLA_GUARDIA_RESIDENZA)?.kind).not.toBe('profession-guide');
  });

  it('il mestiere ha prove PROPRIE → resta una guida-mestiere anche col comune', () => {
    // La riga che impedisce l'ipercorrezione: togliere «villa guardia» lascia
    // «fare la guardia giurata a», e quella prova sopravvive.
    expect(keyOf(GUARDIA_A_VILLA_GUARDIA)).toBe('profession-guide:agente-sicurezza');
  });

  it('senza nessun comune nel testo, niente cambia', () => {
    expect(keyOf(GUARDIA_SENZA_COMUNE)).toBe('profession-guide:agente-sicurezza');
  });

  it('il nome va tolto in TUTTE le sue occorrenze, non solo nella prima', () => {
    // Il testo di decisione è `${title} ${id}`, e l'id ripete quasi sempre
    // ciò che il titolo dice: qui «villa guardia» compare DUE volte. La prima
    // stesura ne toglieva una sola, e l'altra bastava a far sopravvivere la
    // chiave-mestiere — misurato: zero articoli cambiati su 4.498, cioè una
    // fix che non riparava niente restando verde su ogni test a caso singolo.
    const text = `${VILLA_GUARDIA_RESIDENZA.title} ${VILLA_GUARDIA_RESIDENZA.id.replace(/-/g, ' ')}`;
    expect((text.toLowerCase().match(/villa guardia/g) || []).length).toBe(2);
  });

  it('nel corpus reale la regola tocca UN articolo, non una classe', () => {
    // Il valore della fix è che sia chirurgica: se una modifica futura la
    // allargasse, questo conteggio lo direbbe prima della produzione.
    const persi = CORPUS.filter((a) => {
      const k = topicCoverageKey(a);
      return k?.kind === 'profession-guide' && /^(trasferirsi-a-|vivere-)/.test(a.id);
    });
    expect(persi).toEqual([]);
  });
});

/**
 * LE CINQUE FORME CHE LA PREPOSIZIONE OBBLIGATORIA LASCIAVA FUORI (2026-08-20).
 *
 * `RESIDENCE_INTENT_RE` chiedeva `vivere a ` o `vivere in `, con lo spazio.
 * Il testo di decisione è `${title} ${id-con-trattini-come-spazi}`, e gli slug
 * del pool comune la preposizione non ce l'hanno: cinque comuni restavano
 * senza chiave, quindi senza protezione dai doppioni — e due doppioni sono
 * infatti usciti, lo stesso giorno, sullo stesso comune.
 *
 * I casi sono presi dal corpus pubblicato, non inventati: ognuno è una forma
 * DIVERSA di ciò che sfuggiva (slug senza preposizione, `d` eufonica nel
 * titolo, «vivere e lavorare»), perché un test su una sola forma passerebbe
 * anche con una toppa che cura solo quella.
 */
describe('intento residenza: la preposizione non è obbligatoria', () => {
  const REALI = [
    ['vivere-tovo-di-sant-agata-e-lavorare-in-grigioni-da-frontaliere', 'tovo-di-sant-agata',
      'slug senza preposizione, titolo che non parla del comune'],
    ['vivere-courmayeur-e-lavorare-vallese-da-frontaliere', 'courmayeur',
      'slug senza preposizione'],
    ['vivere-valpelline-lavorare-vallese', 'valpelline',
      'slug senza preposizione né congiunzione'],
    ['vivere-villa-guardia-lavorare-ticino', 'villa-guardia',
      'comune di due parole, «vivere e lavorare» nel titolo'],
    ['vivere-masciago-primo-lavorare-ticino', 'masciago-primo',
      'comune di due parole'],
  ];

  for (const [id, comune, perche] of REALI) {
    it(`${comune} prende la chiave (${perche})`, () => {
      // Solo lo slug: è la metà che il generatore produce sempre uguale, ed è
      // quella su cui la vecchia regex falliva. Il titolo non deve servire.
      expect(comuneTopicKey(id.replace(/-/g, ' '))).toBe(comune);
    });
  }

  it('«vivere e lavorare» da solo esprime intento residenza', () => {
    expect(hasResidenceGuideIntent('Villa Guardia: vivere e lavorare come frontaliere')).toBe(true);
  });

  it('la «d» eufonica non fa perdere l\'intento', () => {
    expect(hasResidenceGuideIntent('Vivere ad Albese con Cassano e lavorare in Ticino')).toBe(true);
  });

  it('«vivere» da solo NON basta: serve anche il comune', () => {
    // La congiunzione è ciò che tiene i falsi positivi a zero: allargare
    // l'intento non allarga la chiave se non c'è un nome di comune.
    expect(comuneTopicKey('vivere con 2000 euro al mese da frontaliere')).toBe(null);
    expect(comuneTopicKey('costo della vita in Svizzera: vivere bene con uno stipendio medio')).toBe(null);
  });
});

/**
 * `comuneMatch` (interna a `comuneTopicKey`) sceglie il candidato più lungo
 * fra due nomi che condividono la prima parola normalizzata — «Tronzano»
 * contro «Tronzano Lago Maggiore». La selezione confrontava `n` (parole del
 * candidato in esame) con `best.length`, campo che l'oggetto `best` non ha
 * mai avuto (ha `value`/`start`/`words`): dopo il primo match `best.length`
 * è `undefined`, quindi `n > undefined` è sempre falso e vince il PRIMO nome
 * incontrato scandendo il testo, non il più lungo. Il dataset ha 14 gruppi di
 * comuni che condividono la prima parola normalizzata (`san` → 6, `villa` →
 * 3, `saint` → 8, ecc.), quindi qualunque testo che nomini due comuni dello
 * stesso gruppo nell'ordine sbagliato prendeva lo slug corto.
 */
describe('comuneTopicKey — il nome più lungo vince anche su gruppi ambigui', () => {
  it('due comuni "san …" nel testo: vince il più lungo, non il primo incontrato', () => {
    expect(comuneTopicKey('guida a San Siro poi parliamo di San Bartolomeo Val Cavargna'))
      .toBe('san-bartolomeo-val-cavargna');
  });

  it('stesso caso in ordine inverso: il risultato non dipende dall\'ordine nel testo', () => {
    expect(comuneTopicKey('guida a San Bartolomeo Val Cavargna poi parliamo di San Siro'))
      .toBe('san-bartolomeo-val-cavargna');
  });
});

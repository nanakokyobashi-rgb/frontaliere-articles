/**
 * PORTATO da valerielinc-ops/frontaliere-si-o-no `tests/article-duplicate-detection.test.ts`
 * (manifest: `adapted`) — ma NON è una copia, ed è questo il punto.
 *
 * Il test del sito replica una versione VECCHIA di checkForDuplicates: soglie
 * 0.60/0.45/0.35/0.40, stemmer e sinonimi inline. Il create-article.mjs che
 * genera davvero gli articoli (qui e sul sito: il generatore è stato
 * trasportato, non biforcato) usa da 2026-07-01/#3138 soglie più larghe —
 * ID 0.72 con conferma titolo, titolo adattivo sulla taglia del corpus
 * (≈0.81 a 3.768 articoli), excerpt 0.62 con conferma entità, entità 0.65
 * con combinato 0.45, combinato 0.55 — e la tokenizzazione condivisa di
 * it-text-similarity.mjs. Portare la replica vecchia avrebbe pinnato un
 * algoritmo che non esiste più in nessuno dei due repo.
 *
 * Questa suite replica l'algoritmo ATTUALE (la parte pura di
 * checkForDuplicates, create-article.mjs — cercare «Thresholds» lì), importa
 * stopword/stemmer/sinonimi dalle stesse librerie condivise del generatore, e
 * pinna il comportamento MISURATO sui fixture del sito (2026-08-08):
 *
 *   - calo-q4 vs calo (i due più vicini del trio 2026-02-19): CATTURATO
 *     (entità 1.00, combinato 0.64);
 *   - dati-q4 vs calo-q4: CATTURATO (combinato 0.63);
 *   - dati-q4 vs calo: NON più catturato (combinato 0.44) — il loosening di
 *     #3138 ha scambiato questa cattura contro i falsi positivi evergreen;
 *     asserito com'è perché il gate NON diverga in silenzio in nessuna
 *     direzione: se un rituning lo riprende, il test va aggiornato a dup=true
 *     CONSAPEVOLMENTE;
 *   - congedo-parentale vs maternità-paternità (duplicato per sinonimi): NON
 *     più catturato dal check lessicale (titolo 0.50 < 0.81) — oggi quella
 *     classe è affidata a checkSemanticNearDuplicate (embeddings) e al
 *     pre-flight; qui si pinna che i SINONIMI restano vivi nel tokenizer
 *     (normalizeItWord) anche se la soglia non scatta;
 *   - tutti i negativi del sito (LAMal, terzo pilastro, trasporti, «stessi
 *     dati, taglio diverso») restano negativi anche con le soglie attuali.
 *
 * Il drift guard in fondo lega questa replica al sorgente: se le soglie o le
 * condizioni composte di checkForDuplicates cambiano ancora, fallisce QUESTO
 * file, con l'istruzione di riallineare replica e attese.
 *
 * ## Entità (2026-09-25, run 36096755072)
 *
 * Il segnale «Entità» non è più replicato qui: viene da
 * generator/scripts/lib/dup-entities.mjs, lo stesso modulo che il generatore
 * importa. Sono i numeri di titolo + excerpt e i comuni del titolo, MENO i
 * numeri che il corpus pubblicato ripete (anni, zona dei 20 km, 7500/10000
 * dell'accordo 2024). Prima contavano, e due pagine-comune che dicevano
 * entrambe «2026» valevano Entità=100%: bastava il modello di titolo condiviso
 * per scartare «vivere a Erba» come doppione di un altro comune.
 *
 * ## ADATTAMENTI rispetto al sito (oltre a quanto sopra)
 *  - `node:test` + generator/tests/lib/expect-shim.mjs al posto di vitest.
 *  - Lo stemmer inline del sito (stemIt) non è replicato: le asserzioni sui
 *    sinonimi passano da normalizeItWord, che è ciò che il generatore usa.
 */
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { expect } from './lib/expect-shim.mjs';
import {
  jaccardSim,
  normalizeItWord,
  STOP_WORDS_IT,
} from '../scripts/lib/it-text-similarity.mjs';
import { computeAdaptiveEvergreenThresholds } from '../scripts/lib/scoring/constants.mjs';
import {
  articleEntities,
  commonEntityMinDf,
  corpusCommonEntities,
  distinctiveEntities,
  extractKeyEntities,
} from '../scripts/lib/dup-entities.mjs';

// Taglia del corpus alla registrazione delle attese (3.768 titoli IT misurati
// il 2026-08-08). La soglia titolo è adattiva MA satura al ceiling 0.85, e a
// questa taglia è già ≈0.81: le attese sotto restano valide per ogni corpus
// futuro più grande (la soglia può solo salire verso 0.85). Fissarla qui rende
// il test deterministico invece che dipendente dal contenuto del checkout.
const CORPUS_SIZE_AT_RECORDING = 3768;

// ── Replica della parte pura di checkForDuplicates (create-article.mjs) ──

function getSignificantWords(text) {
  return text.toLowerCase()
    .replace(/[^a-zàáèéìíòóùú0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS_IT.has(w))
    .map((w) => normalizeItWord(w));
}

// Il boilerplate numerico del corpus, come lo misura il generatore (≥ 0,5%
// degli articoli pubblicati). Qui la frequenza viene da un corpus sintetico,
// così le attese non dipendono dal contenuto del checkout: 25 pagine-modello
// che portano gli stessi anni e le stesse cifre dell'accordo 2024. La misura
// sul corpus VERO (2026 in 929 articoli su 6181, 7500 in 35) è nel commento
// di testa di dup-entities.mjs; leggerlo da qui farebbe di questo file un gate
// sul contenuto (content-gates-main.test.mjs).
const BOILERPLATE = corpusCommonEntities(
  Array.from({ length: 25 }, () => ['2026', '2025', '2024', '10', '20', '7500', '10000']),
  commonEntityMinDf(0),
);

function checkDuplicate(newArticle, existingArticle, corpusSize = CORPUS_SIZE_AT_RECORDING, common = BOILERPLATE) {
  const ID_THRESHOLD = 0.72;
  const TITLE_THRESHOLD = computeAdaptiveEvergreenThresholds(corpusSize).titleJaccard;
  const EXCERPT_THRESHOLD = 0.62;
  const COMBINED_THRESHOLD = 0.55;

  const newIdWords = newArticle.id.split('-').filter((w) => w.length > 1).map((w) => normalizeItWord(w));
  const existingIdWords = existingArticle.id.split('-').filter((w) => w.length > 1).map((w) => normalizeItWord(w));
  const idSim = jaccardSim(newIdWords, existingIdWords);
  const titleSim = jaccardSim(getSignificantWords(newArticle.title), getSignificantWords(existingArticle.title));
  const excerptSim = jaccardSim(getSignificantWords(newArticle.excerpt), getSignificantWords(existingArticle.excerpt));
  const entitySim = jaccardSim(
    distinctiveEntities(articleEntities(newArticle.title, newArticle.excerpt), common),
    distinctiveEntities(articleEntities(existingArticle.title, existingArticle.excerpt), common),
  );

  const combinedScore = 0.25 * idSim + 0.30 * titleSim + 0.25 * excerptSim + 0.20 * entitySim;

  const isDuplicate =
    (idSim >= ID_THRESHOLD && titleSim >= 0.40) ||
    titleSim >= TITLE_THRESHOLD ||
    (excerptSim >= EXCERPT_THRESHOLD && entitySim >= 0.20) ||
    (entitySim >= 0.65 && combinedScore >= 0.45) ||
    combinedScore >= COMBINED_THRESHOLD;

  return { isDuplicate, idSim, titleSim, excerptSim, entitySim, combinedScore };
}

// ── I tre duplicati noti del 2026-02-19 (fixture del sito, verbatim) ──

const ARTICLE_1 = {
  id: 'frontalieri-ticino-calo-2025',
  title: 'Frontalieri in calo in Ticino: i dati del 2025',
  excerpt:
    "Mentre la Svizzera segna un record di 411.000 frontalieri, il Ticino va in controtendenza: -1,0% nell'ultimo trimestre. Analisi dei dati UST e cosa significa per il mercato.",
};

const ARTICLE_2 = {
  id: 'frontalieri-ticino-calo-q4-2025',
  title: 'Frontalieri: Ticino in calo, Svizzera in crescita',
  excerpt:
    "Gli ultimi dati UST per il Q4 2025 mostrano un Ticino in controtendenza: -1.0% di frontalieri su base trimestrale, mentre la Svizzera tocca quota 411'000.",
};

const ARTICLE_3 = {
  id: 'frontalieri-ticino-dati-q4-2025',
  title: 'Frontalieri: la Svizzera cresce, il Ticino frena',
  excerpt:
    'Mentre la Svizzera tocca un nuovo record con 411.000 frontalieri, il Ticino va in controtendenza. A fine 2025 i permessi G scendono a 78.809 (-1,0%).',
};

describe('Article duplicate detection (multi-signal, algoritmo ATTUALE)', () => {
  describe('il trio 2026-02-19 con le soglie correnti', () => {
    it('detects article 2 as duplicate of article 1 (entità 1.00 + combinato)', () => {
      const result = checkDuplicate(ARTICLE_2, ARTICLE_1);
      expect(result.isDuplicate).toBe(true);
      expect(result.entitySim).toBeGreaterThanOrEqual(0.65);
    });

    it('detects article 3 as duplicate of article 2 (combinato sopra soglia)', () => {
      const result = checkDuplicate(ARTICLE_3, ARTICLE_2);
      expect(result.isDuplicate).toBe(true);
      expect(result.combinedScore).toBeGreaterThanOrEqual(0.55);
    });

    it('NO LONGER detects article 3 vs article 1 — il costo misurato del loosening #3138', () => {
      // Combinato 0.44: sotto il gate entità-0.65-più-combinato-0.45 per un
      // soffio, e sotto il combinato secco 0.55. Se questo test si mette a
      // fallire con dup=true, il tuning è cambiato: aggiornare l'attesa
      // CONSAPEVOLMENTE, non allargare la replica.
      const result = checkDuplicate(ARTICLE_3, ARTICLE_1);
      expect(result.isDuplicate).toBe(false);
      expect(result.entitySim).toBeGreaterThanOrEqual(0.65);
      expect(result.combinedScore).toBeGreaterThan(0.40);
    });
  });

  describe('does NOT flag genuinely different articles', () => {
    const DIFFERENT_ARTICLE = {
      id: 'guida-assicurazione-malattia-lamal',
      title: 'Assicurazione malattia LAMal: guida completa per frontalieri',
      excerpt:
        'Come scegliere la cassa malati in Svizzera. Confronto franchigie, modelli e premi 2026.',
    };

    const ANOTHER_DIFFERENT = {
      id: 'terzo-pilastro-frontalieri-2026',
      title: 'Terzo pilastro 3a: conviene ai frontalieri nel 2026?',
      excerpt:
        'Vantaggi fiscali del pilastro 3a per frontalieri italiani. Limiti di deduzione e migliori offerte bancarie.',
    };

    it('does not flag LAMal article vs frontalieri-calo article', () => {
      expect(checkDuplicate(DIFFERENT_ARTICLE, ARTICLE_1).isDuplicate).toBe(false);
    });

    it('does not flag pillar-3 vs frontalieri-calo article', () => {
      expect(checkDuplicate(ANOTHER_DIFFERENT, ARTICLE_1).isDuplicate).toBe(false);
    });

    it('does not flag LAMal vs pillar-3 articles (condividono solo «2026»)', () => {
      // Entrambi citano solo "2026", che il corpus ripete ovunque: non è
      // un'entità in comune, entitySim 0.
      const result = checkDuplicate(DIFFERENT_ARTICLE, ANOTHER_DIFFERENT);
      expect(result.isDuplicate).toBe(false);
      expect(result.entitySim).toBe(0);
    });

    it('does not flag articles with same source data but very different framing', () => {
      const newArt = {
        id: 'statistiche-permesso-g-fine-anno',
        title: 'Permessi G: i numeri di fine 2025 in Ticino',
        excerpt:
          'I dati UST mostrano 78.809 frontalieri in Ticino (-1,0%). La Svizzera raggiunge quota 411.000.',
      };
      const result = checkDuplicate(newArt, ARTICLE_1);
      expect(result.isDuplicate).toBe(false);
      expect(result.entitySim).toBeGreaterThan(0.5);
    });

    it('does not flag articles sharing only common words like "frontalieri" and "ticino"', () => {
      const genericNew = {
        id: 'frontalieri-ticino-trasporti-2026',
        title: 'Trasporti per frontalieri in Ticino: novità 2026',
        excerpt:
          'Nuovi orari FFS e TILO per i pendolari transfrontalieri. Abbonamenti Arcobaleno in arrivo.',
      };
      expect(checkDuplicate(genericNew, ARTICLE_1).isDuplicate).toBe(false);
    });
  });

  describe('pagine-comune (run 36096755072): il luogo conta, il boilerplate no', () => {
    // Pubblicati, verbatim dal corpus.
    const BRISSAGO = {
      id: 'vivere-brissago-valtravaglia-ticino',
      title: 'Vivere a Brissago-Valtravaglia, lavorare in Ticino: guida frontaliere',
      excerpt: 'Permesso G, tassazione, AVS, LAMal: tutto quello che devi sapere per trasferirsi a Brissago-Valtravaglia e lavorare da frontaliere in Ticino nel 2026.',
    };
    const TOVO = {
      id: 'vivere-tovo-di-sant-agata-e-lavorare-in-grigioni-da-frontaliere',
      title: "Vivere a Tovo di Sant'Agata e lavorare in Grigioni da frontaliere",
      excerpt: "Il Nuovo Accordo Frontalieri del 2024 è entrato in vigore dal 1° gennaio 2024 e prevede l'esenzione di € 7.500 per i vecchi frontalieri e di € 10.000 per i nuovi frontalieri.",
    };
    const SPRIANA = {
      id: 'vivere-spriana-grigioni-frontaliere',
      title: 'Vivere a Spriana, lavorare in Grigioni da frontaliere',
      excerpt: 'Guida completa per frontalieri: Nuovo Accordo 2024, imposta alla fonte solo Svizzera, esenzione €7.500-€10.000, Permesso G, AVS/LPP e ristorno italiano.',
    };
    const GORNATE = {
      id: 'gornate-olona-regime-fiscale',
      title: 'Gornate Olona: lavorare in Ticino da frontaliere',
      excerpt: "Da Gornate Olona al Ticino: accordo frontalieri in vigore dal 1° gennaio 2024, imposta alla fonte, esenzione €7'500 o franchigia €10'000, AVS e LAMal.",
    };
    const TRASQUERA_A = {
      id: 'vivere-a-trasquera-e-lavorare-in-ticino-da-frontaliere',
      title: 'Vivere a Trasquera, lavorare in Ticino: collegamenti e costo della vita',
      excerpt: 'La regione di Trasquera offre una qualità della vita elevata e un ambiente naturale unico. Tuttavia, lavorare in Ticino può presentare alcuni sfidi per i frontalieri.',
    };
    const TRASQUERA_B = {
      id: 'vivere-trasquera-lavorare-ticino',
      title: 'Vivere a Trasquera e lavorare in Ticino da frontaliere',
      excerpt: 'Guida pratica per i frontalieri: imposte, nuovo accordo fiscale e gestione del reddito tra Italia e Canton Ticino.',
    };
    // Generati nella run e scartati: titolo dal log, excerpt sullo stesso
    // modello delle pagine pubblicate.
    const ERBA = {
      id: 'vivere-erba-lavorare-ticino-frontaliere',
      title: 'Vivere a Erba e lavorare in Ticino da frontaliere',
      excerpt: 'Tragitto, tassazione, AVS e LAMal: cosa sapere per vivere a Erba e lavorare da frontaliere in Ticino nel 2026.',
    };
    const GORNATE_FISCALE = {
      id: 'gornate-olona-guida-fiscale-frontalieri',
      title: 'Guida fiscale per frontalieri a Gornate Olona',
      excerpt: "Da Gornate Olona al Ticino: imposta alla fonte, esenzione €7'500 o franchigia €10'000 del nuovo accordo 2024, ristorni e dichiarazione dei redditi.",
    };

    it('«vivere a Erba» non è più il doppione di un altro comune per un «2026» in comune', () => {
      const result = checkDuplicate(ERBA, BRISSAGO);
      expect(result.isDuplicate).toBe(false);
      expect(result.entitySim).toBe(0);
      // Con il segnale di prima (tutti i numeri contano) era 100%.
      const before = jaccardSim(
        extractKeyEntities(`${ERBA.title} ${ERBA.excerpt}`),
        extractKeyEntities(`${BRISSAGO.title} ${BRISSAGO.excerpt}`),
      );
      expect(before).toBe(1);
    });

    it('due comuni diversi con le stesse cifre dell\'accordo 2024 non sono doppioni', () => {
      // Il falso positivo pubblicato: combinato 0,47 con entità 1,00 prima.
      const result = checkDuplicate(TOVO, SPRIANA);
      expect(result.isDuplicate).toBe(false);
      expect(result.entitySim).toBe(0);
    });

    it('lo stesso comune resta un doppione, ora per il luogo e non per le cifre', () => {
      const result = checkDuplicate(GORNATE_FISCALE, GORNATE);
      expect(articleEntities(GORNATE.title, '')).toContain('comune:gornate-olona');
      expect(result.entitySim).toBe(1);
      expect(result.isDuplicate).toBe(true);
    });

    it('due pagine pubblicate sullo stesso comune vengono riconosciute', () => {
      const result = checkDuplicate(TRASQUERA_B, TRASQUERA_A);
      expect(result.isDuplicate).toBe(true);
    });

    it('il comune viene dal titolo, non dall\'excerpt che nomina i vicini', () => {
      const entities = articleEntities('Vivere ad Allein, lavorare in Vallese', 'A pochi minuti da Aosta, con il Gran San Bernardo.');
      expect(entities).toContain('comune:allein');
      expect(entities).not.toContain('comune:aosta');
    });
  });

  describe('boilerplate numerico', () => {
    it('la soglia è lo 0,5% del corpus, mai sotto 20', () => {
      expect(commonEntityMinDf(0)).toBe(20);
      expect(commonEntityMinDf(3000)).toBe(20);
      expect(commonEntityMinDf(6181)).toBe(31);
    });

    it('conta gli articoli, non le occorrenze', () => {
      const common = corpusCommonEntities([['2026', '2026'], ['2026'], ['411000']], 2);
      expect([...common]).toEqual(['2026']);
      expect(distinctiveEntities(['2026', '411000'], common)).toEqual(['411000']);
    });
  });

  describe('sinonimi: vivi nel tokenizer anche dove la soglia non scatta', () => {
    const MATERNITY_ARTICLE = {
      id: 'congedo-parentale-frontalieri-svizzera',
      title: 'Congedo parentale per frontalieri in Svizzera: guida completa',
      excerpt:
        'Tutto sul congedo di maternità e paternità per i lavoratori frontalieri. Durata, indennità giornaliera e diritti dei genitori.',
    };

    const PARENTAL_LEAVE_ARTICLE = {
      id: 'maternita-paternita-frontalieri-diritti',
      title: 'Maternità e paternità: diritti dei frontalieri in Svizzera',
      excerpt:
        'Guida ai diritti delle gestanti e dei neo-genitori transfrontalieri. Congedo nascita, indennità e protezione dal licenziamento.',
    };

    it('il check lessicale da solo NON li cattura più (era il caso-cardine del sito)', () => {
      // Titolo 0.50 contro soglia adattiva ≈0.81, combinato 0.33. Oggi questa
      // classe è compito di checkSemanticNearDuplicate (embeddings) e del
      // pre-flight evergreen. Asserito perché un futuro lettore non deduca
      // dal nome del file una protezione lessicale che non c'è.
      const result = checkDuplicate(PARENTAL_LEAVE_ARTICLE, MATERNITY_ARTICLE);
      expect(result.isDuplicate).toBe(false);
    });

    it('ma la normalizzazione sinonimica resta viva: la similarità è alta, non nulla', () => {
      const result = checkDuplicate(PARENTAL_LEAVE_ARTICLE, MATERNITY_ARTICLE);
      expect(result.titleSim).toBeGreaterThan(0.3);
      expect(result.excerptSim).toBeGreaterThan(0.2);
    });
  });

  describe('Jaccard similarity (jaccardSim condivisa)', () => {
    it('returns 0 for empty arrays', () => {
      expect(jaccardSim([], [])).toBe(0);
    });

    it('returns 1 for identical sets', () => {
      expect(jaccardSim(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
    });

    it('returns 0 for disjoint sets', () => {
      expect(jaccardSim(['a', 'b'], ['c', 'd'])).toBe(0);
    });

    it('handles partial overlap', () => {
      // {a,b,c} ∩ {b,c,d} = {b,c} → 2/4 = 0.5
      expect(jaccardSim(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(0.5);
    });
  });

  describe('entity extraction', () => {
    it('extracts numbers from text', () => {
      const entities = extractKeyEntities('Il Ticino ha 78.809 frontalieri su 411.000 totali');
      expect(entities).toContain('78809');
      expect(entities).toContain('411000');
    });

    it('extracts percentages', () => {
      const entities = extractKeyEntities('Calo del -1,0% e crescita del 3.2%');
      expect(entities.some((e) => e.includes('%'))).toBe(true);
    });
  });

  describe('synonym normalization (normalizeItWord, la mappa che il generatore usa davvero)', () => {
    it('maps maternità and congedo to same canonical', () => {
      expect(normalizeItWord('maternità')).toBe(normalizeItWord('congedo'));
    });

    it('maps paternità and parentale to same canonical', () => {
      expect(normalizeItWord('paternità')).toBe(normalizeItWord('parentale'));
    });

    it('maps frontalieri and pendolari to same canonical', () => {
      expect(normalizeItWord('frontalieri')).toBe(normalizeItWord('pendolari'));
    });

    it('maps imposta and tassa to same canonical', () => {
      expect(normalizeItWord('imposta')).toBe(normalizeItWord('tassa'));
    });

    it('maps stipendio and salario to same canonical', () => {
      expect(normalizeItWord('stipendio')).toBe(normalizeItWord('salario'));
    });

    it('does not map unrelated words to same canonical', () => {
      expect(normalizeItWord('pensione')).not.toBe(normalizeItWord('trasporto'));
    });
  });
});

// ── Drift guard: la replica sopra deve corrispondere al sorgente vero ──

describe('drift guard — checkForDuplicates in create-article.mjs', () => {
  it('le soglie e le condizioni composte replicate qui esistono verbatim nel sorgente', () => {
    const src = readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf-8');

    expect(src).toContain('function checkForDuplicates(data)');
    expect(src).toContain('const ID_THRESHOLD = 0.72;');
    expect(src).toContain("computeAdaptiveEvergreenThresholds(existingArticles.length).titleJaccard");
    expect(src).toContain('const EXCERPT_THRESHOLD = 0.62;');
    expect(src).toContain('const COMBINED_THRESHOLD = 0.55;');
    expect(src).toContain('(idSim >= ID_THRESHOLD && titleSim >= 0.40) ||');
    expect(src).toContain('(excerptSim >= EXCERPT_THRESHOLD && entitySim >= 0.20) ||');
    expect(src).toContain('(entitySim >= 0.65 && combinedScore >= 0.45) ||');
    expect(src).toContain('.map(w => normalizeItWord(w))');
    // Le entità vengono dal modulo condiviso, al netto del boilerplate del corpus.
    expect(src).toContain('const existingEntityLists = existingArticles.map((a) => articleEntities(a.title, a.excerpt));');
    expect(src).toContain('const commonEntities = corpusCommonEntities(existingEntityLists, commonEntityMinDf(existingArticles.length));');
    expect(src).toContain('const existingEntities = distinctiveEntities(existingEntityLists[index], commonEntities);');
    expect(src).not.toContain('function extractKeyEntities(text)');

    // I pesi del combinato, riga per riga come stanno nel sorgente.
    expect(src).toContain('0.25 * idSim +');
    expect(src).toContain('0.30 * titleSim +');
    expect(src).toContain('0.25 * excerptSim +');
    expect(src).toContain('0.20 * entitySim;');
  });

  it('la soglia titolo adattiva satura al ceiling: le attese restano valide su corpus più grandi', () => {
    const at3768 = computeAdaptiveEvergreenThresholds(3768).titleJaccard;
    const at10000 = computeAdaptiveEvergreenThresholds(10000).titleJaccard;
    expect(at3768).toBeGreaterThan(0.80);
    expect(at10000).toBeGreaterThanOrEqual(at3768);
    expect(at10000).toBeLessThan(0.86);
  });
});

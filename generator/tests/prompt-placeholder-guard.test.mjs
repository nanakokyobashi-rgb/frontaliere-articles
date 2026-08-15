/**
 * prompt-placeholder-guard.test.mjs — banco del guard sui segnaposto del
 * prompt, piu' il LOCK sul template e il gate sull'output pubblicato.
 *
 * ## Quattro strati, perche' tre non bastano
 *
 * `it-microcopy-guard.test.mjs` ne ha tre (unit + wiring + scan) e la sua
 * intestazione spiega perche'. Qui ne serve un quarto, ed e' quello che rende
 * questo guard diverso da tutti i precedenti sulla stessa classe:
 *
 *   1. UNIT     — le stringhe VERE uscite in produzione, verbatim.
 *   2. LOCK     — i letterali dello schema si ri-estraggono da
 *                 `create-article.mjs` e devono coincidere con quelli del
 *                 modulo. **Se il template acquisisce un segnaposto nuovo,
 *                 questo test diventa rosso** — che e' l'unica differenza fra
 *                 un guard e una lista di stringhe destinata a invecchiare.
 *   3. WIRING   — il guard e' invocato davvero, sul percorso di scrittura
 *                 CONDIVISO e non in un solo produttore.
 *   4. GATE     — zero offender sui campi pubblicati, con i due tassi di falso
 *                 positivo misurati SEPARATAMENTE su metadati e su corpi.
 *
 * La ragione dello strato 2 e' scritta nella storia del difetto: tre fix hanno
 * chiuso tre campi (slug con la PR #121, title/excerpt con it-microcopy-guard,
 * la forma della FAQ col filtro di lunghezza) e ogni volta il segnaposto e'
 * ricomparso nel campo successivo. Una lista scritta a mano avrebbe chiuso il
 * quarto campo e lasciato aperto il quinto.
 *
 * ## Perche' il gate ha soglie di conteggio
 *
 * `content/blog-body**` e' escluso da ogni worktree sparse di questo repo. Uno
 * scan su zero file passa. Le asserzioni sui conteggi esistono perche' non
 * possa passare a vuoto — stessa ragione, stessa forma di
 * `it-microcopy-guard.test.mjs`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA_PLACEHOLDER_LITERALS,
  SLUG_OWNED_LITERALS,
  PROMPT_SCAFFOLD_LABELS,
  SOURCE_ECHO_MARKERS,
  PLACEHOLDER_RULES,
  leadOf,
  findPromptPlaceholders,
  hasPromptPlaceholder,
  stripFaqNumberedLabels,
  stripSchemaHeadingLine,
  truncateAtPromptScaffold,
  cleanFaqPairs,
  orphanFaqLocales,
  sanitizePromptPlaceholders,
} from '../scripts/lib/prompt-placeholder-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_ARTICLE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');
const createArticleSrc = fs.readFileSync(CREATE_ARTICLE, 'utf-8');

// ═══════════════════════════════════════════════════════════════════════════
// 1. UNIT — i segnaposto veri, usciti in produzione
// ═══════════════════════════════════════════════════════════════════════════

describe('la FAQ segnaposto, che e\' il caso grave', () => {
  // Il valore verbatim di 18 file `content/blog-body**/it/*.ts` su origin/main.
  const FAQ_SEGNAPOSTO = [
    { q: "Domanda frequente 1 basata sui fatti dell'articolo?", a: 'Risposta con dati DALLA FONTE. 50-100 parole.' },
    { q: 'Domanda frequente 2?', a: 'Risposta pratica basata sulla fonte.' },
    { q: 'Domanda frequente 3?', a: 'Risposta con procedura o scadenza dalla fonte.' },
  ];

  it('il filtro di FORMA che c\'era la accettava: 3 coppie oltre soglia', () => {
    // La riga che stampava «✅ FAQ: 3 coppie valide» mentre le coppie erano lo
    // schema. Se questa asserzione cade, il difetto non era quello descritto.
    const passavano = FAQ_SEGNAPOSTO.filter((p) => p.q.length > 10 && p.a.length > 20);
    assert.equal(passavano.length, 3, 'il vecchio filtro non le accettava: la premessa del guard e\' sbagliata');
  });

  it('cleanFaqPairs le scarta tutte e tre e rimuove il campo', () => {
    const { pairs, dropped } = cleanFaqPairs(FAQ_SEGNAPOSTO);
    assert.equal(dropped.length, 3);
    assert.equal(pairs, null, 'sotto le 2 coppie il campo va RIMOSSO: una FAQ assente non produce structured data, una finta si\'');
  });

  it('scarta anche la coppia con domanda segnaposto e risposta VERA (tennis-donne-open-di-chiasso…)', () => {
    const { pairs, dropped } = cleanFaqPairs([
      { q: "Domanda frequente 1 basata sui fatti dell'articolo?", a: "Marija Glebovna Timofeeva ha vinto il titolo dell'Open di Chiasso il 23 ottobre 2023." },
      { q: 'Domanda frequente 2?', a: "L'Open di Chiasso è una competizione prestigiosa in Svizzera." },
      { q: 'Domanda frequente 3?', a: "La registrazione per l'Open di Chiasso 2024 si aprirà il 1º gennaio 2024." },
    ]);
    assert.equal(dropped.length, 3);
    assert.equal(pairs, null, 'una domanda non si inventa: la coppia finirebbe in FAQPage.name');
  });

  it('la variante minuscola senza suffisso (non-c-e-assolutamente-nessun-errore-sistemico)', () => {
    const { pairs } = cleanFaqPairs([
      { q: 'Domanda frequente 1', a: 'Risposta con dati dalla fonte.' },
      { q: 'Domanda frequente 2', a: 'Risposta pratica basata sulla fonte.' },
      { q: 'Domanda frequente 3', a: 'Risposta con procedura o scadenza dalla fonte.' },
    ]);
    assert.equal(pairs, null);
  });

  it('RIPARA invece di scartare quando dietro l\'etichetta c\'e\' contenuto vero (domanda-scomoda-razzisti-omofobi)', () => {
    const { pairs, repaired, dropped } = cleanFaqPairs([
      { q: 'Domanda frequente 1: che cosa significa la domanda scomoda?', a: 'La domanda scomoda è una domanda che si fa sulla possibilità di pregiudizi e discriminazioni.' },
      { q: 'Domanda frequente 2: come posso evitare di essere discriminato?', a: 'Per evitare di essere discriminato è importante essere consapevole delle proprie azioni.' },
      { q: 'Domanda frequente 3: cosa devo fare per informarmi?', a: 'Rivolgersi agli sportelli cantonali competenti e chiedere assistenza.' },
    ]);
    assert.equal(dropped.length, 0);
    assert.equal(repaired, 3);
    assert.equal(pairs[0].q, 'Che cosa significa la domanda scomoda?', 'l\'iniziale stava sull\'etichetta: va rimessa');
  });
});

describe('la FAQ segnaposto TRADOTTA — cio\' che i letterali italiani non possono vedere', () => {
  // Verbatim da `origin/main` il 2026-08-11, per lo stesso articolo
  // (`regione-lombardia-fiduciosa`) di cui `it` NON ha piu' la chiave.
  const TRADOTTE = {
    en: [
      { q: 'FAQ 1 based on the facts of the article?', a: 'Response with data FROM SOURCE. 50-100 words.' },
      { q: 'Frequently Asked Question 2?', a: 'Practical answer based on the source.' },
      { q: 'Frequently Asked Question 3?', a: 'Response with procedure or deadline from source.' },
    ],
    de: [
      { q: 'FAQ 1 basierend auf den Fakten des Artikels?', a: 'Antwort mit Daten AUS DER QUELLE. 50-100 Wörter.' },
      { q: 'FAQ 2?', a: 'Praktische Antwort basierend auf der Quelle.' },
      { q: 'FAQ 3?', a: 'Antwort mit Verfahren oder Fälligkeit von der Quelle.' },
    ],
    fr: [
      { q: "Question fréquemment posée 1 basée sur les faits de l'article ?", a: 'Réponse avec des données DE LA SOURCE. 50-100 mots.' },
      { q: 'Foire aux questions 2 ?', a: 'Réponse pratique basée sur la source.' },
      { q: 'Foire aux questions 3 ?', a: 'Réponse par procédure ou échéance de la source.' },
    ],
  };

  // ── LA PREMESSA DI `orphanFaqLocales`, aggiornata dopo `source-echo-allcaps` ──
  //
  // Fino al 2026-08-14 questi tre test pretendevano `dropped == []`: nessuna
  // delle tre traduzioni era vista, e quella cecita' totale era la motivazione
  // della regola strutturale. `source-echo-allcaps` (#300) ne ha recuperata
  // UNA — la prima coppia, che porta il marcatore ALL-CAPS nella RISPOSTA — e
  // lasciato invisibili le altre due, dove il modello ha tradotto anche il
  // marcatore in prosa minuscola («based on the source», «basierend auf der
  // Quelle»).
  //
  // La premessa quindi non cade, si affila: due coppie segnaposto su tre
  // restano indistinguibili da una FAQ vera in en/de/fr, quindi
  // `orphanFaqLocales` resta l'unica via che le nomina. Il test dice ORA cosa
  // vede e cosa no, invece di dire «non vede niente», che dal 2026-08-14 e'
  // falso — un test che afferma il falso e' come quello che codificava la
  // scappatoia: passa, e mente sul motivo.
  for (const [locale, pairs] of Object.entries(TRADOTTE)) {
    it(`cleanFaqPairs vede SOLO la coppia col marcatore ALL-CAPS in '${locale}': le altre due restano invisibili`, () => {
      const { dropped, pairs: kept } = cleanFaqPairs(pairs, { dropShort: false });
      assert.deepEqual(
        dropped.map((d) => d.reason),
        ['source-echo-allcaps'],
        'la prima coppia va scartata per il marcatore nella risposta, e per quello soltanto',
      );
      assert.equal(
        kept?.length,
        2,
        'le coppie 2 e 3 non hanno marcatore: nessun letterale italiano le vede, ed e\' questa la ragione per cui orphanFaqLocales esiste',
      );
    });
  }

  it('nemmeno le tre traduzioni sono uguali fra loro: una lista di letterali non le copre', () => {
    const primi = Object.values(TRADOTTE).map((p) => p[0].q);
    assert.equal(new Set(primi).size, 3);
  });

  it('orphanFaqLocales le nomina tutte e tre quando `it` non ha la chiave', () => {
    assert.deepEqual(
      orphanFaqLocales({
        it: { hasFile: true, hasFaq: false },
        en: { hasFile: true, hasFaq: true },
        de: { hasFile: true, hasFaq: true },
        fr: { hasFile: true, hasFaq: true },
      }),
      ['de', 'en', 'fr'],
    );
  });

  it('tace quando `it` la FAQ ce l\'ha — il caso normale, 3.174 articoli su 3.193', () => {
    assert.deepEqual(
      orphanFaqLocales({
        it: { hasFile: true, hasFaq: true },
        en: { hasFile: true, hasFaq: true },
        de: { hasFile: true, hasFaq: false },
        fr: { hasFile: true, hasFaq: true },
      }),
      [],
      'una traduzione che MANCA e\' un difetto di un\'altra classe: qui non si aggiunge niente',
    );
  });

  it('tace quando il file `it` non esiste: li\' cancellare distruggerebbe l\'unico contenuto', () => {
    assert.deepEqual(
      orphanFaqLocales({
        it: { hasFile: false, hasFaq: false },
        en: { hasFile: true, hasFaq: true },
      }),
      [],
    );
  });
});

describe('imageAlt — la famiglia piu\' numerosa (40 campi su 11 articoli)', () => {
  for (const valore of ['max 125 chars', 'Max 125 chars', 'Max 125 caratteri', 'max 125 caratteri']) {
    it(`«${valore}» e' un segnaposto`, () => {
      assert.ok(hasPromptPlaceholder(valore));
    });
  }

  it('«Max 125 caratteri» NON e\' nel prompt: e\' la traduzione che il modello inventa', () => {
    assert.ok(!createArticleSrc.includes('Max 125 caratteri'), 'se il prompt la contenesse, la regola di forma sarebbe superflua');
    assert.ok(createArticleSrc.includes('max 125 chars'), 'il letterale del template deve esserci');
    const [hit] = findPromptPlaceholders('Max 125 caratteri');
    assert.equal(hit.rule, 'budget-as-value');
  });

  it('vede anche il segnaposto INCOLLATO a un alt vero (cuoco-frontaliere-ticino-guadagno)', () => {
    assert.ok(hasPromptPlaceholder('Vista di Lugano dal lago. Max 125 chars'));
    assert.ok(hasPromptPlaceholder('View of Lugano from the lake. Max 125 chars'));
  });
});

describe('l\'excerpt TRADOTTO in quattro lingue (trasferirsi-a-marchirolo-…)', () => {
  // Il caso che nessun matcher costruito sul letterale italiano puo' vedere:
  // translateArticle() ha tradotto il segnaposto come se fosse contenuto.
  const casi = [
    ['it', 'Sottotitolo con dati concreti DALLA FONTE (max 160 char)'],
    ['en', 'Subtitle with concrete data FROM THE SOURCE (max 160 char)'],
    ['de', 'Untertitel mit konkreten Angaben AUS DER QUELLE (max 160 char)'],
    ['fr', 'Sous-titre avec des données concrètes DE LA SOURCE (max 160 char)'],
  ];
  for (const [locale, valore] of casi) {
    it(`${locale}: «${valore.slice(0, 45)}…»`, () => {
      assert.ok(hasPromptPlaceholder(valore), `il segnaposto tradotto in ${locale} non viene visto`);
    });
  }

  it('en/de/fr li vedono SOLO le regole di forma, mai un letterale', () => {
    for (const [locale, valore] of casi.slice(1)) {
      const regole = findPromptPlaceholders(valore).map((h) => h.rule);
      // Il claim non e' «una regola sola»: e' che nessuna regola DERIVATA da un
      // letterale italiano arriva qui. Dal 2026-08-14 le regole di forma che lo
      // vedono sono due (`source-echo-allcaps` ha aggiunto la seconda), e
      // pinnare il conteggio invece del claim avrebbe reso rosso un guard che
      // migliora.
      assert.deepEqual(
        regole.filter((r) => r.startsWith('schema-lead-')),
        [],
        `${locale}: un letterale italiano non puo' matchare una traduzione — trovato ${regole.join(',')}`,
      );
      assert.ok(regole.includes('budget-parenthetical'), `${locale}: l'inciso col budget resta l'invariante, trovato ${regole.join(',')}`);
      assert.ok(regole.includes('source-echo-allcaps'), `${locale}: il marcatore ALL-CAPS resta l'altro invariante, trovato ${regole.join(',')}`);
    }
  });
});

describe('#344 — budget-parenthetical strutturale: l\'inciso senza verbo "max" (blog-meta-ch-en.ts, riparato in #341)', () => {
  it('«(59 characters)», nessuna cifra preceduta da "max"/"massimo": la vecchia finestra fragile lo perdeva', () => {
    const valore = '… for over 5,000 daily passengers. **Mandatory Constraints** met for title translation (59 characters).';
    const regole = findPromptPlaceholders(valore).map((h) => h.rule);
    assert.ok(regole.includes('budget-parenthetical'), `non visto: ${regole.join(',') || 'nessuna regola'}`);
  });

  it('vede anche senza chiusura immediata dopo l\'unita\' (testo fra l\'unita\' e la parentesi chiusa)', () => {
    assert.equal(findPromptPlaceholders('un sottotitolo (max 160 characters circa)').length, 1);
  });

  it('resta cieco a un inciso fra parentesi che non nomina l\'unita\' di misura dei caratteri', () => {
    assert.deepEqual(findPromptPlaceholders('un dato riservato (confidenziale)'), []);
    assert.deepEqual(findPromptPlaceholders('der Registrierungsdaten (Kennzeichen CH-123-456)'), []);
  });
});

describe('#350 — rischio 1: un inciso lungo che nomina cifra e unita\' senza relazione fra loro', () => {
  it('un inciso oltre 80 caratteri con un numero 2-4 cifre e "characters" non correlati non e\' un segnaposto', () => {
    const inciso =
      '(nota editoriale: il documento cita l\'articolo 42 del regolamento e descrive come i moduli vengano compilati, characters a parte, dal personale)';
    assert.ok(inciso.length > 80, 'il fixture deve superare il tetto per essere un test valido');
    assert.deepEqual(findPromptPlaceholders(`Testo introduttivo ${inciso} a seguire.`), []);
  });

  it('un segnaposto vero, breve, resta visto anche col tetto di lunghezza', () => {
    assert.equal(findPromptPlaceholders('un sottotitolo (max 160 characters)').length, 1);
  });

  it('review #355: il tetto NON si applica a uno span esterno che contiene un sotto-span annidato', () => {
    // Riapre esattamente il rischio #2: senza l'esenzione, questo span esterno
    // (oltre 80 caratteri) veniva scartato dal tetto e restava visibile solo
    // il sotto-span interno "(160)", che non porta l'unita' di misura.
    const valore =
      'Testo introduttivo (nota editoriale estesa del traduttore incaricato che spiega il contesto e riporta un identificativo interno (160) per un massimo di characters previsti dallo schema originale del prompt condiviso con la redazione) fine.';
    const inciso = valore.slice(valore.indexOf('('), valore.lastIndexOf(')') + 1);
    assert.ok(inciso.length > 80, 'il fixture deve superare il tetto per essere un test valido');
    assert.equal(findPromptPlaceholders(valore).filter((h) => h.rule === 'budget-parenthetical').length, 1);
  });
});

describe('#350 — rischio 2: il segnaposto annidato dentro una parentesi esterna aggiunta dal traduttore', () => {
  it('segnaposto nello span esterno, fuori dal sotto-span annidato che lo precede', () => {
    // Con un solo `start` (non uno stack), l'apertura della parentesi interna
    // "(rif. interno)" sovrascriveva `start`; alla sua chiusura veniva
    // registrato SOLO l'inciso interno (senza cifra/unita'), e `start`
    // veniva azzerato — la parentesi esterna, che contiene il vero
    // "max 160 chars", non veniva mai registrata come span. Verificato che
    // questo fixture non trova nulla sull'algoritmo pre-#350 (`let start = -1`).
    const valore = 'Nota (vedi (rif. interno) — max 160 chars) fine.';
    assert.equal(findPromptPlaceholders(valore).filter((h) => h.rule === 'budget-parenthetical').length, 1);
  });

  it('due incisi consecutivi allo stesso livello (non annidati): il secondo resta visto', () => {
    const valore = 'Sottotitolo (vedi doc) con dati DALLA FONTE (max 160 chars) qui dentro.';
    assert.equal(findPromptPlaceholders(valore).filter((h) => h.rule === 'budget-parenthetical').length, 1);
  });
});

describe('il preambolo del prompt dentro il corpo (ristorni-frontalieri-…)', () => {
  const body = 'Testo giornalistico reale che parla dei ristorni e del tavolo Lombardia-Ticino, abbastanza lungo da non essere un moncone e da superare la soglia dei duecento caratteri che il riparatore pretende prima di riscrivere un campo.\n\nHEADLINE: Italia - Svizzera - Ristorni frontalieri\n\nRECENT ARTICLE IDS (last 50 of 3006 total — do NOT reuse): educatore-infanzia-ticino';

  it('e\' rilevato da due regole di scaffold', () => {
    const regole = findPromptPlaceholders(body).map((h) => h.rule).sort();
    assert.deepEqual(regole, ['scaffold-headline', 'scaffold-recent-article-ids']);
  });

  it('truncateAtPromptScaffold taglia al PRIMO marcatore', () => {
    const { value, removed } = truncateAtPromptScaffold(body);
    assert.ok(removed > 0);
    assert.ok(value.endsWith('prima di riscrivere un campo.'), `tagliato male: «…${value.slice(-40)}»`);
    assert.deepEqual(findPromptPlaceholders(value), []);
  });

  it('il percorso di SCRITTURA non tronca: lancia', () => {
    // Troncare in generazione pubblicherebbe come articolo la pagina di origine
    // che precede il marcatore. Lo si fa solo sul gia' pubblicato, dove
    // l'alternativa e' lasciarlo com'e'.
    assert.throws(
      () => sanitizePromptPlaceholders({ id: 'x', content: { it: { title: 'Titolo vero', body1: body } } }),
      /prompt-placeholder.*content\.it\.body1/s,
    );
  });
});

describe('etichette dello schema dentro il corpo — si tolgono, non si butta l\'articolo', () => {
  it('«1. **Domanda frequente 1**: …» (coworking-spazi-lugano.body3)', () => {
    const { value, stripped } = stripFaqNumberedLabels('1. **Domanda frequente 1**: Quali sono i servizi inclusi negli spazi di coworking a Lugano?');
    assert.equal(stripped, 1);
    assert.equal(value, '1. Quali sono i servizi inclusi negli spazi di coworking a Lugano?');
  });

  it('«- Domanda frequente 1: …» conserva lo spazio del bullet (violenza-sessuale-conseguenze-ticino.body3)', () => {
    const { value } = stripFaqNumberedLabels('## FAQ\n- Domanda frequente 1: Quali sono le conseguenze a lungo termine?');
    assert.equal(value, '## FAQ\n- Quali sono le conseguenze a lungo termine?');
  });

  it('NON tocca l\'etichetta nuda: quella va scartata, non ripulita', () => {
    assert.equal(stripFaqNumberedLabels('Domanda frequente 1').stripped, 0);
    assert.equal(stripFaqNumberedLabels('Domanda frequente 2?').stripped, 0);
  });

  it('l\'intestazione che ripete la descrizione dello schema (confronto-imposta-cantonale-svizzera-cantoni.body2)', () => {
    const body = '## Analisi pratica: implicazioni, confronti, scenari\n\nLe aliquote di imposta cantonale in Svizzera hanno un impatto significativo sulla vita di chi lavora in Svizzera.';
    const { value, stripped } = stripSchemaHeadingLine(body);
    assert.equal(stripped, 1);
    assert.ok(value.startsWith('Le aliquote'));
    assert.deepEqual(findPromptPlaceholders(value), []);
  });

  it('la stessa intestazione in Title Case (frontaliere-scelta-comune-residenza-…​.body2)', () => {
    const body = '### Analisi Pratica: Implicazioni, Confronti, Scenari\n\nLa scelta di una frontiera comune tra Italia e Svizzera comporta valutazioni fiscali diverse per ogni comune.';
    assert.equal(stripSchemaHeadingLine(body).stripped, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1b. FALSI POSITIVI — cio' che il guard NON deve toccare
// ═══════════════════════════════════════════════════════════════════════════

describe('i falsi positivi misurati sul corpus: `(max ` NON e\' un marcatore', () => {
  // Verbatim da `content/blog-body**`: 48 campi legittimi contengono `(max `.
  // Un guard che lo includesse rigetterebbe 48 articoli buoni — peggio del
  // difetto che ripara.
  const prosaLegittima = [
    'Economic compensation plan for Ticino businesses (max 15,000 CHF/year) approved by the Grand Council.',
    'Cross-border workers with a G permit can open a Swiss 3a account (max CHF 7,258 in 2026 for employees).',
    'Alcohol limit: 5 litres (max 18% alcohol) or 1 litre of spirits.',
    'Tax deduction: Up to 15% (max CHF 1,200) for security systems in 2026 tax return.',
    'Check availability of seats (max 50 participants).',
    'Submission of federation licenses (max 3 per team).',
    'Lettre de motivation (max 1 page)',
    'possono lavorare un numero limitato di ore per settimana (max 9 ore/giorno, 42 ore/settimana).',
    "Plan de compensation économique pour les entreprises tessinoises (max 15.000 CHF/an).",
    'In Italia, solo se documentato ed entro limiti specifici (max €2.500/anno per i frontalieri).',
  ];
  for (const testo of prosaLegittima) {
    it(`prosa: «${testo.slice(0, 50)}…»`, () => {
      assert.deepEqual(findPromptPlaceholders(testo), [], 'falso positivo su prosa legittima');
    });
  }

  it('cio\' che distingue il segnaposto e\' l\'UNITA\' di misura, non `(max `', () => {
    assert.deepEqual(findPromptPlaceholders('un bonus (max 160 CHF) per i pendolari'), []);
    assert.equal(findPromptPlaceholders('un sottotitolo (max 160 chars)').length, 1);
  });

  it('un articolo che PARLA di FAQ non viene toccato', () => {
    assert.deepEqual(findPromptPlaceholders('## Domande frequenti\n\nQuanto costa il permesso G?'), []);
    assert.deepEqual(findPromptPlaceholders('Le domande frequenti dei frontalieri riguardano soprattutto i ristorni.'), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1c. LE TRE VARIANTI SU CUI IL GUARD ERA VACUO (#295 → piano in #300)
// ═══════════════════════════════════════════════════════════════════════════
//
// #295 ha rimesso nel corpus i tre leak reali trovati in #208/#241 e ha
// rilanciato questa suite: **0 rossi su 85**. Non era un guard debole, era un
// guard che su quelle tre forme non guardava. #297 ne ha chiusa una (il campo
// `keywords`, che il gate SEO non scansionava affatto); le altre due sono
// arrivate qui col terzo matcher che la bonifica richiede per non peggiorare i
// campi che ripara.
//
// Ogni stringa qui sotto e' VERBATIM da produzione: e' la differenza fra
// provare il guard e provare la propria idea del guard.

describe('#300.1 — il budget in CODA al campo, senza parentesi (imposta-di-succesione… / chi-sono-i-frontalieri…)', () => {
  const reali = [
    ['it', 'Un ristorante in Lugano, Ticino, con camerieri in servizio. Max 125 char'],
    ['en', 'A restaurant in Lugano, Ticino, with waiters in service. Max 125 char'],
    ['de', 'Ein Restaurant in Lugano, Ticino, mit Bedienungen im Dienst. Max 125 Char'],
    ['fr', 'Un restaurant à Lugano, Ticino, avec des serveurs en service. Max 125 Char'],
    ['it/ch', 'Una galleria ferroviaria in Svizzera con una vista panoramica del lago di Lugano, con un treno in arrivo o in partenza. Max 125 char.'],
  ];
  for (const [locale, valore] of reali) {
    it(`${locale}: «…${valore.slice(-28)}»`, () => {
      const regole = findPromptPlaceholders(valore).map((h) => h.rule);
      assert.ok(regole.includes('budget-tail'), `non visto: ${regole.join(',') || 'nessuna regola'}`);
    });
  }

  it('le due regole preesistenti NON lo vedono — e\' questo il buco che #300 nomina', () => {
    const valore = reali[0][1];
    const regole = findPromptPlaceholders(valore).map((h) => h.rule);
    assert.ok(!regole.includes('budget-as-value'), 'il campo non e\' SOLO il budget');
    assert.ok(!regole.includes('budget-parenthetical'), 'il budget non e\' fra parentesi');
  });

  it('l\'ancora di sinistra: il budget deve APRIRE la clausola, non starci dentro', () => {
    // Prosa legittima che una regola senza ancora rigetterebbe. Nessuna di
    // queste compare oggi nel corpus, ma sono la forma in cui comparirebbe:
    // un articolo che spiega un modulo con un limite di caratteri.
    for (const legittimo of [
      'Il campo note del formulario accetta al massimo 500 caratteri.',
      'La motivazione va scritta in massimo 200 caratteri.',
      'Il riassunto deve contenere massimo 160 caratteri di testo utile.',
    ]) {
      assert.deepEqual(findPromptPlaceholders(legittimo), [], `falso positivo su: ${legittimo}`);
    }
  });

  it('la coda va tolta, non buttato il campo: resta un alt-text vero', () => {
    // La prova della scelta di `rebuildImageAlt` (repair-prompt-placeholders.mjs):
    // il testo davanti al budget e' contenuto buono.
    const stripped = 'Un ristorante in Lugano, Ticino, con camerieri in servizio';
    assert.deepEqual(findPromptPlaceholders(stripped), []);
  });
});

describe('#300.1 — `DALLA FONTE` e le sue traduzioni fuori dai letterali (trasferirsi-a-aprica-…)', () => {
  // Il template «trasferirsi a X da frontaliere» ha un proprio segnaposto che
  // non e' mai entrato in SCHEMA_PLACEHOLDER_LITERALS: qui non c'e' la prosa
  // italiana a cui i letterali sono ancorati, c'e' solo il marcatore.
  const reali = [
    ['it', "Trasferirsi ad Aprica da frontaliere: costi, tempi e servizi DALLA FONTE."],
    ['en', 'Moving to Aprica as a cross-border worker: costs, times and services FROM THE SOURCE.'],
    ['de', 'Umzug nach Aprica als Grenzgänger: Kosten, Zeiten und Dienstleistungen AUS DER QUELLE.'],
    ['fr', "Déménager à Aprica en tant que frontalier : coûts, délais et services DE LA SOURCE."],
  ];
  for (const [locale, valore] of reali) {
    it(`${locale}: «…${valore.slice(-24)}»`, () => {
      const regole = findPromptPlaceholders(valore).map((h) => h.rule);
      assert.ok(regole.includes('source-echo-allcaps'), `non visto: ${regole.join(',') || 'nessuna regola'}`);
      assert.deepEqual(
        regole.filter((r) => r.startsWith('schema-lead-')),
        [],
        'nessun letterale dello schema arriva qui: e\' il punto della regola',
      );
    });
  }

  it('MINUSCOLO e\' prosa legittima: 168 campi pubblicati lo contengono', () => {
    // La misura che decide la regola. Se un giorno qualcuno le togliesse il
    // vincolo di maiuscolo, questi tre diventerebbero rossi in produzione.
    for (const prosa of [
      'I dati provengono dalla fonte ufficiale del Cantone.',
      'Data from the source is public and verifiable.',
      "Les données de la source sont publiques.",
    ]) {
      assert.deepEqual(findPromptPlaceholders(prosa), [], `falso positivo su prosa: ${prosa}`);
    }
  });
});

describe('#300 (residuo misurato qui) — il campo che descrive SE STESSO (terzo-pilastro-3a-vantaggi-2026-basilea)', () => {
  const reali = [
    "Descrizione dell'immagine in italiano, massimo 125 caratteri",
    "Descrizione dell'immagine in tedesco, massimo 125 caratteri",
    "Descrizione dell'immagine in inglese, massimo 125 caratteri",
    "Descrizione dell'immagine in francese, massimo 125 caratteri",
  ];
  for (const valore of reali) {
    it(`«${valore.slice(0, 46)}…»`, () => {
      const regole = findPromptPlaceholders(valore).map((h) => h.rule);
      assert.ok(regole.includes('alt-field-description'), `non visto: ${regole.join(',') || 'nessuna regola'}`);
    });
  }

  it('senza questa regola la BONIFICA peggiorerebbe il campo invece di ripararlo', () => {
    // `budget-tail` da solo toglie la coda e lascia un segnaposto piu' corto
    // che nessun'altra regola vede. E' la ragione per cui la regola esiste:
    // cosi' il campo non e' riparabile per sottrazione e si ricade sul titolo.
    const codaTolta = "Descrizione dell'immagine in tedesco";
    assert.ok(
      findPromptPlaceholders(codaTolta).some((h) => h.rule === 'alt-field-description'),
      'il residuo della sottrazione deve restare visibile, altrimenti la bonifica pubblica un segnaposto',
    );
  });

  it('un corpo che PARLA della descrizione di un\'immagine non viene toccato', () => {
    assert.deepEqual(
      findPromptPlaceholders("Nel modulo va indicata anche la descrizione dell'immagine allegata alla domanda."),
      [],
    );
  });
});

describe('#300 punto 2 — il NOME del campo come token nudo della tag-list `keywords`', () => {
  // Il caso reale (`trasferirsi-a-marchirolo-...`, riparato nei DATI da #296 e
  // mai rilevabile prima di qui). Il buco non era nei letterali: e' la ricetta
  // di `optimizeSeoMetadata()`, che riderivano `keywords` da title+excerpt+id
  // in minuscolo e a token, buttando via la frase-schema attorno alla parola —
  // cioe' tutto cio' a cui i letterali si agganciano.
  const leak = 'frontalieri, ticino, svizzera, italia, trasferirsi, marchirolo, sottotitolo, contro';

  it('vede il token nudo dentro la tag-list', () => {
    const regole = findPromptPlaceholders(leak).map((h) => h.rule);
    assert.ok(regole.includes('schema-field-name-as-keyword'), `non visto: ${regole.join(',') || 'nessuna regola'}`);
  });

  it('vede anche le tre traduzioni, che sopravvivono alla traduzione del segnaposto', () => {
    for (const v of [
      'frontaliers, ticino, suisse, sous-titre, contre',
      'grenzgaenger, tessin, schweiz, untertitel, gegen',
      'cross-border, ticino, switzerland, subtitle, against',
    ]) {
      const regole = findPromptPlaceholders(v).map((h) => h.rule);
      assert.ok(regole.includes('schema-field-name-as-keyword'), `non visto su «${v}»: ${regole.join(',') || 'nessuna regola'}`);
    }
  });

  it('il gemello SANO dello stesso campo resta verde (la regola non e\' vacua)', () => {
    // Lo stesso campo dopo la bonifica di #296: sette token invece di otto, e
    // il buco e' esattamente dove stava la parola. Se questo diventasse rosso,
    // la regola starebbe matchando la tag-list, non il leak.
    assert.deepEqual(
      findPromptPlaceholders('frontalieri, ticino, svizzera, italia, trasferirsi, marchirolo, contro'),
      [],
    );
  });

  it('la prosa che parla DAVVERO di sottotitoli non viene toccata', () => {
    // Misurato sul corpus: 70 occorrenze legittime, tutte plurale o participio
    // dentro un corpo (film in lingua originale, HbbTV, corsi di lingua), e
    // nessuna di quelle nelle `keywords` dei rispettivi articoli.
    for (const prosa of [
      "Il film e' proiettato in lingua originale con sottotitoli in italiano.",
      'Die Sendung wird mit deutschen Untertiteln ausgestrahlt.',
      'The documentary is available with English subtitles.',
      'Le film est disponible avec des sous-titres en francais.',
    ]) {
      assert.deepEqual(findPromptPlaceholders(prosa), [], `falso positivo su prosa: ${prosa}`);
    }
  });

  it('i nomi di campo GENERICI restano fuori, ed e\' una scelta misurata', () => {
    // Allargare a `titolo`/`title`/`keyword` costerebbe 11 falsi positivi veri
    // nel corpus di oggi. Sono tag-list legittime: se un giorno qualcuno le
    // aggiunge alla regola, questi tre diventano rossi in produzione.
    for (const v of [
      'friborg-gotteron, allo, spareggio, titolo',
      'equipollenza, titolo, studio, italiano',
      'comco, apre, inchieste, keyword',
    ]) {
      assert.deepEqual(findPromptPlaceholders(v), [], `falso positivo su tag-list legittima: ${v}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. LOCK — il criterio segue il template, non viceversa
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ri-estrae i valori letterali dallo schema JSON che il prompt mostra al
 * modello. Ancorato alla riga «Genera JSON (no markdown, no code fences):» e
 * chiuso su «REGOLE FINALI:». Le coppie con un'interpolazione `${…}` sono
 * saltate: non sono segnaposto, sono valori calcolati.
 */
function extractSchemaLiterals(src) {
  const start = src.indexOf('Genera JSON (no markdown, no code fences):');
  assert.ok(start > 0, 'ancora dello schema JSON non trovata in create-article.mjs — il prompt e\' cambiato forma');
  const end = src.indexOf('\nREGOLE FINALI:', start);
  assert.ok(end > start, 'chiusura dello schema JSON non trovata');
  const block = src.slice(start, end);
  const out = [];
  const rx = /"([A-Za-z0-9_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = rx.exec(block)) !== null) {
    if (m[2].includes('${')) continue;
    out.push(m[2]);
  }
  return out;
}

describe('LOCK — se il template acquisisce un segnaposto, questo test diventa rosso', () => {
  const estratti = extractSchemaLiterals(createArticleSrc);

  it('lo schema del prompt espone almeno 20 valori letterali', () => {
    assert.ok(estratti.length >= 20, `estratti solo ${estratti.length} letterali: l'estrattore non sta leggendo lo schema`);
  });

  it('i letterali del modulo coincidono ESATTAMENTE con quelli del template', () => {
    const dalTemplate = [...new Set(estratti)].sort();
    const dalModulo = [...new Set(SCHEMA_PLACEHOLDER_LITERALS)].sort();
    assert.deepEqual(
      dalTemplate,
      dalModulo,
      'SCHEMA_PLACEHOLDER_LITERALS non e\' allineato al prompt di create-article.mjs.\n' +
        'Aggiungere/togliere un campo nello schema JSON richiede di aggiornare la lista nel modulo:\n' +
        'e\' proprio questo il controllo che impedisce al criterio di invecchiare.',
    );
  });

  it('OGNI letterale e\' visto da questo guard OPPURE dal classificatore degli slug', async () => {
    // I due sono complementari per costruzione: id e slugs non sono campi di
    // testo e hanno il loro classificatore, che copre anche le varianti
    // tradotte (`slug-inglese`) che una lista non vedrebbe.
    const scoperti = [];
    for (const literal of estratti) {
      if (hasPromptPlaceholder(literal)) continue;
      if (SLUG_OWNED_LITERALS.includes(literal)) continue;
      scoperti.push(literal);
    }
    assert.deepEqual(scoperti, [], 'letterali dello schema che nessun guard riconosce');
  });

  it('i letterali delegati allo slug guard sono davvero classificati da lui', async (t) => {
    // Import dinamico: create-article.mjs ha jsdom fra le dipendenze statiche,
    // quindi si carica solo se il modulo e' risolvibile. Se non lo e', il test
    // si dichiara saltato invece di fingere di aver verificato.
    //
    // E «si dichiara» vuol dire `t.skip()`, non `return` (issue #382 item 1).
    // Con il `return` il salto esisteva solo come riga su stderr: il runner
    // contava il caso come PASSATO — senza node_modules il file chiudeva 108
    // pass / 0 fail / 0 skipped — e l'unico strato che verifica davvero il
    // classificatore degli slug spariva dietro un verde pieno. Chi legge il
    // riassunto (o il gate che lo legge per lui) non aveva modo di accorgersene.
    let inspect;
    try {
      ({ inspectSlugForPromptPlaceholder: inspect } = await import('../scripts/create-article.mjs'));
    } catch (err) {
      t.skip(`slug guard non caricabile: ${err.code || err.message}`);
      return;
    }
    for (const literal of SLUG_OWNED_LITERALS) {
      assert.equal(inspect(literal).leaked, true, `lo slug guard non riconosce "${literal}"`);
    }
  });

  it('le etichette del preambolo sono ancora quelle che il prompt costruisce', () => {
    for (const label of PROMPT_SCAFFOLD_LABELS) {
      assert.ok(
        createArticleSrc.includes(label),
        `"${label}" non compare piu' in create-article.mjs: la regola scaffold punta nel vuoto`,
      );
    }
  });

  // Stessa disciplina delle etichette del preambolo: una lista scritta a mano
  // che non e' ancorata al template invecchia in silenzio. Qui l'ancora e' il
  // marcatore ITALIANO, che nel template c'e'; le altre tre sono traduzioni
  // OSSERVATE (#295, articolo `trasferirsi-a-aprica-…`) e per costruzione non
  // possono comparire in un prompt scritto in italiano.
  it('il marcatore ALL-CAPS e\' ancora quello che il template urla', () => {
    const italiano = SOURCE_ECHO_MARKERS[0];
    assert.ok(
      SCHEMA_PLACEHOLDER_LITERALS.some((l) => l.includes(italiano)),
      `"${italiano}" non compare piu' in nessun letterale dello schema: la regola source-echo-allcaps ` +
        'sta inseguendo un prompt che non esiste piu\', e le tre traduzioni con lei',
    );
    assert.ok(
      createArticleSrc.includes(italiano),
      `"${italiano}" non compare piu' in create-article.mjs`,
    );
  });

  it('ogni marcatore tradotto e\' ALL-CAPS: e\' il maiuscolo a fare il lavoro', () => {
    for (const marker of SOURCE_ECHO_MARKERS) {
      assert.equal(marker, marker.toUpperCase(), `${marker} non e' ALL-CAPS: la regola non lo distinguerebbe dalla prosa`);
    }
  });

  it('leadOf e\' deterministica e non degenera su nessun letterale', () => {
    for (const literal of SCHEMA_PLACEHOLDER_LITERALS) {
      const lead = leadOf(literal);
      assert.ok(lead.length >= 7, `lead troppo corto per "${literal}": "${lead}"`);
      assert.ok(literal.startsWith(lead), `lead non e' un prefisso di "${literal}"`);
      assert.equal(lead, leadOf(literal), 'non deterministica');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. WIRING — il guard e' invocato, e nel posto giusto
// ═══════════════════════════════════════════════════════════════════════════

describe('wiring — il guard e\' cablato sul percorso di scrittura CONDIVISO', () => {
  it('create-article.mjs importa il modulo', () => {
    assert.match(createArticleSrc, /from '\.\/lib\/prompt-placeholder-guard\.mjs'/);
  });

  it('sanitizePromptPlaceholders gira dentro registerArticleFiles()', () => {
    // Non in validate(): validate() e' UN produttore, e i quattro generatori
    // che importano registerArticleFiles direttamente non ci passano mai —
    // la forma esatta dell'incidente del 2026-08-09 sulla meta description.
    const i = createArticleSrc.indexOf('export async function registerArticleFiles');
    assert.ok(i > 0, 'registerArticleFiles non trovata');
    const corpo = createArticleSrc.slice(i, i + 2000);
    assert.ok(corpo.includes('sanitizePromptPlaceholders(data)'), 'guard non invocato in registerArticleFiles');
  });

  it('sanitizePromptPlaceholders gira anche nel flusso AI primario (generateAndValidateArticle)', () => {
    // Il flusso primario — main() → generateAndValidateArticle(), il
    // produttore piu' frequente del corpus (cron ogni ~30 min) — scrive i
    // file direttamente (modifyRouterTs/modifyBlogArticlesTsx) e non passa
    // MAI da registerArticleFiles(), che e' usata solo dai quattro
    // produttori secondari. Senza una chiamata anche qui un segnaposto
    // generato dal flusso quotidiano principale pubblicava senza essere
    // intercettato (review PR #196).
    const i = createArticleSrc.indexOf('async function generateAndValidateArticle');
    const j = createArticleSrc.indexOf('function slugifySlugPart');
    assert.ok(i > 0 && j > i, 'generateAndValidateArticle non trovata');
    const corpo = createArticleSrc.slice(i, j);
    assert.ok(corpo.includes('sanitizePromptPlaceholders(data)'), 'guard non invocato nel flusso AI primario');
    assert.ok(
      corpo.indexOf('translateArticle(data)') < corpo.indexOf('sanitizePromptPlaceholders(data)'),
      'il guard deve girare DOPO translateArticle(), altrimenti non vede i segnaposto propagati dalla traduzione',
    );
    assert.ok(
      corpo.indexOf('sanitizePromptPlaceholders(data)') < corpo.indexOf('modifyRouterTs(data)'),
      'il guard deve girare PRIMA della scrittura dei file',
    );
  });

  it('gira PRIMA di clampSeoDescriptions', () => {
    // Troncare a 160 caratteri un campo che E' il segnaposto lo renderebbe
    // solo un segnaposto piu' corto — e sotto il taglio la regola di forma
    // ancorata non lo vedrebbe piu'.
    const i = createArticleSrc.indexOf('export async function registerArticleFiles');
    const corpo = createArticleSrc.slice(i, i + 2000);
    assert.ok(
      corpo.indexOf('sanitizePromptPlaceholders(data)') < corpo.indexOf('clampSeoDescriptions(data)'),
      'il guard deve precedere il clamp',
    );
  });

  it('il filtro FAQ passa da cleanFaqPairs, non piu\' solo dalla lunghezza', () => {
    assert.ok(createArticleSrc.includes('cleanFaqPairs(rawFaq)'), 'il filtro FAQ non usa il guard');
    assert.ok(
      !/const validFaq = rawFaq\.filter/.test(createArticleSrc),
      'il vecchio filtro di sola FORMA e\' ancora al suo posto: una FAQ segnaposto lo supera',
    );
  });

  it('lo script di bonifica esiste e importa lo stesso modulo', () => {
    const repair = path.join(ROOT, 'generator', 'scripts', 'repair-prompt-placeholders.mjs');
    assert.ok(fs.existsSync(repair), 'repair-prompt-placeholders.mjs mancante');
    assert.match(fs.readFileSync(repair, 'utf-8'), /from '\.\/lib\/prompt-placeholder-guard\.mjs'/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// I TRE PRODUTTORI SENZA SLUG GUARD (issue #382 item 4)
//
// `create-article.mjs` chiama `inspectSlugForPromptPlaceholder` perche' li' lo
// slug lo PROPONE IL MODELLO: e' un campo dell'output JSON, e un segnaposto del
// prompt puo' uscire al suo posto (e' successo, PR #121). Gli altri tre
// produttori del corpus non lo chiamano, e la misura di #382 lo registra come
// 0/3. Ma la copertura mancante si misura sul rischio, non sulle chiamate: in
// questi tre lo slug non passa da nessun modello, e' scritto nel sorgente —
// due costanti letterali e un template che interpola solo la data ISO. Una
// guard aggiunta li' non potrebbe mai scattare: sarebbe rumore che invecchia.
//
// Quello che invece serve e' un OSSERVATORE della premessa. Questi test non
// verificano una guard: verificano che lo slug sia ancora un letterale. Il
// giorno in cui uno di questi tre lo costruisce da un output di modello, la
// costante letterale sparisce, questo blocco diventa rosso, e chi fa il cambio
// e' obbligato a decidere consapevolmente se aggiungere lo slug guard.
// ───────────────────────────────────────────────────────────────────────────

const SCRIPTS = path.join(ROOT, 'generator', 'scripts');
const leggiScript = (rel) => fs.readFileSync(path.join(SCRIPTS, rel), 'utf-8');
/** Le righe di CODICE che assegnano `slugs:` — i commenti non contano. */
const righeSlugs = (src) => src.split('\n').map((r) => r.trim()).filter((r) => r.startsWith('slugs:'));
/** Un valore di slug ammissibile: minuscole, cifre e trattini, e nessun segnaposto. */
function asseriscilSlugLetterale(valore, dove) {
  assert.match(valore, /^[a-z0-9-]+$/, `${dove}: "${valore}" non e' uno slug in forma canonica`);
  assert.deepEqual(findPromptPlaceholders(valore), [], `${dove}: segnaposto dentro uno slug letterale`);
}

describe('wiring — i tre produttori senza slug guard: lo slug non viene da un modello', () => {
  const EVERGREEN = [
    {
      produttore: 'generate-events-digest-article.mjs',
      contenuto: 'lib/events-digest-content.mjs',
      costante: 'DIGEST_ARTICLE_SLUGS',
    },
    {
      produttore: 'generate-border-wait-ranking-article.mjs',
      contenuto: 'lib/border-wait-ranking-content.mjs',
      costante: 'RANKING_ARTICLE_SLUGS',
    },
  ];

  for (const { produttore, contenuto, costante } of EVERGREEN) {
    it(`${produttore}: lo slug e' la costante letterale ${costante}`, () => {
      const srcProd = leggiScript(produttore);
      const srcCont = leggiScript(contenuto);
      assert.ok(srcProd.length > 1000 && srcCont.length > 1000, 'sorgente vuoto o troncato: il test passerebbe a vuoto');
      // 1. Il produttore prende gli slug SOLO dal builder, in un punto solo.
      assert.deepEqual(righeSlugs(srcProd), ['slugs: article.slugs,'],
        'il produttore assegna `slugs` da qualcosa che non e\' l\'articolo costruito dal builder');
      assert.ok(srcProd.includes(`from './${contenuto}'`), `il produttore non importa piu' ${contenuto}`);
      // 2. Il builder li prende dalla costante, senza toccarli.
      assert.ok(srcCont.includes(`slugs: { ...${costante} }`),
        `${contenuto} non costruisce piu' gli slug copiando ${costante}`);
      // 3. E la costante e' un letterale: quattro stringhe, nessuna interpolazione.
      const m = new RegExp(`export const ${costante} = \\{([^}]*)\\};`).exec(srcCont);
      assert.ok(m, `${costante} non e' piu' un oggetto letterale in ${contenuto}`);
      assert.ok(!m[1].includes('${'), `${costante} ha un'interpolazione: lo slug non e' piu' un letterale`);
      const valori = [...m[1].matchAll(/(\w+):\s*'([^']*)'/g)];
      assert.deepEqual(valori.map((x) => x[1]), ['it', 'en', 'de', 'fr']);
      for (const [, locale, valore] of valori) asseriscilSlugLetterale(valore, `${costante}.${locale}`);
    });
  }

  it('generate-daily-brief-article.mjs: lo slug e\' un template che interpola solo la data ISO', () => {
    const srcProd = leggiScript('generate-daily-brief-article.mjs');
    const srcCont = leggiScript('lib/daily-brief-content.mjs');
    assert.ok(srcProd.length > 1000 && srcCont.length > 1000, 'sorgente vuoto o troncato');
    // Il Bollettino e' l'unico dei tre con un id DATATO: il suo slug non puo'
    // essere una costante, ma resta calcolato — e la sola variabile ammessa e'
    // la data del giorno, che non viene da nessun modello.
    assert.ok(srcProd.includes("from './lib/daily-brief-content.mjs'"), 'il produttore non importa piu\' il builder');
    assert.deepEqual(righeSlugs(srcProd), [], 'il produttore ora assegna `slugs` per conto suo: non e\' piu\' il builder a deciderli');
    const prefisso = /export const DAILY_BRIEF_ID_PREFIX = '([a-z0-9-]+)';/.exec(srcCont);
    assert.ok(prefisso, 'DAILY_BRIEF_ID_PREFIX non e\' piu\' una stringa letterale');
    const corpo = /export function dailyBriefSlugs\(dateIso\) \{\n\s*return \{([\s\S]*?)\n\s*\};/.exec(srcCont);
    assert.ok(corpo, 'dailyBriefSlugs non ritorna piu\' un oggetto letterale');
    const interpolazioni = [...new Set([...corpo[1].matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1].trim()))];
    assert.deepEqual(interpolazioni, ['dateIso'],
      `dailyBriefSlugs interpola ${JSON.stringify(interpolazioni)}: qualcosa oltre alla data entra nello slug`);
    const voci = [...corpo[1].matchAll(/(\w+):\s*(?:`([^`]*)`|dailyBriefArticleId\(dateIso\))/g)];
    assert.deepEqual(voci.map((x) => x[0].split(':')[0]), ['it', 'en', 'de', 'fr']);
    for (const [, locale, template] of voci) {
      if (!template) continue; // `it` passa da dailyBriefArticleId, gia' coperto dal prefisso
      asseriscilSlugLetterale(template.replace('${dateIso}', '2026-01-02'), `dailyBriefSlugs.${locale}`);
    }
    asseriscilSlugLetterale(`${prefisso[1]}-2026-01-02`.replace('--', '-'), 'DAILY_BRIEF_ID_PREFIX');
  });
});

describe('sanitizePromptPlaceholders — le due risposte, di proposito diverse', () => {
  it('imageAlt segnaposto → ricostruito dal titolo, non un rifiuto', () => {
    const data = {
      id: 'x',
      imageAlt: { it: 'Max 125 caratteri', en: 'max 125 chars', de: 'Ok', fr: 'Ok' },
      content: { it: { title: 'Ristorni sospesi: cosa cambia' } },
    };
    const fixes = sanitizePromptPlaceholders(data);
    assert.equal(data.imageAlt.it, 'Immagine editoriale relativa a: Ristorni sospesi: cosa cambia');
    assert.equal(data.imageAlt.en, 'Editorial image related to: Ristorni sospesi: cosa cambia');
    assert.equal(data.imageAlt.de, 'Ok');
    assert.equal(fixes.filter((f) => f.action === 'imagealt-rebuilt').length, 2);
  });

  it('faq segnaposto → il campo sparisce', () => {
    const data = {
      id: 'x',
      content: {
        it: {
          title: 'T',
          faq: [
            { q: "Domanda frequente 1 basata sui fatti dell'articolo?", a: 'Risposta con dati DALLA FONTE. 50-100 parole.' },
            { q: 'Domanda frequente 2?', a: 'Risposta pratica basata sulla fonte.' },
          ],
        },
      },
    };
    sanitizePromptPlaceholders(data);
    assert.equal('faq' in data.content.it, false);
  });

  it('excerpt segnaposto → LANCIA (nessuna ricostruzione senza rischio di propagare il leak)', () => {
    assert.throws(
      () => sanitizePromptPlaceholders({ id: 'x', content: { it: { title: 'T', excerpt: 'Sottotitolo con dati concreti DALLA FONTE (max 160 chars)' } } }),
      /content\.it\.excerpt/,
    );
  });

  it('seo.description segnaposto → LANCIA', () => {
    assert.throws(
      () => sanitizePromptPlaceholders({ id: 'x', content: { it: { title: 'T' } }, seo: { description: 'Meta description 150-160 chars (HARD CAP: ≤ 160 caratteri)' } }),
      /seo\.description/,
    );
  });

  it('un articolo pulito passa senza modifiche', () => {
    const data = {
      id: 'x',
      imageAlt: { it: 'Un frontaliere alla dogana di Chiasso' },
      content: {
        it: {
          title: 'Ristorni sospesi: cosa cambia per i frontalieri',
          excerpt: 'Il Consiglio di Stato ticinese ha sospeso i ristorni alla Lombardia: oltre 50 milioni bloccati.',
          body1: 'Testo con un tetto di spesa (max 15.000 CHF/anno) approvato dal Gran Consiglio.',
          faq: [
            { q: 'Cosa significa la sospensione dei ristorni?', a: 'Significa che il Cantone non versa la quota dovuta ai comuni italiani di frontiera.' },
            { q: 'Quando riprenderanno i versamenti?', a: 'Non è ancora stata fissata una data: dipende dai colloqui fra Berna e Roma.' },
          ],
        },
      },
      seo: { description: 'Ristorni sospesi dal Ticino: cosa cambia per i frontalieri e per i comuni italiani.' },
    };
    const prima = JSON.stringify(data);
    assert.deepEqual(sanitizePromptPlaceholders(data), []);
    assert.equal(JSON.stringify(data), prima);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. GATE — zero offender pubblicati, e i due tassi misurati separatamente
// ═══════════════════════════════════════════════════════════════════════════

const unescapeTs = (s) => s.replace(/\\(.)/gs, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('gate — METADATI pubblicati (title/excerpt/imageAlt)', () => {
  const metaFiles = fs.readdirSync(path.join(ROOT, 'content')).filter((f) => /^blog-meta(-ch)?-(it|en|de|fr)\.ts$/.test(f));

  it('trova tutti e 8 i file meta (uno sparse checkout non deve passare a vuoto)', () => {
    assert.equal(metaFiles.length, 8);
  });

  const campi = [];
  for (const f of metaFiles) {
    const src = fs.readFileSync(path.join(ROOT, 'content', f), 'utf-8');
    const re = /'blog\.article\.([^.']+)\.(title|excerpt|imageAlt)'\s*:\s*'((?:\\'|[^'])*)'/g;
    let m;
    while ((m = re.exec(src)) !== null) campi.push({ f, id: m[1], field: m[2], value: unescapeTs(m[3]) });
  }

  it('legge piu\' di 40.000 campi (idem: niente passaggio a vuoto)', () => {
    assert.ok(campi.length > 40000, `letti solo ${campi.length} campi`);
  });

  it('zero segnaposto — tasso di falsi positivi 0 su questa superficie', () => {
    const offenders = campi
      .filter((c) => hasPromptPlaceholder(c.value))
      .map((c) => `${c.f} ${c.id}.${c.field} = ${JSON.stringify(c.value.slice(0, 70))}`);
    assert.deepEqual(offenders, []);
  });
});

describe('gate — CORPI e FAQ pubblicati (body1..N, faq)', () => {
  const files = [...walk(path.join(ROOT, 'content', 'blog-body')), ...walk(path.join(ROOT, 'content', 'blog-body-ch'))];

  it('trova piu\' di 10.000 file body (idem)', () => {
    assert.ok(files.length > 10000, `trovati solo ${files.length} file body`);
  });

  const campi = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf-8');
    const re = /'blog\.article\.([^']+)\.(body\d+|faq)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = re.exec(src)) !== null) campi.push({ f: path.relative(ROOT, f), id: m[1], field: m[2], value: unescapeTs(m[3]) });
  }

  it('legge piu\' di 50.000 campi body/faq (idem)', () => {
    assert.ok(campi.length > 50000, `letti solo ${campi.length} campi`);
  });

  it('zero segnaposto — tasso di falsi positivi 0 su questa superficie', () => {
    const offenders = campi
      .filter((c) => hasPromptPlaceholder(c.value))
      .map((c) => `${c.f} [${c.field}] ${JSON.stringify(c.value.slice(0, 70))}`);
    assert.deepEqual(offenders, []);
  });

  it('nessuna FAQ pubblicata contiene una coppia segnaposto', () => {
    const offenders = [];
    for (const c of campi.filter((x) => x.field === 'faq')) {
      let pairs;
      try {
        pairs = JSON.parse(c.value);
      } catch {
        continue;
      }
      // Solo i drop per SEGNAPOSTO: le coppie corte tradotte sono un difetto
      // di un altra classe e non sono cio che questo gate misura.
      const { dropped } = cleanFaqPairs(pairs, { dropShort: false });
      if (dropped.length) offenders.push(`${c.f}: ${dropped.length} coppie (${dropped[0].reason})`);
    }
    assert.deepEqual(offenders, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. GATE — la FAQ orfana, che il gate qui sopra NON puo' vedere
// ═══════════════════════════════════════════════════════════════════════════
//
// Il gate dei segnaposto guarda il TESTO, e su una traduzione non trova nulla
// da guardare: il segnaposto e' passato dal traduttore e non e' piu' un
// letterale dello schema. Restava quindi verde mentre 57 chiavi `faq` orfane
// (19 articoli × en/de/fr, lasciate dalla bonifica #196 che aveva ripulito solo
// `it`) tenevano ROSSO il job `tests` del sito — `tests/i18n-completeness.test.ts`,
// «consistent keys across all locales» — e con esso ogni PR aperta, perche'
// `pr-review-loop` parte solo su `tests` verde.
//
// Il criterio e' strutturale e non testuale, quindi vale anche per una FAQ `it`
// tolta per una causa che qui non c'entra. E' il gate mancante: sul sito il
// difetto arriva come rosso di TUTTE le PR, qui come una lista di file.
describe('gate — nessuna FAQ orfana: en/de/fr non possono avere una faq che `it` non ha', () => {
  const LOCALI = ['it', 'en', 'de', 'fr'];
  const RADICI = ['blog-body', 'blog-body-ch'];
  // Ancorata all'id del filename, non alla prima chiave `.faq` del file: stesso
  // anti-pattern gia' corretto in `faqQuestionsInBodyText` per #289 — senza
  // l'ancora una `.faq` di un id estraneo verrebbe attribuita a `id`.
  const hasFaqIn = (p, id) => {
    if (!fs.existsSync(p)) return false;
    const idPart = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`'blog\\.article\\.${idPart}\\.faq'\\s*:`).test(fs.readFileSync(p, 'utf-8'));
  };

  const articoli = [];
  for (const radice of RADICI) {
    const itDir = path.join(ROOT, 'content', radice, 'it');
    if (!fs.existsSync(itDir)) continue;
    for (const name of fs.readdirSync(itDir).filter((f) => f.endsWith('.ts'))) {
      const id = name.slice(0, -3);
      const byLocale = Object.fromEntries(LOCALI.map((l) => {
        const p = path.join(ROOT, 'content', radice, l, name);
        return [l, { hasFile: fs.existsSync(p), hasFaq: hasFaqIn(p, id) }];
      }));
      articoli.push({ rel: `${radice}/…/${name}`, byLocale });
    }
  }

  // Il pavimento anti-falso-verde: `content/blog-body**` e' fuori da ogni
  // worktree sparse di questo repo, e uno scan su zero articoli passerebbe.
  it('enumera piu\' di 3.000 articoli (altrimenti e\' un checkout sparse)', () => {
    assert.ok(articoli.length > 3000, `enumerati solo ${articoli.length} articoli`);
  });

  it('zero FAQ orfane', () => {
    const offenders = articoli
      .map((a) => ({ rel: a.rel, orfane: orphanFaqLocales(a.byLocale) }))
      .filter((a) => a.orfane.length)
      .map((a) => `${a.rel}: faq presente in ${a.orfane.join(',')} e assente in it`);
    assert.deepEqual(offenders, []);
  });
});

describe('gate — SEO pubblicato (content/seo/seo-blog*.ts)', () => {
  const seoDir = path.join(ROOT, 'content', 'seo');
  const files = fs.readdirSync(seoDir).filter((x) => /^seo-blog.*\.ts$/.test(x));

  it('trova almeno 5 file seo (idem)', () => {
    assert.ok(files.length >= 5, `trovati solo ${files.length} file seo`);
  });

  // `keywords` e' un campo di testo dello schema (letterale '6-8 keywords IT') e
  // un leak ci passava indisturbato: #295 misura 0/85 rossi con `sottotitolo`
  // incollato a `keywords` di `trasferirsi-a-marchirolo-…`, perche' questo gate
  // non lo guardava affatto — non un problema di regola, un campo mai scansionato.
  it('zero segnaposto in description/ogDescription/caption e nei gemelli JSON', () => {
    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(seoDir, f), 'utf-8');
      let m;
      const ts = /(?:^|\n)\s*(title|description|keywords|ogTitle|ogDescription|twitterTitle|twitterDescription):\s*'((?:\\'|[^'])*)'/g;
      while ((m = ts.exec(src)) !== null) {
        if (hasPromptPlaceholder(unescapeTs(m[2]))) offenders.push(`${f} [${m[1]}] ${JSON.stringify(m[2].slice(0, 70))}`);
      }
      const json = /"(headline|description|caption)":\s*"((?:\\"|[^"])*)"/g;
      while ((m = json.exec(src)) !== null) {
        if (hasPromptPlaceholder(m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\'))) offenders.push(`${f} [sd.${m[1]}] ${JSON.stringify(m[2].slice(0, 70))}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe('coerenza interna delle regole', () => {
  it('nessun id di regola duplicato', () => {
    const ids = PLACEHOLDER_RULES.map((r) => r.id);
    assert.deepEqual([...new Set(ids)], ids, 'due regole con lo stesso id: il conteggio per regola sarebbe falso');
  });

  it('ogni regola ha un `why` non vuoto', () => {
    for (const r of PLACEHOLDER_RULES) assert.ok(r.why && r.why.length > 30, `regola ${r.id} senza motivazione`);
  });

  it('nessuna regola scatta sulla stringa vuota o su testo neutro', () => {
    for (const testo of ['', '   ', 'Il permesso G si rinnova ogni anno.']) {
      assert.deepEqual(findPromptPlaceholders(testo), [], `regola troppo larga su ${JSON.stringify(testo)}`);
    }
  });
});

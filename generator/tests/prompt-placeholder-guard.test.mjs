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

  // Questa e' la PREMESSA di `orphanFaqLocales`, e va tenuta rossa se cade:
  // se un giorno `cleanFaqPairs` imparasse le tre lingue, la regola strutturale
  // resterebbe corretta ma non sarebbe piu' l'unica via.
  for (const [locale, pairs] of Object.entries(TRADOTTE)) {
    it(`cleanFaqPairs NON vede il segnaposto in '${locale}': i letterali dello schema sono italiani`, () => {
      const { dropped } = cleanFaqPairs(pairs, { dropShort: false });
      assert.deepEqual(dropped, [], `se questo scarta qualcosa, la motivazione di orphanFaqLocales e' cambiata`);
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

  it('en/de/fr li vede SOLO la regola di forma, non un letterale', () => {
    for (const [locale, valore] of casi.slice(1)) {
      const regole = findPromptPlaceholders(valore).map((h) => h.rule);
      assert.deepEqual(regole, ['budget-parenthetical'], `${locale}: atteso solo budget-parenthetical, trovato ${regole.join(',')}`);
    }
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

  it('i letterali delegati allo slug guard sono davvero classificati da lui', async () => {
    // Import dinamico: create-article.mjs ha jsdom fra le dipendenze statiche,
    // quindi si carica solo se il modulo e' risolvibile. Se non lo e', il test
    // si dichiara saltato invece di fingere di aver verificato.
    let inspect;
    try {
      ({ inspectSlugForPromptPlaceholder: inspect } = await import('../scripts/create-article.mjs'));
    } catch (err) {
      console.error(`  ⏭️  slug guard non caricabile (${err.code || err.message}) — verifica saltata`);
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

  it('zero segnaposto in description/ogDescription/caption e nei gemelli JSON', () => {
    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(seoDir, f), 'utf-8');
      let m;
      const ts = /(?:^|\n)\s*(title|description|ogTitle|ogDescription|twitterTitle|twitterDescription):\s*'((?:\\'|[^'])*)'/g;
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

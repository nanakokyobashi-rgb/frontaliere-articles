/**
 * news-scan-section-gates.test.mjs — Fase 1 must filter for the section it is
 * generating for.
 *
 * WHAT WAS BROKEN, MEASURED
 *
 * `scanNewsSources` runs two drops (`filterByAnchor`) and one truncation
 * (`prioritizeFrontalieriHeadlines`) over the raw headline pool. All three
 * were written for the `frontaliere` section and none of them read
 * `IS_FRONTALIERE`, so the `svizzera` section — national by design, whose own
 * classifier prompt opens with "NON sei limitato ai frontalieri" — was being
 * filtered with a cross-border lexicon.
 *
 * Measured 2026-08-10 on 538 real headlines fetched from the reachable
 * NEWS_SOURCES_SVIZZERA:
 *
 *     anchor-gate pass ................. 495 / 538
 *     + TOPICAL_KEYWORDS ...............  77 / 495   (16%)
 *     + SVIZZERA_TOPICAL_KEYWORDS ...... 188 / 495   (38%)
 *
 * and the direction of the error mattered more than the size. Dropped under
 * the frontaliere lexicon: "Svizzera: PIL in crescita", "L'export svizzero in
 * ripresa", "BNS in perdita di mezzo miliardo", "Il franco sempre più forte",
 * "Impennata dei fallimenti in Svizzera", "Iniziativa 10 milioni", "Siccità,
 * aiuti federali per l'agricoltura". Kept: "Il lavoro mortale dei giornalisti
 * in Messico" and "Disinformazione russa colpisce in Francia" — they contain
 * `lavor`. The gate was not merely tight, it was aimed elsewhere, and the pool
 * it produced was rejected 100% by the classifier in run after run.
 *
 * WHAT THIS PINS
 *
 * The claim is symmetric and both halves have to hold, or the fix is a
 * regression in the other direction: national headlines that used to die must
 * survive on `svizzera`, AND cronaca / culture / foreign filler must keep
 * falling on both sections. Loosening until everything passes reintroduces the
 * film-festival articles that burn a whole LLM generation before REGOLA #0
 * rejects them (observed run 31402084443, two generations wasted).
 *
 * EXTRACTION, not import: `create-article.mjs` pulls the whole generator
 * closure (sharp/undici/…) and this repo has no `node_modules` — the same
 * reason blog-title-casing.test.mjs and evergreen-brief-section-aware.test.mjs
 * use this technique. `hasDomainAnchor` IS imported for real: it is the
 * production regex plus the municipality sets, and a re-implementation here
 * could stay green while production drops everything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasDomainAnchor } from '../scripts/lib/discovery/domainAnchor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const SRC = readFileSync(CREATE_ARTICLE, 'utf-8');

/**
 * Slice [startMarker … endMarker] inclusive, loudly if any delimiter moved.
 * `through` forces the slice past an intermediate declaration, so a block that
 * happens to contain an earlier closing brace is not cut short.
 */
function slice(startMarker, endMarker, through) {
  const start = SRC.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`delimitatore iniziale non trovato in create-article.mjs: ${JSON.stringify(startMarker)} — aggiornare questo test`);
  }
  let from = start + startMarker.length;
  if (through) {
    const mid = SRC.indexOf(through, from);
    if (mid === -1) {
      throw new Error(`delimitatore intermedio non trovato dopo ${JSON.stringify(startMarker)}: ${JSON.stringify(through)} — aggiornare questo test`);
    }
    from = mid + through.length;
  }
  const end = SRC.indexOf(endMarker, from);
  if (end === -1) {
    throw new Error(`delimitatore finale non trovato dopo ${JSON.stringify(startMarker)}: ${JSON.stringify(endMarker)} — aggiornare questo test`);
  }
  return SRC.slice(start, end + endMarker.length);
}

// The lexicons + the two predicates that read them. One contiguous block, and
// it has to run past `sectionTopicalKeywords` to reach `countTopicalHits`.
const LEXICON_SRC = slice('const TOPICAL_KEYWORDS = [', '\n}\n', 'function countTopicalHits(');
// `filterByAnchor` is a closure inside scanNewsSources; the two env consts it
// closes over sit immediately above it, so the block starts there.
const FILTER_SRC = slice('const dropAnchorless = ', '\n  };\n');
// The boost/truncate pass.
const PRIORITIZE_SRC = slice('const FRONTALIERI_KEYWORDS = [', '\n}\n');

assert.match(LEXICON_SRC, /function countTopicalHits\(/, 'il blocco lessico deve arrivare fino a countTopicalHits — delimitatori da aggiornare');
assert.match(FILTER_SRC, /const filterByAnchor = \(list\) => \{/, 'il blocco filtro deve contenere filterByAnchor — delimitatori da aggiornare');
assert.match(PRIORITIZE_SRC, /function prioritizeFrontalieriHeadlines\(/, 'il blocco prioritize deve contenere la funzione — delimitatori da aggiornare');

/**
 * Evaluates the three blocks with the module-scope names they close over
 * injected, for one section.
 */
function loadGates(section) {
  const isFrontaliere = section === 'frontaliere';
  const logs = [];
  const runReport = { headlines: {} };
  const api = new Function(
    'IS_FRONTALIERE',
    'SECTION_NAME',
    'hasDomainAnchor',
    'RUN_REPORT',
    'console',
    `${LEXICON_SRC}\n${FILTER_SRC}\n${PRIORITIZE_SRC}\nreturn {
       TOPICAL_KEYWORDS, SVIZZERA_TOPICAL_KEYWORDS, FRONTALIERI_KEYWORDS,
       FRONTALIERE_ADMISSION_KEYWORDS,
       hasTopicalSignal, countTopicalHits, filterByAnchor,
       hasAdmissionSignal, countAdmissionHits,
       prioritizeFrontalieriHeadlines,
     };`,
  )(
    isFrontaliere,
    section,
    hasDomainAnchor,
    runReport,
    { error: (...a) => logs.push(a.join(' ')) },
  );
  return { ...api, logs, runReport };
}

const FRONT = loadGates('frontaliere');
const CH = loadGates('svizzera');

// URLs are opaque on purpose, and that is not a shortcut: rsi.ch — the source
// that carries most of this section's pool — publishes every article under
// `/s/<id>`, so the topical decision rests on the headline alone, while the
// `.ch` host is what satisfies the anchor. Fixtures with a `/economia/` path
// would smuggle a `economi` hit into the URL and quietly prove nothing.
let _id = 3940000;
const h = (headline) => ({ headline, url: `https://www.rsi.ch/s/${_id++}` });

// ── The corpus. Real headlines from the 2026-08-10 fetch, verbatim. ────────

// National agenda: the classifier prompt for `svizzera` lists economy, federal
// tax, health insurance, cost of living, votes, BNS, federal statistics.
// Every one of these was dropped by the frontaliere topical lexicon.
const NATIONAL = [
  h('Svizzera: PIL in crescita'),
  h('L’export svizzero in ripresa nel secondo trimestre, ma giugno è in rosso'),
  h('BNS in perdita di mezzo miliardo nel primo trimestre'),
  h('Il franco sempre più forte: ai massimi di sempre sull’euro'),
  h('Impennata dei fallimenti in Svizzera nel 2025'),
  h('Leggero aumento dei prezzi in Svizzera'),
  h('KOF, prospettive congiunturali 2026 incoraggianti'),
  h('Iniziativa 10 milioni: il limite demografico ha spaventato gli elettori'),
  h('Rösti: gli obiettivi climatici rischiano di non venir rispettati'),
  h('Siccità, aiuti federali per l’agricoltura'),
  h('Dazi USA, Parmelin: “Attendiamo segnali da Washington”'),
  h('La RUAG ha ceduto al ricatto degli hacker'),
];

// Cronaca, culture, sport, weather, foreign filler. These must keep falling on
// BOTH sections: they are what the topical gate exists for.
const EXTRANEOUS = [
  h('A Basilea sono nati sei “ghepardini”'),
  h('Circo Knie, motociclista si ferisce durante un numero'),
  h('Grigioni, morto un parapendista 24enne'),
  h('L’incredibile amicizia tra un uomo e una leonessa'),
  h('Vespe sempre più presenti nelle case svizzere'),
  h('Berna, stop alle esercitazioni dei pompieri con fuoco vero'),
];

// ── 1. The lexicon is chosen by section ───────────────────────────────────

test('svizzera: national headlines the frontaliere lexicon drops now survive', () => {
  const survived = [];
  const stillDropped = [];
  for (const item of NATIONAL) {
    const text = `${item.headline} ${item.url}`;
    assert.equal(
      FRONT.hasTopicalSignal(text), false,
      `il corpus di questo test vale solo se "${item.headline}" cade davvero sotto il lessico frontaliere — se ora passa, il corpus va rinnovato`,
    );
    (CH.hasTopicalSignal(text) ? survived : stillDropped).push(item.headline);
  }
  assert.deepEqual(
    stillDropped, [],
    'ogni headline di agenda nazionale deve superare il gate topicale sulla sezione svizzera',
  );
  assert.equal(survived.length, NATIONAL.length);
});

test('extraneous headlines keep falling on BOTH sections — this is not a blanket loosening', () => {
  for (const item of EXTRANEOUS) {
    const text = `${item.headline} ${item.url}`;
    assert.equal(FRONT.hasTopicalSignal(text), false, `frontaliere: "${item.headline}" non deve passare`);
    assert.equal(CH.hasTopicalSignal(text), false, `svizzera: "${item.headline}" non deve passare`);
  }
});

test('the frontaliere lexicon is untouched — the national list extends it, never replaces it', () => {
  for (const k of FRONT.TOPICAL_KEYWORDS) {
    assert.ok(
      CH.SVIZZERA_TOPICAL_KEYWORDS.includes(k),
      `la sezione nazionale non può essere più stretta di quella frontaliere: manca "${k}"`,
    );
  }
  assert.ok(
    CH.SVIZZERA_TOPICAL_KEYWORDS.length > FRONT.TOPICAL_KEYWORDS.length,
    'la lista nazionale deve aggiungere qualcosa',
  );
  // A frontaliere headline must still read as topical on the frontaliere
  // section: the extension must not have shifted the default.
  assert.equal(FRONT.hasTopicalSignal('Ristorni ai frontalieri, nuovo accordo fiscale'), true);
});

// ── 2. Substring traps ────────────────────────────────────────────────────
//
// The lexicons are matched with `String.includes`, so a stem like `oro` would
// fire on "lavoro" and `utile` on "inutile". The national list was written
// around those; without this test the next person to extend it has no way to
// know that constraint exists.

test('the national lexicon avoids the Italian substring traps', () => {
  for (const trap of ['oro', 'utile', 'fusion', 'import', 'volo', 'legge', 'cure', 'interess', 'divis', 'pil']) {
    assert.ok(
      !CH.SVIZZERA_TOPICAL_KEYWORDS.includes(trap),
      `"${trap}" è uno stem-trappola (matcha lavoro/inutile/confusione/importante/volontario/leggere/sicure): usare una forma più lunga`,
    );
  }
  assert.equal(
    CH.hasTopicalSignal('Una polemica inutile e la confusione totale'), false,
    'inutile/confusione non devono essere letti come segnale economico',
  );
  assert.equal(
    CH.hasTopicalSignal('Un volontario racconta: è importante leggere le regole'), false,
    'volontario/importante/leggere non devono essere letti come segnale economico',
  );
});

// ── 3. filterByAnchor end to end ──────────────────────────────────────────

test('filterByAnchor: the same mixed pool yields the national agenda on svizzera and nothing on frontaliere', () => {
  const pool = [...NATIONAL, ...EXTRANEOUS];

  const keptCH = CH.filterByAnchor(pool).map(x => x.headline);
  const keptFront = FRONT.filterByAnchor(pool).map(x => x.headline);

  assert.deepEqual(keptCH, NATIONAL.map(x => x.headline));
  assert.deepEqual(keptFront, [], 'sulla sezione frontaliere questo pool nazionale resta correttamente vuoto');
});

test('filterByAnchor: the anchor drop still applies on the national section', () => {
  // Italian-domestic items from fiscoetasse.com / lavoroediritti.com. They are
  // topical under both lexicons (fisco, lavoro) and have no Swiss nexus at
  // all, so it is the ANCHOR that has to stop them — requiring one is correct
  // for a Swiss national section, which is why that drop was left in place.
  const italianDomestic = [
    {
      headline: 'Assegno di Inclusione, ricarica prima di Ferragosto: ecco chi riceve il pagamento',
      url: 'https://www.lavoroediritti.com/soldi-e-diritti/assegno-inclusione',
    },
    {
      headline: 'Ravvedimento operoso solo per errori e omissioni',
      url: 'https://www.fiscoetasse.com/new-rassegna-stampa/4384-ravvedimento',
    },
  ];
  for (const item of italianDomestic) {
    assert.equal(hasDomainAnchor(`${item.headline} ${item.url}`), false, 'presupposto del test: nessun ancoraggio svizzero');
  }
  assert.deepEqual(CH.filterByAnchor(italianDomestic), []);
  assert.deepEqual(FRONT.filterByAnchor(italianDomestic), []);
});

test('filterByAnchor names the lexicon it used, so a section mismatch is visible in the log', () => {
  const fresh = loadGates('svizzera');
  fresh.filterByAnchor(EXTRANEOUS);
  const topicalLine = fresh.logs.find(l => l.includes('Topical-gate'));
  assert.ok(topicalLine, 'il topical-gate deve loggare gli scarti');
  assert.match(
    topicalLine, /nazionale: svizzera/,
    'la riga diceva "lavoro/fisco/permess/…" anche sulla sezione nazionale: è così che il mismatch è rimasto invisibile per 224 run di log',
  );
});

// ── 4. prioritizeFrontalieriHeadlines ─────────────────────────────────────

test('prioritizeFrontalieriHeadlines is a no-op on the national section', () => {
  // Ten frontalieri hits is the MIN_BOOSTED threshold: above it the function
  // DROPS every non-boosted headline. On the national section that would hand
  // the pool to precisely the topics its classifier prompt rejects by
  // construction ("appartengono a una sezione separata") — a guaranteed total
  // rejection downstream.
  const pool = [
    ...Array.from({ length: 10 }, (_, i) => h(`Frontalieri, ristorni ${i}`)),
    h('Svizzera: PIL in crescita'),
    h('BNS in perdita di mezzo miliardo'),
  ];

  assert.deepEqual(
    CH.prioritizeFrontalieriHeadlines(pool), pool,
    'la sezione nazionale deve ricevere il pool intatto, nello stesso ordine',
  );

  // …and the frontaliere path must still truncate, or the early return has
  // quietly disabled the boost for the section that needs it.
  const keptFront = FRONT.prioritizeFrontalieriHeadlines(pool);
  assert.equal(keptFront.length, 10);
  assert.ok(keptFront.every(x => x._frontalieriBoosted));
});

// ── 5. Admission vs ranking lexicon (issue #189) ────────────────────────────
//
// TOPICAL_KEYWORDS admits events/culture content (festival, sagra, …) that
// the downstream frontaliere-density gate (REGOLA #0) has no words for, so a
// Locarno-Film-Festival-shaped source paid for a full generation before
// being rejected. The admission lexicon must exclude those 8 tokens while
// the ranking lexicon (TOPICAL_KEYWORDS itself) keeps them, since they are
// data-justified for ranking real traffic.

test('the admission lexicon drops the events/culture tokens the ranking lexicon keeps', () => {
  const eventsCultureTokens = [
    'festival', 'sagra', 'mercatin', 'fiera', 'manifestazion',
    'spettacol', 'rassegna', 'concert',
  ];
  for (const tok of eventsCultureTokens) {
    assert.ok(FRONT.TOPICAL_KEYWORDS.includes(tok), `presupposto del test: "${tok}" deve restare nella lista di ranking`);
    assert.ok(
      !FRONT.FRONTALIERE_ADMISSION_KEYWORDS.includes(tok),
      `"${tok}" non deve ammettere un candidato: il gate a valle (REGOLA #0) lo rigetta comunque`,
    );
  }
});

test('a headline that only matches an events/culture token ranks as topical but is not admitted, on frontaliere', () => {
  const text = 'Ecco i vincitori del Locarno Film Festival 2026 https://www.laregione.ch/culture/locarno-film-festival';
  assert.equal(
    FRONT.hasTopicalSignal(text), true,
    'presupposto del test: il gate di ranking legacy considera questo candidato topico (bug di #189)',
  );
  assert.equal(
    FRONT.hasAdmissionSignal(text), false,
    'il gate di ammissione non deve pagare una generazione che REGOLA #0 rigetterà comunque',
  );
});

test('filterByAnchor on frontaliere now drops a festival headline it used to admit', () => {
  const festival = h('Ecco i vincitori di Open Doors 2026, tra fiere e rassegne culturali a Locarno');
  const kept = FRONT.filterByAnchor([festival]);
  assert.deepEqual(kept, [], 'un candidato solo-eventi non deve superare l\'ammissione sulla sezione frontaliere');
});

test('admission is unchanged on svizzera: no downstream density gate exists there for events/culture', () => {
  const text = 'Grande festival internazionale a Zurigo, fiera con migliaia di visitatori';
  assert.equal(
    CH.hasAdmissionSignal(text), CH.hasTopicalSignal(text),
    'la sezione nazionale non ha un gate REGOLA #0 sulla density frontaliere: ammissione e ranking restano la stessa lista',
  );
});

test('a genuine frontaliere headline is still admitted, not just ranked', () => {
  assert.equal(FRONT.hasAdmissionSignal('Ristorni ai frontalieri, nuovo accordo fiscale'), true);
});

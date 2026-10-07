/**
 * redflag-important-marker — un `🔴 Important` CITATO non e' il marker della riga.
 *
 * ## Il difetto che copre (PR #909)
 *
 * `REDFLAG_IMPORTANT_RE` girava sul body intero della review senza distinguere un
 * marker dal testo che lo riporta. Sulla PR #909 una review con
 * `## Findings (Important: 0, Nit: 3)` e `## LGTM` regolari citava un marker dentro
 * il testo di un proprio nit, e il review gate rendeva ROSSA una PR approvata:
 * `review-gate: l'ultima review del bot non e' approvante`. La PR e' rimasta ferma
 * su quel falso rosso.
 *
 * E' la TERZA variante della stessa classe. Il rimedio precedente (#3330,
 * pretendere la punteggiatura dopo "Important") non la copre, perche' il marker
 * citato porta anche lui i due punti. Il discriminante non e' il vocabolario ma la
 * POSIZIONE NELLA STRUTTURA: un marker APRE la riga del proprio finding, una
 * citazione sta dentro la riga di un ALTRO finding o dentro un code span.
 *
 * ## Le due direzioni
 *
 * Una fix che spegne il gate sarebbe peggio del falso positivo che chiude, quindi
 * ogni caso «citazione → verde» qui sotto ha il suo gemello «marker vero → rosso»,
 * e la coerenza col conteggio dichiarato e' asserita in entrambe le direzioni. Il
 * conteggio e' l'ORACOLO del test, non un ingresso del gate: potrebbe spostare un
 * verdetto solo da rosso a verde, cioe' esattamente nella direzione che spegne.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { REDFLAG_IMPORTANT_RE } from '../../scripts/ci/lib/constants.mjs';

// --- forme storiche: nessuna regressione -----------------------------------
test('matcha la forma letterale', () => {
  assert.equal(REDFLAG_IMPORTANT_RE.test('🔴 Important: missing canonical'), true);
});

test('matcha la forma in grassetto che ruppe il gate letterale (PR #2211)', () => {
  assert.equal(REDFLAG_IMPORTANT_RE.test('🔴 **Important —** sibling non spazzato'), true);
  assert.equal(REDFLAG_IMPORTANT_RE.test('🔴**Important**: regressione'), true);
});

test('NON matcha la prosa di negazione senza delimitatore (PR #3330)', () => {
  assert.equal(REDFLAG_IMPORTANT_RE.test('Correction: zero 🔴 Important findings (both nits are non-blocking).\n\n## LGTM'), false);
  assert.equal(REDFLAG_IMPORTANT_RE.test('Nessun 🔴 trovato — tutto pulito.\n\n## LGTM'), false);
});

// --- terza variante: il marker citato (PR #909) -----------------------------
// Verbatim dalla review della PR #909 (commit de11cb7c): tre occorrenze, tutte
// dentro la riga di un 🟡 Nit.
const REVIEW_909 = [
  '## Findings (Important: 0, Nit: 3)',
  '',
  "`scripts/ci/harvest-agent-lessons.mjs:L276: 🟡 Nit: il gap `(?:\\s+\\S+){0,3}?` fa scattare il ramo A anche quando la negazione porta su un PARTICIPIO e non sul verbo di impatto, e li' la frase e' un difetto vero. Verificato: «🔴 Important: il path non gestito raggiunge `parsePath` e il router.» → stripped resta vuoto.",
  '',
  '## LGTM',
].join('\n');

test('NON matcha il marker citato dentro la riga di un altro finding (#909)', () => {
  assert.equal(REDFLAG_IMPORTANT_RE.test(REVIEW_909), false);
});

test('NON matcha il marker dentro un code span (testo riportato)', () => {
  assert.equal(REDFLAG_IMPORTANT_RE.test('Il test pinna la stringa `🔴 Important: x` come fixture.'), false);
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `constants.mjs:L84`: 🟡 Nit: il pattern `🔴 Important:` va documentato.'), false);
});

test('matcha il marker vero a inizio riga e dopo una location label', () => {
  assert.equal(REDFLAG_IMPORTANT_RE.test('## Findings (Important: 1, Nit: 0)\n\n🔴 Important: `/de/blog/null` finisce nel canonical e nella sitemap.\n'), true);
  assert.equal(REDFLAG_IMPORTANT_RE.test('`scripts/build-api.mjs:L851: 🔴 Important: guard mancante'), true);
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `scripts/ci/transport-identical-twins.mjs:L446`: 🔴 Important: shard non coperto'), true);
});

test('un 🔴 decorativo prima del marker NON lo nasconde (si sbaglia in direzione rossa)', () => {
  // `🔴` e' deliberatamente FUORI dalla classe negata del lead: se lo escludessimo,
  // una riga che apre con un 🔴 non-marker spegnerebbe il gate sul marker che segue.
  assert.equal(REDFLAG_IMPORTANT_RE.test('🔴 blocca il merge — 🔴 Important: canonical rotto'), true);
});

test('una riga citante non spegne il marker vero che sta su UN ALTRA riga', () => {
  const body = [
    '## Findings (Important: 1, Nit: 1)',
    '',
    '`a.mjs:L1`: 🟡 Nit: la review precedente diceva «🔴 Important: falso allarme».',
    '`b.mjs:L2`: 🔴 Important: la sitemap perde gli slug `de`.',
    '',
    '## LGTM',
  ].join('\n');
  assert.equal(REDFLAG_IMPORTANT_RE.test(body), true);
});

// --- residui di #959 chiusi da #977 ----------------------------------------
// Le due direzioni in cui la clausola POSIZIONE spegneva il gate in SILENZIO: uno
// skip del fixer, non un errore. Entrambe le forme sono marker VERI e devono
// restare rosse.
test('la location label incollata al marker NON lo spegne (#977)', () => {
  // Il backtick che CHIUDE la label e' preceduto da un non-spazio: non apre un code
  // span. Il `(?<!`)` originale guardava un carattere solo e non li distingueva.
  assert.equal(REDFLAG_IMPORTANT_RE.test('`a.mjs:L1`🔴 Important: la sitemap perde gli slug `de`.'), true);
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`🔴 **Important —** guard mancante'), true);
});

test('il marker dentro un code span APERTO resta citazione (#977 non allarga il rosso)', () => {
  // Backtick preceduto da spazio o a inizio riga = span che si apre sul marker.
  assert.equal(REDFLAG_IMPORTANT_RE.test('Il test pinna `🔴 Important: x` come fixture.'), false);
  assert.equal(REDFLAG_IMPORTANT_RE.test('`🔴 Important: x` a inizio riga: fixture, non marker.'), false);
  // Il finding interamente dentro un code span (forma degli esempi di REVIEW.md)
  // non e' una citazione: li' il backtick non e' incollato al glifo.
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1: 🔴 Important: canonical rotto.`'), true);
});

test('un secondo finding sulla stessa riga resta ROSSO (#977)', () => {
  // Viola «una riga per finding» (REVIEW.md → Output format), ma un 🔴 vero non puo'
  // sparire per una violazione di forma: era l'unica direzione in cui la fix di #959
  // spegneva il gate.
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`: 🟡 Nit: x. 🔴 Important: y'), true);
  // Anche con un code span CHIUSO nel mezzo: e' prosa normale, non una citazione.
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`: 🟡 Nit: rinomina `x`. 🔴 Important: la sitemap perde gli slug'), true);
  // ...ma la citazione marcata come tale resta verde: e' il caso #909.
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`: 🟡 Nit: la review diceva «🔴 Important: y».'), false);
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`: 🟡 Nit: il pattern `🔴 Important:` va documentato.'), false);
});

test('un numero dispari di backtick non fa sparire un finding successivo (#1120)', () => {
  const line = '🟡 Nit: cita `🔴 Important: no` e `🔴 Important: yes';
  assert.equal(REDFLAG_IMPORTANT_RE.test(line), true);
  assert.equal(REDFLAG_IMPORTANT_RE.test('🟡 Nit: cita `🔴 Important: no`'), false);
});

// --- il glifo-ancora non puo' stare dentro una citazione (#1106) ------------
// La clausola 1-bis apriva la citazione al glifo: con un `.*` davanti, l'ancora
// poteva essere un 🟡 CITATO, e da li' il controllo di apri-citazione non vedeva
// piu' il backtick (o l'`«`) che aveva aperto la citazione. Il body qui sotto e'
// la forma verbatim che ha respinto la review di questa stessa PR — `Important: 0`,
// `## LGTM`, e nessun marker vero.
test('un 🔴 dentro un code span che porta ANCHE il glifo non e\' un marker (#1106)', () => {
  const line =
    "- `scripts/ci/lib/constants.mjs:L147`: 🟡 Nit: verificato eseguendo la regex vecchia e la nuova: `Due 🟡 nit non-funnel, nessun 🔴 Important — merge libero.` era `false`, ora e' `true`.";
  assert.equal(REDFLAG_IMPORTANT_RE.test(line), false);
  assert.equal(REDFLAG_IMPORTANT_RE.test(`## Findings (Important: 0, Nit: 1)\n\n${line}\n\n## LGTM`), false);
});

test("il sibling con «»: glifo e 🔴 dentro la STESSA citazione (#1106)", () => {
  // Stessa classe, altra forma di citazione: senza il prefisso attraversante,
  // l'ancora finiva sul 🟡 interno alle «» e il gate diventava rosso.
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`: 🟡 Nit: la review diceva «🟡 nit e 🔴 Important: y».'), false);
});

// --- la narrow non puo' perdere il glifo-ancora (#1106, round 2) -----------
// Il prefisso attraversante si fermava su TUTTO cio' che apre una citazione, anche
// quando quella citazione era chiusa o non era una citazione affatto: l'ancora
// spariva e un marker VERO tornava verde — la direzione che il gate non puo'
// prendere. Le due forme misurate, entrambe ROSSE prima di #1106.
test('una citazione CHIUSA prima del marker non spegne il gate (#1106)', () => {
  assert.equal(REDFLAG_IMPORTANT_RE.test('- 🟢 ok. Il body dice «x». 🟡 Nit: a. 🔴 Important: b'), true);
  // Stessa classe nella coda dopo il glifo (era 🟣 pre-esistente da #977).
  assert.equal(
    REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`: 🟡 Nit: il sito dice «vecchio». 🔴 Important: la sitemap perde gli slug'),
    true,
  );
  // ...ma la citazione APERTA continua a spegnere: e' li' che il 🔴 e' riportato.
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`: 🟡 Nit: la review diceva «🔴 Important: y».'), false);
});

test('la location label mai chiusa non e\' uno span aperto (#1106)', () => {
  // `` `a.mjs:L1: `` e' la forma idiomatica di REVIEW.md: il backtick non ha un
  // compagno sulla riga, quindi non apre niente e non puo' nascondere l'ancora.
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1: 🟡 Nit: a. 🔴 Important: b'), true);
  assert.equal(REDFLAG_IMPORTANT_RE.test('`a.mjs:L1: 🟡 Nit: rinomina x. 🔴 **Important —** guard mancante'), true);
  // Un backtick che il compagno ce l'ha resta un apri-span: il falso rosso di
  // #1106 non si riapre.
  assert.equal(
    REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`: 🟡 Nit: `Due 🟡 nit, nessun 🔴 Important — merge libero.` era false'),
    false,
  );
});

test('la narrow di #1106 non spegne il secondo finding VERO sulla riga (#977)', () => {
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`: 🟡 Nit: x. 🔴 Important: y'), true);
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`: 🟡 Nit: rinomina `x`. 🔴 Important: la sitemap perde gli slug'), true);
});

// --- àncora di posizione senza punteggiatura (sito, PR 9339) ----------------
// `path:L<n>: 🔴 Important testo` è il formato di uscita di REVIEW.md. Quando il
// reviewer ometteva i due punti dopo la severità, nessuna delle tre copie vedeva
// il 🔴: con `## LGTM` nella stessa review la PR passava il gate con un Important
// aperto. Il sito lo aveva chiuso; qui mancava.
test('il marker dopo una location label vale anche senza punteggiatura dopo Important', () => {
  for (const line of [
    'scripts/ci/x.mjs:L12: 🔴 Important il ramo non chiude',
    '- scripts/ci/x.mjs:L12-14: 🔴 **Important** il ramo non chiude',
    'PR body:L9: 🔴 Important il claim non ha una misura',
    '`a.mjs:L1`: 🔴 Important guard mancante',
    '- `a.mjs:L1: 🔴 Important guard mancante',
    '> generator/scripts/lib/free-translate.mjs:L967: 🔴 Important nel recovery una riga torna uguale',
  ]) {
    assert.equal(REDFLAG_IMPORTANT_RE.test(line), true, line);
  }
  const body = '## Findings (Important: 1, Nit: 0)\n\nscripts/ci/x.mjs:L12: 🔴 Important il ramo non chiude\n\n## LGTM';
  assert.equal(REDFLAG_IMPORTANT_RE.test(body), true, 'un LGTM nella stessa review non spegne il marker ancorato');
});

test('senza la label a inizio riga la forma senza punteggiatura resta prosa (#3330 non si riapre)', () => {
  for (const line of [
    'Correction: zero 🔴 Important findings (both nits are non-blocking).',
    'Nessun 🔴 Important trovato in scripts/ci/x.mjs:L12 dopo la correzione.',
    '`a.mjs:L1`: 🟡 Nit: non e\' un 🔴 Important vero, solo naming.',
    'Il test pinna `x.mjs:L1: 🔴 Important guard` come fixture.',
    // La label da sola con la severita' e nient'altro non e' un finding.
    'scripts/ci/x.mjs:L12: 🔴 Important',
    'scripts/ci/x.mjs:L12: 🔴 Important   ',
  ]) {
    assert.equal(REDFLAG_IMPORTANT_RE.test(line), false, line);
  }
});

test('il testo del finding ancorato sta sulla STESSA riga: JS e grep giudicano uguale', () => {
  // Con `\s+\S` la copia JS leggerebbe come testo la riga successiva, mentre
  // `grep` (orientato alla riga) no: le tre copie divergerebbero su questo corpo.
  assert.equal(REDFLAG_IMPORTANT_RE.test('scripts/ci/x.mjs:L12: 🔴 Important\nriga successiva'), false);
});

test('la label ancorata vale anche in un elenco numerato e con piu\' ancore', () => {
  for (const line of [
    '1. scripts/ci/x.mjs:L12: 🔴 Important il ramo non chiude',
    '2) `a.mjs:L1`: 🔴 **Important** guard mancante',
    '- 3. PR body:L9: 🔴 Important il claim non ha una misura',
    'a.mjs:L1, b.mjs:L2: 🔴 Important i due lati divergono',
    '`a.mjs:L1`, `b.mjs:L2-4`: 🔴 Important i due lati divergono',
    '- a.mjs:L1; PR body:L4: 🔴 Important codice e descrizione non tornano',
  ]) {
    assert.equal(REDFLAG_IMPORTANT_RE.test(line), true, line);
  }
});

test('fra le ancore della label non passa prosa, e i prefissi di elenco sono limitati', () => {
  for (const line of [
    // Prosa fra le ancore o davanti alla label: resta la regola di #3330.
    'a.mjs:L1, vedi anche sotto: 🔴 Important guard mancante',
    'In a.mjs:L1, b.mjs:L2: 🔴 Important guard mancante',
    // Una riga di soli separatori non e' un elenco che porta una label.
    `${'-'.repeat(60)} 🔴 Important testo`,
  ]) {
    assert.equal(REDFLAG_IMPORTANT_RE.test(line), false, line);
  }
  // Limite ai prefissi: una riga lunga di trattini e cifre resta lineare.
  const started = process.hrtime.bigint();
  assert.equal(REDFLAG_IMPORTANT_RE.test(`${'1.-'.repeat(20000)} 🔴 Important testo`), false);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 2000, 'la riga patologica non deve costare secondi');
});

// --- coerenza col conteggio dichiarato, nelle due direzioni -----------------
const declared = (body) => {
  const header = body.match(/^#{1,4}\s*Findings\b[^\n]*/m);
  const n = header?.[0].match(/Important:\s*(\d+)/i);
  return n ? Number(n[1]) : null;
};

for (const [name, body] of [
  ['Important: 0 con un marker citato → verde', '## Findings (Important: 0, Nit: 1)\n\n`x.mjs:L1`: 🟡 Nit: la review diceva «🔴 Important: y».\n\n## LGTM'],
  ['Important: 1 con un marker vero → rosso', '## Findings (Important: 1, Nit: 0)\n\n`x.mjs:L1`: 🔴 Important: canonical rotto.\n'],
  ['Important: 0 senza alcun 🔴 → verde', '## Findings (Important: 0, Nit: 2)\n\n🟡 Nit: naming.\n🟡 Nit: commento stale.\n\n## LGTM'],
  ['Important: 2 con due marker veri → rosso', '## Findings (Important: 2, Nit: 0)\n\n- `a.mjs:L1`: 🔴 Important: uno.\n- `b.mjs:L2`: 🔴 **Important —** due.\n'],
]) {
  test(`coerenza col conteggio dichiarato — ${name}`, () => {
    const n = declared(body);
    assert.notEqual(n, null);
    assert.equal(REDFLAG_IMPORTANT_RE.test(body), n > 0);
  });
}

// --- le copie bash non possono divergere ------------------------------------
// Il difetto e' stato riparato tre volte perche' la logica vive in TRE copie:
// questa regex e i due `grep -cP` bash (un `if:`/`run:` YAML non puo' importare un
// modulo JS). Il guard deriva il pattern atteso dalla `.source` — grep e' gia'
// orientato alla riga, quindi l'unica differenza legittima e' il `\n` nella classe
// negata — e lo pretende verbatim in entrambi i workflow.
const bashPattern = REDFLAG_IMPORTANT_RE.source.replaceAll('[^\\n', '[^');

test("la sola differenza fra la source JS e il pattern bash sono i `\\n` delle classi negate", () => {
  assert.ok(REDFLAG_IMPORTANT_RE.source.includes('[^\\n'));
  assert.ok(!bashPattern.includes('\\n'));
  // `replaceAll`, non `replace`: le classi negate sono piu' di una da #977, e con la
  // sostituzione della sola PRIMA il pattern derivato porterebbe ancora un `\n` —
  // il guard sarebbe verde qui e i due grep non matcherebbero mai in produzione.
  assert.equal(bashPattern, REDFLAG_IMPORTANT_RE.source.replaceAll('\\n', ''));
});

for (const wf of ['pr-redflag-fixer.yml', 'stale-pr-rescuer.yml']) {
  test(`${wf} grepa esattamente quel pattern`, () => {
    const yaml = readFileSync(new URL(`../../.github/workflows/${wf}`, import.meta.url), 'utf8');
    assert.ok(yaml.includes(`grep -cP '${bashPattern}'`), `${wf} non porta il pattern derivato dalla source`);
  });
}

// --- parita' ESEGUITA fra la copia JS e il pattern bash ----------------------
// I guard qui sopra provano che i due workflow portano il pattern DERIVATO dalla
// source; non provano che i due motori lo leggano allo stesso modo. Queste righe
// passano davvero per `grep -P` (il comando dei workflow, stesso locale) e per
// la regex JS. Ci sono solo forme la cui parita' vale per costruzione: spazi
// ASCII, piu' lo spazio non separabile dopo `Important`, che il ramo ancorato
// tratta con una classe esplicita proprio perche' `\S` non e' la stessa classe
// nei due motori.
const NBSP = '\u00A0';
const PARITY_LINES = [
  ['🔴 Important: missing canonical', true],
  ['🔴 **Important —** sibling non spazzato', true],
  ['- `scripts/ci/transport-identical-twins.mjs:L446`: 🔴 Important: shard non coperto', true],
  ['Correction: zero 🔴 Important findings (both nits are non-blocking).', false],
  ['Il test pinna la stringa `🔴 Important: x` come fixture.', false],
  ['- `constants.mjs:L84`: 🟡 Nit: il pattern `🔴 Important:` va documentato.', false],
  ['scripts/ci/x.mjs:L12: 🔴 Important il ramo non chiude', true],
  ['- scripts/ci/x.mjs:L12-14: 🔴 **Important** il ramo non chiude', true],
  ['PR body:L9: 🔴 Important il claim non ha una misura', true],
  ['- `a.mjs:L1: 🔴 Important guard mancante', true],
  ['> generator/scripts/lib/free-translate.mjs:L967: 🔴 Important nel recovery una riga torna uguale', true],
  ['1. scripts/ci/x.mjs:L12: 🔴 Important il ramo non chiude', true],
  ['2) `a.mjs:L1`: 🔴 **Important** guard mancante', true],
  ['a.mjs:L1, b.mjs:L2: 🔴 Important i due lati divergono', true],
  ['`a.mjs:L1`, `b.mjs:L2-4`: 🔴 Important i due lati divergono', true],
  ['a.mjs:L1, vedi anche sotto: 🔴 Important guard mancante', false],
  ['Nessun 🔴 Important trovato in scripts/ci/x.mjs:L12 dopo la correzione.', false],
  ['scripts/ci/x.mjs:L12: 🔴 Important', false],
  ['scripts/ci/x.mjs:L12: 🔴 Important   ', false],
  // Lo spazio non separabile incollato alla severita' non apre il testo...
  [`scripts/ci/x.mjs:L12: 🔴 Important${NBSP}testo`, false],
  // ...ma dopo uno spazio vero e' gia' testo, in entrambi i motori.
  [`scripts/ci/x.mjs:L12: 🔴 Important ${NBSP}testo`, true],
];

test('le righe di parita\' hanno il verdetto atteso nella copia JS', () => {
  for (const [line, expected] of PARITY_LINES) {
    assert.equal(REDFLAG_IMPORTANT_RE.test(line), expected, line);
  }
});

const grepEnv = { ...process.env, LC_ALL: 'C.UTF-8' };
const grepProbe = spawnSync('grep', ['-cP', 'a'], { input: 'a\n', encoding: 'utf8', env: grepEnv });
const grepPAvailable = grepProbe.status === 0 && String(grepProbe.stdout).trim() === '1';

test('`grep -P` col pattern dei workflow da\' lo stesso verdetto, riga per riga', {
  // Fuori da Actions (macOS: grep BSD senza -P) il confronto non e' eseguibile;
  // in Actions deve girare, o l'osservatore sparirebbe in silenzio.
  skip: !grepPAvailable && !process.env.GITHUB_ACTIONS ? '`grep -P` non disponibile su questa macchina' : false,
}, () => {
  assert.ok(grepPAvailable, 'in Actions `grep -P` deve esistere: e\' il comando dei due workflow');
  const input = `${PARITY_LINES.map(([line]) => line).join('\n')}\n`;
  const result = spawnSync('grep', ['-nP', bashPattern], { input, encoding: 'utf8', env: grepEnv });
  assert.ok(result.status === 0 || result.status === 1, `grep -P non ha compilato il pattern: ${result.stderr}`);
  const matched = new Set(String(result.stdout).split('\n').filter(Boolean).map((row) => Number(row.split(':', 1)[0])));
  PARITY_LINES.forEach(([line, expected], index) => {
    assert.equal(matched.has(index + 1), expected, `grep -P: ${line}`);
  });
});

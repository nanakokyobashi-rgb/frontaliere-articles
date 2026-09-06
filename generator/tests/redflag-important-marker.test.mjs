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
  assert.equal(REDFLAG_IMPORTANT_RE.test('`a.mjs:L1`\u{1F534} Important: la sitemap perde gli slug `de`.'), true);
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`\u{1F534} **Important \u2014** guard mancante'), true);
});

test('il marker dentro un code span APERTO resta citazione (#977 non allarga il rosso)', () => {
  // Backtick preceduto da spazio o a inizio riga = span che si apre sul marker.
  assert.equal(REDFLAG_IMPORTANT_RE.test('Il test pinna `\u{1F534} Important: x` come fixture.'), false);
  assert.equal(REDFLAG_IMPORTANT_RE.test('`\u{1F534} Important: x` e\u2019 la fixture di questo test.'), false);
  // Il finding interamente dentro un code span (forma degli esempi di REVIEW.md)
  // non e' una citazione: li' il backtick non e' incollato al glifo.
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1: \u{1F534} Important: canonical rotto.`'), true);
});

test('un secondo finding sulla stessa riga resta ROSSO (#977)', () => {
  // Viola «una riga per finding» (REVIEW.md \u2192 Output format), ma un \u{1F534} vero non puo'
  // sparire per una violazione di forma: era l'unica direzione in cui la fix di #959
  // spegneva il gate.
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`: \u{1F7E1} Nit: x. \u{1F534} Important: y'), true);
  // Anche con un code span CHIUSO nel mezzo: e' prosa normale, non una citazione.
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`: \u{1F7E1} Nit: rinomina `x`. \u{1F534} Important: la sitemap perde gli slug'), true);
  // ...ma la citazione marcata come tale resta verde: e' il caso #909.
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`: \u{1F7E1} Nit: la review diceva \u00AB\u{1F534} Important: y\u00BB.'), false);
  assert.equal(REDFLAG_IMPORTANT_RE.test('- `a.mjs:L1`: \u{1F7E1} Nit: il pattern `\u{1F534} Important:` va documentato.'), false);
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
// questa regex e i due `grep -qP` bash (un `if:`/`run:` YAML non puo' importare un
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
    assert.ok(yaml.includes(`grep -qP '${bashPattern}'`), `${wf} non porta il pattern derivato dalla source`);
  });
}

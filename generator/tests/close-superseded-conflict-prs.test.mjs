/**
 * close-superseded-conflict-prs.test.mjs — le decisioni di
 * `scripts/ci/close-superseded-conflict-prs.mjs`, sulle sole funzioni pure.
 * Run with `node --test generator/tests/close-superseded-conflict-prs.test.mjs`.
 *
 * Le fixture sono gli stati misurati il 2026-10-06: #2205 (riapplicazione di
 * #2201, già mergiata), #2246 (hand-off #2250 chiuso dal fixer con
 * `already-fixed`) e i duplicati della stessa causa con la sorgente chiusa.
 * Ogni caso positivo ha accanto i negativi che lo rendono stretto: lo sweep
 * CHIUDE PR, quindi il verso sicuro in cui sbagliare è lasciarle aperte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CLOSES_PER_RUN,
  SUPERSEDED_MARKER,
  closingComment,
  decideHandoffAlreadyFixed,
  handoffTitleQuery,
  isSweepCandidate,
  isTrustedFixerOutcome,
  isTrustedComment,
  latestConflictLabelEventAt,
  mergeTreeAllowsClose,
  latestHandoffOf,
  mergeTreeRefMatches,
} from '../../scripts/ci/close-superseded-conflict-prs.mjs';
import { buildConflictHandoffIssue } from '../../scripts/ci/pr-autorebase.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const HEAD = '244f876cdaaa64fa9a5530933f6356de47202ab8';
const CONFLICT_DETECTED_AT = '2026-10-05T23:06:51Z';

const loopPr = (over = {}) => ({
  number: 2246,
  title: 'fix(cantoni): prevent workflow self-trigger burst',
  body: '## Implementato\n\n- fix\nCloses #2236\n\n## Non implementato (ancora)\n\n- niente, per scelta',
  headRefName: 'fix/issue-2236',
  headRefOid: HEAD,
  baseRefName: 'main',
  isDraft: false,
  mergeable: 'CONFLICTING',
  labels: [{ name: 'has-conflicts' }, { name: 'agent:autofix' }],
  ...over,
});

// L'hand-off è costruito dal producer vero: se pr-autorebase cambia titolo o
// body, questo consumer deve accorgersene qui e non in produzione.
const handoffOf = (pr, over = {}) => {
  const { title, body } = buildConflictHandoffIssue({
    num: pr.number, branch: pr.headRefName, head: pr.headRefOid, files: ['scripts/ci/x.mjs'],
  });
  return {
    number: 2250, title, body, labels: [{ name: 'agent:triaged' }], createdAt: '2026-10-05T23:06:00Z', ...over,
  };
};

const verdict = (code, over = {}) => ({
  body: `Root cause: già su main.\n<!-- FIX_OUTCOME: ${code} -->`,
  created_at: '2026-10-06T00:18:00Z',
  author_association: 'OWNER',
  user: { login: 'nanakokyobashi-rgb' },
  ...over,
});

// ── Candidatura ─────────────────────────────────────────────────────────────

test('candidata: PR del ciclo, in conflitto, non draft', () => {
  assert.equal(isSweepCandidate(loopPr()).candidate, true);
  // `fix/*` senza label resta una PR del ciclo (branch storico del fixer).
  assert.equal(isSweepCandidate(loopPr({ labels: [{ name: 'has-conflicts' }] })).candidate, true);
});

test('non candidata: senza conflitto, umana, draft, fuori dal ciclo, o tornata mergeable', () => {
  const reason = (over) => isSweepCandidate(loopPr(over)).reason;
  assert.equal(reason({ labels: [{ name: 'agent:autofix' }] }), 'no-conflict-label');
  assert.equal(reason({ headRefName: 'feat/p7b', labels: [{ name: 'has-conflicts' }] }), 'not-loop-pr');
  assert.equal(reason({ isDraft: true }), 'draft');
  assert.equal(reason({ labels: [{ name: 'has-conflicts' }, { name: 'agent:autofix' }, { name: 'needs-human' }] }), 'hands-off-label');
  assert.equal(reason({ labels: [{ name: 'has-conflicts' }, { name: 'agent:autofix' }, { name: 'keep-open' }] }), 'hands-off-label');
  // «Il contenuto è già su main» vale solo per una PR diretta a main.
  assert.equal(reason({ baseRefName: 'release/x' }), 'base-not-main');
  assert.equal(reason({ baseRefName: undefined }), 'base-not-main');
  // La label è una fotografia di merge-tree: se GitHub dice MERGEABLE il
  // conflitto è appena rientrato e decide pr-autorebase, non questo sweep.
  assert.equal(reason({ mergeable: 'MERGEABLE' }), 'mergeable-now');
  // `UNKNOWN` (tipico subito dopo un push su main) o un campo assente non
  // confermano il conflitto: lo sweep gira anche se l'autorebase che ricalcola
  // la label è fallito, quindi serve `CONFLICTING` da GitHub.
  assert.equal(reason({ mergeable: 'UNKNOWN' }), 'conflict-unconfirmed');
  // Solo la scrematura della lista ammette `UNKNOWN` come «da verificare»:
  // main riceve un commit ogni pochi minuti e la lista risponde quasi sempre
  // così. La decisione gira poi sulla rilettura singola, che resta stretta.
  assert.deepEqual(isSweepCandidate(loopPr({ mergeable: 'UNKNOWN' }), { allowUnknown: true }), { candidate: true, reason: 'conflict-to-verify' });
  assert.equal(isSweepCandidate(loopPr({ mergeable: 'MERGEABLE' }), { allowUnknown: true }).candidate, false);
  assert.equal(isSweepCandidate(loopPr({ mergeable: '' }), { allowUnknown: true }).candidate, false);
  assert.equal(reason({ mergeable: undefined }), 'conflict-unconfirmed');
  assert.equal(reason({ mergeable: '' }), 'conflict-unconfirmed');
});

// ── Caso 1: riapplicazione di un'origine mergiata (#2205 → #2201) ───────────

test('«riapplica un\'origine mergiata» NON è una ragione di chiusura', () => {
  // Il caso c'era, ed è stato tolto: l'origine può aver mergiato una HEAD
  // diversa o essere stata revertita, e la PR che lo aveva motivato lo
  // smentisce — #2205 riapplicava #2201 (mergiata), ma il suo contenuto non
  // era su main, qualcuno ne ha risolto il conflitto ed è stata MERGIATA.
  const src = readFileSync(path.join(ROOT, 'scripts/ci/close-superseded-conflict-prs.mjs'), 'utf8');
  assert.equal(/decideReapplyOfMergedOrigin|originContentOnMain\(|readPrFiles/.test(src), false, 'lo sweep non deve chiudere una riapplicazione sulla base dello stato della sua origine');
  assert.throws(() => closingComment({ reason: 'reapply-origin-merged', origin: 2201, handoff: 2204 }), /ragione di chiusura sconosciuta/);
  // Una riapplicazione in conflitto senza un verdetto sul PROPRIO hand-off resta aperta.
  const reapply = loopPr({ number: 2205, headRefName: 'fix/issue-2204' });
  assert.equal(
    decideHandoffAlreadyFixed({ pr: reapply, handoff: null, comments: null, openPrs: [reapply] }).close,
    false,
  );
});

test('merge-tree vale solo sulla ref realmente scaricata', () => {
  // Dopo un push il clone può avere ancora l'oggetto vecchio: la prova si
  // accetta solo se l'OID scaricato adesso è la HEAD giudicata.
  assert.equal(mergeTreeRefMatches(`${HEAD}\n`, HEAD), true);
  assert.equal(mergeTreeRefMatches(HEAD.toUpperCase(), HEAD), true);
  assert.equal(mergeTreeRefMatches('f'.repeat(40), HEAD), false);
  assert.equal(mergeTreeRefMatches(HEAD.slice(0, 12), HEAD), false, 'un prefisso non è un OID');
  assert.equal(mergeTreeRefMatches('', HEAD), false);
  const src = readFileSync(path.join(ROOT, 'scripts/ci/close-superseded-conflict-prs.mjs'), 'utf8');
  const fn = src.slice(src.indexOf('function mergeTreeState(pr)'), src.indexOf('function decide(pr, openPrs)'));
  assert.ok(fn.indexOf('mergeTreeRefMatches(') < fn.indexOf("'merge-tree'"), 'il confronto dell\'OID deve precedere merge-tree');
  assert.equal(/'merge-tree', '--write-tree', [^\]]*\bhead\b\]/.test(fn), false, 'merge-tree deve fondere la ref scaricata, non lo SHA dello snapshot');
});

test('l\'ultima cosa prima della chiusura è una rilettura della PR', () => {
  const src = readFileSync(path.join(ROOT, 'scripts/ci/close-superseded-conflict-prs.mjs'), 'utf8');
  const main = src.slice(src.indexOf('function main()'));
  const closeAt = main.indexOf("gh(['pr', 'close'");
  const finalCheck = main.lastIndexOf('rereadLivePr(live)', closeAt);
  assert.notEqual(finalCheck, -1, 'manca la rilettura finale');
  assert.ok(finalCheck > main.indexOf('decide(live, freshOpenPrs)'), 'la rilettura finale deve venire DOPO la decisione di conferma');
  const between = main.slice(finalCheck, closeAt);
  assert.equal(/\b(decide|listOpenPrs|mergeTreeState)\(/.test(between), false, 'niente letture lunghe fra la rilettura finale e la close');
  // Nella stessa guardia, PRIMA della rilettura: merge-tree contro il main di adesso.
  const guard = main.slice(main.lastIndexOf('if (', finalCheck), finalCheck);
  assert.match(guard, /mergeTreeAllowsClose\(mergeTreeState\(live\)\)/, 'la guardia finale deve rifare merge-tree prima della rilettura della HEAD');
  // La finestra irriducibile è dichiarata, non taciuta.
  assert.match(main, /FINESTRA RESIDUA, per costruzione/);
});

test('caso 2 — verdetto already-fixed sull\'hand-off della HEAD corrente: superata', () => {
  const pr = loopPr();
  assert.deepEqual(
    decideHandoffAlreadyFixed({
      pr,
      handoff: handoffOf(pr),
      comments: [verdict('already-fixed')],
      openPrs: [pr],
      conflictDetectedAt: CONFLICT_DETECTED_AT,
    }),
    { close: true, reason: 'handoff-already-fixed', handoff: 2250 },
  );
});

test('caso 2 — ogni condizione mancante lascia la PR aperta', () => {
  const pr = loopPr();
  const reason = (over) => decideHandoffAlreadyFixed({
    pr, handoff: handoffOf(pr), comments: [verdict('already-fixed')], openPrs: [pr],
    conflictDetectedAt: CONFLICT_DETECTED_AT, ...over,
  }).reason;
  assert.equal(reason({ handoff: null }), 'no-handoff');
  assert.equal(reason({ handoff: handoffOf(loopPr({ number: 2249 })) }), 'handoff-of-another-pr');
  // Una HEAD nuova è un contributo nuovo: il verdetto parlava di quella vecchia.
  assert.equal(reason({ pr: loopPr({ headRefOid: 'f'.repeat(40) }) }), 'handoff-head-mismatch');
  assert.equal(reason({ handoff: handoffOf(pr, { labels: [{ name: 'agent:in-progress' }] }) }), 'handoff-in-progress');
  assert.equal(reason({ comments: null }), 'handoff-comments-unreadable');
  assert.equal(reason({ openPrs: null }), 'open-prs-unreadable');
  assert.equal(reason({ comments: [] }), 'no-trusted-verdict');
  // Solo `already-fixed` dice «niente da riapplicare»: gli altri verdetti no.
  assert.equal(reason({ comments: [verdict('blocked-secrets')] }), 'verdict-blocked-secrets');
  assert.equal(reason({ comments: [verdict('pr-created')] }), 'verdict-pr-created');
  // Conta l'ULTIMO verdetto: un già-risolto superato da un giro nuovo non vale.
  assert.equal(
    reason({ comments: [verdict('already-fixed'), verdict('no-root-cause', { created_at: '2026-10-06T02:00:00Z' })] }),
    'verdict-no-root-cause',
  );
  // Un verdetto più vecchio dell'hand-off appartiene a un'altra storia.
  assert.equal(reason({ comments: [verdict('already-fixed', { created_at: '2026-10-05T20:00:00Z' })] }), 'verdict-not-after-handoff');
});

test('caso 2 — claim parziale o hand-off in coda al fixer: il verdetto non basta', () => {
  // Il claim è quello del predicato condiviso: una scrittura parziale può
  // lasciare `agent:remote`/`agent:local` senza `agent:in-progress`.
  const pr = loopPr();
  const reason = (labels) => decideHandoffAlreadyFixed({
    pr, handoff: handoffOf(pr, { labels: labels.map((name) => ({ name })) }), comments: [verdict('already-fixed')], openPrs: [pr],
    conflictDetectedAt: CONFLICT_DETECTED_AT,
  }).reason;
  assert.equal(reason(['agent:remote']), 'handoff-in-progress');
  assert.equal(reason(['agent:local']), 'handoff-in-progress');
  assert.equal(reason(['agent:fix']), 'handoff-routed');
  assert.equal(reason(['agent:fix-queued']), 'handoff-routed');
  assert.equal(reason(['agent:triaged', 'fu-parked', 'maybe-resolved']), 'handoff-already-fixed');
});

test('caso 2 — un hand-off duplicato ancora attivo blocca la chiusura', () => {
  const pr = loopPr();
  const latest = handoffOf(pr, { number: 2300, createdAt: '2026-10-05T23:30:00Z', state: 'OPEN' });
  const decide = (older, openPrs = [pr]) => decideHandoffAlreadyFixed({
    pr, handoff: latest, comments: [verdict('already-fixed')], openPrs, siblings: [latest, older],
    conflictDetectedAt: CONFLICT_DETECTED_AT,
  });
  const older = (over) => handoffOf(pr, { number: 2250, state: 'OPEN', ...over });
  assert.deepEqual(decide(older({ labels: [{ name: 'agent:in-progress' }] })), { close: false, reason: 'handoff-in-progress', active: 2250 });
  assert.deepEqual(decide(older({ labels: [{ name: 'agent:fix-queued' }] })), { close: false, reason: 'handoff-routed', active: 2250 });
  // Una PR che riapplica il duplicato più vecchio, non il più recente.
  assert.deepEqual(
    decide(older({}), [pr, { number: 2290, headRefName: 'fix/issue-2250', body: '' }]),
    { close: false, reason: 'reapply-in-flight', active: 2250 },
  );
  // Un duplicato CHIUSO ha già avuto il suo esito, anche se la label è rimasta.
  assert.equal(decide(older({ state: 'CLOSED', labels: [{ name: 'agent:fix' }] })).close, true);
  assert.equal(decide(older({})).close, true);
});

test('caso 2 — una riapplicazione in volo ha la precedenza sul verdetto', () => {
  const pr = loopPr();
  const reason = (reapply) => decideHandoffAlreadyFixed({
    pr, handoff: handoffOf(pr), comments: [verdict('already-fixed')], openPrs: [pr, reapply],
    conflictDetectedAt: CONFLICT_DETECTED_AT,
  }).reason;
  assert.equal(reason({ number: 2290, headRefName: 'fix/issue-2250', body: '' }), 'reapply-in-flight');
  assert.equal(reason({ number: 2291, headRefName: 'codex/x', body: 'Supersedes #2246' }), 'reapply-in-flight');
});

test('caso 2 — un marker incollato da fuori non chiude niente', () => {
  const pr = loopPr();
  const outsider = verdict('already-fixed', { author_association: 'NONE', user: { login: 'passante' } });
  assert.equal(isTrustedComment(outsider), false);
  assert.equal(
    decideHandoffAlreadyFixed({
      pr, handoff: handoffOf(pr), comments: [outsider], openPrs: [pr], conflictDetectedAt: CONFLICT_DETECTED_AT,
    }).reason,
    'no-trusted-verdict',
  );
  // Il fixer commenta anche come bot di Actions, che non ha un'associazione.
  assert.equal(isTrustedComment({ author_association: 'NONE', user: { login: 'github-actions[bot]' } }), true);
  assert.equal(isTrustedComment({ author_association: 'COLLABORATOR', user: { login: 'valerielinc-ops' } }), true);
});

test('caso 2 — il preflight zero-Claude con lo stesso marker non è un verdetto del fixer', () => {
  const pr = loopPr();
  const preflight = verdict('already-fixed', {
    author_association: 'NONE',
    user: { login: 'github-actions[bot]' },
    body: '<!-- reconcile-bot -->\n⏭️ **Pre-flight (auto, zero-Claude)**\n<!-- FIX_OUTCOME: already-fixed -->',
  });
  assert.equal(isTrustedFixerOutcome(preflight), false);
  assert.equal(
    decideHandoffAlreadyFixed({
      pr, handoff: handoffOf(pr), comments: [preflight], openPrs: [pr],
      conflictDetectedAt: CONFLICT_DETECTED_AT,
    }).reason,
    'no-trusted-verdict',
  );
  const fixer = verdict('already-fixed', {
    author_association: 'NONE',
    user: { login: 'github-actions[bot]' },
    body: 'Diagnosi issue-fix: già su main.\n<!-- FIX_OUTCOME: already-fixed -->',
  });
  assert.equal(isTrustedFixerOutcome(fixer), true);
});

test('caso 2 — un verdetto precedente all\'ultima rilevazione di conflitto non chiude', () => {
  const pr = loopPr();
  assert.equal(
    decideHandoffAlreadyFixed({
      pr, handoff: handoffOf(pr), comments: [verdict('already-fixed')], openPrs: [pr],
      conflictDetectedAt: '2026-10-06T00:30:00Z',
    }).reason,
    'verdict-before-current-conflict',
  );
});

test('la rilevazione corrente richiede l\'ultima transizione has-conflicts come labeled', () => {
  assert.equal(
    latestConflictLabelEventAt([
      { event: 'labeled', label: { name: 'has-conflicts' }, created_at: CONFLICT_DETECTED_AT },
      { event: 'unlabeled', label: { name: 'has-conflicts' }, created_at: '2026-10-06T00:30:00Z' },
      { event: 'labeled', label: { name: 'has-conflicts' }, created_at: '2026-10-06T00:40:00Z' },
    ]),
    Date.parse('2026-10-06T00:40:00Z'),
  );
  assert.equal(
    latestConflictLabelEventAt([
      { event: 'labeled', label: { name: 'has-conflicts' }, created_at: CONFLICT_DETECTED_AT },
      { event: 'unlabeled', label: { name: 'has-conflicts' }, created_at: '2026-10-06T00:30:00Z' },
    ]),
    null,
  );
});

test('l\'hand-off più recente della PR si trova con entrambe le forme del titolo', () => {
  const issues = [
    { number: 2250, title: 'Conflitto con main dopo LGTM: riapplicare la PR #2246 su main', createdAt: '2026-10-05T23:06:00Z' },
    { number: 2300, title: 'Conflitto con main: riapplicare la PR #2246 su main', createdAt: '2026-10-06T05:00:00Z' },
    // La ricerca per titolo di GitHub è per token: #22460 non è #2246.
    { number: 2301, title: 'Conflitto con main dopo LGTM: riapplicare la PR #22460 su main', createdAt: '2026-10-06T06:00:00Z' },
  ];
  assert.equal(latestHandoffOf(2246, issues).number, 2300);
  assert.equal(latestHandoffOf(9999, issues), null);
  assert.ok(issues[0].title.includes(handoffTitleQuery(2246)));
});

// ── Niente terzo caso, e il conflitto si ricalcola ─────────────────────────

test('una issue sorgente chiusa da un\'altra PR NON è una ragione di chiusura', () => {
  // Review di #2274: due PR possono chiudere la stessa issue con fix parziali
  // o diversi. Il riferimento alla issue non prova che QUESTO contenuto sia su
  // main, quindi lo sweep non lo usa: restano solo le due prove legate alla PR
  // o al suo hand-off.
  const src = readFileSync(path.join(ROOT, 'scripts/ci/close-superseded-conflict-prs.mjs'), 'utf8');
  assert.equal(/closedIssueRefs|closingMergedPr/.test(src), false, 'lo sweep non deve dedurre niente dalle keyword di chiusura');
  assert.throws(() => closingComment({ reason: 'source-issues-delivered', issues: [2236] }), /ragione di chiusura sconosciuta/);
  // Una PR in conflitto con un hand-off senza verdetto resta aperta, anche se
  // dichiara di chiudere una issue: la riprendono la classe F e il recycle.
  const pr = loopPr();
  assert.equal(
    decideHandoffAlreadyFixed({
      pr, handoff: handoffOf(pr), comments: [], openPrs: [pr], conflictDetectedAt: CONFLICT_DETECTED_AT,
    }).close,
    false,
  );
});

test('solo merge-tree «conflicted» sulla HEAD corrente autorizza la chiusura', () => {
  assert.equal(mergeTreeAllowsClose('conflicted'), true);
  // `clean`: il conflitto è rientrato e label/cache sono vecchie.
  assert.equal(mergeTreeAllowsClose('clean'), false);
  // `unknown`: fetch fallito o oggetto mancante — non lo sappiamo.
  assert.equal(mergeTreeAllowsClose('unknown'), false);
  assert.equal(mergeTreeAllowsClose(undefined), false);
});

// ── Commento e agganci ──────────────────────────────────────────────────────

test('il commento di chiusura dice la ragione e come annullarla', () => {
  for (const decision of [
    { reason: 'handoff-already-fixed', handoff: 2250 },
  ]) {
    const body = closingComment(decision);
    assert.ok(body.startsWith(SUPERSEDED_MARKER), body);
    assert.match(body, /gh pr reopen/, body);
    assert.match(body, /branch NON è stato cancellato/, body);
  }
  assert.match(closingComment({ reason: 'handoff-already-fixed', handoff: 2250 }), /#2250/);
  assert.throws(() => closingComment({ reason: 'inventata' }), /ragione di chiusura sconosciuta/);
});

test('la chiusura rilegge PR, conflitto e prove, e decide sull\'oggetto riletto', () => {
  const src = readFileSync(path.join(ROOT, 'scripts/ci/close-superseded-conflict-prs.mjs'), 'utf8');
  const main = src.slice(src.indexOf('function main()'));
  const closeAt = main.indexOf("'pr', 'close'");
  assert.notEqual(closeAt, -1);
  const before = main.slice(0, closeAt);
  // Prima decisione sullo snapshot, conferma sull'oggetto RILETTO: un body
  // cambiato fra le due letture non deve essere ignorato.
  assert.ok(before.includes('decide(pr, openPrs)'), 'manca la prima decisione');
  // `mergeable=UNKNOWN` è la risposta tipica (main si muove ogni pochi
  // minuti): scrematura e riletture delle invarianti lo ammettono, altrimenti
  // lo sweep resterebbe inerte. Il conflitto lo decide SOLO merge-tree, che
  // deve stare fra la rilettura e ogni decisione.
  assert.equal(src.split('allowUnknown: true').length - 1, 2, '`allowUnknown`: scrematura della lista e rilettura delle invarianti, nient\'altro');
  const reread = before.indexOf('const pr = rereadLivePr(listed);');
  const tree = before.indexOf('mergeTreeState(pr)');
  const first = before.indexOf('decide(pr, openPrs)');
  assert.ok(reread >= 0 && reread < tree && tree < first, 'ordine atteso: rilettura delle invarianti, merge-tree, decisione');
  assert.match(before.slice(tree, first), /if \(!mergeTreeAllowsClose\(treeState\)\) \{[\s\S]*?continue;/, 'senza merge-tree «conflicted» non si arriva alla decisione');
  assert.ok(before.includes('const live = rereadLivePr(pr);'), 'manca la rilettura della PR');
  assert.ok(before.includes('decide(live, freshOpenPrs)'), 'la conferma deve decidere sull\'oggetto riletto, non sullo snapshot');
  assert.equal(before.split('mergeTreeAllowsClose(').length - 1, 3, 'merge-tree va ricalcolato prima della decisione, prima della conferma e nella guardia finale');
  assert.ok(before.includes('confirmed.reason !== decision.reason'), 'la conferma deve reggere la stessa ragione');
  // La rilettura chiede gli stessi campi della lista, base compresa.
  assert.match(src, /const PR_FIELDS = '[^']*baseRefName[^']*title[^']*|const PR_FIELDS = '[^']*title[^']*baseRefName/);
});

test('i checkout sparsi dei due workflow non hanno un `filter` che li annulla', () => {
  // `actions/checkout`: «filter … Overrides sparse-checkout if set». Con
  // entrambi il checkout materializza comunque content/, dist/ e public/, e
  // il job del rescuer (8 minuti) scade prima dello scan.
  for (const file of ['stale-pr-rescuer.yml', 'pr-autorebase.yml']) {
    const lines = readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8').split('\n');
    const uses = lines.map((l, i) => (/^\s+uses: actions\/checkout@/.test(l) ? i : -1)).filter((i) => i >= 0);
    assert.ok(uses.length > 0, `${file}: nessun checkout trovato`);
    let sparse = 0;
    for (const at of uses) {
      const end = lines.findIndex((l, i) => i > at && /^\s+- (name|uses|id|run):/.test(l));
      const step = lines.slice(at, end < 0 ? lines.length : end).filter((l) => !/^\s*#/.test(l)).join('\n');
      if (!/^\s+sparse-checkout: /m.test(step)) continue;
      sparse += 1;
      assert.equal(/^\s+filter: /m.test(step), false, `${file}: un checkout ha sia \`filter\` sia \`sparse-checkout\`, e il primo annulla il secondo`);
    }
    assert.ok(sparse > 0, `${file}: atteso almeno un checkout sparso`);
  }
});

test('lo sweep non cancella mai il branch e ha un tetto per run', () => {
  const src = readFileSync(path.join(ROOT, 'scripts/ci/close-superseded-conflict-prs.mjs'), 'utf8');
  assert.equal(/['"]--delete-branch['"]/.test(src), false, 'la chiusura deve restare annullabile con `gh pr reopen`');
  assert.ok(Number.isInteger(MAX_CLOSES_PER_RUN) && MAX_CLOSES_PER_RUN > 0);
});

test('pr-autorebase.yml esegue lo sweep dopo l\'autorebase, anche se questo fallisce', () => {
  const wf = readFileSync(path.join(ROOT, '.github/workflows/pr-autorebase.yml'), 'utf8');
  const rebaseAt = wf.indexOf('node scripts/ci/pr-autorebase.mjs');
  const sweepAt = wf.indexOf('node scripts/ci/close-superseded-conflict-prs.mjs');
  assert.notEqual(sweepAt, -1, 'lo sweep non è agganciato a pr-autorebase.yml');
  // Dopo: è l'autorebase a ricalcolare `has-conflicts` con merge-tree.
  assert.ok(sweepAt > rebaseAt, 'lo sweep deve leggere le label appena ricalcolate dall\'autorebase');
  const step = wf.slice(wf.lastIndexOf('      - name:', sweepAt), sweepAt);
  assert.match(step, /if: always\(\)/, step);
  assert.match(step, /continue-on-error: true/, step);
  assert.match(step, /DRY_RUN: \$\{\{ github\.event\.inputs\.dry_run \}\}/, step);
  // Senza la deadline `runBudgetFromEnv()` è illimitato: lo sweep fa letture
  // `gh` sincrone per ogni candidata e deve fermarsi pulito prima del timeout.
  const run = wf.slice(sweepAt - 120, sweepAt);
  assert.match(run, /CI_JOB_DEADLINE_EPOCH=/, 'il passo dello sweep deve esportare la propria deadline');
});

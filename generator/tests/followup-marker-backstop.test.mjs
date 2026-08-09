/**
 * followup-marker-backstop.test.mjs — il backstop del marker di idempotenza.
 *
 * ## Cosa protegge
 *
 * Il triage post-merge e' idempotente solo grazie a un commento che un MODELLO
 * deve ricordarsi di scrivere. Misurato il 2026-08-09: 17 run verdi, zero
 * commenti marker, zero issue `follow-up` — e nessuno step che se ne accorgesse.
 *
 * Ma la riparazione ovvia («se il marker manca, scrivilo tu») e' quella
 * sbagliata, ed e' la ragione per cui questi test insistono sul caso 4. Nelle
 * run reali il modello NON aveva saltato un obbligo: ogni comando di shell
 * moriva su `bwrap: Can't create file at /home/.mcp.json: Permission denied`,
 * quindi `gh` era irraggiungibile e il triage non e' mai avvenuto. Un backstop
 * che avesse scritto «zero outstanding items» in quello stato avrebbe reso
 * DEFINITIVA una perdita che oggi e' solo ripetuta: il collector non puo'
 * distinguere un marker vero da uno fabbricato.
 *
 * Da qui i quattro casi, di cui il quarto e' quello che vale:
 *   1. marker presente                       → non fa nulla
 *   2. marker assente, sessione consegnata   → lo posta, con warning
 *   3. marker assente MA issue create        → lo posta citando le issue, warning
 *      rumoroso (e' un'incoerenza, non un no-op)
 *   4. marker assente, sessione NON consegnata → NON posta, error, exit 1
 *
 * Piu' il test che lega backstop e collector: se le due letture del marker
 * divergessero, il backstop crederebbe di aver chiuso l'idempotenza senza
 * averlo fatto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKER_PREFIX,
  parseBatch,
  hasTriageMarker,
  analyzeSession,
  issuesForPr,
  decide,
  runBackstop,
} from '../../scripts/ci/followup-marker-backstop.mjs';
import { hasTriageComment } from '../../scripts/ci/collect-followup-batch.mjs';

// ── Fixture ─────────────────────────────────────────────────────────

const comments = (...bodies) => JSON.stringify({ comments: bodies.map((body) => ({ body })) });

/** Un execution file in cui OGNI Bash muore all'init del sandbox (run 31307620545). */
function brokenSandboxExec(n = 9) {
  const msgs = [{ type: 'system', subtype: 'init' }];
  for (let i = 0; i < n; i += 1) {
    msgs.push({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: 'gh pr view 1' } }] },
    });
    msgs.push({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          content: "Exit code 1\nbwrap: Can't create file at /home/.mcp.json: Permission denied",
          is_error: true,
          tool_use_id: `toolu_${i}`,
        }],
      },
    });
  }
  // Il messaggio finale e' un SUCCESSO: e' precisamente il motivo per cui la
  // run esce verde e il difetto e' rimasto invisibile per 17 run.
  msgs.push({ type: 'result', subtype: 'success', is_error: false, num_turns: 2 * n + 1 });
  return JSON.stringify(msgs);
}

/** Un execution file sano: qualche Bash riuscito. */
function healthyExec() {
  return JSON.stringify([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '{"number":56}', tool_use_id: 'a' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok', is_error: false, tool_use_id: 'b' }] } },
    { type: 'result', subtype: 'success', is_error: false, num_turns: 5 },
  ]);
}

/**
 * `gh` finto. Registra gli argv e risponde da una tabella. Nessuna rete, e
 * soprattutto: il test FALLISCE se il backstop prova a postare quando non deve,
 * perche' la scrittura finisce in `calls`.
 */
function fakeGh({ commentsByPr = {}, issues = '[]', unreadable = [] } = {}) {
  const calls = [];
  const fn = (args, opts = {}) => {
    calls.push({ args, input: opts.input });
    if (args[0] === 'issue' && args[1] === 'list') return issues;
    if (args[0] === 'pr' && args[1] === 'view') {
      const pr = Number(args[2]);
      if (unreadable.includes(pr)) return '';
      return commentsByPr[pr] ?? comments();
    }
    if (args[0] === 'pr' && args[1] === 'comment') return '';
    return '';
  };
  fn.calls = calls;
  fn.posts = () => calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'comment');
  return fn;
}

const silent = () => {};

// ── Il prefisso e' un contratto condiviso, non una costante locale ───

test('il prefisso marker del backstop e quello del collector coincidono', () => {
  // Il collector non esporta la sua costante, ma la sua FUNZIONE la usa: se i
  // due prefissi divergessero, un commento scritto dal backstop non verrebbe
  // riconosciuto e l'idempotenza resterebbe aperta con la CI verde.
  assert.equal(
    hasTriageComment(comments(`${MARKER_PREFIX}: zero outstanding items.`)),
    true,
    `il collector non riconosce un commento che inizia con il prefisso del backstop (${MARKER_PREFIX})`,
  );
});

test('le due letture del marker concordano su tutta la matrice', () => {
  const fixtures = [
    comments(`${MARKER_PREFIX}: zero outstanding items.`),
    comments(`${MARKER_PREFIX} (backfill skipped): PR not eligible`),
    comments('\n\n' + `${MARKER_PREFIX}: dopo whitespace iniziale`),
    comments('un commento qualsiasi', `${MARKER_PREFIX}: in seconda posizione`),
    comments('nessun marker qui'),
    comments(`testo prima\n${MARKER_PREFIX}`), // il prefisso NON e' a inizio corpo
    JSON.stringify([{ body: `${MARKER_PREFIX}: forma array nuda` }]),
    'json rotto {{{',
    '',
  ];
  for (const f of fixtures) {
    assert.equal(
      hasTriageMarker(f),
      hasTriageComment(f),
      `backstop e collector divergono sulla fixture: ${f.slice(0, 80)}`,
    );
  }
});

// ── I quattro casi ──────────────────────────────────────────────────

test('caso 1 — marker presente: il backstop non fa nulla', () => {
  const gh = fakeGh({ commentsByPr: { 56: comments(`${MARKER_PREFIX}: zero outstanding items.`) } });
  const r = runBackstop({ batch: [56], repo: 'o/r', execRaw: healthyExec(), gh, log: silent });
  assert.equal(r.decisions[0].code, 'marker-present');
  assert.equal(r.decisions[0].action, 'noop');
  assert.equal(r.decisions[0].level, 'none');
  assert.deepEqual(gh.posts(), [], 'non deve scrivere nulla quando il marker c\'e\' gia\'');
  assert.equal(r.exitCode, 0);
});

test('caso 2 — marker assente e sessione consegnata: lo posta, con warning', () => {
  const gh = fakeGh({ commentsByPr: { 56: comments('solo chiacchiere') } });
  const r = runBackstop({ batch: [56], repo: 'o/r', execRaw: healthyExec(), runUrl: 'https://run/1', gh, log: silent });

  assert.equal(r.decisions[0].code, 'marker-missing');
  assert.equal(r.decisions[0].action, 'post');
  assert.equal(r.decisions[0].level, 'warning', 'un obbligo saltato va segnalato, non nascosto');

  const posts = gh.posts();
  assert.equal(posts.length, 1, 'attesa esattamente una scrittura');
  assert.deepEqual(posts[0].args.slice(0, 3), ['pr', 'comment', '56']);
  assert.ok(
    posts[0].input.startsWith(MARKER_PREFIX),
    'il corpo DEVE iniziare col prefisso: il collector fa startsWith, non un match libero',
  );
  assert.ok(posts[0].input.includes('zero outstanding items'));
  assert.ok(posts[0].input.includes('https://run/1'), 'manca il rimando alla run');
  // E il commento appena scritto deve essere idempotente per il collector.
  assert.equal(hasTriageComment(comments(posts[0].input)), true);
  assert.equal(r.exitCode, 0);
});

test('caso 3 — marker assente MA issue create: warning rumoroso e marker che non mente', () => {
  const gh = fakeGh({
    commentsByPr: { 56: comments('nessun marker') },
    issues: JSON.stringify([
      { number: 201, title: 'follow-up(#56): hub landing senza canonical' },
      { number: 202, title: 'follow-up(#56): ticker non aggiornato' },
      { number: 203, title: 'follow-up(#77): altra PR' },
      { number: 204, title: 'non e\' un follow-up canonico' },
    ]),
  });
  const r = runBackstop({ batch: [56], repo: 'o/r', execRaw: brokenSandboxExec(), gh, log: silent });

  const d = r.decisions[0];
  assert.equal(d.code, 'marker-missing-with-issues');
  assert.equal(d.level, 'warning');
  assert.match(d.message, /INCOERENZA/, 'l\'incoerenza opposta va detta a voce alta');
  assert.match(d.message, /#201/);
  assert.match(d.message, /#202/);

  const body = gh.posts()[0].input;
  assert.ok(body.startsWith(MARKER_PREFIX));
  assert.ok(!body.includes('zero outstanding items'), 'con issue create, "zero outstanding items" sarebbe falso');
  assert.ok(body.includes('#201') && body.includes('#202'));
  assert.ok(!body.includes('#203'), 'issue di un\'altra PR non vanno attribuite a questa');

  // Le issue sono anche la PROVA che la sessione ha parlato con GitHub: qui
  // l'execution file e' quello rotto, eppure il backstop deve consegnare.
  assert.equal(r.delivered, true);
});

test('caso 4 — sessione NON consegnata: NIENTE marker, error, exit 1', () => {
  const gh = fakeGh({ commentsByPr: { 56: comments(), 57: comments() } });
  const r = runBackstop({ batch: [56, 57], repo: 'o/r', execRaw: brokenSandboxExec(), stepOutcome: 'success', gh, log: silent });

  assert.equal(r.delivered, false, 'nessuno dei tre segnali regge: la sessione non ha consegnato');
  for (const d of r.decisions) {
    assert.equal(d.action, 'abstain');
    assert.equal(d.code, 'undelivered-session');
    assert.equal(d.level, 'error');
    assert.equal(d.body, null);
  }
  assert.deepEqual(
    gh.posts(),
    [],
    'scrivere "zero outstanding items" qui renderebbe DEFINITIVA una perdita oggi solo ripetuta',
  );
  assert.equal(r.exitCode, 1, 'il rosso e\' cio\' che tiene fermo il watermark e fa ri-coprire la finestra');
});

test('caso 4-bis — una sola PR gia\' marcata prova che la sessione ha parlato con GitHub', () => {
  // Segnale 2: l\'execution file e\' quello rotto (nessun Bash riuscito), ma un
  // marker c\'e\'. Allora sull\'altra PR l\'assenza e\' un obbligo saltato, non
  // una sessione morta → si posta.
  const gh = fakeGh({
    commentsByPr: { 56: comments(`${MARKER_PREFIX}: zero outstanding items.`), 57: comments('niente') },
  });
  const r = runBackstop({ batch: [56, 57], repo: 'o/r', execRaw: brokenSandboxExec(), gh, log: silent });
  assert.equal(r.delivered, true);
  assert.equal(r.decisions[0].code, 'marker-present');
  assert.equal(r.decisions[1].code, 'marker-missing');
  assert.deepEqual(r.posted, [57]);
  assert.equal(r.exitCode, 0);
});

test('commenti illeggibili: nessun marker e nessun rosso', () => {
  // `gh` a vuoto non dice «marker assente», dice «non lo so». Trattarlo come
  // assenza scriverebbe un marker su un dubbio — l\'unica mossa irreversibile.
  const gh = fakeGh({ unreadable: [56] });
  const r = runBackstop({ batch: [56], repo: 'o/r', execRaw: healthyExec(), gh, log: silent });
  assert.equal(r.decisions[0].code, 'comments-unreadable');
  assert.equal(r.decisions[0].action, 'unknown');
  assert.deepEqual(gh.posts(), []);
  assert.equal(r.exitCode, 0);
});

// ── I mattoni puri ──────────────────────────────────────────────────

test('analyzeSession riconosce il sandbox che non parte', () => {
  const s = analyzeSession(brokenSandboxExec(9));
  assert.equal(s.parsed, true);
  assert.equal(s.bashUses, 9);
  assert.equal(s.bashOk, 0);
  assert.equal(s.bashErr, 9);
  assert.equal(s.shellCapable, false);
  assert.equal(s.sandboxBroken, true);
  assert.match(s.sandboxError, /bwrap/);
});

test('un tool NON-Bash riuscito non vale come consegna', () => {
  // Non e' un caso di scuola: nella run 31307620545 i tool_use erano 10 — 9
  // Bash tutti falliti e UN `Read` di FOLLOWUP.md riuscito. Se la consegna si
  // misurasse sui tool riusciti invece che sui comandi di shell riusciti,
  // quella lettura basterebbe a far scrivere un marker «zero outstanding
  // items» a una sessione che non ha mai raggiunto `gh`.
  const exec = JSON.stringify([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'contenuto del file', tool_use_id: 'r' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: {} }] } },
    {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          content: "Exit code 1\nbwrap: Can't create file at /home/.mcp.json: Permission denied",
          is_error: true,
          tool_use_id: 'b',
        }],
      },
    },
    { type: 'result', subtype: 'success', is_error: false },
  ]);
  const s = analyzeSession(exec);
  assert.equal(s.toolUses, 2);
  assert.equal(s.bashUses, 1);
  assert.equal(s.bashOk, 0);
  assert.equal(s.shellCapable, false, 'un Read riuscito non prova che la sessione possa chiamare gh');

  const gh = fakeGh({ commentsByPr: { 56: comments() } });
  const r = runBackstop({ batch: [56], repo: 'o/r', execRaw: exec, gh, log: silent });
  assert.deepEqual(gh.posts(), []);
  assert.equal(r.exitCode, 1);
});

test('analyzeSession riconosce una sessione sana', () => {
  const s = analyzeSession(healthyExec());
  assert.equal(s.bashUses, 2);
  assert.equal(s.bashOk, 2);
  assert.equal(s.shellCapable, true);
  assert.equal(s.sandboxBroken, false);
});

test('analyzeSession e\' totale su input rotti', () => {
  for (const bad of ['', 'non json', '{}', '[]', null, undefined]) {
    const s = analyzeSession(bad);
    assert.equal(s.shellCapable, false, `input ${JSON.stringify(bad)} non deve mai dichiarare consegna`);
  }
});

test('analyzeSession legge anche l\'ndjson', () => {
  const ndjson = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash' }] } }),
    'riga troncata a meta {',
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok', tool_use_id: 'x' }] } }),
  ].join('\n');
  const s = analyzeSession(ndjson);
  assert.equal(s.bashOk, 1, 'una riga corrotta non deve invalidare l\'intero file');
});

test('parseBatch tollera il CSV scritto a mano di un workflow_dispatch', () => {
  assert.deepEqual(parseBatch('56,57 , 58'), [56, 57, 58]);
  assert.deepEqual(parseBatch(' 56 '), [56]);
  assert.deepEqual(parseBatch('56,,x,#57'), [56], 'i token non numerici si scartano, non si lancia');
  assert.deepEqual(parseBatch(''), []);
  assert.deepEqual(parseBatch(undefined), []);
});

test('issuesForPr attribuisce solo per titolo canonico', () => {
  const list = JSON.stringify([
    { number: 1, title: 'follow-up(#56): a' },
    { number: 2, title: '  follow-up(#56): con spazi davanti' },
    { number: 3, title: 'follow-up(#5): PR diversa, prefisso simile' },
    { number: 4, title: 'qualcosa su follow-up(#56) ma non in testa' },
  ]);
  assert.deepEqual(issuesForPr(list, 56), [1, 2]);
  assert.deepEqual(issuesForPr(list, 5), [3]);
  assert.deepEqual(issuesForPr('json rotto', 56), []);
  assert.deepEqual(issuesForPr('', 56), []);
});

test('decide non scrive mai un corpo quando non deve scrivere', () => {
  // Invariante trasversale: l\'unica azione irreversibile del backstop e\'
  // postare. Ogni ramo che non e\' `post` deve avere `body === null`, cosi\' un
  // refactor non puo\' far cadere un corpo in un ramo che non lo prevede.
  const cases = [
    { pr: 1, markerPresent: true, delivered: true },
    { pr: 2, markerPresent: false, delivered: false },
    { pr: 3, markerPresent: null, delivered: true },
    { pr: 4, markerPresent: null, delivered: false },
  ];
  for (const c of cases) {
    const d = decide(c);
    assert.notEqual(d.action, 'post', `il caso ${JSON.stringify(c)} non deve postare`);
    assert.equal(d.body, null);
  }
});

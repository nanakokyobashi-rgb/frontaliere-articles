/**
 * Un body corretto sulla stessa HEAD ammette UNA review `minimal`, non una
 * review piena (trasporto adattato del sito #9275, fix 5).
 *
 * Il valore sta nei confini, non nel ramo felice: questo helper decide di
 * spendere o non spendere un turno di modello, e sbagliare in una delle due
 * direzioni costa in modo diverso. Ammettere troppo riapre la classe
 * #9066/#9074 (LGTM poi 🔴 sulla stessa HEAD) e regala review illimitate a un
 * loop di body edit; ammettere troppo poco riporta la review piena, che e'
 * proprio il costo che la fix toglie. I test qui pinnano i tre NO — LGTM
 * sticky, cap per HEAD, revisione gia' giudicata — prima del SI'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_BODY_REREVIEWS_PER_HEAD,
  admissionCli,
  hasOpenCodeImportant,
  shouldAdmitBodyReReview,
} from '../../scripts/ci/body-rereview-admission.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEAD = 'a'.repeat(40);
const REVISION = `body:${'1'.repeat(64)}`;
const OLD_REVISION = `body:${'2'.repeat(64)}`;

const review = ({
  body, commit = HEAD, at = '2026-09-19T10:00:00Z', login = 'claude[bot]', state = 'COMMENTED',
}) => ({
  user: { type: 'Bot', login },
  state,
  commit_id: commit,
  submitted_at: at,
  body,
});

const redflag = (revision = OLD_REVISION) => [
  `<!-- REVIEW_INPUT_REVISION: ${revision} -->`,
  '`PR body:L5`: 🔴 Important: la voce non dichiara uno stato.',
].join('\n');

const lgtm = (revision = OLD_REVISION) => [
  `<!-- REVIEW_INPUT_REVISION: ${revision} -->`,
  'Important: 0',
  '',
  '## LGTM',
].join('\n');

test('verdetto non approvante + body corretto dopo di esso → ammesso', () => {
  assert.equal(shouldAdmitBodyReReview({
    headSha: HEAD,
    revision: REVISION,
    reviews: [[review({ body: redflag() })]],
    bodyEditedAt: '2026-09-19T10:05:00Z',
  }), true);
});

test('un LGTM pulito sulla HEAD resta sticky: un body edit non compra una review', () => {
  assert.equal(shouldAdmitBodyReReview({
    headSha: HEAD,
    revision: REVISION,
    reviews: [[review({ body: lgtm() })]],
    bodyEditedAt: '2026-09-19T10:05:00Z',
  }), false, 'e\' la classe #9066/#9074: LGTM poi 🔴 sulla stessa HEAD');

  // Un LGTM accanto a un 🔴 NON e' approvante: quello e' un verdetto negativo
  // e il body corretto merita il secondo giro.
  assert.equal(shouldAdmitBodyReReview({
    headSha: HEAD,
    revision: REVISION,
    reviews: [[review({ body: `${redflag()}\n\n## LGTM` })]],
    bodyEditedAt: '2026-09-19T10:05:00Z',
  }), true);
});

test('il cap per HEAD impedisce a un loop di body edit review illimitate', () => {
  const many = Array.from({ length: MAX_BODY_REREVIEWS_PER_HEAD + 1 }, (_, i) => review({
    body: redflag(),
    at: `2026-09-19T10:0${i}:00Z`,
  }));
  assert.equal(shouldAdmitBodyReReview({
    headSha: HEAD, revision: REVISION, reviews: [many], bodyEditedAt: '2026-09-19T11:00:00Z',
  }), false);
  // Il cap dichiarato e' 3: con 3 verdetti gia' sulla HEAD, il quarto NON si
  // ammette. Con `>` ne passava uno in piu' di quanti il docblock prometteva.
  assert.equal(shouldAdmitBodyReReview({
    headSha: HEAD,
    revision: REVISION,
    reviews: [many.slice(0, MAX_BODY_REREVIEWS_PER_HEAD)],
    bodyEditedAt: '2026-09-19T11:00:00Z',
  }), false, `con ${MAX_BODY_REREVIEWS_PER_HEAD} verdetti il cap e' raggiunto`);
  assert.equal(shouldAdmitBodyReReview({
    headSha: HEAD,
    revision: REVISION,
    reviews: [many.slice(0, MAX_BODY_REREVIEWS_PER_HEAD - 1)],
    bodyEditedAt: '2026-09-19T11:00:00Z',
  }), true, 'sotto il cap si ammette');
});

test('un 🔴 di CODICE aperto chiude la corsia body-only', () => {
  // La garanzia non puo' essere una promessa fatta al modello nel prompt: una
  // review `minimal` che dimentica di riportare un Important di codice chiude
  // il gate, e il finding sparisce su un contributo che nessuno ha riparato.
  // Se c'e' codice aperto, correggere il body non basta: review piena.
  const withCode = [
    `<!-- REVIEW_INPUT_REVISION: ${OLD_REVISION} -->`,
    '`PR body:L5`: 🔴 Important: la voce non dichiara uno stato.',
    '`engine/render.mjs:42`: 🔴 Important: il canonical e\' sbagliato.',
  ].join('\n');
  assert.equal(hasOpenCodeImportant(withCode), true);
  assert.equal(shouldAdmitBodyReReview({
    headSha: HEAD, revision: REVISION, reviews: [[review({ body: withCode })]],
    bodyEditedAt: '2026-09-19T10:05:00Z',
  }), false);

  // Anche un Important SENZA alcun anchor e' lavoro aperto che il body non tocca.
  const noAnchor = [
    `<!-- REVIEW_INPUT_REVISION: ${OLD_REVISION} -->`,
    '🔴 Important: il contratto del manifest non regge.',
  ].join('\n');
  assert.equal(hasOpenCodeImportant(noAnchor), true);
  assert.equal(shouldAdmitBodyReReview({
    headSha: HEAD, revision: REVISION, reviews: [[review({ body: noAnchor })]],
    bodyEditedAt: '2026-09-19T10:05:00Z',
  }), false);

  // Un Important di CODICE che MENZIONA un anchor del body senza esserne
  // ancorato resta lavoro aperto: cercare l'anchor ovunque nel testo apriva
  // la corsia e faceva sparire il finding dal verdetto.
  const mentionsAnchor = [
    `<!-- REVIEW_INPUT_REVISION: ${OLD_REVISION} -->`,
    '🔴 Important: il canonical e\' sbagliato, vedi anche `PR body:L5`.',
  ].join('\n');
  assert.equal(hasOpenCodeImportant(mentionsAnchor), true,
    'l\'anchor deve essere la POSIZIONE del finding, non una menzione');

  // Solo body → la corsia si apre, anche con un anchor a intervallo.
  assert.equal(hasOpenCodeImportant(redflag()), false);
  assert.equal(hasOpenCodeImportant([
    `<!-- REVIEW_INPUT_REVISION: ${OLD_REVISION} -->`,
    '`PR body:L5-6`: 🔴 Important: le due voci non tornano.',
  ].join('\n')), false);
});

test('il recupero del verdetto precedente non usa una flag che `gh api` non ha', () => {
  // `gh api` non supporta `--arg`: e' di `jq`. Passarla faceva fallire il
  // comando, e l'errore inghiottito lasciava al reviewer un contesto VUOTO
  // mentre il bundle gli prometteva il verdetto precedente verbatim.
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
  // Il blocco ESATTO che produce il file, non una finestra attorno al nome:
  // il prefetch fa altre chiamate `gh api` e una finestra ne pescava una
  // qualsiasi, rendendo il guard cieco alla regressione che deve vedere.
  const open = workflow.indexOf('if ! gh api');
  assert.notEqual(open, -1, 'recupero del verdetto precedente non trovato');
  const close = workflow.indexOf('previous-review.md"; then', open);
  assert.notEqual(close, -1, 'chiusura del recupero non trovata');
  const block = workflow.slice(open, close);
  const beforeJq = block.split('| jq')[0];
  assert.match(beforeJq, /gh api "repos\/\$REPO\/pulls\/\$PR_NUMBER\/reviews"/u,
    'il blocco trovato non e\' il recupero delle review');
  assert.ok(!/--arg\b/u.test(beforeJq),
    '`--arg` passata a `gh api`: il comando fallisce e il contesto resta vuoto');
  assert.match(block, /\|\s*jq -r --arg head/u, 'la query deve passare da jq vero');
  assert.match(workflow.slice(open, close + 600), /::warning::Verdetto precedente/u,
    'un recupero fallito va DICHIARATO, non travestito da «non c\'era niente»');
});

test('fra due verdetti con lo stesso timestamp vince quello con l\'id piu\' alto', () => {
  const at = '2026-09-19T10:00:00Z';
  const older = { ...review({ body: redflag(), at }), id: 10 };
  const newer = { ...review({ body: lgtm(), at }), id: 11 };
  // Il piu' recente e' un LGTM pulito: sticky, niente ammissione, comunque
  // sia ordinato l'array in ingresso.
  for (const order of [[older, newer], [newer, older]]) {
    assert.equal(shouldAdmitBodyReReview({
      headSha: HEAD, revision: REVISION, reviews: [order], bodyEditedAt: '2026-09-19T10:05:00Z',
    }), false, `ordine ${order.map((r) => r.id).join(',')}`);
  }
});

test('un body gia\' giudicato su questa HEAD non si rigiudica', () => {
  assert.equal(shouldAdmitBodyReReview({
    headSha: HEAD,
    revision: REVISION,
    reviews: [[review({ body: redflag(REVISION) })]],
    bodyEditedAt: '2026-09-19T10:05:00Z',
  }), false, 'la review porta gia\' la revisione corrente: niente di nuovo');
});

test('un edit PRIMA dell\'ultimo verdetto, o senza data, non ammette niente', () => {
  const reviews = [[review({ body: redflag(), at: '2026-09-19T10:00:00Z' })]];
  assert.equal(shouldAdmitBodyReReview({
    headSha: HEAD, revision: REVISION, reviews, bodyEditedAt: '2026-09-19T09:59:00Z',
  }), false, 'il verdetto e\' successivo all\'edit: lo ha gia\' visto');
  assert.equal(shouldAdmitBodyReReview({
    headSha: HEAD, revision: REVISION, reviews, bodyEditedAt: 'none',
  }), false, 'body mai modificato');
  assert.equal(shouldAdmitBodyReReview({
    headSha: HEAD, revision: REVISION, reviews, bodyEditedAt: '',
  }), false);
});

test('una review su un\'altra HEAD, non terminale o di un non-reviewer non conta', () => {
  const at = '2026-09-19T10:00:00Z';
  const edited = '2026-09-19T10:05:00Z';
  const cases = [
    review({ body: redflag(), commit: 'b'.repeat(40) }),
    review({ body: redflag(), state: 'PENDING' }),
    review({ body: redflag(), state: 'DISMISSED' }),
    { user: { type: 'User', login: 'umano' }, state: 'COMMENTED', commit_id: HEAD, submitted_at: at, body: redflag() },
    review({ body: redflag(), login: 'github-actions[bot]' }),
  ];
  for (const [index, entry] of cases.entries()) {
    assert.equal(shouldAdmitBodyReReview({
      headSha: HEAD, revision: REVISION, reviews: [[entry]], bodyEditedAt: edited,
    }), false, `caso ${index} non deve ammettere`);
  }
  // Lo stesso github-actions[bot] CON il marker del fallback Codex e' invece
  // un reviewer riconosciuto.
  assert.equal(shouldAdmitBodyReReview({
    headSha: HEAD,
    revision: REVISION,
    reviews: [[review({ body: `<!-- CODEX_FALLBACK_REVIEW -->\n${redflag()}`, login: 'github-actions[bot]' })]],
    bodyEditedAt: edited,
  }), true);
});

test('la CLI non ammette su input illeggibile e stampa la forma GITHUB_OUTPUT', () => {
  const out = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = () => true;
  try {
    assert.equal(admissionCli(['--head', HEAD, '--revision', REVISION, '--body-edited-at', '2026-09-19T10:05:00Z'], 'non-json'), 0);
    assert.equal(out.join(''), 'body_rereview=false\n', 'un JSON rotto non compra la corsia economica');
    out.length = 0;
    admissionCli(
      ['--head', HEAD, '--revision', REVISION, '--body-edited-at', '2026-09-19T10:05:00Z'],
      JSON.stringify([[review({ body: redflag() })]]),
    );
    assert.equal(out.join(''), 'body_rereview=true\n');
  } finally {
    process.stdout.write = realWrite;
    process.stderr.write = realErr;
  }
});

test('tests.yml consuma davvero l\'ammissione e la porta al tier minimal', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/tests.yml'), 'utf8');
  assert.match(workflow, /node scripts\/ci\/body-rereview-admission\.mjs/u,
    'il guard deve invocare l\'helper');
  assert.match(workflow, /BODY_REREVIEW: \$\{\{ steps\.guard\.outputs\.body_rereview \}\}/u,
    'lo step tier deve ricevere la decisione del guard');
  assert.match(workflow, /if \[ "\$\{BODY_REREVIEW:-\}" = "true" \]; then[\s\S]{0,400}set_tier minimal/u,
    'la decisione deve produrre il tier minimal, non una review piena');
  assert.ok(workflow.includes('## Code contribution unchanged'),
    'il bundle deve dire al reviewer che il codice non e\' cambiato');
  assert.ok(workflow.includes('### Previous verdict on this HEAD (verbatim)'),
    'il bundle deve portare il verdetto precedente, non solo l\'istruzione di riportarlo');
  assert.match(workflow, /previous-review\.md/u,
    'il prefetch deve recuperare il verdetto precedente');
  assert.match(workflow, /CODE_UNCHANGED_SINCE: \$\{\{ steps\.tier\.outputs\.code_unchanged_since \}\}/u,
    'il prefetch deve ricevere il riferimento della review precedente');
  // L'ordine e' parte del contratto: il LGTM pulito sulla revisione corrente
  // deve essere valutato PRIMA dell'ammissione del body, altrimenti un edit
  // potrebbe riaprire una review gia' approvata su quello stesso body.
  const stickyAt = workflow.indexOf('nessuna seconda review, anche dopo un body edit');
  const admitAt = workflow.indexOf('body_rereview:-false');
  assert.ok(stickyAt !== -1 && admitAt !== -1 && stickyAt < admitAt,
    'il ramo LGTM-sticky deve precedere il ramo body_rereview');
});

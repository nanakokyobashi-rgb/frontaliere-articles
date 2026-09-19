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
    headSha: HEAD,
    revision: REVISION,
    reviews: [many],
    bodyEditedAt: '2026-09-19T11:00:00Z',
  }), false);
  assert.equal(shouldAdmitBodyReReview({
    headSha: HEAD,
    revision: REVISION,
    reviews: [many.slice(0, MAX_BODY_REREVIEWS_PER_HEAD)],
    bodyEditedAt: '2026-09-19T11:00:00Z',
  }), true, 'esattamente al cap si ammette ancora');
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

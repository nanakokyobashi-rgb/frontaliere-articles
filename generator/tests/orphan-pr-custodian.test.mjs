import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionMarker,
  cancelledRequiredSuites,
  classifyOrphan,
  isAutonomousPr,
  reviewRevisionForBody,
} from '../../scripts/ci/orphan-pr-custodian.mjs';
import { VITEST_CHECK_NAME } from '../../scripts/ci/lib/constants.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const NOW_S = Date.parse('2026-09-19T17:40:00Z') / 1000;
const WORKFLOW = readFileSync(new URL('../../.github/workflows/stale-pr-rescuer.yml', import.meta.url), 'utf8');

function pr(overrides = {}) {
  return {
    number: 1591,
    draft: false,
    headRef: 'audit-stale-claim-marker',
    headSha: HEAD,
    updatedAt: '2026-09-19T11:09:00Z',
    headCommittedAt: '2026-09-19T11:09:00Z',
    authorType: 'User',
    labels: [],
    ...overrides,
  };
}

function review(body, commit = HEAD, id = 10) {
  return { id, state: 'COMMENTED', commit_id: commit, body, user: { type: 'Bot', login: 'frontaliere-automation[bot]' } };
}

function checkRun(id, suite, conclusion, status = 'completed', sha = HEAD) {
  return {
    id,
    name: VITEST_CHECK_NAME,
    head_sha: sha,
    status,
    conclusion,
    check_suite: { id: suite },
    details_url: `https://github.com/o/r/actions/runs/${suite * 10}/job/${id}`,
  };
}

const outOfScope = {
  user: { login: 'github-actions[bot]' },
  body: '<!-- REDFLAG_OUT_OF_SCOPE -->\nℹ️ 🔴-fixer: fuori scope',
};
const IMPORTANT = '## Findings\nscripts/x.mjs:L1: 🔴 Important: rompe il contratto.';

describe('orphan-pr-custodian — rerun di un check richiesto CANCELLED con LGTM (corpus #1591)', () => {
  it('rilancia la suite cancellata anche quando un\'altra suite dello stesso check e\' verde', () => {
    const decision = classifyOrphan({
      pr: pr(),
      checkRuns: [checkRun(1, 7, 'cancelled'), checkRun(2, 8, 'success')],
      reviews: [review('## LGTM\nTutto ok.')],
      comments: [],
      nowS: NOW_S,
    });
    assert.equal(decision.action, 'rerun');
    assert.deepEqual(decision.runIds, ['70']);
  });

  it('usa solo l\'ultima generazione di ogni suite: un rerun verde chiude la suite', () => {
    const { cancelled } = cancelledRequiredSuites(
      [checkRun(1, 7, 'cancelled'), checkRun(3, 7, 'success')], HEAD, VITEST_CHECK_NAME);
    assert.deepEqual(cancelled, []);
  });

  it('non agisce senza LGTM sulla HEAD, con una run in volo, o dopo il marker', () => {
    const base = { checkRuns: [checkRun(1, 7, 'cancelled')], comments: [], nowS: NOW_S };
    assert.equal(classifyOrphan({ ...base, pr: pr(), reviews: [review('## LGTM', OLD)] }).action, 'none');
    assert.notEqual(classifyOrphan({ ...base, pr: pr(), reviews: [review(`## LGTM\n${IMPORTANT}`)] }).action, 'rerun');
    assert.equal(classifyOrphan({
      ...base, pr: pr(), reviews: [review('## LGTM')],
      checkRuns: [checkRun(1, 7, 'cancelled'), checkRun(4, 9, null, 'in_progress')],
    }).action, 'none');
    assert.equal(classifyOrphan({
      ...base, pr: pr(), reviews: [review('## LGTM')],
      // Il marker del rerun porta la generazione cancellata (check-run id 1).
      comments: [{ user: { login: 'github-actions[bot]' }, body: actionMarker('rerun', HEAD, '1') }],
    }).action, 'none');
  });

  it('non tocca una PR con un push nelle ultime 2 ore o in draft', () => {
    const args = { checkRuns: [checkRun(1, 7, 'cancelled')], reviews: [review('## LGTM')], comments: [], nowS: NOW_S };
    assert.equal(classifyOrphan({
      ...args,
      pr: pr({ updatedAt: '2026-09-19T16:30:00Z', headCommittedAt: '2026-09-19T16:30:00Z' }),
    }).action, 'none');
    assert.equal(classifyOrphan({ ...args, pr: pr({ draft: true }) }).action, 'none');
  });

  it('l\'orologio e\' il push, non `updated_at` che il bot di review rinfresca', () => {
    // #1599 su questo repo: aperta da 11,7 h, ultimo push 20:04Z, nessun agente
    // vivo — ma `updated_at` diceva 1,8 h perche' il reviewer aveva appena
    // postato il suo ennesimo 🔴.
    const rinfrescata = pr({
      updatedAt: '2026-09-19T17:00:00Z',
      headCommittedAt: '2026-09-19T09:00:00Z',
    });
    assert.equal(classifyOrphan({
      pr: rinfrescata, checkRuns: [], reviews: [review(IMPORTANT)], comments: [], nowS: NOW_S,
    }).action, 'adopt');
  });

  it('ricade su `updated_at` quando la data del push non e\' leggibile', () => {
    assert.equal(classifyOrphan({
      pr: pr({ headCommittedAt: undefined }), checkRuns: [], reviews: [review(IMPORTANT)],
      comments: [], nowS: NOW_S,
    }).action, 'adopt');
    assert.equal(classifyOrphan({
      pr: pr({ headCommittedAt: '', updatedAt: 'non-una-data' }), checkRuns: [],
      reviews: [review(IMPORTANT)], comments: [], nowS: NOW_S,
    }).action, 'none');
  });
});

describe('orphan-pr-custodian — adozione di un 🔴 fuori scope (sito #9221/#9224/#9230)', () => {
  it('adotta una PR umana con 🔴 sulla HEAD e REDFLAG_OUT_OF_SCOPE', () => {
    const decision = classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT)], comments: [outOfScope], nowS: NOW_S,
    });
    assert.equal(decision.action, 'adopt');
  });

  it('lascia ai fixer le PR gia\' autonome e rispetta needs-human', () => {
    const args = { checkRuns: [], reviews: [review(IMPORTANT)], comments: [outOfScope], nowS: NOW_S };
    assert.equal(classifyOrphan({ ...args, pr: pr({ headRef: 'fix/issue-1' }) }).action, 'none');
    assert.equal(classifyOrphan({ ...args, pr: pr({ labels: ['agent:autofix'] }) }).action, 'none');
    assert.equal(classifyOrphan({ ...args, pr: pr({ authorType: 'Bot' }) }).action, 'none');
    assert.equal(classifyOrphan({ ...args, pr: pr({ labels: ['needs-human'] }) }).action, 'none');
  });

  it('adotta anche senza REDFLAG_OUT_OF_SCOPE: il marker e\' prova, non precondizione', () => {
    // Il commento lo scrive `pr-redflag-fixer.yml` con lo stesso predicato di
    // `isAutonomousPr` gia' valutato qui. Su questo repo quel workflow non
    // girava dal 17-09 (le review le posta `github-actions[bot]` e GitHub
    // sopprime il `pull_request_review` a valle), quindi il ramo era morto.
    const senzaMarker = classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT)], comments: [], nowS: NOW_S,
    });
    assert.equal(senzaMarker.action, 'adopt');
    assert.equal(senzaMarker.outOfScopeDeclared, false);
    assert.ok(senzaMarker.reason.includes('nessun run del redflag-fixer'));

    const conMarker = classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT)], comments: [outOfScope], nowS: NOW_S,
    });
    assert.equal(conMarker.action, 'adopt');
    assert.equal(conMarker.outOfScopeDeclared, true);
  });

  it('non adotta su review vecchia o due volte', () => {
    assert.equal(classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT, OLD)], comments: [outOfScope], nowS: NOW_S,
    }).action, 'none');
    assert.equal(classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT)],
      comments: [outOfScope, { user: { login: 'github-actions[bot]' }, body: actionMarker('adopt', HEAD) }],
      nowS: NOW_S,
    }).action, 'none');
  });

  it('non accredita un REDFLAG_OUT_OF_SCOPE scritto da un utente qualsiasi', () => {
    assert.equal(classifyOrphan({
      pr: pr(), checkRuns: [], reviews: [review(IMPORTANT)],
      comments: [{ user: { login: 'someone' }, body: outOfScope.body }], nowS: NOW_S,
    }).outOfScopeDeclared, false);
  });

  it('non riusa un verdetto emesso su una revisione precedente del body', () => {
    const REV_A = `body:${'1'.repeat(64)}`;
    const REV_B = `body:${'2'.repeat(64)}`;
    const marcata = (rev, body) => review(`<!-- REVIEW_INPUT_REVISION: ${rev} -->\n${body}`);
    const base = { pr: pr(), checkRuns: [], comments: [], nowS: NOW_S };
    assert.equal(classifyOrphan({ ...base, reviews: [marcata(REV_B, IMPORTANT)], reviewRevision: REV_B }).action, 'adopt');
    assert.equal(classifyOrphan({ ...base, reviews: [marcata(REV_A, IMPORTANT)], reviewRevision: REV_B }).action, 'none');
    assert.equal(classifyOrphan({ ...base, reviews: [marcata(REV_A, IMPORTANT)] }).action, 'none');
    assert.equal(classifyOrphan({ ...base, reviews: [review(IMPORTANT)], reviewRevision: REV_B }).action, 'adopt');
    // Due marker: il gate non riusa quel verdetto, e nemmeno noi.
    assert.equal(classifyOrphan({
      ...base,
      reviews: [review(`<!-- REVIEW_INPUT_REVISION: ${REV_A} -->\n<!-- REVIEW_INPUT_REVISION: ${REV_B} -->\n${IMPORTANT}`)],
      reviewRevision: REV_B,
    }).action, 'none');
    // Newline serializzati come due caratteri: li normalizza il parser canonico.
    assert.equal(classifyOrphan({
      ...base,
      reviews: [review(`<!-- REVIEW_INPUT_REVISION: ${REV_B} -->\\n${IMPORTANT}`)],
      reviewRevision: REV_B,
    }).action, 'adopt');
  });

  it('usa il parser canonico dei marker, non una copia locale della regex', () => {
    const src = readFileSync(new URL('../../scripts/ci/orphan-pr-custodian.mjs', import.meta.url), 'utf8');
    assert.ok(src.includes("from './lib/review-input-revision.mjs'"));
  });

  it('la revisione si calcola come `body:sha256(body + newline)`', () => {
    assert.equal(reviewRevisionForBody('ciao'),
      `body:${createHash('sha256').update('ciao\n').digest('hex')}`);
    assert.equal(reviewRevisionForBody(undefined), null);
  });

  it('un rerun a sua volta cancellato non mura la PR: il marker e\' per generazione', () => {
    const base = { pr: pr(), reviews: [review('## LGTM')], nowS: NOW_S };
    const primo = classifyOrphan({ ...base, checkRuns: [checkRun(1, 7, 'cancelled')], comments: [] });
    assert.equal(primo.action, 'rerun');
    const markerPrimo = { user: { login: 'github-actions[bot]' }, body: actionMarker('rerun', HEAD, primo.rerunKey) };
    assert.equal(classifyOrphan({
      ...base, checkRuns: [checkRun(1, 7, 'cancelled')], comments: [markerPrimo],
    }).action, 'none');
    assert.equal(classifyOrphan({
      ...base, checkRuns: [checkRun(5, 7, 'cancelled')], comments: [markerPrimo],
    }).action, 'rerun');
  });

  it('non adotta una PR il cui head sta su un fork', () => {
    assert.equal(classifyOrphan({
      pr: pr({ headRepo: 'someone/fork', baseRepo: 'o/r' }), checkRuns: [], reviews: [review(IMPORTANT)],
      comments: [outOfScope], nowS: NOW_S,
    }).action, 'none');
  });

  it('rilancia la run intera (niente --failed) e ritira le label se il dispatch fallisce', () => {
    const src = readFileSync(new URL('../../scripts/ci/orphan-pr-custodian.mjs', import.meta.url), 'utf8');
    assert.ok(src.includes("gh(['run', 'rerun', runId, '--repo', repo]);"));
    assert.ok(!src.includes("'--failed'"));
    const onFail = src.slice(src.indexOf('dispatch del redflag-fixer fallito') - 600);
    assert.ok(onFail.includes('ok = false;'));
    assert.ok(onFail.includes("'--remove-label', AUTOFIX_LABEL, '--remove-label', ORPHANED_LABEL"));
  });

  it('usa la stessa definizione di autonomia dei fixer', () => {
    assert.equal(isAutonomousPr(pr({ headRef: 'automerge-x' })), true);
    assert.equal(isAutonomousPr(pr()), false);
  });
});

describe('stale-pr-rescuer — cablaggio', () => {
  it('non crea nemmeno il run per i tests di main (filtro sul trigger)', () => {
    assert.match(WORKFLOW, /workflow_run:\n\s+workflows: \['tests'\]\n\s+types: \[completed\]\n(?:\s+#.*\n)*\s+branches-ignore: \[main\]\n/);
  });

  it('non gira sui completamenti di tests dei push su main', () => {
    assert.ok(WORKFLOW.includes("if: github.event_name != 'workflow_run' || github.event.workflow_run.event != 'push'"));
  });

  it('misura l\'inattivita\' sul push, come il custode che esegue', () => {
    assert.ok(WORKFLOW.includes("PUSHED_AT=$(gh api \"repos/$REPO/commits/$HEAD\" --jq '.commit.committer.date'"));
    assert.ok(WORKFLOW.includes('IDLE_SINCE="${PUSHED_AT:-$UPD}"'));
    assert.ok(!WORKFLOW.includes('UPD_S=$(date -u -d "$UPD" +%s'));
  });

  it('porta il modulo canonico della revisione nel checkout sparse del custode', () => {
    assert.match(WORKFLOW, /sparse-checkout: \|\n(?:\s+\S+\n)*\s+scripts\/ci\/lib\/review-input-revision\.mjs\n/);
  });

  it('esegue il custode con lo script e le costanti presenti nel checkout sparse', () => {
    assert.match(WORKFLOW, /sparse-checkout: \|\n(?:\s+\S+\n)*\s+scripts\/ci\/orphan-pr-custodian\.mjs\n/);
    assert.ok(WORKFLOW.includes('scripts/ci/lib/constants.mjs'));
    assert.ok(WORKFLOW.includes('run: node scripts/ci/orphan-pr-custodian.mjs'));
    // Qui il fixer accetta il dispatch: l'adozione lo avvia subito.
    assert.ok(WORKFLOW.includes('REDFLAG_FIXER_DISPATCH_INPUT: pr'));
  });
});

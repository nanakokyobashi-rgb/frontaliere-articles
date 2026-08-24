/**
 * handoff-to-site.test.mjs — il passaggio di consegne verso il sito.
 *
 * Il difetto, misurato il 2026-08-24: `blocked-admin-settings` su questo repo non
 * descrive impostazioni di repo. Su tutte e 4 le issue aperte che lo portavano —
 * #548, #531, #513, #472 — la forma era «lato sbagliato del mirror»: il fixer
 * verifica al turno 1 che il file da cambiare vive sul SITO, lo scrive, e si
 * ferma. La diagnosi è corretta, completa e già pagata, e nessuno la portava di
 * là: il verdetto la trasformava in un parcheggio, che è il modo più costoso di
 * avere ragione.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handoffDecision,
  extractSitePaths,
  handoffTitle,
  lastVerdictComment,
  HANDOFF_VERDICTS,
  SITE_REPO,
} from '../../scripts/ci/handoff-to-site.mjs';

const MIRROR_BODY = 'Root cause nota: il JSDoc bugiardo vive in `scripts/create-article.mjs` '
  + 'del repo **`valerielinc-ops/frontaliere-si-o-no`**, non in questo repo. '
  + 'Confermato: `generator/scripts/create-article.mjs` qui è diverso.';

test('instrada il caso mirror: verdetto + repo del sito + path', () => {
  const d = handoffDecision({ verdict: 'blocked-admin-settings', body: MIRROR_BODY });
  assert.equal(d.handoff, true);
  assert.ok(d.paths.includes('scripts/create-article.mjs'));
});

test('serve la CONGIUNZIONE: due condizioni su tre non bastano', () => {
  // È la congiunzione a selezionare 4 casi su 4 senza falsi. Allentarla a una
  // disgiunzione spedirebbe al sito ogni `blocked-admin-settings`, incluse le
  // impostazioni di repo che sono davvero tali.
  assert.equal(handoffDecision({ verdict: 'no-root-cause', body: MIRROR_BODY }).handoff, false);
  assert.equal(handoffDecision({
    verdict: 'blocked-admin-settings',
    body: 'serve branch protection su `main`, niente a che vedere con l\'altro repo',
  }).handoff, false);
  assert.equal(handoffDecision({
    verdict: 'blocked-admin-settings',
    body: 'il fix va in valerielinc-ops/frontaliere-si-o-no ma non so dove',
  }).handoff, false, 'senza un path la diagnosi non è azionabile: non si spedisce');
});

test('senza verdetto → non instradata, e il default è non spedire', () => {
  assert.equal(handoffDecision({}).handoff, false);
  assert.equal(handoffDecision({ verdict: null, body: MIRROR_BODY }).handoff, false);
});

test('i due verdetti instradabili sono solo quelli osservati', () => {
  assert.ok(HANDOFF_VERDICTS.has('blocked-admin-settings'));
  assert.ok(HANDOFF_VERDICTS.has('blocked-workflows-scope'));
  for (const v of ['already-fixed', 'no-root-cause', 'max-turns', 'pr-created']) {
    assert.equal(HANDOFF_VERDICTS.has(v), false, v);
  }
});

test('extractSitePaths prende solo i path in backtick, che è la forma prescritta', () => {
  assert.deepEqual(extractSitePaths('vedi `scripts/a/b.mjs` e `x/y.ts`'), ['scripts/a/b.mjs', 'x/y.ts']);
  // Prosa che nomina un file senza backtick: non è un path citato, ed è giusto
  // che non conti — il fixer li scrive in backtick per contratto.
  assert.deepEqual(extractSitePaths('il file scripts/a/b.mjs è rotto'), []);
  assert.deepEqual(extractSitePaths(''), []);
  assert.deepEqual(extractSitePaths(null), []);
});

test('il titolo mette il discriminante PRIMO', () => {
  // Chi legge i titoli taglia a 60 caratteri: un discriminante in coda si perde,
  // e due consegne diverse diventerebbero lo stesso titolo.
  const t = handoffTitle(548, 'follow-up(#537): JSDoc bugiardo nel gemello sito');
  assert.ok(t.startsWith('corpus#548:'));
});

test('lastVerdictComment prende il PIÙ RECENTE, in entrambe le forme di data', () => {
  const got = lastVerdictComment([
    { body: '<!-- FIX_OUTCOME: no-root-cause -->', created_at: '2026-08-19T10:00:00Z' },
    { body: `<!-- FIX_OUTCOME: blocked-admin-settings -->\n${MIRROR_BODY}`, createdAt: '2026-08-22T10:00:00Z' },
  ]);
  assert.equal(got.verdict, 'blocked-admin-settings');
  assert.ok(got.body.includes('create-article.mjs'));
});

test('lastVerdictComment è null quando non c\'è nessun marker', () => {
  assert.equal(lastVerdictComment([{ body: 'solo prosa' }]), null);
  assert.equal(lastVerdictComment([]), null);
  assert.equal(lastVerdictComment(null), null);
});

test('il repo di destinazione è il sito, non un placeholder', () => {
  assert.match(SITE_REPO, /^valerielinc-ops\/frontaliere-si-o-no$/);
});

test('lo script è CITATO da issue-fix.yml: non è codice scollegato', async () => {
  // Difetto ricorrente di questo ciclo: un meccanismo costruito e mai attaccato
  // a niente non fa fallire nulla. Se qualcuno lo scollega, questo test lo dice.
  const fs = await import('node:fs');
  const wf = fs.readFileSync(new URL('../../.github/workflows/issue-fix.yml', import.meta.url), 'utf8');
  assert.match(wf, /handoff-to-site\.mjs/);
  assert.match(wf, /SITE_TOKEN:/);
});

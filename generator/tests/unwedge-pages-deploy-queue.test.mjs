/**
 * unwedge-pages-deploy-queue.test.mjs — il reaper del gate `github-pages` di
 * publish-api.yml cancella SOLO cio' che non ha iniziato a eseguire, ed e'
 * davvero collegato al publisher che deve sbloccare.
 *
 * Porta in node:test i casi di `tests/pages-deploy-queue-invariants.test.ts`
 * del sito (selectWedgedRuns) e aggiunge i legami che qui non sono importabili:
 * il nome del workflow nello script, i permessi e la cadenza del chiamante, la
 * concurrency che rende necessaria la valvola. Run reale: 36762664618, ferma
 * in `waiting` dal 2026-09-30T19:00:51Z con `reviewers: []` e `wait_timer: 0`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import {
  cancelVerdict,
  gateEntryMs,
  parkedAtPagesGate,
  selectWedgedRuns,
  wedgeAgeMinutes,
} from '../../scripts/ci/unwedge-pages-deploy-queue.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NOW = Date.parse('2026-10-01T06:00:00Z');
const at = (iso, status, id = 1, head_branch = 'main') => ({ id, status, head_branch, created_at: iso });

test('seleziona la run parcheggiata al gate oltre la soglia (run 36762664618)', () => {
  const runs = [at('2026-09-30T19:00:49Z', 'waiting', 36762664618)];
  assert.deepEqual(selectWedgedRuns(runs, { nowMs: NOW }).map((r) => r.id), [36762664618]);
  assert.equal(wedgeAgeMinutes(Date.parse(runs[0].created_at), NOW), 659);
});

test("non seleziona MAI una run che esegue, e' in coda o e' finita, per quanto vecchia", () => {
  // L'asserzione portante: cancellare una run in esecuzione interrompe un
  // deploy Pages o la spinta all'edge a meta', che e' il danno che la
  // concurrency `cancel-in-progress: false` di publish-api.yml evita.
  const old = '2026-09-01T00:00:00Z';
  for (const status of ['in_progress', 'queued', 'pending', 'completed', 'requested']) {
    assert.deepEqual(selectWedgedRuns([at(old, status)], { nowMs: NOW }), [], status);
  }
});

test('lascia stare una run appena entrata al gate', () => {
  assert.deepEqual(selectWedgedRuns([at('2026-10-01T05:50:00Z', 'waiting')], { nowMs: NOW }), []);
});

test('rispetta una soglia esplicita in entrambe le direzioni', () => {
  const runs = [at('2026-10-01T05:00:00Z', 'waiting')]; // 60 min
  assert.equal(selectWedgedRuns(runs, { nowMs: NOW, thresholdMinutes: 30 }).length, 1);
  assert.equal(selectWedgedRuns(runs, { nowMs: NOW, thresholdMinutes: 90 }).length, 0);
});

test('fallisce CHIUSO su un timestamp illeggibile o assente', () => {
  assert.deepEqual(selectWedgedRuns([{ id: 1, status: 'waiting', created_at: 'not-a-date' }], { nowMs: NOW }), []);
  assert.deepEqual(selectWedgedRuns([{ id: 2, status: 'waiting' }], { nowMs: NOW }), []);
});

test('tollera una risposta API malformata senza lanciare', () => {
  assert.deepEqual(selectWedgedRuns(undefined, { nowMs: NOW }), []);
  assert.deepEqual(selectWedgedRuns([null], { nowMs: NOW }), []);
});

test('lo script punta al publisher che esiste, e il publisher ha ancora il gate e la concurrency che lo rendono necessario', () => {
  const script = read('scripts/ci/unwedge-pages-deploy-queue.mjs');
  assert.match(script, /DEPLOY_QUEUE_API_TIMEOUT_MS/);
  assert.match(script, /signal:\s*controller\.signal/g);
  assert.match(script, /Math\.min\(Math\.max\(1, Math\.floor\(raw\)\), 120_000\)/);
  assert.match(script, /return await res\.json\(\)/);
  assert.match(script, /clearTimeout\(timer\)/g);
  assert.match(script, /cancel failed \(\$\{err\?\.message \|\| err\}\)/);
  const workflowFile = script.match(/const WORKFLOW_FILE = '([^']+)'/)?.[1];
  assert.ok(workflowFile, 'WORKFLOW_FILE non trovato nello script');
  const publisherPath = `.github/workflows/${workflowFile}`;
  assert.ok(fs.existsSync(path.join(ROOT, publisherPath)), `${publisherPath} non esiste: il reaper non sbloccherebbe niente`);
  const publisher = read(publisherPath);
  assert.match(publisher, /environment:\s*\n\s*name: github-pages/);
  assert.match(publisher, /concurrency:\s*\n\s*group: publish-api\s*\n\s*queue: max\s*\n\s*cancel-in-progress: false/);
});

test('il chiamante gira a cadenza, invoca lo script e ha actions: write', () => {
  const caller = read('.github/workflows/publish-api-unwedge.yml');
  assert.match(caller, /\n\s*schedule:\s*\n\s*- cron: /);
  assert.match(caller, /node scripts\/ci\/unwedge-pages-deploy-queue\.mjs/);
  // Senza, la cancel risponde 403: il gate resta incastrato a run verde.
  assert.match(caller, /\n\s*actions: write/);
  // Lo sparse checkout deve portare anche l'import dello script.
  assert.match(caller, /scripts\/lib\/githubApiHeaders\.mjs/);
});

// ── Review 5376724637 (PR #2017): ref, ingresso nel gate, ri-lettura, esito ──

// Forme reali della run 36762664618 (run, job `publish`, pending deployment).
const REAL_RUN = { id: 36762664618, status: 'waiting', head_branch: 'main', event: 'push', created_at: '2026-09-30T19:00:49Z', head_sha: '4e40008a' };
const REAL_JOBS = [{ name: 'publish', status: 'waiting', created_at: '2026-09-30T19:00:50Z' }];
const REAL_PENDING = [{ environment: { name: 'github-pages' }, wait_timer: 0, wait_timer_started_at: null, reviewers: [], current_user_can_approve: false }];

test('selectWedgedRuns scarta una run di un ref diverso da main', () => {
  assert.deepEqual(selectWedgedRuns([at('2026-09-30T19:00:49Z', 'waiting', 7, 'feature')], { nowMs: NOW }), []);
  assert.deepEqual(selectWedgedRuns([{ id: 8, status: 'waiting', created_at: '2026-09-30T19:00:49Z' }], { nowMs: NOW }), []);
});

test("gateEntryMs legge l'ingresso nel gate dal job in waiting, il piu' recente se sono piu' d'uno", () => {
  assert.equal(gateEntryMs(REAL_JOBS), Date.parse('2026-09-30T19:00:50Z'));
  assert.equal(
    gateEntryMs([
      { status: 'completed', created_at: '2026-10-01T05:59:00Z' },
      { status: 'waiting', created_at: '2026-10-01T04:00:00Z' },
      { status: 'waiting', created_at: '2026-10-01T05:00:00Z' },
    ]),
    Date.parse('2026-10-01T05:00:00Z'),
  );
  assert.ok(Number.isNaN(gateEntryMs([{ status: 'queued', created_at: '2026-09-01T00:00:00Z' }])));
  assert.ok(Number.isNaN(gateEntryMs([{ status: 'waiting', created_at: 'not-a-date' }])));
  assert.ok(Number.isNaN(gateEntryMs(undefined)));
});

test('parkedAtPagesGate vuole un pending deployment github-pages', () => {
  assert.equal(parkedAtPagesGate(REAL_PENDING), true);
  assert.equal(parkedAtPagesGate([{ environment: { name: 'production' } }]), false);
  assert.equal(parkedAtPagesGate([]), false);
  assert.equal(parkedAtPagesGate(undefined), false);
});

test('cancelVerdict cancella la run reale 36762664618', () => {
  const v = cancelVerdict({ run: REAL_RUN, jobs: REAL_JOBS, pendingDeployments: REAL_PENDING, nowMs: NOW });
  assert.equal(v.cancel, true);
  assert.equal(v.ageMinutes, 659);
});

test('cancelVerdict lascia una run creata da ore ma arrivata al gate da poco (coda o runner)', () => {
  const run = { ...REAL_RUN, created_at: '2026-10-01T03:00:00Z' };
  const jobs = [{ status: 'waiting', created_at: '2026-10-01T05:50:00Z' }];
  assert.equal(selectWedgedRuns([run], { nowMs: NOW }).length, 1, 'la lista la candida');
  const v = cancelVerdict({ run, jobs, pendingDeployments: REAL_PENDING, nowMs: NOW });
  assert.equal(v.cancel, false);
  assert.match(v.reason, /within the 45-min threshold/);
});

test("cancelVerdict non cancella se alla ri-lettura la run non e' piu' waiting", () => {
  for (const status of ['in_progress', 'queued', 'completed']) {
    const v = cancelVerdict({ run: { ...REAL_RUN, status }, jobs: REAL_JOBS, pendingDeployments: REAL_PENDING, nowMs: NOW });
    assert.equal(v.cancel, false, status);
  }
});

test('cancelVerdict non cancella un altro ref, ne\' senza gate github-pages, ne\' senza job in waiting', () => {
  const base = { run: REAL_RUN, jobs: REAL_JOBS, pendingDeployments: REAL_PENDING, nowMs: NOW };
  assert.equal(cancelVerdict({ ...base, run: { ...REAL_RUN, head_branch: 'feature' } }).cancel, false);
  assert.equal(cancelVerdict({ ...base, pendingDeployments: [] }).cancel, false);
  assert.equal(cancelVerdict({ ...base, jobs: [{ status: 'in_progress', created_at: '2026-09-30T19:00:50Z' }] }).cancel, false);
});

// Lo script vero, con `fetch` sostituito: niente rete, niente token reale.
function runScript(routes, { failListAfterFirst = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unwedge-'));
  const mock = path.join(dir, 'mock-fetch.mjs');
  fs.writeFileSync(mock, `
const routes = JSON.parse(process.env.MOCK_ROUTES);
globalThis.__calls = [];
let listHits = 0;
globalThis.fetch = async (url, init = {}) => {
  const method = init.method || 'GET';
  const hit = routes.find((r) => (r.method || 'GET') === method && url.includes(r.match));
  process.stderr.write('CALL ' + method + ' ' + url + '\\n');
  if (!hit) return new Response('{}', { status: 404 });
  if (process.env.FAIL_LIST_AFTER_FIRST === '1' && hit.match.endsWith('/runs') && ++listHits > 1) return new Response('{}', { status: 500 });
  const st = hit.status ?? 200;
  return new Response(st === 204 ? null : JSON.stringify(hit.body ?? {}), { status: st });
};
`);
  const res = spawnSync(process.execPath, ['--import', mock, path.join(ROOT, 'scripts/ci/unwedge-pages-deploy-queue.mjs')], {
    env: { ...process.env, GH_TOKEN: 'test-token', GITHUB_REPOSITORY: 'o/r', MOCK_ROUTES: JSON.stringify(routes), FAIL_LIST_AFTER_FIRST: failListAfterFirst ? '1' : '0' },
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

const LIST = '/actions/workflows/publish-api.yml/runs';
const wedgedRoutes = (cancelStatus, { dispatchStatus = 204 } = {}) => [
  { match: '/actions/workflows/publish-api.yml/dispatches', method: 'POST', status: dispatchStatus },
  { match: LIST, body: { workflow_runs: [REAL_RUN] } },
  { match: `/actions/runs/${REAL_RUN.id}/jobs`, body: { jobs: REAL_JOBS } },
  { match: `/actions/runs/${REAL_RUN.id}/pending_deployments`, body: REAL_PENDING },
  { match: `/actions/runs/${REAL_RUN.id}/cancel`, method: 'POST', status: cancelStatus },
  { match: `/actions/runs/${REAL_RUN.id}`, body: REAL_RUN },
];

test('script: niente di incastrato → exit 0', () => {
  const r = runScript([{ match: LIST, body: { workflow_runs: [] } }]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Nothing wedged/);
});

test('script: lista illeggibile o malformata → exit 1 con ::error::, nessuna cancel', () => {
  for (const routes of [[{ match: LIST, status: 500 }], [{ match: LIST, body: { message: 'x' } }]]) {
    const r = runScript(routes);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /::error::Could not read publish-api\.yml runs/);
    assert.doesNotMatch(r.stderr, /CALL POST/);
  }
});

test('script: run incastrata e cancel accettata → exit 0, una sola POST dopo la ri-lettura', () => {
  const r = runScript(wedgedRoutes(202));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Cancelled 1 wedged run/);
  const calls = r.stderr.split('\n').filter((l) => l.startsWith('CALL'));
  const post = calls.findIndex((l) => l.startsWith('CALL POST'));
  assert.ok(post > calls.findIndex((l) => l.includes('/pending_deployments')), 'la cancel arriva dopo la ri-lettura');
  // Una cancel + un dispatch di rete (la sola run viva era quella annullata).
  assert.equal(calls.filter((l) => l.startsWith('CALL POST') && l.includes('/cancel')).length, 1);
  assert.equal(calls.filter((l) => l.startsWith('CALL POST') && l.includes('/dispatches')).length, 1);
  assert.ok(calls.findIndex((l) => l.includes('/dispatches')) > post, 'il dispatch segue la cancel');
});

test('script: un\'altra run push viva dopo il cancel → nessun dispatch', () => {
  const other = { id: 5, event: 'push', head_branch: 'main', status: 'queued' };
  // La prima GET (status=waiting) vede la run incastrata; la ri-lettura dopo il cancel vede anche un push nuovo.
  const routes = wedgedRoutes(202).map((r) => (r.match === LIST ? { ...r, body: { workflow_runs: [REAL_RUN, other] } } : r));
  const r = runScript(routes);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no redispatch needed/);
  assert.doesNotMatch(r.stderr, /CALL POST .*\/dispatches/);
});

test('script: ri-lettura dopo il cancel fallita → dispatch comunque (fail verso la pubblicazione)', () => {
  const routes = wedgedRoutes(202);
  const r = runScript(routes, { failListAfterFirst: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /dispatching to be safe/);
  assert.match(r.stderr, /CALL POST .*\/dispatches/);
});

test('script: dispatch di rete rifiutato → exit 1 con ::error::', () => {
  const r = runScript(wedgedRoutes(202, { dispatchStatus: 403 }));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /redispatch of publish-api\.yml failed/);
});

test('script: cancel rifiutata → exit 1 con ::error::, la coda non viene data per libera', () => {
  const r = runScript(wedgedRoutes(403));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /::error::The publish-api queue may still be jammed/);
});

test("script: alla ri-lettura la run e' partita → nessuna cancel, exit 0", () => {
  const routes = wedgedRoutes(202).map((r) => (r.match === `/actions/runs/${REAL_RUN.id}` ? { ...r, body: { ...REAL_RUN, status: 'in_progress' } } : r));
  const r = runScript(routes);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /CALL POST/);
  assert.match(r.stdout, /left alone — status is now in_progress/);
});

// ── Cessione della coalescenza revocabile: rete di redispatch ──

test('needsRedispatch: dispaccia salvo che sopravviva un\'altra run push viva di main, non annullata ora', async () => {
  const { needsRedispatch } = await import('../../scripts/ci/unwedge-pages-deploy-queue.mjs');
  const live = (id, over = {}) => ({ id, event: 'push', head_branch: 'main', status: 'queued', ...over });
  // Lettura fallita o malformata: non si prova che qualcuno pubblichi -> dispatch.
  assert.equal(needsRedispatch(null, { cancelledIds: [1] }), true);
  assert.equal(needsRedispatch(undefined, { cancelledIds: [1] }), true);
  // Solo la run appena annullata (anche se la lista la mostra ancora viva): dispatch.
  assert.equal(needsRedispatch([live(1, { status: 'waiting' })], { cancelledIds: [1] }), true);
  // Un'altra run push viva: nessun dispatch (un push arrivato dopo il cancel e' visto qui).
  assert.equal(needsRedispatch([live(1, { status: 'waiting' }), live(2)], { cancelledIds: [1] }), false);
  assert.equal(needsRedispatch([live(2, { status: 'in_progress' })], { cancelledIds: [1] }), false);
  // Non contano: run chiuse, di altri branch, o non push (un replay pinned non copre main).
  assert.equal(needsRedispatch([live(2, { status: 'completed' })], { cancelledIds: [1] }), true);
  assert.equal(needsRedispatch([live(2, { head_branch: 'x' })], { cancelledIds: [1] }), true);
  assert.equal(needsRedispatch([live(2, { event: 'workflow_dispatch' })], { cancelledIds: [1] }), true);
  assert.equal(needsRedispatch([], { cancelledIds: [1] }), true);
});

test('lo script dispaccia publish-api su main dopo il cancel e il workflow cita la rete', () => {
  const script = read('scripts/ci/unwedge-pages-deploy-queue.mjs');
  assert.match(script, /actions\/workflows\/\$\{WORKFLOW_FILE\}\/dispatches/);
  assert.match(script, /JSON\.stringify\(\{ ref: PUBLISH_BRANCH \}\)/);
  assert.match(script, /redispatch of \$\{WORKFLOW_FILE\} failed/);
  const publisher = read('.github/workflows/publish-api.yml');
  assert.match(publisher, /Cessione revocabile/);
  assert.match(publisher, /publish-api-unwedge ne dispaccia una nuova su main/);
});

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
import { selectWedgedRuns, wedgeAgeMinutes } from '../../scripts/ci/unwedge-pages-deploy-queue.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const NOW = Date.parse('2026-10-01T06:00:00Z');
const at = (iso, status, id = 1) => ({ id, status, created_at: iso });

test('seleziona la run parcheggiata al gate oltre la soglia (run 36762664618)', () => {
  const runs = [at('2026-09-30T19:00:49Z', 'waiting', 36762664618)];
  assert.deepEqual(selectWedgedRuns(runs, { nowMs: NOW }).map((r) => r.id), [36762664618]);
  assert.equal(wedgeAgeMinutes(runs[0], NOW), 659);
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
  const workflowFile = script.match(/const WORKFLOW_FILE = '([^']+)'/)?.[1];
  assert.ok(workflowFile, 'WORKFLOW_FILE non trovato nello script');
  const publisherPath = `.github/workflows/${workflowFile}`;
  assert.ok(fs.existsSync(path.join(ROOT, publisherPath)), `${publisherPath} non esiste: il reaper non sbloccherebbe niente`);
  const publisher = read(publisherPath);
  assert.match(publisher, /environment:\s*\n\s*name: github-pages/);
  assert.match(publisher, /concurrency:\s*\n\s*group: publish-api\s*\n\s*cancel-in-progress: false/);
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

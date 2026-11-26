import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isDrainPromotable } from '../../scripts/ci/followup-drainer.mjs';

const AUTOREBASE = readFileSync(new URL('../../.github/workflows/pr-autorebase.yml', import.meta.url), 'utf8');
const RECONCILER = readFileSync(new URL('../../.github/workflows/conflict-handoff-reconcile.yml', import.meta.url), 'utf8');
const DRAINER = readFileSync(new URL('../../.github/workflows/followup-drainer.yml', import.meta.url), 'utf8');
const DRAINER_SCRIPT = readFileSync(new URL('../../scripts/ci/followup-drainer.mjs', import.meta.url), 'utf8');
const RECONCILE_SCRIPT = readFileSync(new URL('../../scripts/ci/reconcile-conflict-handoffs.mjs', import.meta.url), 'utf8');
const AUTOREBASE_SCRIPT = readFileSync(new URL('../../scripts/ci/pr-autorebase.mjs', import.meta.url), 'utf8');

function jobBlock(source, name) {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job ${name} non trovato`);
  const tail = source.slice(start + 1);
  const next = tail.search(/\n {2}[a-zA-Z_][\w-]*:\n/);
  return next === -1 ? tail : tail.slice(0, next);
}

function concurrencyPolicy(source) {
  const match = source.match(/\n\s*concurrency:\n\s*group:\s*([^\n]+)\n\s*cancel-in-progress:\s*(true|false)/);
  assert.ok(match, 'concurrency policy non trovata');
  return { group: match[1].trim(), cancelInProgress: match[2] === 'true' };
}

function writerQueue(arrivals) {
  const active = new Map();
  const pending = new Map();
  const cancelled = [];
  const completed = [];
  let maxActive = 0;

  const arrive = (writer) => {
    const running = active.get(writer.group);
    if (!running) {
      active.set(writer.group, writer);
    } else if (writer.cancelInProgress) {
      cancelled.push(running.name);
      active.set(writer.group, writer);
    } else {
      pending.set(writer.group, writer);
    }
    maxActive = Math.max(maxActive, active.size);
  };

  const finish = (group) => {
    const running = active.get(group);
    assert.ok(running, `nessun writer attivo per ${group}`);
    completed.push(running.name);
    const queued = pending.get(group);
    if (queued) {
      active.set(group, queued);
      pending.delete(group);
    } else {
      active.delete(group);
    }
    maxActive = Math.max(maxActive, active.size);
  };

  arrivals.forEach(arrive);
  return { active, pending, cancelled, completed, finish, get maxActive() { return maxActive; } };
}

function githubHandoffStore() {
  const issues = [];
  let createCount = 0;
  let routeCount = 0;
  return {
    find(origin, head) {
      return issues.find((issue) => issue.origin === origin && issue.head === head) ?? null;
    },
    create(origin, head) {
      createCount += 1;
      const issue = { number: 20_000 + createCount, origin, head, labels: new Set() };
      issues.push(issue);
      return issue;
    },
    route(issue) {
      routeCount += 1;
      issue.labels.add('agent:fix');
    },
    counts() {
      return { create: createCount, route: routeCount };
    },
  };
}

function* conflictHandoffProducer(store, origin, head) {
  // Il primo yield rende esplicita la finestra TOCTOU: senza mutex due writer
  // possono osservare stati diversi della stessa issue.
  const existing = store.find(origin, head);
  yield 'read';
  existing ?? store.create(origin, head);
  yield 'create-or-reuse';
}

function* conflictHandoffConsumer(store, origin, head) {
  const existing = store.find(origin, head);
  yield 'read';
  if (existing && !existing.labels.has('agent:fix')) store.route(existing);
  yield 'route-or-keep';
}

function runToCompletion(task) {
  for (let step = task.next(); !step.done; step = task.next()) {
    // I yield sono punti di interleaving del test, non effetti aggiuntivi.
  }
}

test('autorebase e reconciler condividono il mutex repo-wide non cancellante', () => {
  const autorebase = concurrencyPolicy(AUTOREBASE);
  const reconcile = concurrencyPolicy(RECONCILER);

  assert.equal(autorebase.group, 'conflict-handoff-writer-${{ github.repository }}');
  assert.deepEqual(reconcile, autorebase);
  assert.equal(autorebase.cancelInProgress, false);
  assert.match(RECONCILER, /\n  schedule:\n/);
  assert.match(RECONCILER, /\n  workflow_dispatch:\n/);
  assert.doesNotMatch(RECONCILER, /\n  issues:\n/);
});

test('due writer concorrenti completano in serie senza cancellazioni', () => {
  const autorebase = concurrencyPolicy(AUTOREBASE);
  const reconcile = concurrencyPolicy(RECONCILER);
  const queue = writerQueue([
    { name: 'pr-autorebase', ...autorebase },
    { name: 'reconcile-conflict-handoffs', ...reconcile },
  ]);

  assert.equal(queue.active.size, 1);
  assert.equal(queue.pending.size, 1);
  assert.deepEqual(queue.cancelled, []);
  queue.finish(autorebase.group);
  assert.equal(queue.active.get(autorebase.group)?.name, 'reconcile-conflict-handoffs');
  queue.finish(autorebase.group);
  assert.deepEqual(queue.completed, ['pr-autorebase', 'reconcile-conflict-handoffs']);
  assert.equal(queue.maxActive, 1);

  const unsafe = writerQueue([
    { name: 'pr-autorebase', ...autorebase },
    { name: 'reconcile-conflict-handoffs', ...reconcile, group: `${reconcile.group}-drift` },
  ]);
  assert.equal(unsafe.maxActive, 2, 'il controllo deve fallire se i gruppi divergono');
});

test('due writer sulla stessa origine+HEAD creano e instradano un solo hand-off', () => {
  const policy = concurrencyPolicy(AUTOREBASE);
  const origin = 19_422;
  const head = 'a'.repeat(40);
  const store = githubHandoffStore();
  const queue = writerQueue([
    { name: 'pr-autorebase-create', ...policy, task: conflictHandoffProducer(store, origin, head) },
    { name: 'reconcile-route', ...policy, task: conflictHandoffConsumer(store, origin, head) },
  ]);

  while (queue.active.size > 0) {
    const [group, writer] = queue.active.entries().next().value;
    runToCompletion(writer.task);
    queue.finish(group);
  }
  assert.deepEqual(store.counts(), { create: 1, route: 1 });

  // Controprova della fixture: senza il single-flight il consumer legge
  // l'assenza prima della create e perde il routing fino a un tick successivo.
  const racedStore = githubHandoffStore();
  const racedConsumer = conflictHandoffConsumer(racedStore, origin, head);
  const racedProducer = conflictHandoffProducer(racedStore, origin, head);
  assert.equal(racedConsumer.next().value, 'read');
  assert.equal(racedProducer.next().value, 'read');
  runToCompletion(racedProducer);
  runToCompletion(racedConsumer);
  assert.deepEqual(racedStore.counts(), { create: 1, route: 0 });
});

test('il drain resta indipendente dal reconciler e conserva il mutex daily preesistente', () => {
  const drain = jobBlock(DRAINER, 'drain');
  assert.doesNotMatch(drain, /\n    needs:/);
  assert.deepEqual(concurrencyPolicy(drain), {
    group: 'followup-daily-${{ github.repository }}',
    cancelInProgress: false,
  });
  assert.doesNotMatch(DRAINER, /run: node scripts\/ci\/reconcile-conflict-handoffs\.mjs/);
  assert.doesNotMatch(DRAINER, /conflict-handoff-writer-/);
});

test('il workflow autonomo è l’unico consumer che promuove gli hand-off di conflitto', () => {
  const handoff = {
    title: 'Conflitto con main dopo LGTM: riapplicare la PR #19422 su main',
    labels: [{ name: 'agent:fix-queued' }],
  };
  assert.equal(isDrainPromotable(handoff), false);
  assert.equal(isDrainPromotable({ title: 'follow-up ordinaria', labels: handoff.labels }), true);
  assert.match(
    DRAINER_SCRIPT,
    /const pool = listIssues\(LBL_QUEUED\)[\s\S]*?\.filter\(\(i\) => conflictHandoffOriginPr\(i\.title\) === null\);/,
  );
  assert.doesNotMatch(DRAINER_SCRIPT, /function routeHandoff\(/);
  const producer = AUTOREBASE_SCRIPT.slice(
    AUTOREBASE_SCRIPT.indexOf('function handOffConflictToFixer('),
    AUTOREBASE_SCRIPT.indexOf('function commentConflictOnce('),
  );
  assert.doesNotMatch(producer, /'--add-label', 'agent:fix'/);
  assert.match(RECONCILE_SCRIPT, /function routeHandoff\(/);
  assert.match(RECONCILE_SCRIPT, /'--add-label', 'agent:fix'/);
});

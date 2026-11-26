import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const AUTOREBASE = readFileSync(new URL('../../.github/workflows/pr-autorebase.yml', import.meta.url), 'utf8');
const RECONCILER = readFileSync(new URL('../../.github/workflows/conflict-handoff-reconcile.yml', import.meta.url), 'utf8');
const DRAINER = readFileSync(new URL('../../.github/workflows/followup-drainer.yml', import.meta.url), 'utf8');

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

function* conflictHandoffWriter(store, origin, head) {
  // Il primo yield rende esplicita la finestra TOCTOU: senza mutex due writer
  // possono osservare entrambi l'assenza prima che uno dei due crei la issue.
  const existing = store.find(origin, head);
  yield 'read';
  const issue = existing ?? store.create(origin, head);
  yield 'create-or-reuse';
  if (!issue.labels.has('agent:fix')) store.route(issue);
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
    { name: 'autorebase-run-a', ...policy, task: conflictHandoffWriter(store, origin, head) },
    { name: 'autorebase-run-b', ...policy, task: conflictHandoffWriter(store, origin, head) },
  ]);

  while (queue.active.size > 0) {
    const [group, writer] = queue.active.entries().next().value;
    runToCompletion(writer.task);
    queue.finish(group);
  }
  assert.deepEqual(store.counts(), { create: 1, route: 1 });

  // Controprova della fixture: senza il single-flight entrambi leggono
  // l'assenza prima della create e producono due issue, entrambe instradate.
  const racedStore = githubHandoffStore();
  const raced = [
    conflictHandoffWriter(racedStore, origin, head),
    conflictHandoffWriter(racedStore, origin, head),
  ];
  raced.forEach((writer) => assert.equal(writer.next().value, 'read'));
  raced.forEach(runToCompletion);
  assert.deepEqual(racedStore.counts(), { create: 2, route: 2 });
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

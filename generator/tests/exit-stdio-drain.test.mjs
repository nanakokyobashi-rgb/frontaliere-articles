/**
 * Regressioni per il drenaggio degli stream prima di `process.exit()` (#1134).
 *
 * Il primo livello usa pipe reali: una write oltre il buffer della pipe viene
 * seguita da una coda di log su stdout e stderr. Il secondo livello sorveglia
 * staticamente ogni uscita terminale dei tre entry point, perche' create-
 * article.mjs non e' importabile in questa suite senza le dipendenze runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('../scripts/lib/drain-stdio.mjs', import.meta.url));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Stay above the largest POSIX pipe capacity used by the CI runners: the
// no-drain branch must have bytes pending when it calls process.exit().
const PAYLOAD_BYTES = 2_000_001;
const OUT_TAIL = 'STDOUT-TELEMETRY-TAIL';
const ERR_TAIL = 'STDERR-TELEMETRY-TAIL';

function sourceOf(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function runChild({ drain }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'frontaliere-drain-'));
  const childFile = path.join(dir, 'child.mjs');
  writeFileSync(childFile, [
    drain ? `import { exitAfterDrain } from ${JSON.stringify(LIB)};` : '',
    `process.stdout.write('o'.repeat(${PAYLOAD_BYTES}));`,
    `process.stderr.write('e'.repeat(${PAYLOAD_BYTES}));`,
    `process.stdout.write(${JSON.stringify(OUT_TAIL)});`,
    `process.stderr.write(${JSON.stringify(ERR_TAIL)});`,
    drain ? 'await exitAfterDrain(7);' : 'process.exit(7);',
  ].join('\n'));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    const collect = () => {
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.stderr.on('data', (chunk) => err.push(chunk));
    };

    // Without the helper, attach readers only once the child has already
    // exited: bytes still in the kernel pipe remain observable, while bytes
    // left in Node's write queue are gone. With the helper, read immediately
    // so the child can actually complete its bounded drain.
    if (drain) collect();
    child.once('error', reject);
    child.once('exit', () => { if (!drain) collect(); });
    child.once('close', (code) => {
      const result = {
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      };
      rmSync(dir, { recursive: true, force: true });
      resolve(result);
    });
  });
}

function runBlockedChild() {
  const dir = mkdtempSync(path.join(tmpdir(), 'frontaliere-drain-timeout-'));
  const childFile = path.join(dir, 'child.mjs');
  writeFileSync(childFile, [
    `import { exitAfterDrain } from ${JSON.stringify(LIB)};`,
    `process.stdout.write('x'.repeat(${PAYLOAD_BYTES * 4}));`,
    'await exitAfterDrain(9, 40);',
  ].join('\n'));
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.once('error', reject);
    child.once('close', (code) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ code: code ?? -1, elapsedMs: Date.now() - startedAt });
    });
  });
}

function consumerSkeleton() {
  const stream = new EventEmitter();
  stream.writableEnded = false;
  stream.destroyed = false;
  stream.writableLength = 1;
  stream.writableNeedDrain = true;
  return stream;
}

function closedConsumer() {
  const stream = consumerSkeleton();
  stream.write = () => {
    stream.emit('close');
    stream.emit('error', Object.assign(new Error('consumer closed'), { code: 'EPIPE' }));
    // No write callback: close/error are not delivery confirmation.
    return false;
  };
  return stream;
}

function errorConsumer() {
  const stream = consumerSkeleton();
  stream.write = () => {
    queueMicrotask(() => stream.emit('error', Object.assign(new Error('consumer failed'), { code: 'EPIPE' })));
    return false;
  };
  return stream;
}

function completedConsumer() {
  const stream = consumerSkeleton();
  stream.write = (_chunk, callback) => callback();
  return stream;
}

function throwingConsumer(stateFlag) {
  const stream = consumerSkeleton();
  stream.write = () => {
    if (stateFlag) stream[stateFlag] = true;
    throw new Error('write rejected');
  };
  return stream;
}

function idleConsumer() {
  const stream = consumerSkeleton();
  stream.writableLength = 0;
  stream.writableNeedDrain = false;
  return stream;
}

test('senza drain la coda delle pipe si perde, con drain arrivano entrambi gli stream', async () => {
  const lost = await runChild({ drain: false });
  assert.ok(lost.stdout.length < PAYLOAD_BYTES + OUT_TAIL.length, 'stdout non risulta troncato nel caso senza drain');
  assert.ok(lost.stderr.length < PAYLOAD_BYTES + ERR_TAIL.length, 'stderr non risulta troncato nel caso senza drain');
  assert.doesNotMatch(lost.stdout, new RegExp(OUT_TAIL));
  assert.doesNotMatch(lost.stderr, new RegExp(ERR_TAIL));

  const drained = await runChild({ drain: true });
  assert.equal(drained.code, 7);
  assert.equal(drained.stdout.length, PAYLOAD_BYTES + OUT_TAIL.length);
  assert.equal(drained.stderr.length, PAYLOAD_BYTES + ERR_TAIL.length);
  assert.match(drained.stdout, new RegExp(`${OUT_TAIL}$`));
  assert.match(drained.stderr, new RegExp(`${ERR_TAIL}$`));
});

test('un buffer gia\' vuoto non paga il timeout', async () => {
  const { drainStdio } = await import('../scripts/lib/drain-stdio.mjs');
  const startedAt = Date.now();
  await drainStdio(60_000);
  assert.ok(Date.now() - startedAt < 1_000);
});

test('un consumer bloccato non supera il timeout e non cambia l\'exit code', async () => {
  const result = await runBlockedChild();
  assert.equal(result.code, 9);
  assert.ok(result.elapsedMs < 1_000, `timeout non bounded: ${result.elapsedMs}ms`);
});

test('close/error del consumer non confermano il flush: resta il timeout bounded', async () => {
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process, 'stderr');
  Object.defineProperty(process, 'stdout', { configurable: true, enumerable: true, value: closedConsumer() });
  Object.defineProperty(process, 'stderr', { configurable: true, enumerable: true, value: closedConsumer() });

  try {
    const { drainStdio } = await import('../scripts/lib/drain-stdio.mjs');
    const startedAt = Date.now();
    await drainStdio(50);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 35, 'close/error ha concluso prematuramente il drain: ' + elapsedMs + 'ms');
    assert.ok(elapsedMs < 500, 'timeout non bounded dopo close/error: ' + elapsedMs + 'ms');
  } finally {
    Object.defineProperty(process, 'stdout', stdoutDescriptor);
    Object.defineProperty(process, 'stderr', stderrDescriptor);
  }
});

test('error senza callback non conferma il flush: resta il timeout bounded', async () => {
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process, 'stderr');
  Object.defineProperty(process, 'stdout', { configurable: true, enumerable: true, value: errorConsumer() });
  Object.defineProperty(process, 'stderr', { configurable: true, enumerable: true, value: errorConsumer() });

  try {
    const { drainStdio } = await import('../scripts/lib/drain-stdio.mjs');
    const startedAt = Date.now();
    await drainStdio(50);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 35, 'error senza callback ha concluso prematuramente il drain: ' + elapsedMs + 'ms');
    assert.ok(elapsedMs < 500, 'timeout non bounded dopo error senza callback: ' + elapsedMs + 'ms');
  } finally {
    Object.defineProperty(process, 'stdout', stdoutDescriptor);
    Object.defineProperty(process, 'stderr', stderrDescriptor);
  }
});

test('write che lancia dopo l altro stream completato libera il proprio slot', async () => {
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process, 'stderr');
  Object.defineProperty(process, 'stdout', { configurable: true, enumerable: true, value: completedConsumer() });
  Object.defineProperty(process, 'stderr', { configurable: true, enumerable: true, value: throwingConsumer() });

  try {
    const { drainStdio } = await import('../scripts/lib/drain-stdio.mjs');
    const startedAt = Date.now();
    await drainStdio(50);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 35, 'write lanciata ha lasciato il drain in attesa del timeout: ' + elapsedMs + 'ms');
  } finally {
    Object.defineProperty(process, 'stdout', stdoutDescriptor);
    Object.defineProperty(process, 'stderr', stderrDescriptor);
  }
});

for (const stateFlag of ['writableEnded', 'destroyed']) {
  test(`stream ${stateFlag} prima di write: il drain resta bounded`, async () => {
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout');
    const stderrDescriptor = Object.getOwnPropertyDescriptor(process, 'stderr');
    Object.defineProperty(process, 'stdout', { configurable: true, enumerable: true, value: throwingConsumer(stateFlag) });
    Object.defineProperty(process, 'stderr', { configurable: true, enumerable: true, value: idleConsumer() });

    try {
      const { drainStdio } = await import('../scripts/lib/drain-stdio.mjs');
      const startedAt = Date.now();
      await drainStdio(50);
      const elapsedMs = Date.now() - startedAt;
      assert.ok(elapsedMs < 35, `${stateFlag} prima di write ha lasciato il drain in attesa: ${elapsedMs}ms`);
    } finally {
      Object.defineProperty(process, 'stdout', stdoutDescriptor);
      Object.defineProperty(process, 'stderr', stderrDescriptor);
    }
  });
}

test('create-article drena dopo il ledger e prima dell\'unico process.exit nudo', () => {
  const source = sourceOf('scripts/create-article.mjs');
  const start = source.indexOf('async function exitAfterFlush(code) {');
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, 'exitAfterFlush non trovato');
  const body = source.slice(start, end);
  const flush = body.indexOf('flushScoresBeforeExit()');
  const drain = body.indexOf('await drainStdio(');
  const exit = body.indexOf('process.exit(');
  assert.ok(flush >= 0 && flush < drain && drain < exit);
  assert.match(body, /process\.exitCode\s*=\s*code/);
  assert.equal((source.match(/^\s*process\.exit\(/gm) || []).length, 1);
  assert.match(source, /exitAfterDrain\(143\)/);
});

test('batch e fix-faq non mantengono uscite nude', () => {
  const batch = sourceOf('scripts/batch-add-faq-to-articles.mjs');
  assert.match(batch, /import \{ exitAfterDrain \} from '\.\/lib\/drain-stdio\.mjs'/);
  assert.match(batch.slice(batch.indexOf('main().catch(')), /await exitAfterDrain\(1\)/);
  assert.equal((batch.match(/^\s*process\.exit\(/gm) || []).length, 0);

  const fix = sourceOf('scripts/fix-faq-locales.mjs');
  assert.match(fix, /async function parseFaqLimitOrExit\(/);
  assert.match(fix, /await exitAfterDrain\(2\)/);
  assert.match(fix, /await exitAfterDrain\(1\)/);
  assert.equal((fix.match(/^\s*process\.exit\(/gm) || []).length, 0);
});

test('i signal handler del ledger usano lo stesso drenaggio', () => {
  const source = sourceOf('scripts/lib/ai-models.mjs');
  const start = source.indexOf('function _registerExitHooks() {');
  const end = source.indexOf('\n}\n', start);
  const hooks = source.slice(start, end);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const line = hooks.split('\n').find((candidate) => candidate.includes(`'${signal}'`));
    assert.ok(line, `${signal} non registrato`);
    assert.match(line, /exitAfterDrain\(/);
    assert.doesNotMatch(line, /process\.exit\(/);
  }
});

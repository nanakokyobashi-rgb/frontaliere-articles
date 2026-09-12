/**
 * Il close dei digest e delle code deve essere verificato sulla post-condizione,
 * non sull'exit code del chiuditore best-effort.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveVerified } from '../../scripts/ci/resolve-issue-verified.mjs';

function fakeGh(handler) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const result = handler(args, calls) || {};
    return {
      status: result.status ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
  return { run, calls };
}

function capture(fn) {
  const out = [];
  const err = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  try {
    return { code: fn(), out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
}

const closeCalls = (calls) => calls.filter((args) => args[0] === 'issue' && args[1] === 'close');

test('numero: close verificato al primo tentativo', () => {
  const gh = fakeGh((args) => (args[1] === 'view' ? { stdout: 'CLOSED' } : {}));
  const { code, err } = capture(() => resolveVerified({ number: '42' }, gh));
  assert.equal(code, 0);
  assert.equal(closeCalls(gh.calls).length, 1);
  assert.doesNotMatch(err, /::error::/);
});

test('numero: decide lo stato reale, anche se il close esce non-zero', () => {
  const gh = fakeGh((args) => (
    args[1] === 'view' ? { stdout: 'CLOSED' } : { status: 1, stderr: 'HTTP 502' }
  ));
  const { code, err } = capture(() => resolveVerified({ number: '42' }, gh));
  assert.equal(code, 0);
  assert.doesNotMatch(err, /::error::/);
});

test('numero: ancora aperta dopo il primo tentativo ritenta una volta', () => {
  const gh = fakeGh((args, calls) => {
    if (args[1] !== 'view') return {};
    return { stdout: closeCalls(calls).length >= 2 ? 'CLOSED' : 'OPEN' };
  });
  const { code, out } = capture(() => resolveVerified({ number: '7' }, gh));
  assert.equal(code, 0);
  assert.equal(closeCalls(gh.calls).length, 2);
  assert.match(out, /ritento una volta/);
});

test('numero: close respinto dopo il retry annota ed esce non-zero', () => {
  const gh = fakeGh((args) => (
    args[1] === 'view' ? { stdout: 'OPEN' } : { status: 1, stderr: 'HTTP 403' }
  ));
  const { code, err } = capture(() => resolveVerified({ number: '7' }, gh));
  assert.equal(code, 1);
  assert.match(err, /^::error::/m);
  assert.match(err, /#7/);
  assert.equal(closeCalls(gh.calls).length, 2);
});

test('numero: stato non leggibile non vale come issue chiusa', () => {
  const gh = fakeGh((args) => (
    args[1] === 'view' ? { status: 1, stderr: 'rate limit' } : {}
  ));
  const { code, err } = capture(() => resolveVerified({ number: '9' }, gh));
  assert.equal(code, 1);
  assert.match(err, /::error::/);
  assert.match(err, /stato non leggibile/);
});

test('numero: commento e numero arrivano al comando di close', () => {
  const gh = fakeGh((args) => (args[1] === 'view' ? { stdout: 'CLOSED' } : {}));
  capture(() => resolveVerified({ number: '42', comment: 'coda drenata' }, gh));
  assert.deepEqual(closeCalls(gh.calls)[0].slice(0, 5), [
    'issue', 'close', '42', '--comment', 'coda drenata',
  ]);
});

test('titolo: nessuna issue aperta e un no-op verificato', () => {
  const gh = fakeGh(() => ({ stdout: '' }));
  const { code, err } = capture(() => resolveVerified(
    { title: 'Articoli fantasma: annunciati senza pagina sugli shard' },
    { ...gh, resolve: () => assert.fail('non si chiude quando non c e un match') },
  ));
  assert.equal(code, 0);
  assert.doesNotMatch(err, /::error::/);
});

test('titolo: issue ancora aperta dopo il close ritenta e poi annota', () => {
  const gh = fakeGh(() => ({ stdout: '331\n' }));
  let attempts = 0;
  const { code, err } = capture(() => resolveVerified(
    { title: 'Articoli fantasma: annunciati senza pagina sugli shard' },
    { ...gh, resolve: () => { attempts += 1; } },
  ));
  assert.equal(code, 1);
  assert.equal(attempts, 2);
  assert.match(err, /::error::/);
  assert.match(err, /#331/);
});

test('titolo: query di verifica non leggibile non vale come chiusura', () => {
  const gh = fakeGh(() => ({ status: 1, stderr: 'HTTP 502' }));
  const { code, err } = capture(() => resolveVerified(
    { title: 'Articoli fantasma: annunciati senza pagina sugli shard' },
    { ...gh, resolve: () => assert.fail('query non leggibile: non chiudere alla cieca') },
  ));
  assert.equal(code, 1);
  assert.match(err, /non leggibile/);
});

test('titolo: la verifica usa REST paginata e non search/issues', () => {
  const gh = fakeGh(() => ({ stdout: '' }));
  capture(() => resolveVerified(
    { title: 'Articoli fantasma: annunciati senza pagina sugli shard' },
    { ...gh, resolve: () => {} },
  ));
  const api = gh.calls.find((args) => args[0] === 'api');
  assert.ok(api);
  assert.ok(api.includes('--paginate'));
  assert.ok(api.some((arg) => /state=open&per_page=100/.test(arg)));
  assert.ok(!api.some((arg) => /search\/issues/.test(arg)));
});

test('titolo: la chiave della verifica viene da searchSafePrefix', () => {
  const longTitle = 'Articoli con control character C0: ripubblicazione incompleta e altro';
  const gh = fakeGh(() => ({ stdout: '' }));
  capture(() => resolveVerified({ title: longTitle }, { ...gh, resolve: () => {} }));
  const api = gh.calls.find((args) => args[0] === 'api');
  const jq = api[api.indexOf('--jq') + 1];
  assert.match(jq, /startswith\(env\.RESOLVE_PREFIX\)/);
  assert.match(jq, /select\(\.pull_request \| not\)/);
});

test('una issue pinnata dal manifest non viene chiusa', () => {
  const gh = fakeGh(() => ({ stdout: 'OPEN' }));
  const { code, err } = capture(() => resolveVerified(
    { number: '55' },
    { ...gh, pinnedBy: () => 'scripts/ci/qualcosa.mjs' },
  ));
  assert.equal(code, 0);
  assert.equal(closeCalls(gh.calls).length, 0);
  assert.doesNotMatch(err, /::error::/);
});

test('una pinnata non conta come residuo nel percorso per titolo', () => {
  const gh = fakeGh(() => ({ stdout: '77\n' }));
  let delegated = 0;
  const { code } = capture(() => resolveVerified(
    { title: 'Articoli fantasma: annunciati senza pagina sugli shard' },
    {
      ...gh,
      pinnedBy: (number) => (String(number) === '77' ? 'scripts/ci/qualcosa.mjs' : null),
      resolve: () => { delegated += 1; },
    },
  ));
  assert.equal(code, 0);
  assert.equal(delegated, 0);
  assert.equal(closeCalls(gh.calls).length, 0);
});

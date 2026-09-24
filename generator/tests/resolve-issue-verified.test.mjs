/**
 * Il close dei digest e delle code deve essere verificato sulla post-condizione,
 * non sull'exit code del chiuditore best-effort.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalTitle,
  findOpenByTitle,
  resolveVerified,
} from '../../scripts/ci/resolve-issue-verified.mjs';

const noSleep = () => {};

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

test('numero: close respinto al primo tentativo viene ripetuto una volta', () => {
  const gh = fakeGh((args, calls) => {
    if (args[1] === 'close') return closeCalls(calls).length === 1 ? { status: 1, stderr: 'HTTP 502' } : {};
    return { stdout: closeCalls(calls).length >= 2 ? 'CLOSED' : 'OPEN' };
  });
  const { code, out } = capture(() => resolveVerified({ number: '7' }, { ...gh, sleep: noSleep }));
  assert.equal(code, 0);
  assert.equal(closeCalls(gh.calls).length, 2);
  assert.match(out, /ritento una volta/);
});

test('numero: close accettato e lettura stale rilegge senza ripetere il close (FU-2026-09-12-030)', () => {
  let views = 0;
  const waits = [];
  const gh = fakeGh((args) => {
    if (args[1] !== 'view') return {};
    views += 1;
    return { stdout: views === 1 ? 'OPEN' : 'CLOSED' };
  });
  const { code, out } = capture(() => resolveVerified(
    { number: '7', comment: 'coda drenata' },
    { ...gh, sleep: (ms) => waits.push(ms) },
  ));
  assert.equal(code, 0);
  assert.equal(closeCalls(gh.calls).length, 1, 'un close gia accettato non si ripete (niente secondo commento)');
  assert.equal(views, 2);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0);
  assert.match(out, /rileggo senza ripetere il close/);
});

test('numero: close accettato ma ancora aperta dopo la rilettura annota ed esce non-zero', () => {
  const gh = fakeGh((args) => (args[1] === 'view' ? { stdout: 'OPEN' } : {}));
  const { code, err } = capture(() => resolveVerified({ number: '7' }, { ...gh, sleep: noSleep }));
  assert.equal(code, 1);
  assert.equal(closeCalls(gh.calls).length, 1);
  assert.match(err, /^::error::/m);
})

test('numero: close respinto dopo il retry annota ed esce non-zero', () => {
  const gh = fakeGh((args) => (
    args[1] === 'view' ? { stdout: 'OPEN' } : { status: 1, stderr: 'HTTP 403' }
  ));
  const { code, err } = capture(() => resolveVerified({ number: '7' }, { ...gh, sleep: noSleep }));
  assert.equal(code, 1);
  assert.match(err, /^::error::/m);
  assert.match(err, /#7/);
  assert.equal(closeCalls(gh.calls).length, 2);
});

test('numero: stato non leggibile non vale come issue chiusa', () => {
  const gh = fakeGh((args) => (
    args[1] === 'view' ? { status: 1, stderr: 'rate limit' } : {}
  ));
  const { code, err } = capture(() => resolveVerified({ number: '9' }, { ...gh, sleep: noSleep }));
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

const GHOST = 'Articoli fantasma: annunciati senza pagina sugli shard';
const apiCalls = (calls) => calls.filter((args) => args[0] === 'api');

test('titolo: nessuna issue aperta e un no-op verificato', () => {
  const gh = fakeGh(() => ({ stdout: '' }));
  const { code, err } = capture(() => resolveVerified({ title: GHOST }, { ...gh, sleep: noSleep }));
  assert.equal(code, 0);
  assert.equal(closeCalls(gh.calls).length, 0);
  assert.doesNotMatch(err, /::error::/);
});

test('titolo: chiude per numero con nota e reason completed, poi verifica', () => {
  const gh = fakeGh((args, calls) => {
    if (args[0] !== 'api') return {};
    return { stdout: closeCalls(calls).length ? '' : '331\n' };
  });
  const { code, err } = capture(() => resolveVerified(
    { title: GHOST, workflow: 'reconcile-article-shards', runUrl: 'https://example.test/run/1' },
    { ...gh, sleep: noSleep },
  ));
  assert.equal(code, 0);
  assert.doesNotMatch(err, /::error::/);
  const [close] = closeCalls(gh.calls);
  assert.equal(close[2], '331');
  assert.equal(close[close.indexOf('--reason') + 1], 'completed');
  const note = close[close.indexOf('--comment') + 1];
  assert.match(note, /Auto-resolved/);
  assert.match(note, /reconcile-article-shards/);
  assert.match(note, /https:\/\/example\.test\/run\/1/);
});

test('titolo: close respinto viene ripetuto e poi annotato', () => {
  const gh = fakeGh((args) => (
    args[0] === 'api' ? { stdout: '331\n' } : { status: 1, stderr: 'HTTP 403' }
  ));
  const { code, err } = capture(() => resolveVerified({ title: GHOST }, { ...gh, sleep: noSleep }));
  assert.equal(code, 1);
  assert.equal(closeCalls(gh.calls).length, 2);
  assert.match(err, /::error::/);
  assert.match(err, /#331/);
});

test('titolo: close accettato con lista stale rilegge senza ripetere il close (FU-2026-09-12-030)', () => {
  let lists = 0;
  const gh = fakeGh((args) => {
    if (args[0] !== 'api') return {};
    lists += 1;
    return { stdout: lists <= 2 ? '331\n' : '' };
  });
  const { code } = capture(() => resolveVerified({ title: GHOST }, { ...gh, sleep: noSleep }));
  assert.equal(code, 0);
  assert.equal(closeCalls(gh.calls).length, 1);
});

test('titolo: query di verifica non leggibile non vale come chiusura', () => {
  const gh = fakeGh(() => ({ status: 1, stderr: 'HTTP 502' }));
  const { code, err } = capture(() => resolveVerified({ title: GHOST }, { ...gh, sleep: noSleep }));
  assert.equal(code, 1);
  assert.equal(closeCalls(gh.calls).length, 0, 'query non leggibile: non chiudere alla cieca');
  assert.match(err, /non leggibile/);
});

test('titolo: stdout con exit 0 ma righe non numeriche e illeggibile, non vuoto (FU-2026-09-12-028)', () => {
  for (const stdout of ['{"message":"API rate limit exceeded"}', '331\nnull\n', '331\n12abc\n']) {
    const gh = fakeGh(() => ({ stdout }));
    assert.equal(findOpenByTitle(GHOST, gh), null, JSON.stringify(stdout));
  }
  assert.deepEqual(findOpenByTitle(GHOST, fakeGh(() => ({ stdout: '' }))), []);
  assert.deepEqual(findOpenByTitle(GHOST, fakeGh(() => ({ stdout: '331\n\n331\n412\n' }))), [331, 412]);

  const gh = fakeGh(() => ({ stdout: '{"message":"API rate limit exceeded"}' }));
  const { code, err } = capture(() => resolveVerified({ title: GHOST }, { ...gh, sleep: noSleep }));
  assert.equal(code, 1, 'una risposta illeggibile non e una chiusura verificata');
  assert.match(err, /non leggibile/);
});

test('titolo: la verifica usa REST paginata e non search/issues', () => {
  const gh = fakeGh(() => ({ stdout: '' }));
  capture(() => resolveVerified({ title: GHOST }, { ...gh, sleep: noSleep }));
  const api = apiCalls(gh.calls)[0];
  assert.ok(api);
  assert.ok(api.includes('--paginate'));
  assert.ok(api.some((arg) => /state=open&per_page=100/.test(arg)));
  assert.ok(!api.some((arg) => /search\/issues/.test(arg)));
});

test('titolo: il filtro e uguaglianza sul titolo canonico, non prefisso (FU-2026-09-12-029)', () => {
  const longTitle = `Articoli con control character C0: ripubblicazione incompleta ${'x'.repeat(220)}`;
  const envs = [];
  const run = (args, env) => {
    if (args[0] === 'api') envs.push(env);
    return { status: 0, stdout: '', stderr: '' };
  };
  capture(() => resolveVerified({ title: longTitle }, { run, sleep: noSleep }));
  const jq = (() => {
    const gh = fakeGh(() => ({ stdout: '' }));
    capture(() => resolveVerified({ title: longTitle }, { ...gh, sleep: noSleep }));
    const api = apiCalls(gh.calls)[0];
    return api[api.indexOf('--jq') + 1];
  })();
  assert.match(jq, /select\(\.title == env\.RESOLVE_TITLE\)/);
  assert.doesNotMatch(jq, /startswith/);
  assert.match(jq, /select\(\.pull_request \| not\)/);
  assert.ok(envs.length > 0);
  for (const env of envs) {
    assert.equal(env.RESOLVE_TITLE, canonicalTitle(longTitle));
    assert.equal(env.RESOLVE_TITLE.length, 200, 'stesso troncamento del creator (--title slice 0..200)');
  }
});

test('titolo: una gemella con lo stesso prefisso non viene chiusa (FU-2026-09-12-029)', () => {
  // Simula la REST list: due issue aperte che condividono i primi 60 caratteri.
  const issues = [
    { number: 71, title: 'Articoli con control character C0: ripubblicazione incompleta' },
    { number: 72, title: 'Articoli con control character C0: ripubblicazione incompleta (en)' },
  ];
  let closed = new Set();
  const run = (args, env) => {
    if (args[0] === 'api') {
      const out = issues
        .filter((issue) => !closed.has(issue.number) && issue.title === env.RESOLVE_TITLE)
        .map((issue) => issue.number)
        .join('\n');
      return { status: 0, stdout: out, stderr: '' };
    }
    if (args[1] === 'close') closed.add(Number(args[2]));
    return { status: 0, stdout: '', stderr: '' };
  };
  const { code } = capture(() => resolveVerified(
    { title: 'Articoli con control character C0: ripubblicazione incompleta' },
    { run, sleep: noSleep },
  ));
  assert.equal(code, 0);
  assert.deepEqual([...closed], [71]);
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
  const { code } = capture(() => resolveVerified(
    { title: GHOST },
    {
      ...gh,
      sleep: noSleep,
      pinnedBy: (number) => (String(number) === '77' ? 'scripts/ci/qualcosa.mjs' : null),
    },
  ));
  assert.equal(code, 0);
  assert.equal(closeCalls(gh.calls).length, 0);
});

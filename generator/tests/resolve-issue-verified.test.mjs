/**
 * resolve-issue-verified.test.mjs — un close respinto deve EMERGERE.
 *
 * Il difetto (issue #1005, item 3 di #920) non era in un singolo file: era la
 * somma di tre strati best-effort che si coprono a vicenda. `gh issue close`
 * gira con `allowFailure: true` dentro `resolveGithubIssue`, il ramo CLI
 * `--resolve` esce 0 SEMPRE, e il `null` di ritorno significa insieme «non
 * c'era niente da chiudere» e «la chiusura e' stata respinta». Sotto
 * `continue-on-error: true` (o senza `set -e`) il risultato e' una run VERDE
 * con l'issue ancora aperta e un elenco ormai falso.
 *
 * Il wrapper non ripara nessuno dei tre strati: cambia la DOMANDA. Non «il
 * chiuditore ha detto ok?» ma «l'issue e' chiusa?». Questi test esercitano la
 * differenza — in particolare il caso che nessun controllo sull'exit code
 * saprebbe distinguere: comando fallito ma issue chiusa (verde legittimo), e
 * comando riuscito ma issue ancora aperta (rosso dovuto).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveVerified } from '../../scripts/ci/resolve-issue-verified.mjs';

/**
 * Un finto `gh`. `plan` mappa il sottocomando osservato su una risposta; le
 * chiamate restano registrate perche' il numero di TENTATIVI e' esso stesso
 * parte del contratto (uno e uno solo di ritentativo).
 */
function fakeGh(handler) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const res = handler(args, calls) || {};
    return { status: res.status ?? 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  };
  return { run, calls };
}

/** Cattura stdout/stderr dello script: l'annotazione `::error::` E' l'output. */
function capture(fn) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const code = fn();
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const closeCalls = (calls) => calls.filter((a) => a[0] === 'issue' && a[1] === 'close');

test('--number: chiusa al primo colpo, un solo tentativo e exit 0', () => {
  const gh = fakeGh((args) => (args[1] === 'view' ? { stdout: 'CLOSED' } : {}));
  const { code, err } = capture(() => resolveVerified({ number: '42' }, gh));
  assert.equal(code, 0);
  assert.equal(closeCalls(gh.calls).length, 1, 'una chiusura verificata non va ritentata');
  assert.doesNotMatch(err, /::error::/);
});

test('--number: e la POST-CONDIZIONE a decidere, non l exit code del close', () => {
  // Il caso che nessun `if [ $? -ne 0 ]` saprebbe trattare: `gh issue close`
  // esce non-zero (un 5xx sul commento, una race con un altro chiuditore) ma
  // l'issue RISULTA chiusa. Fallire qui vorrebbe dire annotare un guasto che
  // non c'e', e un'annotazione falsa e' il modo piu' rapido per far ignorare
  // quelle vere.
  const gh = fakeGh((args) => (args[1] === 'view' ? { stdout: 'CLOSED' } : { status: 1, stderr: 'HTTP 502' }));
  const { code, err } = capture(() => resolveVerified({ number: '42' }, gh));
  assert.equal(code, 0);
  assert.doesNotMatch(err, /::error::/);
});

test('--number: ancora aperta dopo il primo tentativo => ritenta UNA volta', () => {
  const gh = fakeGh((args, calls) => {
    if (args[1] !== 'view') return {};
    return { stdout: closeCalls(calls).length >= 2 ? 'CLOSED' : 'OPEN' };
  });
  const { code, out } = capture(() => resolveVerified({ number: '7' }, gh));
  assert.equal(code, 0);
  assert.equal(closeCalls(gh.calls).length, 2, 'il ritentativo deve esserci');
  assert.match(out, /ritento una volta/);
});

test('--number: aperta anche dopo il ritentativo => ::error:: e exit non-zero', () => {
  const gh = fakeGh((args) => (args[1] === 'view' ? { stdout: 'OPEN' } : { status: 1, stderr: 'HTTP 403' }));
  const { code, err } = capture(() => resolveVerified({ number: '7' }, gh));
  assert.equal(code, 1, 'un close respinto non puo lasciare la run verde');
  assert.match(err, /^::error::/m, 'senza annotazione il guasto non compare nella run');
  assert.match(err, /#7/);
  // E non ritenta all'infinito: il guasto persistente va reso visibile, non
  // trasformato in minuti di attesa e poi nello stesso rosso.
  assert.equal(closeCalls(gh.calls).length, 2);
});

test('--number: uno stato NON leggibile conta come aperta, mai come chiusa', () => {
  // Stessa asimmetria dei guard sulle query in recycle-stale-prs.yml (#981):
  // un risultato vuoto per un errore non e «gia chiusa».
  const gh = fakeGh((args) => (args[1] === 'view' ? { status: 1, stderr: 'rate limit' } : {}));
  const { code, err } = capture(() => resolveVerified({ number: '9' }, gh));
  assert.equal(code, 1);
  assert.match(err, /::error::/);
  assert.match(err, /stato non leggibile/);
});

test('--number: uno stato inatteso non viene scambiato per una chiusura', () => {
  const gh = fakeGh((args) => (args[1] === 'view' ? { stdout: 'MERGED' } : {}));
  const { code } = capture(() => resolveVerified({ number: '9' }, gh));
  assert.equal(code, 1);
});

test('--number: il commento di chiusura arriva a `gh issue close`', () => {
  const gh = fakeGh((args) => (args[1] === 'view' ? { stdout: 'CLOSED' } : {}));
  capture(() => resolveVerified({ number: '42', comment: 'coda drenata' }, gh));
  const args = closeCalls(gh.calls)[0];
  assert.deepEqual(args.slice(0, 5), ['issue', 'close', '42', '--comment', 'coda drenata']);
});

test('--title: nessuna issue aperta col prefisso => no-op verde', () => {
  // Il `null` ambiguo di resolveGithubIssue («niente da chiudere» oppure
  // «respinta») viene disambiguato dallo stato reale del repo, non indovinato.
  const gh = fakeGh(() => ({ stdout: '' }));
  const { code, err } = capture(() => resolveVerified(
    { title: 'Articoli fantasma: annunciati senza pagina sugli shard' },
    { ...gh, resolve: () => null },
  ));
  assert.equal(code, 0);
  assert.doesNotMatch(err, /::error::/);
});

test('--title: issue ancora aperta dopo il close => ritenta e poi annota', () => {
  const gh = fakeGh(() => ({ stdout: '331\n' }));
  let attempts = 0;
  const { code, err } = capture(() => resolveVerified(
    { title: 'Articoli fantasma: annunciati senza pagina sugli shard' },
    { ...gh, resolve: () => { attempts += 1; return null; } },
  ));
  assert.equal(code, 1);
  assert.equal(attempts, 2, 'un solo ritentativo, e deve esserci');
  assert.match(err, /::error::/);
  assert.match(err, /#331/, 'l annotazione deve dire QUALE issue e rimasta aperta');
});

test('--title: la query di verifica non leggibile non vale «chiusa»', () => {
  const gh = fakeGh(() => ({ status: 1, stderr: 'HTTP 502' }));
  const { code, err } = capture(() => resolveVerified(
    { title: 'Articoli fantasma: annunciati senza pagina sugli shard' },
    { ...gh, resolve: () => ({ number: 331 }) },
  ));
  assert.equal(code, 1);
  assert.match(err, /non leggibile/);
});

test('--title: la verifica legge la LISTA REST, non l indice di ricerca', () => {
  // L'indice e' in ritardo: interrogato subito dopo una chiusura riuscita
  // direbbe «ancora aperta», cioe' un rosso falso a ogni run. E `--paginate`,
  // perche' `gh issue list --limit N` tronca in silenzio — un troncamento qui
  // direbbe «nessuna residua» su un backlog che ne ha.
  const gh = fakeGh(() => ({ stdout: '' }));
  capture(() => resolveVerified({ title: 'Articoli fantasma: annunciati senza pagina sugli shard' }, { ...gh, resolve: () => null }));
  const api = gh.calls.find((a) => a[0] === 'api');
  assert.ok(api, 'la verifica deve passare da `gh api`');
  assert.ok(api.includes('--paginate'), 'senza `--paginate` la verifica puo essere troncata');
  assert.ok(api.some((a) => /state=open&per_page=100/.test(a)), 'la verifica legge le issue APERTE, 100 per pagina');
  assert.ok(!api.some((a) => /search\/issues/.test(a)), 'mai `search/issues`: l indice e in ritardo');
});

test('--title: la chiave di verifica viene da searchSafePrefix, non da una seconda copia', () => {
  // AGENTS.md #6: il prefisso con cui il wrapper verifica dev essere lo STESSO
  // che il chiuditore usa per cercare, o le due forme divergono e la verifica
  // finisce per guardare un'altra issue.
  const long = 'Articoli con control character C0: ripubblicazione incompleta e altro ancora';
  const gh = fakeGh(() => ({ stdout: '' }));
  capture(() => resolveVerified({ title: long }, { ...gh, resolve: () => null }));
  const api = gh.calls.find((a) => a[0] === 'api');
  const jq = api[api.indexOf('--jq') + 1];
  assert.match(jq, /startswith\(env\.RESOLVE_PREFIX\)/, 'il match e per prefisso, come il chiuditore');
  assert.match(jq, /select\(\.pull_request \| not\)/, 'una PR con lo stesso titolo non e l issue da chiudere');
});

/**
 * Il rovescio del wrapper: rendere visibile un close respinto non deve
 * trasformarlo in «chiudi con piu' insistenza». Il `trackingIssue` di una voce
 * `corpus-only-pending` del manifest e' aperto APPOSTA — e' l'unica traccia
 * del gemello che sul sito non c'e' ancora — e chiuderlo la cancellerebbe.
 * Guard generale in generator/tests/manifest-pinned-issues.test.mjs; qui si
 * inchioda il comportamento.
 */
test('una issue pinnata dal manifest non viene chiusa, e non e un guasto', () => {
  const gh = fakeGh(() => ({ stdout: 'OPEN' }));
  const { code, err } = capture(() => resolveVerified(
    { number: '55' },
    { ...gh, pinnedBy: () => 'scripts/ci/qualcosa.mjs' },
  ));
  assert.equal(code, 0, 'un pin non e un fallimento di chiusura: nessuna annotazione');
  assert.equal(closeCalls(gh.calls).length, 0, 'la issue pinnata non deve nemmeno essere tentata');
  assert.doesNotMatch(err, /::error::/);
});

test('--title: una pinnata non conta come residuo e non viene chiusa', () => {
  const gh = fakeGh(() => ({ stdout: '77\n' }));
  let delegated = 0;
  const { code } = capture(() => resolveVerified(
    { title: 'Articoli fantasma: annunciati senza pagina sugli shard' },
    { ...gh, pinnedBy: (n) => (String(n) === '77' ? 'scripts/ci/qualcosa.mjs' : null), resolve: () => { delegated += 1; } },
  ));
  assert.equal(code, 0, 'una pinnata rimasta aperta e lo stato voluto, non un close respinto');
  assert.equal(delegated, 0, 'la delega al chiuditore per prefisso chiuderebbe proprio quella');
  assert.equal(closeCalls(gh.calls).length, 0);
});

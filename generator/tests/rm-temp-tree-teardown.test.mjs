/**
 * Il teardown non deve SOSTITUIRE l'asserzione. Run with `node --test`.
 *
 * IL DIFETTO (follow-up di #790, issue #817). `rmTempTree` viene chiamata da un
 * `finally`, e rilanciava dall'ultimo tentativo. Un'eccezione lanciata da un
 * `finally` scarta quella in volo: se il corpo del test era gia' fallito con
 * un'asserzione, il report mostrava `ENOTEMPTY` al posto della diagnosi vera —
 * la stessa perdita di diagnosi che il retry esiste per evitare, con in piu'
 * ~1.8s di finestra in cui capitarci.
 *
 * Il contratto ora e': il teardown fallito non rilancia, ma non viene nemmeno
 * ingoiato — vale a fine processo con `exitCode = 1`. Questi test pinnano
 * entrambe le meta', perche' tenere solo la prima significherebbe aver
 * abbassato un gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmTempTree } from './rm-temp-tree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Fallimenti raccolti localmente: il registro globale renderebbe rosso QUESTO file. */
const seen = [];
const onFailure = (dir, err) => seen.push({ dir, code: err.code || null, message: err.message });

/** Un `rmSync` che fallisce sempre come farebbe il gc staccato di git. */
function alwaysBusy(code = 'ENOTEMPTY') {
  return () => {
    const err = new Error(`${code}: directory not empty, rmdir '/tmp/finto/.git'`);
    err.code = code;
    throw err;
  };
}

test('IL DIFETTO: il teardown fallito non sostituisce piu\' l\'asserzione del corpo', () => {
  let thrown = null;
  try {
    try {
      assert.fail('la diagnosi vera');
    } finally {
      rmTempTree('/tmp/finto-corpo-fallito', { attempts: 2, delayMs: 0, rmImpl: alwaysBusy(), onFailure });
    }
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'il corpo doveva fallire');
  assert.match(
    thrown.message,
    /la diagnosi vera/,
    'l\'errore di teardown ha scartato l\'asserzione in volo: il report mostra ENOTEMPTY al posto ' +
      'della diagnosi vera (#817)',
  );
  assert.ok(!/ENOTEMPTY/.test(thrown.message));
});

test('un errore NON transitorio non rilancia neanche lui (stesso masking)', () => {
  // Prima il ramo non-transitorio lanciava al primo colpo: e' il caso in cui
  // la finestra di masking e' del 100%, non dell'1.8s.
  assert.doesNotThrow(() =>
    rmTempTree('/tmp/finto-eacces', { attempts: 3, delayMs: 0, rmImpl: alwaysBusy('EACCES'), onFailure }),
  );
  const leaks = seen;
  assert.ok(
    leaks.some((l) => l.dir === '/tmp/finto-eacces' && l.code === 'EACCES'),
    'il fallimento e\' stato ingoiato invece che registrato: quello si sarebbe un gate abbassato',
  );
});

test('un teardown fallito rende comunque ROSSO il file di test (exit code)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-temp-tree-exit-'));
  const probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(
    probe,
    [
      `import { rmTempTree } from ${JSON.stringify(path.join(HERE, 'rm-temp-tree.mjs'))};`,
      'const boom = () => { const e = new Error("directory not empty"); e.code = "ENOTEMPTY"; throw e; };',
      'rmTempTree("/tmp/finto-exit", { attempts: 2, delayMs: 0, rmImpl: boom });',
      'console.log("CORPO VERDE");',
    ].join('\n'),
  );
  let status = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [probe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    status = e.status;
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(out, /CORPO VERDE/, 'il corpo doveva arrivare in fondo');
  assert.equal(
    status,
    1,
    'una directory che resta occupata deve restare un fallimento: non rilanciare non vuol dire ingoiare',
  );
  assert.match(out, /rm-temp-tree\] teardown NON riuscito su \/tmp\/finto-exit/);
});

test('il percorso felice resta invariato: rimuove davvero, e in silenzio', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-temp-tree-ok-'));
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'b', 'f.txt'), 'x');
  rmTempTree(dir, { onFailure });
  assert.equal(fs.existsSync(dir), false);
  assert.equal(
    seen.some((l) => l.dir === dir),
    false,
    'una rimozione riuscita non deve registrare un leak',
  );
});

test('ritenta dall\'alto finche\' l\'errore e\' transitorio, poi si arrende', () => {
  let calls = 0;
  rmTempTree('/tmp/finto-retry', {
    attempts: 4,
    delayMs: 0,
    onFailure,
    rmImpl: () => {
      calls += 1;
      if (calls < 3) {
        const e = new Error('busy');
        e.code = 'EBUSY';
        throw e;
      }
    },
  });
  assert.equal(calls, 3, 'il retry dall\'alto e\' cio\' che rilegge l\'albero: non deve sparire');
  assert.equal(
    seen.some((l) => l.dir === '/tmp/finto-retry'),
    false,
    'un retry andato a buon fine non e\' un leak',
  );
});

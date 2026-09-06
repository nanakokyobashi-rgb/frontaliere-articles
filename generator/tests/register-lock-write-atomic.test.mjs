// issue #963 — il marker del lock di registrazione scritto senza temp+rename.
//
// `beginRegisterLock()` committava il marker con una `writeFileSync` diretta
// sul path finale. Un SIGKILL fra l'apertura del file e la fine della scrittura
// (`generate-article.yml` uccide il processo con un kill esterno misurato 42/42
// SIGKILL, vedi create-article-write-atomic.test.mjs) lascia su disco un JSON
// TRONCATO. `readRegisterLock()` lo riporta come `{ id: null, unreadable: true }`
// e `resolveRegisterLock()` lancia su OGNI run successiva finche' qualcuno non
// cancella il file a mano: un arresto duro permanente, e per di piu' su un
// corpus intatto, perche' il kill puo' essere atterrato prima della prima delle
// 9 scritture, senza nessuno split da riparare. E' esattamente il brick che il
// design del lock dichiara di voler evitare.
//
// Il resto della catena era gia' atomico (`write()` di create-article.mjs,
// issue #561): il lock era l'unica scrittura rimasta sul path finale.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeOnly } from './lib/reachable-source.mjs';
import {
  beginRegisterLock,
  readRegisterLock,
  registerLockPath,
  REGISTER_LOCK_FILE,
} from '../scripts/lib/register-lock.mjs';

const ARTICLE_ID = 'permesso-g-frontalieri-2026';
const SECTION = 'frontaliere';

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'register-lock-atomic-'));
}

const lockDir = (root) => path.dirname(registerLockPath(root));

test('dopo beginRegisterLock() il marker su disco e\' JSON parsabile e completo', () => {
  const root = sandbox();
  beginRegisterLock(root, ARTICLE_ID, SECTION);

  const raw = fs.readFileSync(registerLockPath(root), 'utf-8');
  const parsed = JSON.parse(raw); // niente troncamento: JSON.parse non deve lanciare
  assert.equal(parsed.id, ARTICLE_ID);
  assert.equal(parsed.section, SECTION);

  const lock = readRegisterLock(root);
  assert.equal(lock.unreadable, undefined,
    'il lock appena scritto non deve mai presentarsi come illeggibile');
  assert.equal(lock.id, ARTICLE_ID);
  assert.equal(lock.section, SECTION);
});

test('beginRegisterLock() non lascia file temporanei residui accanto al marker', () => {
  const root = sandbox();
  beginRegisterLock(root, ARTICLE_ID, SECTION);

  // La directory del lock e' VERSIONATA (`generator/data/`, non `.tmp/`): un
  // temp residuo verrebbe raccolto dal `git add -A` di generate-article.yml e
  // committato per sempre.
  const leftovers = fs.readdirSync(lockDir(root))
    .filter((f) => f !== path.basename(REGISTER_LOCK_FILE));
  assert.deepEqual(leftovers, [],
    `il rename deve consumare il temp: residui trovati [${leftovers.join(', ')}]`);
});

test('un lock preesistente non viene mai osservato in stato parziale', () => {
  const root = sandbox();
  beginRegisterLock(root, ARTICLE_ID, SECTION);
  const before = fs.readFileSync(registerLockPath(root), 'utf-8');

  // Il secondo begin rifiuta di partire, e non tocca il marker del primo:
  // nessuna finestra in cui il file esiste ma e' a meta'.
  assert.throws(() => beginRegisterLock(root, 'altro-articolo', SECTION),
    /registration lock still present/);
  assert.equal(fs.readFileSync(registerLockPath(root), 'utf-8'), before);
  assert.equal(readRegisterLock(root).id, ARTICLE_ID);
});

// Drift guard sulla FORMA, come create-article-write-atomic.test.mjs: la prova
// comportamentale sopra passerebbe anche con una `writeFileSync` diretta (il
// troncamento richiede un kill a meta' syscall, non riproducibile in un test).
// Cio' che si puo' pinnare e' che il choke-point non torni a scrivere sul path
// finale.
const srcPath = path.join(import.meta.dirname, '..', 'scripts', 'lib', 'register-lock.mjs');
const src = fs.readFileSync(srcPath, 'utf-8');
const code = codeOnly(src);

test('register-lock.mjs commette il marker via writeJsonAtomic, non con writeFileSync', () => {
  assert.match(code, /writeJsonAtomic\(\s*lockPath/,
    'il marker deve essere scritto dall\'unico helper atomico (AGENTS.md #6: una sorgente sola)');
  assert.match(code, /from '\.\/atomic-write-json\.mjs'/,
    'writeJsonAtomic va importato da generator/scripts/lib/atomic-write-json.mjs');
  assert.doesNotMatch(code, /\bwriteFileSync\b/,
    'nessuna writeFileSync nel modulo: il path finale del lock si tocca solo via renameSync');
});

test('writeJsonAtomic commette davvero via temp+rename', () => {
  // Il guard sopra vale solo se l'helper che pinna e' quello atomico: se
  // `writeJsonAtomic` perdesse il rename, register-lock tornerebbe non atomico
  // restando verde qui.
  const helper = codeOnly(fs.readFileSync(
    path.join(import.meta.dirname, '..', 'scripts', 'lib', 'atomic-write-json.mjs'), 'utf-8'));
  assert.match(helper, /renameSync\(\s*tmp\s*,\s*filePath\s*\)/,
    'writeJsonAtomic deve committare con renameSync dal temp al target');
});

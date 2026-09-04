/**
 * register-lock.test.mjs — la transazione multi-file di `registerArticleFiles()`
 * (issue #562).
 *
 * Registrare un articolo tocca 9 file, ciascuno scritto indipendentemente.
 * Ogni singola `write()` e' atomica sul PROPRIO bersaglio (#561), ma nulla
 * impediva a un kill di atterrare FRA due delle nove chiamate: il corpus
 * restava con l'id registrato in alcuni file e non in altri, e **nessun
 * controllo lo rilevava al run successivo** — `getAllArticleIds()` e
 * `checkArticleIdExists()` guardano i soli file slug/registry, mai i 9 fra
 * loro.
 *
 * Quello che questo test osserva non e' il lock in se', ma le tre proprieta'
 * senza le quali il lock sarebbe inutile o dannoso:
 *
 *   1. il marker SOPRAVVIVE al crash a meta' sequenza — se fosse rimosso da un
 *      `finally` sparirebbe proprio nel caso per cui esiste;
 *   2. il run successivo si RIFIUTA di procedere quando il corpus e'
 *      davvero spezzato (alcuni bersagli registrati, altri no);
 *   3. il run successivo si auto-ripara quando il marker e' orfano ma il
 *      corpus e' coerente (tutti o nessuno). Senza questa terza proprieta' un
 *      solo run interrotto bloccherebbe PER SEMPRE ogni generazione
 *      successiva su un corpus che in realta' sta bene — il fallimento sarebbe
 *      peggiore del difetto.
 *
 * Il lock e' testato tramite `lib/register-lock.mjs` e non tramite
 * `create-article.mjs`: quest'ultimo importa `jsdom` staticamente, quindi
 * `node --test` non puo' caricarlo senza `node_modules` (assente per default,
 * vedi AGENTS.md). E' esattamente il motivo per cui il meccanismo vive in un
 * modulo proprio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REGISTER_LOCK_FILE,
  registerLockPath,
  beginRegisterLock,
  endRegisterLock,
  readRegisterLock,
  registrationTargetStatus,
  resolveRegisterLock,
} from '../scripts/lib/register-lock.mjs';

const ARTICLE_ID = 'permesso-g-frontalieri-2026';

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'register-lock-'));
}

/**
 * Gli stessi bersagli che `registerLockTargets()` costruisce da `SECTION` in
 * create-article.mjs: le 9 chiamate `modifyXxx()` scrivono 11 file, perche'
 * `modifyI18nTs`/`modifyLocaleFile` ne toccano due per locale (meta + body) e
 * `modifySitemap`/`modifySitemapNews` sono no-op in questo repo.
 */
function makeTargets(root) {
  return (id) => {
    const rel = [
      ['data/routerBlogData.ts', id],
      ['data/blog-articles-data.ts', id],
      ['services/seo/seo-blog-5.ts', id],
    ];
    for (const locale of ['it', 'en', 'de', 'fr']) {
      rel.push([`services/locales/blog-meta-${locale}.ts`, `blog.article.${id}.`]);
      rel.push([`services/locales/blog-body/${locale}/${id}.ts`, null]);
    }
    return rel.map(([r, needle]) => ({ label: r, absPath: path.join(root, r), needle }));
  };
}

test('il marker sopravvive a un crash a meta\' della sequenza di 9 scritture', () => {
  const root = sandbox();
  const build = makeTargets(root);
  const steps = build(ARTICLE_ID);
  assert.equal(steps.length, 11, 'i bersagli coprono slug + registry + seo + 4 meta + 4 body');

  // Il kill atterra a meta': i primi passi hanno scritto, gli altri no.
  const failAt = 4;
  assert.throws(() => {
    beginRegisterLock(root, ARTICLE_ID);
    steps.forEach((t, i) => {
      if (i === failAt) throw new Error('kill simulato');
      fs.mkdirSync(path.dirname(t.absPath), { recursive: true });
      fs.writeFileSync(t.absPath, t.needle == null ? 'body\n' : `entry ${t.needle}\n`, 'utf-8');
    });
    endRegisterLock(root);
  }, /kill simulato/);

  // La proprieta' 1: il marker e' ANCORA sul disco. Se `endRegisterLock()`
  // fosse chiamato da un `finally`, qui non ci sarebbe piu' niente.
  assert.ok(fs.existsSync(registerLockPath(root)), `${REGISTER_LOCK_FILE} deve sopravvivere al crash`);
  assert.equal(readRegisterLock(root).id, ARTICLE_ID);

  // E il corpus e' effettivamente spezzato: alcuni registrati, altri no.
  const { present, absent } = registrationTargetStatus(steps);
  assert.equal(present.length, failAt);
  assert.equal(absent.length, steps.length - failAt);
});

test('il run successivo RIFIUTA di procedere su un corpus spezzato', () => {
  const root = sandbox();
  const build = makeTargets(root);
  const steps = build(ARTICLE_ID);
  assert.throws(() => {
    beginRegisterLock(root, ARTICLE_ID);
    steps.forEach((t, i) => {
      if (i === 4) throw new Error('kill simulato');
      fs.mkdirSync(path.dirname(t.absPath), { recursive: true });
      fs.writeFileSync(t.absPath, t.needle == null ? 'body\n' : `entry ${t.needle}\n`, 'utf-8');
    });
  }, /kill simulato/);

  // Il run seguente, che parte da `main()`: si ferma con un errore che nomina
  // sia i file registrati sia quelli mancanti — la diagnosi che prima non
  // esisteva affatto.
  assert.throws(
    () => resolveRegisterLock(root, build),
    (err) => /SPLIT/.test(err.message)
      && err.message.includes(ARTICLE_ID)
      && err.message.includes('data/routerBlogData.ts')
      && err.message.includes(REGISTER_LOCK_FILE),
    'l\'errore deve nominare l\'id, i bersagli e il file di lock da rimuovere',
  );

  // E si rifiuta di nuovo finche' il marker non e' stato ripulito a mano:
  // il rifiuto e' persistente, non un allarme che si spegne da solo.
  assert.throws(() => resolveRegisterLock(root, build), /SPLIT/);
  fs.rmSync(registerLockPath(root));
  assert.deepEqual(resolveRegisterLock(root, build), { state: 'clean' });
});

test('una registrazione completata non lascia marker e non blocca il run dopo', () => {
  const root = sandbox();
  const build = makeTargets(root);
  runRegistration(root, ARTICLE_ID, build);
  assert.equal(fs.existsSync(registerLockPath(root)), false);
  assert.deepEqual(resolveRegisterLock(root, build), { state: 'clean' });
});

/**
 * La sequenza di registrazione ridotta alla sola forma rilevante qui: passi che
 * scrivono l'id su bersagli distinti, con il lock aperto prima del primo e
 * chiuso dopo l'ultimo.
 */
function runRegistration(root, id, build, { failAt = -1 } = {}) {
  const steps = build(id);
  beginRegisterLock(root, id);
  steps.forEach((t, i) => {
    if (i === failAt) throw new Error('kill simulato');
    fs.mkdirSync(path.dirname(t.absPath), { recursive: true });
    fs.writeFileSync(t.absPath, t.needle == null ? 'body\n' : `entry ${t.needle}\n`, 'utf-8');
  });
  endRegisterLock(root);
}

test('marker orfano ma corpus coerente: si auto-ripara invece di bloccare per sempre', () => {
  const build = (root) => makeTargets(root);

  // Caso A — il kill e' atterrato DOPO l'ultima scrittura ma prima di
  // `endRegisterLock()`: la transazione ha committato, non c'e' niente da
  // riparare.
  const rootAll = sandbox();
  const buildAll = build(rootAll);
  runRegistration(rootAll, ARTICLE_ID, buildAll);
  beginRegisterLock(rootAll, ARTICLE_ID); // marker rimasto indietro
  assert.deepEqual(resolveRegisterLock(rootAll, buildAll), { state: 'committed', id: ARTICLE_ID });
  assert.equal(fs.existsSync(registerLockPath(rootAll)), false, 'il lock benigno viene rimosso');

  // Caso B — il kill e' atterrato PRIMA della prima scrittura: nessun file
  // cita l'id, il corpus e' intatto.
  const rootNone = sandbox();
  const buildNone = build(rootNone);
  beginRegisterLock(rootNone, ARTICLE_ID);
  assert.deepEqual(resolveRegisterLock(rootNone, buildNone), { state: 'nothing-written', id: ARTICLE_ID });
  assert.equal(fs.existsSync(registerLockPath(rootNone)), false);
});

test('un lock illeggibile e\' comunque un lock, mai letto come "pulito"', () => {
  const root = sandbox();
  const lockPath = registerLockPath(root);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '{ tronco', 'utf-8');
  assert.equal(readRegisterLock(root).id, null);
  // Senza id non si possono confrontare i 9 file: l'unica risposta sicura e'
  // fermarsi, non tirare a indovinare che vada tutto bene.
  assert.throws(() => resolveRegisterLock(root, makeTargets(root)), /unreadable/);
});

test('beginRegisterLock non sovrascrive un lock esistente', () => {
  const root = sandbox();
  beginRegisterLock(root, ARTICLE_ID);
  assert.throws(() => beginRegisterLock(root, 'altro-articolo'), /registration lock still present/);
  // Il lock originale e' intatto: sovrascriverlo perderebbe l'id da
  // confrontare coi 9 file.
  assert.equal(readRegisterLock(root).id, ARTICLE_ID);
});

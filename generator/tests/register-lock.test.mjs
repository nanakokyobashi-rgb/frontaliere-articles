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
  LEGACY_REGISTER_LOCK_FILE,
  registerLockFile,
  registerLockPath,
  beginRegisterLock,
  endRegisterLock,
  readRegisterLock,
  readLegacyRegisterLock,
  registrationTargetStatus,
  resolveRegisterLock,
} from '../scripts/lib/register-lock.mjs';

const ARTICLE_ID = 'permesso-g-frontalieri-2026';
const SECTION = 'frontaliere';
// L'identita' di run che `beginRegisterLock()` timbra nel marker (issue #965):
// e' `GITHUB_RUN_ID` sotto Actions e `null` in locale, e il banco deve pinnare
// la propagazione, non il valore.
const CURRENT_RUN_ID = process.env.GITHUB_RUN_ID || null;

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'register-lock-'));
}

/**
 * Gli stessi bersagli che `registerLockTargets()` costruisce dalla config di
 * sezione in create-article.mjs: le 9 chiamate `modifyXxx()` scrivono 11 file,
 * perche' `modifyI18nTs`/`modifyLocaleFile` ne toccano due per locale (meta +
 * body) e `modifySitemap`/`modifySitemapNews` sono no-op in questo repo.
 *
 * I path sono scopati alla SEZIONE, come nel codice reale: le due sezioni non
 * condividono nemmeno un bersaglio, ed e' questo che rende fatale confrontare
 * un id contro i file dell'altra sezione.
 */
const SECTION_FILES = {
  frontaliere: { slug: 'data/routerBlogData.ts', registry: 'data/blog-articles-data.ts', seo: 'services/seo/seo-blog-5.ts', metaPrefix: 'blog-meta', bodyDir: 'blog-body' },
  svizzera: { slug: 'data/routerSwissData.ts', registry: 'data/swiss-articles-data.ts', seo: 'services/seo/seo-blog-ch.ts', metaPrefix: 'blog-meta-ch', bodyDir: 'blog-body-ch' },
};

function makeTargets(root) {
  return (id, section = SECTION) => {
    const cfg = SECTION_FILES[section];
    if (!cfg) throw new Error(`sezione sconosciuta nel lock: "${section}"`);
    const rel = [
      [cfg.slug, id],
      [cfg.registry, id],
      [cfg.seo, id],
    ];
    for (const locale of ['it', 'en', 'de', 'fr']) {
      rel.push([`services/locales/${cfg.metaPrefix}-${locale}.ts`, `blog.article.${id}.`]);
      rel.push([`services/locales/${cfg.bodyDir}/${locale}/${id}.ts`, null]);
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
    beginRegisterLock(root, ARTICLE_ID, SECTION);
    steps.forEach((t, i) => {
      if (i === failAt) throw new Error('kill simulato');
      fs.mkdirSync(path.dirname(t.absPath), { recursive: true });
      fs.writeFileSync(t.absPath, t.needle == null ? 'body\n' : `entry ${t.needle}\n`, 'utf-8');
    });
    endRegisterLock(root, SECTION);
  }, /kill simulato/);

  // La proprieta' 1: il marker e' ANCORA sul disco. Se `endRegisterLock()`
  // fosse chiamato da un `finally`, qui non ci sarebbe piu' niente.
  assert.ok(fs.existsSync(registerLockPath(root, SECTION)), `${registerLockFile(SECTION)} deve sopravvivere al crash`);
  assert.equal(readRegisterLock(root, SECTION).id, ARTICLE_ID);

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
    beginRegisterLock(root, ARTICLE_ID, SECTION);
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
    () => resolveRegisterLock(root, build, SECTION),
    (err) => /SPLIT/.test(err.message)
      && err.message.includes(ARTICLE_ID)
      && err.message.includes('data/routerBlogData.ts')
      && err.message.includes(registerLockFile(SECTION)),
    'l\'errore deve nominare l\'id, i bersagli e il file di lock da rimuovere',
  );

  // E si rifiuta di nuovo finche' il marker non e' stato ripulito a mano:
  // il rifiuto e' persistente, non un allarme che si spegne da solo.
  assert.throws(() => resolveRegisterLock(root, build, SECTION), /SPLIT/);
  fs.rmSync(registerLockPath(root, SECTION));
  assert.deepEqual(resolveRegisterLock(root, build, SECTION), { state: 'clean', resolved: [], deferred: [] });
});

test('una registrazione completata non lascia marker e non blocca il run dopo', () => {
  const root = sandbox();
  const build = makeTargets(root);
  runRegistration(root, ARTICLE_ID, build);
  assert.equal(fs.existsSync(registerLockPath(root, SECTION)), false);
  assert.deepEqual(resolveRegisterLock(root, build, SECTION), { state: 'clean', resolved: [], deferred: [] });
});

/**
 * La sequenza di registrazione ridotta alla sola forma rilevante qui: passi che
 * scrivono l'id su bersagli distinti, con il lock aperto prima del primo e
 * chiuso dopo l'ultimo.
 */
function runRegistration(root, id, build, { failAt = -1, section = SECTION } = {}) {
  const steps = build(id, section);
  beginRegisterLock(root, id, section);
  steps.forEach((t, i) => {
    if (i === failAt) throw new Error('kill simulato');
    fs.mkdirSync(path.dirname(t.absPath), { recursive: true });
    fs.writeFileSync(t.absPath, t.needle == null ? 'body\n' : `entry ${t.needle}\n`, 'utf-8');
  });
  endRegisterLock(root, section);
}

test('marker orfano ma corpus coerente: si auto-ripara invece di bloccare per sempre', () => {
  const build = (root) => makeTargets(root);

  // Caso A — il kill e' atterrato DOPO l'ultima scrittura ma prima di
  // `endRegisterLock()`: la transazione ha committato, non c'e' niente da
  // riparare.
  const rootAll = sandbox();
  const buildAll = build(rootAll);
  runRegistration(rootAll, ARTICLE_ID, buildAll);
  beginRegisterLock(rootAll, ARTICLE_ID, SECTION); // marker rimasto indietro
  assert.deepEqual(resolveRegisterLock(rootAll, buildAll, SECTION), {
    state: 'committed',
    id: ARTICLE_ID,
    section: SECTION,
    resolved: [{ file: registerLockFile(SECTION), state: 'committed', id: ARTICLE_ID, section: SECTION, runId: CURRENT_RUN_ID }],
    deferred: [],
  });
  assert.equal(fs.existsSync(registerLockPath(rootAll, SECTION)), false, 'il lock benigno viene rimosso');

  // Caso B — il kill e' atterrato PRIMA della prima scrittura: nessun file
  // cita l'id, il corpus e' intatto.
  const rootNone = sandbox();
  const buildNone = build(rootNone);
  beginRegisterLock(rootNone, ARTICLE_ID, SECTION);
  assert.deepEqual(resolveRegisterLock(rootNone, buildNone, SECTION), {
    state: 'nothing-written',
    id: ARTICLE_ID,
    section: SECTION,
    resolved: [{ file: registerLockFile(SECTION), state: 'nothing-written', id: ARTICLE_ID, section: SECTION, runId: CURRENT_RUN_ID }],
    deferred: [],
  });
  assert.equal(fs.existsSync(registerLockPath(rootNone, SECTION)), false);
});

test('un lock illeggibile e\' comunque un lock, mai letto come "pulito"', () => {
  const root = sandbox();
  const lockPath = registerLockPath(root, SECTION);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '{ tronco', 'utf-8');
  assert.equal(readRegisterLock(root, SECTION).id, null);
  // Senza id non si possono confrontare i 9 file: l'unica risposta sicura e'
  // fermarsi, non tirare a indovinare che vada tutto bene.
  assert.throws(() => resolveRegisterLock(root, makeTargets(root), SECTION), /unreadable/);
});

test('beginRegisterLock non sovrascrive un lock esistente', () => {
  const root = sandbox();
  beginRegisterLock(root, ARTICLE_ID, SECTION);
  assert.throws(() => beginRegisterLock(root, 'altro-articolo', SECTION), /registration lock still present/);
  // Il lock originale e' intatto: sovrascriverlo perderebbe l'id da
  // confrontare coi 9 file.
  assert.equal(readRegisterLock(root, SECTION).id, ARTICLE_ID);
});

test('il lock resta risolto sulla SEZIONE registrata, non su quella del run successivo', () => {
  // `generate-article.yml` gira le due sezioni nello STESSO checkout (la
  // catena di retry le alterna). Prima che il lock portasse con se' la propria
  // sezione, i bersagli venivano costruiti da quella corrente: un id svizzero
  // cercato nei file frontaliere non c'e' in nessuno, il caso veniva
  // classificato `nothing-written` e il marker cancellato — proprio sopra il
  // corpus spezzato che doveva denunciare.
  //
  // Da #965 il marker sta su un path proprio della sezione, quindi la
  // mis-comparazione e' impedita per COSTRUZIONE e non piu' solo dal campo
  // registrato; il campo resta perche' e' cio' che permette di risolvere anche
  // il marker legacy (test sotto) e perche' rende il file auto-descrittivo.
  const root = sandbox();
  const build = makeTargets(root);
  const swissId = 'imposta-preventiva-ch-2026';

  assert.throws(() => {
    runRegistration(root, swissId, build, { failAt: 4, section: 'svizzera' });
  }, /kill simulato/);

  assert.equal(readRegisterLock(root, 'svizzera').section, 'svizzera');
  assert.equal(readRegisterLock(root, SECTION), null, 'il marker svizzero non compare come marker frontaliere');

  // Il run svizzero successivo — quello che possiede il marker — si ferma, e
  // l'errore nomina l'id, i bersagli svizzeri e il file da rimuovere.
  assert.throws(
    () => resolveRegisterLock(root, build, 'svizzera'),
    (err) => /SPLIT/.test(err.message)
      && err.message.includes(swissId)
      && err.message.includes('svizzera')
      && err.message.includes('data/routerSwissData.ts')
      && err.message.includes(registerLockFile('svizzera')),
    'lo split svizzero deve fermare il run svizzero',
  );
  assert.ok(fs.existsSync(registerLockPath(root, 'svizzera')), 'il marker non viene cancellato');
});

/**
 * I QUATTRO PRODUTTORI SECONDARI davanti al marker di un'altra sezione
 * (issue #965).
 *
 * `generate-daily-brief-article.mjs`, `generate-events-digest-article.mjs`,
 * `generate-border-wait-ranking-article.mjs` e `publish-journalist-article.mjs`
 * importano `registerArticleFiles()` direttamente: non hanno il `main()` di
 * create-article.mjs, girano tutti e quattro come `frontaliere` (nessuno passa
 * `--section` ne' `ARTICLE_SECTION`), e nei rispettivi workflow il loro entry
 * point e' uno step semplice senza `continue-on-error` — un throw fa fallire il
 * job e apre una workflow-failure issue.
 *
 * Col marker unico per repo, uno split SVIZZERO lasciato da create-article.mjs
 * fermava quindi tutti e quattro: bollettino quotidiano, digest weekend,
 * classifica dogane e coda giornalista, su un corpus che nessuno di loro aveva
 * rotto e che nessuno di loro poteva riparare (gli 11 bersagli delle due
 * sezioni sono disgiunti). Il criterio pinnato qui e' quello: **si risponde del
 * proprio marker, mai di quello altrui**, e il marker altrui resta intatto
 * perche' la sezione che lo possiede ci inciampi.
 */
const SECONDARY_PRODUCERS = [
  'generate-daily-brief-article.mjs',
  'generate-events-digest-article.mjs',
  'generate-border-wait-ranking-article.mjs',
  'publish-journalist-article.mjs',
];

for (const producer of SECONDARY_PRODUCERS) {
  test(`${producer} prosegue su uno split dell'altra sezione, e non lo cancella`, () => {
    const root = sandbox();
    const build = makeTargets(root);
    const swissId = 'imposta-preventiva-ch-2026';
    assert.throws(() => runRegistration(root, swissId, build, { failAt: 4, section: 'svizzera' }), /kill simulato/);

    // Il produttore secondario entra da `registerArticleFiles()`, cioe'
    // risolve e apre il lock della PROPRIA sezione: non deve morire qui.
    const outcome = resolveRegisterLock(root, build, SECTION);
    assert.equal(outcome.state, 'clean');
    assert.deepEqual(outcome.deferred, [], 'un marker gia\' scopato per sezione non e\' nemmeno da deferire');
    assert.doesNotThrow(() => beginRegisterLock(root, `brief-${producer}`, SECTION));

    // E il marker svizzero e' ancora li', identico: e' l'unica prova dello
    // split, e cancellarla sarebbe il danno peggiore del blocco.
    assert.equal(readRegisterLock(root, 'svizzera').id, swissId);
    assert.throws(() => resolveRegisterLock(root, build, 'svizzera'), /SPLIT/);
  });

  test(`${producer} si ferma invece su uno split della PROPRIA sezione`, () => {
    // La meta' che non deve cedere: il rifiuto resta pieno quando lo split e'
    // nei file che questo produttore sta per riscrivere. Senza questo caso,
    // «scopare il lock per sezione» sarebbe indistinguibile da «disattivarlo».
    const root = sandbox();
    const build = makeTargets(root);
    assert.throws(() => runRegistration(root, ARTICLE_ID, build, { failAt: 4 }), /kill simulato/);
    assert.throws(
      () => resolveRegisterLock(root, build, SECTION),
      (err) => /SPLIT/.test(err.message) && err.message.includes(ARTICLE_ID),
      `${producer} deve rifiutarsi di registrare su un corpus frontaliere spezzato`,
    );
  });
}

test('il marker LEGACY (pre-#965, unico per repo) resta risolvibile dalla sezione che lo ha scritto', () => {
  // Un marker scritto prima di questo cambio puo' benissimo essere gia' sul
  // repo — e' tracciato, ed e' esattamente il caso per cui il lock esiste.
  // Va quindi ancora letto, risolto dalla sezione REGISTRATA dentro di lui, e
  // deferito (mai cancellato) da un run dell'altra sezione.
  const root = sandbox();
  const build = makeTargets(root);
  const swissId = 'imposta-preventiva-ch-2026';
  const legacy = path.join(root, LEGACY_REGISTER_LOCK_FILE);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ id: swissId, section: 'svizzera', pid: 4242 }), 'utf-8');

  // Un run frontaliere (i quattro produttori secondari, fra gli altri) lo
  // lascia stare e lo DICHIARA: il silenzio si leggerebbe come «nessun marker».
  const outcome = resolveRegisterLock(root, build, SECTION);
  assert.equal(outcome.state, 'clean');
  assert.deepEqual(outcome.deferred.map((d) => [d.file, d.section, d.id]), [[LEGACY_REGISTER_LOCK_FILE, 'svizzera', swissId]]);
  assert.match(outcome.deferred[0].origin, /run non identificato/, 'un marker pre-#965 non ha identita\' di run, e lo si dice');
  assert.ok(fs.existsSync(legacy), 'il marker legacy altrui non viene rimosso');

  // Il run svizzero, che lo possiede, lo risolve: nessuno dei bersagli cita
  // l'id, quindi «nessuna scrittura avvenuta» e marker ripulito.
  assert.equal(readLegacyRegisterLock(root).section, 'svizzera');
  const owner = resolveRegisterLock(root, build, 'svizzera');
  assert.equal(owner.state, 'nothing-written');
  assert.deepEqual(owner.resolved.map((r) => r.file), [LEGACY_REGISTER_LOCK_FILE]);
  assert.equal(fs.existsSync(legacy), false);
});

test('il marker porta l\'identita\' del RUN, non solo il pid', () => {
  // Il pid non sopravvive al processo: su un run successivo — o in un checkout
  // fresco, che e' l'unico modo in cui un marker committato viene rivisto —
  // nomina un processo scorrelato o nessuno. `GITHUB_RUN_ID` sopravvive e
  // punta ai log che spiegano cosa ha interrotto la registrazione.
  const root = sandbox();
  const prev = { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
  process.env.GITHUB_RUN_ID = '1234567890';
  process.env.GITHUB_RUN_ATTEMPT = '2';
  try {
    beginRegisterLock(root, ARTICLE_ID, SECTION);
  } finally {
    if (prev.id === undefined) delete process.env.GITHUB_RUN_ID; else process.env.GITHUB_RUN_ID = prev.id;
    if (prev.attempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT; else process.env.GITHUB_RUN_ATTEMPT = prev.attempt;
  }
  const lock = readRegisterLock(root, SECTION);
  assert.equal(lock.runId, '1234567890');
  assert.equal(lock.runAttempt, '2');
  assert.equal(typeof lock.pid, 'number', 'il pid resta, ma non e\' piu\' l\'unica identita\'');

  // E l'identita' esce nell'errore che un umano legge mentre ripara a mano:
  // e' li' che serve, non nel file.
  const build = makeTargets(root);
  fs.mkdirSync(path.dirname(build(ARTICLE_ID)[0].absPath), { recursive: true });
  fs.writeFileSync(build(ARTICLE_ID)[0].absPath, `entry ${ARTICLE_ID}\n`, 'utf-8');
  assert.throws(
    () => resolveRegisterLock(root, build, SECTION),
    (err) => /SPLIT/.test(err.message) && err.message.includes('run 1234567890') && err.message.includes('attempt 2'),
    'l\'errore deve nominare il run che ha lasciato il marker',
  );
});

test('la sezione non puo\' uscire da generator/data/ attraverso il nome del marker', () => {
  // La sezione finisce in un NOME DI FILE: un valore con un separatore
  // scriverebbe il marker fuori da `generator/data/`, dove il `git add -A` di
  // `generate-article.yml` non lo raccoglierebbe nel commit che porta il danno
  // — cioe' esattamente la proprieta' per cui il marker non sta sotto `.tmp/`.
  for (const bad of ['../fuori', 'a/b', '', 'Frontaliere', '.', null]) {
    assert.throws(() => registerLockFile(bad), /requires the article section/);
    assert.throws(() => beginRegisterLock(sandbox(), ARTICLE_ID, bad), /requires the article section/);
  }
});

test('un lock senza sezione non viene risolto a indovinare', () => {
  // Un marker con id ma senza sezione (JSON scritto a mano, o troncato dopo
  // il campo id) non permette di sapere QUALI file confrontare: cadere sulla
  // sezione corrente e' esattamente la mis-comparazione che il campo esiste
  // per impedire.
  const root = sandbox();
  const lockPath = registerLockPath(root, SECTION);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ id: ARTICLE_ID }), 'utf-8');
  assert.equal(readRegisterLock(root, SECTION).section, null);
  assert.throws(() => resolveRegisterLock(root, makeTargets(root), SECTION), /missing its section/);
  // E aprire un lock senza sezione e' impedito alla fonte.
  fs.rmSync(lockPath);
  assert.throws(() => beginRegisterLock(root, ARTICLE_ID), /requires the article section/);
});

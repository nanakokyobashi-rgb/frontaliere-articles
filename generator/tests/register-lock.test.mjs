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
const SECTION = 'frontaliere';

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'register-lock-'));
}

/**
 * Gli stessi bersagli che `registerLockTargets()` costruisce dalla config di
 * sezione in create-article.mjs: le 9 chiamate `modifyXxx()` scrivono 12 file
 * per frontaliere (11 per svizzera), perche' `modifyI18nTs`/`modifyLocaleFile`
 * ne toccano due per locale (meta + body), `modifyRouterTs` ne tocca due per
 * la sola frontaliere (union + mappa slug) e `modifySitemap`/`modifySitemapNews`
 * sono no-op in questo repo.
 *
 * I path sono scopati alla SEZIONE, come nel codice reale: le due sezioni non
 * condividono nemmeno un bersaglio, ed e' questo che rende fatale confrontare
 * un id contro i file dell'altra sezione.
 */
const SECTION_FILES = {
  frontaliere: { union: 'packages/articles/content/blogArticleIds.ts', slug: 'data/routerBlogData.ts', registry: 'data/blog-articles-data.ts', seo: 'services/seo/seo-blog-5.ts', metaPrefix: 'blog-meta', bodyDir: 'blog-body' },
  svizzera: { union: null, slug: 'data/routerSwissData.ts', registry: 'data/swiss-articles-data.ts', seo: 'services/seo/seo-blog-ch.ts', metaPrefix: 'blog-meta-ch', bodyDir: 'blog-body-ch' },
};

function makeTargets(root) {
  return (id, section = SECTION) => {
    const cfg = SECTION_FILES[section];
    if (!cfg) throw new Error(`sezione sconosciuta nel lock: "${section}"`);
    const rel = [
      // La union e' la PRIMA scrittura della sequenza, e il needle e' la forma
      // che ci finisce davvero: l'id fra apici singoli.
      ...(cfg.union ? [[cfg.union, `'${id}'`]] : []),
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
  assert.equal(steps.length, 12, 'i bersagli coprono union + slug + registry + seo + 4 meta + 4 body');

  // Il kill atterra a meta': i primi passi hanno scritto, gli altri no.
  const failAt = 4;
  assert.throws(() => {
    beginRegisterLock(root, ARTICLE_ID, SECTION);
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
function runRegistration(root, id, build, { failAt = -1, section = SECTION } = {}) {
  const steps = build(id, section);
  beginRegisterLock(root, id, section);
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
  beginRegisterLock(rootAll, ARTICLE_ID, SECTION); // marker rimasto indietro
  assert.deepEqual(resolveRegisterLock(rootAll, buildAll), { state: 'committed', id: ARTICLE_ID, section: SECTION });
  assert.equal(fs.existsSync(registerLockPath(rootAll)), false, 'il lock benigno viene rimosso');

  // Caso B — il kill e' atterrato PRIMA della prima scrittura: nessun file
  // cita l'id, il corpus e' intatto.
  const rootNone = sandbox();
  const buildNone = build(rootNone);
  beginRegisterLock(rootNone, ARTICLE_ID, SECTION);
  assert.deepEqual(resolveRegisterLock(rootNone, buildNone), { state: 'nothing-written', id: ARTICLE_ID, section: SECTION });
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
  beginRegisterLock(root, ARTICLE_ID, SECTION);
  assert.throws(() => beginRegisterLock(root, 'altro-articolo', SECTION), /registration lock still present/);
  // Il lock originale e' intatto: sovrascriverlo perderebbe l'id da
  // confrontare coi 9 file.
  assert.equal(readRegisterLock(root).id, ARTICLE_ID);
});

test('il lock resta risolto sulla SEZIONE registrata, non su quella del run successivo', () => {
  // `generate-article.yml` gira le due sezioni nello STESSO checkout (la
  // catena di retry le alterna), quindi il processo che trova il marker sta
  // di norma girando come l'ALTRA sezione. Prima che il lock portasse con se'
  // la propria sezione, i bersagli venivano costruiti da quella corrente: un
  // id svizzero cercato nei file frontaliere non c'e' in nessuno, il caso
  // veniva classificato `nothing-written` e il marker cancellato — proprio
  // sopra il corpus spezzato che doveva denunciare.
  const root = sandbox();
  const build = makeTargets(root);
  const swissId = 'imposta-preventiva-ch-2026';

  assert.throws(() => {
    runRegistration(root, swissId, build, { failAt: 4, section: 'svizzera' });
  }, /kill simulato/);

  // Il run successivo gira `--section=frontaliere`: i suoi bersagli non
  // citano nemmeno un id svizzero. Il default di `build` e' infatti
  // frontaliere, ma `resolveRegisterLock` deve ignorarlo e passare la sezione
  // letta dal lock.
  assert.equal(readRegisterLock(root).section, 'svizzera');
  assert.throws(
    () => resolveRegisterLock(root, build),
    (err) => /SPLIT/.test(err.message)
      && err.message.includes(swissId)
      && err.message.includes('svizzera')
      && err.message.includes('data/routerSwissData.ts'),
    'lo split svizzero deve essere rilevato anche da un run frontaliere',
  );
  assert.ok(fs.existsSync(registerLockPath(root)), 'il marker non viene cancellato dal run dell\'altra sezione');
});

test('un lock senza sezione non viene risolto a indovinare', () => {
  // Un marker con id ma senza sezione (JSON scritto a mano, o troncato dopo
  // il campo id) non permette di sapere QUALI file confrontare: cadere sulla
  // sezione corrente e' esattamente la mis-comparazione che il campo esiste
  // per impedire.
  const root = sandbox();
  const lockPath = registerLockPath(root);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ id: ARTICLE_ID }), 'utf-8');
  assert.equal(readRegisterLock(root).section, null);
  assert.throws(() => resolveRegisterLock(root, makeTargets(root)), /missing its section/);
  // E aprire un lock senza sezione e' impedito alla fonte.
  fs.rmSync(lockPath);
  assert.throws(() => beginRegisterLock(root, ARTICLE_ID), /requires the article section/);
});

// ── L'osservatore sulla lista reale (issue #960) ─────────────────────────
//
// I bersagli qui sopra sono uno SPECCHIO scritto a mano di
// `registerLockTargets()`: se la funzione vera ne perde uno, lo specchio resta
// verde e la finestra cieca si allarga in silenzio. E' esattamente com'e'
// sfuggita per mesi la union `BlogArticleId`, che `modifyRouterUnion()` scrive
// per PRIMA e la cui path non e' in `ARTICLE_SECTION_CONFIGS` ma cablata dentro
// quella funzione: un kill fra la union e la mappa slug lasciava l'id nel solo
// file non confrontato, `registrationTargetStatus()` tornava `present: []` e
// `resolveRegisterLock()` cancellava il marker come `nothing-written` sopra una
// union con un membro orfano.
//
// La funzione vera si esegue estraendone il sorgente e istanziandola con
// `new Function` (stessa tecnica di article-slug-i18n.test.mjs): importare
// create-article.mjs non e' possibile, importa `jsdom` staticamente e
// `node --test` gira senza node_modules.
const CREATE_ARTICLE_SRC = fs.readFileSync(
  new URL('../scripts/create-article.mjs', import.meta.url),
  'utf-8',
);

/** Il valore reale di `updateRouterUnion` per sezione, letto dalla config. */
function updateRouterUnionFlags() {
  const configStart = CREATE_ARTICLE_SRC.indexOf('export const ARTICLE_SECTION_CONFIGS = {');
  assert.notEqual(configStart, -1, 'ARTICLE_SECTION_CONFIGS non trovata in create-article.mjs');
  const flags = {};
  for (const name of ['frontaliere', 'svizzera']) {
    const from = CREATE_ARTICLE_SRC.indexOf(`\n  ${name}: {`, configStart);
    assert.notEqual(from, -1, `sezione ${name} non trovata in ARTICLE_SECTION_CONFIGS`);
    const to = CREATE_ARTICLE_SRC.indexOf('\n  },', from);
    const m = /updateRouterUnion:\s*(true|false)/.exec(CREATE_ARTICLE_SRC.slice(from, to));
    assert.ok(m, `updateRouterUnion assente dalla sezione ${name}`);
    flags[name] = m[1] === 'true';
  }
  return flags;
}

/** `registerLockTargets()` vera, con le sue dipendenze iniettate. */
function loadRegisterLockTargets() {
  const needle = 'function registerLockTargets(id, sectionName = SECTION_NAME) {';
  const start = CREATE_ARTICLE_SRC.indexOf(needle);
  assert.notEqual(start, -1, 'registerLockTargets non trovata in create-article.mjs: aggiornare questo test');
  const endRel = CREATE_ARTICLE_SRC.slice(start).search(/\n\}\n/);
  assert.notEqual(endRel, -1, 'chiusura di registerLockTargets non trovata');
  const body = CREATE_ARTICLE_SRC.slice(start, start + endRel + 2);

  const flags = updateRouterUnionFlags();
  const configs = Object.fromEntries(
    Object.entries(SECTION_FILES).map(([name, cfg]) => [name, {
      slugDataFile: cfg.slug,
      registryFile: cfg.registry,
      seoFile: cfg.seo,
      metaPrefix: cfg.metaPrefix,
      bodyDir: cfg.bodyDir,
      updateRouterUnion: flags[name],
    }]),
  );
  return new Function(
    'ARTICLE_SECTION_CONFIGS',
    'SECTION_NAME',
    'REGISTER_LOCK_FILE',
    'resolve',
    `${body}\nreturn registerLockTargets;`,
  )(configs, SECTION, REGISTER_LOCK_FILE, (r) => `/root/${r}`);
}

test('la union BlogArticleId e\' fra i bersagli di frontaliere, e assente da svizzera', () => {
  const registerLockTargets = loadRegisterLockTargets();
  const UNION = 'packages/articles/content/blogArticleIds.ts';

  const fro = registerLockTargets(ARTICLE_ID, 'frontaliere');
  const froLabels = fro.map((t) => t.label);
  assert.ok(
    froLabels.includes(UNION),
    `la finestra di kill piu' larga resta non confrontata: ${UNION} non e' fra i bersagli (${froLabels.join(', ')})`,
  );
  // E' la PRIMA scrittura della sequenza: se il confronto la mettesse in coda
  // l'ordine non cambierebbe l'esito, ma la lista smetterebbe di raccontare
  // la sequenza che sorveglia.
  assert.equal(froLabels[0], UNION, 'la union e\' il primo bersaglio, come e\' la prima scrittura');
  // Il needle e' la forma realmente scritta da `modifyRouterUnion()`: l'id fra
  // apici singoli. Cercare l'id nudo darebbe un falso positivo su qualunque
  // sottostringa (un id e' prefisso di un altro piu' lungo appena si aggiunge
  // un suffisso di anno).
  assert.equal(fro.find((t) => t.label === UNION).needle, `'${ARTICLE_ID}'`);
  assert.equal(froLabels.length, 12, 'union + slug + registry + seo + 4 meta + 4 body');

  // svizzera non mantiene la union (`updateRouterUnion: false`): pretenderla
  // la' renderebbe `absent` un file che nessuno scrive mai, cioe' uno SPLIT
  // permanente su ogni lock svizzero.
  const svi = registerLockTargets(ARTICLE_ID, 'svizzera');
  const sviLabels = svi.map((t) => t.label);
  assert.equal(sviLabels.includes(UNION), false, 'svizzera non scrive la union: non va confrontata');
  assert.equal(sviLabels.length, 11, 'slug + registry + seo + 4 meta + 4 body');

  // Lo specchio scritto a mano di questo file deve restare allineato: e' cio'
  // che rende significativi gli altri test del lock.
  assert.deepEqual(froLabels, makeTargets('/root')(ARTICLE_ID, 'frontaliere').map((t) => t.label));
  assert.deepEqual(sviLabels, makeTargets('/root')(ARTICLE_ID, 'svizzera').map((t) => t.label));
});

test('la path della union e\' la stessa in scrittura, in staging e nel lock', () => {
  // Tre siti la nominano come letterale (`modifyRouterUnion`, `gitAddAll`,
  // `registerLockTargets`) e non possono importarsi a vicenda: il legame va
  // coperto da un test (AGENTS.md #6). Se uno dei tre cambia path da solo, il
  // lock torna a confrontare un file che nessuno scrive.
  const UNION = 'packages/articles/content/blogArticleIds.ts';
  const occorrenze = CREATE_ARTICLE_SRC.split(`'${UNION}'`).length - 1;
  assert.ok(
    occorrenze >= 3,
    `atteso il letterale ${UNION} in modifyRouterUnion + gitAddAll + registerLockTargets, trovate ${occorrenze} occorrenze`,
  );
  const writeBlock = CREATE_ARTICLE_SRC.slice(CREATE_ARTICLE_SRC.indexOf('function modifyRouterUnion(data) {'));
  assert.ok(
    writeBlock.slice(0, writeBlock.search(/\n\}\n/)).includes(`const routerFile = '${UNION}';`),
    'modifyRouterUnion non scrive piu\' su questa path: aggiornare anche registerLockTargets',
  );
});

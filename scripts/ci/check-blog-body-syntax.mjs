#!/usr/bin/env node
/**
 * check-blog-body-syntax.mjs — PREFLIGHT: ogni corpo articolo deve essere un
 * modulo TypeScript sintatticamente valido.
 *
 * PORTATO da valerielinc-ops/frontaliere-si-o-no `tests/blog-body-typescript-syntax.test.ts`.
 * Stesso oracolo, byte per byte: `esbuild.transform` con
 * `{ loader: 'ts', format: 'esm', target: 'es2022' }` — SOLO sintassi, nessun
 * type-check. Un file che passa qui passa la' e viceversa.
 *
 * ── Perche' un eseguibile e non un test in generator/tests/ ──────────────────
 *
 * Le due ragioni sono state MISURATE, non dedotte, e vanno lette insieme perche'
 * la seconda da sola non basterebbe.
 *
 * 1. Il difetto NON tocca la superficie dati di questo repo.
 *    `scripts/build-api.mjs` non contiene la stringa `blog-body` nemmeno una
 *    volta (`git show origin/main:scripts/build-api.mjs | grep -c blog-body` -> 0):
 *    carica i registri, i meta per locale, i router e `content/seo`, mai un
 *    corpo. Quindi un corpo rotto NON rompe questo build, non rompe manifest,
 *    articles.json, le sitemap, i dieci feed o il ticker. Nasce qui e detona sul
 *    SITO, nei quattro job build-locale — dove il 2026-07-29 un apostrofo non
 *    scappato in un corpo FR svizzera ha ucciso OGNI deploy finche' qualcuno non
 *    l'ha trovato leggendo i log di build. Il costo non e' un articolo: e' il
 *    deploy del sito, per tutti e quattro i locali, a tempo indeterminato.
 *
 * 2. Un gate sulle PR non vedrebbe mai un articolo.
 *    `.github/workflows/tests.yml` gira su `pull_request` e su
 *    `push: branches-ignore: [main]`. Gli articoli atterrano per PUSH DIRETTO
 *    su `main`: nessuno dei due trigger scatta. In piu' quel workflow e'
 *    dependency-free PER PROGETTO (nessun `npm ci`, commento esplicito nel
 *    file), mentre questo controllo ha bisogno di un parser TypeScript.
 *
 * Quindi il gate vive dove il difetto PASSA DAVVERO: come preflight di
 * `publish-api.yml`, che parte sul push a `main` che tocca `content/**` — cioe'
 * sull'unico evento che un corpo nuovo produce.
 *
 * ── Perche' FA FALLIRE la pubblicazione ─────────────────────────────────────
 *
 * Obiezione legittima: il difetto non tocca la superficie dati, quindi bloccare
 * la pubblicazione sembra sproporzionato. Non lo e', e il motivo e' l'asimmetria
 * dei costi. Pubblicare vuol dire ANNUNCIARE l'articolo — slugs.json, la
 * sitemap, i feed, il ticker — e un articolo annunciato che il sito non riesce a
 * compilare e' la classe «articolo fantasma», con in piu' il deploy del sito
 * fermo. Fermare UNA pubblicazione costa una finestra di staleness di una
 * mezz'ora (il push successivo ripubblica tutto); lasciar passare il corpo costa
 * ogni deploy del sito finche' un umano non legge i log. Il fallimento apre una
 * issue via `.github/workflows/workflow-failure-issues.yml`, che e' il canale di
 * drenaggio: non resta muto.
 *
 * ── Il parser, e perche' non e' un import statico ────────────────────────────
 *
 * Questo repo non ha `node_modules` e il ciclo agentico gira SENZA `npm ci` —
 * `generator/tests/loop-scripts-closure.test.mjs` lo sorveglia rifiutando gli
 * import di pacchetti non dichiarati in package.json per tutto `scripts/ci/`.
 * `esbuild` non e' fra le dipendenze e non deve diventarlo: verrebbe installato
 * a ogni merge insieme a playwright, sharp e transformers.
 *
 * Quindi esbuild e' risolto A RUNTIME, da una directory passata esplicitamente.
 * Ma — e qui la differenza con `scripts/ci/lib/mergePreviewCheck.mjs`, che se
 * `typescript` manca si dichiara SALTATO — qui l'assenza del parser e' un
 * ERRORE, non uno skip. Uno skip conservativo va bene per un check advisory al
 * merge; su un gate di pubblicazione sarebbe il falso verde perfetto: verde
 * perche' non ha guardato niente.
 *
 * NON trasformare la risoluzione runtime in `import esbuild from 'esbuild'`:
 * romperebbe `loop-scripts-closure.test.mjs`. Il guard
 * `generator/tests/blog-body-syntax-gate.test.mjs` lo verifica esplicitamente.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────
 *
 *   PREFLIGHT_ESBUILD_DIR=<dir che contiene node_modules/> \
 *     node scripts/ci/check-blog-body-syntax.mjs
 *
 * Exit 0 = tutti i corpi parsano. Exit 1 = offender, o pavimento non raggiunto,
 * o parser assente. Non esistono altri esiti.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * ENTRAMBI i corpora. Sul sito questo guard copriva solo `blog-body` e mai
 * `blog-body-ch`: e' cosi' che l'apostrofo del 2026-07-29 e' passato. Qui le
 * due radici sono `content/blog-body` e `content/blog-body-ch` (il sito le ha
 * sotto `services/locales/`).
 */
export const BLOG_BODY_ROOTS = [
  { rel: 'content/blog-body', minFiles: 3000 },
  { rel: 'content/blog-body-ch', minFiles: 1000 },
];

/**
 * Pavimento TOTALE, in aggiunta ai pavimenti per radice.
 *
 * I due pavimenti non sono ridondanti, coprono due modi di fallire diversi:
 *  - il TOTALE prende il caso «il gate ha scandito quasi niente» — in un
 *    worktree sparse `content/` non esiste affatto, e un gate che passa su zero
 *    file e' il falso verde piu' facile da produrre su questo repo;
 *  - il PER-RADICE prende il caso che il totale NON vede, ed e' il piu'
 *    insidioso: `blog-body` da solo fa 12.544 file, quindi una soglia sul totale
 *    resta soddisfatta anche se `blog-body-ch` risolve a zero (cartella
 *    rinominata, symlink orfano). Sarebbe il buco del 2026-07-29 riaperto dal
 *    guard che esiste per chiuderlo. Ogni corpus deve dimostrare di essere stato
 *    guardato.
 */
export const MIN_FILES_TOTAL = 3000;

/** Raccoglie ricorsivamente i `.ts` sotto `dir`. Directory assente -> []. */
export function collectTypeScriptFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.ts')) files.push(fullPath);
  }
  return files;
}

/**
 * Applica i pavimenti. Ritorna la lista dei messaggi di violazione (vuota = ok).
 * Pura e senza I/O sulle soglie: e' la meta' che il test in `generator/tests/`
 * puo' esercitare senza esbuild e senza `content/`.
 */
export function floorViolations(perRoot, { minTotal = MIN_FILES_TOTAL } = {}) {
  const violations = [];
  let total = 0;
  for (const { rel, minFiles, count } of perRoot) {
    total += count;
    if (count <= minFiles) {
      violations.push(
        `${rel}: ${count} file scanditi, soglia > ${minFiles}. ` +
          `La radice non e' stata guardata (checkout sparse? cartella rinominata?) — ` +
          `un gate che passa senza guardare e' peggio di nessun gate.`,
      );
    }
  }
  if (total <= minTotal) {
    violations.push(
      `TOTALE: ${total} file scanditi, soglia > ${minTotal}. ` +
        `In un checkout sparse content/ non esiste affatto: questo e' il falso verde da non produrre.`,
    );
  }
  return violations;
}

/** Formatta gli offender come il test del sito: path relativo + messaggi esbuild. */
export function formatOffender(filePath, err) {
  const messages =
    err && Array.isArray(err.errors) && err.errors.length
      ? err.errors.map((e) => e.text).join('\n')
      : String(err);
  return `${path.relative(ROOT, filePath)}\n${messages}`;
}

/**
 * Carica esbuild da una directory esplicita. Fallisce rumorosamente: vedi
 * l'intestazione — su un gate di pubblicazione uno skip e' un falso verde.
 */
export function loadEsbuild(dir = process.env.PREFLIGHT_ESBUILD_DIR) {
  const candidates = [];
  if (dir) candidates.push(path.resolve(dir));
  candidates.push(ROOT); // se un giorno questo repo avesse node_modules

  const tried = [];
  for (const base of candidates) {
    try {
      // createRequire vuole un FILENAME: risolve a partire da <base>/node_modules.
      // Il file non deve esistere.
      return createRequire(path.join(base, 'noop.cjs'))('esbuild');
    } catch (err) {
      tried.push(`${base}/node_modules  (${err.code || err.message})`);
    }
  }
  throw new Error(
    'esbuild non risolvibile: il preflight non ha un parser e NON puo' +
      "' dichiararsi verde.\n" +
      'Cercato in:\n  ' +
      tried.join('\n  ') +
      '\nInstallalo in una directory isolata e passala in PREFLIGHT_ESBUILD_DIR ' +
      '(vedi lo step «Install the preflight parser» di .github/workflows/publish-api.yml). ' +
      "Isolata e non nella radice del repo: `npm install` qui dentro tirerebbe anche le 7 " +
      'dipendenze di package.json, playwright e sharp comprese.',
  );
}

/**
 * A quanti transform concorrenti tenere esbuild.
 *
 * Il test del sito fa `Promise.all` su tutti e ~14k i file insieme; regge, ma
 * accoda 15k richieste sul servizio esbuild e tiene 15k sorgenti vivi in memoria
 * contemporaneamente. A lotti il picco e' costante e il tempo e' lo stesso: il
 * collo di bottiglia e' il parsing, non la concorrenza.
 */
const BATCH = 500;

export async function run({ log = console.log, error = console.error } = {}) {
  const perRoot = BLOG_BODY_ROOTS.map((r) => {
    const files = collectTypeScriptFiles(path.join(ROOT, r.rel));
    return { ...r, count: files.length, files };
  });

  for (const r of perRoot) log(`${r.rel}: ${r.count} file`);

  const violations = floorViolations(perRoot);
  if (violations.length) {
    for (const v of violations) error(`::error::preflight blog-body — ${v}`);
    return 1;
  }

  const esbuild = loadEsbuild();
  const files = perRoot.flatMap((r) => r.files);
  const failures = [];

  const started = Date.now();
  for (let i = 0; i < files.length; i += BATCH) {
    const chunk = files.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(async (filePath) => {
        const source = fs.readFileSync(filePath, 'utf8');
        try {
          await esbuild.transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
          return null;
        } catch (err) {
          return formatOffender(filePath, err);
        }
      }),
    );
    for (const r of results) if (r !== null) failures.push(r);
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  log(`preflight blog-body: ${files.length} file analizzati in ${elapsed}s, ${failures.length} offender`);

  if (failures.length) {
    error(
      '::error::preflight blog-body — ' +
        `${failures.length} corpo/i non parsano come TypeScript. Questi NON rompono la ` +
        'superficie dati di questo repo (build-api.mjs non legge i corpi): rompono i quattro ' +
        'job build-locale del SITO, cioe' +
        "' ogni suo deploy, finche' qualcuno non legge i log di build. " +
        'La pubblicazione si ferma qui apposta.',
    );
    for (const f of failures) error(f + '\n');
    return 1;
  }
  return 0;
}

// Guardia CLI: importare questo modulo da un test non deve eseguirlo.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run();
}

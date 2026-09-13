/**
 * article-surfaces.mjs — «su quali file vive un articolo?», in un posto solo.
 *
 * I due lettori di questa risposta devono darne la STESSA:
 *
 *   - `scripts/retire-article.mjs`, passo 12, che rilegge le superfici dopo la
 *     rimozione ed esce 1 su `RIMOZIONE PARZIALE`;
 *   - `generator/tests/retired-articles-fully-removed.test.mjs`, gate di PR
 *     (`scripts/ci/list-pr-gate-tests.mjs`), che rilegge le stesse superfici su
 *     ogni voce di `data/retired-articles.json`.
 *
 * Fino a qui l'elenco era scritto a mano, e la copia era già divergente dalla
 * sorgente del generatore: il gate non guardava `content/blogArticleIds.ts` o
 * i file SEO, quindi un id ritirato sopravvissuto lì passava verde — proprio
 * nel test che esiste per accorgersene. Un elenco duplicato non diverge «se
 * qualcuno sbaglia»: diverge da solo, perché una superficie nuova si aggiunge
 * dove serve subito e non dove serve dopo. Da qui la sorgente unica
 * (AGENTS.md #6), come già per `mentions-id.mjs`.
 */

import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTICLE_SECTION_CORE } from '../../engine/shared/articleSectionCore.mjs';
import { corpusPath } from '../../generator/scripts/lib/corpus-paths.mjs';
import { ledgerArticleId } from '../../generator/scripts/lib/source-url-ledger.mjs';
import { mentionsId } from './mentions-id.mjs';

/** La radice del repo: questo modulo vive in `scripts/lib/`. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const SURFACE_PATH_STATUS = Object.freeze({
  ABSENT: 'absent',
  DIRECTORY: 'directory',
  REGULAR: 'regular',
  NON_REGULAR: 'non-regular',
  UNREADABLE: 'unreadable',
});

function statusForStatError(error) {
  if (error?.code === 'ENOENT') return SURFACE_PATH_STATUS.ABSENT;
  // A file in the middle of a path is not an absent optional surface: it is
  // a malformed tree that must stop a retirement before its first write.
  if (error?.code === 'ENOTDIR') return SURFACE_PATH_STATUS.NON_REGULAR;
  return SURFACE_PATH_STATUS.UNREADABLE;
}

/**
 * Classifica un path senza collassare «non c'è» e «non lo si può leggere».
 *
 * `lstatSync` copre directory, symlink, FIFO e gli altri inode non regolari;
 * `accessSync` copre il file regolare presente ma non leggibile. Tutti i
 * chiamanti dei guard usano questa stessa decisione, così un errore di tipo
 * non diventa una superficie opzionale sparita per magia.
 */
export function surfacePathStatus(root, rel) {
  const absolute = path.join(root, rel);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch (error) {
    return statusForStatError(error);
  }
  if (stats.isDirectory()) return SURFACE_PATH_STATUS.DIRECTORY;
  if (!stats.isFile()) return SURFACE_PATH_STATUS.NON_REGULAR;
  try {
    accessSync(absolute, fsConstants.R_OK);
  } catch {
    return SURFACE_PATH_STATUS.UNREADABLE;
  }
  return SURFACE_PATH_STATUS.REGULAR;
}

/** Predicate condivisa con i gate che verificano file obbligatori. */
export function isRegularFile(root, rel) {
  return surfacePathStatus(root, rel) === SURFACE_PATH_STATUS.REGULAR;
}

function invalidRegularFileError(rel, status, label) {
  return new Error(
    `${label}: '${rel}' non è un file regolare leggibile (${status}); ` +
    'assenza e path non utilizzabile sono stati distinti fail-closed.',
  );
}

function invalidDirectoryError(rel, status, label) {
  return new Error(
    `${label}: '${rel}' non è una directory leggibile (${status}); ` +
    'assenza e path non utilizzabile sono stati distinti fail-closed.',
  );
}

/** Richiede un file regolare già noto: anche l'assenza è un errore. */
export function requireRegularFile(root, rel, label = 'file') {
  const status = surfacePathStatus(root, rel);
  if (status !== SURFACE_PATH_STATUS.REGULAR) {
    throw invalidRegularFileError(rel, status, label);
  }
  return true;
}

/** Accetta l'assenza opzionale, ma non un inode presente e non utilizzabile. */
export function assertRegularFileIfPresent(root, rel, label = 'superficie') {
  const status = surfacePathStatus(root, rel);
  if (status === SURFACE_PATH_STATUS.ABSENT) return false;
  if (status !== SURFACE_PATH_STATUS.REGULAR) {
    throw invalidRegularFileError(rel, status, label);
  }
  return true;
}

export const LOCALES = ['it', 'en', 'de', 'fr'];
export const IMAGES_LEDGER = 'data/blog-images-used.json';
export const IMAGE_CATALOG = 'public/data/journalist-image-catalog.json';
export const RETIRED_LEDGER = 'data/retired-articles.json';

/**
 * The main-layout tuple is canonical in `ARTICLE_SECTION_CORE`. The corpus
 * only maps those paths into its published layout; section-specific extras
 * remain here because they are genuinely not part of that shared tuple.
 */
function canonicalSurfaces(core) {
  return {
    registryFile: corpusPath(core.registryFile),
    slugDataFile: corpusPath(core.slugDataFile),
    metaFiles: LOCALES.map((locale) => corpusPath(`services/locales/${core.metaPrefix}-${locale}.ts`)),
    bodyDir: corpusPath(`services/locales/${core.bodyDir}`),
  };
}

/** Descrittori per sezione: le superfici su cui `create-article.mjs` scrive. */
export const SECTIONS = {
  frontaliere: {
    ...canonicalSurfaces(ARTICLE_SECTION_CORE.frontaliere),
    fallbackReasonsConstName: 'BLOG_SLUG_FALLBACK_REASONS',
    // `ALL_BLOG_ARTICLE_IDS` è un array letterale indipendente, non derivato
    // da `BLOG_SLUGS`: rimuovere la riga slug non lo tocca. `routerSwissData.ts`
    // non ha bisogno del suo equivalente qui perché lì è
    // `Object.keys(SWISS_SLUGS)`, quindi resta coerente da solo.
    idListVar: 'ALL_BLOG_ARTICLE_IDS',
    // Stessa classe: `create-article.mjs` appende l'id anche alla union di
    // literal `BlogArticleId` (`modifyRouterUnion`, solo per questa sezione),
    // che è un file a sé e non deriva da nulla. Senza ripulirla il tipo
    // continua ad ammettere un id che non esiste più su nessuna superficie.
    idUnionFile: 'content/blogArticleIds.ts',
    seoFiles: null, // scoperti a runtime: content/seo/seo-blog*.ts
    seoGlobPrefix: 'content/seo/seo-blog',
    sourceLedger: 'data/article-source-urls.json',
    sidecarDir: 'data/blog-articles',
  },
  svizzera: {
    ...canonicalSurfaces(ARTICLE_SECTION_CORE.svizzera),
    fallbackReasonsConstName: 'SWISS_SLUG_FALLBACK_REASONS',
    idListVar: null,
    // `create-article.mjs`: la sezione svizzera NON mantiene la union
    // (`updateRouterUnion` falso), gli id sono stringhe libere.
    idUnionFile: null,
    seoFiles: ['content/seo/seo-blog-ch.ts'],
    seoGlobPrefix: null,
    sourceLedger: 'data/swiss-article-source-urls.json',
    sidecarDir: 'data/swiss-articles',
  },
};

const SOURCE_LEDGER_FILES = new Set(Object.values(SECTIONS).map(({ sourceLedger }) => sourceLedger));

export const SURFACE_ARTICLE_ID_STATUS = Object.freeze({
  ABSENT: 'absent',
  PRESENT: 'present',
  UNREADABLE: 'unreadable',
});

/**
 * Cerca un id nelle superfici testuali, rispettando la struttura dei ledger
 * URL→id: in quei due JSON l'id è il valore, non una parte della chiave URL.
 */
export function surfaceArticleIdStatus(rel, text, id) {
  if (typeof id !== 'string' || id.length === 0) return SURFACE_ARTICLE_ID_STATUS.ABSENT;
  if (!SOURCE_LEDGER_FILES.has(rel)) {
    return mentionsId(text, id)
      ? SURFACE_ARTICLE_ID_STATUS.PRESENT
      : SURFACE_ARTICLE_ID_STATUS.ABSENT;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return SURFACE_ARTICLE_ID_STATUS.UNREADABLE;
    return Object.values(parsed).some((value) => ledgerArticleId(value) === id)
      ? SURFACE_ARTICLE_ID_STATUS.PRESENT
      : SURFACE_ARTICLE_ID_STATUS.ABSENT;
  } catch {
    return SURFACE_ARTICLE_ID_STATUS.UNREADABLE;
  }
}

/**
 * Boolean compatibility for the PR gate: unreadable ledgers remain blocking,
 * because an unreadable surface is not proof that the article is gone.
 */
export function surfaceMentionsArticleId(rel, text, id) {
  return surfaceArticleIdStatus(rel, text, id) !== SURFACE_ARTICLE_ID_STATUS.ABSENT;
}

/**
 * I file SEO della sezione, elencati o scoperti a runtime. Solo quelli esistenti.
 *
 * Il glob è `seo-blog*.ts` e non `seo-blog-*.ts`: il trattino escludeva
 * `content/seo/seo-blog.ts`, che è il chunk ORIGINALE e contiene ancora un
 * migliaio di voci `'blog-<id>'`. Un articolo vecchio ritirato ci lasciava
 * dentro il suo blocco SEO, e il passo 12 non lo vedeva perché leggeva lo
 * stesso elenco monco. Stesso glob di `generator/scripts/repair-microcopy.mjs`
 * e `repair-prompt-placeholders.mjs`, che quel file lo trattano da sempre.
 */
export function seoFilesFor(section, root = ROOT) {
  const cfg = SECTIONS[section];
  if (!cfg) throw new Error(`sezione sconosciuta: '${section}'`);
  const label = `superficie SEO della sezione '${section}'`;
  if (cfg.seoFiles) {
    return cfg.seoFiles.filter((f) => assertRegularFileIfPresent(root, f, label));
  }

  const dirRel = 'content/seo';
  const dirStatus = surfacePathStatus(root, dirRel);
  if (dirStatus === SURFACE_PATH_STATUS.ABSENT) return [];
  if (dirStatus !== SURFACE_PATH_STATUS.DIRECTORY) {
    throw invalidDirectoryError(dirRel, dirStatus, label);
  }

  const dir = path.join(root, dirRel);
  let names;
  try {
    accessSync(dir, fsConstants.R_OK | fsConstants.X_OK);
    names = readdirSync(dir);
  } catch (error) {
    throw new Error(
      `${label}: '${dirRel}' è presente ma illeggibile (${error?.code || error?.message || error})`,
    );
  }
  return names
    .filter((f) => /^seo-blog.*\.ts$/.test(f))
    .map((f) => `content/seo/${f}`)
    .map((f) => {
      requireRegularFile(root, f, label);
      return f;
    });
}

/**
 * Files every section must have for a registration to be inspectable. These
 * are not optional inputs: if one is absent, treating the section as clean
 * would make a partial retirement pass the guard open. SEO chunks and the
 * source/id ledgers are intentionally handled separately because their
 * presence varies by producer/history.
 */
export function requiredSurfaceFilesFor(section, root = ROOT) {
  const cfg = SECTIONS[section];
  if (!cfg) throw new Error(`sezione sconosciuta: '${section}'`);
  const required = [cfg.registryFile, cfg.slugDataFile, ...cfg.metaFiles];
  const invalid = required
    .map((file) => ({ file, status: surfacePathStatus(root, file) }))
    .filter(({ status }) => status !== SURFACE_PATH_STATUS.REGULAR);
  if (invalid.length > 0) {
    throw new Error(
      `superfici obbligatorie mancanti o non utilizzabili per la sezione '${section}': ` +
      invalid.map(({ file, status }) => `${file} (${status})`).join(', '),
    );
  }
  return required;
}

/**
 * Le superfici TESTUALI su cui un id ritirato non deve più comparire — quelle
 * da cui si rimuove una riga o un blocco, non il file intero (corpi e sidecar
 * si cancellano, e la loro assenza si verifica con `existsSync`).
 *
 * Restituisce solo i file esistenti: una superficie assente non è un residuo.
 */
export function leftoverSurfacesFor(section, root = ROOT) {
  const cfg = SECTIONS[section];
  if (!cfg) throw new Error(`sezione sconosciuta: '${section}'`);
  const required = requiredSurfaceFilesFor(section, root);
  const optional = [
    ...seoFilesFor(section, root),
    cfg.sourceLedger,
    ...(cfg.idUnionFile ? [cfg.idUnionFile] : []),
  ].flatMap((f) => assertRegularFileIfPresent(root, f) ? [f] : []);
  return [...required, ...optional];
}

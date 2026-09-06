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
 * Fino a qui l'elenco era scritto due volte, e le due copie erano già
 * divergenti: il gate non guardava `content/blogArticleIds.ts`, i file SEO né
 * il ledger delle immagini, quindi un id ritirato sopravvissuto lì passava
 * verde — proprio nel test che esiste per accorgersene. Un elenco duplicato non
 * diverge «se qualcuno sbaglia»: diverge da solo, perché una superficie nuova
 * si aggiunge dove serve subito (lo script) e non dove serve dopo (il gate).
 * Da qui la sorgente unica (AGENTS.md #6), come già per `mentions-id.mjs`.
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** La radice del repo: questo modulo vive in `scripts/lib/`. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const LOCALES = ['it', 'en', 'de', 'fr'];
export const IMAGES_LEDGER = 'data/blog-images-used.json';
export const IMAGE_CATALOG = 'public/data/journalist-image-catalog.json';
export const RETIRED_LEDGER = 'data/retired-articles.json';

/** Descrittori per sezione: le superfici su cui `create-article.mjs` scrive. */
export const SECTIONS = {
  frontaliere: {
    registryFile: 'content/blog-articles-data.ts',
    slugDataFile: 'content/routerBlogData.ts',
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
    metaFiles: LOCALES.map((l) => `content/blog-meta-${l}.ts`),
    bodyDir: 'content/blog-body',
    seoFiles: null, // scoperti a runtime: content/seo/seo-blog*.ts
    seoGlobPrefix: 'content/seo/seo-blog',
    sourceLedger: 'data/article-source-urls.json',
    sidecarDir: 'data/blog-articles',
  },
  svizzera: {
    registryFile: 'content/swiss-articles-data.ts',
    slugDataFile: 'content/routerSwissData.ts',
    idListVar: null,
    // `create-article.mjs`: la sezione svizzera NON mantiene la union
    // (`updateRouterUnion` falso), gli id sono stringhe libere.
    idUnionFile: null,
    metaFiles: LOCALES.map((l) => `content/blog-meta-ch-${l}.ts`),
    bodyDir: 'content/blog-body-ch',
    seoFiles: ['content/seo/seo-blog-ch.ts'],
    seoGlobPrefix: null,
    sourceLedger: 'data/swiss-article-source-urls.json',
    sidecarDir: 'data/swiss-articles',
  },
};

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
export function seoFilesFor(section) {
  const cfg = SECTIONS[section];
  if (!cfg) throw new Error(`sezione sconosciuta: '${section}'`);
  if (cfg.seoFiles) return cfg.seoFiles.filter((f) => existsSync(path.join(ROOT, f)));
  const dir = path.join(ROOT, 'content/seo');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('seo-blog-') && f.endsWith('.ts'))
    .map((f) => `content/seo/${f}`);
}

/**
 * Le superfici TESTUALI su cui un id ritirato non deve più comparire — quelle
 * da cui si rimuove una riga o un blocco, non il file intero (corpi e sidecar
 * si cancellano, e la loro assenza si verifica con `existsSync`).
 *
 * Restituisce solo i file esistenti: una superficie assente non è un residuo.
 */
export function leftoverSurfacesFor(section) {
  const cfg = SECTIONS[section];
  if (!cfg) throw new Error(`sezione sconosciuta: '${section}'`);
  return [
    cfg.registryFile,
    cfg.slugDataFile,
    ...cfg.metaFiles,
    ...seoFilesFor(section),
    cfg.sourceLedger,
    IMAGES_LEDGER,
    ...(cfg.idUnionFile ? [cfg.idUnionFile] : []),
  ].filter((f) => existsSync(path.join(ROOT, f)));
}

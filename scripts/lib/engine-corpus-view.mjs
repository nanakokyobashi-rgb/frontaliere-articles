import '../../host/cantonSectionsBootstrap.mjs';

/**
 * engine-corpus-view.mjs — il corpus visto nel LAYOUT che l'engine legge.
 *
 * L'engine (mirror dal sito) legge il corpus con i path del sito:
 * `services/locales/<metaPrefix>-<loc>.ts`, `services/seo/seo-blog-<sezione>.ts`,
 * `packages/articles/content/cantons/<id>/registry.ts`. Il corpus tiene gli
 * stessi file sotto `content/`. Per le due sezioni storiche il ponte sono dei
 * symlink committati, uno per file (`services/locales/blog-meta-ch-it.ts` →
 * `content/…`), e i chiamanti che passano un `layout` (i feed RSS).
 *
 * Per le sezioni cantonali quel ponte non basta, per due ragioni:
 *   - 24 sezioni x (4 meta + corpi + registro + slug + SEO) sarebbero piu' di
 *     cento symlink da tenere in pari col generatore a ogni cantone acceso;
 *   - il chunk SEO ha due NOMI: create-article lo scrive in
 *     `content/cantons/<id>/seo.ts` (accanto al registro, dentro i `push.paths`
 *     del workflow del cantone), l'engine lo cerca come
 *     `services/seo/seo-blog-<id>.ts` (descrittore articolo e profilo RSS).
 *     Senza ponte gli articoli si rendono senza metadati e i feed senza item:
 *     nessun errore, solo pagine mancanti.
 *
 * Qui la vista si costruisce al volo, in una cartella temporanea, con alias di
 * CARTELLA che valgono per qualunque sezione piu' UN alias per chunk SEO
 * cantonale:
 *
 *   services/locales                    → content
 *   services/seo/<file>                 → content/seo/<file>          (ogni chunk storico)
 *   services/seo/seo-blog-<canton-id>.ts → content/cantons/<canton-id>/seo.ts   (se esiste)
 *   packages/articles/content           → content
 *   packages/articles/engine            → engine
 *   <ogni altra voce della radice>      → la voce vera
 *
 * Sola lettura: niente viene scritto attraverso la vista. Chi la crea la
 * rimuove (`fs.rmSync(view, { recursive: true })` cancella i symlink, non i
 * loro bersagli).
 *
 * Solo builtin Node (regola di `scripts/lib/**`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ARTICLE_SECTION_CORE_ALL } from '../../engine/shared/articleSectionCore.mjs';

/** Il chunk SEO di una sezione cantonale come lo scrive create-article (relativo alla radice). */
export function cantonSeoSourceFile(section) {
  return `content/cantons/${section}/seo.ts`;
}

/** Il nome con cui l'engine cerca il chunk SEO di una sezione cantonale. */
export function engineSeoChunkName(section) {
  return `seo-blog-${section}.ts`;
}

/**
 * Dove stanno NEL CORPUS i chunk SEO che alimentano i feed di una sezione
 * dell'engine (`{ id, seoFiles }`, una voce di RSS_SECTIONS), per chi li conta
 * dalla radice vera senza passare dalla vista (i pavimenti): `content/seo` e i
 * nomi dell'engine per le storiche, la cartella della sezione e `seo.ts` per
 * una cantonale.
 * @returns {{ seoDir: string, files: string[], historyComparable: boolean }}
 */
export function seoChunkSources(section) {
  if (ARTICLE_SECTION_CORE_ALL[section.id]?.kind === 'canton') {
    const source = cantonSeoSourceFile(section.id);
    // Niente confronto con la revisione precedente: la lettura storica cerca i
    // chunk in content/seo coi nomi dell'engine, che per una cantonale non esistono.
    return { seoDir: path.dirname(source), files: [path.basename(source)], historyComparable: false };
  }
  return { seoDir: path.join('content', 'seo'), files: [...section.seoFiles], historyComparable: true };
}

/**
 * @param {string} rootDir radice del repo
 * @param {string} [tmpBase]
 * @returns {string} la cartella della vista
 */
export function createEngineCorpusView(rootDir, tmpBase = os.tmpdir()) {
  const view = fs.mkdtempSync(path.join(tmpBase, 'engine-corpus-view-'));
  const link = (target, rel) => {
    const abs = path.join(view, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.symlinkSync(path.join(rootDir, target), abs);
  };
  for (const entry of fs.readdirSync(rootDir)) {
    if (['.git', 'dist', 'services', 'packages'].includes(entry)) continue;
    link(entry, entry);
  }
  const servicesDir = path.join(rootDir, 'services');
  for (const entry of fs.existsSync(servicesDir) ? fs.readdirSync(servicesDir) : []) {
    if (entry === 'locales' || entry === 'seo') continue;
    link(path.join('services', entry), path.join('services', entry));
  }
  link('content', 'services/locales');
  const seoDir = path.join(rootDir, 'content', 'seo');
  for (const file of fs.existsSync(seoDir) ? fs.readdirSync(seoDir) : []) link(path.join('content', 'seo', file), path.join('services', 'seo', file));
  for (const core of Object.values(ARTICLE_SECTION_CORE_ALL)) {
    if (core.kind !== 'canton') continue;
    const source = cantonSeoSourceFile(core.section);
    const alias = path.join('services', 'seo', engineSeoChunkName(core.section));
    // Un chunk gia' presente col nome dell'engine in content/seo vince (e' gia' linkato sopra).
    if (fs.existsSync(path.join(rootDir, source)) && !fs.existsSync(path.join(view, alias))) link(source, alias);
  }
  link('content', 'packages/articles/content');
  link('engine', 'packages/articles/engine');
  return view;
}

/** Il layout da passare a `engine/rssFeeds.mjs` quando la radice e' la vista. */
export function engineViewRssLayout(slugFile) {
  return Object.freeze({
    seoDir: 'services/seo',
    localesDir: 'services/locales',
    slugDir: slugFile.slice(0, slugFile.lastIndexOf('/')),
  });
}

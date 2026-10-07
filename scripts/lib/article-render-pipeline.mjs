import '../../host/cantonSectionsBootstrap.mjs';

/**
 * article-render-pipeline.mjs — la catena di render delle pagine articolo di
 * UNA sezione, estratta da scripts/publish-article-fast.mjs perche' la usino
 * allo stesso modo il fast-publish verso gli shard (frontaliere, svizzera) e
 * il publisher R2 delle sezioni cantonali (scripts/publish-section-pages.mjs).
 *
 * E' UNA catena con un ordine che conta, e due copie divergerebbero proprio
 * sull'ordine (issue #5270: l'offload CDN deve girare dopo OGNI pagina resa,
 * archivio compreso; la copia del sito e questa si sono gia' sfasate una
 * volta). I passi, invariati:
 *
 *   0. symlink di public/images nello scratch (solo per il passo 1)
 *   1. renderArticlePages (engine/ogPagesPlugin.ts)
 *   2-5. flat bridge, link contestuali, hreflang, hero sul CDN, sanificazione
 *   6. archivio `/tutti/` + page-N (engine/articleHubPagesPlugin.ts)
 *   6b. `beforeOffload`: pagine in piu' del chiamante (landing e hub cantonali)
 *   7. offload-generated-images-cdn.mjs sull'intero scratch
 *   7b. verifica che gli /assets/ riscritti esistano sul CDN (non fatale)
 *
 * Va eseguito con tsx (importa i .ts di engine/ e host/) e UNA volta per
 * processo: imposta ASSET_CDN e TZ prima del primo import dell'engine, che li
 * legge a tempo di valutazione del modulo.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { sanitizeHtmlDocument } from './sanitize-control-chars.mjs';
import { reportStrippedControlChars } from '../../generator/scripts/lib/control-char-write-report.mjs';
import { filterEntriesByImagePostcondition } from './article-image-postcondition.mjs';
import { releaseArticlesWithNothingToProtect } from './article-online-image-probe.mjs';

export const CDN_BASE = 'https://cdn.frontaliereticino.ch';
const SITE_ORIGIN = 'https://frontaliereticino.ch';
const MAX_DECLARED_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const IMAGE_FETCH_ATTEMPTS = 2;
const IMAGE_FETCH_CONCURRENCY = 4;

/**
 * @param {object} opts
 * @param {string} opts.rootDir radice del repo
 * @param {string} opts.distDir cartella scratch (creata dal chiamante)
 * @param {string} opts.section sezione ATTIVA del core
 * @param {string[]} opts.ids id articolo da rendere (vuoto = nessun articolo, solo archivio ed extra)
 * @param {string} [opts.logPrefix]
 * @param {(ctx: { distDir: string, entries: any[], hubResult: any }) => (string[] | void | Promise<string[] | void>)} [opts.beforeOffload]
 *   scrive pagine in piu' in distDir e ne restituisce i path relativi
 * @param {(url: string) => Promise<{ state: string, reason: string }>} [opts.probeOnlineImage]
 *   lettura della pagina online per gli articoli ricaduti sull'immagine generica (default: produzione)
 * @returns {Promise<{ written: number, entries: any[], hubResult: any, extraPaths: string[], locales: string[], declaredImages: object, downloadedImageKeys: string[], imageFetchFailures: any[], imagePostcondition: object }>}
 */
export async function renderSectionArticlePipeline({ rootDir, distDir, section, ids, logPrefix = 'article-render-pipeline', beforeOffload, probeOnlineImage }) {
  // build-plugins/constants.ts reads process.env.ASSET_CDN ONCE, at module
  // top-level evaluation (an IIFE, not a function call re-read per use), to
  // derive CDN_PRECONNECT_HINT (consumed by ogPagesPlugin.ts). the site repo's deploy workflow's
  // build-locale job hardcodes ASSET_CDN: 'https://cdn.frontaliereticino.ch'
  // for every real deploy build (including the `it` shard whose vite build
  // renders this exact article HTML) — matching that here is required for
  // byte-identity, not optional config. Must be set BEFORE the first import
  // of ogPagesPlugin.ts/constants.ts below (module evaluation is cached —
  // setting it later would be a no-op on a second call in the same process,
  // and this script only ever does ONE render per invocation anyway).
  // Without this, CDN_PRECONNECT_HINT is empty at render time, ogPagesPlugin
  // never emits its own preconnect (normally placed right before the
  // blog-chunk preload links), and step 7's offload script — which DOES get
  // CDN_BASE below — then finds no existing same-origin preconnect to dedup
  // against and injects a redundant preconnect+dns-prefetch pair of its own
  // at the very top of <head> instead: a real, confirmed byte-identity
  // divergence from production (see the site repo's article byte-identity check),
  // not a live-staleness artifact — verified by tracing both code paths and
  // reproducing the exact live vs. fast-path <head> diff.
  process.env.ASSET_CDN = CDN_BASE;

  // Configure the site-shell contract. Must come AFTER the ASSET_CDN
  // assignment above and BEFORE any engine import: host/constants.ts derives
  // CDN_PRECONNECT_HINT from process.env.ASSET_CDN at module-evaluation time
  // (an IIFE, not a per-use read), and the bootstrap imports it. Loading the
  // bootstrap first leaves CDN_PRECONNECT_HINT empty, ogPagesPlugin then emits
  // no preconnect, and step 7's offload script — finding no same-origin
  // preconnect to dedup against — injects its own preconnect+dns-prefetch pair
  // at the top of <head> instead. That is a real byte divergence from the full
  // build, confirmed by diffing this script's output against the main repo's
  // for the same article id.
  //
  // In the main repo this ordering is implicit: every `build-plugins/*` shim
  // imports the bootstrap as a side effect. Here the host tree is ours and the
  // wiring has to be explicit.
  await import('../../host/siteShellBootstrap.ts');

  // Pin the process timezone to match the CI runner.
  //
  // No longer load-bearing: ogPagesPlugin's byline formatters used to read the
  // calendar day through local `new Date(...)` accessors, so a CET developer
  // machine and a UTC runner disagreed by a day for midnight-CET stamps. That
  // was a real bug shipping on ~142 live articles (machine-readable `datetime`
  // vs visible text off by one) and is fixed at the source in the same PR —
  // both formatters now parse the ISO string's own fields, and the rendered
  // bytes are identical under TZ=UTC and TZ=America/New_York.
  //
  // The pin stays as defence in depth: it keeps this script's environment
  // identical to the deploy build's for any date handling added later, at zero
  // cost. Must be set before the dynamic import below (Node reads TZ once).
  process.env.TZ = 'UTC';

  const declaredImages = await readDeclaredImages(rootDir, section, ids);
  const imageStage = await prepareImageView({ rootDir, distDir, ids, declaredImages, logPrefix });

  // ── Step 1: render the 4 locale pages (Deliverables 1+2, #4837 stream A) ──
  const { renderArticlePages } = await import('../../engine/ogPagesPlugin.ts');
  // `ids` vuoto = nessun articolo da rendere (una sezione appena accesa, o un
  // giro che rinfresca solo landing/archivio/hub): `onlyArticleIds: []` non
  // deve mai voler dire «tutta la sezione».
  let written;
  let entries;
  try {
    ({ written, entries } = ids.length
      ? await renderArticlePages({ rootDir, distDir, section, onlyArticleIds: ids })
      : { written: 0, entries: [] });
  } finally {
    removeImageView(imageStage.viewDir);
    fs.rmSync(imageStage.downloadDir, { recursive: true, force: true });
  }

  const renderedIds = new Set(entries.map((entry) => entry.articleId));
  const missingIds = ids.filter((id) => !renderedIds.has(id));
  if (missingIds.length > 0) {
    throw new Error(`article id(s) not found in section "${section}": ${missingIds.join(', ')} — check --ids/--section`);
  }

  // ── Steps 2-5: flat-redirect -> contextual links -> hreflang -> hero-image CDN ──
  const { buildFlatBridgeFromSibling } = await import('../../engine/flatHtmlRedirect.ts');
  const { injectContextualLinks } = await import('../../engine/blogContextualLinksPlugin.ts');
  const { transformHreflang } = await import('../../engine/hreflangPostprocess.ts');
  const { rewriteBlogImageRefs } = await import('../../engine/blogImageCdnFinalize.ts');
  const { BASE_URL } = await import('../../host/constants.ts');

  const locales = ['it', 'en', 'de', 'fr'];
  for (const entry of entries) {
    for (const locale of locales) {
      const indexRel = entry.paths[locale];
      const flatRel = entry.flatPaths[locale];
      if (!indexRel || !flatRel) continue; // locale not rendered (defensive — both sections render all 4)

      const indexAbs = path.join(distDir, indexRel);
      const flatAbs = path.join(distDir, flatRel);
      const slashUrl = entry.urls[locale];

      const freshIndexHtml = fs.readFileSync(indexAbs, 'utf-8');

      // 2. flat-redirect transform (built from the fresh, pre-postprocess content)
      const bridgeHtml = buildFlatBridgeFromSibling(freshIndexHtml, slashUrl);

      // 3. contextual links (index.html only)
      const linked = injectContextualLinks(freshIndexHtml, locale);
      let indexHtml = linked.html;

      // 4. hreflang postprocess — all 4 locale index.html for this article
      // already exist in distDir, so existsCheck can hit the real filesystem.
      const hreflangResult = transformHreflang(indexHtml, distDir, BASE_URL, (absPath) => fs.existsSync(absPath));
      if (hreflangResult) indexHtml = hreflangResult.html;

      // 5. hero-image CDN rewrite — applied to both files, matching
      // blogImageCdnFinalizePlugin's unconditional whole-dist walk. Images
      // recovered from the CDN for this scratch render can also live outside
      // images/blog; keep those references on the CDN after the temporary
      // image view is removed.
      indexHtml = rewriteDownloadedImageRefs(rewriteBlogImageRefs(indexHtml), imageStage.downloadedImageKeys);
      const finalBridgeHtml = rewriteDownloadedImageRefs(rewriteBlogImageRefs(bridgeHtml), imageStage.downloadedImageKeys);

      // Last transform before the bytes hit disk, so it covers steps 1-5 and
      // anything a later step inserts through them. A clean page comes back
      // byte-identical, which keeps the byte-identity contract with the full
      // build intact (the site repo's article byte-identity check).
      const indexClean = sanitizeHtmlDocument(indexHtml);
      reportStrippedControlChars(indexAbs, indexHtml, indexClean);
      fs.writeFileSync(indexAbs, indexClean, 'utf-8');
      const flatClean = sanitizeHtmlDocument(finalBridgeHtml);
      reportStrippedControlChars(flatAbs, finalBridgeHtml, flatClean);
      fs.writeFileSync(flatAbs, flatClean, 'utf-8');
    }
  }

  const htmlByPath = {};
  for (const entry of entries) {
    for (const rel of [...Object.values(entry.paths || {}), ...Object.values(entry.flatPaths || {})]) {
      if (rel && fs.existsSync(path.join(distDir, rel))) htmlByPath[rel] = fs.readFileSync(path.join(distDir, rel), 'utf-8');
    }
  }
  // Un articolo che ricade sull'immagine generica resta fuori dal push solo se
  // online c'è qualcosa da proteggere: una sua pagina con immagine propria, o
  // una risposta che non si è potuta leggere. Un articolo senza pagine online
  // esce subito con l'immagine generica (decisione del proprietario, 07-10-2026).
  const imagePostcondition = await releaseArticlesWithNothingToProtect({
    entries,
    postcondition: filterEntriesByImagePostcondition({ entries, declaredImages, htmlByPath }),
    probe: probeOnlineImage,
  });
  if (imagePostcondition.excludedArticles.length > 0) {
    console.error(
      `[${logPrefix}] image postcondition excluded ${imagePostcondition.excludedArticles.length} article(s) / ` +
        `${imagePostcondition.excludedPages} page(s): ${imagePostcondition.firstExcludedArticleIds.join(', ')}`,
    );
  }
  if (imagePostcondition.releasedArticles.length > 0) {
    console.error(
      `[${logPrefix}] image postcondition released ${imagePostcondition.releasedArticles.length} article(s) with the generic image ` +
        `(no page online to protect): ${imagePostcondition.releasedArticles.slice(0, 10).map((article) => article.articleId).join(', ')}`,
    );
  }
  const aggregatePagesAllowed = imagePostcondition.excludedArticles.length === 0;

  // ── Step 6: article-hub archive pages (issue #4881 Fase 1) ──
  // Re-renders each section's `/tutti/` archive + pagination into the SAME
  // scratch distDir so the newly-published article is immediately LISTED,
  // not just reachable by direct URL — otherwise it stays orphaned (no
  // internal link points at it) until the next full deploy. Uses the SAME
  // renderArticleHubPagesCore the full build's emitSeoHubs calls (see
  // engine/articleHubPagesPlugin.ts, #4881), so hub-page bytes are provably
  // identical to what a full build emits for this section — no second
  // implementation, no copy-pasted rendering chrome.
  //
  // Not postprocessed through steps 2-5 above: those are article-body
  // specific (flat-redirect bridge, contextual links keyed off THIS
  // article's own related-articles picks, hero-image CDN rewrite) and do
  // not apply to an archive listing page (no hero image, no flat bridge).
  //
  // BUT IT MUST RUN BEFORE THE CDN OFFLOAD, and used to run after (issue
  // #5270). The archive HTML carries the same hardcoded `/assets/...`
  // strings the article pages do (articleHubPagesPlugin.ts emits
  // `src="/assets/${entryJs}"` as plain text). The offload below is the ONLY
  // pass that turns those into CDN URLs — and no origin on the serving path
  // hosts `/assets` at all (`https://frontaliereticino.ch/assets/index-entry.js`
  // → 404), so an archive page that misses the rewrite ships with no CSS, no
  // SPA bundle and no AdSense loader.
  //
  // A full build is immune (there the offload runs after the whole build,
  // archive included) and the site repo's own copy of this script was fixed in
  // valerielinc-ops/frontaliere-si-o-no#5271 — so the live archive healed
  // whenever the SITE published and broke again whenever THIS repo did, which
  // is exactly why it looked like a deploy-ordering problem for a day.
  //
  // The previous ordering grouped this under "not postprocessed through steps
  // 2-6". That rationale is right for steps 2-5, which are per-article, and
  // wrong for the offload, which is a whole-dist pass every emitted page
  // needs — archive included.
  // Gli archivi e le pagine aggregate leggono l'intero registro, non il set
  // filtrato appena sopra. Se anche un solo articolo resta trattenuto, lasciare
  // uscire quegli aggregati potrebbe pubblicare un link alla pagina omessa: in
  // quel caso restano online gli aggregati precedenti e questo giro pubblica
  // soltanto le pagine articolo dimostrate sane.
  let hubResult = { written: 0, pathsByLocale: Object.fromEntries(locales.map((locale) => [locale, []])) };
  let extraPaths = [];
  if (aggregatePagesAllowed) {
    const { renderArticleHubPages } = await import('../../engine/articleHubPagesPlugin.ts');
    hubResult = await renderArticleHubPages({
      rootDir: rootDir,
      distDir,
      section: section,
    });

    // The archive lists every article's TITLE, so it carries the same control
    // bytes the article page does — one poisoned title contaminates every page
    // of the /tutti/ chain in all 4 locales, not just its own URL. Steps 2-5
    // deliberately skip these pages (they are article-body transforms); this is
    // not an article-body transform, so it does not skip them. Rewritten only
    // when something actually changed, so a clean archive keeps its bytes.
    for (const locale of locales) {
      for (const rel of hubResult.pathsByLocale[locale] ?? []) {
        const abs = path.join(distDir, rel);
        if (!fs.existsSync(abs)) continue;
        const html = fs.readFileSync(abs, 'utf-8');
        const clean = sanitizeHtmlDocument(html);
        reportStrippedControlChars(abs, html, clean);
        if (clean !== html) fs.writeFileSync(abs, clean, 'utf-8');
      }
    }

    // ── Step 6b: pagine in piu' del chiamante, PRIMA dell'offload ──
    // Il publisher delle sezioni cantonali scrive qui landing e hub tematici:
    // devono esistere in distDir prima del passo 7 per la stessa ragione
    // dell'archivio (#5270) — l'offload e' il solo passaggio che porta sul CDN
    // gli `/assets/` same-origin, e va fatto dopo OGNI pagina resa.
    extraPaths = beforeOffload ? (await beforeOffload({ distDir, entries: imagePostcondition.entries, hubResult })) ?? [] : [];
  } else {
    console.error(`[${logPrefix}] aggregate pages withheld because the image postcondition excluded an article`);
  }

  // ── Step 7: offload-generated-images-cdn.mjs, unmodified, via subprocess ──
  // The script hardcodes distDir = path.resolve(process.cwd(), 'dist'), so we
  // spawn it with cwd = a temp dir containing a `dist` symlink to our real
  // scratch --out dir — the same trick, not a fork of its logic.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-article-fast-'));
  try {
    fs.symlinkSync(distDir, path.join(tmpDir, 'dist'), 'dir');
    const offloadScript = path.join(rootDir, 'scripts', 'offload-generated-images-cdn.mjs');
    const result = spawnSync(process.execPath, [offloadScript], {
      cwd: tmpDir,
      env: { ...process.env, CDN_BASE },
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      console.error(
        `[${logPrefix}] offload-generated-images-cdn.mjs exited ${result.status} — ` +
          'unexpected (the script catches its own errors and always exits 0); dist left as rendered pre-offload',
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ── Step 7b: gli /assets/ appena riscritti sul CDN esistono davvero? ──
  // L'offload riscrive OGNI `/assets/<file>` su ${CDN_BASE} senza guardia di
  // esistenza. Per og/data/images l'ordine del deploy la rende superflua (i
  // byte sono stati caricati prima); per /assets/ no: questo repo non builda
  // né spinge dist/assets, quindi quei riferimenti puntano al bundle
  // dell'ULTIMO deploy del sito. Da #764 il contratto trasporta anche
  // `/assets/partnerize-tag.js`, emesso dal SITO: se non è sul CDN, ogni
  // pagina pubblicata qui lo carica a vuoto — nessuna eccezione, nessun gate
  // rosso, zero tracking affiliato. NON-FATAL e fail-open per costruzione
  // (vedi scripts/lib/cdn-asset-existence.mjs): non si rinuncia a pubblicare
  // un articolo perché manca uno script di tracking, ma il 404 smette di
  // essere invisibile.
  //
  // Assenza di URL CDN NON vuol dire «niente da riscrivere» (#817): l'offload
  // e' non-fatale e su qualunque errore lascia dist intatto ed esce 0, quindi
  // i due mondi producevano la stessa riga rassicurante. La discriminante e'
  // il `/assets/` SAME-ORIGIN superstite, che si raccoglie nella stessa
  // passata.
  try {
    const { collectCdnAssetRefs, hasSameOriginAssetRef, verifyCdnAssetRefs, formatCdnAssetReport, formatOffloadCoverageReport } =
      await import('./cdn-asset-existence.mjs');
    const refs = new Set();
    const sameOriginFiles = [];
    const collectFrom = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) collectFrom(fp);
        else if (e.isFile() && path.extname(fp) === '.html') {
          const html = fs.readFileSync(fp, 'utf-8');
          for (const url of collectCdnAssetRefs(html, CDN_BASE)) refs.add(url);
          if (hasSameOriginAssetRef(html)) sameOriginFiles.push(path.relative(distDir, fp));
        }
      }
    };
    collectFrom(distDir);
    for (const line of formatOffloadCoverageReport({ cdnRefCount: refs.size, sameOriginFiles })) {
      console.log(line);
    }
    if (refs.size > 0) {
      // Il margine si misura qui, con l'orologio vero: verifyCdnAssetRefs usa
      // il proprio `now` iniettabile, e un tetto di cui non si sa quanto avanza
      // non e' un tetto misurato (issue #1219).
      const startedAt = Date.now();
      const results = await verifyCdnAssetRefs({ urls: [...refs] });
      const elapsedMs = Date.now() - startedAt;
      for (const line of formatCdnAssetReport(results, '[cdn-asset-check]', { elapsedMs })) console.log(line);
    }
  } catch (err) {
    console.log(`[cdn-asset-check] verifica saltata (non-fatale): ${(err && err.message) || err}`);
  }

  return {
    written,
    entries: imagePostcondition.entries,
    hubResult,
    extraPaths,
    locales,
    declaredImages,
    downloadedImageKeys: imageStage.downloadedImageKeys,
    imageFetchFailures: imageStage.failures,
    imagePostcondition,
  };
}

function registryPathForSection(rootDir, section) {
  const filename = section === 'svizzera' || section === 'articolisvizzera'
    ? 'swiss-articles-data.ts'
    : section === 'frontaliere' || section === 'articolifrontaliere'
      ? 'blog-articles-data.ts'
      : null;
  return filename ? path.join(rootDir, 'content', filename) : null;
}

async function readDeclaredImages(rootDir, section, ids) {
  const sourcePath = registryPathForSection(rootDir, section);
  if (!sourcePath || !fs.existsSync(sourcePath)) return {};
  const source = fs.readFileSync(sourcePath, 'utf-8');
  const { parseArticleRegistryEntries } = await import('../../engine/shared/articleRegistryEntries.ts');
  const wanted = new Set(ids);
  return Object.fromEntries(
    parseArticleRegistryEntries(source)
      .filter((entry) => wanted.has(entry.id))
      .map((entry) => [entry.id, entry.image]),
  );
}

function removeImageView(viewDir) {
  if (!viewDir || !fs.existsSync(viewDir)) return;
  if (fs.lstatSync(viewDir).isSymbolicLink()) fs.unlinkSync(viewDir);
  else fs.rmSync(viewDir, { recursive: true, force: true });
}

function mirrorImageFiles(sourceDir, destinationDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const item of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, item.name);
    const destination = path.join(destinationDir, item.name);
    if (item.isDirectory()) mirrorImageFiles(source, destination);
    else if (item.isFile()) fs.symlinkSync(source, destination);
  }
}

function imageDownloadPath(reference) {
  const rel = imagePathFromReference(reference);
  return rel ? `/${rel}` : null;
}

export async function fetchDeclaredImage({ imagePath, destination, logPrefix, fetchImpl = globalThis.fetch }) {
  const url = new URL(imagePath, `${CDN_BASE}/`);
  if (url.origin !== new URL(CDN_BASE).origin || url.protocol !== 'https:') throw new Error('origine CDN non autorizzata');
  let lastError = 'nessuna risposta';
  for (let attempt = 1; attempt <= IMAGE_FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal });
      const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!contentType.startsWith('image/')) throw new Error(`content-type non immagine: ${contentType || 'assente'}`);
      const contentLength = Number(response.headers?.get?.('content-length') || 0);
      if (contentLength > MAX_DECLARED_IMAGE_BYTES) throw new Error('immagine oltre 5 MB');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_DECLARED_IMAGE_BYTES) throw new Error('immagine oltre 5 MB');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, buffer);
      return;
    } catch (error) {
      lastError = error?.name === 'AbortError' ? 'timeout 20s' : error?.message || String(error);
      if (attempt < IMAGE_FETCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError);
}

export async function prepareImageView({ rootDir, distDir, ids, declaredImages, logPrefix, fetchImpl = globalThis.fetch, logger = console }) {
  const viewDir = path.join(distDir, 'images');
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontaliere-declared-images-'));
  const downloadedImageKeys = [];
  const failures = [];
  removeImageView(viewDir);
  mirrorImageFiles(path.join(rootDir, 'public', 'images'), viewDir);

  const missing = [];
  for (const articleId of ids) {
    const reference = declaredImages[articleId];
    const rel = imagePathFromReference(reference);
    if (!rel || fs.existsSync(path.join(rootDir, 'public', rel))) continue;
    missing.push({ articleId, rel });
  }

  let cursor = 0;
  const worker = async () => {
    while (cursor < missing.length) {
      const item = missing[cursor++];
      const destination = path.join(downloadDir, item.rel);
      try {
        await fetchDeclaredImage({ imagePath: imageDownloadPath(item.rel), destination, logPrefix, fetchImpl });
        const target = path.join(viewDir, item.rel.replace(/^images[\\/]/, ''));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(destination, target);
        downloadedImageKeys.push(item.rel);
        logger.log(`[${logPrefix}] downloaded declared image from CDN: ${item.rel}`);
      } catch (error) {
        const failure = { articleId: item.articleId, image: item.rel, reason: error?.message || String(error) };
        failures.push(failure);
        logger.error(`[${logPrefix}] declared image unavailable (${item.articleId}, ${item.rel}): ${failure.reason}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_FETCH_CONCURRENCY, Math.max(1, missing.length)) }, worker));
  return { viewDir, downloadDir, downloadedImageKeys, failures };
}

function imagePathFromReference(reference) {
  const raw = String(reference ?? '').trim();
  if (!raw) return null;
  let pathname = raw;
  try {
    if (/^https?:\/\//i.test(raw)) pathname = new URL(raw).pathname;
  } catch {
    return null;
  }
  const heroImgRel = pathname.split(/[?#]/, 1)[0].replace(/^\/+/, '');
  if (!heroImgRel.startsWith('images/') || heroImgRel.includes('..')) return null;
  return heroImgRel;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A declared image downloaded into the temporary render view already exists
 * on the CDN and is deliberately not uploaded again. Rewrite only those exact
 * same-origin references so removing the view cannot leave the published HTML
 * pointing at an asset absent from the shard.
 */
export function rewriteDownloadedImageRefs(html, downloadedImageKeys = []) {
  let rewritten = String(html ?? '');
  for (const key of new Set(downloadedImageKeys)) {
    const imageKey = imagePathFromReference(key);
    if (!imageKey) continue;
    const escapedKey = escapeRegExp(imageKey);
    const boundary = '(?![\\w./%-])';
    const replacement = `${CDN_BASE}/${imageKey}`;
    rewritten = rewritten
      .replace(new RegExp(`${escapeRegExp(SITE_ORIGIN)}/${escapedKey}${boundary}`, 'g'), replacement)
      .replace(new RegExp(`(?<![\\w.@])/${escapedKey}${boundary}`, 'g'), replacement);
  }
  return rewritten;
}

function imageReferencesFromHtml(html) {
  const refs = [];
  const attribute = /\b(?:src|srcset)=["']([^"']+)["']/gi;
  for (const match of String(html ?? '').matchAll(attribute)) {
    // srcset has comma-separated candidates; the first token of each one is
    // the actual image URL. `src` simply produces one candidate.
    for (const candidate of match[1].split(',')) {
      const reference = imagePathFromReference(candidate.trim().split(/\s+/, 1)[0]);
      if (reference) refs.push(reference);
    }
  }
  return refs;
}

function addHeroCdnUpload({ rootDir, imagePath, cdnUploadsByKey, missing, logPrefix, downloadedImageKeys = new Set() }) {
  const heroImgRel = imagePathFromReference(imagePath);
  if (!heroImgRel) return;
  const heroDir = path.dirname(heroImgRel);
  const heroExt = path.extname(heroImgRel) || '.webp';
  const heroBase = path.basename(heroImgRel, heroExt);
  const heroLocal = path.join('public', heroDir, `${heroBase}${heroExt}`);
  const thumbLocal = path.join('public', heroDir, 'thumbnails', `${heroBase}-480w.webp`);
  const heroKey = path.join(heroDir, `${heroBase}${heroExt}`);
  const thumbKey = path.join(heroDir, 'thumbnails', `${heroBase}-480w.webp`);
  if (downloadedImageKeys.has(heroKey)) {
    // renderSectionArticlePipeline already rewrote this exact key to CDN_BASE
    // in every emitted article page before the temporary image view vanished.
    console.log(`[${logPrefix}] skipping CDN upload for downloaded image ${heroKey}`);
  } else if (fs.existsSync(path.join(rootDir, heroLocal))) {
    cdnUploadsByKey.set(heroKey, {
      local: heroLocal,
      key: heroKey,
    });
  } else {
    console.error(`[${logPrefix}] resolved hero "${heroLocal}" does not exist on disk — omitting from cdnUploads`);
    missing?.push({ kind: 'hero', local: heroLocal, key: heroKey });
  }
  if (downloadedImageKeys.has(thumbKey) || downloadedImageKeys.has(heroKey)) {
    // The hero came FROM the CDN: its thumbnail lives there too, and its
    // absence from this checkout is expected, not a missing asset.
    console.log(`[${logPrefix}] skipping CDN upload for the thumbnail of downloaded image ${heroKey}`);
  } else if (fs.existsSync(path.join(rootDir, thumbLocal))) {
    cdnUploadsByKey.set(thumbKey, {
      local: thumbLocal,
      key: thumbKey,
    });
  } else {
    console.error(`[${logPrefix}] expected thumbnail "${thumbLocal}" does not exist on disk — omitting from cdnUploads`);
  }
}

/**
 * I file immagine (hero + thumbnail 480w) da caricare sul CDN, come
 * `[{ local, key }]` senza duplicati. Oltre agli articoli resi, `htmlPages`
 * permette al publisher cantonale di includere gli hero di TUTTE le card che
 * la landing rende dal registry: un refresh parziale non puo' pubblicare una
 * landing che punta a un asset non confermato.
 */
export function heroCdnUploads({ rootDir, entries = [], htmlPages = [], missing, logPrefix = 'article-render-pipeline', downloadedImageKeys = [] }) {
  // Derive every upload from the ACTUAL resolved directory — NOT a hardcoded
  // `images/blog/`. Shared stock heroes live under `images/places/` and use
  // the same thumbnail convention. DEFAULT_IMG (`/og-image.png`) is outside
  // `images/` and is deliberately not listed here.
  const cdnUploadsByKey = new Map();
  const downloaded = new Set(downloadedImageKeys);
  for (const entry of entries) addHeroCdnUpload({ rootDir, imagePath: entry?.img, cdnUploadsByKey, missing, logPrefix, downloadedImageKeys: downloaded });
  for (const page of htmlPages) {
    for (const imagePath of imageReferencesFromHtml(page?.html)) {
      addHeroCdnUpload({ rootDir, imagePath, cdnUploadsByKey, missing, logPrefix, downloadedImageKeys: downloaded });
    }
  }
  return [...cdnUploadsByKey.values()];
}

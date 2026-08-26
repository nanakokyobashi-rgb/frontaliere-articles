#!/usr/bin/env node
/**
 * Register / refresh the EVERGREEN "best/worst dogane" wait-time ranking
 * blog article (chained on the border-wait feature, F8).
 *
 * One stable id (`classifica-dogane-ticino`) is registered ONCE into the blog
 * system (slug map + router union, ARTICLES registry, i18n meta, body files,
 * blog SEO/JSON-LD, sitemap, RSS) by reusing create-article.mjs's registrar —
 * no AI, no copy-paste of registration logic (AGENTS.md §6). On every later
 * run only the body files are rewritten with the current 7-day ranking (the
 * registrar is append-only), plus an updatedAt bump — so the repo never
 * floods with one new article per week (same pattern as issue #2963's
 * weekend-events digest). This script also writes a compact
 * `public/data/border-wait-ranking.json` snapshot consumed by the live
 * ranking chart injected into the article (InlineBorderWaitRanking) — under
 * `public/`, not repo-root `data/`, because only `public/` is copied into
 * the Vite build output (same placement as
 * `public/data/switzerland-unemployment-rate.json`); the component fetches
 * it same-origin at `/data/border-wait-ranking.json`.
 *
 * NOTE: this script imports `build-plugins/borderWaitData.ts` (via the
 * content builder) so it MUST run under `tsx`, not plain `node` — same
 * constraint as scripts/check-border-data-health.mjs.
 *
 * Usage:
 *   npx tsx scripts/generate-border-wait-ranking-article.mjs            # register or refresh
 *   DRY_RUN=1 npx tsx scripts/generate-border-wait-ranking-article.mjs  # plan only, no writes
 *   TODAY_ISO=2027-01-01 npx tsx scripts/...                            # pin "today" (tests/CI)
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { rankingFromStats, trendFromStats, computeFunFacts, computeWeekWindow, computeMovers } from './lib/border-wait-ranking.mjs';
import { buildBorderWaitRankingArticle } from './lib/border-wait-ranking-content.mjs';
import { registerArticleFiles, checkArticleIdExists, buildBodyFile } from './create-article.mjs';
import { bumpUpdatedAt, bumpDateModified, bumpSitemapLastmod } from './lib/evergreen-article-refresh.mjs';
import { isTicinoCrossing } from '../build-plugins/borderWaitData.ts';
import { corpusPath } from './lib/corpus-paths.mjs';
import { sanitizeText } from '../../scripts/lib/sanitize-control-chars.mjs';
import { reportStrippedControlChars } from './lib/control-char-write-report.mjs';
import { sanitizePromptPlaceholders } from './lib/prompt-placeholder-guard.mjs';

// Scrittura ATOMICA del corpus: temp accanto al target + renameSync.
// Questi file riscrivono un `content/*.ts` GIA' ESISTENTE (rerun idempotente
// same-day) sotto `generate-border-wait-ranking-weekly.yml`, che ha `timeout-minutes` e quindi uccide con
// SIGKILL: un `writeFileSync` diretto sul target puo' lasciarlo troncato a
// meta' scrittura. `renameSync` e' un singolo syscall POSIX, atomico sullo
// stesso filesystem — e il temp sta accanto al target proprio perche' il
// rename non attraversi mai un confine di filesystem. Stesso pattern di
// `writeCorpusFile()` in lib/evergreen-article-refresh.mjs e lib/
// article-meta-refresh.mjs, che questa PR ha gia' convertito: qui era
// rimasto scoperto il call-site che li CHIAMA.
let writeTmpSeq = 0;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `../..`: the transport moved this from `scripts/` to `generator/scripts/`,
// so one level up is now the generator directory, not the repo root.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOCALES = ['it', 'en', 'de', 'fr'];
// REWIRE (#4974 item 3): the 1.7 GB history stays in the site repo; this reads
// the ~32 KB aggregate refresh-border-wait-window.mjs fetches from it.
const WINDOW_PATH = path.join(__dirname, '..', 'data', 'border-wait-ranking-window.json');
const RANKING_JSON_PATH = path.join(REPO_ROOT, 'public', 'data', 'border-wait-ranking.json');

// Evergreen metadata — registered once, NEVER refreshed (no date/count inside).
const STATIC_META = {
  category: 'novita',
  image: 'mendrisio.webp', // → /images/places/mendrisio.webp (exists in catalog, dogana/confine keywords)
  hasCalculator: false,
  author: { slug: 'redazione', name: 'Redazione Frontaliere Ticino' },
  seo: {
    title: 'Classifica delle dogane in Ticino: le migliori e le peggiori',
    description:
      "Ogni dogana ticinese classificata per tempo medio di attesa, con trend settimanale e quanti minuti si perdono (o guadagnano) scegliendo un valico piuttosto che un altro.",
    keywords:
      'dogane ticino, tempi attesa dogana, classifica dogane, traffico confine ticino, valico ticino, coda dogana',
    ogTitle: 'Classifica delle dogane in Ticino',
    ogDescription:
      "Le dogane ticinesi classificate per tempo di attesa: le più veloci, le più lente, e quanti minuti di vita si perdono a sceglierne una piuttosto che un'altra.",
    headline: 'Classifica delle dogane in Ticino: le migliori e le peggiori per tempo di attesa',
    breadcrumbName: 'Classifica dogane',
  },
};

/**
 * Load the aggregate window fetched by refresh-border-wait-window.mjs.
 *
 * REWIRE (issue #4974 item 3). In main this script read
 * `data/border-wait-history/*.json` directly — 90 daily files, 1.7 GB, site
 * telemetry that stays there. Here the same numbers arrive as the ~32 KB
 * aggregate main publishes, and the identical pure functions
 * (`rankingFromStats` / `trendFromStats`) run over them.
 *
 * Missing is fatal, deliberately: this is the article's data, not an overlay.
 * Generating the ranking article without a ranking is wrong output on an
 * evergreen URL that already ranks, not degraded output.
 */
export function loadWindow(windowPath = WINDOW_PATH) {
  if (!existsSync(windowPath)) {
    throw new Error(
      `border-wait window not found at ${windowPath} — run ` +
        `generator/scripts/refresh-border-wait-window.mjs first`,
    );
  }
  const payload = JSON.parse(readFileSync(windowPath, 'utf-8'));
  if (!payload?.current?.perCrossing) {
    throw new Error(`${windowPath} has no current.perCrossing — refusing`);
  }
  return payload;
}

/**
 * Compute the current ranking/trend/fun-facts/week-window/movers snapshot for
 * todayIso, from the fetched aggregate window.
 */
export function computeSnapshot(todayIso, windowPayload = loadWindow()) {
  // This snapshot feeds the evergreen "Classifica delle dogane in Ticino"
  // article + its embedded live chart (buildRankingJson below) — both
  // Ticino-only by identity. rankingFromStats/trendFromStats are generic
  // aggregation over ALL registered crossings (now 134, incl. the 108
  // non-Ticino Germany/Austria/Liechtenstein/France-corridor ones from
  // #4889), so scope to Ticino here, once, before funFacts/movers derive
  // from it — otherwise a foreign crossing could surface as this
  // Ticino-only article's best/worst/biggest mover.
  const rankingAll = rankingFromStats(windowPayload.current.perCrossing);
  const ranking = rankingAll
    .filter((r) => isTicinoCrossing(r.slug))
    .map((r, idx) => ({ ...r, rank: idx + 1 }));
  const trendAll = trendFromStats(
    windowPayload.current.perCrossing,
    windowPayload.previous?.perCrossing ?? {},
  );
  const trend = Object.fromEntries(Object.entries(trendAll).filter(([slug]) => isTicinoCrossing(slug)));
  const funFacts = computeFunFacts(ranking);
  const { weekStart, weekEnd } = computeWeekWindow(todayIso, 7);
  const movers = computeMovers(trend);
  return { ranking, trend, funFacts, weekStart, weekEnd, movers };
}

/** Build the full registration `data` object from the current ranking snapshot. */
export function buildData(todayIso, windowPayload = loadWindow()) {
  const { ranking, trend, funFacts, weekStart, weekEnd, movers } = computeSnapshot(todayIso, windowPayload);
  const article = buildBorderWaitRankingArticle({ ranking, trend, funFacts, weekStart, weekEnd, movers, todayIso });
  return {
    id: article.id,
    ...STATIC_META,
    // Niente `inspectSlugForPromptPlaceholder` qui, e non e' una dimenticanza
    // (issue #382 item 4): `article.slugs` e' `RANKING_ARTICLE_SLUGS`, quattro
    // stringhe letterali nel sorgente di `lib/border-wait-ranking-content.mjs`.
    // Lo slug guard esiste perche' in `create-article.mjs` lo slug lo propone
    // il MODELLO, e un segnaposto del prompt puo' finirci dentro; qui non c'e'
    // nessun modello nella catena — `wiring — i tre produttori senza slug
    // guard` in `generator/tests/prompt-placeholder-guard.test.mjs` lo
    // verifica, e diventa rosso il giorno in cui uno arriva.
    slugs: article.slugs,
    imageAlt: article.imageAlt,
    content: article.content,
    _rankedCount: article._rankedCount,
  };
}

/** Rewrite only the 4 body files (idempotent refresh; registration is append-only). */
export function refreshBodyFiles(data, repoRoot = REPO_ROOT, log = console.log) {
  // Guard in processo, non solo nello step di workflow (follow-up #315 a #309):
  // i percorsi di scrittura sono DUE — `registerArticleFiles()` alla prima
  // registrazione, e questo `writeFileSync` a ogni refresh successivo. Il guard
  // copriva solo il primo. Fail-closed: ripara il riparabile, lancia sul resto.
  sanitizePromptPlaceholders(data);
  for (const locale of LOCALES) {
    const dir = path.join(repoRoot, corpusPath('services/locales/blog-body'), locale);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${data.id}.ts`);
    const body = buildBodyFile(data, locale);
    const clean = sanitizeText(body);
    // Non basta togliere il byte: toglierlo distrugge il MARKER che rende
    // esatta una riparazione futura (issue #95). Si registra prima, con il
    // contesto che conserva la coppia (byte, carattere seguente).
    reportStrippedControlChars(file, body, clean);
    const tmp = `${file}.${process.pid}.${writeTmpSeq++}.tmp`;
    try {
      writeFileSync(tmp, clean);
      renameSync(tmp, file);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      throw err;
    }
    log(`  ✅ ${path.relative(repoRoot, file)}`);
  }
}

/**
 * Compact per-crossing ranking snapshot for the live chart component
 * (services/borderWaitRankingService.ts → InlineBorderWaitRanking). Kept
 * separate from the (much larger) article body payload.
 */
export function buildRankingJson({ ranking, trend, funFacts, todayIso, weekStart, weekEnd, movers }) {
  return {
    updatedAt: todayIso,
    windowDays: 7,
    weekStart,
    weekEnd,
    ranking: ranking.map((r) => ({
      slug: r.slug,
      rank: r.rank,
      avgMinutes: Math.round(r.avgMinutes * 10) / 10,
      totalSamples: r.totalSamples,
      trend: trend[r.slug]?.direction || 'flat',
      deltaMinutes: trend[r.slug]?.deltaMinutes != null ? Math.round(trend[r.slug].deltaMinutes * 10) / 10 : null,
    })),
    funFacts,
    movers,
  };
}

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
  const todayIso = process.env.TODAY_ISO || new Date().toISOString().slice(0, 10);
  // Loaded once and threaded through, so the two calls cannot disagree if the
  // cache is refreshed mid-run.
  const windowPayload = loadWindow();
  const { ranking, trend, funFacts, weekStart, weekEnd, movers } = computeSnapshot(todayIso, windowPayload);
  const data = buildData(todayIso, windowPayload);
  const exists = checkArticleIdExists(data.id);

  console.log(
    `🛂 border-wait ranking article — id=${data.id} ranked=${data._rankedCount} exists=${exists} dry=${dryRun}`,
  );

  // The evergreen article already ranks under this URL. Fewer than 2 known
  // Ticino crossings means buildBorderWaitRankingArticle() falls back to the
  // `noData` stub copy (content.mjs: `hasData = known.length >= 2`) — a run
  // that would silently REPLACE a correct ranking with a content-free page
  // instead of failing loud. This is data the run itself computed, not an
  // upstream fetch failure (that's already fatal in loadWindow()), so it must
  // stop here rather than let registerArticleFiles/refreshBodyFiles publish it.
  if (data._rankedCount < 2 && !dryRun) {
    throw new Error(
      `only ${data._rankedCount} ranked Ticino crossing(s) — refusing to publish the noData stub over the evergreen ranking article`,
    );
  }

  if (dryRun) {
    console.log('DRY_RUN — no files written.');
    console.log('  IT title :', data.content.it.title);
    console.log('  IT body1 :', data.content.it.body1.slice(0, 200).replace(/\n/g, ' '));
    return;
  }

  mkdirSync(path.dirname(RANKING_JSON_PATH), { recursive: true });
  // Atomico come le scritture del body, e per una ragione PIU' forte: questo
  // JSON viene ripubblicato verbatim in `dist/api/border-wait-ranking.json` da
  // scripts/build-api.mjs, che ne fa `JSON.parse` senza catch. Un SIGKILL da
  // `timeout-minutes` a meta' di questa scrittura lascia un JSON troncato, e
  // il parse che lancia interrompe l'INTERO build-api: non solo la ranking
  // chart, ma manifest, articles.json, feed e meta restano fermi alla versione
  // precedente finche' qualcuno non ripara il file a mano.
  const rankingTmp = `${RANKING_JSON_PATH}.${process.pid}.${writeTmpSeq++}.tmp`;
  try {
    writeFileSync(
      rankingTmp,
      JSON.stringify(buildRankingJson({ ranking, trend, funFacts, todayIso, weekStart, weekEnd, movers }), null, 2) + '\n',
    );
    renameSync(rankingTmp, RANKING_JSON_PATH);
  } catch (err) {
    try { unlinkSync(rankingTmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
  console.log(`  ✅ ${path.relative(REPO_ROOT, RANKING_JSON_PATH)}`);

  if (!exists) {
    console.log('📂 first run — registering the evergreen article across the blog system…');
    await registerArticleFiles(data, { skipNews: true }); // evergreen → not a Google News item
    console.log('✅ registered.');
    return;
  }

  // Refresh only the body files + updatedAt. RSS feeds read the blog SEO file
  // (evergreen headline/description), NOT the body, so they don't need to be
  // regenerated on a body refresh — that would churn ~4 MB of feed files for
  // no content change (same rationale as generate-events-digest-article.mjs).
  console.log('♻️  refreshing body files (article already registered)…');
  refreshBodyFiles(data);
  if (!bumpUpdatedAt(data.id, todayIso)) console.warn('⚠️  updatedAt not bumped (entry not matched).');
  if (!bumpDateModified(data.id, `${todayIso}T00:00:00+02:00`)) {
    console.warn('⚠️  dateModified not bumped (entry/regex not matched) — freshness signal may be stale.');
  }
  if (!bumpSitemapLastmod(data.slugs.it, todayIso)) {
    console.warn('⚠️  sitemap-blog lastmod not bumped (url block not matched) — freshness signal may be stale.');
  }
  console.log('✅ refreshed.');
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((e) => {
    console.error('❌', e.message);
    process.exit(1);
  });
}

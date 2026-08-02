/**
 * Google News topic whitelist — VENDORED from frontaliere-si-o-no's
 * `data/news-sitemap-whitelist.ts` (issue #4974 item 3, §5.3 REWIRE set).
 *
 * WHY A COPY AND NOT A LIVE CALL
 *
 * §5.3 is explicit: this is "vendored into nanako (as code, not a live call —
 * it changes rarely and a live dependency on main from nanako's generation path
 * would invert the intended one-way architecture)". Main pulls from here; the
 * generation path must never reach back the other way. The list is a handful of
 * editorial keywords that move a few times a year, so a copy costs little and a
 * network dependency in the middle of article generation would cost a lot.
 *
 * WHY `.mjs` AND NOT A PARSE
 *
 * Main's `create-article.mjs` loaded this by regex-parsing the `.ts` file at
 * startup, to avoid needing a TS loader for one string array. Transported here
 * that parse silently returned `[]` — the file it looks for does not exist in
 * this repo — and `isArticleEligibleForNewsSitemap()` treats an empty list as
 * allow-all. Every article would have entered the news sitemap, defeating the
 * topical-authority filter with no error and no log. Real code cannot fail that
 * way: if this module is missing, the import throws.
 *
 * KEEPING IT IN SYNC
 *
 * Tokens below are byte-identical to main's, extracted mechanically rather than
 * retyped, comments and grouping included, so a diff between the two files is
 * readable. Main is the editorial owner: change it there first, then mirror.
 * `generator/tests/news-sitemap-whitelist.test.mjs` pins the token count and a
 * sample of the semantics, so an accidental edit here fails loudly.
 *
 * Filtered-out articles stay in `sitemap-blog.xml` and remain reachable — this
 * only reduces noise in the NEWS sitemap. Never noindex, never delete HTML.
 */

/** Case-insensitive substring tokens, matched against slug + title + section + tags + keywords. */
export const NEWS_SITEMAP_WHITELIST = Object.freeze([
  // 1. Fisco / tasse / dichiarazione / accordo
  'fisco',
  'fiscale',
  'tasse',
  'tassa',
  '730',
  'dichiarazione',
  'irpef',
  'nuovo-accordo-2026',
  'nuovo accordo',
  'accordo-fiscale',
  'imposta-fonte',
  'imposta alla fonte',
  'valore-locativo',
  'valore locativo',
  'perequazione',
  'ristorni',

  // 2. AVS / LPP / pensione / previdenza
  'avs',
  'lpp',
  'pensione',
  'pensioni',
  'previdenza',
  'pilastro-3a',
  'terzo pilastro',

  // 3. LAMal / assicurazione malattia / cassa malati / tassa salute
  'lamal',
  'assicurazione-malattia',
  'assicurazione malattia',
  'cassa-malati',
  'cassa malati',
  'cmi',
  'tassa-salute',
  'tassa salute',

  // 4. Dogana / frontiera / permit / lavoro frontaliere / salari
  // NOTE: do NOT add standalone "frontaliere/frontalieri" — they appear in
  // virtually every Ticino-news slug and would defeat the filter. The compound
  // tokens below (lavoro-frontaliere, parita-frontalieri, ristorni-frontalieri)
  // are intentional: they capture genuine cross-border-worker stories.
  'dogana',
  'frontiera',
  'varco',
  'permit-g',
  'permit g',
  'permesso g',
  'permit-b',
  'permit b',
  'permesso b',
  'lavoro-frontaliere',
  'lavoro frontaliere',
  'parita-frontalieri',
  'parita frontalieri',
  'ristorni-frontalieri',
  'ristorni frontalieri',
  'salari',
  'salario',
  'stipendi',
  'stipendio',
  'contratto',
  'dumping-salariale',
  'dumping salariale',
  'frontalieri-ticino',
  'frontalieri del ticino',
  'frontaliere ticino',
  'lavoratori-frontalieri',
  'lavoratori frontalieri',
  'disoccupazione',
  'occupazione-ticino',
  'occupazione ticino',
  'mercato-lavoro',
  'mercato del lavoro',

  // 5. Cambio valuta / CHF-EUR / bonifico / tasso
  'cambio-valuta',
  'cambio valuta',
  'chf-eur',
  'chf eur',
  'franco-svizzero',
  'franco svizzero',
  'franco forte',
  'bonifico',
  'tasso',
  'tassi-bce',
  'tassi bce',
  'inflazione',
  'bce-tassi',
  'bce tassi',

  // 6. Trasporti frontaliere / treno / auto / traffico / webcam
  // NOTE: "auto" alone is too noisy (matches "automatic", "autorita", etc.).
  // Use compound tokens that name the frontaliere transport context.
  'trasporti-frontaliere',
  'trasporti frontaliere',
  'treno',
  'tilo',
  'traffico',
  'webcam-dogana',
  'webcam dogana',
  'autisti-bus',
  'autisti bus',
  'a2-melide',
  'a2 melide',
  'a2-chiasso',
  'a2 chiasso',
  'pendolarismo',
  'autostrada-a2',
  'autostrada a2',
  'ffs-ticino',
  'ffs ticino',
  'treni-svizzeri',
  'treni svizzeri',
  'ferrovia-ticino',
]);

/** Google News window (per spec, articles older than ~2 days are dropped by Google). */
export const NEWS_SITEMAP_WINDOW_HOURS = 48;

function toLower(value) {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase();
}

/**
 * True iff the article matches at least one whitelist token AND was published
 * within the last {@link NEWS_SITEMAP_WINDOW_HOURS} hours. Mirrors
 * `isArticleNewsEligible` in main's news-sitemap-whitelist.ts, including the
 * future-dated-is-malformed rule.
 *
 * @param {{slug?:string,title?:string,articleSection?:string,tags?:string[],keywords?:string,publishedAt?:string|Date}} article
 * @param {number} [now]
 */
export function isArticleNewsEligible(article, now = Date.now()) {
  if (article.publishedAt !== undefined) {
    const ts =
      article.publishedAt instanceof Date
        ? article.publishedAt.getTime()
        : new Date(article.publishedAt).getTime();
    if (Number.isNaN(ts)) return false;
    const ageMs = now - ts;
    if (ageMs < 0) return false; // future-dated = malformed, drop
    if (ageMs > NEWS_SITEMAP_WINDOW_HOURS * 60 * 60 * 1000) return false;
  }

  const haystack = [
    toLower(article.slug),
    toLower(article.title),
    toLower(article.articleSection),
    toLower(article.keywords),
    ...(article.tags ?? []).map(toLower),
  ].join('  ');
  return NEWS_SITEMAP_WHITELIST.some((t) => haystack.includes(t.toLowerCase()));
}

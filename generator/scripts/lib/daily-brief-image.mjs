/**
 * Hero-image generation for the daily "Bollettino del Frontaliere" edition.
 *
 * Discover's requirement is a UNIQUE image ≥1200px wide per edition — a shared
 * catalog photo (the evergreen digests' `/images/places/…` route) does not
 * qualify. So the hero is generated from the day's numbers: an SVG stat card
 * rasterized to 1200×675 webp (the site's og:image geometry, same as
 * create-article.mjs's optimizeImageToWebp target).
 *
 * Split in two on the dry-run-entrypoints rule: `buildDailyBriefSvg` is pure
 * string work (unit-testable, no deps), while `renderDailyBriefImage` imports
 * sharp DYNAMICALLY — same pattern as optimizeImageToWebp — because this repo
 * has no node_modules locally; sharp exists only where `npm ci` ran (CI) or a
 * NODE_PATH is provided. A static import would kill every `node --test` run.
 *
 * No emoji in the SVG: CI runners rasterize text with fontconfig defaults
 * (DejaVu on ubuntu) and emoji become tofu boxes. Labels are plain text.
 */

const WIDTH = 1200;
const HEIGHT = 675;

const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const IMG_T = {
  it: {
    brand: 'BOLLETTINO DEL FRONTALIERE',
    site: 'frontaliereticino.ch',
    tagline: 'I numeri del giorno, dal nostro monitoraggio',
    bw: 'VALICHI — ATTESA MASSIMA',
    bwNone: 'senza coda',
    fuel: 'BENZINA — MINIMO ITALIA',
    fx: 'CAMBIO — 1 CHF IN EUR',
    jobs: 'LAVORO — NUOVI ANNUNCI IERI',
    na: 'dato non disponibile',
    min: 'min',
  },
  en: {
    brand: 'CROSS-BORDER DAILY BRIEF',
    site: 'frontaliereticino.ch',
    tagline: "The day's numbers, from our monitoring",
    bw: 'BORDER — LONGEST WAIT',
    bwNone: 'no queue',
    fuel: 'FUEL — LOWEST IN ITALY',
    fx: 'EXCHANGE — 1 CHF IN EUR',
    jobs: 'JOBS — NEW LISTINGS YESTERDAY',
    na: 'no data',
    min: 'min',
  },
  de: {
    brand: 'GRENZGÄNGER-TAGESBULLETIN',
    site: 'frontaliereticino.ch',
    tagline: 'Die Zahlen des Tages, aus eigener Messung',
    bw: 'GRENZE — LÄNGSTE WARTEZEIT',
    bwNone: 'keine Warteschlange',
    fuel: 'BENZIN — TIEFSTPREIS ITALIEN',
    fx: 'WECHSELKURS — 1 CHF IN EUR',
    jobs: 'ARBEIT — NEUE STELLEN GESTERN',
    na: 'keine Daten',
    min: 'Min.',
  },
  fr: {
    brand: 'BULLETIN DU FRONTALIER',
    site: 'frontaliereticino.ch',
    tagline: 'Les chiffres du jour, de notre suivi',
    bw: 'DOUANES — ATTENTE MAXIMALE',
    bwNone: 'aucune file',
    fuel: 'ESSENCE — MINIMUM ITALIE',
    fx: 'CHANGE — 1 CHF EN EUR',
    jobs: 'EMPLOI — NOUVELLES OFFRES HIER',
    na: 'donnée indisponible',
    min: 'min',
  },
};

function fmtNum(locale, n, digits = 0) {
  if (!Number.isFinite(n)) return null;
  const tag = { it: 'it-CH', en: 'en-CH', de: 'de-CH', fr: 'fr-CH' }[locale] || 'it-CH';
  return n.toLocaleString(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** One stat tile. `big` is the number line, `small` the context line. */
function tile(x, y, w, h, label, big, small, accent) {
  return `
  <g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#ffffff" fill-opacity="0.06" stroke="#ffffff" stroke-opacity="0.14"/>
    <rect x="${x}" y="${y}" width="6" height="${h}" rx="3" fill="${accent}"/>
    <text x="${x + 28}" y="${y + 44}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="21" letter-spacing="1.5" fill="#9fb3c8">${esc(label)}</text>
    <text x="${x + 28}" y="${y + 116}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="60" font-weight="bold" fill="#ffffff">${esc(big)}</text>
    <text x="${x + 28}" y="${y + 158}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="24" fill="#c9d6e2">${esc(small)}</text>
  </g>`;
}

/**
 * Build the 1200×675 SVG stat card from a daily-brief snapshot.
 * Degraded blocks render as an explicit "no data" tile — the image never lies
 * by omission about what the edition actually contains.
 */
export function buildDailyBriefSvg(brief, { locale = 'it' } = {}) {
  const t = IMG_T[locale] || IMG_T.it;
  const { blocks = {}, dateIso = '' } = brief || {};

  const bw = blocks.borderWait;
  const bwBig = bw?.available ? `${fmtNum(locale, bw.worst.waitMinutes)} ${t.min}` : '—';
  const bwSmall = bw?.available
    ? bw.worst.waitMinutes > 0 ? bw.worst.name : `${bw.worst.name} — ${t.bwNone}`
    : t.na;

  const fuel = blocks.fuel;
  const fuelTop = fuel?.available ? fuel.cheapestItaly[0] : null;
  const fuelBig = fuelTop ? `${fmtNum(locale, fuelTop.minPriceEur, 3)} €/L` : '—';
  const fuelSmall = fuelTop ? `${fuelTop.municipality} (${fuelTop.province})` : t.na;

  const fx = blocks.exchange;
  const fxBig = fx?.available ? `${fmtNum(locale, fx.rate, 4)} €` : '—';
  const fxDelta = fx?.available && Number.isFinite(fx.delta1d)
    ? `${fx.delta1d > 0 ? '+' : ''}${fmtNum(locale, fx.delta1d, 4)} (1d)`
    : t.na;

  const jobs = blocks.jobs;
  const jobsBig = jobs?.available && Number.isFinite(jobs.yesterdayAdded) ? `+${fmtNum(locale, jobs.yesterdayAdded)}` : '—';
  const jobsSmall = jobs?.available ? `${fmtNum(locale, jobs.activeJobs)} tot.` : t.na;

  const M = 48; // outer margin
  const GAP = 24;
  const tileW = (WIDTH - M * 2 - GAP) / 2;
  const tileH = 180;
  const topY = 210;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b2239"/>
      <stop offset="1" stop-color="#123a5c"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <text x="${M}" y="86" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="44" font-weight="bold" letter-spacing="2" fill="#ffffff">${esc(t.brand)}</text>
  <text x="${M}" y="132" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="30" fill="#7fd1ae">${esc(dateIso)}</text>
  <text x="${WIDTH - M}" y="132" text-anchor="end" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="26" fill="#9fb3c8">${esc(t.tagline)}</text>
  ${tile(M, topY, tileW, tileH, t.bw, bwBig, bwSmall, '#e4572e')}
  ${tile(M + tileW + GAP, topY, tileW, tileH, t.fuel, fuelBig, fuelSmall, '#f4a259')}
  ${tile(M, topY + tileH + GAP, tileW, tileH, t.fx, fxBig, fxDelta, '#7fd1ae')}
  ${tile(M + tileW + GAP, topY + tileH + GAP, tileW, tileH, t.jobs, jobsBig, jobsSmall, '#5aa9e6')}
  <text x="${M}" y="${HEIGHT - 32}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="26" fill="#9fb3c8">${esc(t.site)}</text>
</svg>`;
}

/**
 * Rasterize the SVG to a 1200×675 webp hero plus a 480w thumbnail (the
 * `<slug>-480w.webp` convention fast-publish uploads to R2). Dynamic import:
 * sharp only exists where dependencies are installed.
 * @returns {Promise<{ heroBytes: number, thumbBytes: number }>}
 */
export async function renderDailyBriefImage(svg, heroPath, thumbPath) {
  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch (err) {
    throw new Error(
      `sharp is not installed (${err.message}) — the daily edition REQUIRES a unique generated hero; run under npm ci (CI) or provide NODE_PATH`,
    );
  }
  const input = Buffer.from(svg);
  const hero = await sharp(input, { density: 96 })
    .resize(WIDTH, HEIGHT, { fit: 'fill' })
    .webp({ quality: 82, effort: 6 })
    .toBuffer();
  const thumb = await sharp(hero).resize({ width: 480 }).webp({ quality: 68, effort: 6 }).toBuffer();
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(heroPath), { recursive: true });
  mkdirSync(dirname(thumbPath), { recursive: true });
  writeFileSync(heroPath, hero);
  writeFileSync(thumbPath, thumb);
  return { heroBytes: hero.length, thumbBytes: thumb.length };
}

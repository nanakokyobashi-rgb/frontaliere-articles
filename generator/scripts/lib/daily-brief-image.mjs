/**
 * Hero-image helpers for the daily "Bollettino del Frontaliere" edition.
 * The production cover comes from the governed article-hero engine. The old
 * SVG card exports below remain only so historical assets can be audited and
 * reproduced; the daily article producer no longer calls them.
 */

import '../../../host/cantonSectionsBootstrap.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {
  BLOG_IMAGE_HARD_MAX_BYTES,
  BLOG_IMAGE_HEIGHT,
  BLOG_IMAGE_QUALITY_PASSES,
  BLOG_IMAGE_TARGET_MAX_BYTES,
  BLOG_IMAGE_WIDTH,
} from './blog-image-policy.mjs';
import { buildDeterministicCardRecord } from './deterministic-card-provenance.mjs';
import { appendGeneratedImageRecord, sha256File } from './blog-image-registry.mjs';
import { articleHeroImagePath, articleImageAssetId } from './article-cover-identity.mjs';
import { LICENSED_PHOTO_KIND } from '../../../engine/shared/generatedImageRegistry.mjs';
import { imageCreditRecordFromGeneratedImageRecord } from '../../../engine/shared/imageCredits.mjs';
import { GENERATED_COVER_ALT_BY_LOCALE } from './generated-cover-alt.mjs';

const WIDTH = BLOG_IMAGE_WIDTH;
const HEIGHT = BLOG_IMAGE_HEIGHT;
let writeTmpSeq = 0;

function writeImageFileAtomically(file, contents) {
  const tmp = `${file}.${process.pid}.${writeTmpSeq++}.tmp`;
  let created = false;
  let descriptor;
  try {
    descriptor = fs.openSync(tmp, 'wx');
    created = true;
    fs.writeFileSync(descriptor, contents);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tmp, file);
    created = false;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best-effort cleanup */ }
    }
    if (created) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
    throw error;
  }
}

function removeStagedImages(staged, errors) {
  for (const item of staged) {
    if (!item.ownsTmp) continue;
    try {
      fs.unlinkSync(item.tmp);
      item.ownsTmp = false;
    } catch (error) {
      if (error?.code === 'ENOENT') item.ownsTmp = false;
      else errors.push(error);
    }
  }
}

function writeImageFilesAtomically(images) {
  const staged = [];
  try {
    for (const { file, contents } of images) {
      let before = null;
      try {
        before = fs.readFileSync(file);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const item = {
        file,
        tmp: `${file}.${process.pid}.${writeTmpSeq++}.tmp`,
        before,
        ownsTmp: false,
      };
      staged.push(item);
      let descriptor;
      try {
        descriptor = fs.openSync(item.tmp, 'wx');
        item.ownsTmp = true;
        fs.writeFileSync(descriptor, contents);
        fs.closeSync(descriptor);
        descriptor = undefined;
      } catch (error) {
        if (descriptor !== undefined) {
          try { fs.closeSync(descriptor); } catch { /* cleanup below reports the primary failure */ }
        }
        throw error;
      }
    }
  } catch (error) {
    const cleanupErrors = [];
    removeStagedImages(staged, cleanupErrors);
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'staging della coppia di immagini incompleto');
    }
    throw error;
  }

  const committed = [];
  try {
    for (const item of staged) {
      fs.renameSync(item.tmp, item.file);
      item.ownsTmp = false;
      committed.push(item);
    }
  } catch (error) {
    const rollbackErrors = [];
    removeStagedImages(staged, rollbackErrors);
    for (const item of committed.reverse()) {
      try {
        if (item.before === null) {
          try { fs.unlinkSync(item.file); } catch (unlinkError) {
            if (unlinkError?.code !== 'ENOENT') throw unlinkError;
          }
        } else {
          writeImageFileAtomically(item.file, item.before);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'commit della coppia di immagini e rollback incompleti');
    }
    throw error;
  }
}

export function buildDailyBriefImageRecord({ id, sha256, bytes }) {
  return buildDeterministicCardRecord({
    id,
    sha256,
    bytes,
    width: WIDTH,
    height: HEIGHT,
  });
}

const DAILY_BRIEF_COVER_SCENES = Object.freeze({
  dailyBrief: 'A Swiss-Italian cross-border commuter train arriving at a small regional station in Ticino on an ordinary weekday.',
  jobs: 'A quiet, contemporary workplace in Ticino beside a commuter rail station, suggesting cross-border employment.',
  border: 'A line of ordinary commuter cars approaching a Swiss-Italian border crossing on a clear weekday, with the traffic flow visible.',
  exchange: 'A neutral still life about the Swiss franc and euro exchange, with unmarked coins and a commuter travel wallet.',
  fuel: 'A car refuelling at an unbranded station near the Swiss-Italian border, with no visible price display.',
});

const DAILY_BRIEF_COVER_TOPICS = Object.freeze({
  dailyBrief: 'daily travel and practical information for cross-border commuters in Ticino',
  jobs: 'cross-border employment and job listings in Ticino',
  border: 'traffic and waiting conditions at Swiss-Italian border crossings',
  exchange: 'the Swiss franc to euro exchange for cross-border commuters',
  fuel: 'fuel costs for cross-border commuters near the Swiss-Italian border',
});

function requireHeadlineKind(headline) {
  const kind = String(headline?.kind || '');
  if (!kind) throw new Error('daily brief cover requires a headline kind');
  return kind;
}

function requireFiniteEvidence(headline, field, kind) {
  const value = headline?.[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${kind} cover requires finite numeric ${field}`);
  }
  return value;
}

/**
 * Build a number-free visual brief from the editorial headline's existing
 * primary signal. The generated image illustrates the topic; all measurements
 * remain in the article copy and are never rendered onto the cover.
 */
export function buildDailyBriefCoverPrompt(headline) {
  const kind = requireHeadlineKind(headline);
  let scene;

  if (kind === 'jobsTrend') {
    const change = requireFiniteEvidence(headline, 'weeklyChange', kind);
    if (change === 0) throw new Error('jobsTrend cover requires a non-zero weeklyChange');
    // The signal counts new listings on our board, not employment. Keep the
    // visual on job search and avoid implying an economy-wide direction.
    scene = DAILY_BRIEF_COVER_SCENES.jobs;
  } else if (kind === 'borderWaitChange') {
    const change = requireFiniteEvidence(headline, 'changeMinutes', kind);
    scene = `${DAILY_BRIEF_COVER_SCENES.border} ${change > 0 ? 'Traffic is building up.' : change < 0 ? 'Traffic is easing.' : 'Traffic is steady.'}`;
  } else if (kind === 'borderWait') {
    scene = DAILY_BRIEF_COVER_SCENES.border;
  } else if (kind === 'jobs' || kind === 'jobsTotal') {
    scene = DAILY_BRIEF_COVER_SCENES.jobs;
  } else if (kind === 'exchangeChange') {
    const change = requireFiniteEvidence(headline, 'weeklyDelta', kind);
    scene = `${DAILY_BRIEF_COVER_SCENES.exchange} ${change > 0 ? 'The Swiss franc is strengthening against the euro.' : change < 0 ? 'The Swiss franc is softening against the euro.' : 'The exchange rate is steady.'}`;
  } else if (kind === 'exchange') {
    scene = DAILY_BRIEF_COVER_SCENES.exchange;
  } else if (kind === 'fuelSaving') {
    scene = DAILY_BRIEF_COVER_SCENES.fuel;
  } else if (kind === 'fuel') {
    scene = DAILY_BRIEF_COVER_SCENES.fuel;
  } else if (kind === 'dailyBrief') {
    scene = DAILY_BRIEF_COVER_SCENES.dailyBrief;
  } else {
    throw new Error(`unsupported daily brief headline kind: ${kind}`);
  }

  return [
    'Create a photorealistic editorial illustration for a Swiss cross-border commuter news bulletin.',
    scene,
    'Use a restrained, natural editorial palette and a clear photographic composition suitable for a wide news hero.',
    'Do not depict a real documented incident, a recognizable person, a foreground person, or an identifiable public figure.',
    'No words, numbers, dates, signage, flags, logos, brands, watermarks, interface screens, or price boards.',
    'The scene must read as a generic editorial illustration, not evidence of a specific real-world event.',
  ].join(' ');
}

/** Return a number-free context object for the governed image engine. */
export function buildDailyBriefImageContext(headline, id) {
  const kind = requireHeadlineKind(headline);
  const topic = kind.startsWith('jobs')
    ? DAILY_BRIEF_COVER_TOPICS.jobs
    : kind.startsWith('borderWait')
      ? DAILY_BRIEF_COVER_TOPICS.border
      : kind.startsWith('exchange')
        ? DAILY_BRIEF_COVER_TOPICS.exchange
        : kind.startsWith('fuel')
          ? DAILY_BRIEF_COVER_TOPICS.fuel
          : kind === 'dailyBrief'
            ? DAILY_BRIEF_COVER_TOPICS.dailyBrief
          : null;
  if (!topic) throw new Error(`unsupported daily brief headline kind: ${kind}`);
  return {
    id,
    title: 'Bollettino del Frontaliere',
    category: 'daily commuter bulletin',
    topic,
    keywords: ['cross-border commuters', 'Ticino', topic],
    imagePrompt: buildDailyBriefCoverPrompt(headline),
  };
}

/** Conservative localized alt text tied to the same editorial headline kind. */
export function buildDailyBriefCoverAlt(headline, { photograph = false } = {}) {
  const kind = requireHeadlineKind(headline);
  const topic = kind.startsWith('jobs')
    ? {
      it: 'un ambiente di lavoro contemporaneo vicino a una stazione ferroviaria in Ticino',
      en: 'a contemporary workplace beside a railway station in Ticino',
      de: 'einen modernen Arbeitsplatz neben einem Bahnhof im Tessin',
      fr: 'un lieu de travail contemporain près d’une gare au Tessin',
    }
    : kind.startsWith('borderWait')
      ? {
        it: 'auto in avvicinamento a un valico tra Svizzera e Italia',
        en: 'cars approaching a Swiss-Italian border crossing',
        de: 'Autos auf dem Weg zu einem Grenzübergang zwischen der Schweiz und Italien',
        fr: 'des voitures approchant d’un poste-frontière entre la Suisse et l’Italie',
      }
      : kind.startsWith('exchange')
        ? {
          it: 'monete non contrassegnate e un portafoglio da pendolare',
          en: 'unmarked coins and a commuter travel wallet',
          de: 'unmarkierte Münzen und eine Pendler-Geldbörse',
          fr: 'des pièces sans inscription et un portefeuille de voyageur',
        }
        : kind.startsWith('fuel')
          ? {
            it: 'un’auto al distributore vicino al confine svizzero-italiano',
            en: 'a car refuelling at an unbranded station near the Swiss-Italian border',
            de: 'ein Auto an einer unmarkierten Tankstelle nahe der Schweizerisch-italienischen Grenze',
            fr: 'une voiture faisant le plein dans une station sans marque près de la frontière suisse-italienne',
          }
          : kind === 'dailyBrief'
            ? {
              it: 'un treno per pendolari in arrivo a una stazione regionale in Ticino',
              en: 'a commuter train arriving at a regional station in Ticino',
              de: 'einen Pendlerzug bei der Einfahrt in einen Regionalbahnhof im Tessin',
              fr: 'un train de banlieue arrivant dans une gare régionale au Tessin',
            }
          : null;
  if (!topic) throw new Error(`unsupported daily brief headline kind: ${kind}`);
  const subject = {
    it: photograph ? 'Fotografia di' : 'Illustrazione di',
    en: photograph ? 'Photograph of' : 'Illustration of',
    de: photograph ? 'Foto von' : 'Illustration von',
    fr: photograph ? 'Photographie de' : 'Illustration de',
  };
  return {
    it: `${subject.it} ${topic.it}.`,
    en: `${subject.en} ${topic.en}.`,
    de: `${subject.de} ${topic.de}.`,
    fr: `${subject.fr} ${topic.fr}.`,
  };
}

/** Select the daily cover alt from its final governed image provenance. */
export function dailyBriefCoverAltForRecord(headline, record) {
  if (record?.kind === 'generated') return { ...GENERATED_COVER_ALT_BY_LOCALE };
  if (!headline?.kind) return null;
  return buildDailyBriefCoverAlt(headline, { photograph: record?.kind === LICENSED_PHOTO_KIND });
}

/**
 * Materialize a fresh governed daily hero and its 480px thumbnail, then append
 * the provider/license record. No existing article-id record is a
 * cache hit: each daily run passes a newly generated engine result here.
 */
export async function materializeDailyBriefHero({
  root,
  data,
  result,
  assetId = data,
  generateThumbnail,
} = {}) {
  try {
    const record = result?.record;
    if (!record) throw new Error(`daily brief engine returned no image record for ${data?.id || '<unknown>'}`);
    const imageUrl = articleHeroImagePath(record.imageUrl);
    const expectedAssetId = typeof assetId === 'string' ? articleImageAssetId(assetId) : articleImageAssetId(data);
    if (record.scope !== 'article-hero' || record.assetId !== expectedAssetId) {
      throw new Error(`daily brief engine returned the wrong hero identity for ${data?.id || '<unknown>'}`);
    }
    if (!Number.isInteger(record.width) || record.width < BLOG_IMAGE_WIDTH
      || !Number.isInteger(record.height) || record.height < BLOG_IMAGE_HEIGHT) {
      throw new Error(`daily brief engine returned a hero below ${BLOG_IMAGE_WIDTH}×${BLOG_IMAGE_HEIGHT}`);
    }
    if (!result?.filePath || !fs.existsSync(result.filePath)) {
      throw new Error(`daily brief engine returned no materialized hero for ${data?.id || '<unknown>'}`);
    }
    if (fs.statSync(result.filePath).size !== record.bytes || sha256File(result.filePath) !== record.sha256) {
      throw new Error(`daily brief hero bytes do not match the engine record for ${data?.id || '<unknown>'}`);
    }

    const heroPath = path.join(root, 'public', imageUrl.slice(1));
    const stem = path.basename(heroPath, path.extname(heroPath));
    const thumbPath = path.join(path.dirname(heroPath), 'thumbnails', `${stem}-480w.webp`);
    fs.mkdirSync(path.dirname(heroPath), { recursive: true });
    fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
    let thumb;
    if (typeof generateThumbnail === 'function') {
      thumb = await generateThumbnail(result.filePath);
    } else {
      let sharp;
      ({ default: sharp } = await import('sharp'));
      thumb = await sharp(result.filePath)
        .resize({ width: 480, withoutEnlargement: true })
        .webp({ quality: 68, effort: 6 })
        .toBuffer();
    }
    if (!Buffer.isBuffer(thumb) || thumb.length === 0) {
      throw new Error(`daily brief thumbnail renderer returned no bytes for ${data?.id || '<unknown>'}`);
    }
    writeImageFilesAtomically([
      { file: heroPath, contents: fs.readFileSync(result.filePath) },
      { file: thumbPath, contents: thumb },
    ]);
    appendGeneratedImageRecord(root, record);
    data._generatedImagePath = imageUrl;
    data._generatedImageRecord = record.kind === LICENSED_PHOTO_KIND ? null : record;
    data._imageCredit = record.kind === LICENSED_PHOTO_KIND
      ? imageCreditRecordFromGeneratedImageRecord(record)
      : null;
    const imageAlt = dailyBriefCoverAltForRecord(data._headline, record);
    if (imageAlt) data.imageAlt = imageAlt;
    data.image = path.basename(imageUrl);
    return {
      record,
      imageUrl,
      heroPath,
      thumbPath,
      heroBytes: record.bytes,
      thumbBytes: thumb.length,
    };
  } finally {
    if (result?.stagingDir) fs.rmSync(result.stagingDir, { recursive: true, force: true });
  }
}

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
    fuel: 'BENZINA — MINIMO RILEVATO',
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
    fuel: 'PETROL — REPORTED MINIMUM',
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
    fuel: 'BENZIN — GEMELDETES MINIMUM',
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
    fuel: 'ESSENCE — MINIMUM RELEVÉ',
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
    ? `Δ ${fx.delta1d > 0 ? '+' : ''}${fmtNum(locale, fx.delta1d, 4)}`
    : t.na;

  const jobs = blocks.jobs;
  const jobsBig = jobs?.available && Number.isFinite(jobs.yesterdayAdded) ? `+${fmtNum(locale, jobs.yesterdayAdded)}` : '—';
  const jobsSmall = jobs?.available ? `${fmtNum(locale, jobs.activeJobs)} CH` : t.na;

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
  let hero = null;
  let quality = null;
  for (const candidateQuality of BLOG_IMAGE_QUALITY_PASSES) {
    const candidate = await sharp(input, { density: 96 })
      .resize(WIDTH, HEIGHT, { fit: 'fill' })
      .webp({ quality: candidateQuality, effort: 6 })
      .toBuffer();
    hero = candidate;
    quality = candidateQuality;
    if (candidate.byteLength <= BLOG_IMAGE_TARGET_MAX_BYTES) break;
  }
  if (!hero || hero.byteLength > BLOG_IMAGE_HARD_MAX_BYTES) {
    throw new Error(`daily brief hero remains above hard cap (${hero?.byteLength ?? 0} bytes)`);
  }
  const thumb = await sharp(hero).resize({ width: 480 }).webp({ quality: 68, effort: 6 }).toBuffer();
  fs.mkdirSync(path.dirname(heroPath), { recursive: true });
  fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
  writeImageFilesAtomically([
    { file: heroPath, contents: hero },
    { file: thumbPath, contents: thumb },
  ]);
  return { heroBytes: hero.length, thumbBytes: thumb.length, quality };
}

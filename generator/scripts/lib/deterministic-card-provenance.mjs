/**
 * Provenance markers for images rendered by repository-owned deterministic
 * producers. The shared image schema already has `private-grant` for bytes
 * owned by the site rather than an external provider; `source` distinguishes
 * a deterministic card from a publisher-only private asset without changing
 * the mirrored engine contract.
 */

export const DETERMINISTIC_CARD_KIND = 'deterministic-card';
export const DETERMINISTIC_CARD_SOURCE = DETERMINISTIC_CARD_KIND;
export const DETERMINISTIC_CARD_LICENSE = 'private-grant';
export const DETERMINISTIC_CARD_PROVIDER = 'site-owned';
export const DETERMINISTIC_CARD_CREDIT = 'frontaliereticino.ch';
export const DETERMINISTIC_CARD_LICENSE_URL = 'https://frontaliereticino.ch/termini-di-servizio/#licenza-immagini';
export const DAILY_BRIEF_IMAGE_PRODUCER = 'generator/scripts/lib/daily-brief-image.mjs';
export const DAILY_BRIEF_IMAGE_TEMPLATE_VERSION = 'frontaliereticino.daily-brief-card.v1';

export function isDeterministicCardRecord(record) {
  return record?.source === DETERMINISTIC_CARD_SOURCE
    && record?.provider === DETERMINISTIC_CARD_PROVIDER
    && record?.license === DETERMINISTIC_CARD_LICENSE
    && record?.producer === DAILY_BRIEF_IMAGE_PRODUCER
    && record?.templateVersion === DAILY_BRIEF_IMAGE_TEMPLATE_VERSION;
}

/** Build the schema-compatible record for the daily brief's rendered hero. */
export function buildDeterministicCardRecord({ id, sha256, bytes, width, height }) {
  if (!/^bollettino-frontaliere-\d{4}-\d{2}-\d{2}$/.test(String(id || ''))) {
    throw new Error(`invalid daily brief image id: ${id}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(String(sha256 || ''))) {
    throw new Error('daily brief image sha256 must be a 64-character hex digest');
  }
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error('daily brief image bytes must be a positive integer');
  }
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('daily brief image dimensions must be positive integers');
  }

  return {
    schema: 1,
    assetId: id,
    source: DETERMINISTIC_CARD_SOURCE,
    provider: DETERMINISTIC_CARD_PROVIDER,
    note: 'Deterministic SVG card rendered by the repository; no external image provider is used.',
    credit: DETERMINISTIC_CARD_CREDIT,
    producer: DAILY_BRIEF_IMAGE_PRODUCER,
    templateVersion: DAILY_BRIEF_IMAGE_TEMPLATE_VERSION,
    license: DETERMINISTIC_CARD_LICENSE,
    sha256: String(sha256).toLowerCase(),
    bytes,
    width,
    height,
    format: 'webp',
    scope: 'article-hero',
    imageUrl: `/images/blog/${id}.webp`,
  };
}

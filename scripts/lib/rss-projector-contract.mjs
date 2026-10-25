import { RSS_DESCRIPTION_MAX_CHARS } from '../../generator/scripts/lib/seo-description-contract.mjs';

/**
 * The RSS builder receives its description projector from build-api.mjs.
 * Keeping the check at this boundary prevents a future caller from silently
 * passing the raw stored description and bypassing the public cap.
 */
const CONTRACT_PROBE = Array.from({ length: 8 }, (_, index) =>
  `A source-backed article description sentence ${index + 1} is deliberately long enough to exercise the public RSS projector contract.`
).join(' ');

export function assertRssProjectorContract(projector) {
  if (typeof projector !== 'function') {
    throw new TypeError('RSS description projector must be a function');
  }
  const projected = projector(CONTRACT_PROBE);
  if (typeof projected !== 'string' || projected.trim().length === 0) {
    throw new TypeError('RSS description projector must return non-empty text');
  }
  if (projected.length > RSS_DESCRIPTION_MAX_CHARS) {
    throw new TypeError(
      `RSS description projector must cap output at ${RSS_DESCRIPTION_MAX_CHARS} characters (got ${projected.length})`,
    );
  }
  const repeated = projector(projected);
  if (repeated !== projected) {
    throw new TypeError('RSS description projector must be idempotent');
  }
  return projector;
}

/**
 * The RSS builder receives its description projector from build-api.mjs.
 * Keeping the check at this boundary prevents a future caller from silently
 * passing the raw stored description and bypassing the public cap.
 */
const CONTRACT_PROBE =
  'A source-backed article description long enough to exercise the public RSS ' +
  'projector contract without depending on corpus data or network access.';

export function assertRssProjectorContract(projector) {
  if (typeof projector !== 'function') {
    throw new TypeError('RSS description projector must be a function');
  }
  const projected = projector(CONTRACT_PROBE);
  if (typeof projected !== 'string' || projected.trim().length === 0) {
    throw new TypeError('RSS description projector must return non-empty text');
  }
  const repeated = projector(projected);
  if (repeated !== projected) {
    throw new TypeError('RSS description projector must be idempotent');
  }
  return projector;
}

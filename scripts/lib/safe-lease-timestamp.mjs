/**
 * Timestamp guard shared by the R2 section and image namespace leases.
 *
 * Lease payloads are persisted as JSON and compared numerically by multiple
 * writers. Finite numbers are not enough: fractional, negative, and unsafe
 * integers can be rounded differently by a producer or consumer and make a
 * stale lock appear live. Keep this predicate dependency-free so both lock
 * implementations use one admission contract.
 */
export function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

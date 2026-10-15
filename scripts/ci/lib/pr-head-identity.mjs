/**
 * Read the head identity from either the REST pull-request shape or the
 * GitHub CLI GraphQL shape. Missing identity stays unknown so callers can
 * keep their existing fail-closed behavior.
 *
 * @param {unknown} pr
 * @returns {{ref: string, repository: string}|null}
 */
export function prHeadIdentity(pr) {
  const head = pr && typeof pr === 'object' ? pr : null;
  const ref = head?.head?.ref ?? head?.headRefName;
  const headRepository = head?.headRepository;
  const repository = head?.head?.repo?.full_name
    ?? headRepository?.nameWithOwner
    ?? (headRepository?.owner?.login && headRepository?.name
      ? `${headRepository.owner.login}/${headRepository.name}`
      : null)
    ?? (head?.headRepositoryOwner?.login && headRepository?.name
      ? `${head.headRepositoryOwner.login}/${headRepository.name}`
      : null);
  if (typeof ref !== 'string' || !ref.trim()) return null;
  if (typeof repository !== 'string' || !repository.trim()) return null;
  return { ref: ref.trim(), repository: repository.trim() };
}

/**
 * Whether a known PR head belongs to the expected repository. `null` means
 * that the head or expected repository is incomplete and should be handled
 * fail-closed by the caller.
 *
 * @param {unknown} pr
 * @param {unknown} expectedRepository
 * @returns {boolean|null}
 */
export function isRepositoryOwnedPrHead(pr, expectedRepository) {
  const identity = prHeadIdentity(pr);
  if (!identity || typeof expectedRepository !== 'string' || !expectedRepository.trim()) return null;
  return identity.repository.toLocaleLowerCase('en-US')
    === expectedRepository.trim().toLocaleLowerCase('en-US');
}

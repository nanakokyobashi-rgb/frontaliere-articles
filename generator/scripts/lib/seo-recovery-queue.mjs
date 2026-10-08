// Queue bookkeeping of the SEO recovery (generator/scripts/recover-seo-orphans.mjs).
// Kept apart from the script, which runs its command line at import.

/**
 * The current queue, with the items this run added placed just before the
 * last one that was already there instead of after it.
 *
 * The result holds exactly the items of `current`, reordered: an item the
 * drain removed after the snapshot stays removed, and two items for the same
 * article both stay as they are. `snapshot` only tells which items were there
 * before the run.
 *
 * The cover pipeline appends its own failures at the end of this file. Two
 * appends at the same spot are a merge conflict; an insertion one item earlier
 * is not, because the last item's lines stay between the two changes. That
 * covers appends only: the drain also deletes items, and a deletion next to
 * the insertion point still conflicts, so a branch that carries this file has
 * to stay short-lived. The drain looks items up by article, so the order only
 * decides who goes first.
 */
export function mergeQueueWithSnapshot(snapshot, current) {
  const snapshotIds = new Set(snapshot.items.map((item) => item?.articleId));
  const kept = current.items.filter((item) => snapshotIds.has(item?.articleId));
  const added = current.items.filter((item) => !snapshotIds.has(item?.articleId));
  const items = kept.length === 0
    ? added
    : [...kept.slice(0, -1), ...added, kept[kept.length - 1]];
  return { ...current, items };
}

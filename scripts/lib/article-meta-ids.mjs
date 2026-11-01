// The generated meta chunks use one key per article field:
// `blog.article.<article-id>.<field>`. Keep this parser shared by observers
// and corpus scanners so publication intent has one representation.
const ARTICLE_META_KEY_RX = /['"]blog\.article\.([a-z0-9-]+)\.[a-zA-Z0-9]+['"]\s*:/;

/** Return the article id named by a generated meta-chunk line, if any. */
export function extractMetaArticleId(line) {
  return String(line ?? '').match(ARTICLE_META_KEY_RX)?.[1] || null;
}

/** Return all article ids represented by a generated meta chunk. */
export function parseArticleMetaIds(source) {
  const ids = new Set();
  for (const line of String(source ?? '').split('\n')) {
    const id = extractMetaArticleId(line);
    if (id) ids.add(id);
  }
  return ids;
}

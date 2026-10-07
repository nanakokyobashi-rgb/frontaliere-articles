export const articleHeroPath = /^\/images\/(?:blog|generated)\/[a-z0-9][a-z0-9._-]{2,127}\.webp$/;

export function articleImageSubject(data = {}) {
  const title = String(data.title || data.content?.it?.title || data.content?.title || '').trim();
  const context = String(data.imagePrompt || '').replace(/\s+/g, ' ').trim();
  return [title, context].filter(Boolean).join(' — ').slice(0, 500);
}

export function articleImageAssetId(value) {
  const raw = typeof value === 'object' && value !== null ? value.id : value;
  const normalized = String(raw || 'article').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `article-${(normalized || 'article').slice(0, 110)}`;
}

export function articleHeroImagePath(imageUrl) {
  const normalized = String(imageUrl || '');
  if (!articleHeroPath.test(normalized)) {
    throw new Error(`Governed engine returned an invalid article-hero path: ${normalized || '<empty>'}`);
  }
  return normalized;
}

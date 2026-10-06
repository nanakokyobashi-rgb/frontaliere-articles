/**
 * Pure source classification for journalist hero images.
 *
 * Keeping this contract dependency-free lets the publication policy be tested
 * without Firebase, sharp, or the full registration pipeline in node:test.
 */

function normalizeRequiredText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function requiredHttpsUrl(value) {
  const text = normalizeRequiredText(value);
  if (!text) return null;
  try {
    return new URL(text).protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}

/**
 * Return the mandatory editorial rights fields, or null when the newsroom
 * has not supplied a complete provenance bundle.
 */
export function editorialUploadMetadata(doc = {}) {
  const rights = doc.imageRights && typeof doc.imageRights === 'object' ? doc.imageRights : {};
  const rightsHolder = normalizeRequiredText(
    doc.imageRightsHolder || rights.rightsHolder || doc.rightsHolder,
  );
  const license = normalizeRequiredText(
    doc.imageLicense || rights.license || doc.license,
  );
  const proofUrl = requiredHttpsUrl(
    doc.imageProofUrl || rights.proofUrl || doc.imageSourceUrl || rights.sourceUrl || doc.proofUrl,
  );
  const author = normalizeRequiredText(
    doc.imageAuthor || rights.author || doc.author,
  );
  if (!rightsHolder || !license || !proofUrl || !author) return null;
  return { rightsHolder, license, proofUrl, author };
}

export function classifyJournalistImage(rawImage, doc = {}) {
  const image = typeof rawImage === 'string' ? rawImage.trim() : '';
  if (/^\/images\//.test(image)) return { kind: 'catalog', path: image };
  if (/^https?:\/\//i.test(image)) {
    if (!/^https:\/\//i.test(image)) {
      return { kind: 'rejected-url', url: image, reason: 'image-url-must-use-https' };
    }
    const metadata = editorialUploadMetadata(doc);
    return metadata
      ? { kind: 'editorial-upload', url: image, metadata }
      : { kind: 'rejected-url', url: image, reason: 'missing-editorial-provenance' };
  }
  return { kind: 'engine' };
}

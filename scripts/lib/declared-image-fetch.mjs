import fs from 'node:fs';
import path from 'node:path';

export const CDN_BASE = 'https://cdn.frontaliereticino.ch';
export const MAX_DECLARED_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_FETCH_TIMEOUT_MS = 20_000;
export const IMAGE_FETCH_ATTEMPTS = 2;

/**
 * Prove that a declared image is the same image contract used by the render
 * pipeline: CDN origin, HTTPS, image content type, bounded body, and no
 * redirects. With a destination the bytes are also materialised for a render;
 * without one the body is still consumed, so the observer gets the same proof
 * without writing a temporary file.
 */
export async function fetchDeclaredImage({ imagePath, destination = null, fetchImpl = globalThis.fetch }) {
  const url = new URL(imagePath, `${CDN_BASE}/`);
  if (url.origin !== new URL(CDN_BASE).origin || url.protocol !== 'https:') throw new Error('origine CDN non autorizzata');
  if (typeof fetchImpl !== 'function') throw new Error('fetch non disponibile');

  let lastError = 'nessuna risposta';
  for (let attempt = 1; attempt <= IMAGE_FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal });
      const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!contentType.startsWith('image/')) throw new Error(`content-type non immagine: ${contentType || 'assente'}`);
      const contentLength = Number(response.headers?.get?.('content-length') || 0);
      if (contentLength > MAX_DECLARED_IMAGE_BYTES) throw new Error('immagine oltre 5 MB');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_DECLARED_IMAGE_BYTES) throw new Error('immagine oltre 5 MB');
      if (destination) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, buffer);
      }
      return { bytes: buffer.byteLength, contentType };
    } catch (error) {
      lastError = error?.name === 'AbortError' ? 'timeout 20s' : error?.message || String(error);
      if (attempt < IMAGE_FETCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError);
}

import fs from 'node:fs';
import path from 'node:path';

export const CDN_BASE = 'https://cdn.frontaliereticino.ch';
export const MAX_DECLARED_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_FETCH_TIMEOUT_MS = 20_000;
export const IMAGE_FETCH_ATTEMPTS = 4;
export const IMAGE_FETCH_RETRY_DELAY_MS = 500;
export const IMAGE_FETCH_MAX_RETRY_DELAY_MS = 4_000;

function retryDelayMs(attempt) {
  return Math.min(
    IMAGE_FETCH_MAX_RETRY_DELAY_MS,
    IMAGE_FETCH_RETRY_DELAY_MS * (2 ** Math.max(0, attempt - 1)),
  );
}

function isTransientFetchError(error, message) {
  if (error?.name === 'AbortError') return true;
  if (/^(ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ECONNABORTED|EPIPE)$/u.test(String(error?.code || ''))) return true;
  if (/fetch failed|socket hang up|timed out|timeout/iu.test(String(message))) return true;
  const status = /^HTTP\s+(\d+)$/u.exec(String(message))?.[1];
  return status === '408' || status === '429' || (status && Number(status) >= 500);
}

/**
 * Prove that a declared image is the same image contract used by the render
 * pipeline: CDN origin, HTTPS, image content type, bounded body, and no
 * redirects. With a destination the bytes are also materialised for a render;
 * without one the body is still consumed, so the observer gets the same proof
 * without writing a temporary file.
 */
export async function fetchDeclaredImage({
  imagePath,
  destination = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = IMAGE_FETCH_TIMEOUT_MS,
  attempts = IMAGE_FETCH_ATTEMPTS,
  sleepImpl = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
}) {
  const url = new URL(imagePath, `${CDN_BASE}/`);
  if (url.origin !== new URL(CDN_BASE).origin || url.protocol !== 'https:') throw new Error('origine CDN non autorizzata');
  if (typeof fetchImpl !== 'function') throw new Error('fetch non disponibile');

  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : IMAGE_FETCH_TIMEOUT_MS;
  const effectiveAttempts = Number.isInteger(attempts) && attempts > 0 ? attempts : IMAGE_FETCH_ATTEMPTS;
  if (typeof sleepImpl !== 'function') throw new Error('sleep non disponibile');

  let lastError = 'nessuna risposta';
  let lastErrorTransient = false;
  for (let attempt = 1; attempt <= effectiveAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
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
      lastError = error?.name === 'AbortError'
        ? `timeout ${Math.round(effectiveTimeoutMs / 1000)}s`
        : error?.message || String(error);
      lastErrorTransient = isTransientFetchError(error, lastError);
      if (attempt < effectiveAttempts && lastErrorTransient) await sleepImpl(retryDelayMs(attempt));
      else if (!lastErrorTransient) break;
    } finally {
      clearTimeout(timer);
    }
  }
  const finalError = new Error(lastError);
  if (lastErrorTransient) finalError.code = 'IMAGE_FETCH_TRANSIENT';
  throw finalError;
}

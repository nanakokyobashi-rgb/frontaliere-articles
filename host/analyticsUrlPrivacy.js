/** Keep email credentials out of telemetry while retaining campaign attribution.
 * Self-contained so the static bootstraps can embed the same implementation.
 */
/** @template {Record<string, any>} T
 * @param {T} properties
 * @returns {T}
 */
export function sanitizeTelemetryProperties(properties) {
 const sensitive = /^(?:ac|at|authToken|ne|newsletter_email|email|newsletter_autologin|subscriber_key|token|access_token|id_token|refresh_token|oobCode)$/i;
 /** @param {string} value @returns {string} */
 const cleanUrl = (value) => {
  // URL constructors discard leading C0 controls and whitespace. Keep this
  // normalized view for parsing, but preserve the caller's bytes when no
  // sensitive component is found.
  const input = value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  const normalized = input.replace(/^(https?):\/*(?!\/)/i, '$1://');
  const absolute = /^https?:\/\//i.test(normalized);
  const protocolRelative = normalized.startsWith('//');
  const queryOnly = normalized.startsWith('?');
  const hashOnly = normalized.startsWith('#');
  const relativePath = normalized.split(/[?#]/, 1)[0];
  try {
   const url = new URL(normalized, 'https://telemetry.invalid/');
   let changed = Boolean(url.username || url.password);
   /** @param {URLSearchParams} params */
   const cleanParams = (params) => {
    let updated = false;
    for (const key of [...params.keys()]) {
     if (sensitive.test(key)) { params.delete(key); updated = true; }
     else {
      const values = params.getAll(key);
      const cleaned = values.map((entry) => /^(?:[a-z][a-z\d+.-]*:|\/|\?|#|\.{1,2}\/)/i.test(entry.trimStart()) ? cleanUrl(entry) : entry);
      if (cleaned.some((entry, index) => entry !== values[index])) {
       updated = true;
       params.delete(key);
       cleaned.forEach((entry) => params.append(key, entry));
      }
     }
    }
    return updated;
   };
   changed = cleanParams(url.searchParams) || changed;
   if (url.hash.includes('?')) {
    const cleanedHash = '#' + cleanUrl(url.hash.slice(1));
    if (cleanedHash !== url.hash) { url.hash = cleanedHash; changed = true; }
   } else if (url.hash.includes('=')) {
    const hash = new URLSearchParams(url.hash.slice(1));
    changed = cleanParams(hash) || changed;
    url.hash = hash.toString();
   }
   url.username = '';
   url.password = '';
   if (!changed) return value;
   if (absolute) return url.toString();
   if (protocolRelative) return `//${url.host}${url.pathname}${url.search}${url.hash}`;
   if (hashOnly) return url.hash;
   if (queryOnly) return url.search + url.hash;
   // Relative path spelling (including ./ and ../) is meaningful to callers;
   // URL.pathname is rooted and would silently change it.
   return relativePath + url.search + url.hash;
  } catch {
   // A malformed URL may hide userinfo in an unparsable authority. Fail closed.
   return '';
  }
 };
 /** @param {any} value @param {string} key @returns {any} */
 const clean = (value, key) => {
  if (typeof value === 'string' && (/^(?:[a-z][a-z\d+.-]*:|\/|\?|#|\.{1,2}\/)/i.test(value.trim()) || /(?:url|path|location|referrer)$/i.test(key))) return cleanUrl(value);
  if (Array.isArray(value)) return value.map((entry) => clean(entry, key));
  if (value && Object.prototype.toString.call(value) === '[object Object]') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, clean(entry, name)]));
  return value;
 };
 return clean(properties, '');
}

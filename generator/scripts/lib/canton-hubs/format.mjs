/**
 * format.mjs — numeri e date degli hub cantonali, per locale, senza `Intl`.
 *
 * Gli hub sono file committati e confrontati byte per byte fra un run e
 * l'altro (`updatedAt` cambia solo se cambia il contenuto): la formattazione
 * non puo' dipendere dalla versione di ICU del runner. Quattro locali, regole
 * scritte qui.
 */

export const HUB_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

const GROUP_SEP = { it: '.', en: ',', de: '’', fr: ' ' };
const DECIMAL_SEP = { it: ',', en: '.', de: '.', fr: ',' };

const MONTHS = {
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};

function checkLocale(locale) {
  if (!HUB_LOCALES.includes(locale)) throw new Error(`canton-hubs: locale non supportata "${locale}"`);
  return locale;
}

/**
 * Un numero con `decimals` cifre decimali fisse e separatore delle migliaia.
 * @param {number} value
 * @param {string} locale
 * @param {number} [decimals]
 */
export function fmtNumber(value, locale, decimals = 0) {
  checkLocale(locale);
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`canton-hubs: numero non valido ${JSON.stringify(value)}`);
  const fixed = Math.abs(value).toFixed(decimals);
  const [int, frac] = fixed.split('.');
  // In italiano le quattro cifre non si separano (1500, 12.500).
  const grouped = locale === 'it' && int.length <= 4 ? int : int.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_SEP[locale]);
  const sign = value < 0 && Number(fixed) !== 0 ? '-' : '';
  return `${sign}${grouped}${frac ? `${DECIMAL_SEP[locale]}${frac}` : ''}`;
}

/** Decimali solo quando servono: 740.2 → «740,20», 679 → «679». */
export function fmtAmount(value, locale) {
  return fmtNumber(value, locale, Number.isInteger(value) ? 0 : 2);
}

export function fmtChf(value, locale) {
  return `${fmtAmount(value, locale)} CHF`;
}

/** Percentuale con al piu' due decimali significativi: 8.92 → «8,92 %», 10.1 → «10,1 %». */
export function fmtPct(value, locale) {
  const decimals = Number.isInteger(value) ? 0 : Number.isInteger(value * 10) ? 1 : 2;
  const n = fmtNumber(value, locale, decimals);
  return locale === 'en' ? `${n}%` : `${n} %`;
}

/** Prezzo al litro, tre decimali come alla pompa. */
export function fmtPerLitre(value, currency, locale) {
  return `${fmtNumber(value, locale, 3)} ${currency}/l`;
}

/** Il giorno UTC (`YYYY-MM-DD`) di un istante o di una data ISO. */
export function isoDayOf(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`canton-hubs: data non valida ${JSON.stringify(value)}`);
  return new Date(ms).toISOString().slice(0, 10);
}

/** «5 ottobre 2026» / «5 October 2026» / «5. Oktober 2026» / «5 octobre 2026». */
export function fmtDay(value, locale) {
  checkLocale(locale);
  const [y, m, d] = isoDayOf(value).split('-').map(Number);
  const month = MONTHS[locale][m - 1];
  if (locale === 'de') return `${d}. ${month} ${y}`;
  if (locale === 'fr' && d === 1) return `1er ${month} ${y}`;
  return `${d} ${month} ${y}`;
}

/** «a, b e c» nelle quattro locali. */
export function joinList(items, locale) {
  checkLocale(locale);
  const list = items.filter(Boolean);
  if (list.length <= 1) return list.join('');
  const and = { it: ' e ', en: ' and ', de: ' und ', fr: ' et ' }[locale];
  return `${list.slice(0, -1).join(', ')}${and}${list[list.length - 1]}`;
}

/** Tronca a `max` caratteri sul confine di parola, con ellissi. */
export function clip(text, max = 180) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.–—-]+$/u, '')}…`;
}

/** `https://…` valido per il renderer (che rifiuta http e URL con spazi), oppure null. */
export function httpsUrlOrNull(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!/^https:\/\/[^\s"<>]+$/.test(v)) return null;
  try {
    return new URL(v).hostname ? v : null;
  } catch {
    return null;
  }
}

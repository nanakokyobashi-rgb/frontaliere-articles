#!/usr/bin/env node
/**
 * bonifica-sample.mjs — il campione da GIUDICARE prima di una scrittura della
 * bonifica dei body bloccanti (`bonifica-blocking-bodies.yml`).
 *
 * ## Perche' esiste
 *
 * La issue del sito 7683 (`translation-false-friend`) mette una condizione
 * d'ordine: prima un campione stratificato di almeno 30 casi giudicato, col
 * tasso di falsi positivi scritto sulla issue, e SOLO dopo la fix. Il
 * workflow produce quel campione a ogni run; il verdetto non lo decide lui.
 *
 * La selezione sta qui, in una funzione pura, e non in un `node -e` dentro il
 * YAML: cosi' e' deterministica e un test la esercita.
 *
 * ## Come sceglie
 *
 * Per ogni codice: le coppie del `--list-out` di
 * `retranslate-blocking-bodies.mjs --scan` che portano quel codice, ordinate
 * per `key`. Se sono al massimo `min` le prende tutte. Altrimenti divide `min`
 * fra i locali in proporzione (resto maggiore, almeno una coppia per locale
 * presente, cosi' un locale piccolo non sparisce dal campione) e dentro ogni
 * locale prende una coppia ogni `floor(n / quota)`, partendo dalla prima.
 * Stesso input, stesso campione: nessun `Math.random`, nessuna data.
 *
 * Uso:
 *   node generator/scripts/bonifica-sample.mjs --in stock.jsonl --out sample.md
 *     [--code a,b]      codici da campionare (default: tutti quelli presenti)
 *     [--locale a,b]    locali ammessi (default: tutti)
 *     [--min N]         dimensione minima del campione per codice (default 30)
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SAMPLE_MIN = 30;

/** Locale di una chiave `<dir>/<locale>/<id>`: il penultimo segmento. */
export function localeOfKey(key) {
  const parts = String(key || '').split('/');
  return parts.length >= 3 ? parts[parts.length - 2] : '';
}

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const splitList = (raw) =>
  String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Quote per locale: proporzionali, almeno 1 per locale presente, somma pari a
 * `max(min, numero di locali)`, mai oltre le coppie del locale.
 */
function localeQuotas(groups, total, min) {
  const locales = [...groups.keys()].sort();
  const target = Math.min(total, Math.max(min, locales.length));
  const quotas = new Map();
  const remainders = [];
  for (const locale of locales) {
    const n = groups.get(locale).length;
    const exact = (target * n) / total;
    const base = Math.min(n, Math.max(1, Math.floor(exact)));
    quotas.set(locale, base);
    remainders.push({ locale, frac: exact - Math.floor(exact) });
  }
  let assigned = [...quotas.values()].reduce((a, b) => a + b, 0);
  // Resto maggiore, a parita' di resto l'ordine dei locali: deterministico.
  remainders.sort((a, b) => b.frac - a.frac || (a.locale < b.locale ? -1 : 1));
  let progressed = true;
  while (assigned < target && progressed) {
    progressed = false;
    for (const { locale } of remainders) {
      if (assigned >= target) break;
      if (quotas.get(locale) < groups.get(locale).length) {
        quotas.set(locale, quotas.get(locale) + 1);
        assigned += 1;
        progressed = true;
      }
    }
  }
  return quotas;
}

/** Una riga ogni `floor(n / quota)`, dalla prima, fino a `quota` righe. */
function everyNth(rows, quota) {
  if (quota >= rows.length) return rows.slice();
  const step = Math.max(1, Math.floor(rows.length / quota));
  const out = [];
  for (let i = 0; i < rows.length && out.length < quota; i += step) out.push(rows[i]);
  return out;
}

/**
 * Campione deterministico e stratificato per locale.
 *
 * @param {Array<{ key: string, codes: string[], evidence?: Array<{ code: string, excerpt: string }> }>} rows
 * @param {{ codes?: string[], locales?: string[] | null, min?: number }} [opts]
 * @returns {Array<{ code: string, total: number, rows: Array<{ key: string, locale: string, excerpt: string }> }>}
 */
export function buildSample(rows, { codes = [], locales = null, min = DEFAULT_SAMPLE_MIN } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.key === 'string');
  const allowed = Array.isArray(locales) && locales.length ? new Set(locales) : null;
  const wanted = Array.isArray(codes) && codes.length
    ? [...new Set(codes)]
    : [...new Set(list.flatMap((r) => (Array.isArray(r.codes) ? r.codes : [])))].sort();
  const floor = Number.isFinite(min) && min > 0 ? Math.floor(min) : DEFAULT_SAMPLE_MIN;

  return wanted.map((code) => {
    const candidates = list
      .filter((r) => Array.isArray(r.codes) && r.codes.includes(code))
      .filter((r) => !allowed || allowed.has(localeOfKey(r.key)))
      .sort(byKey);
    let picked;
    if (candidates.length <= floor) {
      picked = candidates;
    } else {
      const groups = new Map();
      for (const r of candidates) {
        const locale = localeOfKey(r.key);
        if (!groups.has(locale)) groups.set(locale, []);
        groups.get(locale).push(r);
      }
      const quotas = localeQuotas(groups, candidates.length, floor);
      picked = [...groups.keys()].flatMap((locale) => everyNth(groups.get(locale), quotas.get(locale))).sort(byKey);
    }
    return {
      code,
      total: candidates.length,
      rows: picked.map((r) => ({
        key: r.key,
        locale: localeOfKey(r.key),
        excerpt: (Array.isArray(r.evidence) ? r.evidence : []).find((e) => e && e.code === code)?.excerpt || '',
      })),
    };
  });
}

/**
 * Una cella di tabella Markdown che non rompe la tabella e non diventa HTML:
 * l'estratto e' testo pubblicato, e finisce nello step summary di GitHub.
 */
export function markdownCell(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/`/g, "'")
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}

/** Il campione come Markdown: una tabella per codice, colonna verdetto vuota. */
export function renderSampleMarkdown(sections) {
  const out = ['## Campione da giudicare', ''];
  out.push(
    'Il workflow produce il campione, non il verdetto: chi giudica compila la colonna `verdetto` ' +
      '(vero = errore reale, falso = falso positivo) e pubblica tabella e tasso di falsi positivi sulla issue del codice.',
  );
  out.push('');
  if (!sections.length) {
    out.push('Nessuna coppia bloccante per i codici e i locali selezionati.');
    return `${out.join('\n')}\n`;
  }
  for (const section of sections) {
    out.push(`### ${section.code} — ${section.rows.length} su ${section.total}`, '');
    if (!section.rows.length) {
      out.push('Nessuna coppia con questo codice nei locali selezionati.', '');
      continue;
    }
    out.push('| key | locale | estratto | verdetto (vero/falso) | nota |');
    out.push('|---|---|---|---|---|');
    for (const row of section.rows) {
      out.push(`| ${markdownCell(row.key)} | ${markdownCell(row.locale)} | ${markdownCell(row.excerpt)} |  |  |`);
    }
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

/** Righe JSONL del `--list-out`. Una riga illeggibile e' un errore, non un salto. */
export function parseJsonl(text) {
  return String(text || '')
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line)
    .map(({ line, n }) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`riga ${n} del JSONL illeggibile: ${err.message}`);
      }
    });
}

function cliValue(argv, name) {
  const exact = `--${name}`;
  const i = argv.indexOf(exact);
  if (i !== -1) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${exact} richiede un valore`);
    return next;
  }
  const inline = argv.find((a) => a.startsWith(`${exact}=`));
  return inline === undefined ? null : inline.slice(exact.length + 1);
}

export function main(argv = process.argv.slice(2)) {
  const input = cliValue(argv, 'in');
  const out = cliValue(argv, 'out');
  if (!input || !out) {
    console.error('❌ uso: bonifica-sample.mjs --in <stock.jsonl> --out <sample.md> [--code a,b] [--locale a,b] [--min N]');
    return 2;
  }
  const rawMin = cliValue(argv, 'min');
  const min = rawMin === null ? DEFAULT_SAMPLE_MIN : Number(rawMin);
  if (!Number.isInteger(min) || min <= 0) {
    console.error(`❌ --min "${rawMin}" non e' un intero positivo.`);
    return 2;
  }
  const rows = parseJsonl(readFileSync(input, 'utf8'));
  const sections = buildSample(rows, {
    codes: splitList(cliValue(argv, 'code')),
    locales: splitList(cliValue(argv, 'locale')),
    min,
  });
  writeFileSync(out, renderSampleMarkdown(sections));
  for (const s of sections) console.log(`campione ${s.code}: ${s.rows.length} su ${s.total}`);
  return 0;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(2);
  }
}

/**
 * registry-canton-field.mjs — il campo multi-label `canton` nelle voci del
 * registry (`content/blog-articles-data.ts`, `content/swiss-articles-data.ts`).
 *
 * `canton` e' un campo INTERNO del corpus come `articleType`: non entra in
 * `articles.json`/`swiss-articles.json`, perche' `scripts/lib/registry-api-entry.mjs`
 * proietta la voce su un'allowlist che non lo contiene. Lo leggono gli hub
 * cantonali (D17 del piano sezioni cantonali) filtrando il corpus per cantone.
 *
 * Forma: `canton: ['TI', 'GR'],` con i codici dei 24 gruppi URL di
 * `generator/data/canton-url-slugs.json`, ordinati per punteggio decrescente.
 * Assente = nessun cantone assegnato (un articolo nazionale o italiano).
 *
 * Solo funzioni pure su testo: le importano il backfill e i test `node --test`
 * senza `npm ci`, e il registry resta un sorgente TS letto come testo (stesso
 * pattern di `registry-article-type.mjs:readRegistryEntries`).
 */

const CODE_RE = /^[A-Z]{2}$|^(?:APPENZELLO|BASILEA)$/u;

/**
 * Le voci del registry con la loro posizione: [{ id, start, end, text }].
 * `start`/`end` delimitano l'oggetto `{ ... }` della voce.
 */
export function registryEntrySpans(source) {
  const out = [];
  const rx = /\{\s*id:\s*'([^']+)'[\s\S]*?\}/gu;
  let m;
  while ((m = rx.exec(String(source || ''))) !== null) {
    out.push({ id: m[1], start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

/** Il valore di `canton` di una voce, o `undefined` se assente. */
export function readEntryCanton(entryText) {
  const m = /\bcanton:\s*\[([^\]]*)\]/u.exec(String(entryText || ''));
  if (!m) return undefined;
  return [...m[1].matchAll(/'([^']*)'/gu)].map((x) => x[1]);
}

/** `canton` per id, solo per le voci che lo hanno. */
export function readRegistryCantons(source) {
  const out = new Map();
  for (const { id, text } of registryEntrySpans(source)) {
    const cantons = readEntryCanton(text);
    if (cantons !== undefined) out.set(id, cantons);
  }
  return out;
}

/** La riga `canton: [...]`, con i codici validati (fail-closed). */
export function renderCantonLine(cantons, propIndent) {
  for (const c of cantons) {
    if (!CODE_RE.test(c)) throw new Error(`renderCantonLine: codice cantone non valido ${JSON.stringify(c)}`);
  }
  return `${propIndent}canton: [${cantons.map((c) => `'${c}'`).join(', ')}],`;
}

/**
 * Riscrive `canton` in UNA voce: lo inserisce dopo `articleType:` (o dopo
 * `hasCalculator:` per le voci senza tipo), lo sostituisce se c'e', lo toglie
 * se `cantons` e' vuoto. Le altre righe restano byte-identiche.
 */
export function setEntryCanton(entryText, cantons) {
  const lines = String(entryText).split('\n');
  const existing = lines.findIndex((l) => /^\s*canton:\s*\[/u.test(l));
  if (existing !== -1) lines.splice(existing, 1);
  if (cantons.length > 0) {
    let anchor = lines.findIndex((l) => /^\s*articleType:/u.test(l));
    if (anchor === -1) anchor = lines.findIndex((l) => /^\s*hasCalculator:/u.test(l));
    if (anchor === -1) throw new Error('setEntryCanton: voce senza articleType/hasCalculator su riga propria');
    const indent = /^(\s*)/u.exec(lines[anchor])[1];
    lines.splice(anchor + 1, 0, renderCantonLine(cantons, indent));
  }
  return lines.join('\n');
}

/**
 * Applica una mappa id -> cantoni al sorgente del registry. Le voci non
 * presenti nella mappa restano intatte.
 * @returns {{ source: string, changed: number }}
 */
export function applyRegistryCantons(source, cantonsById) {
  let out = '';
  let last = 0;
  let changed = 0;
  for (const span of registryEntrySpans(source)) {
    if (!cantonsById.has(span.id)) continue;
    const next = setEntryCanton(span.text, cantonsById.get(span.id));
    if (next === span.text) continue;
    out += source.slice(last, span.start) + next;
    last = span.end;
    changed += 1;
  }
  out += source.slice(last);
  return { source: out, changed };
}

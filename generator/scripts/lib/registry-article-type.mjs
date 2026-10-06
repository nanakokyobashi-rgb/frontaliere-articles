/**
 * registry-article-type.mjs — COSA e' un articolo (`articleType`) e COSA e'
 * stato verificato (`verifiedAt`), scritti nel registry degli articoli.
 *
 * ## Il difetto, misurato il 2026-10-03
 *
 * Il generatore sa che tipo di articolo sta scrivendo:
 * `RUN_REPORT.selectedArticleType` in `create-article.mjs` vale `news`,
 * `experimental`, `evergreen_static` o `evergreen_dynamic`. E lo buttava via
 * alla scrittura del registry: `modifyBlogArticlesTsx` emetteva soltanto `id`,
 * `category`, `date`, `image`, `hasCalculator` e l'autore. Su `origin/main`
 * `grep -c articleType content/blog-articles-data.ts` dava 0 su 4103 voci.
 *
 * L'unico segnale rimasto era la categoria (`fiscale|pratico|pensione`), che
 * l'audit evergreen del sito usa per dire «evergreen»: nel campione letto a
 * mano il 24-09 (valerielinc-ops/frontaliere-si-o-no, issue 9629) 48 slug su 85
 * erano cronaca datata, non guide. L'audit li contava come guide scadute.
 *
 * Il secondo buco e' la freschezza: l'audit usa `updatedAt || date`, e la issue
 * 7295 vieta di toccare la data se i fatti non cambiano. Un articolo verificato
 * e invariato non aveva quindi nessuna rappresentazione nel registry. Il campo
 * `verifiedAt` e' quella rappresentazione, ed e' letto SOLO dall'audit
 * evergreen: mai da sitemap, lastmod, JSON-LD o `dateModified`. Per non farne
 * un bump di data travestito, ogni `verifiedAt` deve avere la sua prova nel
 * ledger `data/evergreen-verifications.json` (fonti `https://` e fatti
 * verificati invariati): `verifiedAtProblems` qui sotto e' il controllo.
 *
 * ## Perche' un modulo a parte
 *
 * `create-article.mjs` ha dipendenze statiche (jsdom) presenti solo dove gira
 * `npm ci`, e i content gate di `main` (`scripts/ci/content-gates-main.mjs`)
 * girano senza `npm ci`. Un test che importasse `create-article.mjs` sarebbe
 * rosso su `main` dal primo giorno. Qui stanno quindi le funzioni pure,
 * importate sia dal generatore sia da `generator/tests/registry-article-type.test.mjs`.
 * Gli unici import sono `article-meta-block.mjs` (l'escape dei valori a singoli
 * apici ha una sola definizione) e `registry-canton-field.mjs` (la riga
 * `canton:`, scritta identica dal generatore e dal backfill), entrambi senza
 * dipendenze.
 */

import { escapeForSingleQuoteTS } from './article-meta-block.mjs';
import { registryEntrySpans, renderCantonLine } from './registry-canton-field.mjs';

/** I due valori ammessi nel registry. */
export const REGISTRY_ARTICLE_TYPES = Object.freeze(['news', 'evergreen']);

/** La riga `articleType:` usata sia dal generatore sia dai backfill. */
export function renderArticleTypeLine(articleType, propIndent) {
  if (!REGISTRY_ARTICLE_TYPES.includes(articleType)) {
    throw new Error(
      `renderArticleTypeLine: articleType non ammesso ${JSON.stringify(articleType)} `
        + `(ammessi: ${REGISTRY_ARTICLE_TYPES.join(', ')})`,
    );
  }
  return `${propIndent}articleType: '${articleType}',`;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Il tipo di registry dal tipo scelto dal generatore primario.
 *
 * `evergreen_static` / `evergreen_dynamic` → `evergreen`; tutto il resto
 * (`news`, `experimental`, `null`, `undefined`) → `news`. E' la semantica che
 * `resolveRunRecovery()` usava gia' per la riga di log: una definizione sola.
 *
 * @param {string|null|undefined} selectedArticleType
 * @returns {'news'|'evergreen'}
 */
export function registryArticleType(selectedArticleType) {
  return String(selectedArticleType || '').startsWith('evergreen') ? 'evergreen' : 'news';
}

/**
 * Il tipo di registry per il percorso AI primario di `create-article.mjs`.
 *
 * `selectedArticleType` e' un'etichetta di telemetria, non il tipo del
 * contenuto: il tier `experimental` del ranker converte il candidato in
 * `evergreen://<keyword>`, e la modalita' manuale con un URL `evergreen://`
 * lascia `selectedArticleType` a `null`. In entrambi i casi l'articolo nasce
 * dal prompt e dal facts brief EVERGREEN (il ramo `url.startsWith('evergreen://')`
 * di create-article.mjs): e' una guida, non cronaca datata. Decide quindi
 * prima la modalita' di generazione (l'URL), poi l'etichetta.
 *
 * @param {string|null|undefined} selectedArticleType
 * @param {string|null|undefined} url l'URL con cui l'articolo e' stato generato
 * @returns {'news'|'evergreen'}
 */
export function registryArticleTypeForRun(selectedArticleType, url) {
  if (String(url || '').startsWith('evergreen://')) return 'evergreen';
  return registryArticleType(selectedArticleType);
}

/**
 * Il tipo di registry per un produttore che entra da `registerArticleFiles()`.
 *
 * Un `data.articleType` esplicito vince, ma deve essere uno dei due valori
 * ammessi. Assente, decide `opts.skipNews`: e' gia' il modo in cui i produttori
 * dichiarano «non e' una notizia» (events-digest, border-wait-ranking,
 * pharmacy-evergreen), mentre daily-brief («a dated edition IS news») e il
 * giornalista non lo passano. Non e' un default cieco: e' la dichiarazione che
 * il produttore fa gia' per la sitemap news.
 *
 * @param {{articleType?: unknown}} data
 * @param {{skipNews?: boolean}} [opts]
 * @returns {'news'|'evergreen'}
 */
export function resolveArticleType(data, opts = {}) {
  const explicit = data?.articleType;
  if (explicit !== undefined) {
    if (!REGISTRY_ARTICLE_TYPES.includes(explicit)) {
      throw new Error(
        `resolveArticleType: articleType ${JSON.stringify(explicit)} non ammesso per "${data?.id}" `
          + `(ammessi: ${REGISTRY_ARTICLE_TYPES.join(', ')})`,
      );
    }
    return explicit;
  }
  return opts?.skipNews ? 'evergreen' : 'news';
}

/**
 * Le righe di una voce nuova del registry, nell'ordine in cui
 * `modifyBlogArticlesTsx` le ha sempre scritte, con `articleType` subito dopo
 * `hasCalculator` e, se l'articolo ha cantoni, `canton` subito dopo
 * `articleType`.
 *
 * Fail-closed: e' l'UNICO scrittore del registry, quindi un produttore futuro
 * che arriva qui senza passare da `registryArticleType`/`resolveArticleType`
 * fa lanciare la registrazione invece di scrivere una voce senza tipo.
 *
 * @param {{id: string, category: string, hasCalculator?: boolean, articleType?: unknown,
 *   canton?: string[], author?: {slug?: string, name?: string}}} data
 * @param {{objIndent: string, propIndent: string, today: string, imagePath: string}} layout
 * @returns {string[]}
 */
export function renderRegistryEntry(data, { objIndent, propIndent, today, imagePath }) {
  if (!REGISTRY_ARTICLE_TYPES.includes(data?.articleType)) {
    throw new Error(
      `renderRegistryEntry: articleType assente o non valido (${JSON.stringify(data?.articleType)}) `
        + `per "${data?.id}": ogni voce nuova del registry dichiara ${REGISTRY_ARTICLE_TYPES.join(' | ')}`,
    );
  }
  const lines = [
    `${objIndent}{`,
    `${propIndent}id: '${data.id}',`,
    `${propIndent}category: '${data.category}',`,
    `${propIndent}date: '${today}',`,
    `${propIndent}image: '${imagePath}',`,
    `${propIndent}hasCalculator: ${data.hasCalculator ? 'true' : 'false'},`,
    renderArticleTypeLine(data.articleType, propIndent),
  ];
  // D13 sezioni cantonali: il campo multi-label `canton`, interno al corpus
  // (fuori dall'allowlist di registry-api-entry.mjs). Assente se vuoto.
  if (Array.isArray(data.canton) && data.canton.length > 0) {
    lines.push(renderCantonLine(data.canton, propIndent));
  }
  // A2: persist byline so BlogArticles.tsx can render an author link.
  if (data.author?.slug) {
    lines.push(`${propIndent}authorSlug: '${escapeForSingleQuoteTS(data.author.slug)}',`);
  }
  if (data.author?.name) {
    lines.push(`${propIndent}authorName: '${escapeForSingleQuoteTS(data.author.name)}',`);
  }
  lines.push(`${objIndent}},`);
  return lines;
}

/**
 * Inserisce `articleType` in una voce legacy che ne è priva.
 * Le altre righe della voce restano byte-identiche.
 */
export function setEntryArticleType(entryText, articleType) {
  const lines = String(entryText).split('\n');
  const rendered = renderArticleTypeLine(articleType, '');
  const existing = lines.findIndex((line) => /^\s*articleType:/u.test(line));
  if (existing !== -1) {
    const current = lines[existing].trim();
    if (current === rendered) return entryText;
    throw new Error(`setEntryArticleType: voce con articleType diverso da ${rendered}`);
  }
  const anchor = lines.findIndex((line) => /^\s*hasCalculator:/u.test(line));
  if (anchor === -1) throw new Error('setEntryArticleType: voce senza hasCalculator su riga propria');
  const indent = /^(\s*)/u.exec(lines[anchor])[1];
  lines.splice(anchor + 1, 0, renderArticleTypeLine(articleType, indent));
  return lines.join('\n');
}

/** Applica una mappa id -> tipo, toccando solo le voci presenti nella mappa. */
export function applyRegistryArticleTypes(source, typesById) {
  let out = '';
  let last = 0;
  let changed = 0;
  for (const span of registryEntrySpans(source)) {
    if (!typesById.has(span.id)) continue;
    const next = setEntryArticleType(span.text, typesById.get(span.id));
    if (next === span.text) continue;
    out += source.slice(last, span.start) + next;
    last = span.end;
    changed += 1;
  }
  out += source.slice(last);
  return { source: out, changed };
}

/**
 * Le voci di un sorgente di registry, lette con lo stesso pattern di
 * `scripts/build-blog-index.mjs:readRegistry` (regex, non import del modulo
 * TS: questo modulo deve restare caricabile da `node` puro).
 *
 * @param {string} registrySource
 * @returns {{id: string, date: string, articleType?: string, verifiedAt?: string}[]}
 */
export function readRegistryEntries(registrySource) {
  const out = [];
  const rx = /\{\s*id:\s*'([^']+)'([\s\S]*?)\}/g;
  let m;
  while ((m = rx.exec(String(registrySource || ''))) !== null) {
    const [, id, body] = m;
    const pick = (k) => (body.match(new RegExp(`\\b${k}:\\s*'([^']*)'`)) ?? [])[1];
    out.push({
      id,
      date: pick('date') ?? '',
      articleType: pick('articleType'),
      verifiedAt: pick('verifiedAt'),
    });
  }
  return out;
}

/**
 * Le voci nate da `typedFrom` in poi senza `articleType: 'news'|'evergreen'`.
 *
 * `date` nel registry e' un ISO completo (`2026-10-05T07:12:00.000Z`) o una
 * data `YYYY-MM-DD`: il confronto lessicografico con `typedFrom` (`YYYY-MM-DD`)
 * e' corretto per entrambe.
 *
 * @param {string} registrySource
 * @param {string} typedFrom `YYYY-MM-DD`
 * @returns {{total: number, offenders: string[]}}
 */
export function scanRegistryTyping(registrySource, typedFrom) {
  if (!YMD_RE.test(String(typedFrom || ''))) {
    throw new Error(`scanRegistryTyping: typedFrom non e' una data YYYY-MM-DD: ${JSON.stringify(typedFrom)}`);
  }
  const entries = readRegistryEntries(registrySource);
  const offenders = entries
    .filter((e) => e.date >= typedFrom && !REGISTRY_ARTICLE_TYPES.includes(e.articleType))
    .map((e) => e.id);
  return { total: entries.length, offenders };
}

function isValidYmd(s) {
  if (!YMD_RE.test(String(s || ''))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * I difetti di `verifiedAt` nel registry rispetto al ledger delle verifiche.
 *
 * Una voce del ledger ha la forma
 * `{"<id>": {"verifiedAt": "YYYY-MM-DD", "sources": ["https://..."], "unchanged": ["<fatto>"]}}`.
 *
 * Regole: `verifiedAt` e' `YYYY-MM-DD` valido, non nel futuro rispetto a
 * `todayYmd`, non anteriore al giorno di `date`; ogni voce con `verifiedAt` ha
 * una voce di ledger con la STESSA data, almeno una fonte `https://` e almeno
 * un fatto `unchanged` non vuoto; ogni voce di ledger corrisponde a una voce
 * di registry con lo stesso `verifiedAt`.
 *
 * @param {{id: string, date: string, verifiedAt?: string}[]} entries
 * @param {Record<string, {verifiedAt?: unknown, sources?: unknown, unchanged?: unknown}>} ledger
 * @param {string} todayYmd
 * @returns {string[]} un messaggio per difetto; vuoto se tutto torna
 */
export function verifiedAtProblems(entries, ledger, todayYmd) {
  const problems = [];
  const book = ledger && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger : null;
  if (!book) return ['ledger delle verifiche non e\' un oggetto JSON'];
  const byId = new Map();
  for (const e of entries) {
    if (e.verifiedAt === undefined) continue;
    byId.set(e.id, e);
    const v = e.verifiedAt;
    if (!isValidYmd(v)) {
      problems.push(`${e.id}: verifiedAt ${JSON.stringify(v)} non e' una data YYYY-MM-DD`);
      continue;
    }
    if (v > todayYmd) problems.push(`${e.id}: verifiedAt ${v} nel futuro (oggi ${todayYmd})`);
    const born = String(e.date || '').slice(0, 10);
    if (born && v < born) problems.push(`${e.id}: verifiedAt ${v} anteriore a date ${born}`);
    const proof = Object.hasOwn(book, e.id) ? book[e.id] : undefined;
    if (!proof || typeof proof !== 'object') {
      problems.push(`${e.id}: verifiedAt ${v} senza voce nel ledger delle verifiche`);
      continue;
    }
    if (proof.verifiedAt !== v) {
      problems.push(`${e.id}: verifiedAt ${v} diverso dal ledger (${JSON.stringify(proof.verifiedAt)})`);
    }
    const sources = Array.isArray(proof.sources) ? proof.sources : [];
    if (!sources.some((s) => typeof s === 'string' && s.startsWith('https://'))) {
      problems.push(`${e.id}: ledger senza almeno una fonte https://`);
    }
    const unchanged = Array.isArray(proof.unchanged) ? proof.unchanged : [];
    if (!unchanged.some((f) => typeof f === 'string' && f.trim() !== '')) {
      problems.push(`${e.id}: ledger senza almeno un fatto verificato invariato`);
    }
  }
  // Il verso opposto: una prova senza voce. La data diversa e' gia' segnalata
  // sopra, dal lato del registry.
  for (const id of Object.keys(book)) {
    if (!byId.has(id)) problems.push(`${id}: voce di ledger senza verifiedAt nel registry`);
  }
  return problems;
}

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  hasUnclosedTypeScriptDelimiter,
  isTypeScriptObjectLiteralMemberStart,
  isPotentialTypeScriptObjectMemberStart,
  unsupportedObjectMemberAt,
} from './typescript-expression-scanner.mjs';
import { repairLegacyDoubleEscapedBreaks, tsStringEscapesWithNewlineAs } from '../../generator/scripts/lib/unescape-ts-string.mjs';

export const ARTICLE_BODY_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const MAX_ARTICLE_BODY_FIELDS = 20;
export const REQUIRED_ARTICLE_BODY_FIELDS = Object.freeze(['body1', 'body2', 'body3']);
export const MAX_ARTICLE_BODY_QUARANTINES = 3;

const BODY_FIELD_RE = /^body(?:[1-9]|1[0-9]|20)$/u;
const ARTICLE_KEY_RE = /^blog\.article\.([^'"\r\n]+)\.(body\d+|faq)$/u;
const ARTICLE_SECTION_RE = /^[a-z0-9-]+$/u;
const PAYLOAD_KEYS = Object.freeze(['schemaVersion', 'section', 'locale', 'id', 'revision', 'meta', 'translations']);
const META_KEYS = Object.freeze(['title', 'excerpt', 'imageAlt']);
function skipTrivia(source, offset) {
  let index = offset;
  while (index < source.length) {
    if (/\s/u.test(source[index])) {
      index += 1;
      continue;
    }
    if (source[index] !== '/' || index + 1 >= source.length) break;
    if (source[index + 1] === '/') {
      index += 2;
      while (index < source.length && !/[\r\n\u2028\u2029]/u.test(source[index])) index += 1;
      if (index < source.length) {
        index += source[index] === '\r' && source[index + 1] === '\n' ? 2 : 1;
      }
      continue;
    }
    if (source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      if (close < 0) throw new Error('Unterminated block comment in static article body source');
      index = close + 2;
      continue;
    }
    break;
  }
  return index;
}

function decodeTsLiteral(raw, quote) {
  let decoded = '';
  const escapes = {
    ...tsStringEscapesWithNewlineAs('\n'),
    ...(quote === '`' ? { '`': '`', '$': '$' } : {}),
  };
  for (let index = 0; index < raw.length;) {
    const ch = raw[index];
    if (ch !== '\\') {
      decoded += quote === '`' && ch === '\r' && raw[index + 1] === '\n' ? '\n' : ch;
      index += quote === '`' && ch === '\r' && raw[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (index + 1 >= raw.length) {
      decoded += ch;
      index += 1;
      continue;
    }
    const next = raw[index + 1];
    if (next === '\n' || next === '\r') {
      index += next === '\r' && raw[index + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (next === 'u') {
      const match = /^u([\da-fA-F]{4})/u.exec(raw.slice(index + 1));
      if (match) {
        decoded += String.fromCharCode(Number.parseInt(match[1], 16));
        index += match[0].length + 1;
        continue;
      }
    }
    decoded += Object.prototype.hasOwnProperty.call(escapes, next) ? escapes[next] : ch + next;
    index += 2;
  }
  return decoded;
}

function readQuotedToken(source, offset) {
  const quote = source[offset];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  const start = offset + 1;
  let index = start;
  let unescapedNewline = false;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') {
      index += index + 1 < source.length && source[index + 1] === '\r' && source[index + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (quote !== '`' && (ch === '\n' || ch === '\r')) unescapedNewline = true;
    if (quote === '`' && ch === '$' && source[index + 1] === '{') {
      throw new Error('Interpolated template literal is not supported in static article body source');
    }
    if (ch === quote) {
      const raw = source.slice(start, index);
      if (unescapedNewline) {
        return { value: null, raw, quote, end: index + 1, error: 'newline-in-quoted-string' };
      }
      return {
        value: decodeTsLiteral(raw, quote),
        raw,
        quote,
        end: index + 1,
        error: null,
      };
    }
    index += 1;
  }
  return { value: null, raw: source.slice(start), quote, end: source.length, error: 'unterminated-string' };
}

/**
 * Read all statically quoted article body properties from a TypeScript locale module.
 * The trailing-token check deliberately rejects concatenations, calls and other expressions.
 *
 * @returns {Array<{id:string,field:string,value:string|null,error:string|null}>}
 */
export function extractArticleBodyFields(source, { allowEndOfInput = false, validateDelimiter = true } = {}) {
  const text = String(source ?? '');
  if (validateDelimiter && !allowEndOfInput && hasUnclosedTypeScriptDelimiter(text)) {
    throw new Error('Unterminated delimiter in static article body source');
  }
  const entries = [];
  for (let index = 0; index < text.length;) {
    const afterTrivia = skipTrivia(text, index);
    if (afterTrivia !== index) {
      index = afterTrivia;
      continue;
    }
    const unsupportedObjectMember = isPotentialTypeScriptObjectMemberStart(text, index)
      ? unsupportedObjectMemberAt(text, index)
      : null;
    if (unsupportedObjectMember) {
      if (unsupportedObjectMember.kind === 'computed') {
        throw new Error('Computed article body properties are not supported in static source');
      }
      throw new Error('Dynamic article body object members are not supported in static source');
    }
    const keyToken = readQuotedToken(text, index);
    if (!keyToken) {
      index += 1;
      continue;
    }
    if (keyToken.error) {
      throw new Error('Malformed string token in static article body source: ' + keyToken.error);
    }
    const key = ARTICLE_KEY_RE.exec(keyToken.value ?? '');
    const colon = skipTrivia(text, keyToken.end);
    if (key && text[colon] !== ':' && isTypeScriptObjectLiteralMemberStart(text, index)) {
      throw new Error('Article body properties must use a static key/value property in object literals');
    }
    if (!key || keyToken.error || text[colon] !== ':') {
      index = keyToken.end;
      continue;
    }

    const valueStart = skipTrivia(text, colon + 1);
    const valueToken = readQuotedToken(text, valueStart);
    let error = valueToken?.error ?? null;
    let value = valueToken?.value ?? null;
    let end = valueToken?.end ?? valueStart;
    if (!valueToken) error = 'non-literal-value';
    if (valueToken && !error && validateDelimiter) {
      const delimiter = skipTrivia(text, valueToken.end);
      if (text[delimiter] !== ',' && text[delimiter] !== '}' && !(allowEndOfInput && delimiter === text.length)) {
        error = 'trailing-expression';
        value = null;
      }
    }
    if (key[2].startsWith('body') && value !== null) {
      value = repairLegacyDoubleEscapedBreaks(value);
    }
    entries.push({ id: key[1], field: key[2], value, error });
    index = Math.max(keyToken.end, end);
  }
  return entries;
}

/** Kept as the locale-completeness checker's historical body-only projection. */
export function extractBodyFields(source) {
  return extractArticleBodyFields(source, { allowEndOfInput: true, validateDelimiter: false })
    .filter(({ field }) => BODY_FIELD_RE.test(field))
    .map(({ id, field, value }) => ({ id, field, value }));
}

function sortedTranslations(translations) {
  const ordered = {};
  for (let index = 1; index <= MAX_ARTICLE_BODY_FIELDS; index += 1) {
    const field = `body${index}`;
    if (Object.prototype.hasOwnProperty.call(translations, field)) ordered[field] = translations[field];
  }
  if (Object.prototype.hasOwnProperty.call(translations, 'faq')) ordered.faq = translations.faq;
  return ordered;
}

function canonicalPayload(payload) {
  return {
    schemaVersion: 1,
    section: payload.section,
    locale: payload.locale,
    id: payload.id,
    meta: {
      title: payload.meta.title,
      excerpt: payload.meta.excerpt,
      imageAlt: payload.meta.imageAlt,
    },
    translations: sortedTranslations(payload.translations),
  };
}

/**
 * sha256-json-v1 hashes UTF-8 bytes from JSON.stringify with the fixed insertion
 * order in canonicalPayload; translations are body1..body20 numerically, then
 * faq. Text is not normalized, so the browser must hash the exact decoded strings.
 */
export function articleBodyRevision(payload) {
  return createHash('sha256').update(JSON.stringify(canonicalPayload(payload)), 'utf8').digest('hex');
}

function assertValidId(id, label = 'article id') {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
    throw new Error(`${label} non valido: ${String(id)}`);
  }
  if (id === 'index') {
    throw new Error(`${label} riservato: "index" collide con il file di indice articolo`);
  }
}

function assertValidSection(section) {
  if (typeof section !== 'string' || !ARTICLE_SECTION_RE.test(section)) {
    throw new Error(`section non valida: ${String(section)}`);
  }
}

function assertValidLocale(locale) {
  if (!ARTICLE_BODY_LOCALES.includes(locale)) throw new Error(`locale non valida: ${String(locale)}`);
}

function validatedRegistryIds(section, registry) {
  if (!Array.isArray(registry)) throw new Error(`${section}: registry non valido per article bodies`);
  const ids = registry.map((article) => article?.id);
  if (ids.some((id) => typeof id !== 'string')) throw new Error(`${section}: registry contiene id mancante`);
  if (new Set(ids).size !== ids.length) throw new Error(`${section}: registry contiene id duplicati`);
  for (const id of ids) assertValidId(id, `${section} registry id`);
  return ids;
}

function assertMeta(meta, id, locale) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error(`${id}/${locale}: meta assente`);
  const title = meta[`blog.article.${id}.title`];
  const excerpt = meta[`blog.article.${id}.excerpt`];
  const imageAlt = meta[`blog.article.${id}.imageAlt`];
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error(`${id}/${locale}: meta title mancante o vuoto`);
  }
  if (typeof excerpt !== 'string') {
    throw new Error(`${id}/${locale}: meta excerpt mancante o non testuale`);
  }
  if (imageAlt !== undefined && imageAlt !== null && typeof imageAlt !== 'string') {
    throw new Error(`${id}/${locale}: meta imageAlt non testuale`);
  }

  // title ed excerpt sono sempre presenti nei file metadata; excerpt può essere
  // vuoto. imageAlt è opzionale nel writer storico, quindi l'API lo rende
  // esplicito come null senza inventare una descrizione. Un valore composto
  // soltanto da whitespace è vuoto per il contratto.
  return {
    title,
    excerpt,
    imageAlt: imageAlt === undefined || imageAlt === null || imageAlt.trim() === '' ? null : imageAlt,
  };
}

export function buildArticleBodyPayload({ section, locale, id, meta, source }) {
  assertValidId(id);
  assertValidSection(section);
  assertValidLocale(locale);
  const articleMeta = assertMeta(meta, id, locale);
  const entries = extractArticleBodyFields(source);
  const translations = {};
  for (const entry of entries) {
    if (entry.id !== id) throw new Error(`${section}/${locale}/${id}: chiave body per id ${entry.id}`);
    if (entry.error) throw new Error(`${section}/${locale}/${id}.${entry.field}: ${entry.error}`);
    if (!BODY_FIELD_RE.test(entry.field) && entry.field !== 'faq') {
      throw new Error(`${section}/${locale}/${id}: campo non supportato ${entry.field}`);
    }
    if (Object.prototype.hasOwnProperty.call(translations, entry.field)) {
      throw new Error(`${section}/${locale}/${id}: campo duplicato ${entry.field}`);
    }
    if (typeof entry.value !== 'string' || !entry.value.trim()) {
      throw new Error(`${section}/${locale}/${id}.${entry.field}: valore vuoto`);
    }
    translations[entry.field] = entry.value;
  }
  for (const field of REQUIRED_ARTICLE_BODY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(translations, field)) {
      throw new Error(`${section}/${locale}/${id}: campo obbligatorio mancante ${field}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(translations, 'faq')) {
    let parsedFaq;
    try {
      parsedFaq = JSON.parse(translations.faq);
    } catch (error) {
      throw new Error(`${section}/${locale}/${id}.faq: JSON non valido (${error.message})`);
    }
    if (!Array.isArray(parsedFaq)) throw new Error(`${section}/${locale}/${id}.faq: atteso array JSON`);
  }
  const payload = {
    schemaVersion: 1,
    section,
    locale,
    id,
    meta: articleMeta,
    translations: sortedTranslations(translations),
  };
  return { ...payload, revision: articleBodyRevision(payload) };
}

export function articleBodyDocumentPath(section, locale, id) {
  assertValidSection(section);
  assertValidLocale(locale);
  assertValidId(id);
  return `bodies/${section}/${locale}/${id}.json`;
}

function assertPayloadShape(payload, { section, locale, id }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload non e\u0300 un oggetto');
  if (Object.keys(payload).sort().join(',') !== [...PAYLOAD_KEYS].sort().join(',')) throw new Error('schema payload non valido');
  if (payload.schemaVersion !== 1 || payload.section !== section || payload.locale !== locale || payload.id !== id) {
    throw new Error('identita\u0300 payload non corrispondente');
  }
  if (!payload.meta || typeof payload.meta !== 'object' || Array.isArray(payload.meta)
    || Object.keys(payload.meta).sort().join(',') !== [...META_KEYS].sort().join(',')) {
    throw new Error('meta payload non valido');
  }
  if (typeof payload.meta.title !== 'string' || !payload.meta.title.trim()
    || typeof payload.meta.excerpt !== 'string'
    || (payload.meta.imageAlt !== null
      && (typeof payload.meta.imageAlt !== 'string' || !payload.meta.imageAlt.trim()))) {
    throw new Error('meta payload incompleto');
  }
  if (!payload.translations || typeof payload.translations !== 'object' || Array.isArray(payload.translations)) {
    throw new Error('translations payload non valido');
  }
  const fields = Object.keys(payload.translations);
  if (fields.some((field) => !BODY_FIELD_RE.test(field) && field !== 'faq')) throw new Error('campo translations non supportato');
  if (REQUIRED_ARTICLE_BODY_FIELDS.some((field) => typeof payload.translations[field] !== 'string' || !payload.translations[field].trim())) {
    throw new Error('translations payload incompleto');
  }
  if (fields.some((field) => typeof payload.translations[field] !== 'string' || !payload.translations[field].trim())) {
    throw new Error('translations payload contiene valore vuoto');
  }
  if (Object.prototype.hasOwnProperty.call(payload.translations, 'faq')) {
    const faq = JSON.parse(payload.translations.faq);
    if (!Array.isArray(faq)) throw new Error('faq payload non e\u0300 un array');
  }
  if (payload.revision !== articleBodyRevision(payload)) throw new Error('revision payload non corrisponde al contenuto');
}

function readJson(filePath, description) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${description}: ${error.message}`);
  }
}

function quarantineReason(error) {
  const message = error?.message || String(error);
  return message.replace(/\s+/gu, ' ').trim().slice(0, 400) || 'errore non specificato';
}

export function assertArticleBodyQuarantineBudget(totals, limit = MAX_ARTICLE_BODY_QUARANTINES) {
  const quarantined = Number(totals?.quarantined);
  if (!Number.isInteger(quarantined) || quarantined < 0) {
    throw new Error(`article body API: conteggio quarantena non valido: ${String(totals?.quarantined)}`);
  }
  if (quarantined > limit) {
    throw new Error(
      `article body API: soglia quarantena superata (${quarantined} > ${limit}); ` +
        'rifiuto la superficie invece di pubblicare un set troppo incompleto',
    );
  }
}

export function appendArticleBodyQuarantineSummary(quarantined, summaryPath = process.env.GITHUB_STEP_SUMMARY) {
  if (!summaryPath || !Array.isArray(quarantined) || quarantined.length === 0) return;
  const lines = [
    '## Article body quarantine',
    '',
    `Articoli esclusi dalla superficie: **${quarantined.length}**. Soglia fail-closed: **${MAX_ARTICLE_BODY_QUARANTINES}**.`,
    '',
    '| Sorgente | Motivo |',
    '| --- | --- |',
    ...quarantined.map(({ source, reason }) => `| \`${source}\` | ${reason.replace(/\|/gu, '\\|')} |`),
    '',
  ];
  fs.appendFileSync(summaryPath, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * Emit section/locale indexes and payloads. A missing source file gets an explicit
 * index row; a present but unparseable/invalid body is quarantined and excluded
 * from payload output so one bad source cannot discard the whole surface.
 */
export function emitArticleBodyApi({
  root,
  outDir,
  locales = ARTICLE_BODY_LOCALES,
  sections,
  registries,
  publicSections,
  metaBySectionLocale,
  sanitize = (value) => value,
}) {
  const publicSet = publicSections instanceof Set ? publicSections : new Set(publicSections);
  // Validate every published identity before writing any body or index file.
  // Otherwise an id named `index` would overwrite this locale's index.json.
  const idsBySection = new Map();
  for (const section of sections) {
    assertValidSection(section.section);
    for (const locale of locales) assertValidLocale(locale);
    const registry = publicSet.has(section.section) ? registries[section.section] : [];
    idsBySection.set(section.section, validatedRegistryIds(section.section, registry));
  }
  const capabilitySections = {};
  const totals = { expected: 0, available: 0, missing: 0, quarantined: 0 };
  const quarantined = [];
  for (const section of sections) {
    const isPublic = publicSet.has(section.section);
    const ids = idsBySection.get(section.section);
    capabilitySections[section.section] = { status: isPublic ? 'public' : 'inactive', locales: {} };

    for (const locale of locales) {
      const entries = {};
      let availableCount = 0;
      let missingCount = 0;
      let quarantinedCount = 0;
      if (isPublic && ids.length > 0) {
        const sourceLocaleDir = path.join(root, section.bodyDir, locale);
        if (!fs.existsSync(sourceLocaleDir)) {
          throw new Error(`${section.bodyDir}/${locale}: directory assente per ${ids.length} articoli; refusing sparse/truncated source`);
        }
      }
      for (const id of ids) {
        assertValidId(id, `${section.section} registry id`);
        const relativeSource = path.join(section.bodyDir, locale, `${id}.ts`);
        const sourcePath = path.join(root, relativeSource);
        if (!fs.existsSync(sourcePath)) {
          entries[id] = { status: 'missing' };
          missingCount += 1;
          continue;
        }
        const meta = metaBySectionLocale?.[section.section]?.[locale];
        const source = fs.readFileSync(sourcePath, 'utf8');
        let payload;
        try {
          const rawPayload = buildArticleBodyPayload({
            section: section.section,
            locale,
            id,
            meta,
            source,
          });
          const cleanPayloadInput = sanitize({
            schemaVersion: rawPayload.schemaVersion,
            section: rawPayload.section,
            locale: rawPayload.locale,
            id: rawPayload.id,
            meta: rawPayload.meta,
            translations: rawPayload.translations,
          }, articleBodyDocumentPath(section.section, locale, id));
          const normalizedPayloadInput = typeof cleanPayloadInput.meta?.imageAlt === 'string'
            && cleanPayloadInput.meta.imageAlt.trim() === ''
            ? { ...cleanPayloadInput, meta: { ...cleanPayloadInput.meta, imageAlt: null } }
            : cleanPayloadInput;
          payload = { ...normalizedPayloadInput, revision: articleBodyRevision(normalizedPayloadInput) };
        } catch (error) {
          const reason = quarantineReason(error);
          const quarantine = {
            section: section.section,
            locale,
            id,
            source: relativeSource,
            reason,
          };
          quarantined.push(quarantine);
          quarantinedCount += 1;
          entries[id] = { status: 'quarantined', reason };
          console.warn(`::warning::article body quarantined: ${relativeSource} — ${reason}`);
          continue;
        }
        const relativeOutput = articleBodyDocumentPath(section.section, locale, id);
        const outputPath = path.join(outDir, relativeOutput);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, JSON.stringify(payload));
        entries[id] = { status: 'available', path: relativeOutput, expectedHash: payload.revision };
        availableCount += 1;
      }

      const status = isPublic ? 'public' : 'inactive';
      const expectedCount = ids.length;
      const index = {
        schemaVersion: 1,
        section: section.section,
        locale,
        status,
        expectedCount,
        availableCount,
        missingCount,
        quarantinedCount,
        entries,
      };
      const indexPath = `bodies/${section.section}/${locale}/index.json`;
      const absoluteIndex = path.join(outDir, indexPath);
      fs.mkdirSync(path.dirname(absoluteIndex), { recursive: true });
      fs.writeFileSync(absoluteIndex, JSON.stringify(sanitize(index, indexPath)));
      capabilitySections[section.section].locales[locale] = {
        index: indexPath,
        expected: expectedCount,
        available: availableCount,
        missing: missingCount,
        quarantined: quarantinedCount,
      };
      totals.expected += expectedCount;
      totals.available += availableCount;
      totals.missing += missingCount;
      totals.quarantined += quarantinedCount;
    }
  }
  return {
    capability: {
      schemaVersion: 1,
      revisionAlgorithm: 'sha256-json-v1',
      revisionCanonicalFields: [
        'schemaVersion', 'section', 'locale', 'id',
        'meta.title', 'meta.excerpt', 'meta.imageAlt',
        'translations.body1..body20 (present keys, numeric order)',
        'translations.faq (if present, last)',
      ],
      revisionTextEncoding: 'UTF-8',
      revisionUnicodeNormalization: 'none',
      indexPattern: 'bodies/{section}/{locale}/index.json',
      payloadPattern: 'bodies/{section}/{locale}/{id}.json',
      sections: capabilitySections,
    },
    totals,
    quarantined,
  };
}

/** Re-read every index and payload from disk; no in-memory writer state is trusted. */
export function verifyArticleBodyApiOnDisk({ outDir, capability, sections, registries, publicSections, locales = ARTICLE_BODY_LOCALES }) {
  const publicSet = publicSections instanceof Set ? publicSections : new Set(publicSections);
  const expectedPayloadPaths = new Set();
  const expectedIndexPaths = new Set();
  const totals = { expected: 0, available: 0, missing: 0, quarantined: 0 };
  const diskSections = {};

  for (const section of sections) {
    const isPublic = publicSet.has(section.section);
    assertValidSection(section.section);
    const registry = isPublic ? registries[section.section] : [];
    const ids = validatedRegistryIds(section.section, registry);
    diskSections[section.section] = { status: isPublic ? 'public' : 'inactive', locales: {} };
    for (const locale of locales) {
      assertValidLocale(locale);
      const indexPath = `bodies/${section.section}/${locale}/index.json`;
      expectedIndexPaths.add(indexPath);
      const index = readJson(path.join(outDir, indexPath), indexPath);
      const expectedCount = ids.length;
      if (index.schemaVersion !== 1 || index.section !== section.section || index.locale !== locale
        || index.status !== (isPublic ? 'public' : 'inactive')) {
        throw new Error(`${indexPath}: identity/status non valido`);
      }
      if (index.expectedCount !== expectedCount || !index.entries || typeof index.entries !== 'object' || Array.isArray(index.entries)) {
        throw new Error(`${indexPath}: expectedCount o entries non valido`);
      }
      const indexIds = Object.keys(index.entries);
      const missingIds = ids.filter((id) => !Object.prototype.hasOwnProperty.call(index.entries, id));
      const extraIds = indexIds.filter((id) => !ids.includes(id));
      if (missingIds.length || extraIds.length) {
        throw new Error(`${indexPath}: ID index non allineati (missing ${missingIds.length}, extra ${extraIds.length})`);
      }
      let availableCount = 0;
      let missingCount = 0;
      let quarantinedCount = 0;
      for (const id of ids) {
        const entry = index.entries[id];
        if (entry?.status === 'missing') {
          if (Object.keys(entry).length !== 1) throw new Error(`${indexPath}: missing entry contiene dati extra per ${id}`);
          missingCount += 1;
          continue;
        }
        if (entry?.status === 'quarantined') {
          if (Object.keys(entry).length !== 2 || typeof entry.reason !== 'string' || !entry.reason.trim()) {
            throw new Error(`${indexPath}: quarantined entry non valida per ${id}`);
          }
          quarantinedCount += 1;
          continue;
        }
        if (entry?.status !== 'available' || entry.path !== articleBodyDocumentPath(section.section, locale, id)
          || typeof entry.expectedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.expectedHash)) {
          throw new Error(`${indexPath}: entry non valida per ${id}`);
        }
        expectedPayloadPaths.add(entry.path);
        const payload = readJson(path.join(outDir, entry.path), entry.path);
        assertPayloadShape(payload, { section: section.section, locale, id });
        if (payload.revision !== entry.expectedHash) throw new Error(`${entry.path}: hash diverso dall'indice`);
        availableCount += 1;
      }
      if (index.availableCount !== availableCount || index.missingCount !== missingCount
        || index.quarantinedCount !== quarantinedCount
        || availableCount + missingCount + quarantinedCount !== expectedCount) {
        throw new Error(`${indexPath}: counts non corrispondono alle entries su disco`);
      }
      diskSections[section.section].locales[locale] = {
        index: indexPath,
        expected: expectedCount,
        available: availableCount,
        missing: missingCount,
        quarantined: quarantinedCount,
      };
      totals.expected += expectedCount;
      totals.available += availableCount;
      totals.missing += missingCount;
      totals.quarantined += quarantinedCount;
    }
  }

  const actualJsonPaths = new Set();
  const walk = (directory, relative = 'bodies') => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relativePath = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(absolute, relativePath);
      else if (entry.isFile() && entry.name.endsWith('.json')) actualJsonPaths.add(relativePath);
    }
  };
  walk(path.join(outDir, 'bodies'));
  for (const relativePath of expectedIndexPaths) {
    if (!actualJsonPaths.has(relativePath)) throw new Error(`${relativePath}: index assente dal set JSON su disco`);
  }
  const unexpected = [...actualJsonPaths].filter((relativePath) => !expectedIndexPaths.has(relativePath) && !expectedPayloadPaths.has(relativePath));
  if (unexpected.length) throw new Error(`article body API contiene JSON non indicizzati: ${unexpected.slice(0, 10).join(', ')}`);

  const expectedCapability = {
    schemaVersion: 1,
    revisionAlgorithm: 'sha256-json-v1',
    revisionCanonicalFields: [
      'schemaVersion', 'section', 'locale', 'id',
      'meta.title', 'meta.excerpt', 'meta.imageAlt',
      'translations.body1..body20 (present keys, numeric order)',
      'translations.faq (if present, last)',
    ],
    revisionTextEncoding: 'UTF-8',
    revisionUnicodeNormalization: 'none',
    indexPattern: 'bodies/{section}/{locale}/index.json',
    payloadPattern: 'bodies/{section}/{locale}/{id}.json',
    sections: diskSections,
  };
  if (JSON.stringify(capability) !== JSON.stringify(expectedCapability)) {
    throw new Error('manifest articleBodies capability non corrisponde agli indici su disco');
  }
  return { totals, sections: diskSections };
}

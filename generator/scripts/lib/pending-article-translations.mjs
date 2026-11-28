import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeJsonAtomic } from './atomic-write-json.mjs';
import { isSourcePassthrough } from './article-free-mt.mjs';
import { hasUsableTranslatedText } from './body2-payload-verdict.mjs';
import { pendingBodyTranslations } from './free-mt-recovery.mjs';

export const MAX_PENDING_TRANSLATION_ATTEMPTS = 3;
export const MAX_PENDING_TRANSLATION_DRAFTS_PER_SECTION = 50;

function draftFilePath(directory, articleId) {
  const key = createHash('sha256').update(articleId).digest('hex');
  return path.join(directory, `${key}.json`);
}

export function normalizePendingTranslationDraft(raw, expectedSection) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema !== 1) {
    throw new Error('pending translation draft has an unsupported schema');
  }
  const articleId = typeof raw.articleId === 'string' ? raw.articleId.trim() : '';
  const sourceUrl = typeof raw.sourceUrl === 'string' ? raw.sourceUrl.trim() : '';
  if (!articleId || !sourceUrl || raw.section !== expectedSection) {
    throw new Error('pending translation draft has an invalid article id, source URL, or section');
  }
  if (!Number.isInteger(raw.attempts) || raw.attempts < 1 || raw.attempts > MAX_PENDING_TRANSLATION_ATTEMPTS) {
    throw new Error(`pending translation draft has invalid attempt count for ${articleId}`);
  }
  if (typeof raw.pageContent !== 'string' || !raw.data?.content?.it || typeof raw.data.content.it !== 'object') {
    throw new Error(`pending translation draft is missing its verified Italian source for ${articleId}`);
  }
  if (raw.data.id !== articleId) {
    throw new Error(`pending translation draft article identity does not match its data for ${articleId}`);
  }
  if (!Array.isArray(raw.missingFields)) {
    throw new Error(`pending translation draft has invalid missing fields for ${articleId}`);
  }
  if (!raw.sourceContext || typeof raw.sourceContext !== 'object' || Array.isArray(raw.sourceContext)) {
    throw new Error(`pending translation draft has invalid source context for ${articleId}`);
  }
  for (const key of ['createdAt', 'updatedAt', 'verifiedAt']) {
    if (typeof raw[key] !== 'string' || Number.isNaN(Date.parse(raw[key]))) {
      throw new Error(`pending translation draft has invalid ${key} for ${articleId}`);
    }
  }
  const draft = {
    schema: 1,
    section: expectedSection,
    articleId,
    sourceUrl,
    sourceContext: raw.sourceContext,
    pageContent: raw.pageContent,
    sourceDate: typeof raw.sourceDate === 'string' ? raw.sourceDate : '',
    sourceTitle: typeof raw.sourceTitle === 'string' ? raw.sourceTitle : '',
    data: raw.data,
    attempts: raw.attempts,
    missingFields: [...new Set(raw.missingFields.map((field) => String(field)).filter(Boolean))],
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    verifiedAt: raw.verifiedAt,
  };
  if (draft.missingFields.some((field) => !pendingTranslationFieldDescriptors(draft.data).some((item) => item.key === field))) {
    throw new Error(`pending translation draft has an unknown missing field for ${articleId}`);
  }
  return draft;
}

/** Required translated fields derived from the verified Italian source. */
export function pendingTranslationFieldDescriptors(data) {
  const italian = data?.content?.it;
  if (!italian || typeof italian !== 'object' || Array.isArray(italian)) return [];
  const fields = [];
  for (const locale of ['en', 'de', 'fr']) {
    for (const field of ['title', 'excerpt']) {
      if (typeof italian[field] === 'string' && italian[field].trim()) {
        fields.push({ key: `${locale}.${field}`, locale, field, source: italian[field] });
      }
    }
    for (const field of Object.keys(italian)
      .filter((key) => /^body\d+$/.test(key) && typeof italian[key] === 'string' && italian[key].trim())
      .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))) {
      fields.push({ key: `${locale}.${field}`, locale, field, source: italian[field] });
    }
    if (Array.isArray(italian.faq)) {
      for (const [index, pair] of italian.faq.entries()) {
        for (const part of ['q', 'a']) {
          if (typeof pair?.[part] === 'string' && pair[part].trim()) {
            fields.push({
              key: `${locale}.faq[${index}].${part}`,
              locale,
              field: 'faq',
              faqIndex: index,
              faqPart: part,
              source: pair[part],
            });
          }
        }
      }
    }
  }
  return fields;
}

/** Only fields without a usable locale translation are retried. */
export function missingPendingTranslationFields(data) {
  const bodyPending = new Set(
    pendingBodyTranslations(data).map(({ locale, field }) => `${locale}.${field}`),
  );
  return pendingTranslationFieldDescriptors(data)
    .filter(({ key, locale, field, source, faqIndex, faqPart }) => {
      const content = data?.content?.[locale];
      const value = faqPart ? content?.faq?.[faqIndex]?.[faqPart] : content?.[field];
      return bodyPending.has(key)
        || !hasUsableTranslatedText(value, locale)
        || isSourcePassthrough(value, source);
    })
    .map(({ key }) => key);
}

/** Clear exactly the fields recorded as missing before a resume-only retry. */
export function clearPendingTranslationFields(data, missingFields) {
  if (!Array.isArray(missingFields)) throw new TypeError('missingFields must be an array');
  const descriptors = new Map(pendingTranslationFieldDescriptors(data).map((field) => [field.key, field]));
  for (const key of [...new Set(missingFields)]) {
    const descriptor = descriptors.get(key);
    if (!descriptor) throw new Error(`pending translation draft references unknown field '${key}'`);
    const content = data.content[descriptor.locale] ||= {};
    if (!descriptor.faqPart) {
      delete content[descriptor.field];
      continue;
    }
    if (!Array.isArray(content.faq)) content.faq = [];
    while (content.faq.length <= descriptor.faqIndex) content.faq.push({});
    if (!content.faq[descriptor.faqIndex] || typeof content.faq[descriptor.faqIndex] !== 'object') {
      content.faq[descriptor.faqIndex] = {};
    }
    delete content.faq[descriptor.faqIndex][descriptor.faqPart];
  }
  return data;
}

/** Claim exactly one resume run; a third claim exhausts the durable budget. */
export function claimPendingTranslationDraft(draft, { now = new Date().toISOString() } = {}) {
  if (!draft || typeof draft !== 'object' || !Number.isInteger(draft.attempts)) {
    throw new TypeError('claimPendingTranslationDraft requires a validated draft');
  }
  if (draft.attempts >= MAX_PENDING_TRANSLATION_ATTEMPTS) return null;
  return { ...draft, attempts: draft.attempts + 1, updatedAt: now };
}

/** Read every durable draft for one section. Corrupt state is a hard error. */
export function listPendingTranslationDrafts(directory, section) {
  if (!fs.existsSync(directory)) return [];
  const names = fs.readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  const drafts = names.map((name) => {
    const file = path.join(directory, name);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`cannot read pending translation draft ${name}: ${error.message}`);
    }
    const draft = normalizePendingTranslationDraft(raw, section);
    if (draftFilePath(directory, draft.articleId) !== file) {
      throw new Error(`pending translation draft ${name} does not match its article identity`);
    }
    return draft;
  });
  return drafts.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.articleId.localeCompare(b.articleId));
}

/** Atomically write one draft. The caller removes it after success/exhaustion. */
export function writePendingTranslationDraft(directory, section, rawDraft) {
  const draft = normalizePendingTranslationDraft(rawDraft, section);
  const target = draftFilePath(directory, draft.articleId);
  const current = listPendingTranslationDrafts(directory, section);
  const alreadyExists = current.some((entry) => entry.articleId === draft.articleId);
  if (!alreadyExists && current.length >= MAX_PENDING_TRANSLATION_DRAFTS_PER_SECTION) {
    throw new Error(`pending translation draft capacity reached for ${section}`);
  }
  writeJsonAtomic(target, draft);
  return { saved: true, exhausted: draft.attempts >= MAX_PENDING_TRANSLATION_ATTEMPTS, draft };
}

export function removePendingTranslationDraft(directory, articleId) {
  if (typeof articleId !== 'string' || !articleId.trim()) throw new Error('articleId is required');
  try {
    fs.unlinkSync(draftFilePath(directory, articleId.trim()));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

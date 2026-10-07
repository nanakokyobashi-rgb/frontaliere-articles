import '../../../host/cantonSectionsBootstrap.mjs';
import fs from 'node:fs';
import path from 'node:path';

import { ARTICLE_SECTION_CORE_ALL } from '../../../engine/shared/articleSectionCore.mjs';
import { corpusPath } from './corpus-paths.mjs';

let writeTmpSeq = 0;

function writeTextAtomic(root, relativePath, text) {
  const target = absolute(root, relativePath);
  const tmp = `${target}.${process.pid}.${writeTmpSeq++}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function absolute(root, relativePath) {
  return path.join(root, relativePath);
}

function registryDescriptors(registryFiles) {
  if (Array.isArray(registryFiles)) {
    return registryFiles.map((entry) => typeof entry === 'string'
      ? { path: entry, section: null }
      : { path: entry.path, section: entry.section || null });
  }

  const seen = new Set();
  const descriptors = [];
  for (const section of Object.values(ARTICLE_SECTION_CORE_ALL)) {
    const relativePath = corpusPath(section.registryFile);
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    descriptors.push({ path: relativePath, section: section.section });
  }
  return descriptors;
}

function articleIdRegex(articleId) {
  const escaped = String(articleId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*id:\\s*(['"])${escaped}\\1\\s*,?\\s*$`);
}

function imageLineRegex() {
  return /^(\s*image:\s*)(['"])([^'"]*)\2(\s*,?\s*)$/;
}

function seoSourcePaths(root, section) {
  const core = ARTICLE_SECTION_CORE_ALL[section];
  if (core?.kind === 'canton') {
    return [`content/cantons/${section}/seo.ts`];
  }
  if (section === 'svizzera') return ['content/seo/seo-blog-ch.ts'];

  const seoDir = absolute(root, 'content/seo');
  if (!fs.existsSync(seoDir)) return [];
  return fs.readdirSync(seoDir)
    .filter((name) => /^seo-blog(?:-\d+)?\.ts$/.test(name))
    .sort()
    .map((name) => path.join('content/seo', name));
}

function seoEntryRegex(articleId) {
  const escaped = String(articleId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*['"]blog-${escaped}['"]\\s*:\\s*\\{`, 'm');
}

function seoEntryEnd(source, start) {
  const next = /^\s*['"]blog-[^'"]+['"]\s*:\s*\{/gm;
  // `^\s*` may begin on the blank line before the current entry and consume
  // that newline, so starting at `start + 1` can rediscover the same entry.
  // Resume after the current entry's opening line instead.
  const currentEntryStart = source.indexOf('blog-', start);
  const currentLineEnd = source.indexOf('\n', currentEntryStart < 0 ? start : currentEntryStart);
  next.lastIndex = currentLineEnd < 0 ? source.length : currentLineEnd + 1;
  const match = next.exec(source);
  return match ? match.index : source.length;
}

function seoImageUrlLine(block) {
  const imageStart = block.indexOf('"image"');
  if (imageStart < 0) return null;
  const dateStart = block.indexOf('"datePublished"', imageStart);
  const imageBlock = block.slice(imageStart, dateStart < 0 ? undefined : dateStart);
  const template = /(\s*"url"\s*:\s*)`([^`\r\n]*)`/.exec(imageBlock);
  if (template) {
    return {
      line: template[0],
      offset: imageStart + template.index,
      prefix: template[1],
      value: template[2],
      suffix: '',
      kind: 'template',
    };
  }
  const quoted = /(\s*"url"\s*:\s*)(["'])([^"'\r\n]*)\2/.exec(imageBlock);
  if (!quoted) return null;
  return {
    line: quoted[0],
    offset: imageStart + quoted.index,
    prefix: quoted[1],
    quote: quoted[2],
    value: quoted[3],
    suffix: '',
    kind: 'quoted',
  };
}

function imagePathFromSeoValue(value) {
  const marker = String(value || '').indexOf('/images/');
  return marker >= 0 ? String(value).slice(marker) : String(value || '');
}

function renderSeoImageValue(location, imageUrl) {
  if (location.kind === 'template' && location.value.startsWith('${BASE_URL}')) {
    return `\`${'${BASE_URL}'}${imageUrl}\``;
  }
  if (location.kind === 'template') {
    const marker = location.value.indexOf('/images/');
    const prefix = marker >= 0 ? location.value.slice(0, marker) : location.value;
    return `\`${prefix}${imageUrl}\``;
  }
  const marker = location.value.indexOf('/images/');
  const prefix = marker >= 0 ? location.value.slice(0, marker) : '';
  return `${location.quote}${prefix}${imageUrl}${location.quote}`;
}

function objectStart(lines, idIndex) {
  for (let index = idIndex; index >= 0; index -= 1) {
    if (/^\s*\{\s*$/.test(lines[index])) return index;
  }
  return -1;
}

function objectEnd(lines, startIndex) {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\},?\s*$/.test(lines[index])) return index;
  }
  return -1;
}

function locateArticleInText(text, articleId, relativePath, section) {
  const lines = text.split('\n');
  const idPattern = articleIdRegex(articleId);
  const idIndexes = lines
    .map((line, index) => (idPattern.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (idIndexes.length === 0) return null;
  if (idIndexes.length > 1) {
    throw new Error(`article ${articleId} appears more than once in ${relativePath}`);
  }

  const idIndex = idIndexes[0];
  const startIndex = objectStart(lines, idIndex);
  const endIndex = startIndex < 0 ? -1 : objectEnd(lines, startIndex);
  if (startIndex < 0 || endIndex < 0 || idIndex > endIndex) {
    throw new Error(`cannot isolate article ${articleId} in ${relativePath}`);
  }

  let imageIndex = -1;
  let imageMatch = null;
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const match = lines[index].match(imageLineRegex());
    if (match) {
      if (imageIndex !== -1) throw new Error(`article ${articleId} has duplicate image fields in ${relativePath}`);
      imageIndex = index;
      imageMatch = match;
    }
  }
  if (imageIndex === -1) throw new Error(`article ${articleId} has no image field in ${relativePath}`);

  return {
    path: relativePath,
    section,
    text,
    lines,
    idIndex,
    startIndex,
    endIndex,
    imageIndex,
    previousImage: imageMatch[3],
  };
}

/** Locate exactly one registry entry for an article across all corpus sections. */
export function locateArticleRegistry(root, articleId, { registryFiles } = {}) {
  const matches = [];
  for (const descriptor of registryDescriptors(registryFiles)) {
    const relativePath = descriptor.path;
    if (!relativePath) throw new Error('article registry descriptor has no path');
    const absolutePath = absolute(root, relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    const located = locateArticleInText(
      fs.readFileSync(absolutePath, 'utf8'),
      articleId,
      relativePath,
      descriptor.section,
    );
    if (located) matches.push(located);
  }

  if (matches.length === 0) throw new Error(`article ${articleId} not found in a known article registry`);
  if (matches.length > 1) throw new Error(`article ${articleId} appears in multiple article registries`);
  return matches[0];
}

/**
 * Replace only the image literal in the already-located article object.
 * The caller can retain the returned previous text as a transaction snapshot.
 */
export function updateArticleImageInRegistry(root, articleId, imageUrl, options = {}) {
  const located = locateArticleRegistry(root, articleId, options);
  const currentLine = located.lines[located.imageIndex];
  const match = currentLine.match(imageLineRegex());
  if (!match) throw new Error(`article ${articleId} image field changed while updating ${located.path}`);

  if (match[3] === imageUrl) {
    return {
      ...located,
      changed: false,
      previousImage: match[3],
      nextText: located.text,
    };
  }

  located.lines[located.imageIndex] = `${match[1]}${match[2]}${imageUrl}${match[2]}${match[4]}`;
  const nextText = located.lines.join('\n');
  writeTextAtomic(root, located.path, nextText);
  return { ...located, changed: true, nextText };
}

/** Locate the canonical image URL inside an article's SEO/JSON-LD entry. */
export function locateArticleSeoImage(root, articleId, { section = 'frontaliere' } = {}) {
  const matches = [];
  for (const relativePath of seoSourcePaths(root, section)) {
    const absolutePath = absolute(root, relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    const source = fs.readFileSync(absolutePath, 'utf8');
    const marker = seoEntryRegex(articleId).exec(source);
    if (!marker) continue;
    const start = marker.index;
    const end = seoEntryEnd(source, start);
    const block = source.slice(start, end);
    const image = seoImageUrlLine(block);
    if (!image) {
      throw new Error(`SEO entry for article ${articleId} has no structuredData image URL in ${relativePath}`);
    }
    matches.push({
      path: relativePath,
      source,
      start,
      end,
      block,
      ...image,
      previousImage: imagePathFromSeoValue(image.value),
    });
  }

  if (matches.length === 0) {
    throw new Error(`article ${articleId} has no SEO entry in the ${section} section`);
  }
  if (matches.length > 1) {
    throw new Error(`article ${articleId} appears in multiple SEO entries`);
  }
  return matches[0];
}

/** Replace only the structured-data image URL in an existing SEO entry. */
export function updateArticleImageInSeo(root, articleId, imageUrl, options = {}) {
  const located = locateArticleSeoImage(root, articleId, options);
  if (located.previousImage === imageUrl) {
    return { ...located, changed: false, nextImage: imageUrl };
  }

  const replacement = `${located.prefix}${renderSeoImageValue(located, imageUrl)}${located.suffix}`;
  const lineStart = located.start + located.offset;
  const nextSource = located.source.slice(0, lineStart)
    + replacement
    + located.source.slice(lineStart + located.line.length);
  writeTextAtomic(root, located.path, nextSource);
  return {
    ...located,
    changed: true,
    previousImage: located.previousImage,
    nextImage: imageUrl,
    nextSource,
  };
}

export function registryPathForArticle(root, articleId, options = {}) {
  return locateArticleRegistry(root, articleId, options).path;
}

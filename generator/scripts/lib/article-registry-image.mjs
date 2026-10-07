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

export function registryPathForArticle(root, articleId, options = {}) {
  return locateArticleRegistry(root, articleId, options).path;
}

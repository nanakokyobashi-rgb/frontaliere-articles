import '../../../host/cantonSectionsBootstrap.mjs';
import fs from 'node:fs';
import path from 'node:path';

import { ARTICLE_SECTION_CORE_ALL } from '../../../engine/shared/articleSectionCore.mjs';
import { corpusPath } from './corpus-paths.mjs';
import { readTopLevelString, scanTopLevelArticleRecords } from '../../../scripts/lib/article-registry-reader.mjs';
import { writeFileSnapshotAtomically } from '../../../scripts/lib/write-file-pair-atomically.mjs';

function writeTextAtomic(root, relativePath, text, before) {
  const target = absolute(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeFileSnapshotAtomically(target, before, text);
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

function findMatchingObjectEnd(source, objectStart) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findObjectProperty(source, propertyName, from = 0, end = source.length) {
  const marker = `"${propertyName}"`;
  let quote = null;
  let escaped = false;
  for (let index = from; index < end; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (source.startsWith(marker, index)) {
      const property = new RegExp(`^${marker.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*:\\s*`).exec(
        source.slice(index, end),
      );
      if (property) {
        return {
          start: index,
          valueStart: index + property[0].length,
          prefix: property[0],
        };
      }
    }
    if (char === '"' || char === '\'' || char === '`') quote = char;
  }
  return null;
}

function imageObjectLocation(block) {
  const property = findObjectProperty(block, 'image');
  if (!property || block[property.valueStart] !== '{') return null;
  const end = findMatchingObjectEnd(block, property.valueStart);
  return end < 0 ? null : { start: property.start, objectStart: property.valueStart, end };
}

function findDirectObjectProperty(source, propertyName, objectStart, objectEnd) {
  const marker = `"${propertyName}"`;
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let index = objectStart + 1; index < objectEnd; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (depth === 1 && source.startsWith(marker, index)) {
      const property = new RegExp(`^${marker.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*:\\s*`).exec(
        source.slice(index, objectEnd),
      );
      if (property) {
        return {
          start: index,
          valueStart: index + property[0].length,
          prefix: property[0],
        };
      }
    }
    if (char === '"' || char === '\'' || char === '`') quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
  }
  return null;
}

function directUrlLocation(block, image) {
  const property = findDirectObjectProperty(block, 'url', image.objectStart, image.end);
  if (!property) return null;

  const valueQuote = block[property.valueStart];
  if (!['`', '"', '\''].includes(valueQuote)) return null;
  let valueEnd = property.valueStart + 1;
  let valueEscaped = false;
  for (; valueEnd < image.end; valueEnd += 1) {
    const char = block[valueEnd];
    if (valueEscaped) {
      valueEscaped = false;
    } else if (char === '\\') {
      valueEscaped = true;
    } else if (char === valueQuote) {
      break;
    }
  }
  if (valueEnd >= image.end) return null;
  return {
    line: block.slice(property.start, valueEnd + 1),
    offset: property.start,
    prefix: property.prefix,
    quote: valueQuote,
    value: block.slice(property.valueStart + 1, valueEnd),
    suffix: '',
    kind: valueQuote === '`' ? 'template' : 'quoted',
  };
}

function seoImageUrlLine(block) {
  const image = imageObjectLocation(block);
  const location = image ? directUrlLocation(block, image) : null;
  if (!location) return null;
  return {
    ...location,
    offset: location.offset,
  };
}

function consumeLineBreak(source, start) {
  if (source[start] === '\r') return source[start + 1] === '\n' ? start + 2 : start + 1;
  return source[start] === '\n' ? start + 1 : start;
}

function seoImageBlockRange(block) {
  const image = imageObjectLocation(block);
  if (!image) return null;
  const lineStart = block.lastIndexOf('\n', image.start) + 1;
  const prefix = block.slice(lineStart, image.start);
  const start = prefix.trim() === '' ? lineStart : image.start;
  let end = image.end + 1;
  if (block[end] === ',') end += 1;
  end = consumeLineBreak(block, end);
  return {
    start,
    end,
    text: block.slice(start, image.end + 1),
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

function locateArticleInText(text, articleId, relativePath, section) {
  const records = scanTopLevelArticleRecords(text).filter((record) => record.id === articleId);
  if (records.length === 0) return null;
  if (records.length > 1) {
    throw new Error(`article ${articleId} appears more than once in ${relativePath}`);
  }

  const record = records[0];
  const imageProperties = record.entries.filter(({ key }) => key === 'image');
  const imageProperty = imageProperties[0];
  const previousImage = readTopLevelString(record, 'image');
  if (imageProperties.length === 0 || previousImage === null) {
    throw new Error(`article ${articleId} has no image field in ${relativePath}`);
  }
  if (imageProperties.length > 1) {
    throw new Error(`article ${articleId} has duplicate image fields in ${relativePath}`);
  }

  const rawValue = text.slice(imageProperty.valueStart, imageProperty.valueEnd);
  const literal = rawValue.trim();
  const literalOffset = rawValue.indexOf(literal);
  const imageLiteralStart = imageProperty.valueStart + literalOffset;
  const imageLiteralEnd = imageLiteralStart + literal.length;
  const lineIndex = (offset) => text.slice(0, offset).split('\n').length - 1;
  const idProperty = record.properties.get('id');

  return {
    path: relativePath,
    section,
    text,
    lines: text.split('\n'),
    idIndex: lineIndex(idProperty.valueStart),
    startIndex: lineIndex(record.start),
    endIndex: lineIndex(record.end - 1),
    imageIndex: lineIndex(imageLiteralStart),
    imageLiteralStart,
    imageLiteralEnd,
    previousImage,
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
  const literal = located.text.slice(located.imageLiteralStart, located.imageLiteralEnd);
  const quote = literal[0];
  if (!['\'', '"'].includes(quote) || literal.at(-1) !== quote) {
    throw new Error(`article ${articleId} image field changed while updating ${located.path}`);
  }
  const currentImage = literal.slice(1, -1);

  if (currentImage === imageUrl) {
    return {
      ...located,
      changed: false,
      previousImage: currentImage,
      nextText: located.text,
    };
  }

  const nextText = located.text.slice(0, located.imageLiteralStart)
    + `${quote}${imageUrl}${quote}`
    + located.text.slice(located.imageLiteralEnd);
  writeTextAtomic(root, located.path, nextText, located.text);
  return { ...located, lines: nextText.split('\n'), changed: true, nextText };
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
    const imageBlock = seoImageBlockRange(block);
    matches.push({
      path: relativePath,
      source,
      start,
      end,
      block,
      ...image,
      ...(imageBlock ? {
        imageBlock: imageBlock.text,
        imageBlockStart: imageBlock.start,
        imageBlockEnd: imageBlock.end,
      } : {}),
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
  writeTextAtomic(root, located.path, nextSource, located.source);
  return {
    ...located,
    changed: true,
    previousImage: located.previousImage,
    nextImage: imageUrl,
    nextSource,
  };
}

/** Replace the complete structured-data ImageObject in an existing SEO entry. */
export function updateArticleSeoImageBlock(root, articleId, imageBlock, options = {}) {
  if (typeof imageBlock !== 'string' || imageBlock.trim() === '') {
    throw new TypeError('updateArticleSeoImageBlock: imageBlock is required');
  }
  const located = locateArticleSeoImage(root, articleId, options);
  if (located.imageBlockStart === undefined || located.imageBlockEnd === undefined) {
    throw new Error(`SEO entry for article ${articleId} has no complete ImageObject block`);
  }
  const normalizedBlock = imageBlock.replace(/\s+$/, '');
  if (located.imageBlock === normalizedBlock) {
    return { ...located, changed: false, nextSource: located.source };
  }

  const blockStart = located.start + located.imageBlockStart;
  const blockEnd = located.start + located.imageBlockEnd;
  const replacement = `${normalizedBlock},\n`;
  const nextSource = located.source.slice(0, blockStart)
    + replacement
    + located.source.slice(blockEnd);
  writeTextAtomic(root, located.path, nextSource, located.source);
  return {
    ...located,
    changed: true,
    imageBlock: normalizedBlock,
    nextSource,
  };
}

export function registryPathForArticle(root, articleId, options = {}) {
  return locateArticleRegistry(root, articleId, options).path;
}

/** Read static article fields with the shared source decoder and AST contract. */

import {
  parseStaticArticleTranslationEntries,
} from '../../../engine/shared/articleStaticSource.mjs';
import { decodeStaticString } from '../../../engine/shared/staticSourceAst.mjs';
import { loadArticleSourceTypeScript } from '../../../engine/shared/typescriptRuntime.mjs';

const ts = loadArticleSourceTypeScript();
const ARTICLE_KEY_PREFIX = 'blog.article.';

function articleFieldFromKey(key) {
  if (!key.startsWith(ARTICLE_KEY_PREFIX)) return null;
  const rest = key.slice(ARTICLE_KEY_PREFIX.length);
  const separator = rest.lastIndexOf('.');
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { articleId: rest.slice(0, separator), field: rest.slice(separator + 1) };
}

function staticArticleProperty(property) {
  if (
    !ts.isPropertyAssignment(property)
    || (!ts.isStringLiteral(property.name) && !ts.isNoSubstitutionTemplateLiteral(property.name))
  ) return false;
  return articleFieldFromKey(property.name.text) !== null;
}

function sourceArticleKeyInventory(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
  const inventory = [];
  let token = scanner.scan();

  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token !== ts.SyntaxKind.StringLiteral
      && token !== ts.SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      token = scanner.scan();
      continue;
    }

    const start = scanner.getTokenPos();
    const end = scanner.getTextPos();
    const next = scanner.scan();
    if (next === ts.SyntaxKind.ColonToken) {
      const literal = source.slice(start, end);
      const quote = literal[0];
      const key = decodeStaticString(literal.slice(1, -1), quote, { tabAs: '\t' });
      if (articleFieldFromKey(key) !== null) inventory.push({ key, start });
    }
    token = next;
  }

  return inventory;
}

function topLevelObjectLiterals(sourceFile) {
  const objects = [];
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) {
          objects.push(declaration.initializer);
        }
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      if (ts.isObjectLiteralExpression(statement.expression)) objects.push(statement.expression);
    }
  }
  return objects;
}

function missingCommaPosition(sourceFile, diagnostic) {
  if (diagnostic.code !== 1005 || typeof diagnostic.start !== 'number') return null;

  for (const object of topLevelObjectLiterals(sourceFile)) {
    const currentIndex = object.properties.findIndex(
      (property) => property.getStart(sourceFile) === diagnostic.start,
    );
    if (currentIndex < 1) continue;

    const previous = object.properties[currentIndex - 1];
    const current = object.properties[currentIndex];
    if (staticArticleProperty(previous) && staticArticleProperty(current)) {
      return previous.getEnd();
    }
  }
  return null;
}

function sourceLocation(sourceFile, offset) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
  return `${line + 1}:${character + 1}`;
}

function parseWithRecoverableSeparators(source, sourcePath) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const insertions = [];

  for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
    const position = missingCommaPosition(sourceFile, diagnostic);
    if (position === null) {
      const location = typeof diagnostic.start === 'number'
        ? sourceLocation(sourceFile, diagnostic.start)
        : 'unknown location';
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      throw new SyntaxError(`Unresolved TypeScript syntax diagnostic in ${sourcePath}:${location}: ${message}`);
    }
    insertions.push(position);
  }

  const uniqueInsertions = [...new Set(insertions)].sort((left, right) => left - right);
  let normalized = source;
  for (const position of uniqueInsertions.slice().reverse()) {
    normalized = `${normalized.slice(0, position)},${normalized.slice(position)}`;
  }

  return {
    normalized,
    toOriginalOffset(offset) {
      let original = offset;
      for (const position of uniqueInsertions) {
        if (position >= original) break;
        original -= 1;
      }
      return original;
    },
  };
}

/**
 * @returns {Array<{
 *   articleId: string,
 *   field: string,
 *   rawValue: string,
 *   value: string,
 *   quote: string,
 *   keyStart: number,
 *   valueStart: number,
 *   valueEnd: number,
 *   end: number,
 * }>}
 */
export function scanStaticArticleFieldEntries(source, sourcePath = 'article-source.ts') {
  const text = String(source ?? '');
  let entries;
  let toOriginalOffset = (offset) => offset;
  try {
    entries = parseStaticArticleTranslationEntries(text, sourcePath);
  } catch (error) {
    if (!(error instanceof SyntaxError) || !error.message.includes('TypeScript syntax error')) throw error;
    const recovered = parseWithRecoverableSeparators(text, sourcePath);
    if (recovered.normalized === text) throw error;
    entries = parseStaticArticleTranslationEntries(recovered.normalized, sourcePath);
    toOriginalOffset = recovered.toOriginalOffset;
  }

  const scannedEntries = entries.map((entry) => {
    const keyStart = toOriginalOffset(entry.index);
    const valueStart = toOriginalOffset(entry.valueStart);
    const valueEnd = toOriginalOffset(entry.valueEnd);
    return {
      articleId: entry.articleId,
      field: entry.field,
      rawValue: text.slice(valueStart, valueEnd),
      value: entry.value,
      quote: text[valueStart - 1],
      keyStart,
      valueStart,
      valueEnd,
      end: valueEnd + 1,
    };
  });

  assertStaticSourceComplete(text, scannedEntries, sourcePath);
  return scannedEntries;
}

/**
 * Ensure recovery never turns a partial AST into a successful scan.
 *
 * The parser is deliberately allowed to repair only missing separators between
 * adjacent article properties. The independent token inventory below keeps
 * that recovery fail-closed: comments and prose that merely contain article
 * keys are ignored, while every real static article key must still be present
 * exactly once in the returned entries and retain its original offset.
 */
export function assertStaticSourceComplete(source, entries, sourcePath = 'article-source.ts') {
  if (!Array.isArray(entries)) {
    throw new TypeError('static article entries must be an array');
  }

  const expected = sourceArticleKeyInventory(String(source ?? ''));
  const actual = entries.map(({ articleId, field, keyStart }) => ({
    key: `blog.article.${articleId}.${field}`,
    start: keyStart,
  }));
  const mismatch = expected.findIndex((entry, index) => {
    const candidate = actual[index];
    return !candidate || candidate.key !== entry.key || candidate.start !== entry.start;
  });

  if (mismatch !== -1 || expected.length !== actual.length) {
    const position = mismatch === -1 ? expected.length : mismatch;
    throw new SyntaxError(
      `Incomplete static article source scan in ${sourcePath}: `
      + `expected ${expected.length} article fields, scanned ${actual.length} `
      + `at entry ${position + 1}`,
    );
  }
}

/** Encode a cooked string as a static TypeScript string with its source delimiter. */
export function encodeStaticArticleFieldValue(value, quote) {
  const text = String(value ?? '');
  if (quote === '`') {
    return text
      .replaceAll('\\', '\\\\')
      .replaceAll('`', '\\`')
      .replaceAll('${', '\\${');
  }
  if (quote !== "'" && quote !== '"') {
    throw new TypeError(`Unsupported TypeScript string delimiter: ${String(quote)}`);
  }
  const escapedQuote = quote === "'" ? /'/gu : /"/gu;
  return text
    .replaceAll('\\', '\\\\')
    .replace(escapedQuote, '\\$&')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

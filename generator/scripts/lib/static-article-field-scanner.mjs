/**
 * Finds static article fields in top-level TypeScript object literals.
 *
 * The corpus uses flat object literals with quoted keys and static string
 * values, including template literals without substitutions.
 * Parsing the module with the pinned TypeScript compiler keeps strings,
 * comments, regular expressions, templates, type members, and nested examples
 * out of repair targets while preserving offsets into the original source.
 * The historical corpus has some syntax diagnostics; use parser recovery so
 * one malformed separator does not hide later static fields.
 */

import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';

const ARTICLE_KEY_PREFIX = 'blog.article.';
const require = createRequire(import.meta.url);
let cachedTypeScript;

function loadTypeScript() {
  if (cachedTypeScript) return cachedTypeScript;

  const configuredEntry = process.env.ARTICLE_SOURCE_TYPESCRIPT;
  if (configuredEntry !== undefined) {
    if (!isAbsolute(configuredEntry)) {
      throw new Error('ARTICLE_SOURCE_TYPESCRIPT must be an absolute path to the TypeScript compiler entry.');
    }
    cachedTypeScript = require(resolve(configuredEntry));
  } else {
    try {
      cachedTypeScript = require('typescript');
    } catch {
      throw new Error(
        'The static article field scanner requires TypeScript. Set ARTICLE_SOURCE_TYPESCRIPT using scripts/ci/article-source-runtime/README.md.',
      );
    }
  }

  if (typeof cachedTypeScript.createSourceFile !== 'function') {
    throw new Error('The configured TypeScript runtime does not expose createSourceFile().');
  }
  return cachedTypeScript;
}

function articleFieldFromKey(key) {
  if (!key.startsWith(ARTICLE_KEY_PREFIX)) return null;
  const rest = key.slice(ARTICLE_KEY_PREFIX.length);
  const separator = rest.lastIndexOf('.');
  if (separator <= 0 || separator === rest.length - 1) return null;
  return {
    articleId: rest.slice(0, separator),
    field: rest.slice(separator + 1),
  };
}

function staticPropertyName(ts, name) {
  if (
    ts.isStringLiteral(name)
    || ts.isNoSubstitutionTemplateLiteral(name)
    || ts.isIdentifier(name)
    || ts.isNumericLiteral(name)
  ) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(ts, name.expression);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text;
    }
  }

  return null;
}

function unwrapExpression(ts, expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function sourceLocation(sourceFile, offset) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
  return `line ${line + 1}, column ${character + 1}`;
}

function parseSource(ts, text) {
  return ts.createSourceFile(
    'article-source.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function topLevelObjectLiterals(ts, sourceFile) {
  const objects = [];
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer) {
          const initializer = unwrapExpression(ts, declaration.initializer);
          if (ts.isObjectLiteralExpression(initializer)) objects.push(initializer);
        }
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = unwrapExpression(ts, statement.expression);
      if (ts.isObjectLiteralExpression(expression)) objects.push(expression);
    }
  }
  return objects;
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
export function scanStaticArticleFieldEntries(source) {
  const text = String(source ?? '');
  const ts = loadTypeScript();
  const sourceFile = parseSource(ts, text);
  const entries = [];

  for (const object of topLevelObjectLiterals(ts, sourceFile)) {
    const isArticleMap = object.properties.some((property) => {
      if (!property.name) return false;
      const key = staticPropertyName(ts, property.name);
      return key !== null && articleFieldFromKey(key) !== null;
    });
    if (!isArticleMap) continue;

    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        const location = sourceLocation(sourceFile, property.getStart(sourceFile));
        throw new SyntaxError(`Top-level article map has a spread member at ${location}.`);
      }

      if (!property.name) {
        const location = sourceLocation(sourceFile, property.getStart(sourceFile));
        throw new SyntaxError(`Top-level article map has a member without a static name at ${location}.`);
      }

      const key = staticPropertyName(ts, property.name);
      if (key === null) {
        const location = sourceLocation(sourceFile, property.name.getStart(sourceFile));
        throw new SyntaxError(`Top-level article map has a dynamic member name at ${location}.`);
      }

      const field = articleFieldFromKey(key);
      if (!field) continue;

      if (!ts.isPropertyAssignment(property)) {
        const location = sourceLocation(sourceFile, property.name.getStart(sourceFile));
        throw new SyntaxError(`Static article field ${key} must be a property assignment at ${location}.`);
      }

      if (
        !ts.isStringLiteral(property.initializer)
        && !ts.isNoSubstitutionTemplateLiteral(property.initializer)
      ) {
        const location = sourceLocation(sourceFile, property.initializer.getStart(sourceFile));
        throw new SyntaxError(
          `Static article field ${key} must have a quoted string value at ${location}.`,
        );
      }

      const literalStart = property.initializer.getStart(sourceFile);
      const literalEnd = property.initializer.getEnd();
      const quote = text[literalStart];
      if (text[literalEnd - 1] !== quote) {
        const location = sourceLocation(sourceFile, literalStart);
        throw new SyntaxError(`Static article field ${key} has a malformed string literal at ${location}.`);
      }
      const valueStart = literalStart + 1;
      const valueEnd = literalEnd - 1;
      entries.push({
        ...field,
        rawValue: text.slice(valueStart, valueEnd),
        value: property.initializer.text,
        quote,
        keyStart: property.name.getStart(sourceFile),
        valueStart,
        valueEnd,
        end: property.initializer.getEnd(),
      });
    }
  }

  return entries;
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

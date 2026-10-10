import { matchingDelimiter } from './ts-literals.mjs';

function skipTrivia(source, start, limit = source.length) {
  let i = start;
  while (i < limit) {
    if (/\s/.test(source[i])) { i += 1; continue; }
    if (source[i] === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end === -1 || end >= limit ? limit : end + 1;
      continue;
    }
    if (source[i] === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1 || end + 2 > limit) throw new Error('commento non chiuso nel registro');
      i = end + 2;
      continue;
    }
    break;
  }
  return i;
}

function readString(source, start, limit = source.length) {
  const quote = source[start];
  if (quote !== "'" && quote !== '"') return null;
  let value = '';
  for (let i = start + 1; i < limit; i += 1) {
    const ch = source[i];
    if (ch === quote) return { value, end: i + 1 };
    if (ch === '\n' || ch === '\r') throw new Error('stringa non chiusa nel registro');
    if (ch !== '\\') { value += ch; continue; }
    i += 1;
    if (i >= limit) throw new Error('escape non chiuso nel registro');
    const escaped = source[i];
    const decoded = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }[escaped];
    value += decoded ?? escaped;
  }
  throw new Error('stringa non chiusa nel registro');
}

function skipString(source, start, limit) {
  const quote = source[start];
  for (let i = start + 1; i < limit; i += 1) {
    if (source[i] === '\\') { i += 1; continue; }
    if (source[i] === quote) return i + 1;
  }
  throw new Error('stringa non chiusa nel registro');
}

function readIdentifier(source, start, limit) {
  if (!/[A-Za-z_$]/.test(source[start] ?? '')) return null;
  let end = start + 1;
  while (end < limit && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
  return { value: source.slice(start, end), end };
}

function readKey(source, start, limit) {
  const ch = source[start];
  if (ch === "'" || ch === '"') {
    const token = readString(source, start, limit);
    return { key: token.value, end: token.end, computed: false };
  }
  if (ch === '[') {
    const close = matchingDelimiter(source, start);
    if (close === -1 || close >= limit) throw new Error('chiave calcolata non chiusa nel registro');
    const inner = skipTrivia(source, start + 1, close);
    const token = readString(source, inner, close);
    const tail = token ? skipTrivia(source, token.end, close) : close;
    return {
      key: token && tail === close ? token.value : null,
      end: close + 1,
      computed: true,
    };
  }
  const identifier = readIdentifier(source, start, limit);
  return identifier ? { key: identifier.value, end: identifier.end, computed: false } : null;
}

function skipValue(source, start, limit) {
  for (let i = start; i < limit;) {
    const ch = source[i];
    if (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      i = skipTrivia(source, i, limit);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { i = skipString(source, i, limit); continue; }
    if (ch === '{' || ch === '[' || ch === '(') {
      const close = matchingDelimiter(source, i);
      if (close === -1 || close >= limit) throw new Error('valore annidato non chiuso nel registro');
      i = close + 1;
      continue;
    }
    if (ch === ',' || ch === ';' || ch === '}') return i;
    i += 1;
  }
  return limit;
}

function hasNestedImage(source, start, limit, label) {
  for (let i = start; i < limit;) {
    if (source[i] === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      i = skipTrivia(source, i, limit);
      continue;
    }
    if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      i = skipString(source, i, limit);
      continue;
    }
    if (source[i] === '{') {
      const nested = parseObject(source, i, label);
      if (nested.properties.some(({ key }) => key === 'image')) return true;
      // Keep scanning inside this object for deeper nested image properties.
      i += 1;
      continue;
    }
    i += 1;
  }
  return false;
}

function parseObject(source, open, label) {
  const close = matchingDelimiter(source, open);
  if (close === -1) throw new Error(`${label}: oggetto di registro non chiuso`);
  const properties = [];
  let i = open + 1;
  while (i < close) {
    i = skipTrivia(source, i, close);
    if (source[i] === ',') { i += 1; continue; }
    if (i >= close) break;

    if (source.slice(i, i + 3) === '...') {
      const end = skipValue(source, skipTrivia(source, i + 3, close), close);
      properties.push({ key: null, kind: 'spread', start: i, end });
      i = end;
      continue;
    }

    let accessor = false;
    let keyStart = i;
    const prefix = readIdentifier(source, i, close);
    if (prefix && ['get', 'set', 'async'].includes(prefix.value)) {
      const next = skipTrivia(source, prefix.end, close);
      const candidate = readKey(source, next, close);
      const afterCandidate = candidate ? skipTrivia(source, candidate.end, close) : close;
      if (candidate && source[afterCandidate] === '(') {
        accessor = true;
        keyStart = next;
      }
    }
    const token = readKey(source, keyStart, close);
    if (!token) {
      // Invalid/unfamiliar syntax is not safe to use as evidence for a cover.
      throw new Error(`${label}: membro non riconosciuto nel registro`);
    }
    let after = skipTrivia(source, token.end, close);
    if (source[after] === '?' || source[after] === '!') after = skipTrivia(source, after + 1, close);
    const property = { key: token.key, computed: token.computed, accessor, kind: 'shorthand' };
    if (source[after] === ':') {
      const valueStart = skipTrivia(source, after + 1, close);
      const valueEnd = skipValue(source, valueStart, close);
      property.kind = 'value';
      property.raw = source.slice(valueStart, valueEnd).trim();
      property.valueStart = valueStart;
      property.valueEnd = valueEnd;
      after = valueEnd;
    } else if (source[after] === '(') {
      const argsEnd = matchingDelimiter(source, after);
      if (argsEnd === -1 || argsEnd >= close) throw new Error(`${label}: metodo non chiuso nel registro`);
      after = skipTrivia(source, argsEnd + 1, close);
      if (source[after] === '{') {
        const bodyEnd = matchingDelimiter(source, after);
        if (bodyEnd === -1 || bodyEnd >= close) throw new Error(`${label}: corpo metodo non chiuso nel registro`);
      after = skipTrivia(source, bodyEnd + 1, close);
      }
      property.kind = accessor ? 'accessor' : 'method';
    }
    properties.push(property);
    i = after;
    if (source[i] === ',' || source[i] === ';') i += 1;
    else if (i < close) throw new Error(`${label}: separatore proprietà non riconosciuto nel registro`);
  }
  return { close, properties, block: source.slice(open, close + 1) };
}

function staticLiteral(property) {
  if (property.kind !== 'value') return undefined;
  const raw = property.raw;
  if (raw[0] === "'" || raw[0] === '"') {
    const token = readString(raw, 0);
    if (skipTrivia(raw, token.end) === raw.length) return token.value;
    return undefined;
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

/**
 * Read the direct literal entries of a generated article registry. Nested
 * objects, strings, and comments are skipped; ambiguous image declarations
 * fail closed so callers never select or delete a guessed cover.
 */
export function readArticleRegistry(source, label = 'registry', { rejectNestedImage = false } = {}) {
  const entries = [];
  for (let i = 0; i < source.length;) {
    if (source[i] === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      i = skipTrivia(source, i);
      continue;
    }
    if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      i = skipString(source, i, source.length);
      continue;
    }
    if (source[i] !== '{') { i += 1; continue; }

    const object = parseObject(source, i, label);
    const idProperties = object.properties.filter(({ key }) => key === 'id');
    if (idProperties.length > 0) {
      const staticIds = idProperties.map(staticLiteral).filter((value) => typeof value === 'string' && value.length > 0);
      // TypeScript interfaces also declare `id: string`; only a static string
      // value is an article row. Dynamic row ids were never accepted by the
      // previous literal readers and are not evidence for a cover.
      if (staticIds.length === 0) { i += 1; continue; }
      if (idProperties.length !== 1 || staticIds.length !== 1) {
        throw new Error(`${label}: id del registro non è una stringa letterale univoca`);
      }
      const [id] = staticIds;
      if (object.properties.some(({ kind, computed }) => kind === 'spread' || computed)) {
        throw new Error(`${label} ${id}: spread o chiave calcolata, cover non determinabile`);
      }
      const images = object.properties.filter(({ key }) => key === 'image');
      if (images.length > 1) throw new Error(`${label} ${id}: proprietà image ripetuta, cover ambigua`);
      let image;
      if (images.length === 1) {
        image = staticLiteral(images[0]);
        if (typeof image !== 'string') {
          throw new Error(`${label} ${id}: image non è una stringa letterale statica`);
        }
      }
      if (rejectNestedImage && hasNestedImage(source, i + 1, object.close, label)) {
        throw new Error(`${label} ${id}: proprietà image annidata, cover ambigua`);
      }
      const fields = {};
      for (const property of object.properties) {
        if (property.key && !property.computed && property.kind === 'value') {
          const value = staticLiteral(property);
          if (value !== undefined) fields[property.key] = value;
        }
      }
      entries.push({ id, image, fields, block: object.block });
      i = object.close + 1;
      continue;
    }
    i += 1;
  }
  return entries;
}

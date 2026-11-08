/**
 * control-char-write-report.mjs — rende RUMOROSO e RECUPERABILE lo strip dei
 * control character in scrittura.
 *
 * ## Perche' esiste (issue #95)
 *
 * I sette choke point di scrittura portati da #75 risolvono «il byte non entra»
 * cancellandolo, e lo annunciano cosi':
 *
 *     console.error(`  ⚠️  write(${rel}): stripped N invalid C0 ...`);
 *
 * Nessun exit code diverso da 0, nessun contatore, nessun artefatto. Una riga
 * dentro un run che ne produce migliaia. Il rubinetto a monte (#66) non e'
 * chiuso — il body di #75 lo dichiara: «Pinpointing the exact upstream step
 * that mangles the accented character... not done» — quindi ogni articolo
 * nuovo puo' portare il difetto e nessuno lo sa.
 *
 * ## Il danno vero non e' lo strip: e' la perdita dell'ANCORA
 *
 * Il byte C0 non era il difetto, era il suo MARKER. La corruzione e' che un
 * carattere non-ASCII e' stato sostituito da `(byte C0 + cifra)`: togliere il
 * byte lascia la cifra dentro la parola — `compétences` diventa `comp9tences`
 * — e a quel punto il difetto e' indistinguibile da un refuso.
 *
 * Misurato il 2026-08-09: finche' il byte e' nel corpus la riparazione e'
 * ancorata ed esatta (`repair-mangled-chars.mjs` ne ha riparate 303 su 582
 * proprio cosi'). Dieci occorrenze erano gia' irrecuperabili perche' il
 * generatore aveva riscritto tre `content/blog-meta-*.ts` e questo guard
 * aveva tolto il byte lasciando la cifra orfana: `Il "territorio poroso"` e'
 * diventato `Il 3territorio poroso3`, e non c'e' piu' modo di sapere che li'
 * andava una virgoletta.
 *
 * Quindi il rimedio non e' «non strippare» — sanificare in uscita e' giusto e
 * resta — ma **conservare cio' che si sta per distruggere**, prima di
 * distruggerlo.
 *
 * ## I due buchi che restavano, e che questo file ora chiude (issue #94)
 *
 * **1. Non tutti gli strip sono uguali, e il rapporto non lo diceva.** Togliere
 * il byte da `<10>Der` lascia «Der», che era gia' la parola giusta: lo strip
 * qui perde un'ancora ma non rompe niente di leggibile. Toglierlo da
 * `comp<16>9tences` lascia **`comp9tences`**, cioe' una parola rotta che va
 * online, la legge il crawler, e da quel momento e' indistinguibile da un
 * refuso. Sono due eventi diversi con conseguenze diverse, e il contatore
 * unico li mescolava: `stripped` poteva salire di venti senza che nessuno dei
 * venti avesse rotto una parola, oppure con tutti e venti che l'avevano rotta.
 * Ora si contano separatamente (`residueCount`) e l'annotazione lo dice.
 *
 * **2. L'evidenza moriva col runner.** `DEFAULT_REPORT_PATH` sta sotto
 * `RUNNER_TEMP`, che GitHub cancella alla fine del job, e **nessun workflow del
 * repo carica quel file come artefatto** (verificato l'11-08-2026: zero
 * riferimenti a `CONTROL_CHAR_REPORT` e a `control-char-strips` fuori da questo
 * modulo). Quindi il contesto che #131 salva — l'unica cosa che rende esatta
 * una riparazione dopo — veniva scritto e buttato via nello stesso minuto. Ora
 * la stessa evidenza viene anche appesa a `GITHUB_STEP_SUMMARY`, che resta
 * attaccato alla run per sempre e non richiede di toccare nessun workflow.
 *
 * ## Guardia di scrittura
 *
 * La segnalazione da sola non protegge il corpus: i chiamanti scrivevano
 * comunque `clean` dopo il ritorno da questa funzione, perdendo il marker
 * esatto che serve per riparare il testo. Ora la funzione registra prima
 * l'evidenza e poi lancia; ogni choke point la chiama prima della scrittura,
 * quindi il sorgente originale resta intatto e il run fallisce chiuso.
 * L'eventuale errore di I/O del report viene segnalato ma non rende il testo
 * pubblicabile.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readTsStringMap } from './ts-string-map.mjs';

/** Dove finisce l'evidenza. Sovrascrivibile per i test. */
export const DEFAULT_REPORT_PATH = process.env.CONTROL_CHAR_REPORT
  || path.join(process.env.RUNNER_TEMP || process.env.TMPDIR || '/tmp', 'control-char-strips.jsonl');

/**
 * La finestra di contesto attorno a un marker, in caratteri.
 *
 * Serve a rendere la riparazione possibile DOPO: con il solo offset non si
 * ricostruisce la parola, e con la sola parola non si sa dove rimetterla.
 * Venti caratteri per lato coprono il token piu' lungo osservato nel corpus
 * (`provincia-di-varese-investe...`) senza trasformare il report in una copia
 * del contenuto.
 */
export const CONTEXT_CHARS = 20;

const C0 = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const REGEX_PREFIX_WORDS = new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await', 'else', 'do', 'new']);
const CONTROL_PAREN_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

function isInvalidC0(code) {
  return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
}

/** Svela le forme di escape che i writer HTML e JSON rimuovono. */
function decodeEscapedControlChars(value) {
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] !== '\\') {
      out += value[i];
      i += 1;
      continue;
    }
    const next = value[i + 1];
    if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(value.slice(i + 2, i + 4))) {
      const code = Number.parseInt(value.slice(i + 2, i + 4), 16);
      out += isInvalidC0(code) ? String.fromCharCode(code) : value.slice(i, i + 4);
      i += 4;
      continue;
    }
    if (next === 'u' && value[i + 2] === '{') {
      const end = value.indexOf('}', i + 3);
      const digits = end < 0 ? '' : value.slice(i + 3, end);
      if (/^[0-9a-fA-F]{1,6}$/.test(digits)) {
        const code = Number.parseInt(digits, 16);
        if (code <= 0x10ffff) {
          out += isInvalidC0(code) ? String.fromCodePoint(code) : value.slice(i, end + 1);
          i = end + 1;
          continue;
        }
      }
    }
    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(value.slice(i + 2, i + 6))) {
      const code = Number.parseInt(value.slice(i + 2, i + 6), 16);
      out += isInvalidC0(code) ? String.fromCharCode(code) : value.slice(i, i + 6);
      i += 6;
      continue;
    }
    if (/[0-7]/.test(next || '')) {
      // JavaScript non-strict strings and template quasis still interpret
      // legacy octal escapes. In particular, \07 is U+0007 and must not
      // cross the write gate as harmless-looking source text.
      const maxDigits = next <= '3' ? 3 : 2;
      let end = i + 2;
      while (end < value.length && end < i + 1 + maxDigits && /[0-7]/.test(value[end])) end += 1;
      const code = Number.parseInt(value.slice(i + 1, end), 8);
      out += isInvalidC0(code) ? String.fromCharCode(code) : value.slice(i, end);
      i = end;
      continue;
    }
    if (next === 'b' || next === 'f' || next === 'v') {
      const code = { b: 0x08, f: 0x0c, v: 0x0b }[next];
      out += String.fromCharCode(code);
      i += 2;
      continue;
    }
    out += value.slice(i, i + 2);
    i += 2;
  }
  return out;
}

function collectJsonStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectJsonStrings(item, out);
    }
  }
  return out;
}

function findTemplateExpressionClose(source, openingBrace) {
  let depth = 1;
  let index = openingBrace + 1;
  let canStartRegex = true;
  let lastIdentifier = null;
  const controlParens = [];
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '/' && next === '/') {
      index += 2;
      while (index < source.length && !/[\r\n\u2028\u2029]/u.test(source[index])) index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    if (character === '\'' || character === '"') {
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === '\\') { end += 2; continue; }
        if (source[end] === character) break;
        end += 1;
      }
      index = Math.min(source.length, end + 1);
      canStartRegex = false;
      lastIdentifier = null;
      continue;
    }
    if (character === '`') {
      index = skipTemplateLiteral(source, index);
      canStartRegex = false;
      lastIdentifier = null;
      continue;
    }
    if (character === '/' && canStartRegex) {
      let end = index + 1;
      let inClass = false;
      while (end < source.length) {
        const current = source[end];
        if (current === '\\') { end += 2; continue; }
        if (/[\r\n\u2028\u2029]/u.test(current)) break;
        if (current === '[') inClass = true;
        else if (current === ']' && inClass) inClass = false;
        else if (current === '/' && !inClass) {
          end += 1;
          while (/[A-Za-z]/u.test(source[end] || '')) end += 1;
          break;
        }
        end += 1;
      }
      if (end > index + 1 && !/[\r\n]/u.test(source[end - 1])) {
        index = end;
        canStartRegex = false;
        lastIdentifier = null;
        continue;
      }
    }
    if (/[A-Za-z_$]/u.test(character)) {
      let end = index + 1;
      while (/[A-Za-z0-9_$]/u.test(source[end] || '')) end += 1;
      const word = source.slice(index, end);
      index = end;
      canStartRegex = REGEX_PREFIX_WORDS.has(word);
      lastIdentifier = word;
      continue;
    }
    if (character === '(') {
      controlParens.push(CONTROL_PAREN_KEYWORDS.has(lastIdentifier));
      canStartRegex = true;
      lastIdentifier = null;
      index += 1;
      continue;
    }
    if (character === ')') {
      canStartRegex = controlParens.pop() ?? false;
      lastIdentifier = null;
      index += 1;
      continue;
    }
    if (character === '{') {
      depth += 1;
      canStartRegex = true;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
      canStartRegex = false;
    } else if (!/\s/u.test(character)) {
      canStartRegex = '([{,;:=!?&|+-%^~<>'.includes(character) || character === '/';
      lastIdentifier = null;
    }
    index += 1;
  }
  return -1;
}

function skipTemplateLiteral(source, start) {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue; }
    if (source[index] === '`') return index + 1;
    if (source[index] === '$' && source[index + 1] === '{') {
      const close = findTemplateExpressionClose(source, index + 1);
      if (close < 0) return source.length;
      index = close + 1;
      continue;
    }
    index += 1;
  }
  return source.length;
}

function decodeTemplateSegments(body, decodeStaticSegments) {
  let output = '';
  let index = 0;
  let segmentStart = 0;
  while (index < body.length) {
    if (body[index] === '\\') { index += 2; continue; }
    if (body[index] === '$' && body[index + 1] === '{') {
      const close = findTemplateExpressionClose(body, index + 1);
      if (close < 0) return output + body.slice(segmentStart);
      const staticSegment = body.slice(segmentStart, index);
      output += decodeStaticSegments ? decodeEscapedControlChars(staticSegment) : staticSegment;
      output += '${' + decodeScriptEscapesOutsideComments(body.slice(index + 2, close)) + '}';
      index = close + 1;
      segmentStart = index;
      continue;
    }
    index += 1;
  }
  const staticSegment = body.slice(segmentStart);
  return output + (decodeStaticSegments ? decodeEscapedControlChars(staticSegment) : staticSegment);
}

function decodeScriptEscapesOutsideComments(source) {
  let output = '';
  let index = 0;
  let canStartRegex = true;
  let lastIdentifier = null;
  let pendingFunctionParams = false;
  let pendingFunctionBody = false;
  let blockPending = false;
  let declarationBlockPending = false;
  let statementStart = true;
  let labelCandidate = false;
  let stringDotPending = false;
  let stringRawTag = false;
  let globalStringIdentifier = false;
  let lastSignificant = null;
  const controlParens = [];
  const braceContexts = [];

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '/' && next === '/') {
      let stop = index + 2;
      while (stop < source.length && !/[\r\n\u2028\u2029]/u.test(source[stop])) stop += 1;
      output += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (character === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      const stop = close < 0 ? source.length : close + 2;
      output += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (character === '\'' || character === '"') {
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === '\\') { end += 2; continue; }
        if (source[end] === character) break;
        end += 1;
      }
      if (end >= source.length) {
        output += source.slice(index);
        break;
      }
      output += character + decodeEscapedControlChars(source.slice(index + 1, end)) + character;
      index = end + 1;
      canStartRegex = false;
      lastIdentifier = null;
      blockPending = false;
      statementStart = false;
      labelCandidate = false;
      stringDotPending = false;
      stringRawTag = false;
      globalStringIdentifier = false;
      lastSignificant = 'literal';
      continue;
    }
    if (character === '`') {
      const stop = skipTemplateLiteral(source, index);
      const end = stop > index && source[stop - 1] === '`' ? stop - 1 : source.length;
      const templateBody = source.slice(index + 1, end);
      const preserveRawSegments = !canStartRegex && stringRawTag;
      output += '`' + decodeTemplateSegments(templateBody, !preserveRawSegments) + (end < source.length ? '`' : '');
      index = stop;
      canStartRegex = false;
      lastIdentifier = null;
      blockPending = false;
      statementStart = false;
      labelCandidate = false;
      stringDotPending = false;
      stringRawTag = false;
      globalStringIdentifier = false;
      lastSignificant = 'literal';
      continue;
    }
    if (character === '/' && canStartRegex) {
      let end = index + 1;
      let inClass = false;
      while (end < source.length) {
        const current = source[end];
        if (current === '\\') { end += 2; continue; }
        if (current === '\n' || current === '\r' || current === '\u2028' || current === '\u2029') break;
        if (current === '[') inClass = true;
        else if (current === ']' && inClass) inClass = false;
        else if (current === '/' && !inClass) {
          end += 1;
          while (/[A-Za-z]/.test(source[end] || '')) end += 1;
          break;
        }
        end += 1;
      }
      if (end > index + 1 && source[end - 1] !== '\n' && source[end - 1] !== '\r') {
        output += source.slice(index, end);
        index = end;
        canStartRegex = false;
        lastIdentifier = null;
        blockPending = false;
        statementStart = false;
        labelCandidate = false;
        stringDotPending = false;
        stringRawTag = false;
        globalStringIdentifier = false;
        lastSignificant = 'literal';
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1;
      while (/[A-Za-z0-9_$]/.test(source[end] || '')) end += 1;
      const word = source.slice(index, end);
      const precedingSignificant = lastSignificant;
      output += word;
      index = end;
      canStartRegex = REGEX_PREFIX_WORDS.has(word);
      labelCandidate = statementStart;
      statementStart = false;
      stringRawTag = word === 'raw' && stringDotPending;
      globalStringIdentifier = word === 'String' && precedingSignificant !== '.';
      stringDotPending = false;
      lastIdentifier = word;
      lastSignificant = word;
      if (word === 'function') {
        pendingFunctionParams = true;
        blockPending = false;
      } else if (['class', 'enum', 'interface', 'namespace'].includes(word)) {
        declarationBlockPending = true;
        blockPending = true;
      } else if (['do', 'else', 'finally', 'try'].includes(word)) {
        blockPending = true;
      } else if (!pendingFunctionParams && !declarationBlockPending) {
        blockPending = false;
      }
      continue;
    }
    if (character === '(') {
      output += character;
      index += 1;
      controlParens.push({
        control: CONTROL_PAREN_KEYWORDS.has(lastIdentifier),
        functionParams: pendingFunctionParams,
      });
      pendingFunctionParams = false;
      canStartRegex = true;
      lastIdentifier = null;
      labelCandidate = false;
      statementStart = false;
      stringDotPending = false;
      stringRawTag = false;
      globalStringIdentifier = false;
      lastSignificant = '(';
      continue;
    }
    if (character === ')') {
      output += character;
      index += 1;
      const context = controlParens.pop();
      canStartRegex = context?.control ?? false;
      pendingFunctionBody = context?.functionParams ?? false;
      if (context?.control) blockPending = true;
      lastIdentifier = null;
      labelCandidate = false;
      statementStart = context?.control ?? false;
      stringDotPending = false;
      stringRawTag = false;
      globalStringIdentifier = false;
      lastSignificant = ')';
      continue;
    }
    if (source.startsWith('=>', index)) {
      output += '=>';
      index += 2;
      canStartRegex = true;
      lastIdentifier = null;
      blockPending = false;
      statementStart = false;
      labelCandidate = false;
      stringDotPending = false;
      stringRawTag = false;
      globalStringIdentifier = false;
      lastSignificant = '=>';
      continue;
    }
    if (character === '{') {
      const objectPrefix = ['=', ':', '(', '[', ',', '?'].includes(lastSignificant)
        || ['return', 'throw', 'yield'].includes(lastIdentifier);
      const isBlock = blockPending || pendingFunctionBody || declarationBlockPending || !objectPrefix;
      braceContexts.push(isBlock);
      output += character;
      index += 1;
      canStartRegex = true;
      lastIdentifier = null;
      blockPending = false;
      declarationBlockPending = false;
      pendingFunctionBody = false;
      statementStart = isBlock;
      labelCandidate = false;
      stringDotPending = false;
      stringRawTag = false;
      globalStringIdentifier = false;
      lastSignificant = '{';
      continue;
    }
    if (character === '}') {
      output += character;
      index += 1;
      const isBlock = braceContexts.pop() ?? false;
      canStartRegex = isBlock;
      lastIdentifier = null;
      blockPending = false;
      statementStart = isBlock;
      labelCandidate = false;
      stringDotPending = false;
      stringRawTag = false;
      globalStringIdentifier = false;
      lastSignificant = '}';
      continue;
    }
    output += character;
    index += 1;
    if (!/\s/u.test(character)) {
      const isStringDot = character === '.' && lastIdentifier === 'String' && globalStringIdentifier;
      if (character === ':' && labelCandidate) {
        blockPending = true;
        statementStart = true;
      } else if (character === ';') {
        statementStart = true;
      } else {
        statementStart = false;
      }
      canStartRegex = '([{,;:=!?&|+-%^~<>'.includes(character) || character === '/';
      lastIdentifier = null;
      labelCandidate = false;
      if (pendingFunctionParams && character !== '*') pendingFunctionParams = false;
      if (character !== ';' && character !== ':' && !declarationBlockPending) blockPending = false;
      stringDotPending = isStringDot;
      stringRawTag = false;
      globalStringIdentifier = false;
      lastSignificant = character;
    }
  }
  return output;
}

function decodeXmlReferencesOutsideLiterals(xml) {
  const decode = (text) => text.replace(/&#(x[0-9a-fA-F]+|[0-9]+);/g, (reference, digits) => {
    const code = digits[0] === 'x'
      ? Number.parseInt(digits.slice(1), 16)
      : Number.parseInt(digits, 10);
    return Number.isFinite(code) && isInvalidC0(code) ? String.fromCharCode(code) : reference;
  });
  let output = '';
  let index = 0;
  while (index < xml.length) {
    const comment = xml.indexOf('<!--', index);
    const cdata = xml.indexOf('<![CDATA[', index);
    const processingInstruction = xml.indexOf('<?', index);
    const commentStart = comment < 0 ? xml.length : comment;
    const cdataStart = cdata < 0 ? xml.length : cdata;
    const processingInstructionStart = processingInstruction < 0 ? xml.length : processingInstruction;
    const start = Math.min(commentStart, cdataStart, processingInstructionStart);
    if (start < 0) return output + decode(xml.slice(index));
    if (start === xml.length) return output + decode(xml.slice(index));
    output += decode(xml.slice(index, start));
    const closeMarker = start === commentStart ? '-->' : start === cdataStart ? ']]>' : '?>';
    const openLength = start === commentStart ? 4 : start === cdataStart ? 9 : 2;
    const close = xml.indexOf(closeMarker, start + openLength);
    if (close < 0) return output + xml.slice(start);
    output += xml.slice(start, close + closeMarker.length);
    index = close + closeMarker.length;
  }
  return output;
}

function articleSourceReportableText(file, original) {
  const normalizedFile = String(file).replaceAll('\\', '/');
  const isBodySource = /(?:^|\/)content\/blog-body[^/]*\/[^/]+\/[^/]+\.ts$/u.test(normalizedFile);
  const isMetaSource = /(?:^|\/)content\/blog-meta[^/]*\.ts$/u.test(normalizedFile);
  if (!isBodySource && !isMetaSource) return null;

  C0.lastIndex = 0;
  const hasRawC0 = C0.test(original);
  C0.lastIndex = 0;
  if (hasRawC0) return original;

  const text = [];
  for (const [key, value] of readTsStringMap(original)) {
    text.push(key);
    if (key.endsWith('.faq')) {
      try {
        text.push(...collectJsonStrings(JSON.parse(value)));
      } catch {
        // The article parser rejects invalid FAQ JSON; keep the source intact here.
        text.push(value);
      }
    } else {
      text.push(value);
    }
  }
  return text.length > 0 ? text.join('\n') : original;
}

function findHtmlTagEnd(html, start) {
  let quote = null;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === '\'') {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

function hasHtmlAttribute(attributes, expectedName) {
  let index = 0;
  while (index < attributes.length) {
    while (index < attributes.length && (/\s/u.test(attributes[index]) || attributes[index] === '/')) index += 1;
    const start = index;
    while (index < attributes.length && !/[\s=/>]/u.test(attributes[index])) index += 1;
    if (start === index) {
      index += 1;
      continue;
    }
    if (attributes.slice(start, index).toLowerCase() === expectedName) return true;
    while (index < attributes.length && /\s/u.test(attributes[index])) index += 1;
    if (attributes[index] !== '=') continue;
    index += 1;
    while (index < attributes.length && /\s/u.test(attributes[index])) index += 1;
    const quote = attributes[index];
    if (quote === '"' || quote === '\'') {
      index += 1;
      while (index < attributes.length && attributes[index] !== quote) index += 1;
      if (index < attributes.length) index += 1;
    } else {
      while (index < attributes.length && !/\s/u.test(attributes[index])) index += 1;
    }
  }
  return false;
}

function decodeInlineScriptBodies(html) {
  let output = '';
  let cursor = 0;
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open < 0) break;
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      index = close < 0 ? html.length : close + 3;
      continue;
    }
    if (html[open + 1] === '/' || html[open + 1] === '!' || html[open + 1] === '?') {
      const end = findHtmlTagEnd(html, open + 2);
      index = end < 0 ? html.length : end + 1;
      continue;
    }
    let nameEnd = open + 1;
    while (/[A-Za-z0-9:-]/u.test(html[nameEnd] || '')) nameEnd += 1;
    if (nameEnd === open + 1) {
      index = open + 1;
      continue;
    }
    const tagName = html.slice(open + 1, nameEnd).toLowerCase();
    const tagEnd = findHtmlTagEnd(html, nameEnd);
    if (tagEnd < 0) break;
    if (tagName !== 'script') {
      index = tagEnd + 1;
      continue;
    }

    const closePattern = /<\/script(?=[\t\n\f\r />])/gi;
    closePattern.lastIndex = tagEnd + 1;
    const closeStart = closePattern.exec(html);
    if (!closeStart) break;
    const closeEnd = findHtmlTagEnd(html, closeStart.index + '</script'.length);
    if (closeEnd < 0) break;
    const closeText = html.slice(closeStart.index, closeEnd + 1);
    const body = html.slice(tagEnd + 1, closeStart.index);
    output += html.slice(cursor, tagEnd + 1);
    output += hasHtmlAttribute(html.slice(nameEnd, tagEnd), 'src')
      ? body
      : decodeScriptEscapesOutsideComments(body);
    output += closeText;
    cursor = closeEnd + 1;
    index = cursor;
  }
  return output + html.slice(cursor);
}

function reportableText(file, original) {
  // JSON.parse reveals both value and key escapes (for example `\\b` and
  // `\\u0016`) before sanitizeDeep removes the resulting character.
  try {
    return collectJsonStrings(JSON.parse(original)).join('\n');
  } catch {
    // The other writer formats are not necessarily JSON documents.
  }

  const extension = path.extname(file).toLowerCase();
  if (extension === '.ts') {
    const articleSourceText = articleSourceReportableText(file, original);
    if (articleSourceText !== null) return articleSourceText;
  }
  if (extension === '.xml') {
    return decodeXmlReferencesOutsideLiterals(original);
  }

  if (extension === '.html' || extension === '.htm') {
    return decodeInlineScriptBodies(original);
  }
  return original;
}

const LETTERA = /\p{L}/u;
const CIFRA = /[0-9]/;

let stripped = 0;
let residue = 0;
let files = new Set();

/** Quante occorrenze sono state strippate in questo processo. */
export function strippedCount() {
  return stripped;
}

/** Quante di quelle lasciavano dietro una parola rotta. */
export function residueCount() {
  return residue;
}

/**
 * True se togliere il marker in posizione `at` incolla una cifra a una lettera.
 *
 * E' la firma del difetto, e non e' una euristica su un testo gia' scritto: si
 * guarda cosa il byte tiene separato NEL MOMENTO in cui lo si toglie. Tre
 * forme, tutte osservate nel corpus:
 *
 *     comp<16>9tences   lettera prima, cifra dopo    -> comp9tences
 *     sar<17>0 l'inf    lettera prima, cifra dopo    -> sar0 l'inferno
 *     Il <08>3territor  cifra dopo, lettera dopo     -> Il 3territorio
 *
 * `<10>Der` invece non lascia residuo: prima c'e' uno spazio, dopo una lettera,
 * e senza il byte resta «Der», che e' la parola che ci andava. Perdere l'ancora
 * li' e' un peccato, non un danno leggibile — e distinguere i due casi e' cio'
 * che permette di misurare quanti difetti NUOVI e invisibili ogni run manda
 * online, invece di contare byte che non rompono niente.
 */
export function stripLasciaResiduo(original, at) {
  const prima = original[at - 1] || '';
  const dopo = original[at + 1] || '';
  const poi = original[at + 2] || '';
  if (LETTERA.test(prima) && CIFRA.test(dopo)) return true;
  if (CIFRA.test(prima) && LETTERA.test(dopo)) return true;
  if (CIFRA.test(dopo) && LETTERA.test(poi)) return true;
  return false;
}

/** Quanti file distinti ne sono stati toccati. */
export function strippedFiles() {
  return [...files];
}

/** Azzera i contatori. Solo per i test: in produzione il processo e' monouso. */
export function resetCounters() {
  stripped = 0;
  residue = 0;
  files = new Set();
}

/**
 * Le occorrenze da registrare, con il contesto che le rende riparabili.
 * Pura: nessun I/O, cosi' i test la esercitano senza toccare il disco.
 */
export function occurrencesIn(original, { contextChars = CONTEXT_CHARS } = {}) {
  const out = [];
  if (typeof original !== 'string') return out;
  C0.lastIndex = 0;
  for (const m of original.matchAll(C0)) {
    const at = m.index;
    out.push({
      at,
      byte: original.charCodeAt(at),
      // `residuo: true` = togliere questo byte rompe una parola. E' il campo
      // che separa «ho perso un'ancora» da «ho appena pubblicato comp9tences».
      residuo: stripLasciaResiduo(original, at),
      // Il contesto e' PRIMA dello strip: e' l'unico momento in cui la coppia
      // (byte, carattere seguente) esiste ancora, ed e' quella coppia a dire
      // quale carattere e' andato perso.
      context: original.slice(Math.max(0, at - contextChars), at + contextChars + 1),
    });
  }
  return out;
}

/** Scrive l'evidenza prima di rifiutare l'output. */
function reportOccurrences(file, occ, opts = {}) {
  if (occ.length === 0) return 0;

  const log = opts.log || ((s) => console.error(s));
  const io = opts.fsImpl || fs;
  const reportPath = opts.reportPath || DEFAULT_REPORT_PATH;

  const conResiduo = occ.filter((o) => o.residuo);
  stripped += occ.length;
  residue += conResiduo.length;
  files.add(file);

  // `::error::` e non `::warning::`: un warning in un run che ne produce
  // migliaia e' cio' che ha reso questo difetto invisibile per settimane.
  // Il conteggio dei residui identifica le parole a rischio; il throw
  // successivo blocca la scrittura e preserva l'ancora nel sorgente.
  log(
    `::error::control-char-strip: ${file} portava ${occ.length} control character C0, ` +
    `di cui ${conResiduo.length} che rompono una parola (es. comp<16>9tences -> comp9tences). ` +
    'Scrittura rifiutata prima di togliere il marker o l\'escape, che resta disponibile per la riparazione. ' +
    'Evidenza in ' + reportPath + ' (issue #95, causa a monte #66).',
  );

  try {
    io.mkdirSync(path.dirname(reportPath), { recursive: true });
    const lines = occ.map((o) => JSON.stringify({ file, ...o })).join('\n') + '\n';
    io.appendFileSync(reportPath, lines, 'utf-8');
  } catch (err) {
    // Il report e' un di piu': anche se il disco non collabora, il throw sotto
    // impedisce comunque di scrivere il contenuto sanificato.
    log(`::warning::control-char-strip: impossibile scrivere ${reportPath}: ${err.message}`);
  }

  appendStepSummary(file, occ, opts);

  throw new Error(
    `control-char-write-report: scrittura rifiutata per ${file}: `
      + `${occ.length} control character C0 non ammessi (${conResiduo.length} rompono una parola); `
      + 'sorgente preservato, ripararlo o metterlo in quarantena prima di riprovare.',
  );
}

function assertNoUntracedChange(file, original, clean, opts, changed = clean !== original) {
  if (!changed || opts.allowExpectedRewrite === true) return;
  const log = opts.log || ((s) => console.error(s));
  const reportPath = opts.reportPath || DEFAULT_REPORT_PATH;
  log(
    `::error::control-char-sanitize: ${file} e' cambiato durante la sanificazione `
    + 'senza un control character C0 riconoscibile da registrare. '
    + 'Scrittura rifiutata per conservare la sorgente e consentire la diagnosi. '
    + 'Evidenza attesa in ' + reportPath + '.',
  );
  throw new Error(
    `control-char-write-report: scrittura rifiutata per ${file}: `
    + 'sanificazione non tracciata (clean differisce da original senza un marker C0 riconoscibile); '
    + 'sorgente preservato, verificare la rappresentazione prima di riprovare.',
  );
}

/**
 * Controlla il valore originale prima della write, svelando le rappresentazioni
 * che i writer JSON, XML e HTML interpretano o rimuovono.
 *
 * @param {string} file path del file che si sta per scrivere
 * @param {string} original contenuto com'era, coi marker ancora dentro
 * @param {string} _clean contenuto sanificato che il chiamante intende scrivere
 * @param {{reportPath?: string, log?: (s: string) => void, fsImpl?: typeof fs, allowExpectedRewrite?: boolean}} [opts]
 * @returns {0} se l'originale non contiene control character C0 non ammessi
 * @throws {Error} se l'originale contiene C0, dopo aver registrato l'evidenza
 */
export function reportStrippedControlChars(file, original, clean, opts = {}) {
  if (typeof original !== 'string') return 0;
  const occurrences = occurrencesIn(reportableText(file, original));
  if (occurrences.length === 0) assertNoUntracedChange(file, original, clean, opts);
  return reportOccurrences(file, occurrences, opts);
}

/**
 * La stessa evidenza, ma dove sopravvive alla run.
 *
 * `reportPath` sta sotto `RUNNER_TEMP`, che GitHub cancella a fine job, e
 * nessun workflow di questo repo lo carica come artefatto: il contesto che
 * rende riparabile l'occorrenza veniva scritto e cancellato nello stesso
 * minuto. `GITHUB_STEP_SUMMARY` invece resta attaccato alla run, si legge
 * dall'interfaccia e — decisivo qui — **non richiede di modificare nessun
 * workflow**, quindi non puo' essere dimenticato dal prossimo che ne aggiunge
 * uno che scrive in `content/`.
 *
 * I byte C0 non ci vanno crudi: il sommario e' Markdown reso in HTML, e un byte
 * di controllo li' dentro e' esattamente il difetto che questo modulo esiste
 * per non propagare. Si scrivono come `<XX>`, che e' la forma leggibile e la
 * stessa che usa `repair-mangled-chars.mjs` nei suoi rapporti.
 */
function appendStepSummary(file, occ, opts = {}) {
  const dest = opts.summaryPath !== undefined ? opts.summaryPath : process.env.GITHUB_STEP_SUMMARY;
  if (!dest) return;
  const io = opts.fsImpl || fs;
  // `C0` esclude apposta 0x09/0x0A/0x0D (sono legali), ma sono proprio quelli
  // che spezzano una riga di tabella Markdown: un a capo crudo nel contesto
  // fa traboccare la cella su piu' righe e corrompe la resa per tutte le righe
  // successive — stesso difetto, stessa fix di `leggibile()` in
  // `repair-mangled-chars.mjs` (issue #94).
  const visibile = (s) => String(s)
    .replace(C0, (c) => `<${c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}>`)
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  const righe = [
    '',
    `### control-char-strip — \`${file}\``,
    '',
    `${occ.length} control character C0 rilevati; scrittura rifiutata. ${occ.filter((o) => o.residuo).length} avrebbero rotto una parola dopo lo strip.`,
    '',
    '| offset | byte | rompe una parola | contesto (prima dello strip) |',
    '|---|---|---|---|',
    ...occ.map((o) => `| ${o.at} | 0x${o.byte.toString(16).padStart(2, '0')} | ${o.residuo ? 'si' : 'no'} | \`${visibile(o.context).replace(/\|/g, '\\|')}\` |`),
    '',
  ];
  try {
    io.appendFileSync(dest, righe.join('\n'), 'utf-8');
  } catch {
    // Come sopra: l'evidenza e' un di piu', la scrittura del contenuto no.
  }
}

/**
 * Le foglie stringa di una struttura, in ordine di visita, unite da `\n`.
 *
 * Serve a `reportStrippedControlCharsDeep`. `\n` e' 0x0A, che **non** e' nella
 * classe C0 che questo modulo cerca: unire con quello non puo' inventare ne'
 * nascondere un'occorrenza.
 */
function joinStringLeaves(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) joinStringLeaves(v, out);
  else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      out.push(key);
      joinStringLeaves(nested, out);
    }
  }
  return out;
}

function sameSanitizedStructure(original, clean) {
  if (Object.is(original, clean)) return true;
  if (!original || !clean || typeof original !== 'object' || typeof clean !== 'object') return false;
  const originalIsArray = Array.isArray(original);
  if (originalIsArray !== Array.isArray(clean)) return false;
  if (originalIsArray && original.length !== clean.length) return false;
  if (!originalIsArray) {
    const originalPrototype = Object.getPrototypeOf(original);
    const cleanPrototype = Object.getPrototypeOf(clean);
    const originalIsPlain = originalPrototype === Object.prototype || originalPrototype === null;
    const cleanIsPlain = cleanPrototype === Object.prototype || cleanPrototype === null;
    if (!originalIsPlain || !cleanIsPlain) return false;
  }

  const originalKeys = Object.keys(original);
  const cleanKeys = Object.keys(clean);
  if (originalKeys.length !== cleanKeys.length) return false;
  for (const key of originalKeys) {
    if (!Object.hasOwn(clean, key) || !sameSanitizedStructure(original[key], clean[key])) return false;
  }
  return true;
}

/**
 * Come `reportStrippedControlChars`, ma per un valore STRUTTURATO che sta per
 * essere serializzato.
 *
 * ## Perche' non basta la versione a stringhe (issue #133)
 *
 * Il richiamo istintivo sarebbe confrontare `JSON.stringify(original)` con
 * `JSON.stringify(clean)`. Non funziona: **`JSON.stringify` escapa i byte C0**
 * in `\u0016`, quindi la forma serializzata non contiene piu' il byte letterale e
 * la regex di `occurrencesIn` non trova nulla. E' la stessa ragione per cui, nel
 * corpus, un grep di byte sui `.json` non vedeva la corruzione mentre i `.ts` la
 * mostravano.
 *
 * Quindi si guardano le chiavi e le foglie stringa **prima** della
 * serializzazione, che e' l'unico momento in cui il byte esiste come byte.
 */
export function reportStrippedControlCharsDeep(file, original, clean, opts = {}) {
  const originalText = joinStringLeaves(original).join('\n');
  const cleanText = joinStringLeaves(clean).join('\n');
  const occurrences = occurrencesIn(originalText);
  if (occurrences.length === 0) {
    assertNoUntracedChange(file, originalText, cleanText, opts, !sameSanitizedStructure(original, clean));
  }
  return reportOccurrences(file, occurrences, opts);
}

/**
 * ── LA BONIFICA NON DEVE POTER PEGGIORARE UNA PAGINA ───────────────────────
 *
 * `retranslate-blocking-bodies.mjs` riscrive body-locale GIA' PUBBLICATI. E'
 * la sola cosa in questo repo che lo faccia, ed e' esattamente la classe di
 * script che nel 2026-07 ha distrutto dei titoli: un detector al 33% di falsi
 * positivi che "riparava" il testo che aveva segnalato.
 *
 * La differenza qui non e' la buona intenzione, e' il verdetto: il testo nuovo
 * esce dalla cascata MT (`translateFieldFreeMt`) e viene scritto SOLO se la
 * guardia di factuality lo accetta con zero `critical`. Se la ri-traduzione
 * ri-fallisce, la pagina pubblicata resta com'e'.
 *
 * Questo test blinda quel verdetto e la meccanica di scrittura, cioe' i due
 * modi in cui lo script potrebbe fare danno:
 *
 *   1. `shouldWrite()` — scrivere una traduzione che la guardia rifiuta
 *      ancora, o cucita a meta' perche' un campo e' tornato vuoto dalla
 *      cascata. Sono i tre `return {write:false}`: senza di loro lo script
 *      pubblica esattamente il difetto che doveva togliere.
 *   2. `replaceBodyField()` — sostituire il campo giusto ma corrompere il
 *      resto del file. Il round-trip verifica che riscrivere un campo col
 *      proprio valore sia un no-op byte per byte, e che un valore con
 *      apostrofi, backslash e newline (cioe' la prosa vera) sopravviva alla
 *      coppia escape/unescape senza spostare le altre chiavi.
 *
 * `stratify()` e' qui perche' il pilota che decide se bruciare wall-clock su
 * centinaia di coppie deve coprire piu' codici: prendere "i primi N" di una
 * lista ordinata per id misura UN difetto e lo dichiara rappresentativo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldWrite,
  replaceBodyField,
  readBodyField,
  escapeForSingleQuoteTS,
  stratify,
  blockingPairsFromAudit,
  criticalCodes,
} from '../scripts/retranslate-blocking-bodies.mjs';

const fileFor = (id, fields) => `const b: Record<string, string> = {\n`
  + Object.entries(fields).map(([k, v]) => `  'blog.article.${id}.${k}': '${escapeForSingleQuoteTS(v)}',`).join('\n')
  + `\n};\n\nexport default b;\n`;

test('shouldWrite rifiuta una ri-traduzione che la guardia boccia ancora', () => {
  const v = shouldWrite({ oldCodes: ['unbalanced-parentheses'], newCodes: ['unbalanced-parentheses'], missingField: null });
  assert.equal(v.write, false);
  assert.match(v.reason, /ri-fallita/);
});

test('shouldWrite rifiuta anche quando il codice nuovo e diverso dal vecchio', () => {
  // Un difetto SOSTITUITO da un altro difetto resta un difetto: la condizione
  // e' "zero critical", non "non gli stessi critical di prima".
  const v = shouldWrite({ oldCodes: ['truncated-bold'], newCodes: ['translation-false-friend'], missingField: null });
  assert.equal(v.write, false);
});

test('shouldWrite rifiuta se un campo e tornato vuoto dalla cascata', () => {
  // Mezza traduzione nuova cucita su mezza vecchia sarebbe testo che nessuna
  // pipeline ha mai prodotto: si salta l'articolo intero.
  const v = shouldWrite({ oldCodes: ['truncated-bold'], newCodes: [], missingField: 'body2' });
  assert.equal(v.write, false);
  assert.equal(v.reason, 'campo-vuoto-dalla-cascata');
});

test('shouldWrite non tocca una pagina che la guardia gia accetta', () => {
  const v = shouldWrite({ oldCodes: [], newCodes: [], missingField: null });
  assert.equal(v.write, false);
  assert.equal(v.reason, 'vecchia-gia-pulita');
});

test('shouldWrite scrive solo bloccante-prima e pulita-dopo', () => {
  const v = shouldWrite({ oldCodes: ['truncated-bold'], newCodes: [], missingField: null });
  assert.deepEqual(v, { write: true, reason: 'pulita' });
});

test('replaceBodyField col valore attuale e un no-op byte per byte', () => {
  const src = fileFor('x', { body1: 'uno **grassetto**', body2: 'due (con parentesi)', body3: 'tre' });
  const current = readBodyField(src, 'x', 'body2');
  assert.equal(current, 'due (con parentesi)');
  assert.equal(replaceBodyField(src, 'x', 'body2', current), src);
});

test('replaceBodyField preserva prosa con apostrofi, backslash e newline', () => {
  const src = fileFor('x', { body1: 'uno', body2: 'due', body3: 'tre' });
  const tricky = "l'articolo dice \\ e poi\nva a capo con 'virgolette'";
  const out = replaceBodyField(src, 'x', 'body2', tricky);
  assert.equal(readBodyField(out, 'x', 'body2'), tricky);
  // Le altre chiavi non si spostano.
  assert.equal(readBodyField(out, 'x', 'body1'), 'uno');
  assert.equal(readBodyField(out, 'x', 'body3'), 'tre');
  assert.ok(out.endsWith('export default b;\n'));
});

test('replaceBodyField rende null su chiave assente invece di riscrivere a meta', () => {
  const src = fileFor('x', { body1: 'uno' });
  assert.equal(replaceBodyField(src, 'x', 'body9', 'niente'), null);
});

test('criticalCodes conta solo i critical, deduplicati', () => {
  const codes = criticalCodes({
    issues: [
      { severity: 'critical', code: 'truncated-bold' },
      { severity: 'critical', code: 'truncated-bold' },
      { severity: 'major', code: 'vague-attribution' },
    ],
  });
  assert.deepEqual(codes, ['truncated-bold']);
});

test('blockingPairsFromAudit tiene solo le coppie con almeno un critical', () => {
  const pairs = blockingPairsFromAudit({
    findings: [
      { id: 'a', locale: 'en', dir: 'services/locales/blog-body', criticalCount: 1, issues: [{ severity: 'critical', code: 'truncated-bold' }] },
      { id: 'b', locale: 'de', dir: 'services/locales/blog-body', criticalCount: 0, issues: [{ severity: 'major', code: 'x' }] },
    ],
  });
  assert.deepEqual(pairs.map((p) => p.id), ['a']);
  assert.deepEqual(pairs[0].codes, ['truncated-bold']);
});

test('stratify copre piu codici invece di prendere i primi N dello stesso', () => {
  const pairs = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, codes: ['unbalanced-parentheses'] })),
    { id: 'ff', codes: ['translation-false-friend'] },
    { id: 'lp', codes: ['leaked-prompt-scaffolding'] },
  ];
  const picked = stratify(pairs, 3);
  assert.equal(picked.length, 3);
  assert.deepEqual(
    [...new Set(picked.map((p) => p.codes[0]))].sort(),
    ['leaked-prompt-scaffolding', 'translation-false-friend', 'unbalanced-parentheses'],
  );
});

test('stratify non inventa coppie quando ce ne sono meno del limite', () => {
  const picked = stratify([{ id: 'a', codes: ['x'] }], 10);
  assert.equal(picked.length, 1);
});

/**
 * ── IL DETERMINISMO CHE LA GUARDIA ANTI-DOPPIO-SPLIT ASSUME (issue #610) ────
 *
 * PARENT: #460 — il ri-bracketing della cascata ha introdotto una guardia,
 * `rb.split && rb.split.p !== _splitPromptTentato` (create-article.mjs), che
 * evita di rispedire al modello la STESSA meta' di scrittura gia' rifiutata
 * in questo tentativo: confronta il prompt appena ricostruito da
 * `_buildCall1(target)` (che chiama `_buildHalf`, che chiama `buildPrompt` +
 * `buildMessages`) con quello gia' tentato, per stringa.
 *
 * Quel confronto per stringa presume che le quattro funzioni siano PURE
 * interpolazioni di stringa sulle variabili di closure: a parita' di
 * `target` e di stato di closure invariato, stesso input -> stesso output.
 * Se una di esse introducesse una fonte di non-determinismo (`Math.random`,
 * `Date.now`, `new Date()` senza argomenti), la guardia smetterebbe di
 * riconoscere un duplicato — silenziosamente, perche' il confronto per
 * stringa continuerebbe a "funzionare" senza mai lanciare.
 *
 * La review di #460 l'ha segnalato esplicitamente come "non verificato, fuori
 * da questo diff". Oggi il rischio non si materializza (verificato via grep:
 * nessuno dei tre letterali compare nel corpo di queste quattro funzioni), ma
 * non esiste un osservatore che lo impedisca in futuro. Questo file lo e'.
 *
 * NOTA PER CHI CERCA IL SORGENTE COL GREP: `create-article.mjs` contiene byte
 * che lo fanno classificare BINARIO, e un `grep` senza `-a` torna vuoto IN
 * SILENZIO. Qui si legge con `fs.readFileSync(…, 'utf8')`. Il file non e'
 * importabile da un test: ~891KB e la prima cosa che fa e' una chiamata di
 * rete a module scope (stesso motivo di `prompt-floor-early-exit.test.mjs`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CREATE_ARTICLE = path.join(REPO, 'generator', 'scripts', 'create-article.mjs');
const SRC = fs.readFileSync(CREATE_ARTICLE, 'utf8');

// Marcatori letterali e non numeri di riga: il file si muove ad ogni commit,
// e un range fisso smetterebbe silenziosamente di coprire la funzione giusta
// non appena qualcosa sopra si sposta di una riga.
function slice(startMarker, endMarker, label) {
  const start = SRC.indexOf(startMarker);
  const end = SRC.indexOf(endMarker, start);
  assert.ok(start > 0, `marcatore di inizio non trovato per ${label}: ${startMarker}`);
  assert.ok(end > start, `marcatore di fine non trovato (o precede l'inizio) per ${label}: ${endMarker}`);
  return SRC.slice(start, end);
}

const NON_DETERMINISM_PATTERNS = [
  [/Math\.random\s*\(/, 'Math.random('],
  [/Date\.now\s*\(/, 'Date.now('],
  [/new\s+Date\s*\(\s*\)/, 'new Date() senza argomenti'],
];

function assertDeterministic(src, label) {
  for (const [re, name] of NON_DETERMINISM_PATTERNS) {
    assert.doesNotMatch(
      src,
      re,
      `${label} contiene ${name}: la guardia anti-doppio-split confronta i prompt per stringa e presume che ${label} sia una pura interpolazione di variabili di closure stabili`,
    );
  }
}

test('buildPrompt e\' una pura interpolazione di stringa: nessuna fonte di non-determinismo', () => {
  const src = slice(
    "const buildPrompt = ({ sourceBody, domainFacts, part = 'full' }) => {",
    'const minWordsInstruction = `',
    'buildPrompt',
  );
  assertDeterministic(src, 'buildPrompt');
});

test('buildMessages e\' una pura interpolazione di stringa: nessuna fonte di non-determinismo', () => {
  const src = slice(
    "const buildMessages = (promptText, remediation, part = 'full') => [",
    '// Pass a strict JSON schema so providers that support it',
    'buildMessages',
  );
  assertDeterministic(src, 'buildMessages');
});

test('_buildHalf non introduce non-determinismo oltre a buildPrompt/buildMessages', () => {
  const src = slice(
    'const _buildHalf = (part, sourceBody, domainFacts, remediation) => {',
    '// Costruita QUI, non dentro `_generateSplit`',
    '_buildHalf',
  );
  assertDeterministic(src, '_buildHalf');
});

test('_buildCall1 e\' deterministico a parita\' di target e stato di closure', () => {
  const src = slice(
    'const _buildCall1 = (target = _promptTokenTarget) => {',
    '// `let` e non `const`: il ri-bracketing sulla cascata',
    '_buildCall1',
  );
  assertDeterministic(src, '_buildCall1');
});

test('la guardia anti-doppio-split confronta ancora per stringa il prompt gia\' tentato', () => {
  // Se questa riga sparisse o cambiasse forma, l'invariante sopra
  // smetterebbe di proteggere qualcosa: e' la guardia stessa che presume il
  // determinismo appena verificato nei quattro test precedenti.
  assert.match(
    SRC,
    /rb\.split\s*&&\s*rb\.split\.p\s*!==\s*_splitPromptTentato/,
    'la guardia anti-doppio-split (#460) deve confrontare rb.split.p con _splitPromptTentato',
  );
});

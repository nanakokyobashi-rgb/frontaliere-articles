// issue #561 — write() non atomico in create-article.mjs
//
// Il choke-point di scrittura del generatore chiamava `writeFileSync`
// direttamente sul path finale. `generate-article.yml` uccide il processo
// con un kill esterno che e' stato misurato 42/42 SIGKILL (mai SIGTERM
// eseguito: vedi generator/scripts/lib/ai-models.mjs), quindi nessun
// handler puo' intercettarlo — solo l'atomicita' della singola scrittura
// protegge un `content/*.ts` dal troncamento a meta'.
//
// Questo e' un test by-construction, non comportamentale: `write()` chiude
// su helper interni al modulo (`resolve`, `sanitizeText`,
// `reportStrippedControlChars`, `PROJECT_ROOT`) non esportati, quindi la
// prova che conta e' sulla FORMA del choke-point — esattamente come fa
// generator/tests/control-char-write-report.test.mjs per il sanitizer
// gemello nello stesso punto.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const file = path.join(root, 'generator', 'scripts', 'create-article.mjs');
const src = fs.readFileSync(file, 'utf-8');

function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `atteso di trovare "${signature}" in ${file}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  throw new Error(`parentesi graffa di chiusura non trovata per "${signature}"`);
}

test('write() importa renameSync da node:fs', () => {
  const importLine = src.split('\n').find((l) => l.includes("from 'node:fs'"));
  assert.ok(importLine, 'import di node:fs non trovato');
  assert.match(importLine, /\brenameSync\b/,
    'renameSync deve essere importato: e\' il syscall atomico su cui si basa il commit');
});

test('write() non chiama mai writeFileSync sul path finale, solo su un temp seguito da renameSync', () => {
  const body = extractFunctionBody(src, 'function write(rel, content) {');

  // Il path finale e' `resolve(rel)`, assegnato a una variabile prima di
  // essere usato. writeFileSync non deve mai prendere direttamente quella
  // variabile (ne' l'espressione `resolve(rel)` inline): deve scrivere solo
  // sul path temporaneo.
  const targetVarMatch = body.match(/const (\w+)\s*=\s*resolve\(rel\)/);
  assert.ok(targetVarMatch, 'atteso `const <nome> = resolve(rel)` per isolare il path finale in una variabile');
  const targetVar = targetVarMatch[1];

  assert.doesNotMatch(body, /writeFileSync\(\s*resolve\(rel\)/,
    'writeFileSync non deve scrivere direttamente su resolve(rel): il path finale va scritto via rename, non via write diretta');
  assert.doesNotMatch(body, new RegExp(`writeFileSync\\(\\s*${targetVar}\\b`),
    `writeFileSync non deve scrivere direttamente su ${targetVar} (il path finale): quel path va raggiunto solo via renameSync`);

  // Deve invece scrivere su un path temporaneo…
  const tmpVarMatch = body.match(/const (\w+)\s*=\s*`\$\{[^}]*\}[^`]*\.tmp`/);
  assert.ok(tmpVarMatch, 'atteso un path temporaneo derivato dal target (es. `${target}.${pid}.${seq}.tmp`)');
  const tmpVar = tmpVarMatch[1];
  assert.match(body, new RegExp(`writeFileSync\\(\\s*${tmpVar}\\b`),
    `writeFileSync deve scrivere sul path temporaneo ${tmpVar}, non sul path finale`);

  // …e poi committare con un renameSync atomico dal temp al target.
  assert.match(body, new RegExp(`renameSync\\(\\s*${tmpVar}\\s*,\\s*${targetVar}\\s*\\)`),
    `atteso renameSync(${tmpVar}, ${targetVar}) a chiudere la scrittura: senza, un kill esterno puo' ` +
    'lasciare il file a meta\' scritto al path finale');
});

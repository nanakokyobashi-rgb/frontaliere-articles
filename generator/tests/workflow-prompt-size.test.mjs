/**
 * Guard globale per gli scalar `prompt:` dei workflow GitHub e delle action.
 *
 * GitHub può rifiutare un workflow al caricamento quando uno scalar cresce
 * oltre il limite server-side: la run appare fallita ma `/jobs` restituisce
 * zero job. Misurare ogni file evita che un controllo fissato a un solo nome
 * lasci scoperto il prossimo workflow che cresce. Una chiave `prompt:` non
 * block-scalar è altrettanto sospetta: il testo può essere stato spostato in
 * una forma che il ratchet non misura più.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GITHUB_DIR = path.join(ROOT, '.github');
const PROMPT_ROOTS = [
  path.join(GITHUB_DIR, 'workflows'),
  path.join(GITHUB_DIR, 'actions'),
];
// The site already ratchets this empirical ceiling; keep the corpus aligned
// while leaving margin below the undocumented server-side invalidation limit.
const MAX_PROMPT_CHARS = 20_000;
const PROMPT_KEY_RE = /^(\s*)prompt\s*:(.*)$/;
const BLOCK_SCALAR_RE = /^\s*[|>](?:[+-]?\d?|\d?[+-]?)(?:[ \t]+(?:#.*)?)?$/;

function yamlFiles(root) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.(?:yml|yaml)$/.test(entry.name)) files.push(full);
    }
  }
  visit(root);
  return files;
}

function sourceFiles() {
  return PROMPT_ROOTS
    .flatMap(yamlFiles)
    .map((file) => path.relative(ROOT, file))
    .sort();
}

/**
 * Estrae il testo sorgente dello scalar, inclusa l'indentazione YAML. Questa
 * è la misura usata dal ratchet del sito e quella confrontabile senza valutare
 * espressioni GitHub o dipendenze del runner.
 */
function scanPromptKeys(text, file = '') {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  const nonBlockScalars = [];

  // `action.yml` deve poter dichiarare l'input `prompt` e inoltrarlo alla
  // action esterna senza trasformare quel wiring in un prompt da misurare.
  // Un valore letterale o un'espressione diversa da quel pass-through resta
  // invece un prompt non misurato e deve fare fallire il gate.
  function isInputDeclaration(lineIndex, keyIndent) {
    for (let i = lineIndex - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const indent = line.length - line.replace(/^\s*/, '').length;
      if (indent >= keyIndent) continue;
      return /^\s*inputs\s*:/.test(line);
    }
    return false;
  }

  function isActionPromptPassthrough(lineIndex, keyIndent, value) {
    if (!file.startsWith('.github/actions/')) return false;
    if (/^\s*\$\{\{\s*inputs\.prompt\s*\}\}\s*$/.test(value)) {
      for (let i = lineIndex - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (line.trim() === '') continue;
        const indent = line.length - line.replace(/^\s*/, '').length;
        if (indent >= keyIndent) continue;
        if (/^\s*with\s*:/.test(line)) return true;
        break;
      }
    }
    return false;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const match = PROMPT_KEY_RE.exec(lines[i]);
    if (!match) continue;
    const keyIndent = match[1].length;
    const value = match[2].trim();
    if (isInputDeclaration(i, keyIndent) || isActionPromptPassthrough(i, keyIndent, value)) continue;
    if (!BLOCK_SCALAR_RE.test(value)) {
      nonBlockScalars.push({ line: i + 1, text: lines[i] });
      continue;
    }
    const body = [];
    let lastBodyLine = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') {
        body.push(line);
        lastBodyLine = j;
        continue;
      }
      const indent = line.length - line.replace(/^\s*/, '').length;
      if (indent <= keyIndent) break;
      body.push(line);
      lastBodyLine = j;
    }
    blocks.push(body.join('\n'));
    // The body is prompt text. A line such as `prompt: |` inside it must not
    // be discovered again by the outer scan as a second, phantom block.
    i = lastBodyLine;
  }
  return { blocks, nonBlockScalars };
}

test('il discovery copre workflow e action e trova gli scalar prompt', () => {
  const files = sourceFiles();
  assert.ok(files.length > 0, 'le cartelle GitHub sono vuote o il discovery è rotto');

  const scans = files.map((file) => ({
    file,
    ...scanPromptKeys(fs.readFileSync(path.join(ROOT, file), 'utf8'), file),
  }));
  const invalid = scans.flatMap(({ file, nonBlockScalars }) => nonBlockScalars.map((entry) => ({
    file,
    ...entry,
  })));
  assert.deepEqual(
    invalid,
    [],
    'prompt non block-scalar: il gate non può misurarne la dimensione:\n'
      + invalid.map(({ file, line, text }) => `${file}:${line}: ${text}`).join('\n'),
  );
  const promptCount = scans.reduce((total, scan) => total + scan.blocks.length, 0);
  assert.ok(promptCount >= 8, 'il discovery dei prompt è diventato parziale o vacuo');
});

test('il corpo prompt non riapre un blocco fantasma durante la scansione', () => {
  const scan = scanPromptKeys([
    'with:',
    '  prompt: |',
    '    istruzione reale',
    '    prompt: |',
    '      questa riga è testo, non una seconda chiave',
    'jobs:',
  ].join('\n'), '.github/workflows/synthetic.yml');
  assert.equal(scan.blocks.length, 1);
  assert.deepEqual(scan.nonBlockScalars, []);
});

test('una chiave prompt non block-scalar è un errore esplicito', () => {
  const scan = scanPromptKeys([
    'with:',
    '  prompt: ${{ github.event.inputs.prompt }}',
  ].join('\n'), '.github/workflows/synthetic.yml');
  assert.deepEqual(scan.nonBlockScalars, [{
    line: 2,
    text: '  prompt: ${{ github.event.inputs.prompt }}',
  }]);
});

test('nessun prompt multilinea supera il tetto che evita workflow invalidi', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const [index, prompt] of scanPromptKeys(source, file).blocks.entries()) {
      if (prompt.length > MAX_PROMPT_CHARS) {
        offenders.push(
          `${file} prompt #${index + 1}: ${prompt.length} caratteri; `
            + 'GitHub può rendere invalido il workflow, avviarlo senza job e fermarne il loop',
        );
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'prompt oversize: il workflow diventerebbe invalido e smetterebbe di girare:\n'
      + offenders.join('\n'),
  );
});

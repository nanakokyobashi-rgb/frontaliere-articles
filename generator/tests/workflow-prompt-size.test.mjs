/**
 * Guard globale per gli scalar `prompt:` dei workflow GitHub.
 *
 * GitHub può rifiutare un workflow al caricamento quando uno scalar cresce
 * oltre il limite server-side: la run appare fallita ma `/jobs` restituisce
 * zero job. Misurare ogni file evita che un controllo fissato a un solo nome
 * lasci scoperto il prossimo workflow che cresce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_DIR = path.join(ROOT, '.github/workflows');
// The site already ratchets this empirical ceiling; keep the corpus aligned
// while leaving margin below the undocumented server-side invalidation limit.
const MAX_PROMPT_CHARS = 20_000;
const PROMPT_RE = /^(\s*)prompt:\s*[|>](?:[+-]?\d?|\d?[+-]?)(?:[ \t]+(?:#.*)?)?$/;

function workflowFiles() {
  return fs
    .readdirSync(WORKFLOW_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:yml|yaml)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Estrae il testo sorgente dello scalar, inclusa l'indentazione YAML. Questa
 * è la misura usata dal ratchet del sito e quella confrontabile senza valutare
 * espressioni GitHub o dipendenze del runner.
 */
function promptBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = PROMPT_RE.exec(lines[i]);
    if (!match) continue;
    const keyIndent = match[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') {
        body.push(line);
        continue;
      }
      const indent = line.length - line.replace(/^\s*/, '').length;
      if (indent <= keyIndent) break;
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

test('il discovery copre tutti i workflow e trova gli scalar prompt', () => {
  const files = workflowFiles();
  assert.ok(files.length > 0, 'la cartella dei workflow è vuota o il discovery è rotto');

  const promptCount = files.reduce((total, file) => {
    const source = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    return total + promptBlocks(source).length;
  }, 0);
  assert.ok(promptCount >= 8, 'il discovery dei prompt è diventato parziale o vacuo');
});

test('nessun prompt multilinea supera il tetto che evita workflow invalidi', () => {
  const offenders = [];
  for (const file of workflowFiles()) {
    const source = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    for (const [index, prompt] of promptBlocks(source).entries()) {
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

/**
 * Contratti osservabili del digest prodotto dallo sweep needs-human.
 *
 * Questi controlli sono intenzionalmente testuali: il workflow e il prompt
 * sono il contratto eseguibile, mentre il test deve restare zero-dep e
 * verificare ciò che GitHub Actions riceverà davvero.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/needs-human-sweep.yml');
const text = readFileSync(WORKFLOW, 'utf8');

function stepBlock(name) {
  const start = text.indexOf(`- name: ${name}`);
  assert.notEqual(start, -1, `step «${name}» non trovato`);
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n      - name: ');
  return next === -1 ? rest : rest.slice(0, next);
}

test('il titolo digest ambiguo non viene risolto scegliendo il primo risultato', () => {
  const step = stepBlock('Classify outcome (work-done, not CLI exit)');

  assert.doesNotMatch(
    step,
    /--jq '\.\[0\]\.number/,
    'un digest omonimo non deve essere scelto per rilevanza con `.[0].number`',
  );
  assert.match(
    step,
    /DIGEST_MATCHES=\$\(gh search issues[\s\S]*?--json number,title --jq '[^']*\.title == env\.DIGEST_TITLE[^']*'/,
    'la query deve raccogliere tutte le issue il cui titolo è quello esatto del digest',
  );
  assert.match(
    step,
    /DIGEST_MATCH_COUNT=.*(?:wc -l|length)/,
    'lo step deve contare i digest omonimi invece di scartarli implicitamente',
  );
  const guard = /if \[ "\$DIGEST_MATCH_COUNT" -gt 1 \]; then([\s\S]*?)\n\s+fi/.exec(step);
  assert.ok(guard, 'manca il guard che rende rosso il caso di digest omonimi');
  assert.match(guard[1], /exit 1/, 'più digest omonimi devono far fallire la classificazione');

  const guardAt = step.indexOf('if [ "$DIGEST_MATCH_COUNT" -gt 1 ]; then');
  const numberAt = step.indexOf('N=');
  assert.ok(guardAt !== -1 && numberAt !== -1 && guardAt < numberAt, 'il guard deve precedere la scelta del numero');
});

test('il valore del titolo digest è validato prima del prompt Claude e passato con un token osservabile', () => {
  const validateAt = text.indexOf('- name: Validate digest title');
  const claudeAt = text.indexOf('- name: Run Claude sweep');
  assert.ok(validateAt !== -1, 'manca lo step di validazione del titolo digest');
  assert.ok(claudeAt !== -1 && validateAt < claudeAt, 'il titolo deve essere validato prima di invocare Claude');

  const validate = text.slice(validateAt, claudeAt);
  assert.match(validate, /id: digest_title/, 'lo step deve pubblicare un output identificabile');
  assert.match(text, /\nenv:\n  DIGEST_TITLE: '[^']+'/, 'il titolo deve avere una sorgente top-level');
  assert.doesNotMatch(validate, /\n\s+DIGEST_TITLE:\s+\$\{\{/, 'la sorgente del titolo non deve essere duplicata nello step');
  assert.match(validate, /\[ -n "\$DIGEST_TITLE" \]/, 'un titolo vuoto deve essere un errore osservabile');
  assert.match(validate, /printf 'title=%s\\n' "\$DIGEST_TITLE" >> "\$GITHUB_OUTPUT"/, 'il valore validato deve diventare un output machine-stabile');

  const prompt = stepBlock('Run Claude sweep');
  assert.match(
    prompt,
    /titolo ESATTO `\$\{\{ steps\.digest_title\.outputs\.title \}\}`/,
    'il prompt deve consumare il valore validato, non una interpolazione env non osservabile',
  );
  assert.doesNotMatch(
    prompt,
    /titolo ESATTO `\$\{\{ env\.DIGEST_TITLE \}\}`/,
    'il prompt non deve dipendere dalla risoluzione non verificata di env dentro with',
  );
});

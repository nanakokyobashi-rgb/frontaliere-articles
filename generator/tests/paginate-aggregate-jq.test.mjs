/**
 * `gh api --paginate --jq` non deve mai produrre un AGGREGATO.
 *
 * Sotto `--paginate` il `--jq` gira PER PAGINA e le uscite si concatenano:
 * `length` su 31 commenti vale `"30\n1"`, `[...] | last` restituisce l'ultimo
 * di OGNI pagina. Il consumatore legge quel valore come uno scalare e sbaglia
 * senza fallire — il modo tipico in cui questo ciclo mente in verde. L'idioma
 * sicuro è un filtro element-wise (una riga per elemento, valida su ogni
 * pagina) più l'aggregazione fuori da `gh` (`tail -1`, `grep -c .`, JS).
 *
 * Questo test pinna i siti della classe già sanati: cerca l'aggregato, non la
 * forma esatta del fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Righe che invocano `gh api ... --paginate` e il loro `--jq` (anche a capo). */
function paginatedJqFilters(source) {
  const out = [];
  const lines = source.split('\n');
  const isComment = (l) => /^\s*(#|\/\/|\*)/.test(l);
  lines.forEach((line, i) => {
    if (!/--paginate/.test(line) || isComment(line)) return;
    // Il `--jq` sta spesso sulla riga dopo (continuazione `\` o argomento JS):
    // la riga successiva entra nel campione solo se non è un commento.
    const next = lines[i + 1] ?? '';
    out.push([line, isComment(next) ? '' : next].join(' '));
  });
  return out;
}

const TARGETS = [
  '.github/workflows/pr-redflag-fixer.yml',
  '.github/workflows/pr-redcheck-fixer.yml',
  '.github/workflows/tests.yml',
  'scripts/ci/pr-autorebase.mjs',
  'scripts/ci/pr-body-contract.mjs',
  'scripts/ci/lib/prComments.mjs',
];

// `join(...)` è l'unico aggregato ammesso: il consumatore fa `grep`/`includes`
// su un blob di testo, e la concatenazione fra pagine non cambia l'esito.
const AGGREGATE_RE = /--jq[^\n]*?(\|\s*length|\]\s*\|\s*last|\]\s*\|\s*first|'length'|`length`)/;

test('nessun `gh api --paginate` consuma un aggregato jq per pagina', () => {
  for (const rel of TARGETS) {
    const source = read(rel);
    for (const call of paginatedJqFilters(source)) {
      assert.doesNotMatch(
        call,
        AGGREGATE_RE,
        `${rel}: aggregato jq sotto --paginate (gira per pagina) → ${call.trim().slice(0, 160)}`,
      );
    }
  }
});

test('i siti sanati usano un filtro element-wise', () => {
  const redcheck = read('.github/workflows/pr-redcheck-fixer.yml');
  assert.match(redcheck, /comments\?per_page=100" --paginate \\\n\s+--jq '\.\[\]\.id' 2>\/dev\/null \| grep -c \./);
  assert.equal((redcheck.match(/--jq '\.\[\]\.id' 2>\/dev\/null \| grep -c \./g) || []).length, 2);

  const tests = read('.github/workflows/tests.yml');
  assert.equal((tests.match(/\| \.commit_id \/\/ empty' 2>\/dev\/null \| tail -1/g) || []).length, 2);

  const autorebase = read('scripts/ci/pr-autorebase.mjs');
  assert.match(autorebase, /reviewCount: countPaginatedLines\(reviews\)/);
  assert.match(autorebase, /\| \.body \| @json`/);
  assert.match(autorebase, /return lastPaginatedJsonLine\(raw\)/);

  const bodyContract = read('scripts/ci/pr-body-contract.mjs');
  assert.match(bodyContract, /countPaginatedLines\(existing\) > 0/);
});

test('gli helper di aggregazione vivono in una sola sorgente', async () => {
  const { countPaginatedLines, lastPaginatedJsonLine } = await import(
    path.join(ROOT, 'scripts/ci/lib/prComments.mjs')
  );
  assert.equal(countPaginatedLines('12\n34\n'), 2);
  assert.equal(countPaginatedLines(''), 0);
  assert.equal(countPaginatedLines(null), 0);
  // Un body multi-riga sopravvive all'@json; l'ultimo vince.
  assert.equal(lastPaginatedJsonLine('"a\\nb"\n"c"'), 'c');
  assert.equal(lastPaginatedJsonLine('"a\\nb"'), 'a\nb');
  assert.equal(lastPaginatedJsonLine(''), '');
});

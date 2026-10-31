// La scheda «fatti verificati» e' ground truth: il fact-checker blocca chi se ne
// discosta, quindi una riga sbagliata qui diventa un errore in serie nel corpus.
// Audit del 31/10/2026: la scheda prescriveva «trattenuta SOLO in Svizzera
// (MAI "in entrambi i paesi")» ed «esenzione €7'500, regime transitorio
// 2024–2033», contro l'Accordo del 23.12.2020 (RS 0.642.045.43, art. 3 e 9) e la
// L. 83/2023 art. 4. Il «(NON 2026)» finiva stampato negli articoli come
// «Il riferimento corretto è il 2024, non il 2026».
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(path.join(root, 'generator/scripts/create-article.mjs'), 'utf8');

function templateBlock(name) {
  const start = source.indexOf(`const ${name} = \``);
  assert.notEqual(start, -1, `${name} non trovato`);
  return source.slice(start, source.indexOf('`;', start));
}

for (const name of ['VERIFIED_DOMAIN_FACTS', 'EVERGREEN_FACTS_BRIEF']) {
  test(`${name}: la regola fiscale distingue vecchi e nuovi frontalieri`, () => {
    const block = templateBlock(name);
    assert.doesNotMatch(block, /SOLO in Svizzera per i frontalieri|in entrambi i paesi/);
    assert.doesNotMatch(block, /7'500|7\.500/);
    assert.doesNotMatch(block, /regime transitorio 2024|Periodo transitorio/);
    assert.doesNotMatch(block, /\(NON 2026\)/);
    assert.match(block, /tassati solo in Svizzera/);
    assert.match(block, /10'000/);
    assert.match(block, /ristorni ai Comuni/);
  });
}

test('VERIFIED_DOMAIN_FACTS: importi della quota SSN dal testo di legge', () => {
  const block = templateBlock('VERIFIED_DOMAIN_FACTS');
  assert.match(block, /L\. 213\/2023 art\. 1 c\. 237-239/);
  assert.match(block, /dal 3% al 6% del salario netto, da 30 a 200 euro per mese lavorato/);
});

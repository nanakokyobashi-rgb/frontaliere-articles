/**
 * L'osservatore del corpus pubblicato: cio' che l'audit GEO del 2026-10-31 ha
 * bonificato non deve tornare. I gate fermano la generazione; questo test ferma ogni
 * altra via d'ingresso, compresa una riparazione che ne reintroduce uno.
 *
 * Gli articoli nel ledger (noindex) sono esenti dal controllo fiscale: sono quelli
 * costruiti su cifre che nessuna fonte permette di correggere, e il rimedio e'
 * proprio averli tolti dall'indice.
 */
import '../../host/cantonSectionsBootstrap.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFiscalErrors } from '../scripts/lib/fiscal-claims-guard.mjs';
import { parseArticleIndexExclusions } from '../../engine/shared/articleIndexExclusions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTENT = path.join(ROOT, 'content');
const LEDGER = path.join(CONTENT, 'article-index-exclusions.json');

const withdrawn = new Set([...parseArticleIndexExclusions(readFileSync(LEDGER, 'utf8'))].map((key) => key.split('|')[1]));

function* bodyFiles() {
  for (const dir of readdirSync(CONTENT).filter((name) => name.startsWith('blog-body'))) {
    for (const locale of readdirSync(path.join(CONTENT, dir))) {
      for (const name of readdirSync(path.join(CONTENT, dir, locale))) {
        yield { rel: `${dir}/${locale}/${name}`, id: name.replace(/\.ts$/, ''), file: path.join(CONTENT, dir, locale, name) };
      }
    }
  }
}

const bodies = [...bodyFiles()].map((entry) => ({ ...entry, text: readFileSync(entry.file, 'utf8') }));

test('autoverifica: il corpus letto e\' quello vero', () => {
  assert.ok(bodies.length > 14000, `letti solo ${bodies.length} corpi`);
});

test('nessuna affermazione fiscale smentita dalle fonti primarie', () => {
  const offenders = [];
  for (const { rel, id, text } of bodies) {
    if (withdrawn.has(id)) continue;
    for (const error of findFiscalErrors(text)) offenders.push(`${rel}: ${error.id}: ${error.sentence.trim().slice(0, 100)}`);
  }
  assert.deepEqual(offenders.slice(0, 20), []);
});

test('nessun campo di template senza valore e nessun marcatore del prompt', () => {
  const re = /(?:Importo|Amount|Betrag)\*{0,2}: ?(?:Non specificat[oa]|Not specified|Nicht angegeben)|TITRE (?:DE L.ARTICLE|ARTICLE)\s*:|TITEL DES ARTIKELS\s*:|ARTIKEL-?TITEL\s*:/;
  const offenders = bodies.filter(({ text }) => re.test(text)).map(({ rel }) => rel);
  assert.deepEqual(offenders.slice(0, 20), []);
});

test('il marcatore di una query orfana non e\' una fonte', () => {
  const offenders = bodies.filter(({ text }) => /\*(?:Fonte|Quelle|Source)\s?: orphan\*/.test(text)).map(({ rel }) => rel);
  assert.deepEqual(offenders, []);
});

test('il ledger contiene i casi dell\'audit', () => {
  for (const id of [
    'como-napoli-pareggio-2026',
    'openjobmetis-trieste-vittoria-kastritis',
    'blackout-internet-iran-70-giorni',
    'burraco-solidale-buguggiate',
  ]) {
    assert.ok(withdrawn.has(id), id);
  }
});

#!/usr/bin/env node
/**
 * scan-vacuous-key-facts.mjs — LA MISURA di quanti articoli pubblicati portano
 * un fatto chiave vuoto (issue #949, punto 2).
 *
 * `lib/key-facts-specificity.mjs` impedisce ai nuovi di nascere cosi'; questo
 * script conta quelli gia' usciti. Stessa divisione del lavoro di
 * `repair-prompt-placeholders.mjs` rispetto al suo guard: la prevenzione gira a
 * ogni articolo, la misura gira quando serve sapere quanto e' grande
 * l'arretrato.
 *
 * Non scrive niente, e di proposito. La domanda che chiude e' «quanti», perche'
 * senza quel numero la scelta fra rimedio nel prompt e gate sulla specificita'
 * si farebbe a occhio. Il rimedio a valle sul corpus e' un'altra passata, con
 * la sua PR: riscrive `content/**`, cioe' la superficie che il sito serve senza
 * ribuildare, e non va mescolato con un cambiamento al percorso di generazione.
 *
 * Uso:
 *   node generator/scripts/scan-vacuous-key-facts.mjs           # riepilogo
 *   node generator/scripts/scan-vacuous-key-facts.mjs --list    # + ogni hit
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findVacuousFacts } from './lib/key-facts-specificity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIST = process.argv.includes('--list');
const LOCALES = ['it', 'en', 'de', 'fr'];

/** L'inverso ESATTO di `escapeForSingleQuoteTS` (article-meta-block.mjs). */
const unescapeTs = (s) => s.replace(/\\(.)/gs, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));

const bodyLineRe = /'blog\.article\.([^']+)\.(body\d+)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;

function* iterateBodies() {
  for (const dir of ['blog-body', 'blog-body-ch']) {
    for (const locale of LOCALES) {
      const abs = path.join(ROOT, 'content', dir, locale);
      if (!fs.existsSync(abs)) continue;
      for (const file of fs.readdirSync(abs)) {
        if (!file.endsWith('.ts')) continue;
        const src = fs.readFileSync(path.join(abs, file), 'utf8');
        for (const m of src.matchAll(bodyLineRe)) {
          yield {
            rel: path.join('content', dir, locale, file),
            id: m[1],
            field: m[2],
            locale,
            value: unescapeTs(m[3]),
          };
        }
      }
    }
  }
}

const byKind = { 'placeholder-value': 0, 'hedged-prose': 0 };
const articlesByKind = { 'placeholder-value': new Set(), 'hedged-prose': new Set() };
const files = new Set();
let fieldsScanned = 0;

for (const entry of iterateBodies()) {
  fieldsScanned += 1;
  const hits = findVacuousFacts(entry.value);
  if (!hits.length) continue;
  files.add(entry.rel);
  for (const hit of hits) {
    byKind[hit.kind] += 1;
    articlesByKind[hit.kind].add(entry.id);
    if (LIST) {
      // Una riga per hit: il testo puo' contenere a capo, e un `\n` qui
      // spezzerebbe la riga in due e falserebbe ogni conteggio a valle.
      const flat = hit.text.replace(/\s+/g, ' ').slice(0, 120);
      console.log(`${hit.kind}\t${entry.rel}\t${entry.id}.${entry.field}\t${flat}`);
    }
  }
}

const allArticles = new Set([...articlesByKind['placeholder-value'], ...articlesByKind['hedged-prose']]);
console.log('');
console.log(`Campi body scanditi ......... ${fieldsScanned}`);
console.log(`File con almeno un hit ...... ${files.size}`);
console.log(`Articoli distinti ........... ${allArticles.size}`);
console.log(`  placeholder-value (riparabile per sottrazione) ... ${byKind['placeholder-value']} coppie su ${articlesByKind['placeholder-value'].size} articoli`);
console.log(`  hedged-prose      (solo misurato, non riparabile). ${byKind['hedged-prose']} bullet su ${articlesByKind['hedged-prose'].size} articoli`);

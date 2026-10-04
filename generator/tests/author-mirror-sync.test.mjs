// Il generatore firma gli articoli con il mirror AUTHORS di
// generator/scripts/create-article.mjs (pickAuthorForTopic -> data.author),
// mentre biografia, competenze e Person JSON-LD vengono da host/authors.ts,
// gemello `identical` di data/authors.ts del sito. Il mirror esiste perche'
// lo script e' Node ESM puro e non importa TypeScript; nessun import lega i
// due file, quindi un cambio al registro non faceva fallire niente.
//
// Il mirror non e' una copia del registro: e' lo strumento di punteggio delle
// firme. La relazione resta esplicita qui: ogni competenza del registro e'
// una keyword del mirror, oppure una SPECIALIZZAZIONE DICHIARATA (una keyword
// del mirror che contiene la frase del registro, con motivo), oppure
// un'esclusione motivata. Qualunque altra divergenza fa fallire il test
// invece di cambiare le firme in silenzio.
//
// Caso d'origine: la PR 11327 del sito ha tolto "2026" dalla competenza
// "accordo Italia-Svizzera" di marco-ferrari (correzione del testo mostrato);
// il mirror tiene "accordo italia-svizzera 2026" per scelta, vedi
// DECLARED_SPECIALIZATIONS.
//
// Il test legge entrambi i file come TESTO: il job dei gate del generatore
// non fa `npm ci`, e importare create-article.mjs trascinerebbe le sue
// dipendenze.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY = path.join(ROOT, 'host/authors.ts');
const GENERATOR = path.join(ROOT, 'generator/scripts/create-article.mjs');

// Esclusioni volute: una competenza del registro che il mirror NON deve
// contenere, ciascuna col motivo. Ogni altra assenza e' una divergenza.
const DELIBERATE_EXCLUSIONS = new Map([
  // optimizeSeoMetadata() aggiunge 'frontalieri' alle keyword di ogni
  // articolo: nel mirror darebbe a samuele-valente almeno un punto ovunque
  // (commento sul mirror, review della PR 3625).
  ['samuele-valente', new Set(['frontalieri'])],
]);

// Specializzazioni dichiarate: competenza del registro (minuscola) -> keyword
// del mirror che la contiene, per autore, ciascuna col motivo.
const DECLARED_SPECIALIZATIONS = new Map([
  // "2026" separa il nuovo accordo (marco-ferrari, fiscale) dal trattato in
  // generale (samuele-valente, specialista). La correzione editoriale della
  // PR 11327 cambia il testo mostrato, non l'instradamento: con la frase
  // nuda marco pareggia samuele sull'articolo dell'incidente (ultimo caso qui
  // sotto) e la firma la decide l'hash dell'id.
  ['marco-ferrari', new Map([['accordo italia-svizzera', 'accordo italia-svizzera 2026']])],
]);

function stringsIn(block) {
  return [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
}

function authorBlocks(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `marker non trovato: ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `marker non trovato: ${end}`);
  const body = source.slice(from, to);
  const out = new Map();
  const slugRe = /slug:\s*'([^']+)'/g;
  const slugs = [...body.matchAll(slugRe)];
  for (let i = 0; i < slugs.length; i += 1) {
    const chunk = body.slice(slugs[i].index, slugs[i + 1]?.index ?? body.length);
    const exp = chunk.match(/expertise:\s*(?:Object\.freeze\()?\[([\s\S]*?)\]/);
    assert.ok(exp, `expertise mancante per ${slugs[i][1]}`);
    out.set(slugs[i][1], stringsIn(exp[1]));
  }
  return out;
}

function loadGeneratorPicker(source) {
  const a = source.indexOf('const AUTHORS = Object.freeze([');
  const b = source.indexOf('function getAuthorByUid');
  const h = source.indexOf('function _hashString');
  const hEnd = source.indexOf('\n}\n', h) + 3;
  assert.ok(a >= 0 && b > a && h >= 0 && hEnd > h, 'blocco AUTHORS/pickAuthorForTopic non trovato');
  // eslint-disable-next-line no-new-func
  return new Function(`${source.slice(a, b)}${source.slice(h, hEnd)}\nreturn pickAuthorForTopic;`)();
}

const registrySource = readFileSync(REGISTRY, 'utf8');
const generatorSource = readFileSync(GENERATOR, 'utf8');
const registry = authorBlocks(registrySource, 'export const AUTHORS', '\n]);');
const mirror = authorBlocks(generatorSource, 'const AUTHORS = Object.freeze([', '\n]);');

test('il mirror del generatore ha gli stessi autori del registro host', () => {
  assert.ok(registry.size >= 4, `registro letto a meta': ${registry.size} autori`);
  assert.deepEqual([...mirror.keys()].sort(), [...registry.keys()].sort());
});

test('ogni competenza del registro e\' una keyword del mirror, una specializzazione dichiarata o un\'esclusione motivata', () => {
  for (const [slug, expertise] of registry) {
    const keywords = new Set(mirror.get(slug) ?? []);
    const excluded = DELIBERATE_EXCLUSIONS.get(slug) ?? new Set();
    const specialized = DECLARED_SPECIALIZATIONS.get(slug) ?? new Map();
    for (const term of expertise) {
      const lower = term.toLowerCase();
      if (excluded.has(lower)) {
        assert.ok(!keywords.has(lower), `${slug}: '${lower}' e' escluso per scelta ma e' tornato nel mirror`);
        continue;
      }
      if (specialized.has(lower)) {
        const keyword = specialized.get(lower);
        assert.ok(keyword.includes(lower), `${slug}: la specializzazione '${keyword}' non contiene '${lower}'`);
        assert.ok(keywords.has(keyword), `${slug}: la specializzazione dichiarata '${keyword}' manca dal mirror`);
        continue;
      }
      assert.ok(
        keywords.has(lower),
        `${slug}: la competenza '${term}' di host/authors.ts manca dal mirror di create-article.mjs — allinea il mirror, oppure dichiara la specializzazione o l'esclusione con motivo`,
      );
    }
  }
});

test('ogni specializzazione ed esclusione dichiarata corrisponde ancora al registro', () => {
  // Una voce di tabella orfana (il registro ha cambiato frase) non deve
  // restare a giustificare una divergenza che non esiste piu'.
  for (const [slug, map] of DECLARED_SPECIALIZATIONS) {
    const lowered = (registry.get(slug) ?? []).map((t) => t.toLowerCase());
    for (const term of map.keys()) {
      assert.ok(lowered.includes(term), `${slug}: '${term}' non e' piu' nel registro — aggiorna DECLARED_SPECIALIZATIONS`);
    }
  }
  for (const [slug, set] of DELIBERATE_EXCLUSIONS) {
    const lowered = (registry.get(slug) ?? []).map((t) => t.toLowerCase());
    for (const term of set) {
      assert.ok(lowered.includes(term), `${slug}: '${term}' non e' piu' nel registro — aggiorna DELIBERATE_EXCLUSIONS`);
    }
  }
});

test('ogni autore viene scelto dalle proprie competenze', () => {
  const pick = loadGeneratorPicker(generatorSource);
  for (const [slug, expertise] of registry) {
    assert.equal(pick(expertise.join(' ').toLowerCase(), `probe-${slug}`).slug, slug);
  }
});

test("l'articolo sul trattato dell'incidente samuele-valente resta allo specialista", () => {
  // Stesso caso del test del sito tests/create-article-author-registry.test.ts.
  const pick = loadGeneratorPicker(generatorSource);
  const title = "L'Accordo Italia-Svizzera del 2020 sulla tassazione dei lavoratori frontalieri";
  const id = 'laccordo-italia-svizzera-del-2020-sulla-tassazione-dei-lavoratori-frontalieri';
  assert.equal(pick(['fiscale', title, id].join(' '), id).slug, 'samuele-valente');
});

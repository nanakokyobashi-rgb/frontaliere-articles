/**
 * ts-literal-span.test.mjs — la finestra del letterale `ALL_BLOG_ARTICLE_IDS`
 * e' la SUA, e finisce dove finisce lui.
 *
 * ## I due difetti che sorveglia
 *
 * `scripts/retire-article.mjs` (rimozione) e
 * `generator/scripts/create-article.mjs` (rigenerazione) riscrivono lo stesso
 * array piatto dentro `content/routerBlogData.ts`. Entrambi lo localizzavano
 * con due euristiche di testo:
 *
 *   1. **inizio per NOME**, `\b<varName>\b[^=]*=\s*\[`. `[^=]` comprende il
 *      newline, quindi bastava una menzione del nome in un commento perche' il
 *      match partisse da li' e scavallasse fino al primo `= [` successivo: la
 *      finestra e' un ALTRO array, e la riscrittura corrompe il file. L'unico
 *      backstop era l'exit code.
 *   2. **fine sul primo `];`**. Un array chiuso `] as const;` non ne ha uno:
 *      `indexOf` scavalla al `];` di un array piu' sotto e il taglio cade nel
 *      punto sbagliato — oppure, dal lato di `create-article.mjs`, la regex non
 *      matcha affatto e la rigenerazione salta IN SILENZIO, lasciando il nuovo
 *      id fuori dall'elenco mentre tutto il resto e' stato scritto.
 *
 * E' la stessa coppia di estremi sbagliati misurata su `BORDER_WAIT_CROSSINGS`
 * in `rewire-json-contracts.test.mjs` (166 token invece di 134). Li' la
 * finestra sbagliata falsava una lettura; qui falsa una SCRITTURA su una
 * superficie che il sito consuma senza ribuildare.
 *
 * ## Perche' i casi sono sintetici
 *
 * Oggi `content/routerBlogData.ts` nomina `ALL_BLOG_ARTICLE_IDS` una volta sola
 * e chiude con `];`: nessuno dei due difetti morde sul corpus com'e' adesso, e
 * un test che leggesse solo il file reale sarebbe verde con o senza il fix.
 * Sono difetti latenti — un commento aggiunto sopra la dichiarazione, o un
 * `prettier` che riformatta — quindi vanno provati sulle forme che li
 * innescano. L'ultimo caso, invece, e' sul file vero: e' li' che si vede che la
 * finestra giusta esiste davvero.
 *
 * Lancia con:
 *   node --test generator/tests/ts-literal-span.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  matchingDelimiter, findIdListLiteralSpan, removeFromIdListLiteral,
} from '../../scripts/lib/ts-literals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf-8');

/** I chiamanti della regola: devono usarla, non ri-scriverla in casa. */
const CALLERS = ['scripts/retire-article.mjs', 'generator/scripts/create-article.mjs'];

const bodyOf = (src, name) => {
  const span = findIdListLiteralSpan(src, name);
  assert.ok(span, `span di ${name} non trovato`);
  return src.slice(span.openIdx + 1, span.closeIdx);
};

test('una MENZIONE del nome sopra la dichiarazione non apre la finestra', () => {
  // Difetto 1. Con `\b NAME \b[^=]*=\s*\[` il match parte dal commento e la `[`
  // catturata e' quella di ALTRO_ARRAY: la rimozione avrebbe riscritto l'array
  // sbagliato, e la vittima sarebbe stato l'unico id di quello.
  const src = [
    '// Aggiungendo un articolo: ricordati di aggiornare anche ALL_BLOG_ARTICLE_IDS.',
    "export const ALTRO_ARRAY: string[] = ['non-toccarmi'];",
    "export const ALL_BLOG_ARTICLE_IDS: BlogArticleId[] = ['uno', 'due'];",
    '',
  ].join('\n');

  assert.deepEqual(bodyOf(src, 'ALL_BLOG_ARTICLE_IDS'), "'uno', 'due'");

  const out = removeFromIdListLiteral(src, 'ALL_BLOG_ARTICLE_IDS', 'uno');
  assert.equal(out.changed, true);
  assert.ok(out.src.includes("export const ALTRO_ARRAY: string[] = ['non-toccarmi'];"),
    'la finestra ha morso l\'array sbagliato: ALTRO_ARRAY e\' stato riscritto');
  assert.ok(out.src.includes("ALL_BLOG_ARTICLE_IDS: BlogArticleId[] = ['due'];"));
});

test('la finestra finisce sulla `]` che chiude, non sul primo `];` del file', () => {
  // Difetto 2, nella forma che lo rende visibile: `] as const;` piu' un `];`
  // letterale piu' sotto. Con `indexOf('];')` la finestra inghiottiva
  // l'array successivo, e rimuovere l'ultimo id ne cancellava la dichiarazione.
  const src = [
    'export const ALL_BLOG_ARTICLE_IDS = [',
    "  'uno',",
    "  'due',",
    '] as const;',
    '',
    "export const ALTRO_ARRAY: string[] = ['non-toccarmi'];",
    '',
  ].join('\n');

  assert.equal(bodyOf(src, 'ALL_BLOG_ARTICLE_IDS').includes('ALTRO_ARRAY'), false,
    'la finestra ha scavallato oltre `] as const;`');

  const out = removeFromIdListLiteral(src, 'ALL_BLOG_ARTICLE_IDS', 'due');
  assert.equal(out.changed, true);
  assert.ok(out.src.includes("export const ALTRO_ARRAY: string[] = ['non-toccarmi'];"),
    'rimuovendo un id e\' sparito un altro array');
  assert.ok(out.src.includes('] as const;'), 'la chiusura `as const` non e\' sopravvissuta');
  assert.equal(/'due'/.test(out.src), false);
  assert.ok(/'uno'/.test(out.src));
});

test('un array multilinea rientrato resta una finestra sola', () => {
  const src = [
    'export const ALL_BLOG_ARTICLE_IDS: BlogArticleId[] = [',
    "  'uno',",
    "  'due',",
    "  'tre',",
    '];',
    '',
  ].join('\n');
  const out = removeFromIdListLiteral(src, 'ALL_BLOG_ARTICLE_IDS', 'due');
  assert.equal(out.changed, true);
  assert.equal(/'due'/.test(out.src), false);
  assert.ok(/'uno'/.test(out.src) && /'tre'/.test(out.src));
  assert.ok(out.src.trimEnd().endsWith('];'));
});

test('rimuovere il primo, l\'ultimo e l\'unico id lascia un array valido', () => {
  const three = "export const IDS: string[] = ['uno', 'due', 'tre'];\n";
  assert.ok(removeFromIdListLiteral(three, 'IDS', 'uno').src.includes("['due', 'tre']"));
  assert.ok(removeFromIdListLiteral(three, 'IDS', 'tre').src.includes("['uno', 'due']"));
  const one = "export const IDS: string[] = ['solo'];\n";
  assert.ok(removeFromIdListLiteral(one, 'IDS', 'solo').src.includes('[]'));
});

test('un id che ne CONTIENE un altro non viene scambiato per lui', () => {
  // Stessa classe del needle nudo di `mentions-id.mjs`: gli id si annidano
  // davvero nel corpus, e gli apici sono cio' che li delimita.
  const src = "export const IDS: string[] = ['disoccupazione-2026', 'frontalieri-disoccupazione-2026'];\n";
  const out = removeFromIdListLiteral(src, 'IDS', 'disoccupazione-2026');
  assert.equal(out.changed, true);
  assert.ok(out.src.includes("['frontalieri-disoccupazione-2026']"), out.src);
});

test('un id assente non cambia niente, e non e\' un errore', () => {
  const src = "export const IDS: string[] = ['uno'];\n";
  const out = removeFromIdListLiteral(src, 'IDS', 'mai-esistito');
  assert.equal(out.changed, false);
  assert.equal(out.src, src);
});

test('un elenco DERIVATO non e\' un letterale: nessuna finestra, nessuna riscrittura', () => {
  // La sezione svizzera fa cosi'. `create-article.mjs` deve saltare il blocco
  // (span `null`) invece di inventarsi un array da riscrivere.
  const src = 'export const ALL_SWISS_ARTICLE_IDS = Object.keys(SWISS_SLUGS);\n';
  assert.equal(findIdListLiteralSpan(src, 'ALL_SWISS_ARTICLE_IDS'), null);
});

test('nome presente ma dichiarazione irriconoscibile: la rimozione GRIDA, non tace', () => {
  // Tacere qui vuol dire lasciare l'id nell'elenco e scoprirlo al passo 12, a
  // scritture gia' fatte: e' la RIMOZIONE PARZIALE, che congela la
  // pubblicazione dell'intera superficie.
  const src = 'export const IDS = new Set(RAW_IDS);\n';
  assert.throws(() => removeFromIdListLiteral(src, 'IDS', 'uno'), /forma è cambiata/);
});

test('la scansione dei delimitatori ignora stringhe e commenti', () => {
  // L'apostrofo italiano dentro un commento apriva una stringa che non si
  // chiudeva piu': da li' in poi ogni parentesi veniva ignorata.
  const src = [
    'export const IDS: string[] = [',
    "  // qui c'e' un apostrofo, e sotto una ] dentro una stringa",
    "  'uno', 'un]due',",
    '];',
    'export const DOPO = 1;',
    '',
  ].join('\n');
  const span = findIdListLiteralSpan(src, 'IDS');
  assert.ok(span);
  assert.equal(src[span.closeIdx], ']');
  assert.equal(src.slice(span.closeIdx, span.closeIdx + 2), '];');
  const out = removeFromIdListLiteral(src, 'IDS', 'uno');
  assert.equal(out.changed, true);
  assert.ok(out.src.includes("'un]due',"), out.src);
});

test('matchingDelimiter rifiuta un carattere che non apre niente', () => {
  assert.throws(() => matchingDelimiter('x];', 0), /non è un delimitatore/);
});

test('sul corpus vero la finestra e\' l\'array degli id, e nient\'altro', () => {
  const src = read('content/routerBlogData.ts');
  const span = findIdListLiteralSpan(src, 'ALL_BLOG_ARTICLE_IDS');
  assert.ok(span, 'ALL_BLOG_ARTICLE_IDS non piu\' un letterale in content/routerBlogData.ts');
  const body = src.slice(span.openIdx + 1, span.closeIdx);
  const ids = [...body.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  // Non-vacuita' con un pavimento vero: l'elenco ha migliaia di voci, quindi
  // una finestra collassata (o scavallata su un altro array) si vede.
  assert.ok(ids.length > 1000, `estratti ${ids.length} id, attesi migliaia: finestra fuori posto`);
  assert.equal(body.includes('export const'), false, 'la finestra ha inghiottito un\'altra dichiarazione');
  // Ogni id estratto e' un id reale della mappa slug dello stesso file.
  const slugKeys = new Set([...src.matchAll(/^\s*'([a-z0-9-]+)':\s*\{\s*it:/gm)].map((m) => m[1]));
  for (const id of ids.slice(0, 50)) {
    assert.ok(slugKeys.has(id), `'${id}' non e' una chiave di BLOG_SLUGS: la finestra non e' quella giusta`);
  }
});

test('i chiamanti importano la regola invece di ri-scriverla', () => {
  for (const caller of CALLERS) {
    const src = read(caller);
    assert.ok(/from '.*lib\/ts-literals\.mjs'/.test(src), `${caller}: non importa scripts/lib/ts-literals.mjs`);
    assert.equal(/indexOf\('\];'\)/.test(src), false, `${caller}: cerca ancora la chiusura come primo '];'`);
    assert.equal(/\[\^=\]\*=\\s\*\\\[/.test(src), false, `${caller}: ancora l'ancora per NOME che attraversa i newline`);
  }
});

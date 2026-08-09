/**
 * control-char-write-report.test.mjs — lo strip non deve piu' essere silenzioso.
 *
 * Il difetto che questi test pinnano (#95): i sette choke point di scrittura
 * annunciavano lo strip con un `console.error` dentro un run che ne produce
 * migliaia, senza exit code, senza contatore, senza artefatto. Il risultato e'
 * che il difetto a monte (#66) e' rimasto aperto per settimane mentre ogni
 * scrittura ne cancellava le prove.
 *
 * Il test piu' importante e' `il contesto conserva la coppia (byte, cifra)`:
 * e' quella coppia — non il byte da solo — a dire QUALE carattere e' andato
 * perso. Misurato il 2026-08-09: con la coppia intatta `repair-mangled-chars.mjs`
 * ha riparato 303 occorrenze su 582; le dieci gia' perse, dove il byte era stato
 * strippato lasciando la cifra orfana, non sono state recuperabili in alcun modo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  occurrencesIn,
  reportStrippedControlChars,
  strippedCount,
  resetCounters,
  CONTEXT_CHARS,
} from '../scripts/lib/control-char-write-report.mjs';

const B = String.fromCharCode(0x16); // il marker osservato nel corpus

test('occurrencesIn trova i marker e ne registra byte e posizione', () => {
  const src = `const t = 'comp${B}9tences';`;
  const occ = occurrencesIn(src);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].byte, 0x16);
  assert.equal(src[occ[0].at], B);
});

test('il contesto conserva la coppia (byte, carattere seguente)', () => {
  // E' l'asserzione che vale tutto il file. Con il solo offset non si
  // ricostruisce la parola; con la sola parola gia' strippata non si sa piu'
  // quale carattere andava rimesso. La coppia lo dice.
  const src = `const t = 'comp${B}9tences';`;
  const [o] = occurrencesIn(src);
  const i = o.context.indexOf(B);
  assert.ok(i >= 0, 'il byte deve sopravvivere nel contesto');
  assert.equal(o.context[i + 1], '9', 'la cifra che segue il byte e\' meta\' dell\'informazione');
});

test('il contesto non e\' l\'intero file', () => {
  const src = 'x'.repeat(500) + B + '9' + 'y'.repeat(500);
  const [o] = occurrencesIn(src);
  assert.ok(o.context.length <= CONTEXT_CHARS * 2 + 1, `contesto troppo largo: ${o.context.length}`);
});

test('un contenuto pulito non registra niente e non annuncia niente', () => {
  resetCounters();
  const logs = [];
  const n = reportStrippedControlChars('a.ts', 'pulito', 'pulito', { log: (s) => logs.push(s) });
  assert.equal(n, 0);
  assert.equal(strippedCount(), 0);
  assert.deepEqual(logs, []);
});

test('uno strip emette ::error::, non un warning fra mille', () => {
  // `::warning::` in un run che ne produce migliaia e' cio' che ha reso questo
  // difetto invisibile. L'annotazione deve essere di errore per comparire nel
  // sommario della run.
  resetCounters();
  const logs = [];
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  const n = reportStrippedControlChars('a.ts', `x${B}9y`, 'x9y', { log: (s) => logs.push(s), fsImpl, reportPath: '/tmp/x.jsonl' });
  assert.equal(n, 1);
  assert.equal(strippedCount(), 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^::error::/, `atteso ::error::, visto: ${logs[0]}`);
});

test('l\'evidenza finisce su disco in forma leggibile da un programma', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  reportStrippedControlChars('content/blog-body/fr/x.ts', `a${B}9b`, 'a9b', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl',
  });
  assert.equal(writes.length, 1);
  const rec = JSON.parse(writes[0].d.trim());
  assert.equal(rec.file, 'content/blog-body/fr/x.ts');
  assert.equal(rec.byte, 0x16);
  assert.ok(rec.context.includes(B), 'il record deve portare il byte, non solo il conteggio');
});

test('un disco che rifiuta la scrittura non fa fallire la scrittura del contenuto', () => {
  // L'evidenza e' un di piu'. Se il report non si scrive, l'annotazione e' gia'
  // uscita e l'articolo deve comunque essere scritto: bloccare qui fermerebbe
  // la produzione per un problema di logging.
  resetCounters();
  const logs = [];
  const fsImpl = { mkdirSync() { throw new Error('EACCES'); }, appendFileSync() {} };
  const n = reportStrippedControlChars('a.ts', `x${B}9y`, 'x9y', { log: (s) => logs.push(s), fsImpl });
  assert.equal(n, 1, 'l\'occorrenza va contata comunque');
  assert.ok(logs.some((l) => l.startsWith('::error::')), 'l\'errore va annunciato comunque');
  assert.ok(logs.some((l) => /impossibile scrivere/.test(l)), 'e il fallimento del report va detto');
});

test('i sette choke point di scrittura passano tutti da qui', () => {
  // Il guard di cablaggio: una funzione corretta che nessuno chiama e' lo stesso
  // difetto con un file in piu' nell'albero. Sono sette per costruzione (#75).
  const dir = path.resolve(import.meta.dirname, '..', 'scripts');
  const seen = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.mjs')) continue;
      const src = fs.readFileSync(p, 'utf-8');
      if (/sanitizeText\(/.test(src) && /writeFileSync\(/.test(src)) seen.push({ p, src });
    }
  };
  walk(dir);
  const missing = seen
    .filter(({ src }) => !/reportStrippedControlChars\(/.test(src))
    .map(({ p }) => path.relative(dir, p));
  assert.deepEqual(
    missing,
    [],
    'Questi script sanificano e scrivono senza registrare lo strip: il marker che rende '
      + 'esatta la riparazione va perso in silenzio (#95).\n  ' + missing.join('\n  '),
  );
  assert.ok(seen.length >= 7, `attesi almeno 7 choke point, visti ${seen.length}`);
});

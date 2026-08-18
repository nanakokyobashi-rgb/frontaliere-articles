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
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';
import {
  occurrencesIn,
  reportStrippedControlChars,
  strippedCount,
  residueCount,
  stripLasciaResiduo,
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
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '/tmp/s.md',
  });
  // Filtrato per destinazione e non `writes.length === 1`: da #94 le
  // destinazioni sono due — il JSONL e il sommario della run — e contare le
  // scritture invece dei record faceva fallire questo test appena ne compariva
  // una seconda, dicendo «il JSONL e' sbagliato» quando il JSONL era giusto.
  const suJsonl = writes.filter((w) => w.p === '/tmp/r.jsonl');
  assert.equal(suJsonl.length, 1);
  assert.equal(writes.filter((w) => w.p === '/tmp/s.md').length, 1, 'e il sommario riceve la sua copia');
  const rec = JSON.parse(suJsonl[0].d.trim());
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

test('ogni choke point di scrittura passa da qui — per OGNI sanitizer, non solo sanitizeText', () => {
  // ## Perche' questo guard e' stato riscritto (#133)
  //
  // La versione precedente cercava `sanitizeText\\(` + `writeFileSync\\(` e
  // asseriva `seen.length >= 7`. Era **auto-confermante**: l'ho scritta
  // conoscendo i sette file del ramo `sanitizeText`, quindi cercava la forma
  // che quei sette hanno, li trovava tutti e passava. Non poteva scoprire chi
  // ha una forma diversa — e quattro ce l'avevano, fra cui `build-api.mjs`,
  // che produce la superficie pubblicata: quindici scritture che strippavano
  // i byte C0 senza emettere ne' `::error::` ne' evidenza.
  //
  // Due cambi, entrambi necessari:
  //
  //  1. I sanitizer si LEGGONO dal modulo che li esporta, invece di cablarne
  //     il nome qui. Un `sanitizeQualcosa` aggiunto domani entra nel guard da
  //     solo, senza che nessuno si ricordi di aggiornare questa riga.
  //  2. La soglia `>= N` sparisce. Una soglia «almeno N» non fallisce mai
  //     quando la copertura cala insieme al numero di file trovati: e' una
  //     misura di se' stessa. Al suo posto c'e' l'insieme atteso, esplicito.
  const root = path.resolve(import.meta.dirname, '..', '..');

  // I sanitizer, dal modulo che li dichiara. Questa e' la meta' che rende il
  // guard capace di scoprire cio' che non sapeva gia'.
  const sanitizerSrc = fs.readFileSync(
    path.join(root, 'scripts', 'lib', 'sanitize-control-chars.mjs'), 'utf-8');
  const sanitizers = [...sanitizerSrc.matchAll(/export function (sanitize[A-Za-z]*)/g)].map((m) => m[1]);
  assert.ok(sanitizers.length >= 4, `attesi >= 4 sanitizer esportati, visti ${sanitizers.join(', ')}`);

  // Entrambi gli alberi che scrivono: il generatore e gli script di
  // pubblicazione. Guardarne uno solo era l'altra meta' del punto cieco.
  let seen = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.mjs')) continue;
      const src = fs.readFileSync(p, 'utf-8');
      if (!/writeFileSync\(/.test(src)) continue;
      const used = sanitizers.filter((s) => new RegExp(`\\b${s}\\(`).test(src));
      if (used.length) seen.push({ rel: path.relative(root, p), src, used });
    }
  };
  walk(path.join(root, 'generator', 'scripts'));
  walk(path.join(root, 'scripts'));

  // Un match non e' sempre un choke point: `sanitize*` e `writeFileSync` nello
  // stesso file non provano che la cosa sanificata sia la cosa scritta. Le
  // eccezioni si dichiarano QUI, con la ragione — non restringendo il pattern,
  // che e' cio' che toglie al guard la capacita' di scoprire.
  const NON_CHOKE = new Map([
    ['scripts/find-dirty-content-ids.mjs',
     'sanifica l\'HTML SONDATO dal live per confrontarlo, e scrive il proprio report JSON: '
     + 'due cose diverse. Non scrive mai il contenuto sanificato.'],
  ]);
  for (const rel of NON_CHOKE.keys()) {
    assert.ok(seen.some((s) => s.rel === rel),
      `${rel} e' dichiarato NON_CHOKE ma non corrisponde piu' al pattern: l'esenzione e' marcia, toglila.`);
  }
  seen = seen.filter((s) => !NON_CHOKE.has(s.rel));

  const missing = seen
    .filter(({ src }) => !/reportStrippedControlChars(Deep)?\(/.test(src))
    .map(({ rel, used }) => `${rel}  [${used.join(', ')}]`);

  assert.deepEqual(
    missing, [],
    'Questi script sanificano e scrivono senza registrare lo strip: il marker che rende\n'
      + 'esatta la riparazione va perso in silenzio (#95, #133).\n  ' + missing.join('\n  '),
  );

  // Nessuna soglia «almeno N»: l'insieme atteso, per nome. Se un file entra o
  // esce dalla lista dei choke point, questo test lo DICE invece di assorbirlo.
  const ATTESI = [
    'generator/scripts/batch-add-faq-to-articles.mjs',
    'generator/scripts/create-article.mjs',
    'generator/scripts/fix-faq-locales.mjs',
    'generator/scripts/generate-border-wait-ranking-article.mjs',
    'generator/scripts/generate-daily-brief-article.mjs',
    'generator/scripts/generate-events-digest-article.mjs',
    'generator/scripts/lib/article-meta-refresh.mjs',
    'generator/scripts/lib/evergreen-article-refresh.mjs',
    'scripts/build-api.mjs',
    'scripts/build-blog-index.mjs',
    'scripts/publish-article-fast.mjs',
    'scripts/refresh-hub-landing.mjs',
  ];
  assert.deepEqual(
    seen.map((s) => s.rel).sort(), ATTESI,
    'L\'insieme dei choke point e\' cambiato. Se e\' un file NUOVO che sanifica e scrive,\n'
      + 'cablalo e aggiungilo qui. Se e\' sparito, toglilo. Non e\' un test da allentare.',
  );
});

// ---------------------------------------------------------------------------
// residuo e evidenza durevole — issue #94
// ---------------------------------------------------------------------------

const B08 = String.fromCharCode(0x08);
const B10 = String.fromCharCode(0x10);
const OGNI_C0 = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]', 'g');

test('stripLasciaResiduo: lettera prima, cifra dopo — la parola si rompe', () => {
  const src = `comp${B}9tences`;
  assert.equal(stripLasciaResiduo(src, src.indexOf(B)), true);
});

test('stripLasciaResiduo: cifra dopo e lettera subito dopo — «Il <08>3territorio»', () => {
  // Il caso da cui viene «Il 3territorio poroso3»: prima del marker c'e' uno
  // spazio, quindi la prima regola non basta e serve guardare due caratteri
  // avanti. Senza questa clausola dieci delle occorrenze gia' perse sarebbero
  // classificate «strip innocuo».
  const src = `Il ${B08}3territorio poroso`;
  assert.equal(stripLasciaResiduo(src, src.indexOf(B08)), true);
});

test('stripLasciaResiduo: «<10>Der» NON e\' un residuo', () => {
  // Togliere il byte lascia «Der», che era la parola giusta. Contarlo come
  // residuo gonfierebbe il numero su cui si decidera' se bloccare, ed e'
  // esattamente il conteggio unico che questo campo esiste per spezzare.
  const src = `\n> ${B10}Der Hauptzweck ist`;
  assert.equal(stripLasciaResiduo(src, src.indexOf(B10)), false);
});

test('occurrencesIn marca ogni occorrenza con `residuo`', () => {
  const src = `> ${B10}Der Preis ist comp${B}9tences`;
  const occ = occurrencesIn(src);
  assert.deepEqual(occ.map((o) => o.residuo), [false, true]);
});

test('l\'annotazione dice quante rompono una parola, non solo quante ce n\'erano', () => {
  resetCounters();
  const righe = [];
  const src = `> ${B10}Der comp${B}9tences`;
  reportStrippedControlChars('content/x.ts', src, src.replace(OGNI_C0, ''), {
    log: (s) => righe.push(s),
    fsImpl: { mkdirSync() {}, appendFileSync() {} },
    reportPath: '/dev/null',
    summaryPath: '',
  });
  assert.equal(strippedCount(), 2);
  assert.equal(residueCount(), 1, 'uno solo dei due rompe una parola');
  assert.match(righe[0], /2 control character C0, di cui 1 che rompono una parola/);
});

test('l\'evidenza finisce anche nel sommario della run, dove sopravvive al runner', () => {
  // `reportPath` sta sotto RUNNER_TEMP, che GitHub cancella a fine job, e
  // nessun workflow lo carica come artefatto: senza questo, il contesto che
  // rende esatta una riparazione futura viene scritto e buttato via nello
  // stesso minuto.
  resetCounters();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccws-'));
  const summary = path.join(dir, 'summary.md');
  fs.writeFileSync(summary, '');
  try {
    const src = `des comp${B}9tences pratiques`;
    reportStrippedControlChars('content/blog-body/fr/x.ts', src, src.replace(B, ''), {
      log: () => {},
      reportPath: path.join(dir, 'strips.jsonl'),
      summaryPath: summary,
    });
    const testo = fs.readFileSync(summary, 'utf-8');
    assert.match(testo, /control-char-strip/);
    assert.match(testo, /content\/blog-body\/fr\/x\.ts/);
    // Il contesto c'e', e il byte e' scritto come <16>: un C0 crudo dentro il
    // sommario sarebbe lo stesso difetto che questo modulo non deve propagare.
    assert.match(testo, /comp<16>9tences/);
    assert.equal(testo.includes(B), false, 'nessun byte C0 crudo nel sommario');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('il sommario: il contesto resta UNA riga di tabella — a capo e TAB non la spezzano', () => {
  // Stesso difetto di #94 in `repair-mangled-chars.mjs`, qui nel file gemello:
  // `C0` esclude apposta 0x09/0x0A/0x0D perche' sono legali, ma se restano
  // grezzi nel contesto un a capo fa traboccare la cella Markdown su piu'
  // righe e corrompe la resa della tabella per tutte le righe successive.
  resetCounters();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccws-'));
  const summary = path.join(dir, 'summary.md');
  fs.writeFileSync(summary, '');
  try {
    const src = `avant\n\ncomp${B}9tences\tapres`;
    reportStrippedControlChars('content/x.ts', src, src.replace(B, ''), {
      log: () => {},
      reportPath: path.join(dir, 'strips.jsonl'),
      summaryPath: summary,
    });
    const testo = fs.readFileSync(summary, 'utf-8');
    const righe = testo.split('\n').filter((r) => r.includes('|'));
    assert.equal(righe.length, 3, 'intestazione + separatore + una riga dati: il contesto non deve aggiungere righe alla tabella');
    const rigaTabella = righe.find((r) => r.includes('comp<16>9tences'));
    assert.ok(rigaTabella, 'la riga di tabella con il contesto deve esistere');
    assert.ok(!rigaTabella.includes('\t'), 'niente TAB grezzo nella riga');
    assert.match(rigaTabella, /avant\\n\\ncomp<16>9tences\\tapres/, 'a capo e TAB resi visibili, non grezzi');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('senza GITHUB_STEP_SUMMARY non si scrive niente e non si rompe niente', () => {
  resetCounters();
  const src = `des comp${B}9tences`;
  const n = reportStrippedControlChars('content/x.ts', src, src.replace(B, ''), {
    log: () => {},
    fsImpl: { mkdirSync() {}, appendFileSync() {} },
    reportPath: '/dev/null',
    summaryPath: '',
  });
  assert.equal(n, 1);
  assert.equal(residueCount(), 1);
});

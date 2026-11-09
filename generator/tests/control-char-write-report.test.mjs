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
  reportStrippedControlCharsDeep,
  strippedCount,
  residueCount,
  stripLasciaResiduo,
  resetCounters,
  CONTEXT_CHARS,
} from '../scripts/lib/control-char-write-report.mjs';

const B = String.fromCharCode(0x16); // il marker osservato nel corpus

function expectRejectedWrite(file, original, clean, opts) {
  assert.throws(
    () => reportStrippedControlChars(file, original, clean, opts),
    /scrittura rifiutata/u,
  );
}

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

test('una modifica senza C0 riconoscibile fallisce chiusa, salvo una trasformazione esplicita', () => {
  resetCounters();
  assert.throws(
    () => reportStrippedControlChars('public/data/example.json', '{"name":"Chiasso"}', '{"name":"Lugano"}', {
      log: () => {}, summaryPath: '', reportPath: '/tmp/r.jsonl',
    }),
    /sanificazione non tracciata/u,
  );
  assert.equal(strippedCount(), 0, 'senza un marker non si inventa evidenza');

  assert.equal(reportStrippedControlChars('content/blog-body/it/example.ts', 'prima', 'dopo', {
    allowExpectedRewrite: true, log: () => {}, summaryPath: '',
  }), 0);

  assert.throws(
    () => reportStrippedControlCharsDeep('public/data/example.json', { name: 'Chiasso' }, { name: 'Lugano' }, {
      log: () => {}, summaryPath: '', reportPath: '/tmp/r.jsonl',
    }),
    /sanificazione non tracciata/u,
  );
  for (const [original, clean] of [
    [{ count: 1 }, { count: 2 }],
    [{ state: { enabled: true } }, { state: { enabled: false } }],
    [{ a: ['same'] }, { a: 'same' }],
  ]) {
    assert.throws(
      () => reportStrippedControlCharsDeep('public/data/example.json', original, clean, {
        log: () => {}, summaryPath: '', reportPath: '/tmp/r.jsonl',
      }),
      /sanificazione non tracciata/u,
    );
  }
  assert.equal(reportStrippedControlCharsDeep('content/blog-body/it/example.ts', ['prima'], ['dopo'], {
    allowExpectedRewrite: true, log: () => {}, summaryPath: '',
  }), 0);
});

test('un marker C0 emette ::error:: e rifiuta la scrittura', () => {
  resetCounters();
  const logs = [];
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  expectRejectedWrite('a.ts', `x${B}9y`, 'x9y', {
    log: (s) => logs.push(s), fsImpl, reportPath: '/tmp/x.jsonl', summaryPath: '',
  });
  assert.equal(strippedCount(), 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^::error::/, `atteso ::error::, visto: ${logs[0]}`);
  assert.match(logs[0], /Scrittura rifiutata prima di togliere il marker/u);
  assert.equal(writes.length, 1, 'il report viene scritto prima del rifiuto');
});

test('l\'evidenza finisce su disco in forma leggibile da un programma', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  expectRejectedWrite('content/blog-body/fr/x.ts', `a${B}9b`, 'a9b', {
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

test('l\'offset di un FAQ decodificato indica il campo e la propria base', () => {
  resetCounters();
  const writes = [];
  const source = String.raw`export default { 'blog.article.example.faq': '[{"q":"ab\\u00169","a":"risposta"}]' };`;
  expectRejectedWrite('content/blog-body/fr/example.ts', source, source, {
    log: () => {},
    fsImpl: { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) },
    reportPath: '/tmp/r.jsonl',
    summaryPath: '',
  });
  const rec = JSON.parse(writes.find((w) => w.p === '/tmp/r.jsonl').d.trim());
  assert.equal(rec.field, 'blog.article.example.faq[0].q');
  assert.equal(rec.offsetBasis, 'decoded-json-field');
  assert.equal(rec.at, 2, 'l\'offset e\' relativo al valore FAQ decodificato');
});

test('il report strutturato conserva il percorso dei campi e delimita i backtick nel Markdown', () => {
  resetCounters();
  const writes = [];
  const original = { 'art|`icle': 'pre | ``' + B + '9 post' };
  assert.throws(() => reportStrippedControlCharsDeep('public/data/article.jsonl', original, original, {
    log: () => {},
    fsImpl: { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) },
    reportPath: '/tmp/deep-r.jsonl',
    summaryPath: '/tmp/deep-s.md',
  }), /scrittura rifiutata/u);

  const rec = JSON.parse(writes.find((w) => w.p === '/tmp/deep-r.jsonl').d.trim());
  assert.equal(rec.field, '$.art|`icle');
  assert.equal(rec.offsetBasis, 'structured-field');
  assert.equal(rec.at, 8, 'l\'offset e\' relativo alla stringa del campo');
  const summary = writes.find((w) => w.p === '/tmp/deep-s.md').d;
  const row = summary.split('\n').find((line) => line.includes('structured-field'));
  assert.ok(summary.includes('&#124;'), 'i pipe nei campi e nel contesto sono entita, non separatori GFM');
  assert.ok(row.includes('``') && row.includes('```'), 'i delimitatori superano i backtick del campo e del contesto');
  assert.equal(row.split('|').length - 1, 7, 'la riga conserva le sette pipe strutturali della tabella');
});

test('un errore I/O del report non permette di scrivere il contenuto sanificato', () => {
  resetCounters();
  const logs = [];
  const fsImpl = { mkdirSync() { throw new Error('EACCES'); }, appendFileSync() {} };
  expectRejectedWrite('a.ts', `x${B}9y`, 'x9y', { log: (s) => logs.push(s), fsImpl });
  assert.equal(strippedCount(), 1, 'l\'occorrenza va contata comunque');
  assert.ok(logs.some((l) => l.startsWith('::error::')), 'l\'errore va annunciato comunque');
  assert.ok(logs.some((l) => /impossibile scrivere/.test(l)), 'e il fallimento del report va detto');
});

test('il controllo si applica anche quando clean coincide con un original che contiene C0', () => {
  resetCounters();
  const src = `x${B}9y`;
  expectRejectedWrite('a.ts', src, src, { log: () => {}, summaryPath: '' });
  assert.equal(strippedCount(), 1);
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
      // A choke point can use the shared snapshot writer instead of calling
      // fs.writeFileSync directly. Count explicit file-write helpers too;
      // otherwise moving an already-guarded write behind the helper makes the
      // inventory silently lose the caller that sanitizes and reports it.
      if (!/(?:writeFileSync|writeFileSnapshotAtomically|writeFileAtomic)\(/.test(src)) continue;
      const used = sanitizers.filter((s) => new RegExp(`\\b${s}\\(`).test(src));
      if (used.length) seen.push({ rel: path.relative(root, p), src, used });
    }
  };
  walk(path.join(root, 'generator', 'scripts'));
  walk(path.join(root, 'scripts'));

  // Un match non e' sempre un choke point: `sanitize*` e una chiamata di
  // scrittura diretta o tramite helper nello stesso file non provano da soli
  // che la cosa sanificata sia quella scritta. Le eccezioni si dichiarano QUI,
  // con la ragione — non restringendo il pattern, che toglierebbe al guard la
  // capacita' di scoprire nuovi casi.
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
    'generator/scripts/generate-pharmacy-evergreen-guides.mjs',
    'generator/scripts/lib/article-meta-refresh.mjs',
    'generator/scripts/lib/evergreen-article-refresh.mjs',
    'generator/scripts/repair-empty-template-fields.mjs',
    'generator/scripts/retranslate-blocking-bodies.mjs',
    'scripts/build-api.mjs',
    'scripts/build-blog-index.mjs',
    // La catena di render condivisa da publish-article-fast.mjs e
    // publish-section-pages.mjs: e' li' che le pagine articolo si scrivono.
    'scripts/lib/article-render-pipeline.mjs',
    'scripts/publish-section-pages.mjs',
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
  expectRejectedWrite('content/x.ts', src, src.replace(OGNI_C0, ''), {
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
    expectRejectedWrite('content/blog-body/fr/x.ts', src, src.replace(B, ''), {
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
    expectRejectedWrite('content/x.ts', src, src.replace(B, ''), {
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

test('senza GITHUB_STEP_SUMMARY il rifiuto continua a funzionare', () => {
  resetCounters();
  const src = `des comp${B}9tences`;
  expectRejectedWrite('content/x.ts', src, src.replace(B, ''), {
    log: () => {},
    fsImpl: { mkdirSync() {}, appendFileSync() {} },
    reportPath: '/dev/null',
    summaryPath: '',
  });
  assert.equal(strippedCount(), 1);
  assert.equal(residueCount(), 1);
});

test('il report decodifica i C0 JSON prima della sanificazione, incluse le chiavi', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  const backspace = String.fromCharCode(0x08);
  const raw = JSON.stringify({ ['ti' + backspace + 'tle']: 'Chi' + backspace + 'asso' });
  expectRejectedWrite('dist/api/data.json', raw, '{"title":"Chiasso"}', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });
  assert.equal(strippedCount(), 2);
  const jsonl = writes.find((w) => w.p === '/tmp/r.jsonl').d.trim();
  const records = jsonl.split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.byte === 0x08));
});

test('il report decodifica i campi TypeScript article prima che il writer li salvi', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  const source = String.raw`export const BLOG_ARTICLE_BODY = {
    'blog.article.example.body1': 'comp\x089tences',
    'blog.article.example.faq': '[{"que\\u0008stion":"Q","answer":"comp\\u00089tences"}]',
  };`;
  expectRejectedWrite('content/blog-body/it/example.ts', source, source, {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });
  const records = writes[0].d.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.byte), [0x08, 0x08, 0x08]);
});

test('il report decodifica anche i campi TypeScript dei chunk meta', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  const source = String.raw`export const BLOG_META = {
    'blog.article.example.title': 'Titolo\x08rotto',
  };`;
  expectRejectedWrite('content/blog-meta-it.ts', source, source, {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });
  assert.equal(JSON.parse(writes[0].d.trim()).byte, 0x08);
});

test('il report riconosce gli alias services/locales di body e meta', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  const source = String.raw`export const BLOG_ARTICLE_BODY = {
    'blog.article.example.body1': 'comp\x089tences',
  };`;
  const paths = [
    'services/locales/blog-body/it/example.ts',
    String.raw`services\locales\blog-body-ch\fr\example.ts`,
    'services/locales/blog-body-canton-sg/fr/example.ts',
    '/repo/services/locales/blog-meta-it.ts',
    String.raw`services\locales\blog-meta-ch-fr.ts`,
    'services/locales/blog-meta-canton-sg-fr.ts',
  ];

  for (const file of paths) {
    expectRejectedWrite(file, source, source, {
      log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
    });
  }

  assert.equal(writes.length, paths.length);
  assert.deepEqual(writes.map(({ d }) => JSON.parse(d.trim()).byte), new Array(paths.length).fill(0x08));
});

test('i riferimenti numerici XML sono registrati prima che il writer li rimuova', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  expectRejectedWrite('dist/api/sitemap.xml', '<title>comp&#x16;9tences</title>', '<title>comp9tences</title>', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });
  const record = JSON.parse(writes[0].d.trim());
  assert.equal(record.byte, 0x16);
  assert.equal(record.residuo, true);
});

test('gli escape C0 negli script HTML sono registrati ma un backslash letterale resta intatto', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  const escapedControl = String.raw`\u0008`;
  const html = '<script type="application/ld+json">{"headline":"Chi' + escapedControl + 'asso"}</script>';
  expectRejectedWrite('dist/api/article.html', html, '<script type="application/ld+json">{"headline":"Chiasso"}</script>', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });
  assert.equal(JSON.parse(writes[0].d.trim()).byte, 0x08);

  const literalBackslashB = String.raw`\b`;
  const cleanHtml = '<script>const text = ' + JSON.stringify(literalBackslashB) + ';</script>';
  assert.equal(reportStrippedControlChars('dist/api/article.html', cleanHtml, cleanHtml, { log: () => {} }), 0);
});

test('gli escape negli script HTML sono rilevati senza leggere commenti o regex literal', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  const escapedControl = String.raw`\x08`;
  const html = '<script>const text = "a' + escapedControl + 'b";</script>';
  expectRejectedWrite('dist/api/article.html', html, '<script>const text = "ab";</script>', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });
  assert.equal(JSON.parse(writes[0].d.trim()).byte, 0x08);

  const comment = '<script>// "' + escapedControl + '"\nconst text = "clean";</script>';
  const regex = '<script>const matcher = /["' + escapedControl + '"]/;</script>';
  const regexAfterIf = '<script>if (x) /["' + escapedControl + '"]/.test(x);</script>';
  const regexAfterBlock = '<script>function f(){} /["' + escapedControl + '"]/.test("");</script>';
  const regexAfterLabelledBlock = '<script>label: {} /["' + escapedControl + '"]/.test("");</script>';
  const regexAfterControlledLabel = '<script>if (x) label: {} /["' + escapedControl + '"]/.test("");</script>';
  assert.equal(reportStrippedControlChars('dist/api/comment.html', comment, comment, { log: () => {} }), 0);
  assert.equal(reportStrippedControlChars('dist/api/regex.html', regex, regex, { log: () => {} }), 0);
  assert.equal(reportStrippedControlChars('dist/api/regex-after-if.html', regexAfterIf, regexAfterIf, { log: () => {} }), 0);
  assert.equal(reportStrippedControlChars('dist/api/regex-after-block.html', regexAfterBlock, regexAfterBlock, { log: () => {} }), 0);
  assert.equal(reportStrippedControlChars('dist/api/regex-after-label.html', regexAfterLabelledBlock, regexAfterLabelledBlock, { log: () => {} }), 0);
  assert.equal(reportStrippedControlChars('dist/api/regex-after-controlled-label.html', regexAfterControlledLabel, regexAfterControlledLabel, { log: () => {} }), 0);
});

test('gli escape ottali legacy negli script inline sono respinti prima della scrittura', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  const octalEscapes = [String.raw`\7`, String.raw`\07`, String.raw`\08`];

  for (const [index, escapedControl] of octalEscapes.entries()) {
    const html = '<script>const text = "a' + escapedControl + 'b";</script>';
    expectRejectedWrite(`dist/api/octal-${index}.html`, html, '<script>const text = "ab";</script>', {
      log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
    });
  }
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.map(({ d }) => JSON.parse(d.trim()).byte), [0x07, 0x07, 0x00]);
});

test('gli escape C0 nei template literal statici sono rilevati, ma String.raw resta raw', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  const escapedControl = String.raw`\x08`;
  const html = '<script>const text = `a' + escapedControl + 'b`;</script>';
  expectRejectedWrite('dist/api/template.html', html, '<script>const text = `ab`;</script>', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });
  assert.equal(JSON.parse(writes[0].d.trim()).byte, 0x08);

  const raw = '<script>const text = String.raw`a' + escapedControl + 'b`;</script>';
  assert.equal(reportStrippedControlChars('dist/api/template-raw.html', raw, raw, { log: () => {} }), 0);

  const customTag = '<script>const text = identity`a' + escapedControl + 'b`;</script>';
  expectRejectedWrite('dist/api/template-tagged.html', customTag, '<script>const text = identity`ab`;</script>', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });

  const memberTag = '<script>const text = Foo.String.raw`a' + escapedControl + 'b`;</script>';
  expectRejectedWrite('dist/api/template-member-tag.html', memberTag, '<script>const text = Foo.String.raw`ab`;</script>', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });

  const interpolated = '<script>const text = `a' + escapedControl + '${value}b`;</script>';
  expectRejectedWrite('dist/api/template-interpolated.html', interpolated, '<script>const text = `a${value}b`;</script>', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });
});

test('data-src non rende esterno un blocco script inline', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  const escapedControl = String.raw`\x08`;
  const html = '<script data-src="example.js">const text = "a' + escapedControl + 'b";</script>';
  expectRejectedWrite('dist/api/data-src.html', html, '<script data-src="example.js">const text = "ab";</script>', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });

  const quotedAttributeText = '<script data-note=" src=external.js > still inline">const text = "a' + escapedControl + 'b";</script>';
  expectRejectedWrite('dist/api/quoted-attribute.html', quotedAttributeText, '<script data-note=" src=external.js > still inline">const text = "ab";</script>', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });

  const malformedEndTag = '<script>const text = "a' + escapedControl + 'b";</script x>';
  expectRejectedWrite('dist/api/malformed-end-tag.html', malformedEndTag, '<script>const text = "ab";</script x>', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });

  const nbsp = '\u00a0';
  const nonAsciiBoundary = '<script>const decoy = "</script' + nbsp + '>"; const text = "a' + escapedControl + 'b";</script>';
  expectRejectedWrite('dist/api/non-ascii-end-boundary.html', nonAsciiBoundary,
    '<script>const decoy = "</script' + nbsp + '>"; const text = "ab";</script>', {
      log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
    });
});

test('un riferimento numerico in un commento XML segue il confine del sanitizer', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  const xml = '<!-- titolo &#x08; lasciato in documentazione --><title>pulito</title>';
  expectRejectedWrite('dist/api/comment.xml', xml, '<!-- titolo  lasciato in documentazione --><title>pulito</title>', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });
  assert.equal(JSON.parse(writes[0].d.trim()).byte, 0x08);
});

test('un riferimento numerico dentro CDATA XML segue il confine del sanitizer', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  const xml = '<title><![CDATA[&#x08;]]></title>';
  expectRejectedWrite('dist/api/cdata.xml', xml, '<title><![CDATA[]]></title>', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });
  assert.equal(JSON.parse(writes[0].d.trim()).byte, 0x08);
});

test('un riferimento numerico dentro una processing instruction XML segue il confine del sanitizer', () => {
  resetCounters();
  const writes = [];
  const fsImpl = { mkdirSync() {}, appendFileSync: (p, d) => writes.push({ p, d }) };
  const xml = '<?probe &#x08;?> <title>pulito</title>';
  expectRejectedWrite('dist/api/pi.xml', xml, '<?probe ?> <title>pulito</title>', {
    log: () => {}, fsImpl, reportPath: '/tmp/r.jsonl', summaryPath: '',
  });
  assert.equal(JSON.parse(writes[0].d.trim()).byte, 0x08);
});

test('il report raw non interpreta escape TypeScript che compaiono solo nei commenti', () => {
  resetCounters();
  const source = String.raw`// documentazione: "\u0008"`;
  assert.equal(reportStrippedControlChars('content/blog-body/fr/article.ts', source, source, { log: () => {} }), 0);
});

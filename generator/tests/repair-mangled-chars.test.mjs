/**
 * Guard di `generator/scripts/repair-mangled-chars.mjs` — issue #94.  `node --test`.
 *
 * COSA DEVE DIMOSTRARE
 *
 * Non che lo script ripari: che RIFIUTI.  Una riparazione sbagliata di
 * `content/` e' irreversibile — appena il byte C0 sparisce nessuno sa piu'
 * quale carattere ci fosse — quindi il valore dello script sta tutto nei casi
 * in cui si ferma:
 *
 *   - ambiguo:  `Municipalit 9` e' sia «Municipalité» sia «Municipalità», e
 *               nel corpus esistono entrambe;
 *   - non-lettera: dove il marker stava al posto di una virgoletta, togliergli
 *               il posto e metterci una lettera rovina una parola che era gia'
 *               giusta (` Der` -> «Þr» e' successo davvero, in un giro
 *               precedente di questo stesso script);
 *   - legge non verificata: la «legge del nibble» (0x0E+'9' = 0xE9 = é) vale in
 *               due file su 29 e va provata nel file dove la si usa, mai
 *               assunta.
 *
 * Ogni asserzione qui sotto e' stata falsificata rimettendo il difetto
 * corrispondente nello script e controllando che il test diventasse rosso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { riparaTesto, costruisciLessico, MARKER_G } from '../scripts/repair-mangled-chars.mjs';

const QUI = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(QUI, '..', 'scripts', 'repair-mangled-chars.mjs');

/** I byte C0 sono difficili da scrivere in un sorgente: qui si compongono. */
const B = (n) => String.fromCharCode(n);

/**
 * Il lessico e' la sola prova che lo script accetta, quindi la fixture deve
 * contenerlo: ogni parola due volte, perche' la soglia di default e' 2.
 */
const PAROLE_PULITE = [
  'dépenses', 'Dépenses', 'réduit', 'contrôle', 'financière', 'délais', 'évolution',
  'marché', 'première', 'conçues', 'Municipalité', 'Municipalità', 'à', 'Der',
  'compétences', 'millions', 'nouveaux',
];
const FILE_PULITO = `${PAROLE_PULITE.join(' ')}\n${PAROLE_PULITE.join(' ')}\n`;

function lessicoDiProva(extra = {}) {
  const testi = new Map(Object.entries({ 'content/pulito.ts': FILE_PULITO, ...extra }));
  const file = [...testi.keys()].map((percorso) => ({ percorso }));
  return costruisciLessico(file, testi).lessico;
}

function ripara(testo, extra) {
  return riparaTesto(testo, lessicoDiProva(extra), 2);
}

// ---------------------------------------------------------------------------
// quello che deve riparare
// ---------------------------------------------------------------------------

test('lessico: la parola ricostruita esiste nel corpus pulito, quindi si ripara', () => {
  const r = ripara(`les d${B(0x0e)}9penses de la ville`);
  assert.equal(r.testo, 'les dépenses de la ville');
  assert.equal(r.rifiuti.length, 0);
  assert.equal(r.riparazioni[0].canale, 'lessico');
});

test('hex: la coda e\' l\'esadecimale Latin-1 del carattere perduto', () => {
  const r = ripara(`des d${B(0x00)}e9lais courts`);
  assert.equal(r.testo, 'des délais courts');
  assert.equal(r.riparazioni[0].canale, 'hex+lessico');
});

test('hex: vale anche dove il lessico non ha niente da dire (` e0` isolato = «à»)', () => {
  const r = ripara(`réduit ${B(0x00)}e0 -2,7 millions`);
  assert.equal(r.testo, 'réduit à -2,7 millions');
  assert.equal(r.riparazioni[0].canale, 'hex');
});

test('nibble: la legge si usa DOPO averla verificata in questo file', () => {
  // Tre prove indipendenti la confermano: 0x0E+'9'=0xE9=é, 0x0F+'4'=0xF4=ô,
  // 0x0E+'8'=0xE8=è.  Solo allora `0x0E+'0'` isolato puo' diventare «à».
  const testo = [
    `les d${B(0x0e)}9penses`,
    `le contr${B(0x0f)}4le`,
    `la situation financi${B(0x0e)}8re`,
    `r${B(0x0e)}9duit ${B(0x0e)}0 -2,7 millions`,
  ].join('\n');
  const r = ripara(testo);
  assert.equal(r.leggeNibble, true);
  assert.match(r.testo, /réduit à -2,7 millions/);
  assert.equal(r.rifiuti.length, 0);
});

// ---------------------------------------------------------------------------
// quello che deve RIFIUTARE — e' il punto dello script
// ---------------------------------------------------------------------------

test('FAIL-CLOSED — ambiguo: due ricostruzioni esistono, non si sceglie', () => {
  // `Municipalité` (fr) e `Municipalità` (it) sono entrambe nel corpus.
  const r = ripara(`la Municipalit${B(0x0e)}9 de Bellinzone`);
  assert.ok(r.testo.includes(`Municipalit${B(0x0e)}9`), 'il marker deve restare al suo posto');
  assert.equal(r.riparazioni.length, 0);
  assert.equal(r.rifiuti.length, 1);
  assert.match(r.rifiuti[0].motivo, /ambiguo/);
  assert.deepEqual([...r.rifiuti[0].candidati].sort(), ['Municipalità', 'Municipalité']);
});

test('FAIL-CLOSED — la legge del nibble NON verificata non si applica', () => {
  // Stesse tre prove del test precedente, ma con un byte che la smentisce:
  // 0x16+'9' vale é e 0x16*16+9 = 0x169, che non e' é.  Con la legge caduta,
  // `0x0E+'0'` isolato resta li' invece di diventare «à».
  const testo = [
    `sur le march${B(0x16)}9`,
    `la premi${B(0x16)}8re fois`,
    `des pièces con${B(0x16)}7ues`,
    `réduit ${B(0x0e)}0 -2,7 millions`,
  ].join('\n');
  const r = ripara(testo);
  assert.equal(r.leggeNibble, false);
  assert.ok(r.testo.includes(`${B(0x0e)}0`), 'senza legge verificata il marker resta');
  assert.match(r.testo, /sur le marché/, 'le prove lessicali restano valide');
});

test('FAIL-CLOSED — dove il marker stava al posto di una virgoletta non si mette una lettera', () => {
  // ` Der`: "De" si legge 0xDE, che e' Þ.  Ma «Der» senza il marker e' una
  // parola che il corpus conosce, quindi li' non mancava una lettera.
  const r = ripara(`> ${B(0x10)}Der Hauptzweck`);
  assert.ok(!r.testo.includes('Þ'), 'nessun Þ: sarebbe un errore silenzioso');
  assert.ok(r.testo.includes(`${B(0x10)}Der`), 'il marker resta, e con lui l\'ancora');
  assert.match(r.rifiuti[0].motivo, /non e' una lettera/);
});

test('FAIL-CLOSED — coppia mai vista e parola che non esiste: nessuna ipotesi', () => {
  const r = ripara(`darunter die ${B(0x07)}9euerwehr von Lugano`);
  assert.ok(r.testo.includes(`${B(0x07)}9euerwehr`));
  assert.equal(r.riparazioni.length, 0);
  assert.match(r.rifiuti[0].motivo, /nessuna prova/);
});

test('FAIL-CLOSED — un marker isolato fra due spazi non ha prova possibile', () => {
  // Era una virgoletta o un trattino: zero lettere intorno, quindi il lessico
  // non ha niente su cui pronunciarsi e non si inventa una lettera.
  const r = ripara(`e la crescita ${B(0x02)} nella zona`);
  assert.equal(r.riparazioni.length, 0);
  assert.equal(r.rifiuti.length, 1);
  assert.match(r.rifiuti[0].motivo, /nessuna prova/);
  assert.ok(r.testo.includes(B(0x02)));
});

test('FAIL-CLOSED — l\'apostrofo di bordo non vale come prova', () => {
  // Ritagliando gli apici `’territorio` diventa `territorio`, che nel corpus
  // c'e': senza il controllo, una virgoletta di apertura si vedrebbe
  // «confermata» da una parola che l'apostrofo non ce l'ha.
  const r = ripara(`descrive il ${B(0x08)}3territorio poroso`, {
    'content/altro.ts': 'territorio territorio poroso poroso\n',
  });
  assert.ok(r.testo.includes(`${B(0x08)}3territorio`));
  assert.equal(r.riparazioni.length, 0);
});

// ---------------------------------------------------------------------------
// proprieta' del risultato
// ---------------------------------------------------------------------------

test('idempotenza: rilanciato sul proprio risultato non cambia piu niente', () => {
  const testo = `les d${B(0x0e)}9penses et le contr${B(0x0f)}4le, Municipalit${B(0x0e)}9 incluse`;
  const lessico = lessicoDiProva();
  const a = riparaTesto(testo, lessico, 2);
  const b = riparaTesto(a.testo, lessico, 2);
  assert.equal(b.testo, a.testo);
  assert.equal(b.riparazioni.length, 0);
});

test('non introduce mai nuovi marker e non ne perde nessuno di non riparato', () => {
  const testo = `d${B(0x0e)}9penses ${B(0x07)}9euerwehr ${B(0x02)} contr${B(0x0f)}4le`;
  const r = ripara(testo);
  const prima = (testo.match(MARKER_G) || []).length;
  const dopo = (r.testo.match(MARKER_G) || []).length;
  assert.equal(prima, 4);
  assert.equal(dopo, prima - r.riparazioni.reduce((s, x) => s + x.dettagli.length, 0));
  assert.equal(dopo, 2);
});

// ---------------------------------------------------------------------------
// la CLI
// ---------------------------------------------------------------------------

function alberoDiProva(fileSporchi) {
  const radice = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-mangled-'));
  fs.mkdirSync(path.join(radice, 'content'), { recursive: true });
  fs.writeFileSync(path.join(radice, 'content', 'pulito.ts'), FILE_PULITO);
  for (const [nome, testo] of Object.entries(fileSporchi)) {
    fs.writeFileSync(path.join(radice, 'content', nome), testo);
  }
  return radice;
}

function esegui(radice, argomenti) {
  try {
    const out = execFileSync('node', [SCRIPT, '--root', radice, '--json', ...argomenti], { encoding: 'utf8' });
    return { codice: 0, rapporto: JSON.parse(out) };
  } catch (e) {
    return { codice: e.status, rapporto: e.stdout ? JSON.parse(e.stdout) : null, stderr: e.stderr };
  }
}

test('CLI: il dry-run e\' il default e non tocca un solo byte', () => {
  const sporco = `les d${B(0x0e)}9penses\n`;
  const radice = alberoDiProva({ 'sporco.ts': sporco });
  try {
    const { rapporto } = esegui(radice, []);
    assert.equal(rapporto.modalita, 'dry-run');
    assert.equal(rapporto.riparate, 1);
    assert.equal(fs.readFileSync(path.join(radice, 'content', 'sporco.ts'), 'utf8'), sporco,
      'in dry-run il file su disco deve restare identico');
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

test('CLI: --write scrive, e un secondo giro non trova piu\' niente', () => {
  const radice = alberoDiProva({ 'sporco.ts': `les d${B(0x0e)}9penses\n` });
  try {
    const primo = esegui(radice, ['--write']);
    assert.equal(primo.codice, 0, 'senza rifiuti il codice d\'uscita e\' 0');
    assert.equal(fs.readFileSync(path.join(radice, 'content', 'sporco.ts'), 'utf8'), 'les dépenses\n');
    const secondo = esegui(radice, ['--write']);
    assert.equal(secondo.rapporto.riparate, 0);
    assert.equal(secondo.rapporto.occorrenze, 0);
    assert.equal(fs.readFileSync(path.join(radice, 'content', 'sporco.ts'), 'utf8'), 'les dépenses\n');
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

test('CLI: se resta anche una sola occorrenza rifiutata il codice d\'uscita e\' 2', () => {
  const radice = alberoDiProva({ 'sporco.ts': `die ${B(0x07)}9euerwehr\n` });
  try {
    const { codice, rapporto } = esegui(radice, ['--write']);
    assert.equal(codice, 2);
    assert.equal(rapporto.rifiutate, 1);
    assert.equal(fs.readFileSync(path.join(radice, 'content', 'sporco.ts'), 'utf8'), `die ${B(0x07)}9euerwehr\n`);
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

test('CLI: --apply e\' un alias di --write, non un dry-run travestito', () => {
  const radice = alberoDiProva({ 'sporco.ts': `les d${B(0x0e)}9penses\n` });
  try {
    const { rapporto } = esegui(radice, ['--apply']);
    assert.equal(rapporto.modalita, 'SCRITTURA');
    assert.equal(fs.readFileSync(path.join(radice, 'content', 'sporco.ts'), 'utf8'), 'les dépenses\n');
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

test('CLI: --write insieme a --ref e\' un errore d\'uso, non una scrittura', () => {
  const radice = alberoDiProva({ 'sporco.ts': `les d${B(0x0e)}9penses\n` });
  try {
    const { codice, stderr } = esegui(radice, ['--write', '--ref', 'HEAD']);
    assert.equal(codice, 1);
    assert.match(stderr, /non hanno senso/);
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

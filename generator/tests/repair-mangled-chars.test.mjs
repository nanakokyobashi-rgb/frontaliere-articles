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
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  riparaTesto, risolviToken, costruisciLessico, riparaResidui, residuiDi, MARKER_G,
  localeDi,
} from '../scripts/repair-mangled-chars.mjs';

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
  'compétences', 'millions', 'nouveaux', 'coûts', 'entraînent', 's’élèvent', 'grace',
  'équilibré',
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

test('parassita: la lettera non-ASCII e\' gia\' li\', si toglie solo il byte', () => {
  // `d 9penses` sarebbe una ricostruzione; `d épenses` no: la é c'e' gia'.
  // Cancellare il marker qui non indovina nessuna lettera.
  const r = ripara(`les d${B(0x0e)}épenses de la ville`);
  assert.equal(r.testo, 'les dépenses de la ville');
  assert.equal(r.rifiuti.length, 0);
  assert.match(r.riparazioni[0].canale, /parassita/);
  assert.equal(r.riparazioni[0].dettagli[0].carattere, '');
});

test('parassita: vale anche quando la cancellazione non basta da sola', () => {
  // Due marker, tutti e due davanti a una lettera non-ASCII, ma «sélèvent» non
  // esiste: il lessico conosce «s’élèvent», quindi il primo marker diventa
  // l'apostrofo e solo il secondo sparisce.  Parassita apre un candidato, non
  // impone la cancellazione.
  const r = ripara(`les recettes s${B(0x0e)}él${B(0x0e)}èvent à 233,1 millions`);
  assert.match(r.testo, /les recettes s’élèvent à/);
  assert.equal(r.rifiuti.length, 0);
});

test('parassita: senza conferma del lessico il marker resta dov\'e\'', () => {
  const r = ripara(`des d${B(0x0e)}épenzes imaginaires`);
  assert.ok(r.testo.includes(`d${B(0x0e)}épenzes`));
  assert.equal(r.riparazioni.length, 0);
});

test('parassita: NON si applica se la lettera dopo il marker e\' ASCII', () => {
  // `gr ace` -> «grace» esiste nel corpus, ma la 'a' e' ASCII: la cancellazione
  // non entra fra i candidati e il vecchio rifiuto per «non e' una lettera»
  // resta in piedi.  Senza questa riga il marker sparirebbe e con lui l'ancora
  // di «grâce».
  const r = ripara(`les d${B(0x0e)}épenses gr${B(0x0e)}ace aux nouveaux crédits`);
  assert.ok(r.testo.includes(`gr${B(0x0e)}ace`), 'il marker davanti a una lettera ASCII resta');
  assert.match(r.testo, /les dépenses/, 'quello davanti alla é invece si toglie');
  assert.match(r.rifiuti[0].motivo, /non e' una lettera/);
});

test('parassita: una cancellazione non sposta i marker che vengono dopo', () => {
  // `<0E>équilibr<0E>`: il primo marker sparisce, il secondo diventa é.  Se la
  // cancellazione contasse come un carattere rimesso, la posizione del secondo
  // finirebbe fuori dal ritaglio e la parola verrebbe rifiutata pur essendo nel
  // corpus.  E' il caso di «Un budget équilibré», due volte su origin/main.
  const r = ripara(`Un budget ${B(0x0e)}équilibr${B(0x0e)} pour la ville`);
  assert.match(r.testo, /Un budget équilibré pour la ville/);
  assert.equal(r.rifiuti.length, 0);
});

test('coda esadecimale: la cifra puo\' essere a-f, non solo 0-9', () => {
  // 0x0F+'b' = 0xFB = û, e il lessico conferma «coûts».  Fermarsi a [0-9]
  // lasciava fuori sei caratteri Latin-1 per riga della tabella.
  const r = ripara(`pour estimer temps et co${B(0x0f)}bts`);
  assert.equal(r.testo, 'pour estimer temps et coûts');
  assert.equal(r.rifiuti.length, 0);
});

test('coda esadecimale a-f: la coda si consuma, non resta nella parola', () => {
  // `entra 0enent` -> 0x0E+'e' = 0xEE = î: «entraînent», con la 'e' della coda
  // mangiata dall'unita'.  Se la coda restasse verrebbe «entraîenent».
  const r = ripara(`ces politiques entra${B(0x0e)}enent des charges`);
  assert.match(r.testo, /politiques entraînent des charges/);
});

test('nibble isolato: se il corpus usa il carattere DA SOLO, si ripara', () => {
  // Il simmetrico del rifiuto qui sotto, e la ragione per cui la guardia non e'
  // un divieto: 0x0E+'0' = 0xE0 = à, e «à» e' una parola francese che il corpus
  // usa da sola.  La legge del nibble sceglie, il lessico conferma, si scrive.
  const r = risolviToken(`${B(0x0e)}0`, new Map([['à', 5]]), 2, new Map(), true);
  assert.equal(r.esito, 'riparato');
  assert.equal(r.testo, 'à');
  assert.equal(r.canale, 'nibble');
  assert.equal(r.freq, 5, 'la frequenza riportata e\' quella che ha fatto da prova');
});

// ---------------------------------------------------------------------------
// quello che deve RIFIUTARE — e' il punto dello script
// ---------------------------------------------------------------------------

test('FAIL-CLOSED — hex isolato: il carattere da solo dev\'essere una parola del corpus', () => {
  // 0xE2 e' â in Latin-1, ma in questo corpus e' anche il primo byte UTF-8 di
  // « — » e di « “ ».  «à» da sola e' una parola francese e il corpus la usa;
  // «â» no.  Sulla riga vera — `<00>e2 Il est important de noter` — la lettura
  // esadecimale scriverebbe «â» al posto di un segno.
  const r = ripara(`travaux prioritaires\n${B(0x00)}e2 Il est important de noter`);
  assert.ok(!r.testo.includes('â'), 'nessuna â inventata');
  assert.ok(r.testo.includes(`${B(0x00)}e2`), 'il marker resta, e con lui l\'ancora');
  assert.equal(r.riparazioni.length, 0);
});

test('FAIL-CLOSED — nibble isolato: la legge vale nel FILE, non nel token da solo', () => {
  // Riproduzione esatta del caso segnalato in review sulla PR #142.  Con la
  // legge del nibble gia' verificata (`leggeNibble = true`), `0x0F+'4'` da solo
  // si legge ô — ma nessuna parola del corpus conferma che «ô» da sola sia una
  // ricostruzione valida, e prima della guardia veniva scritta con `freq: 0`.
  // E' lo stesso argomento che il canale hex usa per `<00>e2`: la lettura da
  // sola non e' una prova, e una prova sul FILE non e' una prova sul TOKEN.
  const r = risolviToken(`${B(0x0f)}4`, new Map([['bonjour', 5]]), 2, new Map(), true);
  assert.equal(r.esito, 'rifiutato', 'nessuna ô inventata a frequenza zero');
  assert.match(r.motivo, /nessuna prova/);
});

test('FAIL-CLOSED — coda esadecimale MAIUSCOLA: e\' un\'iniziale, non una coda', () => {
  // Simmetrico di «la cifra puo' essere a-f»: con la 'b' minuscola `co<0F>bts`
  // diventa «coûts», con la 'B' maiuscola l'unita' corta non si forma e non
  // resta niente da confermare.  Misurato sui 279 marker di origin/main: le
  // sole 4 occorrenze con A-F maiuscola dopo il marker sono `<10>Der`,
  // `<01>Eureka` e `<00>Alain` — iniziali di parola, non code.
  const r = ripara(`pour estimer temps et co${B(0x0f)}Bts`);
  assert.ok(r.testo.includes(`co${B(0x0f)}Bts`), 'la B maiuscola resta dov\'e\'');
  assert.equal(r.riparazioni.length, 0);
});

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
    const dove = path.join(radice, 'content', nome);
    // `nome` puo' essere annidato (`blog-body-ch/de/x.ts`): senza questo mkdir
    // il test che copre la seconda cartella dei corpi non potrebbe scriverla.
    fs.mkdirSync(path.dirname(dove), { recursive: true });
    fs.writeFileSync(dove, testo);
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

// Le DUE cartelle dei corpi, e perche' serve un test che lo dica.
//
// I corpi articolo di questo repo stanno in `content/blog-body/<loc>/` (sezione
// frontaliere) E in `content/blog-body-ch/<loc>/` (sezione svizzera).  Il
// walker di questo script scende ricorsivamente in `content/`, quindi le prende
// entrambe PER COSTRUZIONE — ed e' esattamente la forma di copertura che in
// questo repo e' gia' fallita in silenzio: un `loadBody()` hardcoded su
// `content/blog-body/` non ha mai guardato `blog-body-ch/`, dove stavano tutte
// le occorrenze che si cercavano.
//
// Falsificato prima di scriverlo, sul corpus vero di `origin/main`: aggiungendo
// a `elencaFileDisco` un `if (v.name === 'blog-body-ch') continue;` il dry-run
// passa da «26 file / 224 occorrenze» a «25 file / 221» — perde
// `content/blog-body-ch/de/credito-imposta-frontalieri-2026.ts` e i suoi 3
// marker — e le 46 asserzioni preesistenti restavano TUTTE verdi.  Con questo
// test quella mutazione e' rossa.
//
// Il gemello `scripts/find-dirty-content-ids.mjs` questa prova ce l'ha gia'
// (togliere `blog-body-ch` da `BODY_DIR_SECTIONS` rompe 2 dei suoi 39 test):
// qui mancava, ed e' il lato che SCRIVE.
test('CLI: il walker scende in ENTRAMBE le cartelle dei corpi, blog-body/ e blog-body-ch/', () => {
  const sporco = `les d${B(0x0e)}9penses\n`;
  const radice = alberoDiProva({
    'blog-body/fr/frontaliere.ts': sporco,
    'blog-body-ch/de/svizzera.ts': sporco,
  });
  try {
    const { rapporto } = esegui(radice, ['--write']);
    assert.equal(rapporto.fileConMarker, 2, 'il walker deve vedere due file, uno per cartella');
    assert.equal(rapporto.riparate, 2);
    const visti = rapporto.perFile.map((f) => f.file).sort();
    assert.deepEqual(visti, [
      'content/blog-body-ch/de/svizzera.ts',
      'content/blog-body/fr/frontaliere.ts',
    ], 'il rapporto deve nominare tutte e due le cartelle');
    // La prova che conta e' sul disco: il file della sezione svizzera dev\'essere
    // stato RISCRITTO, non solo elencato.
    assert.equal(
      fs.readFileSync(path.join(radice, 'content', 'blog-body-ch', 'de', 'svizzera.ts'), 'utf8'),
      'les dépenses\n',
    );
    assert.equal(
      fs.readFileSync(path.join(radice, 'content', 'blog-body', 'fr', 'frontaliere.ts'), 'utf8'),
      'les dépenses\n',
    );
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

// ---------------------------------------------------------------------------
// il canale TESTIMONE — issue #94, secondo giro
// ---------------------------------------------------------------------------
//
// Anche qui il valore sta nei rifiuti, e per una ragione che i test del lessico
// non coprono: i testimoni sono ALTRE GENERAZIONI dello stesso testo. Sulle
// parole concordano, sulla punteggiatura e sull'impaginazione no. Un canale che
// accetta qualunque cosa il testimone abbia in mezzo non ripara un carattere:
// importa l'impaginazione di un'altra generazione, e dove il testimone non ha
// niente butta via l'ancora. I quattro `FAIL-CLOSED` qui sotto sono le quattro
// forme in cui e' successo davvero su
// `content/blog-body/it/lavena-ponte-tresa-territorio-poroso.ts`.
//
// Falsificazioni eseguite, una per vincolo, ciascuna rimettendo il difetto
// nello script e controllando quale test diventa rosso:
//   - tolto `LETTERA.test(carattere)`      -> rosso «propone un segno di punteggiatura»
//   - tolto il filtro sui file con marker  -> rosso «non guarda i file che hanno un marker»
//   - ammesso un rimpiazzo di 2-4 caratteri -> rosso «propone una virgoletta»

/** Un albero con un file sporco e uno o piu' testimoni puliti. */
function conTestimoni(sporco, testimoni) {
  const alberi = { 'sporco.ts': sporco };
  let n = 0;
  for (const t of testimoni) { n += 1; alberi[`testimone${n}.ts`] = t; }
  return alberoDiProva(alberi);
}

function riparaConAlbero(sporco, testimoni) {
  const radice = conTestimoni(sporco, testimoni);
  try {
    const { rapporto } = esegui(radice, ['--write']);
    return { rapporto, testo: fs.readFileSync(path.join(radice, 'content', 'sporco.ts'), 'utf8') };
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
}

test('testimone: la stessa frase pulita altrove nel corpus da\' la lettera perduta', () => {
  // Il caso reale: `- Qui : Municipalit<0E> de Bellinzone`, che il lessico
  // rifiuta come ambiguo (Municipalité / Municipalità esistono entrambe) e che
  // il testimone risolve perche' la frase INTERA esiste solo in una forma.
  const frase = 'du Tessin\\n- Qui : Municipalit';
  const coda = ' de Bellinzone\\n- Montant : deficit';
  const { rapporto, testo } = riparaConAlbero(
    `${frase}${B(0x0e)}${coda}\n`,
    [`${frase}é${coda}\n`],
  );
  assert.equal(rapporto.riparate, 1);
  assert.equal(testo, `${frase}é${coda}\n`);
  assert.equal(rapporto.riparazioni[0].canale, 'testimone');
  assert.deepEqual(rapporto.riparazioni[0].testimoni, ['content/testimone1.ts']);
});

test('testimone: la coda puo\' contenere altri marker, l\'ancora dopo no', () => {
  // `sc<00>f<16>9narios` -> «scénarios»: due marker e una lettera di troppo al
  // posto di una sola é. Nessun canale per token puo' arrivarci — il giro
  // precedente lo aveva classificato «non riparabile per principio».
  const frase = 'quelques comparaisons entre des sc';
  const coda = 'narios pratiques :\\n\\n- Stages';
  const { rapporto, testo } = riparaConAlbero(
    `${frase}${B(0x00)}f${B(0x16)}9${coda}\n`,
    [`${frase}é${coda}\n`],
  );
  assert.equal(rapporto.riparate, 2, 'i due marker contano entrambi come riparati');
  assert.equal(testo, `${frase}é${coda}\n`);
});

test('FAIL-CLOSED — testimone che propone un segno di punteggiatura, non una lettera', () => {
  // Reale: il gemello pulito di `lavena` ha `svizzeri. Il sindaco` dove il file
  // sporco ha `svizzeri<08>3. Il sindaco`. Le ancore si allineano — il
  // testimone propone il punto al posto del marker — ma un punto non e' una
  // lettera: accettarlo qui butta via l'ancora e toglie una virgoletta che con
  // ogni probabilita' c'era. Questo test cade se si toglie il vincolo
  // `LETTERA.test(carattere)`; verificato.
  const prima = 'ai nostri concittadini svizzeri';
  const dopo = '. Il sindaco Mastromarino ha anche';
  const { rapporto, testo } = riparaConAlbero(
    `${prima}${B(0x08)}3${dopo}\n`,
    [`${prima}${dopo}\n`],
  );
  assert.equal(rapporto.riparate, 0);
  assert.match(testo, new RegExp(B(0x08)), 'il marker resta al suo posto');
});

test('FAIL-CLOSED — testimone che propone una virgoletta: non e\' una lettera, si rifiuta', () => {
  // Reale: `due paesi<08>3. Questo` contro `due paesi." Questo`. La virgoletta
  // e' pure dall'altra parte del punto: due generazioni punteggiano diverso.
  const prima = 'ma piuttosto un ponte tra due paesi';
  const dopo = '. Questo e\\\' il messaggio che vogliamo';
  const { rapporto, testo } = riparaConAlbero(
    `${prima}${B(0x08)}3${dopo}\n`,
    [`${prima}."${dopo.slice(1)}\n`],
  );
  assert.equal(rapporto.riparate, 0);
  assert.match(testo, new RegExp(B(0x08)));
});

test('FAIL-CLOSED — testimone che apre un paragrafo: non si importa l\'impaginazione', () => {
  // Reale: `nella zona. <08>3Il turismo` contro `nella zona. \n\nIl turismo`.
  const prima = 'crescita economica nella zona. ';
  const dopo = 'Il turismo della spesa e\\\' un settore';
  const { rapporto, testo } = riparaConAlbero(
    `${prima}${B(0x08)}3${dopo}\n`,
    [`${prima}\\n\\n"${dopo}\n`],
  );
  assert.equal(rapporto.riparate, 0);
  assert.match(testo, new RegExp(B(0x08)));
});

test('FAIL-CLOSED — due testimoni che propongono lettere diverse: si rifiuta', () => {
  const prima = 'sur les primes de la caisse maladie vot';
  const dopo = 'es par le peuple en septembre 2025';
  const { rapporto, testo } = riparaConAlbero(
    `${prima}${B(0x0e)}${dopo}\n`,
    [`${prima}é${dopo}\n`, `${prima}à${dopo}\n`],
  );
  assert.equal(rapporto.riparate, 0);
  assert.match(testo, new RegExp(B(0x0e)));
});

test('FAIL-CLOSED — nessun file pulito contiene la frase: nessuna ipotesi', () => {
  const { rapporto, testo } = riparaConAlbero(
    `verschiedenen Feuerwehren, darunter die ${B(0x07)}9euerwehr von Laveno\n`,
    ['una frase che non c\'entra niente, ripetuta due volte per il lessico\n'],
  );
  assert.equal(rapporto.riparate, 0);
  assert.match(testo, new RegExp(B(0x07)));
});

// ---------------------------------------------------------------------------
// il canale RESIDUO — issue #94, quarto giro: l'ingresso senza marker
// ---------------------------------------------------------------------------
//
// Qui il valore sta nei rifiuti piu' che altrove, e per una ragione che nessuno
// dei canali precedenti ha: TUTTI loro partono dal byte C0, che e' gia' di per
// se' la prova che qualcosa e' rotto. Il residuo no. Una cifra incollata a una
// lettera, in questo corpus, e' quasi sempre testo giusto — `13a AVS`, `l'A2`,
// `user_polizia_pi1[newsId]`, il bus `'N1'`, il treno `'S5'`, uno slug. Misurato
// su `content/` all'11-08-2026: **189.124** posizioni hanno questa forma, 46
// hanno anche una ricostruzione che il corpus conosce, e **2** sono il difetto.
//
// Falsificazioni eseguite, una per vincolo, ciascuna rimettendo il difetto nello
// script e controllando quale test diventa rosso:
//   - accettato il lessico come prova       -> rosso «13a AVS»
//   - tolta la conferma del lessico          -> rosso «una parola che il corpus non conosce»
//   - tolto `LETTERA.test(carattere)`        -> rosso «un apostrofo non e' una lettera»
//   - tolta l'unanimita' fra i testimoni     -> rosso «due lettere diverse»
//   - tolto il modo ad ancora sinistra sola  -> rosso «il contenitore diverge subito dopo»
//   - ammesso l'esadecimale MAIUSCOLO        -> rosso «l'autostrada A2 perde la cifra»
//   - ammesso lo span lungo senza ancora a destra -> rosso «senza ancora a destra...»

test('residuo: la cifra orfana dentro una parola, provata dal testimone e confermata dal corpus', () => {
  // Il caso vero, ed e' un titolo pubblicato: `content/blog-meta-it.ts` porta
  // `Intesa o sar0 l'inferno` e `meta-it.json` lo serve come titolo
  // dell'articolo `trump-intesa-o-inferno`. Nel file NON c'e' un solo byte C0 —
  // il sanificatore di #65 lo ha tolto lasciando la cifra dentro la parola —
  // quindi nessuna scansione di byte lo trova: l'unico ingresso e' il residuo.
  //
  // E la lettera non e' quella che direbbe la tabella (byte,cifra) del
  // censimento #66, che per `(0x17,'0')` dice `à`: il corpus dice `ò`, in due
  // file, con quaranta caratteri di ancora esatta.
  const frase = 'Trump: "Intesa o sar';
  const coda = ' l inferno. Il giallo dell ultimatum spostato';
  const { rapporto, testo } = riparaConAlbero(
    `${frase}0${coda}\n`,
    [`${frase}ò${coda}\n${frase}ò${coda}\n`],
  );
  assert.equal(rapporto.occorrenze, 0, 'nessun byte C0 in tutto l\'albero: e\' il punto del canale');
  assert.equal(rapporto.residui.riparati, 1);
  assert.equal(testo, `${frase}ò${coda}\n`);
  const rip = rapporto.riparazioni.find((r) => /residuo/.test(r.canale));
  assert.equal(rip.canale, 'residuo (testimone + lessico)');
  assert.equal(rip.parola, 'sarò');
  assert.deepEqual(rip.testimoni, ['content/testimone1.ts']);
});

test('residuo: dove il contenitore diverge subito dopo, l\'ancora si sposta tutta a sinistra', () => {
  // Il secondo residuo dello stesso titolo, `spostato a marted8`. Sta in fondo
  // al valore: i 24 caratteri dopo non sono piu' testo, sono la chiave
  // successiva del file, e nessun testimone puo' averli. E' l'immagine
  // speculare del motivo per cui #218 usa 16 e non 24 a sinistra. Il budget di
  // 40 caratteri resta, tutto da una parte.
  const prima = 'La cronaca del giorno racconta che tutto era stato spostato a marted';
  const { rapporto, testo } = riparaConAlbero(
    `${prima}8',\n  altra chiave: valore diverso\n`,
    [`${prima}ì',\n  descrizione: altro testo ancora\n${prima}ì',\n  ancora un altro campo qui\n`],
  );
  assert.equal(rapporto.residui.riparati, 1);
  assert.match(testo, /spostato a martedì/);
  const rip = rapporto.riparazioni.find((r) => /residuo/.test(r.canale));
  assert.equal(rip.canale, 'residuo (testimone a sinistra + lessico)');
  assert.equal(rip.parola, 'martedì');
});

test('FAIL-CLOSED — residuo: il lessico da solo NON e\' una prova (`13a AVS` resta `13a AVS`)', () => {
  // La tredicesima AVS. Il lessico conosce «ça» e la proporrebbe senza esitare;
  // i testimoni dicono la stessa frase e in quel punto hanno una CIFRA, non una
  // lettera, quindi non propongono niente. Su `content/` questa sola regola
  // salva `l'A2`, `l'A9`, `user_polizia_pi1[newsId]`, il bus `'N1'`, il treno
  // `'S5'`, il `pilastro 3a` e quattro slug: 40 posizioni su 42.
  // La forma e' quella vera, virgoletta compresa: il token e' `'13a`, e
  // ritagliando la virgoletta di bordo la ricostruzione diventa «ça», che il
  // corpus conosce. Senza la virgoletta il token sarebbe `13a`, con una lettera
  // sola di contesto, e il prefiltro lo scarterebbe prima di arrivare alla
  // domanda — cioe' il test passerebbe senza provare niente.
  const frase = "  'blog.article.tredicesima-avs.title': '13a AVS: piu trattenute in busta paga?',";
  const { rapporto, testo } = riparaConAlbero(
    `${frase}\n`,
    [`${frase}\n${frase}\n`, 'ça ça ça ça\n'],
  );
  assert.equal(rapporto.residui.riparati, 0);
  assert.ok(testo.includes("'13a AVS"), 'la cifra della tredicesima resta dov\'e\'');
  assert.ok(!testo.includes('ça AVS'));
  assert.match(rapporto.residui.lasciate[0].motivo, /UNA LETTERA/,
    'ed e\' arrivata fino alla domanda, non e\' stata scartata prima');
});

test('FAIL-CLOSED — residuo: il testimone propone una lettera che non fa una parola del corpus', () => {
  // Il testimone da solo qui non basta: l'ingresso non ha piu' il byte C0 che
  // diceva «qualcosa e' rotto», quindi la lettera proposta deve anche fare una
  // parola che il corpus gia' conosce. «marchà» compare una volta sola —
  // sotto la soglia — e la riparazione si ferma.
  const prima = 'Le rapport sur le grand march';
  const dopo = ' des idees nouvelles et des projets';
  const { rapporto, testo } = riparaConAlbero(
    `${prima}9${dopo}\n`,
    [`${prima}à${dopo}\n`],
  );
  assert.equal(rapporto.residui.riparati, 0);
  assert.ok(testo.includes('march9'), 'il residuo resta, dichiarato');
  assert.match(rapporto.residui.lasciate[0].motivo, /il corpus non conosce/);
});

test('FAIL-CLOSED — residuo: due testimoni con due lettere diverse, non si sceglie', () => {
  const prima = 'Le rapport sur le grand march';
  const dopo = ' des idees nouvelles et des projets';
  const { rapporto, testo } = riparaConAlbero(
    `${prima}9${dopo}\n`,
    [`${prima}é${dopo}\n${prima}é${dopo}\n`, `${prima}è${dopo}\n${prima}è${dopo}\n`],
  );
  assert.equal(rapporto.residui.riparati, 0);
  assert.ok(testo.includes('march9'));
  assert.match(rapporto.residui.lasciate[0].motivo, /lettere diverse/);
});

test('FAIL-CLOSED — residuo: un apostrofo non e\' una lettera, nemmeno se il corpus lo conferma', () => {
  // Reale, e costa una riparazione che «si vede» giusta: `blog-meta-it.ts` porta
  // `Il Dipartimento dell6educazione`, e `dell’educazione` sta nel corpus 40
  // volte. Ma l'apostrofo tipografico e' punteggiatura, e la misura di #218 dice
  // che sulla punteggiatura due generazioni dello stesso testo non concordano:
  // e' il vincolo che ha tolto 22 false riparazioni da un solo file. Resta
  // dichiarato nel rapporto, non riparato.
  const prima = 'Il Dipartimento dell';
  const dopo = 'educazione, della cultura e dello sport comunica';
  const { rapporto, testo } = riparaConAlbero(
    `${prima}6${dopo}\n`,
    [`${prima}’${dopo}\n${prima}’${dopo}\n`],
  );
  assert.equal(rapporto.residui.riparati, 0);
  assert.ok(testo.includes('dell6educazione'));
  assert.match(rapporto.residui.lasciate[0].motivo, /UNA LETTERA/);
});

test('FAIL-CLOSED — residuo: l\'esadecimale MAIUSCOLO non e\' una coda (l\'autostrada A2 tiene la sigla)', () => {
  // La coda puo' allungarsi all'indietro — dopo lo strip la coda di
  // `d<00>e9lais` e' `e9`, non `9` — ma solo su esadecimali MINUSCOLI. E' la
  // stessa asimmetria di `unitaPossibili`, con la stessa ragione: una A-F
  // maiuscola incollata a una cifra quasi mai e' una coda, quasi sempre e' una
  // sigla vera. Nel corpus si vede subito: delle 40 posizioni che questo canale
  // lascia dov'erano, **dieci** sono `l'A2`, `l'A9`, il bus `'N1'` e il treno
  // `'S5'`, tutte maiuscola+cifra.
  //
  // Qui il testimone e' un'altra generazione che in quel punto scrive una
  // maiuscola accentata. Con l'esadecimale maiuscolo ammesso la coda diventa
  // `A2`, il testimone propone `É`, il lessico conferma «É» — e l'autostrada A2
  // sparisce dentro una lettera sola. Il byte C0 non c'e' piu': non resta
  // nemmeno l'ancora per accorgersene dopo.
  const prima = 'Trafic ralenti ce matin en direction du Tessin sur l\\';
  const dopo = ' avec de longues files et des retards importants';
  const { rapporto, testo } = riparaConAlbero(
    `${prima}'A2'${dopo}\n`,
    [`${prima}'É'${dopo}\n`, 'É É\n'],
  );
  assert.equal(rapporto.residui.riparati, 0);
  assert.ok(testo.includes("'A2'"), 'la sigla dell\'autostrada resta intera');
});

test('FAIL-CLOSED — residuo: senza ancora a destra il residuo puo\' essere solo la cifra', () => {
  // Stessa forma del caso `A2`, ma con un esadecimale minuscolo, che la guardia
  // sul maiuscolo non ferma. Senza ancora a destra NIENTE dice dove finisce il
  // residuo: se la coda potesse essere lunga, il testimone che ha la stessa
  // parola proporrebbe la sua prima lettera come rimpiazzo di tutta la coda e la
  // cifra sparirebbe. Con la coda ridotta alla sola cifra, il testimone in quel
  // punto ha una cifra e non propone niente.
  const prima = 'La strada che porta al villaggio passa proprio davanti alla ';
  const sporco = `${prima}be2ola grande e antica del bosco\n`;
  const testimoni = [{ percorso: 'content/t1.ts', testo: `${prima}be2ola piccola vicino al fiume\n` }];
  const lessico = new Map([['beola', 5], ['béola', 5]]);
  const r = riparaResidui(sporco, testimoni, new Map(), lessico, 2);
  assert.equal(r.riparazioni.length, 0);
  assert.equal(r.testo, sporco);
  assert.ok(r.lasciate.length >= 1, 'l\'occorrenza e\' dichiarata, non silenziosa');
});

test('residuo: l\'ingresso e\' `stripLasciaResiduo`, non una regex nuova', () => {
  // Le tre forme che quella funzione descrive, piu' le due che deve escludere.
  // Se `stripLasciaResiduo` cambia, cambia anche questo canale: e' voluto, ed e'
  // la ragione per cui l'ingresso non e' stato riscritto qui.
  const posizioni = (s) => residuiDi(s).map((x) => x.j);
  assert.deepEqual(posizioni('comp9tences'), [4], 'lettera prima, cifra dopo');
  assert.deepEqual(posizioni('Il 3territorio poroso'), [3], 'cifra, poi lettera');
  assert.deepEqual(posizioni('spostato a marted8'), [17], 'in fondo alla parola');
  assert.deepEqual(posizioni('nel 2026 e nel 2027'), [], 'un numero non e\' un residuo');
  assert.deepEqual(posizioni('la data 2026-04-05 alle 10:47'), [], 'nemmeno una data');
});

test('CLI: in dry-run il residuo non viene scritto', () => {
  const frase = 'Trump: "Intesa o sar';
  const coda = ' l inferno. Il giallo dell ultimatum spostato';
  const sporco = `${frase}0${coda}\n`;
  const radice = conTestimoni(sporco, [`${frase}ò${coda}\n${frase}ò${coda}\n`]);
  try {
    const { rapporto } = esegui(radice, []);
    assert.equal(rapporto.modalita, 'dry-run');
    assert.equal(rapporto.residui.riparati, 1, 'il rapporto dice cosa farebbe');
    assert.equal(fs.readFileSync(path.join(radice, 'content', 'sporco.ts'), 'utf8'), sporco,
      'ma sul disco non cambia un byte');
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

test('il testimone non guarda i file che hanno un marker, nemmeno se la frase e\' giusta', () => {
  // Un file che porta ANCHE UN SOLO marker non testimonia per nessuno, e la
  // frase qui sotto e' quella giusta: il rifiuto non viene dal contenuto, viene
  // dal fatto che quel file e' sospetto in blocco. E' la stessa regola del
  // lessico, e serve perche' un file sporco puo' portare la forma DISTRUTTA
  // della stessa parola — `blog-meta-it.ts` ha `sar0` dove `seo-blog-4.ts` ha
  // ancora `sar<17>0` — e prenderla per buona scriverebbe il danno al posto
  // della riparazione. Questo test cade se `costruisciTestimoni` smette di
  // saltare i file con marker; verificato.
  const prima = 'du Tessin\\n- Qui : Municipalit';
  const dopo = ' de Bellinzone\\n- Montant : deficit';
  const { rapporto, testo } = riparaConAlbero(
    `${prima}${B(0x0e)}${dopo}\n`,
    [`${prima}é${dopo}\nun altro punto del file: ${B(0x01)}\n`],
  );
  assert.equal(rapporto.riparate, 0);
  assert.match(testo, new RegExp(B(0x0e)));
});

// ---------------------------------------------------------------------------
// la SPELLING ESCAPATA — issue #345 item 1
// ---------------------------------------------------------------------------
//
// Il difetto e' lo stesso, la scrittura no: dentro un blob `.faq` il control
// character e' `\\u0016` / `\\b` / `\\f`, e sul disco NON c'e' nessun byte C0.
// Tutto cio' che parte da `MARKER.test` su queste occorrenze diceva zero.
//
// PERCHE' QUI IL LESSICO NON E' UNA PROVA, e perche' i test che contano sono i
// rifiuti. Misurato sulle quattro copie della stessa FAQ nel corpus reale
// (`salario-minimo-per-il-controprogetto-la-strada-e-in-discesa`), la STESSA
// coppia (0x08,'5') sta al posto di quattro cose diverse:
//
//   it  `Il salario minimo sociale \b5 una proposta`    -> «è»
//   de  `Der soziale Mindestlohn \b5 ein Vorschlag`     -> «ist»
//   en  `The social minimum wage \b5 a proposal`        -> «is»
//   fr  `Le salaire minimum social \b5 une proposition` -> «est»
//
// Tre su quattro non sono nemmeno un carattere: sono una parola. Il marker e'
// nato nell'italiano ed e' stato PROPAGATO VERBATIM dal traduttore, che l'ha
// trattato come un token intraducibile. Una prova che guarda la parola
// ricostruita — lessico, esadecimale, legge del nibble — su questa famiglia non
// deduce: traduce a occhio. E' la forma esatta del difetto che in un giro
// precedente ha distrutto i titoli, «riparando» dalla lingua sbagliata.
//
// Quindi la sola prova ammessa e' il testimone, UNANIME (una sola lettera fra
// tutti i riscontri) e CROSS-LOCALE (almeno un testimone fuori dal locale del
// file sporco). Sul corpus del 2026-08-14 questa precondizione ripara ZERO
// occorrenze su 45, ed e' il risultato giusto: le 45 restano con la loro ancora
// e ora sono CONTATE, nel rapporto e nel codice d'uscita.

/** La spelling come sta su disco: due backslash, il JSON e' dentro un letterale TS. */
const E = (n) => `\\\\u${n.toString(16).padStart(4, '0')}`;
/** Le forme brevi che `JSON.stringify` usa per 0x08 e 0x0C. */
const E_BREVE = { 0x08: '\\\\b', 0x0c: '\\\\f' };

const PRIMA_FAQ = 'Il salario minimo sociale ';
const DOPO_FAQ = ' una proposta che prevede un salario minimo';

/** Nessun byte C0 grezzo puo' finire su disco: la decodifica non deve mai tornare indietro. */
function senzaByteC0(testo) {
  return !new RegExp(`[${'\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F'}]`).test(testo);
}

function riparaEscapataConAlbero(alberi, quale = 'blog-body/it/sporco.ts') {
  const radice = alberoDiProva(alberi);
  try {
    const { codice, rapporto } = esegui(radice, ['--write']);
    return { codice, rapporto, testo: fs.readFileSync(path.join(radice, 'content', quale), 'utf8') };
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
}

test('escapata: un testimone unanime in un ALTRO locale da\' la lettera perduta', () => {
  const { rapporto, testo } = riparaEscapataConAlbero({
    'blog-body/it/sporco.ts': `${PRIMA_FAQ}${E(0x16)}5${DOPO_FAQ}\n`,
    'blog-body/de/testimone.ts': `${PRIMA_FAQ}è${DOPO_FAQ}\n`,
  });
  assert.equal(rapporto.escapate.occorrenze, 1, 'l\'occorrenza dev\'essere CONTATA, non solo riparata');
  assert.equal(rapporto.escapate.riparate, 1);
  assert.equal(rapporto.escapate.lasciate, 0);
  assert.equal(testo, `${PRIMA_FAQ}è${DOPO_FAQ}\n`, 'la spelling intera sparisce, coda compresa');
  assert.ok(senzaByteC0(testo), 'la decodifica e\' interna: su disco non finisce mai un byte C0');
  const rip = rapporto.riparazioni.find((x) => x.canale.startsWith('escapata'));
  assert.deepEqual(rip.testimoni, ['content/blog-body/de/testimone.ts']);
  assert.deepEqual(rip.localiTestimoni, ['de']);
});

test('escapata: la forma breve \\b e\' la stessa cosa della forma numerica', () => {
  const { rapporto, testo } = riparaEscapataConAlbero({
    'blog-body/it/sporco.ts': `${PRIMA_FAQ}${E_BREVE[0x08]}5${DOPO_FAQ}\n`,
    'blog-body/fr/testimone.ts': `${PRIMA_FAQ}è${DOPO_FAQ}\n`,
  });
  assert.equal(rapporto.escapate.occorrenze, 1);
  assert.equal(rapporto.escapate.riparate, 1);
  assert.equal(testo, `${PRIMA_FAQ}è${DOPO_FAQ}\n`);
});

test('escapata: la coda puo\' contenere a sua volta una spelling, e la mappa regge', () => {
  // `sc<00>f<16>9narios` -> «scénarios», ma scritto escapato: la coda di tre
  // caratteri DECODIFICATI vale 1 + 7 + 1 = 9 caratteri di FILE. Un riparatore
  // che tagliasse `offset + coda` sull'originale lascerebbe mezza spelling nel
  // testo. Questo test cade se la fine del tratto non passa da `fineIn`.
  const prima = 'quelques comparaisons entre des sc';
  const dopo = 'narios pratiques : stages et emplois';
  const { rapporto, testo } = riparaEscapataConAlbero({
    'blog-body/fr/sporco.ts': `${prima}${E(0x00)}f${E(0x16)}9${dopo}\n`,
    'blog-body/it/testimone.ts': `${prima}é${dopo}\n`,
  }, 'blog-body/fr/sporco.ts');
  assert.equal(rapporto.escapate.occorrenze, 2, 'due spelling nello stesso punto');
  assert.equal(testo, `${prima}é${dopo}\n`);
  assert.ok(senzaByteC0(testo));
});

test('FAIL-CLOSED — escapata: il testimone e\' nello STESSO locale, non basta', () => {
  // Il difetto nasce nell'italiano e il traduttore lo propaga verbatim: un
  // testimone dello stesso locale e' un'altra generazione della stessa
  // pipeline, che ha visto lo stesso testo corrotto. Conferma la propagazione,
  // non il carattere. Questo test cade se si toglie il vincolo cross-locale.
  const { codice, rapporto, testo } = riparaEscapataConAlbero({
    'blog-body/it/sporco.ts': `${PRIMA_FAQ}${E(0x16)}5${DOPO_FAQ}\n`,
    'blog-body/it/testimone.ts': `${PRIMA_FAQ}è${DOPO_FAQ}\n`,
  });
  assert.equal(rapporto.escapate.riparate, 0);
  assert.equal(rapporto.escapate.lasciate, 1);
  assert.match(rapporto.escapate.elenco[0].motivo, /fuori dal locale "it"/);
  assert.ok(testo.includes(E(0x16)), 'la spelling resta dov\'e\': e\' l\'ancora');
  assert.equal(codice, 2, 'un\'occorrenza escapata lasciata e\' un difetto, non testo giusto');
});

test('FAIL-CLOSED — escapata: due locali che propongono lettere diverse', () => {
  const { rapporto, testo } = riparaEscapataConAlbero({
    'blog-body/it/sporco.ts': `${PRIMA_FAQ}${E(0x16)}5${DOPO_FAQ}\n`,
    'blog-body/de/testimone.ts': `${PRIMA_FAQ}è${DOPO_FAQ}\n`,
    'blog-body/fr/testimone.ts': `${PRIMA_FAQ}é${DOPO_FAQ}\n`,
  });
  assert.equal(rapporto.escapate.riparate, 0);
  assert.match(rapporto.escapate.elenco[0].motivo, /lettere diverse/);
  assert.ok(testo.includes(E(0x16)));
});

test('FAIL-CLOSED — escapata: nessun testimone, nessuna ipotesi (e il lessico non ha voce)', () => {
  // «Il salario minimo sociale è una proposta» e' una frase che il lessico
  // ricostruirebbe senza fatica — «è» esiste nel corpus a migliaia. Qui non
  // c'e' nessun testimone, e il riparatore non ci prova nemmeno: se un giorno
  // qualcuno aggiunge il canale del lessico a questa spelling, questo test
  // diventa rosso ed e' quello che deve succedere.
  const { codice, rapporto, testo } = riparaEscapataConAlbero({
    'blog-body/it/sporco.ts': `${PRIMA_FAQ}${E(0x16)}5${DOPO_FAQ}\n`,
  });
  assert.equal(rapporto.escapate.occorrenze, 1);
  assert.equal(rapporto.escapate.riparate, 0);
  assert.equal(rapporto.escapate.lasciate, 1);
  assert.ok(testo.includes(E(0x16)));
  assert.equal(codice, 2);
});

test('FAIL-CLOSED — escapata: un file con la sola spelling escapata NON testimonia', () => {
  // Il file «testimone» porta la frase giusta e, altrove, una propria spelling
  // escapata. `MARKER.test` su di lui e' FALSO — non ha un byte C0 — quindi
  // finche' il filtro guardava solo il byte questo file testimoniava. Questo
  // test cade se `costruisciTestimoni` smette di chiamare `haEscapate`.
  const { rapporto, testo } = riparaEscapataConAlbero({
    'blog-body/it/sporco.ts': `${PRIMA_FAQ}${E(0x16)}5${DOPO_FAQ}\n`,
    'blog-body/de/testimone.ts': `${PRIMA_FAQ}è${DOPO_FAQ}\nun altro punto del file: modalit${E(0x01)}8\n`,
  });
  assert.equal(rapporto.escapate.riparate, 0);
  assert.ok(testo.includes(E(0x16)));
});

// ---------------------------------------------------------------------------
// il tetto dei giri (issue #366)
// ---------------------------------------------------------------------------
//
// `riparaEscapate` applica UNA riparazione per giro e si ferma a
// `TESTIMONE_GIRI_MAX` (4). Un file con piu' di quattro occorrenze risolvibili
// usciva quindi dal ciclo con altre risolvibili ancora dentro — e quelle non
// finivano ne' fra le riparate ne' fra le lasciate: sul disco restavano, nel
// rapporto sparivano, e il codice d'uscita diceva 0. Il commento di
// `valutaEscapate` promette il contrario («un elenco di residui che si accorcia
// perche' il ciclo si e' fermato sarebbe la peggiore delle uscite»), ed e'
// quella promessa che questi due test tengono in piedi.

/** Sei frasi distinte: l'ancora di 16 caratteri finisce col numero della frase, quindi nessuna e' ambigua. */
const PRIMA_N = (k) => `frase numero ${k} dello stesso documento, caso ${k}: `;
const DOPO_N = (k) => ` una faccenda che il lettore numero ${k} conosce bene.`;
const QUANTE_N = 6;
const NUMERI = Array.from({ length: QUANTE_N }, (_, i) => i + 1);
const SPORCO_N = NUMERI.map((k) => `${PRIMA_N(k)}${E(0x16)}5${DOPO_N(k)}`).join('\n').concat('\n');
const TESTIMONE_N = NUMERI.map((k) => `${PRIMA_N(k)}è${DOPO_N(k)}`).join('\n').concat('\n');

test('escapata: oltre il tetto dei giri nessuna occorrenza risolvibile sparisce dal rapporto', () => {
  const radice = alberoDiProva({
    'blog-body/it/sporco.ts': SPORCO_N,
    'blog-body/de/testimone.ts': TESTIMONE_N,
  });
  try {
    const { codice, rapporto } = esegui(radice, ['--write']);
    const e = rapporto.escapate;
    assert.equal(e.occorrenze, QUANTE_N, 'la fixture deve avere piu\' occorrenze del tetto di 4 giri');
    assert.equal(e.riparate, 4, 'il tetto resta quello: quattro riparazioni per file e non una di piu\'');
    // L'asserzione che porta la issue: cio' che non e' stato riparato dev'essere
    // DICHIARATO. Con `if (!scelta)` che scartava le risolvibili successive,
    // qui `lasciate` era 0 e due occorrenze sparivano senza traccia.
    assert.equal(
      e.riparate + e.lasciate, e.occorrenze,
      `${e.occorrenze - e.riparate - e.lasciate} occorrenze escapate spariscono: ne' riparate ne' lasciate`,
    );
    assert.equal(e.lasciate, 2);
    assert.equal(e.perFile[0].occorrenze, QUANTE_N);
    assert.equal(e.perFile[0].riparate + e.perFile[0].lasciate, QUANTE_N, 'anche il per-file deve tornare');
    for (const x of e.elenco) {
      assert.match(x.motivo, /tetto di 4 riparazioni per file/);
      assert.equal(x.spelling, E(0x16), 'la spelling dev\'essere quella, non il tratto con la coda');
    }
    assert.deepEqual(e.elenco.map((x) => x.offset), [...e.elenco.map((x) => x.offset)].sort((a, b) => a - b),
      'l\'elenco resta in ordine di offset');
    assert.equal(codice, 2, 'un\'occorrenza risolvibile e non applicata e\' un difetto: deve tingere l\'uscita');
    const testo = fs.readFileSync(path.join(radice, 'content', 'blog-body', 'it', 'sporco.ts'), 'utf8');
    assert.equal(testo.split(E(0x16)).length - 1, 2, 'le due non riparate sono ancora sul disco, con la loro ancora');
    assert.ok(senzaByteC0(testo));
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

test('escapata: il motivo dice «rilanciare lo script», e un secondo giro ripara davvero il resto', () => {
  // Il tetto e' una difesa contro il loop, non un limite del corpus: quello che
  // avanza dev'essere riparabile al giro dopo. Se cosi' non fosse, dichiararlo
  // in `lasciate` sarebbe solo un modo piu' onesto di perderlo.
  const radice = alberoDiProva({
    'blog-body/it/sporco.ts': SPORCO_N,
    'blog-body/de/testimone.ts': TESTIMONE_N,
  });
  try {
    esegui(radice, ['--write']);
    const secondo = esegui(radice, ['--write']);
    assert.equal(secondo.rapporto.escapate.occorrenze, 2, 'il primo giro ne ha riparate 4');
    assert.equal(secondo.rapporto.escapate.riparate, 2);
    assert.equal(secondo.rapporto.escapate.lasciate, 0);
    assert.equal(secondo.codice, 0);
    const testo = fs.readFileSync(path.join(radice, 'content', 'blog-body', 'it', 'sporco.ts'), 'utf8');
    assert.equal(testo, TESTIMONE_N, 'il file finisce identico al testimone');
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

test('il lessico non impara le parole dei file con la sola spelling escapata', () => {
  // Misurato sul corpus reale: `TOKEN_G` non contiene il backslash, quindi
  // `imparzialit\\u0000a1` si spezza in `imparzialit` + `u0000a1` e il lessico
  // imparava la PAROLA MUTILATA — e persino un pezzo della spelling — come
  // vocabolario del corpus pulito. Escludendo i 22 file escapati: 16.806 ->
  // 16.784 file, 235.758 -> 235.611 token distinti, e fra i 147 spariti ci
  // sono `imparzialit`, `accadr` e `u00108`.
  const sporco = `l'imparzialit${E(0x00)}a1 nella CPI ticinese\n`;
  const lessico = lessicoDiProva({ 'content/blog-body/it/faq.ts': `${sporco}${sporco}` });
  assert.equal(lessico.get('imparzialit'), undefined, 'la parola mutilata non e\' vocabolario');
  assert.equal(lessico.get('u0000a1'), undefined, 'nemmeno un pezzo della spelling');
  assert.ok(lessico.get('dépenses') >= 2, 'il resto del lessico c\'e\' ancora');
});

test('localeDi legge il locale dalle due forme di percorso, e non inventa', () => {
  assert.equal(localeDi('content/blog-body/it/cure-a-domicilio-tassa-ticino.ts'), 'it');
  assert.equal(localeDi('content/blog-body-ch/de/svizzera.ts'), 'de');
  assert.equal(localeDi('content/blog-meta-fr.ts'), 'fr');
  assert.equal(localeDi('content/pulito.ts'), null);
  assert.equal(localeDi('content/blog-body/xx/ignoto.ts'), null, 'due lettere non bastano: dev\'essere un locale del corpus');
});

// ---------------------------------------------------------------------------
// L'ESTRAZIONE DEL MARKER — nessuna occorrenza esce dal rapporto senza contesto
// ---------------------------------------------------------------------------
//
// PERCHE' QUESTO GUARD ESISTE.  Il rapporto dichiara le tre grafie del difetto,
// e per due di esse NON diceva dove guardare.  Misurato su `origin/main` il
// 2026-08-18: delle occorrenze stampate, 103 portavano il token col marker in
// forma `<XX>` e **91 (45 escapate + 46 residui) uscivano cosi'**:
//
//     ...:7275  "\\u0010"   <- quale parola?  quale frase?
//     ...:5185  "22il"      <- quale delle due cifre ha preso il posto?
//
// Chi conduce la campagna di riparazione ha dovuto riestrarle dai file una per
// una — e una campagna che riapre i file a mano e' una campagna che si ferma.
// Il guard non chiede che lo script RIPARI di piu': chiede che ogni occorrenza
// che dichiara di aver visto porti con se' l'ancora per andarla a vedere.
//
// Falsificato prima di scriverlo, un vincolo per volta, rimettendo il difetto
// nello script:
//   - tolto `contesto` dalla famiglia escapata  -> rosso «escapata»
//   - tolto `contesto` dalla famiglia residuo   -> rosso «residuo»
//   - tolto `contesto` dai rifiuti del byte C0  -> rosso «byte grezzo»
//   - delimitato il token invece della cifra    -> rosso «il residuo delimita
//     ESATTAMENTE la cifra», che e' l'unico modo di dire quale delle due e'.

/** Il tratto che il rapporto delimita fra `[[` e `]]`, o `null` se non c'e'. */
function delimitato(contesto) {
  const m = /\[\[([\s\S]*)\]\]/.exec(contesto || '');
  return m ? m[1] : null;
}

/** Ogni record dichiarato dal rapporto, di tutte e tre le grafie. */
function occorrenzeDichiarate(rapporto) {
  return [
    ...rapporto.rifiuti.map((x) => ({ ...x, grafia: 'byte grezzo' })),
    ...rapporto.escapate.elenco.map((x) => ({ ...x, grafia: 'escapata' })),
    ...rapporto.residui.lasciate.map((x) => ({ ...x, grafia: 'residuo' })),
  ];
}

/** Un'occorrenza senza marker, senza tratto delimitato o senza NIENTE intorno. */
function senzaEstrazione(rapporto) {
  return occorrenzeDichiarate(rapporto).filter(
    (x) => !x.marker
      || delimitato(x.contesto) === null
      || x.contesto.replace(/\[\[[\s\S]*\]\]/, '').trim() === '',
  );
}

test('estrazione — byte grezzo: il contesto delimita il token e rende il marker <XX>', () => {
  // Il token da solo bastava gia' qui: e' l'unica delle tre grafie che il
  // rapporto sapeva mostrare.  Il guard c'e' lo stesso, perche' e' la forma di
  // riferimento a cui le altre due sono state portate.
  const radice = alberoDiProva({ 'sporco.ts': `un mot inconnu xylo${B(0x0e)}9phone dans la phrase\n` });
  try {
    const { rapporto } = esegui(radice, []);
    assert.equal(rapporto.rifiutate, 1);
    const [x] = rapporto.rifiuti;
    assert.equal(x.marker, '0x0E');
    assert.equal(delimitato(x.contesto), 'xylo<0E>9phone');
    assert.match(x.contesto, /un mot inconnu \[\[/);
    assert.match(x.contesto, /\]\] dans la phrase/);
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

test('estrazione — escapata: il contesto porta la frase, che la sola spelling non diceva', () => {
  // Prima: `"\\u0016"  testimone: ...` e nient'altro.  La spelling e' identica
  // in tutte e 45 le occorrenze del corpus: da sola non distingue un'occorrenza
  // dall'altra, quindi non si puo' ne' classificare ne' andare a vedere.
  const radice = alberoDiProva({ 'blog-body/it/sporco.ts': `${PRIMA_FAQ}${E(0x16)}5${DOPO_FAQ}\n` });
  try {
    const { rapporto } = esegui(radice, []);
    assert.equal(rapporto.escapate.lasciate, 1);
    const [x] = rapporto.escapate.elenco;
    assert.equal(x.marker, '0x16');
    assert.equal(delimitato(x.contesto), E(0x16));
    assert.ok(x.contesto.includes('salario minimo sociale '), 'la frase PRIMA del marker');
    assert.ok(x.contesto.includes(`5${DOPO_FAQ.slice(0, 12)}`), 'la coda e la frase DOPO');
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

test('estrazione — residuo: il contesto delimita ESATTAMENTE la cifra, non il token', () => {
  // Il vincolo che vale il test.  Il token `'13a` porta DUE cifre e il marker
  // non c'e' piu': senza sapere quale delle due ha preso il posto del carattere
  // perduto, l'occorrenza non e' ne' verificabile ne' riparabile a mano.
  // Delimitare il token intero sarebbe la stessa non-informazione di prima.
  const frase = "  'blog.article.tredicesima-avs.title': '13a AVS: piu trattenute in busta paga?',";
  const radice = conTestimoni(`${frase}\n`, [`${frase}\n${frase}\n`, 'ça ça ça ça\n']);
  try {
    const { rapporto } = esegui(radice, []);
    // I testimoni portano la stessa frase, quindi lo stesso residuo: si guarda
    // quello del file sporco, non il primo che capita.
    const x = rapporto.residui.lasciate.find((r) => r.file === 'content/sporco.ts');
    assert.ok(x, 'il residuo del file sporco deve essere dichiarato');
    assert.equal(x.token, "'13a", 'il token resta quello che era: il contesto si aggiunge, non sostituisce');
    assert.equal(x.marker, 'strippato', 'qui il byte non c\'e\' piu\', e il rapporto lo dice invece di tacere');
    assert.equal(x.coda, '3');
    assert.equal(delimitato(x.contesto), '3', 'la cifra, UNA, e non `13a`');
    assert.ok(x.contesto.includes('tredicesima-avs'), 'e intorno c\'e\' abbastanza per riconoscere il punto');
    assert.ok(x.contesto.includes('a AVS: piu'));
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

test('estrazione: ZERO occorrenze dichiarate senza estrazione, su tutte e tre le grafie insieme', () => {
  // Il censimento, ed e' la metrica della campagna: 91 su 194 prima, 0 dopo.
  // Una quarta grafia che arrivi al rapporto senza portarsi dietro l'ancora fa
  // rosso QUI, prima che qualcuno debba riestrarla dai file uno per uno.
  const frase = "  'blog.article.tredicesima-avs.title': '13a AVS: piu trattenute in busta paga?',";
  const radice = alberoDiProva({
    'blog-body/it/sporco.ts': `${PRIMA_FAQ}${E(0x16)}5${DOPO_FAQ}\n`,
    'blog-body/fr/grezzo.ts': `un mot inconnu xylo${B(0x0e)}9phone dans la phrase\n`,
    'blog-body/it/residuo.ts': `${frase}\n`,
    'blog-body/it/testimone.ts': `${frase}\n${frase}\n`,
    'lessico-extra.ts': 'ça ça ça ça\n',
  });
  try {
    const { rapporto } = esegui(radice, []);
    const tutte = occorrenzeDichiarate(rapporto);
    assert.deepEqual([...new Set(tutte.map((x) => x.grafia))].sort(), ['byte grezzo', 'escapata', 'residuo'],
      'il fixture deve produrre tutte e tre le grafie, o il censimento non prova niente');
    assert.deepEqual(senzaEstrazione(rapporto).map((x) => `${x.grafia} ${x.file}:${x.offset}`), []);
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

test('estrazione: il rapporto JSON sopravvive a una PIPE, non solo a un redirect su file', () => {
  // Il difetto che rendeva inutile tutto il resto.  `process.exit()` chiude il
  // processo senza aspettare che stdout sia scritto, e su una pipe stdout e'
  // ASINCRONO: misurato su `content/` il 2026-08-18, `--json | ...` consegnava
  // 65.536 byte esatti — un buffer di pipe — dei 124.385 del rapporto.  Cioe'
  // un JSON che non si apre, mentre `--json > file` era completo: la forma di
  // guasto si vede solo mettendo lo strumento in pipeline, che e' esattamente
  // come lo usa chi conduce la campagna.
  //
  // Il fixture deve produrre un rapporto piu' grande di un buffer di pipe, o il
  // test passerebbe anche col difetto rimesso: 400 occorrenze bastano.
  const molte = Array.from({ length: 400 }, (_, i) => `phrase numero ${i} avec xylo${B(0x0e)}9phone dedans`).join('\n');
  const radice = alberoDiProva({ 'sporco.ts': `${molte}\n` });
  try {
    const grezzo = execSync(`node ${JSON.stringify(SCRIPT)} --root ${JSON.stringify(radice)} --json | cat`, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.ok(grezzo.length > 65536, `il fixture deve superare un buffer di pipe (${grezzo.length} byte)`);
    const rapporto = JSON.parse(grezzo);
    assert.equal(rapporto.rifiutate, 400, 'e il rapporto che arriva in fondo alla pipe e\' quello intero');
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

test('estrazione: il contesto resta UNA riga — a capo, ritorno e TAB si vedono, non spezzano', () => {
  // `MARKER` non considera marker `\n`, `\r` e `\t`, perche' sono caratteri
  // legali.  Ma dentro la finestra ci finiscono lo stesso, e se restano grezzi
  // il rapporto smette di avere una riga per occorrenza: misurato sul corpus,
  // 27 delle 314 occorrenze hanno un a capo nella finestra.  La piu' istruttiva
  // e' `bekannt war.\n\n> [[<10>Der]] Hauptzweck`, che mostra il marker a inizio
  // di una citazione — cioe' che stava al posto della virgoletta aperta, che e'
  // esattamente la classificazione che serve alla campagna.
  const radice = alberoDiProva({ 'sporco.ts': `phrase avant\n\n> ${B(0x0e)}9phone\tapres tabulation\n` });
  try {
    const { rapporto } = esegui(radice, []);
    const [x] = rapporto.rifiuti;
    assert.ok(!/[\n\r\t]/.test(x.contesto), `il contesto non contiene spaziatura grezza: ${JSON.stringify(x.contesto)}`);
    assert.ok(x.contesto.includes('avant\\n\\n> '), 'gli a capo si vedono, resi visibili');
    assert.ok(x.contesto.includes('\\tapres'), 'e il TAB pure: e\' la terza grafia del marker');
  } finally {
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

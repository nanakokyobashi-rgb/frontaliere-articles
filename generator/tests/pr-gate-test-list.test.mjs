/**
 * ── UN CHECK CHE MISURA UN DATO CHE L'AUTORE NON HA SCRITTO ────────────────
 *
 * `tests.yml` è il check-run che l'auto-merge aspetta prima di mergiare
 * QUALUNQUE PR. Finché eseguiva l'intera `generator/tests/`, eseguiva anche i
 * gate che leggono `content/` — il corpus generato dai bot, che cambia senza
 * che nessuna PR lo tocchi: ~90 push al giorno su `main`.
 *
 * Il costo, due volte in due giorni:
 *
 *  - 2026-08-19: l'articolo `vivere-villa-guardia-lavorare-ticino` («Villa
 *    Guardia» è un comune, «guardia» l'alias del mestiere `agente-sicurezza`)
 *    ha reso rosso `article-topic-coverage-guard` su `main` e su OGNI branch.
 *    Nessuna PR ha potuto auto-mergiare per SEI ORE.
 *  - 2026-08-18: sei PR (#410, #413, #414, #416, #417, #418) tutte e sei rosse
 *    sugli stessi tre gate, per contenuto che nessuna aveva scritto. Un
 *    `gh pr update-branch` le ha rese verdi 9/9 senza cambiare una riga,
 *    perché nel frattempo altri articoli avevano sostituito quello colpevole.
 *
 * Un check che diventa rosso per un dato che l'autore della PR non ha scritto
 * e non può riparare non sta misurando quella PR.
 *
 * QUESTO FILE SORVEGLIA LE DUE META' DELLA DECISIONE: che l'esclusione avvenga
 * davvero, e che la copertura NON si perda — perché è la seconda a rendere la
 * prima accettabile.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTENT_GATES } from '../../scripts/ci/content-gates-main.mjs';
import { MIN_PR_GATE_TESTS, listPrGateTests } from '../../scripts/ci/list-pr-gate-tests.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('la lista che tests.yml esegue', () => {
  it('esclude ESATTAMENTE i gate sul contenuto, e nient\'altro', () => {
    const { files, violations } = listPrGateTests();
    assert.deepEqual(violations, []);
    const esclusi = new Set(CONTENT_GATES);
    for (const g of CONTENT_GATES) {
      assert.ok(!files.includes(g), `gate sul contenuto rimasto nella lista: ${g}`);
    }
    const tutti = fs.readdirSync(path.join(ROOT, 'generator/tests'))
      .filter((f) => f.endsWith('.test.mjs'))
      .map((f) => `generator/tests/${f}`);
    const mancanti = tutti.filter((f) => !esclusi.has(f) && !files.includes(f));
    assert.deepEqual(mancanti, [], 'test non-gate spariti dalla lista: sarebbero smessi di girare in silenzio');
  });

  it('rifiuta una lista collassata invece di renderla', () => {
    // È l'unico modo in cui questo script può fare danno: una lista corta fa
    // passare `tests` VERDE avendo eseguito quasi niente. Deve fermarsi, non
    // degradare.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prgate-'));
    fs.mkdirSync(path.join(tmp, 'generator/tests'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'generator/tests/uno.test.mjs'), '');
    const { files, violations } = listPrGateTests(tmp);
    assert.ok(violations.length > 0, `${files.length} test e nessuna violazione: il pavimento non morde`);
    assert.match(violations.join('\n'), new RegExp(String(MIN_PR_GATE_TESTS)));
  });

  it('rifiuta anche una cartella illeggibile: non rende una lista vuota', () => {
    const { files, violations } = listPrGateTests(path.join(os.tmpdir(), 'non-esiste-davvero-prgate'));
    assert.deepEqual(files, []);
    assert.ok(violations.length > 0, 'una cartella assente produrrebbe `node --test` senza argomenti');
  });

  it('l\'eseguibile esce !=0 e NON stampa la lista quando la rifiuta', () => {
    // Chi lo usa ci fa `$(...)` attorno: se stampasse comunque, il comando si
    // comporrebbe con un elenco che lo script ha appena dichiarato invalido.
    // Asserzione sull'ORDINE e non su una finestra di testo: la prima graffa
    // di chiusura sta dentro il template literal del messaggio, e una finestra
    // a lunghezza fissa o taglia troppo presto o ingloba il ramo successivo.
    // La proprieta' vera e' comunque una relazione d'ordine — si esce PRIMA di
    // poter stampare — ed e' quella che va fissata.
    const src = read('scripts/ci/list-pr-gate-tests.mjs');
    const rifiuto = src.indexOf('if (violations.length) {');
    const stderr = src.indexOf('process.stderr.write', rifiuto);
    const exit = src.indexOf('process.exit(1)', rifiuto);
    const stampa = src.indexOf('process.stdout.write', rifiuto);
    assert.notEqual(rifiuto, -1, 'ancora non trovata — aggiornare questo test');
    assert.notEqual(stderr, -1, 'il rifiuto non va piu\' su stderr');
    assert.notEqual(exit, -1, 'il rifiuto non esce piu\' !=0');
    assert.ok(exit < stampa || stampa === -1, 'la lista viene stampata prima di uscire: chi ci fa `$(...)` attorno comporrebbe un comando con un elenco rifiutato');
    assert.ok(stderr < exit, 'esce senza aver detto perche\'');
  });
});

describe('la copertura NON si perde: è ciò che rende accettabile l\'esclusione', () => {
  it('tests.yml usa lo script invece della cartella intera', () => {
    const wf = read('.github/workflows/tests.yml');
    assert.match(wf, /files=\$\(node scripts\/ci\/list-pr-gate-tests\.mjs\)/);
    assert.match(wf, /node --test \$files/);
    assert.doesNotMatch(
      wf,
      /node --test 'generator\/tests\/\*\.test\.mjs'/,
      'la cartella intera è tornata: i gate sul contenuto tornerebbero a bloccare PR che non c\'entrano',
    );
  });

  it('tests.yml NON passa la command substitution direttamente come argomento', () => {
    // Sotto `bash -e`, `node --test $(node list-pr-gate-tests.mjs)` scarta
    // l'exit !=0 dello script se la substitution e' argomento di un altro
    // comando: bash prosegue con `node --test` invocato a vuoto, che cade
    // sulla discovery di default (tutta la cwd) invece di fallire rumorosamente.
    // Va assegnata prima a una variabile, cosi' il fallimento propaga.
    const wf = read('.github/workflows/tests.yml');
    assert.doesNotMatch(
      wf,
      /node --test \$\(node scripts\/ci\/list-pr-gate-tests\.mjs\)/,
      'la substitution e\' di nuovo passata direttamente come argomento: sotto set -e il fallimento non propaga piu\'',
    );
    assert.match(wf, /set -euo pipefail/, 'senza set -e l\'assegnazione fallita non ferma lo step');
  });

  it('generator-ci.yml esegue ANCORA tutta la cartella, sulle PR che toccano generator/**', () => {
    // È la metà che rende l'esclusione sicura invece che una perdita di
    // copertura: una PR che tocca un gate — o il codice che il gate esercita —
    // lo esegue comunque e resta bloccata se lo rompe. Verificato sulla PR
    // #492, che riparava proprio il classificatore del topic-coverage.
    // Se un domani anche questo workflow smettesse di eseguire la cartella
    // intera, l'esclusione in tests.yml diventerebbe una copertura persa e
    // nessun altro test lo direbbe.
    const wf = read('.github/workflows/generator-ci.yml');
    assert.match(
      wf,
      /node --test 'generator\/tests\/\*\.test\.mjs'/,
      'generator-ci non esegue più tutta la cartella: l\'esclusione in tests.yml perde la sua rete',
    );
    const su = wf.slice(0, wf.indexOf('jobs:'));
    assert.match(su, /pull_request:/, 'generator-ci non gira più sulle PR');
    assert.match(su, /'generator\/\*\*'/, 'generator-ci non è più agganciato a generator/**');
  });

  it('content-gates-main.yml resta la via che apre una issue invece di bloccare', () => {
    const wf = read('.github/workflows/content-gates-main.yml');
    assert.match(wf, /branches: \[main\]/);
    assert.match(wf, /issues: write/, 'senza questo il gate non può aprire niente e il segnale sparisce');
  });

  it('ogni gate escluso è eseguito da almeno uno degli altri due percorsi', () => {
    // La proprietà che conta, detta in una riga: nessun gate resta orfano.
    // `generator-ci` esegue la cartella con un glob, `content-gates-main` li
    // nomina uno per uno — quindi basta che il glob ci sia e che la lista di
    // content-gates-main coincida con ciò che tests.yml esclude.
    const genCi = read('.github/workflows/generator-ci.yml');
    assert.match(genCi, /node --test 'generator\/tests\/\*\.test\.mjs'/);
    const { files } = listPrGateTests();
    for (const g of CONTENT_GATES) {
      assert.ok(!files.includes(g));
      assert.ok(fs.existsSync(path.join(ROOT, g)), `gate escluso ma inesistente: ${g}`);
    }
  });
});

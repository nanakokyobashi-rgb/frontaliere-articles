/**
 * transport-permanent-manual-channel.test.mjs — un blocco `permanent` con
 * divergenza reale deve produrre un ROSSO, e quel rosso non deve fermare la
 * copia degli altri gemelli.
 *
 * ## Il difetto (issue #871 item 4)
 *
 * `dropped.filter((d) => d.permanent)` produceva la riga `⛔ copia a mano` e il
 * campo `manual` nel JSON, ma `main()` tornava 0 e nessuno step del workflow
 * leggeva quel campo. Un no-che-non-scade — un file del sito che questo lato
 * non ricevera' piu' finche' una persona non copia le due meta' a mano —
 * restava appeso al log giornaliero di una passata VERDE. L'unico ripescaggio
 * ipotizzato era `stranded-twin` dopo tre giorni, che il difetto dell'item 1
 * poteva spegnere in silenzio.
 *
 * ## Perche' un codice d'uscita PROPRIO, e perche' il test guarda il YAML
 *
 * La correzione ovvia — `return 1` — introduce un difetto peggiore di quello
 * che chiude. `1` in questo script vuol dire «NON copiare» (il buio delle
 * fetch, che invalida la passata intera), e il workflow lo tratta cosi': lo
 * step di dry-run fallirebbe, e lo step di apply ha un `success()` IMPLICITO
 * nel suo `if:`, quindi verrebbe saltato. Risultato: un solo gemello bloccato
 * per sempre fermerebbe il trasporto di TUTTI gli altri, ogni giorno, finche'
 * una persona non copia a mano. Un canale che wedgia il canale.
 *
 * Il contratto vero vive quindi meta' in JS e meta' in YAML, e questo file
 * pinna entrambe le meta': la costante non basta se il workflow la tratta come
 * un fallimento qualsiasi.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_MANUAL_NEEDED } from '../../scripts/ci/transport-identical-twins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SCRIPT = 'scripts/ci/transport-identical-twins.mjs';
const WORKFLOW = '.github/workflows/transport-identical-twins.yml';

test('il no permanente ha un codice suo, diverso da «non copiare»', () => {
  assert.equal(EXIT_MANUAL_NEEDED, 2);
  assert.notEqual(EXIT_MANUAL_NEEDED, 1, '1 e` gia` il buio delle fetch: riusarlo confonde due decisioni opposte');
  assert.notEqual(EXIT_MANUAL_NEEDED, 0, 'verde ma bloccato non e` uno stato accettabile');
});

test('`main()` lo restituisce sui blocchi permanenti, non un 0', () => {
  const src = read(SCRIPT);
  assert.match(
    src,
    /if \(manual\.length\) \{[\s\S]{0,600}?return EXIT_MANUAL_NEEDED;/,
    'il ramo `manual` deve tornare EXIT_MANUAL_NEEDED — un `return 0` qui e` il difetto di #871 item 4',
  );
  // E `manual` dev'essere alimentato dai permanenti in `site-ahead`, non dai
  // soli scarti del tetto: i blocchi diretti erano la meta` che non arrivava
  // mai al campo.
  assert.match(
    src,
    /verdict\.permanent && verdict\.state === 'site-ahead'/,
    'i no permanenti diretti devono entrare in `manual`, non solo quelli separati dal tetto',
  );
});

test('un `stable` bloccato per sempre NON alza il rosso', () => {
  // I 25 gemelli sotto `.github/workflows/` sono bloccati per costruzione (il
  // token del ciclo non ha lo scope `workflows`) e non devono niente a nessuno.
  // Tenerli dentro renderebbe la passata rossa ogni giorno: un canale che si
  // smette di leggere. La condizione deve guardare lo STATO, non il solo flag.
  const src = read(SCRIPT);
  assert.doesNotMatch(
    src,
    /if \(verdict\.permanent\) \{\s*\n\s*manual\.push/,
    '`permanent` da solo include i `stable` e rende la passata rossa ogni giorno',
  );
});

test('il workflow non lascia che il no permanente fermi la copia', () => {
  const yml = read(WORKFLOW);

  // Meta` 1 — il dry-run neutralizza il 2. Se fallisse qui, lo step di apply
  // verrebbe saltato dal `success()` implicito del suo `if:`.
  assert.match(
    yml,
    /\[ "\$rc" = "2" \] && rc=0/,
    'lo step di dry-run deve degradare il 2 a 0, altrimenti salta la copia di tutti gli altri gemelli',
  );

  // Meta` 2 — l'apply prosegue sul 2 e si ferma su ogni altro codice.
  assert.match(
    yml,
    /if \[ "\$rc" != "0" \] && \[ "\$rc" != "2" \]; then exit "\$rc"; fi/,
    'ogni codice diverso da 0 e 2 deve restare bloccante: il buio delle fetch non deve aprire una PR',
  );

  // Meta` 3 — e il rosso arriva comunque, dopo che la PR e` stata aperta.
  const applyStep = yml.slice(yml.indexOf('Copia e apri la PR'));
  const lastExit = applyStep.lastIndexOf('exit "$rc"');
  const lastCreate = applyStep.lastIndexOf('gh pr create');
  assert.ok(lastCreate !== -1 && lastExit > lastCreate, 'il rosso va alzato DOPO `gh pr create`, non prima');
});

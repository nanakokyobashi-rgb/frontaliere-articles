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
import { EXIT_MANUAL_NEEDED, manualTransportReason } from '../../scripts/ci/transport-identical-twins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SCRIPT = 'scripts/ci/transport-identical-twins.mjs';
const WORKFLOW = '.github/workflows/transport-identical-twins.yml';
const REALIGN_WORKFLOW = '.github/workflows/transport-identical-twins-realign.yml';

test('--files= vuoto è un errore prima del no-op e non produce un falso successo', () => {
  const src = read('scripts/cf-purge-cache.mjs');
  const emptyGuard = src.indexOf('if (targetFiles && !targetFiles.length)');
  const tokenGuard = src.indexOf('if (!token)');
  assert.ok(emptyGuard >= 0, 'manca il rifiuto esplicito di --files= vuoto');
  assert.ok(emptyGuard < tokenGuard, 'la validazione deve precedere il no-op del token assente');
  assert.match(src.slice(emptyGuard, emptyGuard + 260), /process\.exit\(1\)/);
});

test('il codice di ritorno del trasporto non può diminuire fra dry-run e apply', () => {
  const yml = read(WORKFLOW);
  assert.match(yml, /previous_rc=.*transport-rc/);
  assert.match(yml, /\[ "\$previous_rc" -gt "\$rc" \] && rc="\$previous_rc"/);
  assert.match(yml, /case "\$previous_rc" in[\s\S]{0,120}0\|1\|2/);
});

test('il no permanente ha un codice suo, diverso da «non copiare»', () => {
  assert.equal(EXIT_MANUAL_NEEDED, 2);
  assert.notEqual(EXIT_MANUAL_NEEDED, 1, '1 e` gia` il buio delle fetch: riusarlo confonde due decisioni opposte');
  assert.notEqual(EXIT_MANUAL_NEEDED, 0, 'verde ma bloccato non e` uno stato accettabile');
});

test('un buio di rete non cancella dal report il blocco manuale', () => {
  const reason = manualTransportReason([{ path: 'host/shared/x.ts' }]);
  assert.match(reason, /host\/shared\/x\.ts/);
  assert.match(reason, /copia a mano/);
  assert.equal(manualTransportReason([]), '');
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

test('fast-publish salta il purge mirato quando la lista URL è vuota', () => {
  const yml = read('.github/workflows/fast-publish-article.yml');
  const first = yml.indexOf('name: Purge the edge cache for what was published');
  const second = yml.indexOf('WHY A SECOND PURGE');
  assert.notEqual(first, -1);
  assert.notEqual(second, -1);
  const firstBlock = yml.slice(first, second);
  const secondBlock = yml.slice(second);
  assert.match(firstBlock, /if \[ "\$\{#urls\[@\]\}" -eq 0 \]/);
  assert.match(secondBlock, /if \[ "\$\{#urls\[@\]\}" -eq 0 \]/);
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
    /if \[ "\$rc" != "0" \] && \[ "\$rc" != "2" \]; then[\s\S]{0,300}?exit "\$rc"/,
    'ogni codice diverso da 0 e 2 deve restare bloccante: il buio delle fetch non deve aprire una PR',
  );

  // Meta` 3 — il codice messo da parte sopravvive al ramo che non ha girato.
  assert.match(
    yml,
    /echo "\$rc" > "\$RUNNER_TEMP\/transport-rc"[\s\S]*?\[ "\$rc" = "2" \] && rc=0/,
    'il dry-run deve SALVARE l`rc prima di degradarlo, altrimenti il 2 sparisce con lui',
  );
});

test('il realign scrive il manifest solo dopo tutti i gate di verifica', () => {
  const src = read(SCRIPT);
  const gate = src.indexOf('if (mismatched.length || normalization.length)');
  const unreadable = src.indexOf('if (unreadable.length)', gate);
  const write = src.indexOf('if (corrections.length) fs.writeFileSync', unreadable);
  assert.ok(gate >= 0);
  assert.ok(unreadable > gate);
  assert.ok(write > unreadable, 'la scrittura deve avvenire dopo mismatch e path non verificabili');
});

test('un mismatch del batch viene escluso, mentre i path sani vengono riallineati', () => {
  const yml = read(WORKFLOW);
  assert.match(yml, /--realign=\/tmp\/transport-paths\.tsv --json/);
  assert.match(yml, /git restore --source=HEAD\^ --staged --worktree --/);
  assert.match(yml, /transport-realign-rc/);
  assert.match(yml, /--realign=\/tmp\/transport-paths\.tsv --json[\s\S]{0,5000}realign-safe\.json/);
  assert.match(yml, /r\.transported = r\.transported\.filter/);
  assert.match(yml, /old\.couplingSnapshot/);
});

test('il job post-merge usa hash site freschi e committa solo il manifest su main', () => {
  const yml = read(REALIGN_WORKFLOW);
  assert.match(yml, /pull_request:\n\s+types: \[closed\]/);
  assert.match(yml, /github\.event\.pull_request\.merged == true/);
  assert.match(yml, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(yml, /site sha256/);
  assert.match(yml, /ref: main[\s\S]{0,100}fetch-depth: 0/);
  assert.match(yml, /--realign="\$RUNNER_TEMP\/transport-realign\.tsv" --json/);
  assert.match(yml, /git push origin HEAD:main/);
  assert.match(yml, /baseline\.corpus/);
});

test('il body del trasporto descrive lo scope workflow osservato, non uno stato inventato', () => {
  const yml = read(WORKFLOW);
  assert.match(yml, /const workflowsBlocked = process\.env\.PAT_WORKFLOWS_SCOPE !== "true";/);
  assert.match(yml, /blocked: PAT_WORKFLOWS_SCOPE non è true/);
  assert.match(yml, /non sono bloccati dallo scope in questa passata/);
  assert.doesNotMatch(
    yml,
    /i gemelli sotto `\.github\/workflows\/`: fuori dall.*token.*non ha lo scope/,
    'il body non deve dichiarare sempre il blocco: la sonda può aver concesso lo scope',
  );
});

/**
 * Il rosso non puo` vivere dentro lo step di apply.
 *
 * Quello step e` gatato su `env.GITHUB_PAT_NANAKO != ''`, e il passo che popola
 * il PAT (`Load secrets from Remote Config`) e` `continue-on-error: true`: se
 * Remote Config non risponde, l'apply viene SALTATO. Un rosso che vivesse solo
 * li` sparirebbe con lo step, e la passata schedulata uscirebbe VERDE coi
 * gemelli bloccati per sempre dentro `manual` — lo stesso guasto che l'item 4
 * chiude, un livello piu` in la`.
 */
test('il verdetto finale gira con `always()`, non dentro il ramo col PAT', () => {
  const yml = read(WORKFLOW);

  // Il passo che carica il PAT e` davvero fail-open: e` la premessa del difetto.
  assert.match(
    yml,
    /Load secrets from Remote Config[\s\S]{0,200}?continue-on-error: true/,
    'se questo step diventasse bloccante il ragionamento qui sotto andrebbe rifatto',
  );

  const at = yml.lastIndexOf('- name: No permanenti');
  assert.notEqual(at, -1, 'manca lo step finale che possiede il verdetto');
  const finalStep = yml.slice(at);
  assert.match(finalStep, /if: always\(\)/, 'senza `always()` il verdetto salta insieme al ramo che ha fallito');
  assert.doesNotMatch(finalStep, /GITHUB_PAT_NANAKO/, 'il verdetto non deve dipendere dal PAT: e` il gate che lo rendeva vacuo');
  assert.match(finalStep, /transport-rc/, 'deve rileggere il codice messo da parte');
  assert.match(finalStep, /exit 1/, 'e uscire rosso');

  // E lo step di apply non deve piu` alzarlo da solo: due rossi per una causa
  // sola, e uno dei due assente proprio quando serve.
  const apply = yml.slice(yml.indexOf('Copia e apri la PR'), at);
  const create = apply.indexOf('gh pr create');
  assert.notEqual(create, -1, 'lo step di apply deve ancora aprire la PR');
  assert.doesNotMatch(
    apply.slice(create),
    /exit "\$rc"/,
    'dopo `gh pr create` lo step di apply non deve alzare il rosso: e` il ramo che puo` non girare',
  );
});

test('i guard contano solo le PR di QUESTO repo, non quelle da un fork', () => {
  // Su una PR da un fork `head.ref` non e` qualificato: chiunque puo` aprire un
  // branch chiamato come il nostro e far contare 1 al guard, che da quel
  // momento si spegne da solo per sempre. Un prefisso e` un nome, non un
  // permesso.
  for (const wf of [WORKFLOW, '.github/workflows/lessons-harvester.yml']) {
    assert.match(
      read(wf),
      /--jq '\.\[\] \| \[\.head\.repo\.full_name, \.head\.ref\] \| @tsv'[\s\S]*awk -F '\\t' -v repo="\$REPO"/,
      `${wf}: il guard deve qualificare il branch col repo, non fidarsi del solo nome`,
    );
  }
});

test('il quinto call-site della classe passa dall`helper', () => {
  // `CF_PURGE_SETTLE_MS=-5` faceva partire `setTimeout` subito: l'attesa di
  // propagazione del purge CDN saltava, e il chiamante andava a sondare
  // un'edge che serviva ancora la variante vecchia. Nessun errore, da nessuna
  // parte.
  const src = read('scripts/cf-purge-cache.mjs');
  assert.match(src, /parsePositiveNum\(process\.env\.CF_PURGE_SETTLE_MS/);
  assert.doesNotMatch(src, /Number\(process\.env\.CF_PURGE_SETTLE_MS\)/);
});

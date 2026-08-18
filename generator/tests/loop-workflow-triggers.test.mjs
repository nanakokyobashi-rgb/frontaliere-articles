/**
 * loop-workflow-triggers.test.mjs — i tre difetti del ciclo che vivono nel
 * BLOCCO DI TESTA di un workflow, dove nessun test arrivava.
 *
 * ## Perché un test sullo YAML, e perché proprio qui
 *
 * `generate-article-chain.test.mjs` estrae ed ESEGUE un blocco `run:`, che è la
 * forma giusta quando c'è della logica. Qui non c'è: `on:`, `concurrency:` e
 * `if:` non si eseguono mai: li interpreta GitHub, una volta sola, prima che
 * qualunque step esista. Un difetto lì non produce un errore, produce
 * un'ASSENZA — una run che non parte, una review che non viene mai postata — e
 * l'assenza è precisamente ciò che nessun log mostra.
 *
 * Le tre asserzioni qui sotto sono le uniche forme in cui quei tre difetti
 * possono tornare, e costano microsecondi.
 *
 * ## Dove girano, e dove NO
 *
 * `tests.yml` ha `pull_request` + `push`. Fino al 2026-08-18 il `push` escludeva
 * `main` (`branches-ignore`), quindi questi test giravano su OGNI PR — che è il
 * momento in cui una di queste righe potrebbe regredire — ma non sui push diretti
 * a `main`; da allora girano anche lì, perché il rescue `stuck-red` di
 * `pr-autorebase.mjs` legge `actions/workflows/tests.yml/runs?branch=main` e
 * senza una run `success` lì non ha prova da esibire (vedi il commento accanto al
 * trigger in `tests.yml`, e la #267).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Solo le righe eseguibili. I commenti di questi workflow CITANO i difetti per
 * intero (gruppi vecchi, flag rimossi): un match sul testo grezzo li leggerebbe
 * come ancora presenti.
 */
const active = (src) =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

const PRL = active(read('.github/workflows/pr-review-loop.yml'));
const GA = active(read('.github/workflows/generate-article.yml'));

/** Il blocco di un job: da `\n  <nome>:` al job successivo allo stesso livello. */
function jobBlock(src, name) {
  const start = src.indexOf(`\n  ${name}:\n`);
  if (start === -1) return null;
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

// ── #5614 (metà corpus) — l'evento nel concurrency group ─────────────────────
//
// `tests.yml` gira sia su `pull_request` sia su `push`, quindi un push su un
// branch con PR aperta produce DUE run di `tests` con lo stesso `head_branch`,
// quindi due run di `pr-review-loop`. Con il group keyed SOLO sul branch e
// `cancel-in-progress: true` le due si cancellavano a vicenda, e la perdente era
// sempre quella che contava: la run nata dal `push` viene saltata dal gate `if:`
// (che pretende `workflow_run.event == 'pull_request'`), quindi uccideva la
// review vera senza lasciare niente al suo posto. 25 coppie `cancelled`+`skipped`
// su 400 run, l'ultima il 2026-08-12T10:49:59Z.

test("pr-review-loop: il concurrency group discrimina l'EVENTO, non solo il branch", () => {
  const m = PRL.match(/\nconcurrency:\n\s+group:\s*(.+)/);
  assert.ok(m, 'blocco `concurrency:` di primo livello non trovato in pr-review-loop.yml');
  const group = m[1];
  assert.ok(
    group.includes('github.event.workflow_run.event'),
    'Il group NON interpola l\'evento che ha fatto partire `tests`.\n' +
      'Senza, la run da `push` e quella da `pull_request` per lo stesso branch finiscono nello\n' +
      'stesso slot e, con cancel-in-progress: true, la prima cancella la review vera lasciando\n' +
      `uno skip al suo posto. Group attuale: ${group}`,
  );
  assert.ok(
    group.includes('head_branch'),
    `Il group ha smesso di essere per-branch: due PR diverse si cancellerebbero. Group: ${group}`,
  );
});

// ── #201 — la maniglia manuale ───────────────────────────────────────────────
//
// Un rerun di `tests` non produce nessun evento `workflow_run` utile, quindi una
// PR riparata dal redflag-fixer resta verde, con una sola review vecchia, per
// sempre. Il trigger è l'unica via d'uscita che non dipenda dallo stato di un
// altro agente.

test('pr-review-loop: esiste workflow_dispatch con il numero di PR come input', () => {
  const onBlock = PRL.slice(PRL.indexOf('\non:'), PRL.indexOf('\nconcurrency:'));
  assert.match(
    onBlock,
    /workflow_dispatch:/,
    'Senza `workflow_dispatch` una PR ferma dopo un rerun di `tests` non ha nessun modo di ' +
      'farsi revieware: il loop dipende dal re-trigger via push, che in un rerun non c\'è.',
  );
  assert.match(onBlock, /\n\s+pr:\n/, 'il dispatch non dichiara l\'input `pr`');
  assert.match(onBlock, /\n\s+required: true\n/, 'l\'input `pr` non è obbligatorio');
});

test('pr-review-loop: il gate `if:` ammette il dispatch, altrimenti il trigger è decorativo', () => {
  const job = jobBlock(PRL, 'review');
  assert.ok(job, 'job `review` non trovato');
  assert.match(
    job,
    /github\.event_name == 'workflow_dispatch'/,
    'Il job resta gateato sul solo `workflow_run`: il trigger manuale partirebbe e verrebbe ' +
      'saltato, cioè esattamente lo stesso silenzio della #201 con un run in più.',
  );
});

test('pr-review-loop: fuori dal resolve nessuno legge più workflow_run.head_sha', () => {
  const hits = PRL.match(/\$\{\{ github\.event\.workflow_run\.head_sha \}\}/g) || [];
  assert.equal(
    hits.length,
    1,
    'Su `workflow_dispatch` `github.event.workflow_run` è nullo, quindi ogni riferimento diretto ' +
      'a `head_sha` diventa la stringa vuota — e uno `actions/checkout` con `ref: ""` prende il ' +
      'DEFAULT BRANCH: il reviewer leggerebbe `main` credendo di leggere la PR, e la review ' +
      'sarebbe sbagliata senza nessun errore. L\'unica occorrenza ammessa è `RUN_HEAD_SHA` nello ' +
      `step di resolve, che è chi normalizza le due strade. Trovate: ${hits.length}.`,
  );
  assert.match(
    PRL,
    /ref: \$\{\{ steps\.resolve\.outputs\.head_sha \}\}/,
    'il checkout non usa la head normalizzata dal resolve',
  );
});

test('pr-review-loop: sul ramo dispatch i permessi sono scoped, non skip-permissions', () => {
  const m = PRL.match(/claude_args: "([^"]*)"/);
  assert.ok(m, '`claude_args` non trovato');
  const args = m[1];
  assert.ok(
    args.includes("github.event_name == 'workflow_dispatch'"),
    'IL FLAG NON È CONDIZIONATO AL TRIGGER. Le run `schedule`/`workflow_dispatch` risolvono ' +
      '`permissionMode` a "default" NONOSTANTE `--dangerously-skip-permissions` (rollback #3269: ' +
      '36 Bash bloccati con "requires approval", zero comment postati). Una maniglia manuale che ' +
      'apre una sessione incapace di postare la review non chiude la #201, la riproduce.\n' +
      `claude_args: ${args}`,
  );
  assert.ok(args.includes('--allowedTools'), 'il ramo dispatch non ripiega su `--allowedTools`');
  assert.ok(
    args.includes('--dangerously-skip-permissions'),
    'il ramo `workflow_run` deve conservare il flag: lì funziona, ed è il percorso caldo',
  );
});

// ── #212 / #193 — lo sfratto dalla coda di concurrency ───────────────────────
//
// Un gruppo di concurrency ammette una run in esecuzione e UNA sola in attesa:
// sotto sovra-sottoscrizione non è una coda, è una politica di scarto. Le run
// sfrattate tornano `jobs.total_count == 0` — zero step eseguiti — quindi lo
// sfratto non stava proteggendo nessuna scrittura: quella è serializzata dal
// push con rebase-retry, che è l'unico strato che vede anche gli altri sei
// produttori che scrivono `content/**` su main sotto un gruppo proprio.

test('generate-article: la concurrency non è più a livello di workflow', () => {
  assert.ok(
    !/^concurrency:/m.test(GA),
    'Un gruppo a livello di workflow mette in coda — e quindi sfratta — PRIMA che qualunque job ' +
      'possa decidere se la generazione serva davvero. È la riga che produceva le run cancellate ' +
      'con `total_count == 0`.',
  );
});

test('generate-article: il gate di ammissione esiste e NON è esso stesso in coda', () => {
  const admit = jobBlock(GA, 'admit');
  assert.ok(admit, 'job `admit` non trovato: senza gate lo sfratto torna identico');
  assert.ok(
    !/\n\s+concurrency:/.test(admit),
    'Il gate ha un `concurrency:`. Un gate che può finire in coda è esattamente il difetto che ' +
      'deve chiudere: verrebbe sfrattato prima di poter decidere, e la run tornerebbe a ' +
      '`total_count == 0`.',
  );
  assert.match(admit, /actions: read/, 'il gate non può elencare le run senza `actions: read`');
});

test('generate-article: la mutua esclusione resta, ma sul job che scrive', () => {
  const gen = jobBlock(GA, 'generate');
  assert.ok(gen, 'job `generate` non trovato');
  assert.match(
    gen,
    /\n\s+concurrency:\n\s+group: generate-article\n\s+cancel-in-progress: false/,
    'Il gruppo `generate-article` non è più sul job che scrive. Il gate riduce gli arrivi, non ' +
      'garantisce l\'esclusività: se due arrivi passano insieme la finestra di corsa fra i due ' +
      'controlli, questo è lo strato che evita di pagare due generazioni per un articolo solo.',
  );
  assert.match(gen, /needs: admit/, 'il job che genera non dipende dal gate');
  assert.match(
    gen,
    /if: needs\.admit\.outputs\.proceed == 'true'/,
    'senza `if:` il gate calcola un output che nessuno legge',
  );
});

// ── Il watchdog dello stallo (2026-08-18) NON sostituisce il tetto del job ───
//
// Dal 15-08 il difetto dominante di questo workflow è un wedge: il processo
// tace, nessun timer JS parte, nessun handler di segnale gira, e solo SIGKILL
// lo chiude — 42 run su 69 `failure`, 26,6 ore in cinque giorni. La fix è un
// watchdog sul SILENZIO dentro lo step «Generate the article», e la tentazione
// che segue sempre una fix così è togliere i cap che ora «non servono più».
//
// Servono, e coprono classi diverse: il watchdog vive DENTRO la shell dello
// step e non può vedere nulla che uccida quella shell o che si incastri prima
// (npm ci, il checkout, l'action del fallback Haiku). `timeout-minutes` è
// l'unico strato che GitHub applica da fuori, e come `on:`/`concurrency:` non
// si esegue mai: se sparisce non produce un errore, produce una run appesa
// fino ai 6 ore di default del runner.
test('generate-article: il job `generate` conserva il proprio timeout-minutes', () => {
  const gen = jobBlock(GA, 'generate');
  assert.ok(gen, 'job `generate` non trovato');
  assert.match(
    gen,
    /timeout-minutes: 60/,
    'Il tetto del job è sparito. Il watchdog dello stallo copre il processo di generazione, non ' +
      'la shell che lo lancia né gli step prima: senza questa riga una run incastrata fuori da ' +
      'quello step resta appesa fino al default di GitHub (6h), e con `cancel-in-progress: false` ' +
      'tiene il gruppo di concurrency per tutto il tempo.',
  );
});

// ── L'esenzione del dispatch dopo l'auto-dispatch (2026-08-18) ───────────────
//
// Da quando la catena dispatcha il proprio successore, `workflow_dispatch` non
// è più una sola cosa. `admit` esentava OGNI dispatch dal gate, e per un umano
// è giusto — una richiesta esplicita non è il riavvio ridondante di niente. Per
// un anello le due forme sbagliate sono entrambe rotte, e nessuna delle due
// produce un errore visibile:
//
//   · anello NON esente → non parte MAI. Il dispatch nasce dentro il job del
//     padre, quindi al momento della domanda il padre è per forza in volo e per
//     forza più vecchio: il gate vedrebbe sempre «una generazione è già in
//     volo». La catena sembrerebbe semplicemente non esistere.
//   · anello esente come un umano → entra nel gruppo di concurrency mentre
//     un'altra run cammina, e lì GitHub tiene UNA sola pending e cancella la
//     precedente a ogni arrivo. È la politica di scarto che le #193/#212 hanno
//     appena chiuso, riaperta da una sorgente di arrivi in più.
//
// È esattamente la classe che questo file copre: righe che GitHub interpreta,
// il cui difetto è un'ASSENZA e non un errore.
test('generate-article: l\'esenzione del dispatch discrimina un anello da un umano', () => {
  const admit = jobBlock(GA, 'admit');
  assert.ok(admit, 'job `admit` non trovato');
  assert.match(
    admit,
    /CHAIN_DEPTH: \$\{\{ inputs\.chain_depth \}\}/,
    'il marcatore non arriva al gate: senza, il gate non ha modo di distinguere i due casi',
  );
  assert.match(
    admit,
    /chain_depth" -gt 0/,
    'l\'esenzione non guarda `chain_depth`: o esenta anche gli anelli (sfratto) o nessuno (catena morta)',
  );
  assert.match(
    admit,
    /is_link" != "true"/,
    'il ramo «procedi sempre» deve restare riservato al dispatch umano',
  );
  // Il padre va escluso dal confronto, o l'anello cede sempre a chi l'ha
  // generato — che è ancora in volo per costruzione.
  assert.match(
    admit,
    /PARENT_RUN_ID: \$\{\{ inputs\.parent_run_id \}\}/,
    'senza il run id del padre non c\'è modo di escluderlo, e ogni anello si ferma',
  );
  // Il tetto orario è l'unica guardia che un input sbagliato non aggira: si
  // calcola dalle run vere, non da un contatore propagato.
  assert.match(
    admit,
    /CHAIN_MAX_RUNS_PER_HOUR/,
    'il tetto orario è sparito: `chain_depth` e `no_article_streak` viaggiano negli input, quindi un ' +
      'dispatch che li azzera li aggira entrambi. Questo no.',
  );
});

test('generate-article: il cron resta il riavvio della catena, e non scende a uno slot', () => {
  const on = GA.slice(GA.indexOf('on:'), GA.indexOf('\npermissions:'));
  const slots = on.match(/- cron: '/g) || [];
  assert.equal(
    slots.length,
    2,
    'Quattro slot erano la compensazione di una catena che si spezzava a ogni anello secco; con il ' +
      'successore garantito due bastano. Ma sotto i due il cron smette di essere una rete: è l\'unica ' +
      'cosa che riaccende dopo un cap esaurito o un kill switch riarmato.',
  );
});

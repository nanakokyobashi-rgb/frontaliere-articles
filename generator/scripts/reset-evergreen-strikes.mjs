#!/usr/bin/env node
/**
 * reset-evergreen-strikes.mjs — amnistia MIRATA sugli strike evergreen (issue #96).
 *
 * IL PROBLEMA CHE RIPARA, e perche' serve uno script e non una modifica a mano.
 *
 * `data/topic-candidates-evergreen-rejected.json` ha due bucket con semantiche
 * diverse (vedi `article-topic-selector.mjs`), oggi serializzate nello schema
 * v2:
 *
 *   bans[]      ban confermati con provenance section/pool/poolEpoch.
 *               Cause ancora valide: questo script NON le tocca mai.
 *   strikes[]   contatori quality reject con provenance e TTL. A
 *               `EVERGREEN_STRIKE_LIMIT` (3) la keyword e' ritirata fino alla
 *               scadenza, non per sempre.
 *   legacy[]    residui pre-v2 conservati con regola `preflight-required`;
 *               il preflight li deve rivalidare prima di renderli attivi.
 *
 * Fino alla fix di #96 un evergreen della sezione `svizzera` veniva graduato
 * dal gate `checkSourceFidelity` contro `EVERGREEN_FACTS_BRIEF`, che e'
 * interamente frontaliero: 27 ancore su Accordo Frontalieri, IRPEF e
 * Convenzione 1976, soglia 14. Un articolo su LAMal o sulla dichiarazione
 * cantonale le omette CORRETTAMENTE, prendeva `source-fidelity-low` per sei
 * tentativi di fila e finiva con uno strike. Tre run e la keyword moriva.
 *
 * Misurato sul run 31315163916 (2026-08-09, section=svizzera): 110 keyword nel
 * pool, 94 gia' morte — 42 per ban, 52 per strike — e il run finito con
 * «Tutte le keyword evergreen risultano gia' coperte dal pre-flight».
 *
 * IL TAGLIO: solo `strikes`, e solo per le keyword che appartengono davvero al
 * pool evergreen della sezione svizzera. Non e' un reset cieco:
 *   - i ban restano, perche' un duplicato resta un duplicato;
 *   - le keyword frontaliere non vengono toccate da `--section=svizzera`;
 *   - una keyword che era davvero cattiva ripaghera' i suoi 3 strike da sola,
 *     perche' i gate sono rimasti tutti in piedi (nessuna soglia abbassata).
 *
 * Il pool viene RICOSTRUITO da `create-article.mjs`, non riscritto qui: le due
 * liste che lo compongono sono la' e devono restare l'unica sorgente di
 * verita'. Estratte per valutazione in sandbox — stessa tecnica di
 * `blog-title-casing.test.mjs` e `seo-clause-truncation.test.mjs` — perche'
 * importare `create-article.mjs` richiederebbe l'intero albero del generatore
 * e questo repo non ha `node_modules`.
 *
 * USO (dry-run per default, non scrive niente senza `--apply`):
 *   node generator/scripts/reset-evergreen-strikes.mjs --section=svizzera
 *   node generator/scripts/reset-evergreen-strikes.mjs --section=svizzera --apply
 */
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearEvergreenStrikesForPool,
  persistEvergreenRejectedTracker,
} from './lib/article-topic-selector.mjs';

// Due livelli: da generator/scripts/ alla radice del repo. Uno solo punterebbe
// a generator/ — vedi import-closure.test.mjs, «entry points resolve the repo root».
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = path.join(PROJECT_ROOT, 'data', 'topic-candidates-evergreen-rejected.json');
const CREATE_ARTICLE = path.join(PROJECT_ROOT, 'generator', 'scripts', 'create-article.mjs');

/** Estrae un blocco di `src` dal suo inizio letterale fino al terminatore dato. */
function extractBlock(src, startNeedle, endNeedle, label) {
  const start = src.indexOf(startNeedle);
  if (start === -1) {
    throw new Error(`${label} non trovata in create-article.mjs — aggiornare i delimitatori`);
  }
  const end = src.indexOf(endNeedle, start);
  if (end === -1) throw new Error(`fine di ${label} non trovata`);
  return src.slice(start, end + endNeedle.length);
}

/**
 * Ricostruisce il pool evergreen della sezione svizzera estraendo da
 * create-article.mjs le TRE liste che lo compongono, senza importarlo.
 * Fallisce RUMOROSAMENTE se i delimitatori cambiano: un pool vuoto qui
 * significherebbe «nessuna keyword da amnistiare», cioe' un no-op silenzioso
 * che sembra un successo.
 *
 * `buildStructuralEvergreenTopicsSvizzera` e' entrata nel giro il 2026-08-10,
 * con il pool nazionale per cantone. Non e' un dettaglio di completezza: e' il
 * 82% del pool, e lasciarla fuori avrebbe reso l'amnistia una no-op su quasi
 * tutte le keyword che possono prendere uno strike da qui in avanti.
 */
export function svizzeraEvergreenPool(src) {
  const priorityBlock = extractBlock(
    src, 'const PRIORITY_EVERGREEN_TOPICS_SVIZZERA = [', '\n];\n', 'PRIORITY_EVERGREEN_TOPICS_SVIZZERA',
  );
  const dynamicBlock = extractBlock(
    src, 'function buildDynamicEvergreenTopicsSvizzera() {', '\n}\n', 'buildDynamicEvergreenTopicsSvizzera',
  );
  const structuralBlock = extractBlock(
    src, 'function buildStructuralEvergreenTopicsSvizzera() {', '\n}\n', 'buildStructuralEvergreenTopicsSvizzera',
  );

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    `${priorityBlock}\n${dynamicBlock}\n${structuralBlock}\n`
    + 'return [...PRIORITY_EVERGREEN_TOPICS_SVIZZERA, ...buildDynamicEvergreenTopicsSvizzera(),'
    + ' ...buildStructuralEvergreenTopicsSvizzera()].map((t) => t.keyword);',
  );
  const pool = factory();
  if (!Array.isArray(pool) || pool.length < 50) {
    throw new Error(`pool svizzero ricostruito con sole ${pool && pool.length} keyword — sospetto, mi fermo`);
  }
  return pool;
}

/**
 * PURA: calcola il nuovo ledger e cosa e' cambiato. Nessun I/O, cosi' il
 * comportamento e' verificabile senza toccare il file di produzione.
 */
export function clearStrikesForPool(ledger, pool) {
  const result = clearEvergreenStrikesForPool(ledger, pool);
  return {
    ledger: result.tracker,
    cleared: result.cleared,
    // I ban restano: dichiarati esplicitamente perche' questo script sceglie
    // di NON riparare quella meta' del ledger, anche dopo la migrazione.
    keptBanned: result.keptBanned,
  };
}

function main(argv) {
  const apply = argv.includes('--apply');
  const sectionArg = (argv.find((a) => a.startsWith('--section=')) || '--section=svizzera').split('=')[1];
  if (sectionArg !== 'svizzera') {
    console.error(`❌ --section="${sectionArg}" non supportata. Questo script ricostruisce solo il pool svizzero (#96).`);
    process.exit(2);
  }

  const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');
  const pool = svizzeraEvergreenPool(src);
  const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf-8'));

  const before = Array.isArray(ledger.strikes) ? ledger.strikes.length : Object.keys(ledger.strikes || {}).length;
  const { ledger: next, cleared, keptBanned } = clearStrikesForPool(ledger, pool);
  const retired = cleared.filter((c) => c.wasRetired);

  console.log(`pool evergreen svizzera ricostruito : ${pool.length} keyword`);
  console.log(`strikes nel ledger                  : ${before}`);
  console.log(`  azzerati (nel pool svizzero)      : ${cleared.length}, di cui gia' ritirati (>=3): ${retired.length}`);
  console.log(`  lasciati intatti (fuori dal pool) : ${Object.keys(next.strikes).length}`);
  console.log(`ban permanenti nel pool, NON toccati: ${keptBanned.length}`);
  console.log('');
  for (const c of retired) console.log(`  ↺ ${c.strikes}  ${c.keyword}`);

  if (!apply) {
    console.log('\nDRY-RUN: nessuna scrittura. Rilancia con --apply per scrivere il ledger.');
    return 0;
  }
  if (!persistEvergreenRejectedTracker(next, { path: LEDGER })) {
    console.error('\n❌ scrittura del ledger fallita');
    return 1;
  }
  console.log(`\n✅ Scritto ${path.relative(PROJECT_ROOT, LEDGER)}`);
  return 0;
}

// Guardia CLI: senza, importare questo modulo da un test lo eseguirebbe davvero
// (vedi ignore-list-semantics.test.mjs, stessa classe di difetto). Risolviamo
// entrambi i lati per coprire l'invocazione via symlink.
const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}

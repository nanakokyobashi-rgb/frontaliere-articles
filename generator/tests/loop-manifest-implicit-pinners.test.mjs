/**
 * loop-manifest-implicit-pinners.test.mjs — il manifest sorveglia i file uno
 * per uno, e cosi' non vede le dipendenze IMPLICITE: le voci `DECLARED_ABSENT`
 * di `loop-references-exist.test.mjs` sono appaiate al TESTO di un file
 * sorvegliato, non alla sua API, quindi nessun `import` le rivela (issue #975,
 * item 4 di #900).
 *
 * Run with `node --test generator/tests/loop-manifest-implicit-pinners.test.mjs`.
 *
 * ## Perche' un test sul parse, e non solo sul verdetto
 *
 * `declaredAbsentCiters()` legge le chiavi di un oggetto letterale che vive in
 * UN ALTRO file di test. Se quella forma cambia — apici diversi, indentazione
 * diversa, un separatore diverso — il parse torna una mappa vuota, e una mappa
 * vuota e' indistinguibile da «nessun file ha dipendenze implicite»: il
 * rilevatore si spegne in silenzio, che e' esattamente il modo di fallire che
 * esiste per chiudere. Il test lo pinna quindi sul registro REALE: la forma non
 * puo' cambiare senza diventare rossa qui.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  implicitPinnersVerdict,
  declaredAbsentCiters,
  crawlerContractIsActive,
  resetPinnerIndex,
  DECLARED_ABSENT_REGISTRY_REL,
  CRAWLER_CONTRACT_REL,
  DORMANT_WITH_CRAWLER_CONTRACT,
  classify,
} from '../../scripts/ci/loop-drift-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
const REGISTRY = fs.readFileSync(path.join(ROOT, DECLARED_ABSENT_REGISTRY_REL), 'utf8');
const CRAWLER_CONTRACT_SOURCE = fs.existsSync(path.join(ROOT, CRAWLER_CONTRACT_REL))
  ? fs.readFileSync(path.join(ROOT, CRAWLER_CONTRACT_REL), 'utf8')
  : null;
const CRAWLER_CONTRACT = crawlerContractIsActive(CRAWLER_CONTRACT_SOURCE);
/** L'indice come lo costruisce lo script: solo le dichiarazioni ATTIVE. */
const activeCiters = () => declaredAbsentCiters(REGISTRY, { crawlerContract: CRAWLER_CONTRACT });

test('il registro dichiarato esiste ed e\' proprio quello dei DECLARED_ABSENT', () => {
  assert.equal(DECLARED_ABSENT_REGISTRY_REL, 'generator/tests/loop-references-exist.test.mjs');
  assert.ok(REGISTRY.includes('const DECLARED_ABSENT = {'), 'il registro non contiene piu\' DECLARED_ABSENT');
});

test('il parse del registro non torna vuoto: una mappa vuota spegne il rilevatore in silenzio', () => {
  const citers = activeCiters();
  assert.ok(citers.size > 0, 'nessuna chiave `<file> :: <referente>` letta: la forma del registro e\' cambiata');
  // Ogni chiave letta deve avere la forma di un path, non di una frase: e` il
  // controllo che separa «ho letto le chiavi» da «ho matchato della prosa».
  const bogus = [...citers.keys()].filter((k) => !/^[\w.@-]+(?:\/[\w.@-]+)+$/.test(k));
  assert.deepEqual(bogus, [], `Chiavi che non sono path repo-relative:\n  ${bogus.join('\n  ')}`);
});

const countEntries = (index) => [...index.values()].reduce((total, refs) => total + refs.length, 0);

test('il parser accetta apici singoli, doppi e template senza attraversare una riga', () => {
  const parsed = declaredAbsentCiters([
    '  "scripts/it\'s.mjs :: docs/a.md": true,',
    "  'scripts/b.mjs :: docs/b.md': true,",
    '  `scripts/c.mjs :: docs/c.md`: true,',
    '  "scripts/d.mjs ::',
    '  docs/d.md": true,',
    '  "scripts/should-not-join.mjs :: docs/e.md": true,',
  ].join('\n'));
  assert.deepEqual([...parsed.entries()], [
    ["scripts/it's.mjs", ['docs/a.md']],
    ['scripts/b.mjs', ['docs/b.md']],
    ['scripts/c.mjs', ['docs/c.md']],
    ['scripts/should-not-join.mjs', ['docs/e.md']],
  ]);
});

test('il registro mantiene un floor di cardinalità misurato sul checkout', () => {
  const all = declaredAbsentCiters(REGISTRY, { crawlerContract: false });
  const active = activeCiters();
  assert.ok(all.size >= 61, 'il registro ha perso chiavi di citanti');
  assert.ok(countEntries(all) >= 142, 'il registro ha perso dichiarazioni totali');
  assert.ok(active.size >= 37, 'il registro ha perso citanti attivi');
  assert.ok(countEntries(active) >= 70, 'il registro ha perso dichiarazioni attive');
});

test('il contract crawler usa il valore JSON e la cache pinner ha una chiave d input', () => {
  assert.equal(crawlerContractIsActive('null'), false);
  assert.equal(crawlerContractIsActive('false'), false);
  assert.equal(crawlerContractIsActive('0'), false);
  assert.equal(crawlerContractIsActive('{}'), true);
  const checker = fs.readFileSync(path.join(ROOT, 'scripts/ci/loop-drift-check.mjs'), 'utf8');
  assert.match(checker, /let PINNER_INDEX_KEY = null/);
  assert.match(checker, /crawlerContract: crawlerContractIsActive\(contractSource\)/);
  resetPinnerIndex();
});

test('il registro e\' `corpus-only`: non scende mai insieme alla copia', () => {
  const entry = MANIFEST.files.find((f) => f.path === DECLARED_ABSENT_REGISTRY_REL);
  assert.ok(entry, 'il registro non e\' piu\' nel manifest');
  assert.equal(
    entry.mode,
    'corpus-only',
    'Se il registro diventasse `identical` scenderebbe insieme ai suoi citanti e l\'avviso perderebbe la sua ragione: rivedi `implicitPinnersVerdict`.',
  );
});

test('almeno una voce `identical` del manifest ha una dichiarazione appaiata', () => {
  // La rimisura del 2026-09-08 su questo `main` dice 20 su 159 contando le sole
  // dichiarazioni ATTIVE (44 contandole tutte). Il numero esatto si muove a
  // ogni PR, ma ZERO vorrebbe dire che il rilevatore non trova piu` niente —
  // cioe` il silenzio che questo modulo esiste per rompere.
  const citers = activeCiters();
  const paired = MANIFEST.files.filter((f) => f.mode === 'identical' && citers.has(f.path));
  assert.ok(paired.length > 0, 'nessun gemello `identical` con dichiarazione appaiata: il rilevatore e\' cieco');
});

test('avvisa solo su `identical` in `site-ahead`', () => {
  const pinners = ['mirror-articles-engine.yml'];
  assert.equal(implicitPinnersVerdict({ mode: 'identical', state: 'site-ahead', pinners }).pinned, true);
  for (const state of ['stable', 'corpus-ahead', 'both-moved', 'undeclared-drift', 'missing-here']) {
    assert.equal(
      implicitPinnersVerdict({ mode: 'identical', state, pinners }).pinned,
      false,
      `${state} non deve produrre l'avviso: nessuna copia sta per riscrivere il testo`,
    );
  }
  for (const mode of ['adapted', 'corpus-only', 'corpus-only-pending', 'not-ported']) {
    assert.equal(
      implicitPinnersVerdict({ mode, state: 'site-ahead', pinners }).pinned,
      false,
      `${mode} non e' copiato cosi' com'e': l'avviso sarebbe rumore`,
    );
  }
});

test('fail-open: senza dichiarazioni non c\'e\' avviso', () => {
  assert.equal(implicitPinnersVerdict({ mode: 'identical', state: 'site-ahead' }).pinned, false);
  assert.equal(implicitPinnersVerdict({ mode: 'identical', state: 'site-ahead', pinners: [] }).pinned, false);
  assert.equal(implicitPinnersVerdict({ mode: 'identical', state: 'site-ahead', pinners: [null, ''] }).pinned, false);
});

test('i referenti tornano deduplicati e ordinati', () => {
  const v = implicitPinnersVerdict({ mode: 'identical', state: 'site-ahead', pinners: ['b.yml', 'a.yml', 'b.yml'] });
  assert.deepEqual(v.pinners, ['a.yml', 'b.yml']);
});

test('lo STATO non cambia: `transportVerdict` continua a vedere `site-ahead`', () => {
  // E` la meta` che rende l'avviso non distruttivo. Se `classify()` restituisse
  // un nuovo stato, `transportVerdict()` — che pretende `site-ahead` — SPEGNEREBBE
  // il trasporto sul 13% delle voci, cioe` il canale fermo per curare un rischio
  // che si materializza solo qualche volta.
  const entry = { path: 'scripts/ci/alert-pat-down.mjs', mode: 'identical' };
  const base = { site: 'aaa', corpus: 'bbb' };
  const now = { site: 'ccc', corpus: 'bbb' };
  const withPin = classify(entry, now, base, [], ['scripts/load-rc-env.mjs']);
  const withoutPin = classify(entry, now, base, [], []);
  assert.equal(withPin.state, 'site-ahead');
  assert.equal(withoutPin.state, 'site-ahead');
  assert.equal(withPin.actionable, withoutPin.actionable);
  assert.ok(withPin.detail.includes('dipendenza IMPLICITA'), 'l\'avviso non compare nel detail');
  assert.ok(withPin.detail.includes('scripts/load-rc-env.mjs'), 'il referente non e\' nominato');
  assert.ok(withPin.detail.startsWith(withoutPin.detail), 'il testo preesistente e\' stato riscritto invece che esteso');
});

test('senza dichiarazioni il `detail` resta byte-identico a prima', () => {
  const entry = { path: 'scripts/ci/alert-pat-down.mjs', mode: 'identical' };
  const v = classify(entry, { site: 'ccc', corpus: 'bbb' }, { site: 'aaa', corpus: 'bbb' }, [], []);
  assert.equal(
    v.detail,
    'Il file e\' dichiarato identico al sito: la modifica del sito e\' copiabile qui cosi\' com\'e\'.',
  );
});

test('il filtro delle dichiarazioni DORMIENTI e\' lo stesso del registro', () => {
  // AGENTS.md #6: il registro e' un file di test, importarlo da uno script CI
  // ne eseguirebbe la suite, quindi la regex e' duplicata. Il legame lo copre
  // questo test: se `ACTIVE_DECLARED_ABSENT` cambia forma, l'indice dello
  // script tornerebbe ad avvisare su dichiarazioni che nessun test fa valere.
  assert.ok(
    REGISTRY.includes('const ACTIVE_DECLARED_ABSENT ='),
    'il registro non filtra piu\' le dichiarazioni dormienti: rivedi `DORMANT_WITH_CRAWLER_CONTRACT`',
  );
  assert.ok(
    REGISTRY.includes(DORMANT_WITH_CRAWLER_CONTRACT.source),
    `la regex del registro non coincide piu\' con quella dello script:\n  ${DORMANT_WITH_CRAWLER_CONTRACT.source}`,
  );
  assert.ok(
    REGISTRY.includes(CRAWLER_CONTRACT_REL),
    'il registro non nomina piu\' il contract crawler: la condizione di dormienza e\' cambiata',
  );
});

test('col contract presente le dichiarazioni dormienti restano fuori dall\'indice', () => {
  const all = declaredAbsentCiters(REGISTRY, { crawlerContract: false });
  const active = declaredAbsentCiters(REGISTRY, { crawlerContract: true });
  const dormant = [...all.keys()].filter((k) => !active.has(k));
  assert.ok(dormant.length > 0, 'nessuna chiave filtrata: il registro non ha piu\' voci dormienti?');
  for (const citer of dormant) {
    assert.ok(
      DORMANT_WITH_CRAWLER_CONTRACT.test(`${citer} :: x`),
      `${citer} e' stato filtrato senza essere dormiente`,
    );
  }
  // Il verso opposto: nessuna voce attiva deve cadere.
  for (const citer of active.keys()) assert.ok(all.has(citer), `${citer} sparito dall'indice completo`);
});

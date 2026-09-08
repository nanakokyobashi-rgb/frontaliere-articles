/**
 * loop-drift-init-attest.test.mjs — la baseline che `--init` SCRIVE viene
 * attestata contro l'albero del sito (issue #978).
 *
 * ## Perché esiste
 *
 * `checkBaselineProvenance()` (issue #148) vive sul percorso NON-init: il ramo
 * `--init` scrive la baseline e fa `continue` prima di arrivarci. E anche se ci
 * arrivasse non direbbe niente — appena scritta, `baseline === now`, quindi
 * `ghostVerdict` chiude su `matchedAt: 'current'`. La verifica di provenienza
 * sa dire se una baseline VECCHIA è mai esistita; su una che nasce in questo
 * istante è un no-op per costruzione.
 *
 * Il risultato è che qualunque cosa `siteFile()` abbia risposto diventa «la
 * verità del giorno»: un `SITE_REF` puntato altrove, una raw servita dalla CDN
 * da una revisione vecchia, un ref che si muove a metà passata. Byte reali, hash
 * valido, e nessuna corrispondenza con ciò che il sito ha su `main` — cioè
 * esattamente la `ghost-baseline` di #148, fabbricata da un comando invece che
 * a mano. `--only` restringe il danno a una voce, non lo esclude.
 *
 * `initAttestVerdict` confronta i byte scaricati con il git blob SHA che
 * l'albero del sito dichiara a quel path: una seconda sorgente (l'API, non la
 * CDN), e l'unica che possa smentire una GET.
 *
 * ## Perché testa la funzione pura e non la CLI
 *
 * `main()` fa rete e riscrive un file versionato. `initAttestVerdict` è pura per
 * la stessa ragione per cui lo sono `ghostVerdict`, `initWriteVerdict` e
 * `corpusOnlyTwinVerdict`: è ciò che la rende verificabile offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initAttestVerdict } from '../../scripts/ci/loop-drift-check.mjs';

const SITE_PATH = 'scripts/lib/control-char-publish-gate.mjs';
const ok = {
  siteBaseline: 'a1b2c3d4e5f60718',
  sitePath: SITE_PATH,
  repo: 'valerielinc-ops/frontaliere-si-o-no',
  defaultRepo: 'valerielinc-ops/frontaliere-si-o-no',
  siteRef: 'main',
  defaultRef: 'main',
  inventoryPaths: [SITE_PATH],
  checked: true,
};

test('attestata: i byte scaricati sono il blob che l’albero dichiara a quel path', () => {
  assert.deepEqual(initAttestVerdict(ok), { blocked: false, why: '' });
});

test('un blob che l’albero non ha a quel path e’ un rifiuto, non un warning', () => {
  // La raw dalla cache: byte reali, hash valido, e nessun path del sito che li
  // porti. E' il caso che oggi diventava «la verita' del giorno».
  const v = initAttestVerdict({ ...ok, inventoryPaths: [] });
  assert.equal(v.blocked, true);
  assert.match(v.why, /cache|ref si e' mosso|ghost-baseline/);
});

test('lo stesso blob a un path DIVERSO non attesta questa voce', () => {
  const v = initAttestVerdict({ ...ok, inventoryPaths: ['scripts/lib/altro.mjs'] });
  assert.equal(v.blocked, true);
  assert.match(v.why, /scripts\/lib\/altro\.mjs/);
});

test('`SITE_REF` diverso dal ref canonico blocca prima ancora di guardare l’inventario', () => {
  // L'inventario e' coerente — ma e' l'albero di UN ALTRO ref, quindi coerente
  // con se stesso e irrilevante per il lato che il drift check guarda.
  const v = initAttestVerdict({ ...ok, siteRef: 'feat/qualcosa' });
  assert.equal(v.blocked, true);
  assert.match(v.why, /SITE_REF/);
  assert.match(v.why, /feat\/qualcosa/);
});

test('inventario non disponibile: si RIFIUTA, non si registra sulla parola della CDN', () => {
  // Fail-open qui significherebbe che basta un rate-limit anonimo per tornare
  // al comportamento di prima: e' una baseline che si sta SCRIVENDO, non un
  // verdetto su una gia' scritta.
  const v = initAttestVerdict({ ...ok, inventoryPaths: null });
  assert.equal(v.blocked, true);
  assert.match(v.why, /GH_TOKEN|--no-provenance/);
});

test('niente lato sito da attestare (`corpus-only`, file assente la’) → passa', () => {
  // `siteBaseline` null non e' una baseline non verificata: e' l'assenza di una
  // baseline. Bloccarla renderebbe impossibile registrare una `corpus-only`.
  assert.equal(initAttestVerdict({ ...ok, siteBaseline: null, inventoryPaths: null }).blocked, false);
  assert.equal(initAttestVerdict({ ...ok, siteBaseline: null, siteRef: 'altro' }).blocked, false);
});

test('`--no-provenance` non attesta: nessun verdetto, per nessun caso', () => {
  // L'unica uscita dichiarata. Non finge di verificare, dice che non verifica.
  for (const patch of [{ inventoryPaths: [] }, { inventoryPaths: null }, { siteRef: 'altro' }]) {
    assert.equal(initAttestVerdict({ ...ok, ...patch, checked: false }).blocked, false);
  }
});

test('il why nomina sempre il path atteso o la via d’uscita: un rifiuto muto non e’ azionabile', () => {
  for (const patch of [{ inventoryPaths: [] }, { inventoryPaths: null }, { siteRef: 'altro' }]) {
    const v = initAttestVerdict({ ...ok, ...patch });
    assert.equal(v.blocked, true);
    assert.ok(v.why.length > 40, `why troppo corto: ${v.why}`);
  }
});

test('un repo del sito non canonico non attesta una baseline', () => {
  const v = initAttestVerdict({ ...ok, repo: 'fork/frontaliere-si-o-no' });
  assert.equal(v.blocked, true);
  assert.match(v.why, /SITE_REPO|canonico|fork\/frontaliere-si-o-no/);
});

test('un albero troncato ha un rifiuto esplicito e non si confonde con una rete assente', () => {
  const v = initAttestVerdict({ ...ok, inventoryPaths: null, inventoryStatus: 'truncated' });
  assert.equal(v.blocked, true);
  assert.match(v.why, /troncato|non ricorsivo/);
  assert.doesNotMatch(v.why, /rete, rate-limit anonimo, o albero troncato/);
});

test('un ref mosso durante la passata chiede di rilanciare', () => {
  const v = initAttestVerdict({ ...ok, inventoryPaths: [], inventoryStatus: 'ref-moved' });
  assert.equal(v.blocked, true);
  assert.match(v.why, /ref.*mosso|rilancia/i);
});

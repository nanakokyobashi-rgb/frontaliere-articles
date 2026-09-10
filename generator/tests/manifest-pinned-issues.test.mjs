/**
 * manifest-pinned-issues.test.mjs — il manifest tiene aperte certe issue, e
 * nessun auto-closer del ciclo puo' contraddirlo.
 *
 * ## La proprieta' sorvegliata
 *
 * Una voce `corpus-only-pending` dice «il gemello sul sito manca e dovrebbe
 * esserci», e il suo `trackingIssue` e' l'UNICO posto in cui quel lavoro resta
 * richiesto. Se quella issue si chiude, la voce continua a puntarla: resta
 * `corpus-only-pending` per sempre — «in lavorazione» su un lavoro che nessuno
 * sta piu' facendo — e il censimento di `loop-sync-manifest-scope.test.mjs` la
 * segnala rossa. E' la forma del punto cieco di `alert-pat-down.mjs` (#45).
 *
 * ## Perche' i test stanno insieme, e non uno per closer
 *
 * Il difetto non era in un closer: era che la domanda «questa issue e' pinnata?»
 * non veniva posta da NESSUNO. La regressione da impedire e' quindi la stessa
 * per tutti — un closer che smette di consultare la sorgente — e va vista in un
 * posto solo, dove si nota anche il closer nuovo che nessuno ha collegato.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifestPinnedIssues, pinnedBy, PINNING_MODES } from '../../scripts/ci/manifest-pinned-issues.mjs';
import { handoffDecision } from '../../scripts/ci/handoff-to-site.mjs';
import { decideReconcileAction } from '../../scripts/ci/reconcile-followups.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'scripts/ci/loop-sync-manifest.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const THIS_REPO = 'nanakokyobashi-rgb/frontaliere-articles';

test('ogni `corpus-only-pending` del manifest produce un pin, con il suo repo', () => {
  const pending = manifest.files.filter((f) => PINNING_MODES.has(f.mode));
  const pinned = manifestPinnedIssues(MANIFEST_PATH);
  assert.equal(pinned.size, pending.length, 'un pin per voce pending: nessuna voce persa per strada');
  for (const f of pending) {
    const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)$/.exec(f.trackingIssue);
    assert.ok(m, `${f.path}: trackingIssue malformato`);
    assert.equal(
      pinnedBy(Number(m[2]), m[1], pinned),
      f.path,
      `${f.path}: il pin non risale alla voce che lo ha prodotto — senza il path il closer ` +
        'scrive "non posso" senza causa.',
    );
  }
});

/**
 * La chiave porta il repo perche' un `trackingIssue` puo' puntare al SITO: un
 * closer che gira qui non deve rifiutarsi di chiudere la propria #N solo perche'
 * il numero coincide con una issue pinnata di la'. Oggi il manifest ha davvero
 * entrambi i casi, quindi la proprieta' e' osservabile e non ipotetica.
 */
test('il pin e\' per repo, non per numero nudo', () => {
  const pinned = manifestPinnedIssues(MANIFEST_PATH);
  const foreign = [...pinned.keys()].filter((k) => !k.startsWith(`${THIS_REPO}#`));
  assert.ok(foreign.length > 0, 'atteso almeno un trackingIssue che punta a un altro repo (oggi: il sito)');
  for (const key of foreign) {
    const n = Number(key.split('#')[1]);
    assert.equal(
      pinnedBy(n, THIS_REPO, pinned),
      null,
      `#${n} e' pinnata su ${key.split('#')[0]}, non qui: un numero nudo la bloccherebbe nel repo sbagliato.`,
    );
  }
});

test('senza repo, o su manifest illeggibile, non si pinna niente (direzione sicura)', () => {
  const pinned = manifestPinnedIssues(MANIFEST_PATH);
  assert.equal(pinnedBy(986, '', pinned), null, 'un numero senza repo non identifica una issue');
  assert.equal(pinnedBy(undefined, THIS_REPO, pinned), null);

  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pinned-')), 'broken.json');
  fs.writeFileSync(tmp, '{ non json');
  assert.equal(manifestPinnedIssues(tmp).size, 0, 'manifest illeggibile → nessun pin, cioe\' il comportamento di prima');
  assert.equal(manifestPinnedIssues(path.join(tmp, 'assente.json')).size, 0);
});

/**
 * Il caso misurato: `.github/workflows/issue-fix.yml` e' `adapted`, quindi
 * spedibile e non `stranded` — il ramo `blocked-*` tornava `close: true`. Su
 * #986 questo significa che il solo canale capace di far avanzare la issue era
 * anche quello che la chiudeva.
 */
test('handoff: una issue pinnata si consegna ma NON si chiude', () => {
  const body =
    'Il file da cambiare vive in valerielinc-ops/frontaliere-si-o-no: ' +
    '`.github/workflows/issue-fix.yml` ha ancora la copia in shell.';

  const free = handoffDecision({ verdict: 'blocked-admin-settings', body });
  assert.equal(free.handoff, true);
  assert.equal(free.close, true, 'senza pin il comportamento resta quello di prima: consegna e chiude');

  const pinnedEntry = 'scripts/ci/detect-aggregate.mjs';
  const held = handoffDecision({ verdict: 'blocked-admin-settings', body, pinnedEntry });
  assert.equal(held.handoff, true, 'la consegna resta: la fix si scrive comunque di la\'');
  assert.deepEqual(held.paths, free.paths, 'il pin non cambia COSA si spedisce, solo se si chiude qui');
  assert.equal(held.close, false);
  assert.deepEqual(
    held.residual,
    [pinnedEntry],
    'la promozione della voce a `identical` quando il gemello atterra e\' lavoro di questo repo: residuo.',
  );
});

/**
 * `redeliveryDecision` legge `residual` per decidere se un secondo giro ha
 * ancora qualcosa da fare qui. Un residuo vuoto corto-circuiterebbe la issue
 * pinnata — e con `close` a false la parcheggerebbe senza mai rientrare.
 */
test('handoff: il pin non produce un corto-circuito senza residuo', async () => {
  const { redeliveryDecision } = await import('../../scripts/ci/handoff-to-site.mjs');
  const body = 'valerielinc-ops/frontaliere-si-o-no: `.github/workflows/issue-fix.yml`';
  const held = handoffDecision({ verdict: 'blocked-admin-settings', body, pinnedEntry: 'scripts/ci/detect-aggregate.mjs' });
  const r = redeliveryDecision({ decision: held, deliveredUrl: 'https://github.com/x/y/issues/1' });
  assert.equal(r.skip, false, 'con un residuo il giro successivo deve poter ancora agire qui');
  assert.equal(r.close, false);
});

/**
 * Il pin entra in `reconcile-followups.mjs` per la porta che gia' esiste — le
 * label keep-open — perche' e' la stessa affermazione, letta dal manifest invece
 * che da un umano. Qui si inchioda che quella porta CHIUDE davvero l'auto-close
 * anche quando tutto il resto e' verde.
 */
test('reconcile: `blocked` batte ogni altra condizione di auto-close', () => {
  const green = {
    resolved: true, hasMaybeResolved: true, hasPriorFlag: true,
    isAggregate: false, noAutoclose: false, strongEvidence: true,
  };
  assert.equal(decideReconcileAction({ ...green, blocked: false }), 'close', 'baseline: senza blocchi chiude');
  assert.notEqual(
    decideReconcileAction({ ...green, blocked: true }),
    'close',
    'una issue pinnata dal manifest arriva qui come `blocked`: non deve mai chiudersi.',
  );
});

/**
 * Il censimento dei closer, e la riga che dice perche' i mirror-locked non sono
 * riparabili QUI.
 *
 * `scripts/ci/**` contiene i closer condivisi dal ciclo. I closer corpus-owned
 * interrogano il manifest; solo i file ancora `mode: identical` sono bloccati
 * dal mirror e devono ricevere la loro meta' del pin sul sito.
 *
 * Il guard e' quindi CONDIZIONATO AL MODE, letto dal manifest invece che da un
 * elenco ricopiato: un closer corpus-owned deve consultare i pin, un
 * mirror-locked no. Quando la fix del sito scendera' col mirror, il closer
 * inizierà a importare la sorgente e questo test continuera' a passare senza
 * modifiche — la condizione si adatta da sola, che e' il punto di leggerla dal
 * manifest.
 */
const MANIFEST_MODE = new Map(manifest.files.map((f) => [f.path, f.mode]));

/** La forma con cui questi script chiudono: `gh(['issue', 'close', ...])`. */
const CLOSES_RE = /\[\s*'issue',\s*'close'/;

/** Tutti i closer di `scripts/ci/`, scoperti — non elencati a mano. */
function discoverClosers() {
  const dir = path.join(ROOT, 'scripts/ci');
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.mjs')) continue;
    const rel = `scripts/ci/${name}`;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    if (CLOSES_RE.test(src)) out.push({ rel, src, mode: MANIFEST_MODE.get(rel) });
  }
  return out;
}

test('ogni closer corpus-owned consulta la sorgente dei pin', () => {
  const owned = discoverClosers().filter((c) => c.mode !== 'identical');
  assert.ok(owned.length > 0, 'nessun closer corpus-owned trovato: il rilevatore si e\' rotto in silenzio');
  for (const c of owned) {
    assert.match(
      c.src,
      /from '\.\/manifest-pinned-issues\.mjs'/,
      `${c.rel} (mode: ${c.mode}) chiude issue e NON consulta \`manifest-pinned-issues.mjs\`: ` +
        'puo\' chiudere il `trackingIssue` di una voce `corpus-only-pending`.',
    );
    assert.match(c.src, /pinnedBy\(/, `${c.rel} importa i pin ma non li interroga.`);
  }
});

/**
 * I closer che il mirror blocca, dichiarati per nome. L'elenco sta QUI e non nel
 * manifest per la stessa ragione di `REQUIRED_ROOTS`: e' il confine del guard, e
 * un confine che vive nel dato sorvegliato si sposta senza che si veda.
 *
 * Se uno di questi sparisce dall'elenco perche' non e' piu' `identical`, il test
 * sopra inizia a pretenderne il pin: e' esattamente la transizione voluta.
 */
test('i closer mirror-locked sono dichiarati, non dimenticati', () => {
  const EXPECTED_MIRROR_LOCKED = [
    'scripts/ci/harvest-agent-lessons.mjs',
  ];
  const actual = discoverClosers().filter((c) => c.mode === 'identical').map((c) => c.rel);
  assert.deepEqual(
    actual,
    EXPECTED_MIRROR_LOCKED,
    'l\'insieme dei closer bloccati dal mirror e\' cambiato. Un closer NUOVO che chiude issue ed e\' ' +
      '`identical` va portato sul sito, non riparato qui; uno che esce da `identical` va invece ' +
      'collegato ai pin. In entrambi i casi la riga si aggiorna qui, e in review si vede.',
  );
});

/**
 * Ogni closer scoperto ha una voce nel manifest. Senza, `c.mode` sarebbe
 * `undefined` e il file cadrebbe nel ramo "corpus-owned" per omissione invece
 * che per classificazione — un guard che passa per il motivo sbagliato.
 */
test('ogni closer e\' classificato dal manifest', () => {
  for (const c of discoverClosers()) {
    assert.ok(c.mode, `${c.rel}: closer senza voce di manifest — non classificabile.`);
  }
});

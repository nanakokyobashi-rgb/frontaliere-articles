/**
 * loop-manifest-corpus-only-twin.test.mjs — pinna l'invariante «una voce
 * `corpus-only` non deve avere un gemello IDENTICO sul sito».
 * Run with `node --test generator/tests/loop-manifest-corpus-only-twin.test.mjs`.
 *
 * ## Il punto cieco che chiude
 *
 * `classify()` esce sul ramo `corpus-only` alla PRIMA riga, senza mai
 * interrogare il sito. La dichiarazione «non esiste là» viene quindi creduta
 * per sempre: se un giorno smette di essere vera, nessuna classe se ne accorge.
 * Il file resta fuori da ogni sorveglianza proprio mentre i due lati sono già
 * gemelli — e una fix su un lato lascia l'altro rotto in silenzio, con la CI
 * verde da entrambe le parti.
 *
 * Misurato su `main` il 2026-08-14, su 62 voci `corpus-only`: DUE avevano già
 * un gemello byte-identico sul sito.
 *
 *   generator/scripts/lib/headline-selection-protocol.mjs  → scripts/lib/… (blob 6cfb5b1a)
 *   generator/scripts/lib/cross-section-dedup.mjs          → scripts/lib/… (blob d4798e7d)
 *
 * ## Perché il confronto è per CONTENUTO e non per path
 *
 * È la metà che discrimina davvero. Quei due file vivono a un path DIVERSO sui
 * due lati (`generator/scripts/lib/` qui, `scripts/lib/` sul sito): un
 * `siteHash(entry.path)` avrebbe risposto 404 e **confermato** la
 * classificazione sbagliata. Un guard costruito sull'uguaglianza dei path
 * sarebbe stato verde su entrambi i casi reali — cioè una guardia che non
 * guarda. Il git blob SHA è l'identità di contenuto indipendente dal path, e
 * l'albero del sito la espone già in una sola richiesta.
 *
 * È la stessa forma di `alert-pat-down.mjs` e di `SiteShellContract`: un legame
 * che non ha la forma che il guard sa seguire non è coperto dal guard.
 *
 * ## Cosa è testato qui, e cosa no
 *
 * Solo la parte PURA, `corpusOnlyTwinVerdict()`, con l'inventario del sito
 * INIETTATO — più i due fatti offline sul manifest committato. La metà che fa
 * rete (`siteBlobIndex()`, una `git/trees?recursive=1`) resta fuori per la
 * stessa ragione per cui `loop-drift-stranded-twin.test.mjs` e
 * `loop-drift-check-provenance.test.mjs` tengono fuori la loro: dipende
 * dall'API di GitHub, 60 richieste/ora per IP anonimo condivise fra i runner.
 * Un guard che dipende dalla rete non è un guard, è un flake.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusOnlyTwinVerdict, gitBlobSha } from '../../scripts/ci/loop-drift-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));

/** I due file reali della misura del 2026-08-14. */
const HEADLINE = 'generator/scripts/lib/headline-selection-protocol.mjs';
const DEDUP = 'generator/scripts/lib/cross-section-dedup.mjs';

const entryFor = (p) => MANIFEST.files.find((f) => f.path === p);

// ── 1. La funzione pura, sui due casi reali ────────────────────────────────

test('IL CASO: `corpus-only` con lo stesso contenuto sul sito a un path DIVERSO', () => {
  // Esattamente lo stato di `main` prima di questa PR: la voce diceva
  // `corpus-only`, e il sito aveva già il file byte-identico altrove.
  const blobSha = '6cfb5b1abf4d5f2e02a1cc9f18b7e6a55a42bbed';
  const v = corpusOnlyTwinVerdict({
    mode: 'corpus-only',
    blobSha,
    siteBlobIndex: new Map([[blobSha, ['scripts/lib/headline-selection-protocol.mjs']]]),
  });
  assert.equal(v.misclassified, true, 'il gemello identico sul sito deve essere DETTO');
  assert.deepEqual(v.sitePaths, ['scripts/lib/headline-selection-protocol.mjs']);
});

test("il path DIVERSO è il punto: un guard sull'uguaglianza dei path sarebbe verde", () => {
  // La prova che il confronto per contenuto vede ciò che un fetch su `path`
  // non vedrebbe. L'inventario non contiene NESSUN
  // `generator/scripts/lib/...`, eppure il verdetto scatta.
  const blobSha = 'd4798e7d7bbc205ecbcbf574357691a1b4692e8f';
  const index = new Map([[blobSha, ['scripts/lib/cross-section-dedup.mjs']]]);
  assert.equal([...index.values()].flat().some((p) => p === DEDUP), false, 'premessa del caso');
  assert.equal(corpusOnlyTwinVerdict({ mode: 'corpus-only', blobSha, siteBlobIndex: index }).misclassified, true);
});

test('un `corpus-only` che il sito davvero non ha resta silenzioso', () => {
  // Il caso maggioritario: 60 voci su 62 il 2026-08-14. Se questo si
  // accendesse, il report diventerebbe rumore e smetterebbe di essere letto.
  const v = corpusOnlyTwinVerdict({
    mode: 'corpus-only',
    blobSha: 'a'.repeat(40),
    siteBlobIndex: new Map([['b'.repeat(40), ['scripts/lib/altro.mjs']]]),
  });
  assert.equal(v.misclassified, false);
  assert.deepEqual(v.sitePaths, []);
});

test('solo `corpus-only`: nessun altro mode viene rivendicato', () => {
  // `identical`/`adapted` hanno già il confronto a tre vie, e
  // `corpus-only-pending` ha il suo stato `-landed`: segnalarli qui sarebbe
  // rumore su un lavoro già coperto.
  const blobSha = 'c'.repeat(40);
  const index = new Map([[blobSha, ['scripts/lib/x.mjs']]]);
  for (const mode of ['identical', 'adapted', 'corpus-only-pending', 'not-ported']) {
    assert.equal(
      corpusOnlyTwinVerdict({ mode, blobSha, siteBlobIndex: index }).misclassified,
      false,
      `${mode} non deve diventare corpus-only-twin`,
    );
  }
});

test('inventario mancante o file illeggibile → mai un verdetto (fail-open)', () => {
  // `siteBlobIndex()` restituisce null su rete giù o albero `truncated`: un
  // inventario a metà darebbe falsi NEGATIVI, e un dato mancante non deve mai
  // produrre un rosso. Stessa scelta di `ghostVerdict` e `strandedVerdict`.
  const sha = 'd'.repeat(40);
  assert.equal(corpusOnlyTwinVerdict({ mode: 'corpus-only', blobSha: sha, siteBlobIndex: null }).misclassified, false);
  for (const bad of [null, undefined, '']) {
    assert.equal(
      corpusOnlyTwinVerdict({ mode: 'corpus-only', blobSha: bad, siteBlobIndex: new Map([[sha, ['x']]]) }).misclassified,
      false,
      `blobSha=${JSON.stringify(bad)} non deve accendere il verdetto`,
    );
  }
});

test('`gitBlobSha` è davvero l\'identità git, non un hash qualunque', () => {
  // Senza questo, l'intero confronto sarebbe contro l'inventario sbagliato e
  // NESSUN caso si accenderebbe mai: il guard sarebbe verde per costruzione.
  // Valore noto: `git hash-object` di un file vuoto.
  assert.equal(gitBlobSha(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(gitBlobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

// ── 2. I due fatti offline sul manifest committato ─────────────────────────

test('le due voci della misura sono `identical`, con `sitePath` e baseline sui DUE lati', () => {
  for (const [p, site] of [
    [HEADLINE, 'scripts/lib/headline-selection-protocol.mjs'],
    [DEDUP, 'scripts/lib/cross-section-dedup.mjs'],
  ]) {
    const e = entryFor(p);
    assert.ok(e, `voce assente dal manifest: ${p}`);
    assert.equal(e.mode, 'identical', `${p}: tornata \`${e.mode}\` — il sito ha il gemello byte-identico`);
    assert.equal(e.sitePath, site, `${p}: senza \`sitePath\` il drift check cercherebbe \`${p}\` sul sito, che risponde 404`);
    assert.ok(e.baseline && e.baseline.site, `${p}: \`baseline.site\` nulla — un \`identical\` senza il lato sito non è confrontabile`);
    assert.equal(
      e.baseline.site,
      e.baseline.corpus,
      `${p}: baseline diverse sui due lati su un \`identical\` — sarebbe \`undeclared-drift\` al primo giro`,
    );
  }
});

test('il contenuto locale delle due voci combacia con la `baseline.corpus` registrata', () => {
  // Una baseline registrata su un contenuto diverso da quello committato
  // produrrebbe `corpus-ahead` al primo giro del cron: la riclassificazione
  // aprirebbe una issue di drift invece di chiudere un punto cieco. È
  // l'asserzione che rende «non nascono issue nuove» un fatto verificato e non
  // una promessa nel body della PR.
  const shortSha256 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
  for (const p of [HEADLINE, DEDUP]) {
    const e = entryFor(p);
    const abs = path.join(ROOT, p);
    assert.ok(fs.existsSync(abs), `${p}: dichiarato nel manifest ma assente dal repo`);
    assert.equal(
      shortSha256(fs.readFileSync(abs)),
      e.baseline.corpus,
      `${p}: \`baseline.corpus\` non è l'hash del file committato — al primo cron sarebbe \`corpus-ahead\`.`,
    );
  }
});

test('nessuna voce `corpus-only` porta un `sitePath`: sarebbe una classificazione contraddittoria', () => {
  // Il rovescio del guard: dichiarare DOVE sta il gemello e insieme che non
  // esiste. `loop-drift-check` non leggerebbe mai quel campo per questo mode,
  // quindi resterebbe un'affermazione muta — la forma esatta del difetto che
  // questa PR ripara.
  for (const f of MANIFEST.files) {
    if (f.mode !== 'corpus-only') continue;
    assert.equal(f.sitePath, undefined, `${f.path}: \`corpus-only\` con \`sitePath\` \`${f.sitePath}\``);
  }
});

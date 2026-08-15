/**
 * pr-body-filepath-check — i path che un body CITA devono esistere (#140).
 *
 * La fixture portante non e' inventata: e' il body REALE della PR #358
 * (`fixtures/pr-bodies/pr-358.md`, scaricato con `gh pr view 358 --json body`).
 * E' il caso che ha motivato il modulo, e serve a fissare il PRIMA e il DOPO:
 *
 *   PRIMA  `node scripts/lib/pr-body-nextstep-check.mjs --json "<quel body>"`
 *          → `ok: true`, zero violazioni. La forma era perfetta.
 *   DOPO   questo modulo trova le DUE citazioni che il reviewer ha trovato
 *          spendendo un ciclo di review.
 *
 * L'oracolo dell'esistenza e' INIETTATO in ogni test (`exists`): il test non
 * deve dipendere da com'e' fatto l'albero il giorno in cui gira, altrimenti
 * diventa rosso per una ragione che non c'entra col modulo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkCitedFilePaths,
  extractCitedPaths,
  candidatePath,
  DISLOCATIONS,
  KNOWN_ROOTS,
  ANNOTATIONS,
} from '../../scripts/lib/pr-body-filepath-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PR358 = fs.readFileSync(path.join(HERE, 'fixtures/pr-bodies/pr-358.md'), 'utf8');

/** I due path che il reviewer di #358 ha segnalato come inesistenti. */
const PHANTOM_358 = [
  'scripts/repair-blog-key-marker-corruption.mjs',
  'scripts/repair-unicode-escape-titles.mjs',
];

/**
 * L'albero come lo vedeva quella PR: tutto cio' che il body cita ESISTE, tranne
 * i due path fantasma. E' l'oracolo minimo che rende il test un test del MODULO
 * e non dell'albero.
 *
 * Assenti anche le loro DISLOCAZIONI: `scripts/X` risolve pure su
 * `generator/scripts/X`, quindi un oracolo che dicesse «esiste» a quel prefisso
 * assolverebbe i fantasmi da una porta di servizio — ed e' esattamente
 * l'errore che la prima stesura di questo test ha fatto.
 */
const ABSENT_358 = new Set([
  ...PHANTOM_358,
  ...PHANTOM_358.map((p) => p.replace(/^scripts\//, 'generator/scripts/')),
]);
const existsFor358 = (p) => !ABSENT_358.has(p);

// ---------------------------------------------------------------------------
// La fixture #358: il caso che il modulo esiste per trovare
// ---------------------------------------------------------------------------

test('#358: trova ESATTAMENTE i due path che il reviewer ha trovato a mano', () => {
  const res = checkCitedFilePaths(PR358, { exists: existsFor358 });
  assert.equal(res.ok, false, 'il body di #358 deve produrre segnalazioni');
  assert.deepEqual(res.violations.map((v) => v.path).sort(), [...PHANTOM_358].sort());
});

test('#358: il body citava molti path, e gli altri NON vengono segnalati', () => {
  const res = checkCitedFilePaths(PR358, { exists: existsFor358 });
  // Anti-vacuita': se il perimetro non pescasse niente, il test sopra sarebbe
  // verde per assenza invece che per correttezza.
  assert.ok(res.checked > 10, `attese >10 citazioni nel perimetro, trovate ${res.checked}`);
  assert.equal(res.violations.length, 2);
});

test('#358: il messaggio nomina il path e la remediation letterale', () => {
  const res = checkCitedFilePaths(PR358, { exists: existsFor358 });
  const m = res.violations[0].message;
  assert.match(m, /repair-/);
  assert.match(m, /\(sul sito\)/);
  assert.match(m, /\(nuovo\)/);
});

// ---------------------------------------------------------------------------
// Il caso verde, e le tre esenzioni
// ---------------------------------------------------------------------------

const withBody = (bullets) =>
  ['## Implementato', '', ...bullets, '', '## Non implementato (ancora)', '', '- Nessuno.'].join('\n');

test('verde: un body i cui path esistono tutti non produce niente', () => {
  const body = withBody([
    '- Toccato `scripts/ci/pr-body-contract.mjs` e `generator/tests/loop-references-exist.test.mjs`.',
    '- Aggiornata la voce in `scripts/ci/loop-sync-manifest.json`.',
  ]);
  const res = checkCitedFilePaths(body, { exists: () => true });
  assert.equal(res.ok, true);
  assert.equal(res.checked, 3, 'le tre citazioni devono essere state guardate davvero');
});

test('un path che la PR AGGIUNGE non e\' un finding: arriva da `extraExisting`', () => {
  const body = withBody(['- Nuovo modulo `scripts/lib/pr-body-filepath-check.mjs`.']);
  const nothingExists = () => false;
  assert.equal(checkCitedFilePaths(body, { exists: nothingExists }).ok, false);
  const res = checkCitedFilePaths(body, {
    exists: nothingExists,
    extraExisting: ['scripts/lib/pr-body-filepath-check.mjs'],
  });
  assert.equal(res.ok, true, 'i file toccati dalla PR contano come esistenti');
});

test('un path NUOVO dichiarato con un marcatore letterale non e\' un finding', () => {
  for (const marker of ['(nuovo)', '(esempio)', '(sul sito)', '(da creare)']) {
    const body = withBody([`- Arrivera' \`scripts/ci/non-esiste-ancora.mjs\` ${marker}, non ora.`]);
    const res = checkCitedFilePaths(body, { exists: () => false });
    assert.equal(res.ok, true, `${marker} doveva esentare`);
    assert.deepEqual(res.exempted, ['scripts/ci/non-esiste-ancora.mjs']);
  }
});

test('il marcatore vale anche PRIMA della citazione, e non oltre la finestra', () => {
  const near = withBody(['- (sul sito) `scripts/ci/mai-visto.mjs` fa il resto.']);
  assert.equal(checkCitedFilePaths(near, { exists: () => false }).ok, true);

  const far = withBody([
    `- (sul sito) ${'x'.repeat(120)} \`scripts/ci/mai-visto.mjs\` fa il resto.`,
  ]);
  assert.equal(
    checkCitedFilePaths(far, { exists: () => false }).ok,
    false,
    'un marcatore a 120 caratteri di distanza non sta dichiarando QUESTA citazione',
  );
});

test('basta annotarlo una volta: la seconda citazione dello stesso path non ritorna', () => {
  const body = withBody([
    '- `scripts/ci/mai-visto.mjs` (sul sito) e' + ' il riferimento.',
    '- Di nuovo `scripts/ci/mai-visto.mjs`, senza ripetere il marcatore.',
  ]);
  const res = checkCitedFilePaths(body, { exists: () => false });
  assert.equal(res.ok, true);
});

// ---------------------------------------------------------------------------
// La dislocazione `scripts/` → `generator/scripts/`
// ---------------------------------------------------------------------------

test('la dislocazione risolve il nome che il path ha SUL SITO', () => {
  const body = withBody(['- Il floor sta in `scripts/create-article.mjs`.']);
  const onlyHere = (p) => p === 'generator/scripts/create-article.mjs';
  assert.equal(checkCitedFilePaths(body, { exists: onlyHere }).ok, true);
  // e non e' un lasciapassare per qualunque cosa sotto `scripts/`
  const other = withBody(['- Il floor sta in `scripts/mai-esistito.mjs`.']);
  assert.equal(checkCitedFilePaths(other, { exists: onlyHere }).ok, false);
});

test('la dislocazione NON funziona al contrario (un path di qui non diventa uno del sito)', () => {
  const body = withBody(['- `generator/scripts/mai-esistito.mjs`.']);
  const onlySite = (p) => p === 'scripts/mai-esistito.mjs';
  assert.equal(checkCitedFilePaths(body, { exists: onlySite }).ok, false);
});

// ---------------------------------------------------------------------------
// Il perimetro: cio' che il modulo deve TACERE
// ---------------------------------------------------------------------------

test('fuori dai root noti non si guarda: i path del sito non entrano in lista', () => {
  for (const p of [
    'tests/packages-articles-confinement.test.ts',
    'build-plugins/shared/titleSuffix.ts',
    'packages/articles/engine/siteShell.ts',
    'src/components/Foo.tsx',
  ]) {
    assert.equal(candidatePath(p), null, `${p} non doveva entrare nel perimetro`);
  }
});

test('senza estensione non e\' un file: cartelle, comandi e nomi nudi tacciono', () => {
  for (const p of [
    'scripts/lib/',
    'scripts/ci',
    'generator/tests/prompt-placeholder-guard',
    'content/blog-body',
  ]) {
    assert.equal(candidatePath(p), null, `${p} non doveva entrare nel perimetro`);
  }
});

test('un template o un comando non e\' un path', () => {
  for (const p of [
    'scripts/ci/<nome>.mjs',
    'scripts/**/*.mjs',
    'content/blog-body/{locale}/x.ts',
    'node scripts/ci/pr-body-contract.mjs 358',
    'git ls-files',
  ]) {
    assert.equal(candidatePath(p), null, `${p} non doveva entrare nel perimetro`);
  }
});

test('i suffissi di posizione delle review non fanno parte del path', () => {
  assert.equal(
    candidatePath('generator/scripts/create-article.mjs:L6591'),
    'generator/scripts/create-article.mjs',
  );
  assert.equal(candidatePath('scripts/ci/pr-body-contract.mjs#L42'), 'scripts/ci/pr-body-contract.mjs');
  assert.equal(candidatePath('scripts/ci/pr-body-contract.mjs:120'), 'scripts/ci/pr-body-contract.mjs');
});

test('i blocchi recintati escono di scena — incluso il template che il gate stesso incolla', () => {
  const body = [
    '## Implementato',
    '',
    '- Vero lavoro su `scripts/ci/pr-body-contract.mjs`.',
    '',
    '```markdown',
    '## Non implementato (ancora)',
    '- vedi `scripts/ci/questo-non-esiste.mjs`',
    '```',
    '',
    '<!-- `scripts/ci/neanche-questo.mjs` -->',
    '',
    '## Non implementato (ancora)',
    '',
    '- Nessuno.',
  ].join('\n');
  const res = checkCitedFilePaths(body, { exists: (p) => p === 'scripts/ci/pr-body-contract.mjs' });
  assert.equal(res.ok, true);
  assert.equal(res.checked, 1, 'solo la citazione fuori dai blocchi doveva essere guardata');
});

test('un body senza citazioni non fa lavoro e non inventa violazioni', () => {
  const res = checkCitedFilePaths('## Implementato\n\n- Niente path.\n', { exists: () => false });
  assert.deepEqual(res, { ok: true, violations: [], checked: 0, exempted: [] });
});

// ---------------------------------------------------------------------------
// Le costanti sono un contratto, non decorazione
// ---------------------------------------------------------------------------

test('i root noti sono quelli di QUESTO repo e finiscono con /', () => {
  assert.ok(KNOWN_ROOTS.includes('generator/'));
  assert.ok(KNOWN_ROOTS.includes('host/'));
  assert.ok(!KNOWN_ROOTS.includes('tests/'), 'tests/ e\' del sito: allargarlo qui e\' rumore');
  for (const r of KNOWN_ROOTS) assert.match(r, /\/$/);
});

test('la dislocazione dichiarata e\' quella misurata: scripts/ → generator/scripts/', () => {
  assert.deepEqual([...DISLOCATIONS], [{ from: 'scripts/', to: 'generator/scripts/' }]);
});

test('l\'insieme dei marcatori e\' chiuso e non vuoto', () => {
  assert.ok(ANNOTATIONS.length >= 10);
  assert.ok(Object.isFrozen(ANNOTATIONS));
});

// ---------------------------------------------------------------------------
// La ragione per cui i marcatori sono LETTERALI e non prosa
// ---------------------------------------------------------------------------

test('la prosa «il sito ha…» NON esenta: e\' la frase esatta di #358', () => {
  // Se un giorno qualcuno sostituisse il marcatore letterale con un'euristica
  // sulla riga («se la frase nomina il sito, lascia stare»), questo test
  // diventa rosso — perche' il bullet di #358 nomina il sito, ed e' proprio il
  // caso per cui il modulo esiste.
  const body = withBody([
    "- il sito ha una famiglia di gemelli plausibili (`scripts/repair-unicode-escape-titles.mjs`) " +
      'che nessun mode mette in relazione con questo.',
  ]);
  const res = checkCitedFilePaths(body, { exists: () => false });
  assert.equal(res.ok, false, 'una euristica sulla prosa assolverebbe il caso #358');
  assert.equal(res.violations[0].path, 'scripts/repair-unicode-escape-titles.mjs');
});

test('extractCitedPaths riporta la posizione, cosi\' il messaggio si puo\' ancorare', () => {
  const body = withBody(['- `scripts/ci/x.mjs`']);
  const [c] = extractCitedPaths(body);
  assert.equal(c.path, 'scripts/ci/x.mjs');
  assert.ok(c.index > 0);
  assert.equal(c.annotated, false);
});

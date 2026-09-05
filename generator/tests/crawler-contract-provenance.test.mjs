/**
 * crawler-contract-provenance.test.mjs — i digest del contratto cross-repo
 * hanno un confronto, e un confronto che non è avvenuto non passa per verde.
 *
 * ## Cosa pinna, e perché non basta il verificatore stesso
 *
 * `scripts/ci/verify-crawler-contract-provenance.mjs` fa una domanda che ha
 * bisogno del sito («questi byte esistono davvero là?»), quindi vive in uno
 * schedule e non qui: un guard appeso ai 60 fetch/ora anonimi è un flake, e un
 * flake finisce spento. Ma la parte che decide COSA confrontare e COME leggere
 * il risultato è pura, e quella si tiene offline — è la parte in cui un
 * digest può sparire dal piano senza che nessuno se ne accorga.
 *
 * Le tre invarianti, una per item della issue #916:
 *
 *   1. il piano copre `generatorSha256` (mai confrontato con niente prima);
 *   2. il piano copre `sourceSha256` di OGNI artifact, che punta a file
 *      assenti da questo checkout — l'unico modo di verificarli è il sito;
 *   3. `artifactSha256` viene confrontato col `sitePath` del manifest, cioè
 *      con i byte serviti dal sito e non con quelli locali: è quell'osservazione
 *      a rendere reale la `baseline.site` che il contratto pretende uguale
 *      all'hash locale.
 *
 * E la regola che impedisce al guard di autoassolversi: una voce non osservata
 * NON è una voce verificata, e se non è stata osservata NESSUNA il verdetto
 * «tutto verde» non viene dato.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SITE_LOGIC_DIR,
  evaluateProvenance,
  planProvenanceChecks,
  siteGeneratorPath,
} from '../../scripts/ci/verify-crawler-contract-provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT = JSON.parse(
  readFileSync(path.join(ROOT, 'generator/data/crawler-cross-repo-contract.json'), 'utf8'),
);
const MANIFEST = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'),
);

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const fixtureManifest = {
  files: [
    { path: '.github/workflows/crawler-group-01.yml', sitePath: '.github/corpus-workflows/crawler-group-01.yml' },
  ],
};
const fixtureContract = {
  sourceRepository: 'valerielinc-ops/frontaliere-si-o-no',
  generatedBy: 'frontaliere-si-o-no/scripts/generate-crawler-group-workflows.mjs',
  generatorSha256: HASH,
  artifacts: [
    {
      file: 'crawler-group-01.yml',
      sourceLogic: 'crawler-group-01-logic.yml',
      sourceSha256: HASH,
      artifactSha256: HASH,
    },
  ],
};

test('`generatedBy` col solo nome del repo o con owner/repo dà lo stesso path', () => {
  assert.equal(
    siteGeneratorPath(fixtureContract),
    'scripts/generate-crawler-group-workflows.mjs',
  );
  assert.equal(
    siteGeneratorPath({
      sourceRepository: 'valerielinc-ops/frontaliere-si-o-no',
      generatedBy: 'valerielinc-ops/frontaliere-si-o-no/scripts/gen.mjs',
    }),
    'scripts/gen.mjs',
  );
  assert.throws(
    () => siteGeneratorPath({ sourceRepository: 'a/b', generatedBy: 'altro/scripts/gen.mjs' }),
    /non appartiene/,
  );
});

test('il piano copre generatore, sorgente e artifact di ogni voce', () => {
  const checks = planProvenanceChecks(fixtureContract, fixtureManifest);
  assert.deepEqual(
    checks.map((c) => [c.field, c.sitePath]),
    [
      ['generatorSha256', 'scripts/generate-crawler-group-workflows.mjs'],
      ['crawler-group-01.yml#sourceSha256', `${SITE_LOGIC_DIR}/crawler-group-01-logic.yml`],
      ['crawler-group-01.yml#artifactSha256', '.github/corpus-workflows/crawler-group-01.yml'],
    ],
  );
});

test('il piano reale copre i 49 digest del contratto committato', () => {
  const checks = planProvenanceChecks(CONTRACT, MANIFEST);
  assert.equal(checks.length, 1 + CONTRACT.artifacts.length * 2);
  assert.equal(checks.length, 49);
  // Nessun digest resta senza una coordinata sul sito: un `sitePath` null
  // sarebbe `undeclared`, cioè rosso, ma è meglio vederlo qui che allo
  // schedule del giorno dopo.
  assert.deepEqual(checks.filter((c) => !c.sitePath || !c.expected), []);
  for (const artifact of CONTRACT.artifacts) {
    assert.ok(
      checks.some((c) => c.field === `${artifact.file}#sourceSha256` && c.expected === artifact.sourceSha256),
      `${artifact.file}: sourceSha256 fuori dal confronto`,
    );
    const site = checks.find((c) => c.field === `${artifact.file}#artifactSha256`);
    assert.equal(site.sitePath, `.github/corpus-workflows/${artifact.file}`, artifact.file);
  }
  assert.ok(checks.some((c) => c.field === 'generatorSha256' && c.expected === CONTRACT.generatorSha256));
});

test('un artifact riordinato a mano, senza sorgente, è `undeclared` e rosso', () => {
  const checks = planProvenanceChecks(
    {
      ...fixtureContract,
      artifacts: [{ file: 'crawler-group-01.yml', artifactSha256: HASH }],
    },
    fixtureManifest,
  );
  const verdict = evaluateProvenance(checks, new Map([
    ['generatorSha256', { sha256: HASH }],
    ['crawler-group-01.yml#artifactSha256', { sha256: HASH }],
  ]));
  const source = verdict.results.find((r) => r.field.endsWith('#sourceSha256'));
  assert.equal(source.state, 'undeclared');
  assert.equal(verdict.red, true);
});

test('un generatore mosso sul sito diventa `drifted` e rosso', () => {
  const checks = planProvenanceChecks(fixtureContract, fixtureManifest);
  const verdict = evaluateProvenance(checks, new Map([
    ['generatorSha256', { sha256: OTHER }],
    ['crawler-group-01.yml#sourceSha256', { sha256: HASH }],
    ['crawler-group-01.yml#artifactSha256', { sha256: HASH }],
  ]));
  assert.equal(verdict.results[0].state, 'drifted');
  assert.match(verdict.results[0].detail, /il sito serve bbbbbbbbbbbbbbbb/);
  assert.equal(verdict.red, true);
});

test('un path del sito sparito è `absent`, non un verde per assenza di prove', () => {
  const checks = planProvenanceChecks(fixtureContract, fixtureManifest);
  const verdict = evaluateProvenance(checks, new Map([
    ['generatorSha256', { sha256: HASH }],
    ['crawler-group-01.yml#sourceSha256', { sha256: null }],
    ['crawler-group-01.yml#artifactSha256', { sha256: HASH }],
  ]));
  assert.equal(verdict.results[1].state, 'absent');
  assert.equal(verdict.red, true);
});

test('tutto verificato è verde, e il piano completo non lascia buchi', () => {
  const checks = planProvenanceChecks(fixtureContract, fixtureManifest);
  const verdict = evaluateProvenance(checks, new Map(checks.map((c) => [c.field, { sha256: HASH }])));
  assert.equal(verdict.red, false);
  assert.equal(verdict.counts.verified, 3);
  assert.equal(verdict.reason, null);
});

test('un errore di rete isolato non è rosso, ma se lo sono tutte il verdetto non si dà', () => {
  const checks = planProvenanceChecks(fixtureContract, fixtureManifest);
  const partial = evaluateProvenance(checks, new Map([
    ['generatorSha256', { error: 'HTTP 502' }],
    ['crawler-group-01.yml#sourceSha256', { sha256: HASH }],
    ['crawler-group-01.yml#artifactSha256', { sha256: HASH }],
  ]));
  assert.equal(partial.results[0].state, 'unobserved');
  assert.equal(partial.red, false, 'un 502 isolato non deve produrre un falso rosso');

  const blind = evaluateProvenance(checks, new Map(checks.map((c) => [c.field, { error: 'ENOTFOUND' }])));
  assert.equal(blind.red, true);
  assert.match(blind.reason, /non significa piu' niente/);
});

test('il manifest registra il verificatore: `scripts/ci` è un root censito', () => {
  const entry = MANIFEST.files.find(
    (f) => f.path === 'scripts/ci/verify-crawler-contract-provenance.mjs',
  );
  assert.ok(entry, 'verificatore non registrato in loop-sync-manifest.json');
  assert.equal(entry.mode, 'corpus-only');
});

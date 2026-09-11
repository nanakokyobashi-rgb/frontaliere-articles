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
  CRAWLER_COMMIT_RUNTIME_PATH,
  SITE_LOGIC_DIR,
  SITE_LOGIC_DIR_FALLBACKS,
  evaluateProvenance,
  evaluateRuntimeFlagChecks,
  isLogicSource,
  isRuntimeFlagSupported,
  planProvenanceChecks,
  planRuntimeFlagChecks,
  resolveSiteCandidate,
  siteGeneratorPath,
  siteLogicDirs,
} from '../../scripts/ci/verify-crawler-contract-provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT = JSON.parse(
  readFileSync(path.join(ROOT, 'generator/data/crawler-cross-repo-contract.json'), 'utf8'),
);
const MANIFEST = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'),
);
const PROVENANCE_SCRIPT = readFileSync(
  path.join(ROOT, 'scripts/ci/verify-crawler-contract-provenance.mjs'),
  'utf8',
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

test('#1264 — il piano runtime raccoglie ogni flag invocata dagli artifact', () => {
  const contract = { siteRuntimePaths: [CRAWLER_COMMIT_RUNTIME_PATH] };
  const artifacts = [
    {
      file: 'crawler-group-01.yml',
      text: 'run: bash scripts/lib/git-commit-data.sh --slice-only "slice"\n' +
        'run: bash scripts/lib/git-commit-data.sh --extra-only "extra"\n',
    },
    {
      file: 'crawler-group-02.yml',
      text: 'run: bash scripts/lib/git-commit-data.sh --group-batch "batch"\n',
    },
  ];
  const checks = planRuntimeFlagChecks(contract, artifacts);
  assert.deepEqual(
    checks.map((check) => check.flag),
    ['--extra-only', '--group-batch', '--slice-only'],
  );
  assert.equal(checks.every((check) => check.declared), true);
  assert.deepEqual(
    checks.find((check) => check.flag === '--slice-only').artifactFiles,
    ['crawler-group-01.yml'],
  );
});

test('#1264 — una flag runtime presente ma assente dal sorgente è rossa', () => {
  const source = Buffer.from(
    'if [ "' + '$' + '{1:-}" = "--extra-only" ]; then\n' +
    'elif [ "' + '$' + '{1:-}" = "--group-batch" ]; then\n',
  );
  const contract = { siteRuntimePaths: [CRAWLER_COMMIT_RUNTIME_PATH] };
  const artifacts = [{
    file: 'crawler-group-01.yml',
    text: 'run: bash scripts/lib/git-commit-data.sh --extra-only "extra"\n' +
      'run: bash scripts/lib/git-commit-data.sh --slice-only "slice"\n',
  }];
  const checks = planRuntimeFlagChecks(contract, artifacts);
  const observed = new Map(checks.map((check) => [
    check.field,
    { sha256: HASH, bytes: source },
  ]));
  const verdict = evaluateRuntimeFlagChecks(checks, observed);
  assert.equal(isRuntimeFlagSupported(source, '--extra-only'), true);
  assert.equal(isRuntimeFlagSupported(source, '--slice-only'), false);
  assert.equal(verdict.red, true);
  assert.equal(verdict.counts.verified, 1);
  assert.equal(verdict.counts.unrecognized, 1);
  assert.match(verdict.reason, /--slice-only/);
});

test('#1264 — un piano runtime vuoto è rosso quando il runtime è dichiarato', () => {
  const verdict = evaluateRuntimeFlagChecks([], new Map(), {
    runtimeDeclared: true,
  });
  assert.equal(verdict.red, true);
  assert.equal(verdict.counts.unobserved, 1);
  assert.match(verdict.reason, /nessuna invocazione runtime/);
});

test('#1264 — il dispatch bash accetta `==` e ignora gli esempi nei commenti', () => {
  const supported = Buffer.from(
    '# [[ "${1:-}" == "--slice-only" ]] è solo documentazione\n' +
    'if [[ "${1:-}" == "--slice-only" ]]; then\n',
  );
  const commented = Buffer.from(
    '# if [[ "${1:-}" == "--slice-only" ]]; then\n',
  );
  assert.equal(isRuntimeFlagSupported(supported, '--slice-only'), true);
  assert.equal(isRuntimeFlagSupported(commented, '--slice-only'), false);
});

test('#1264 — la provenienza runtime distingue 404, rete e path non dichiarato', () => {
  const contract = { siteRuntimePaths: [CRAWLER_COMMIT_RUNTIME_PATH] };
  const artifacts = [{
    file: 'crawler-group-01.yml',
    text: 'run: bash scripts/lib/git-commit-data.sh --extra-only "extra"\n',
  }];
  const [check] = planRuntimeFlagChecks(contract, artifacts);
  const absent = evaluateRuntimeFlagChecks(
    [check],
    new Map([[check.field, { sha256: null, bytes: null }]]),
  );
  assert.equal(absent.results[0].state, 'absent');
  assert.equal(absent.red, true);

  const unobserved = evaluateRuntimeFlagChecks(
    [check],
    new Map([[check.field, { error: 'HTTP 502' }]]),
  );
  assert.equal(unobserved.results[0].state, 'unobserved');
  assert.equal(unobserved.red, true);

  const undeclared = planRuntimeFlagChecks(
    { siteRuntimePaths: [] },
    artifacts,
  );
  const undeclaredVerdict = evaluateRuntimeFlagChecks(undeclared, new Map());
  assert.equal(undeclaredVerdict.results[0].state, 'undeclared');
  assert.equal(undeclaredVerdict.red, true);
});

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

test('la CLI contiene le rejection di rete e lascia l exit governato da `--strict`', () => {
  assert.match(
    PROVENANCE_SCRIPT,
    /main\(\)\.catch\(\(error\) =>/,
    'una rejection fuori dal ciclo di fetch uscirebbe ancora direttamente da Node',
  );
  assert.match(
    PROVENANCE_SCRIPT,
    /process\.exitCode = process\.argv\.includes\('--strict'\) \? 1 : 0/,
    'il fallback della CLI deve essere non-zero solo nel modo strict',
  );
});

test('il manifest registra il verificatore: `scripts/ci` è un root censito', () => {
  const entry = MANIFEST.files.find(
    (f) => f.path === 'scripts/ci/verify-crawler-contract-provenance.mjs',
  );
  assert.ok(entry, 'verificatore non registrato in loop-sync-manifest.json');
  assert.equal(entry.mode, 'corpus-only');
});

/**
 * ## La coordinata inventata (issue #982)
 *
 * `SITE_LOGIC_DIR` è l'unica coordinata che il contratto non dichiara: se il
 * sito sposta i `*-logic.yml`, il verificatore usciva rosso ogni notte con 24
 * `absent` e la diagnosi sbagliata («gli artifact sono stantii»). Le tre
 * invarianti che lo impediscono: la directory si risolve invece di essere
 * assunta, il report nomina il file davvero letto, e 24 assenze in blocco
 * accusano la coordinata, non il contratto.
 */
test('la directory della logica osservata si usa, e un override esplicito si crede', () => {
  const dirs = siteLogicDirs({});
  assert.deepEqual(dirs, [SITE_LOGIC_DIR, ...SITE_LOGIC_DIR_FALLBACKS]);
  assert.deepEqual(SITE_LOGIC_DIR_FALLBACKS, []);
  assert.deepEqual(dirs, ['.github/workflows']);
  // Un override è una dichiarazione: niente tentativi alle spalle di chi l'ha scritto.
  assert.deepEqual(siteLogicDirs({ SITE_LOGIC_DIR: '.github/logic/' }), ['.github/logic']);
});

test('il `sourceSha256` usa solo la directory osservata', () => {
  const checks = planProvenanceChecks(fixtureContract, fixtureManifest);
  const source = checks.find((c) => c.field.endsWith('#sourceSha256'));
  assert.deepEqual(
    source.sitePathCandidates,
    siteLogicDirs({}).map((d) => `${d}/crawler-group-01-logic.yml`),
  );
  assert.equal(source.sitePathCandidates.length, 1);
  for (const c of checks.filter((c) => !c.field.endsWith('#sourceSha256'))) {
    assert.deepEqual(c.sitePathCandidates, [c.sitePath], c.field);
  }
});

test('un source logic richiede la firma strutturale di un reusable workflow', () => {
  const valid = Buffer.from(
    '# Header cosmetico riscritto.\n' +
    'on:\n  workflow_call:\n' +
    'jobs:\n',
  );
  const quoted = Buffer.from(
    '"on":\n  "workflow_call": {}\n' +
    '"jobs":\n',
  );
  const inline = Buffer.from(
    'on: { workflow_call: {} }\n' +
    'jobs:\n',
  );
  const tabsAfterYamlKeys = Buffer.from(
    'on:\n  workflow_call:\t\n' +
    'jobs:\n',
  );
  const residual = Buffer.from('# Crawler Group 01 logic — artifact residuale.\n');
  assert.equal(isLogicSource(valid, 'crawler-group-01-logic.yml'), true);
  assert.equal(isLogicSource(quoted, 'crawler-group-01-logic.yml'), true);
  assert.equal(isLogicSource(inline, 'crawler-group-01-logic.yml'), true);
  assert.equal(isLogicSource(tabsAfterYamlKeys, 'crawler-group-01-logic.yml'), true);
  assert.equal(isLogicSource(residual, 'crawler-group-01-logic.yml'), false);
  assert.equal(isLogicSource(valid, 'crawler-group-02-logic.yml'), true);
  assert.equal(isLogicSource(valid, 'crawler-group-01.yml'), false);
});

test('un residuo omonimo non diventa `drifted`', async () => {
  const residual = Buffer.from('# Crawler Group 01 logic — artifact residuale.\n');
  const resolved = await resolveSiteCandidate(
    ['.github/corpus-workflows/crawler-group-01-logic.yml'],
    async () => ({ sha256: OTHER, bytes: residual }),
    'crawler-group-01-logic.yml',
  );
  assert.equal(resolved.sha256, null);
  assert.equal(resolved.invalidSource, true);
  assert.deepEqual(resolved.triedPaths, ['.github/corpus-workflows/crawler-group-01-logic.yml']);

  const valid = Buffer.from(
    '# Header cosmetico riscritto.\n' +
    'on:\n  workflow_call:\n' +
    'jobs:\n',
  );
  const alternateHit = await resolveSiteCandidate(
    ['.github/workflows/crawler-group-01-logic.yml', '.github/corpus-workflows/crawler-group-01-logic.yml'],
    async (rel) => rel.startsWith('.github/workflows')
      ? { sha256: null }
      : { sha256: HASH, bytes: valid },
    'crawler-group-01-logic.yml',
  );
  assert.equal(alternateHit.sha256, HASH);
  assert.equal(alternateHit.sitePath, '.github/corpus-workflows/crawler-group-01-logic.yml');
});

test('un marker invalido resta visibile nel verdetto, senza accusare gli artifact', () => {
  const checks = planProvenanceChecks(CONTRACT, MANIFEST);
  const observed = new Map(checks.map((c) => [c.field, { sha256: c.expected }]));
  const victim = checks.find((c) => c.field.endsWith('#sourceSha256'));
  observed.set(victim.field, {
    sha256: null,
    invalidSource: true,
    triedPaths: victim.sitePathCandidates,
  });
  const verdict = evaluateProvenance(checks, observed);
  const source = verdict.results.find((r) => r.field === victim.field);
  assert.equal(source.state, 'unrecognized');
  assert.equal(source.invalidSource, true);
  assert.match(source.detail, /presente ma non riconosciuta/);
  assert.match(verdict.reason, /SITE_LOGIC_DIR/);
  assert.doesNotMatch(verdict.reason, /artifact qui sono stantii/);
});

test('un 404 definitivo più un errore di rete diventano `absent`', async () => {
  const resolved = await resolveSiteCandidate(
    ['.github/workflows/crawler-group-01-logic.yml', '.github/corpus-workflows/crawler-group-01-logic.yml'],
    async (rel) => rel.startsWith('.github/workflows')
      ? { sha256: null }
      : { error: 'HTTP 502' },
    'crawler-group-01-logic.yml',
  );
  assert.equal(resolved.sha256, null);
  assert.deepEqual(resolved.triedPaths, [
    '.github/workflows/crawler-group-01-logic.yml',
    '.github/corpus-workflows/crawler-group-01-logic.yml',
  ]);
});

test('tutte le candidate in errore di trasporto restano `unobserved`', async () => {
  const resolved = await resolveSiteCandidate(
    ['.github/workflows/crawler-group-01-logic.yml', '.github/corpus-workflows/crawler-group-01-logic.yml'],
    async () => ({ error: 'HTTP 503' }),
    'crawler-group-01-logic.yml',
  );
  assert.equal(resolved.sha256, undefined);
  assert.equal(resolved.error, 'HTTP 503');
  assert.equal(resolved.triedPaths.length, 2);
});

test('evaluateProvenance nomina il path osservato nel report', () => {
  const checks = planProvenanceChecks(fixtureContract, fixtureManifest);
  const elsewhere = '.github/corpus-workflows/crawler-group-01-logic.yml';
  const verdict = evaluateProvenance(checks, new Map([
    ['generatorSha256', { sha256: HASH }],
    ['crawler-group-01.yml#sourceSha256', { sha256: HASH, sitePath: elsewhere }],
    ['crawler-group-01.yml#artifactSha256', { sha256: HASH }],
  ]));
  assert.equal(verdict.red, false);
  const source = verdict.results.find((r) => r.field.endsWith('#sourceSha256'));
  assert.equal(source.state, 'verified');
  assert.equal(source.sitePath, elsewhere, 'il report deve nominare il file davvero letto');
});

test('24 `*-logic.yml` assenti in blocco accusano la coordinata, non gli artifact', () => {
  const checks = planProvenanceChecks(CONTRACT, MANIFEST);
  const observed = new Map(checks.map((c) => [
    c.field,
    c.field.endsWith('#sourceSha256')
      ? { sha256: null, triedPaths: c.sitePathCandidates }
      : { sha256: c.expected },
  ]));
  const verdict = evaluateProvenance(checks, observed);
  assert.equal(verdict.red, true);
  assert.match(verdict.reason, /SITE_LOGIC_DIR/);
  assert.match(verdict.reason, /gli artifact non c'entrano/);
  assert.doesNotMatch(verdict.reason, /stantii/, 'la diagnosi sbagliata manda il fixer sul file sbagliato');
  // E il dettaglio elenca tutto ciò che è stato provato, non solo la prima candidata.
  const source = verdict.results.find((r) => r.field.endsWith('#sourceSha256'));
  for (const cand of source.sitePathCandidates) assert.ok(source.detail.includes(cand), cand);
});

test('24 sorgenti presenti ma non riconosciute accusano la coordinata, non gli artifact', () => {
  const checks = planProvenanceChecks(CONTRACT, MANIFEST);
  const observed = new Map(checks.map((c) => [
    c.field,
    c.field.endsWith('#sourceSha256')
      ? { sha256: null, invalidSource: true, triedPaths: c.sitePathCandidates }
      : { sha256: c.expected },
  ]));
  const verdict = evaluateProvenance(checks, observed);
  assert.equal(verdict.red, true);
  assert.match(verdict.reason, /SITE_LOGIC_DIR/);
  assert.match(verdict.reason, /risposte non portano il marker/);
  assert.doesNotMatch(verdict.reason, /stantii/);
});

test('un solo `*-logic.yml` sparito resta un problema del contratto', () => {
  const checks = planProvenanceChecks(CONTRACT, MANIFEST);
  const observed = new Map(checks.map((c) => [c.field, { sha256: c.expected }]));
  const victim = checks.find((c) => c.field.endsWith('#sourceSha256'));
  observed.set(victim.field, { sha256: null, triedPaths: victim.sitePathCandidates });
  const verdict = evaluateProvenance(checks, observed);
  assert.equal(verdict.red, true);
  assert.match(verdict.reason, /stantii/);
  assert.doesNotMatch(verdict.reason, /SITE_LOGIC_DIR/);
});

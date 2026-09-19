/**
 * Fissa QUALE credenziale mergia la PR del mirror, su quale perimetro e con
 * quale verdetto required-check.
 * Run with `node --test`.
 *
 * Non è un test di stile: entrambe le cose che verifica falliscono in SILENZIO.
 *
 * 1. Il token. In Remote Config ci sono due PAT e non sono intercambiabili —
 *    `GITHUB_PAT` è un token integration senza Actions write (403 su dispatch,
 *    vedi l'intestazione di generate-article.yml), `GITHUB_PAT_NANAKO` è un PAT
 *    classico con scope `repo` + `workflow`. Peggio ancora sarebbe ricadere su
 *    `GITHUB_TOKEN`: un merge autenticato con quello NON fa scattare
 *    `publish-api.yml` (regola anti-ricorsione), quindi la PR risulterebbe
 *    mergiata e la superficie dati resterebbe vecchia. Nessuna CI diventerebbe
 *    rossa: si vedrebbe solo, settimane dopo, come pagine renderizzate da un
 *    engine che non è quello su main.
 *
 * 2. Il perimetro. `engine-lockstep-auto` è un branch che il mirror possiede in
 *    esclusiva e force-pusha; allargare il filtro a `--state open` senza `--head`
 *    farebbe auto-mergiare qualunque PR aperta di questo repo.
 * 3. Il check. Un output vuoto, non-array, senza il check principale o con uno
 *    stato non sicuro non è un verdetto: il lockstep deve restare fermo e
 *    riprovare. Gli opzionali `SKIPPED`/`NEUTRAL` restano esplicitamente leciti.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  allChecksDecision,
  requiredCheckDecision,
} from '../../scripts/ci/native-automerge-sweep-policy.mjs';
import { VITEST_CHECK_NAME } from '../../scripts/ci/lib/constants.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(here, '../../.github/workflows/auto-merge-engine-lockstep.yml');
const wf = readFileSync(WORKFLOW, 'utf8');

test('mergia con GITHUB_PAT_NANAKO, non con l\'altro PAT', () => {
  assert.match(wf, /GITHUB_PAT_NANAKO/, 'deve usare il PAT che ha Actions write');
  // `GITHUB_PAT` può comparire solo in prosa esplicativa, mai come valore usato.
  const righeAttive = wf
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  assert.ok(
    !/\$\{?GITHUB_PAT\}?[^_]/.test(righeAttive),
    'non deve consumare GITHUB_PAT: è un token integration senza Actions write',
  );
});

test('non ricade MAI su GITHUB_TOKEN per il merge', () => {
  // Asserisce sull'USO, non sulla menzione: il messaggio d'errore del workflow nomina
  // GITHUB_TOKEN in prosa per spiegare perché non lo usa, ed è giusto che lo faccia.
  // Quello che non deve esistere è un RIFERIMENTO alla variabile.
  assert.ok(
    !/\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/.test(wf),
    'non deve ricevere secrets.GITHUB_TOKEN',
  );
  assert.ok(
    !/\$\{?GITHUB_TOKEN\}?\b/.test(wf),
    'non deve leggere $GITHUB_TOKEN: un merge autenticato così non fa scattare publish-api.yml',
  );
  // E il caso "PAT assente" deve essere un errore esplicito, non un ripiego silenzioso.
  assert.match(
    wf,
    /GITHUB_PAT_NANAKO:-\}" \]; then[\s\S]{0,400}exit 1/,
    'senza il PAT deve fallire, non mergiare in un modo che non pubblica',
  );
});

test('è ristretto al branch che il mirror possiede', () => {
  assert.match(wf, /--head engine-lockstep-auto/,
    'senza --head l\'auto-merge prenderebbe qualunque PR aperta del repo');
});

test('usa --merge e non --squash, per non perdere la provenienza', () => {
  // Il commit del mirror porta il SHA del sito da cui l'engine è stato copiato:
  // è l'unico legame fra i due repo, e uno squash lo sostituirebbe col titolo.
  assert.match(wf, /gh pr merge "\$PR" --merge\b/);
  // Solo sulle righe attive: il commento sopra il comando cita --squash per dire
  // perché NON si usa, e asserire sul file intero lo scambierebbe per un uso.
  const attive = wf.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(!/--squash/.test(attive));
});

test('il lockstep legge tutti i check e resta fail-closed', () => {
  assert.match(wf, /gh pr checks "\$PR" --required --json name,state,bucket/);
  assert.match(wf, /gh pr checks "\$PR" --json name,state,bucket/);
  assert.match(wf, /native-automerge-sweep-policy\.mjs/);
  assert.match(wf, /--required-check "\$REQUIRED_CHECKS_FILE"/);
  assert.match(wf, /--all-checks "\$CHECKS_FILE"/);
  assert.match(wf, /REQUIRED_CHECKS_EXIT=/);
  assert.match(wf, /CHECKS_EXIT=/);
  assert.match(wf, /--merge --delete-branch=false/);
});

test('il merge è vincolato alla HEAD catturata prima dei check', () => {
  const headCapture = wf.indexOf('HEAD_SHA=$(gh pr view "$PR" --json headRefOid');
  const checks = wf.indexOf('REQUIRED_CHECKS_FILE=', headCapture);
  const merge = wf.indexOf('gh pr merge "$PR" --merge --delete-branch=false');
  assert.ok(headCapture >= 0, 'deve catturare headRefOid prima della valutazione');
  assert.ok(checks > headCapture, 'i check devono seguire lo snapshot HEAD');
  assert.ok(merge > checks, 'il merge deve seguire entrambi i gate');
  assert.match(
    wf.slice(merge, merge + 180),
    /--match-head-commit "\$HEAD_SHA"/,
    'il merge deve rifiutare un force-push fra check e merge',
  );
  assert.match(wf, /HEAD_SHA.*\^\[0-9a-fA-F\]\{40\}/s,
    'HEAD non valida deve restare fail-closed');
});

const required = (state, overrides = {}) => ({
  name: VITEST_CHECK_NAME,
  state,
  bucket: state === 'SUCCESS' ? 'pass' : 'pending',
  ...overrides,
});

test('la decisione check è table-driven e richiede SUCCESS esplicito', () => {
  const cases = [
    ['SUCCESS', true],
    ['SKIPPED', false],
    ['NEUTRAL', false],
    ['EXPECTED', false],
    ['ACTION_REQUIRED', false],
    ['STALE', false],
    ['PENDING', false],
    ['QUEUED', false],
    ['IN_PROGRESS', false],
    ['FAILURE', false],
    ['ERROR', false],
    ['CANCELLED', false],
    ['UNKNOWN', false],
    ['', false],
  ];
  for (const [state, expected] of cases) {
    assert.equal(requiredCheckDecision([required(state)]).allow, expected, state || '<empty>');
  }
  assert.equal(requiredCheckDecision([required('success')]).allow, true, 'state case-insensitive');
  assert.equal(requiredCheckDecision([required('SUCCESS'), required('SUCCESS')]).allow, false, 'duplicate required ambiguo');
  assert.equal(requiredCheckDecision([
    required('SUCCESS'),
    { name: 'generator-ci', state: 'FAILURE', bucket: 'fail' },
  ]).allow, false, 'altro check rosso');
  assert.equal(requiredCheckDecision([
    required('SUCCESS'),
    { name: 'generator-ci', state: 'UNKNOWN', bucket: 'pending' },
  ]).allow, false, 'altro check sconosciuto');
  assert.equal(requiredCheckDecision([
    required('SUCCESS'),
    { name: 'generator-ci', state: 'SKIPPED', bucket: 'skipping' },
  ]).allow, false, 'required secondario saltato');
  assert.equal(requiredCheckDecision([
    required('SUCCESS'),
    { name: 'generator-ci', state: 'NEUTRAL', bucket: 'pass' },
  ]).allow, false, 'required secondario neutrale');
  assert.equal(requiredCheckDecision([
    required('SUCCESS'),
    { name: 'generator-ci', state: 'SUCCESS', bucket: 'pass' },
  ]).allow, true, 'altri check verdi');
  const optionalCases = [
    ['SUCCESS', true],
    ['SKIPPED', true],
    ['NEUTRAL', true],
    ['EXPECTED', false],
    ['ACTION_REQUIRED', false],
    ['STALE', false],
    ['PENDING', false],
    ['QUEUED', false],
    ['IN_PROGRESS', false],
    ['FAILURE', false],
    ['ERROR', false],
    ['CANCELLED', false],
    ['UNKNOWN', false],
  ];
  for (const [state, expected] of optionalCases) {
    assert.equal(allChecksDecision([
      required('SUCCESS'),
      { name: 'optional-docs', state, bucket: state === 'SUCCESS' ? 'pass' : 'pending' },
    ]).allow, expected, `check opzionale ${state}`);
  }
});

test('payload vuoto, non-array o senza required check non autorizza il merge', () => {
  const cases = [
    ['empty', []],
    ['null', null],
    ['object', {}],
    ['required missing', [{ name: 'unrelated', state: 'SUCCESS', bucket: 'pass' }]],
    ['required malformed', [{ name: VITEST_CHECK_NAME }]],
  ];
  for (const [name, payload] of cases) {
    assert.equal(requiredCheckDecision(payload).allow, false, name);
    assert.equal(allChecksDecision(payload).allow, false, 'all checks: ' + name);
  }
});

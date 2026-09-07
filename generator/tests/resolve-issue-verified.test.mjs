/**
 * resolve-issue-verified.test.mjs — «ho provato a chiudere» non e' «e' chiusa».
 *
 * `scripts/lib/github-issue-creator.mjs --resolve` e' best-effort in tre strati
 * che si coprono a vicenda: `gh issue close` gira con `allowFailure: true`, il
 * ramo CLI fa `process.exit(0)` sempre, e il `null` di ritorno significa
 * insieme «non c'era niente da chiudere» e «la chiusura e' stata respinta». Un
 * rifiuto — permessi, rate-limit, 5xx — lasciava quindi la run VERDE con una
 * riga su stderr, senza ritentativo e senza annotazione, e l'issue aperta con
 * un elenco ormai falso (issue #1005).
 *
 * `scripts/ci/resolve-issue-verified.mjs` non guarda l'exit code del
 * chiuditore: guarda la POST-CONDIZIONE. Questi test coprono le tre decisioni
 * che rendono quella verifica onesta invece di cosmetica:
 *
 *   · uno stato NON LEGGIBILE conta come «ancora aperta», mai come «chiusa»;
 *   · il ritentativo esiste, ed e' UNO — un loop cieco su un rifiuto
 *     permanente costerebbe un commento a ogni giro;
 *   · con N duplicati sullo stesso titolo il budget basta a chiuderli tutti,
 *     perche' `resolveGithubIssue` ne chiude UNA per chiamata.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_ATTEMPTS,
  closeAndVerify,
  findOpenByExactTitle,
  issueState,
} from '../../scripts/ci/resolve-issue-verified.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Un `gh` finto: mappa argv-joined → output, `null` = comando fallito. */
function fakeGh(responses) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const key = args.join(' ');
    return Object.prototype.hasOwnProperty.call(responses, key) ? responses[key] : null;
  };
  run.calls = calls;
  return run;
}

const LIST = 'api --paginate repos/o/r/issues?state=open&per_page=100 --jq .[] | select(.pull_request | not) | "\\(.number)\\t\\(.title)"';

test('la query PRE distingue «nessuna candidata» da «non ho potuto guardare»', () => {
  // Il caso che rende il difetto originale invisibile: la stessa causa (token
  // scaduto, rate-limit) rompe la query E la chiusura. Con `[]` al posto di
  // `null` lo script uscirebbe 0 dichiarando «niente da chiudere» proprio
  // quando non sa niente.
  assert.equal(findOpenByExactTitle('X', fakeGh({}), 'o/r'), null, 'query fallita deve dare null, non una lista vuota');

  const empty = findOpenByExactTitle('X', fakeGh({ [LIST]: '' }), 'o/r');
  assert.deepEqual(empty, [], 'query riuscita e senza righe e una lista vuota, non un errore');
});

test('il match sul titolo e ESATTO, non un prefisso', () => {
  // La chiave di dedup e' il titolo intero: chiudere «needs-human: ... (bis)»
  // credendo di chiudere «needs-human: ...» sarebbe peggio di non chiudere.
  const out = findOpenByExactTitle(
    'digest',
    fakeGh({ [LIST]: '7\tdigest\n8\tdigest esteso\n9\tdigest' }),
    'o/r',
  );
  assert.deepEqual(out, [
    { number: 7, title: 'digest' },
    { number: 9, title: 'digest' },
  ]);
});

test('le PR non entrano mai fra le candidate', () => {
  // `select(.pull_request | not)` nel jq: l'endpoint `issues` elenca anche le
  // PR, e una PR con lo stesso titolo verrebbe chiusa al posto dell issue.
  const run = fakeGh({ [LIST]: '1\tdigest' });
  findOpenByExactTitle('digest', run, 'o/r');
  assert.match(run.calls[0].join(' '), /select\(\.pull_request \| not\)/);
});

test('lo stato si legge per NUMERO, non per ricerca', () => {
  // L'indice di `search/issues` e' in ritardo di secondi: su una chiusura
  // appena andata a buon fine direbbe «open», e il wrapper fabbricherebbe un
  // fallimento che non esiste. L'endpoint per numero e autoritativo.
  const run = fakeGh({ 'api repos/o/r/issues/42 --jq .state': 'closed' });
  assert.equal(issueState(42, run, 'o/r'), 'closed');
  assert.deepEqual(run.calls[0], ['api', 'repos/o/r/issues/42', '--jq', '.state']);
  assert.doesNotMatch(run.calls[0].join(' '), /search/);
});

test('uno stato non leggibile non e «chiusa»', () => {
  assert.equal(issueState(42, fakeGh({}), 'o/r'), null);
  assert.equal(issueState(42, fakeGh({ 'api repos/o/r/issues/42 --jq .state': 'boh' }), 'o/r'), null);
});

test('una chiusura riuscita al primo colpo non ritenta', () => {
  let attempts = 0;
  const out = closeAndVerify({
    candidates: [{ number: 7 }],
    attemptClose: () => { attempts++; },
    readState: () => 'closed',
  });
  assert.equal(attempts, 1);
  assert.deepEqual(out, { closed: [7], stillOpen: [], attempts: 1 });
});

test('un close respinto viene ritentato UNA volta, e la seconda riesce', () => {
  let attempts = 0;
  const out = closeAndVerify({
    candidates: [{ number: 7 }],
    attemptClose: () => { attempts++; },
    readState: () => (attempts >= 2 ? 'closed' : 'open'),
  });
  assert.equal(out.attempts, 2, `il ritentativo esiste (MAX_ATTEMPTS=${MAX_ATTEMPTS})`);
  assert.deepEqual(out.stillOpen, [], 'la seconda passata deve poter salvare la chiusura');
});

test('un rifiuto permanente esce con la issue ancora aperta, e senza loop', () => {
  // E' il caso che DEVE diventare visibile: il chiamante lo traduce in
  // `::error::` + exit non-zero. Il budget resta finito perche' un rifiuto
  // permanente (permessi) non guarisce ritentando, e ogni giro costa un
  // commento sull issue.
  let attempts = 0;
  const out = closeAndVerify({
    candidates: [{ number: 7 }],
    attemptClose: () => { attempts++; },
    readState: () => 'open',
  });
  assert.deepEqual(out.stillOpen, [7]);
  assert.equal(out.attempts, MAX_ATTEMPTS);
  assert.equal(attempts, MAX_ATTEMPTS);
});

test('uno stato illeggibile conta come ancora aperta, non come chiusa', () => {
  const out = closeAndVerify({
    candidates: [{ number: 7 }],
    attemptClose: () => {},
    readState: () => null,
  });
  assert.deepEqual(out.stillOpen, [7], 'sconosciuto non e chiuso: e la stessa asimmetria del guard sulle query');
});

test('con piu duplicati sullo stesso titolo il budget basta a chiuderli tutti', () => {
  // `resolveGithubIssue` chiude UNA issue per chiamata (ricerca il titolo da
  // se'): con un budget fisso a 2 il terzo duplicato resterebbe aperto e il
  // wrapper riporterebbe un guasto che non c'e'.
  const closedSet = new Set();
  let attempts = 0;
  const candidates = [{ number: 1 }, { number: 2 }, { number: 3 }];
  const out = closeAndVerify({
    candidates,
    attemptClose: () => {
      attempts++;
      const next = candidates.find((c) => !closedSet.has(c.number));
      if (next) closedSet.add(next.number);
    },
    readState: (n) => (closedSet.has(n) ? 'closed' : 'open'),
  });
  assert.deepEqual(out.stillOpen, []);
  assert.deepEqual(out.closed.sort(), [1, 2, 3]);
  assert.equal(attempts, 3);
});

test('il wrapper non modifica il chiuditore: lo importa e basta', () => {
  // `scripts/lib/github-issue-creator.mjs` e `identical` nel manifest: una fix
  // li si fa sul SITO e verrebbe sovrascritta al mirror successivo. Il posto
  // giusto e il CHIAMANTE, che sa se la chiusura era un obbligo o un no-op.
  const src = readFileSync(path.join(ROOT, 'scripts/ci/resolve-issue-verified.mjs'), 'utf8');
  assert.match(src, /import \{ resolveGithubIssue \} from '\.\.\/lib\/github-issue-creator\.mjs'/);

  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
  const creator = manifest.files.find((f) => f.path === 'scripts/lib/github-issue-creator.mjs');
  assert.ok(creator, 'il chiuditore deve restare censito nel manifest');
  assert.equal(creator.mode, 'identical', 'se smettesse di essere `identical` questa scelta andrebbe rivista, non cancellata');

  const self = manifest.files.find((f) => f.path === 'scripts/ci/resolve-issue-verified.mjs');
  assert.ok(self, '`scripts/ci` e un albero censito: il wrapper deve avere una voce di manifest');
  assert.equal(self.mode, 'corpus-only');
});

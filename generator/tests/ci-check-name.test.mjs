/**
 * ci-check-name.test.mjs — il guard che impedisce alla coda delle PR di
 * fermarsi in silenzio.
 *
 * `auto-merge-eval.mjs` mergia solo quando il check-run chiamato
 * `VITEST_CHECK_NAME` conclude `success`, e `pr-autorebase.mjs` usa lo stesso
 * nome per riconoscere gli head "orfani" da ri-dispatchare. Quel nome vive in
 * due posti che non possono importarsi a vicenda: una const JS
 * (`scripts/ci/lib/constants.mjs`) e il `name:` di un job YAML
 * (`.github/workflows/tests.yml`).
 *
 * Se i due si separano non esplode niente. La query dei check-run torna
 * semplicemente lista vuota, il gate legge conclusion `''`, lo interpreta come
 * "test non ancora finiti" e **non mergia mai più nulla** — senza un errore, un
 * log rosso o una notifica. È lo stesso modo di rompersi che questo repo ha già
 * conosciuto: una PR con tutti i check verdi rimasta ferma 9 ore.
 *
 * Il rename di un job è esattamente il tipo di modifica che sembra innocua, e
 * questo test è l'unica cosa che la lega alla const.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/tests.yml');

/**
 * Estrae il `name:` del job `tests` senza un parser YAML (il repo non ha
 * dipendenze per le gate, di proposito). Cerca la chiave `tests:` sotto `jobs:`
 * e il primo `name:` che la segue prima del job successivo.
 */
function jobNameFromWorkflow(yaml) {
  const lines = yaml.split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.notEqual(jobsAt, -1, 'tests.yml non ha una sezione `jobs:`');
  const jobAt = lines.findIndex((l, i) => i > jobsAt && /^ {2}tests:\s*$/.test(l));
  assert.notEqual(jobAt, -1, 'tests.yml non ha un job `tests:`');
  for (let i = jobAt + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) break; // job successivo → basta
    const m = lines[i].match(/^ {4}name:\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^['"]|['"]$/g, '');
  }
  assert.fail('il job `tests` non dichiara un `name:` — il check-run prenderebbe il nome della chiave, e il gate cercherebbe un altro nome');
}

test('il nome del check-run in tests.yml combacia con VITEST_CHECK_NAME', async () => {
  // Import dinamico: la const legge process.env al momento del load, e il test
  // deve vedere il DEFAULT del repo, non un override ereditato dall'ambiente.
  delete process.env.CI_CHECK_NAME;
  const { VITEST_CHECK_NAME } = await import('../../scripts/ci/lib/constants.mjs');
  const fromYaml = jobNameFromWorkflow(fs.readFileSync(WORKFLOW, 'utf8'));

  assert.equal(
    VITEST_CHECK_NAME,
    fromYaml,
    `Il gate dell'auto-merge cerca il check-run "${VITEST_CHECK_NAME}" ma tests.yml ` +
      `pubblica "${fromYaml}". Nessuna PR mergerebbe piu', in silenzio. ` +
      `Allinea scripts/ci/lib/constants.mjs e .github/workflows/tests.yml.`,
  );
});

test('ogni CI_CHECK_NAME negli workflow combacia col nome del job', () => {
  // Il valore è ora ripetuto in piu' workflow (auto-merge, sweep, autorebase,
  // stale-pr-rescuer) perche' lo YAML non puo' importare una const. Ogni
  // ripetizione e' una sorgente di verita' in piu' che puo' divergere — e
  // divergere qui non rompe niente: la query dei check-run torna vuota, il
  // gate legge conclusion '' e la coda si ferma in silenzio.
  //
  // In `stale-pr-rescuer.yml` il valore finisce dentro una stringa jq, dove
  // nessun altro controllo lo guarderebbe mai.
  const wfDir = path.join(ROOT, '.github/workflows');
  const expected = jobNameFromWorkflow(fs.readFileSync(WORKFLOW, 'utf8'));
  const wrong = [];

  for (const f of fs.readdirSync(wfDir)) {
    if (!f.endsWith('.yml')) continue;
    const src = fs.readFileSync(path.join(wfDir, f), 'utf8');
    for (const m of src.matchAll(/^\s*CI_CHECK_NAME:\s*(.+?)\s*$/gm)) {
      const value = m[1].replace(/^['"]|['"]$/g, '');
      if (value !== expected) wrong.push(`${f}: "${value}"`);
    }
  }

  assert.deepEqual(
    wrong,
    [],
    `Questi workflow dichiarano un CI_CHECK_NAME diverso dal job in tests.yml ("${expected}"). ` +
      `Il gate cercherebbe un check che non esiste e nessuna PR mergerebbe, senza errori:\n  ${wrong.join('\n  ')}`,
  );
});

test('CI_CHECK_NAME resta sovrascrivibile da env', async () => {
  // L'override è ciò che permette al sito di adottare lo stesso file: il giorno
  // in cui lo fa, i due constants.mjs diventano identici e il drift va a zero.
  // Se qualcuno inlinea di nuovo la stringa, quella strada si chiude.
  const src = fs.readFileSync(path.join(ROOT, 'scripts/ci/lib/constants.mjs'), 'utf8');
  assert.match(
    src,
    /process\.env\.CI_CHECK_NAME\s*\|\|/,
    'VITEST_CHECK_NAME non legge piu\' process.env.CI_CHECK_NAME: i due repo non possono piu\' convergere sullo stesso file.',
  );
});

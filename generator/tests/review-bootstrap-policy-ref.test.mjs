/**
 * Il bootstrap del review gate legge i moduli dalla PUNTA di `main`, non da
 * `pull_request.base.sha`.
 *
 * ## Il difetto che chiude
 *
 * `base.sha` e' la fotografia di `main` al momento in cui la PR e' stata
 * aperta. Un modulo che il gate importa e che `main` ha aggiunto DOPO quella
 * fotografia li' non esiste: `curl` risponde 404, il job muore, e il rosso si
 * presenta come «Fail when required review gate is skipped» — cioe' come gate
 * saltato, non come modulo mancante. Ogni PR aperta prima di quel commit va
 * rossa INDIPENDENTEMENTE dal suo diff.
 *
 * Misurato sulla #1599: mancava `scripts/lib/pr-body-contract-eval.mjs`,
 * aggiunto a `main` da #1613. Non e' un caso isolato: il grafo del gate
 * cresce (#1629 gli ha aggiunto quattro moduli), quindi ogni crescita
 * riapre il difetto su tutte le PR in volo.
 *
 * ## Perche' i test ESEGUONO lo script
 *
 * Un grep su «non c'e' piu' `PR_BASE_SHA` nell'URL» sarebbe soddisfatto da
 * dieci modi di riscrivere il blocco, alcuni sbagliati — per esempio un
 * fallback silenzioso su `base.sha` quando `git ls-remote` fallisce, che
 * farebbe riapparire il difetto solo quando la rete e' lenta. Qui il blocco
 * viene ESTRATTO dallo YAML ed ESEGUITO con `git`, `curl` e `gh` finti, e si
 * osserva quale ref ha davvero usato.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = '.github/workflows/tests.yml';
const BASE_SHA = 'b'.repeat(40);   // main com'era quando la PR e' stata aperta
const TIP_SHA = 'a'.repeat(40);    // main adesso: ha il modulo nuovo

/** Il `run:` dello step di bootstrap, de-indentato e pronto per bash. */
function bootstrapScript() {
  const text = fs.readFileSync(path.join(ROOT, WORKFLOW), 'utf8');
  const stepAt = text.indexOf('- name: Bootstrap trusted review gate from main');
  assert.notEqual(stepAt, -1, `${WORKFLOW}: step di bootstrap non trovato`);
  const runAt = text.indexOf('        run: |', stepAt);
  assert.notEqual(runAt, -1, `${WORKFLOW}: blocco run dello step non trovato`);
  const body = text.slice(text.indexOf('\n', runAt) + 1);
  const lines = [];
  for (const line of body.split('\n')) {
    if (line.trim() === '') { lines.push(''); continue; }
    if (!line.startsWith('          ')) break;
    lines.push(line.slice(10));
  }
  return lines.join('\n');
}

/**
 * Esegue il blocco con binari finti. `curl` serve SOLO i file che esistono
 * sulla punta; il ref richiesto finisce in un log, che e' l'osservazione.
 */
const FAKE_MANIFEST = {
  entrypoint: 'scripts/ci/review-gate.mjs',
  modules: [
    'scripts/ci/review-gate.mjs',
    'scripts/ci/lib/constants.mjs',
    'scripts/lib/pr-body-contract-eval.mjs',
  ],
};

function runBootstrap({ tipSha = TIP_SHA, baseSha = BASE_SHA, servedSha = null, manifest = FAKE_MANIFEST, missingModule = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-bootstrap-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'urls.log');

  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
if [ "$1" = "ls-remote" ]; then printf '%s\\trefs/heads/main\\n' "${tipSha}"; exit 0; fi
exit 0
`, { mode: 0o755 });

  // `gh` non deve servire: il base ref arriva dall'env. Se lo invoca, lo si vede.
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
echo "GH_CALLED $*" >> ${JSON.stringify(log)}
echo main
exit 0
`, { mode: 0o755 });

  // curl finto: registra l'URL, e serve un corpo valido solo se il ref e' la
  // punta. Con `presentOnTipOnly`, un ref diverso riceve 404 — cioe' il caso
  // «modulo aggiunto a main dopo l'apertura della PR».
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args[args.length - 1];
fs.appendFileSync(${JSON.stringify(log)}, 'URL ' + url + '\\n');
const out = args[args.indexOf('--output') + 1];
const served = ${JSON.stringify(servedSha ?? tipSha)};
const missing = ${JSON.stringify(missingModule)};
const present = url.includes(served) && !(missing && url.endsWith('/' + missing));
if (present) {
  // Il manifest e' cio' che il bootstrap legge PRIMA dei moduli: e' lui a
  // dire quali scaricare, e viene dallo stesso ref pinnato.
  const body = url.endsWith('.json')
    ? ${JSON.stringify(JSON.stringify(manifest))}
    : 'export const ok = 1;\\n';
  fs.writeFileSync(out, body);
  process.stdout.write('200');
  process.exit(0);
}
process.stdout.write('404');
process.stderr.write('curl: (22) The requested URL returned error: 404\\n');
process.exit(22);
`, { mode: 0o755 });

  const script = [
    'set -euo pipefail',
    `export PATH=${JSON.stringify(bin)}:$PATH`,
    `export REPO=owner/repo PR_NUMBER=1 PR_BASE_REF=main PR_BASE_SHA=${baseSha}`,
    `export RUNNER_TEMP=${JSON.stringify(path.join(dir, 'runner'))}`,
    `export GITHUB_ENV=${JSON.stringify(path.join(dir, 'github_env'))}`,
    `mkdir -p "$RUNNER_TEMP"; : > "$GITHUB_ENV"`,
    bootstrapScript(),
  ].join('\n');

  let status = 0;
  let output = '';
  try {
    output = execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout || ''}${error.stderr || ''}`;
  }
  const urls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { status, output, urls };
}

test('i moduli si scaricano dalla PUNTA di main, non da base.sha', () => {
  const { status, output, urls } = runBootstrap();
  assert.equal(status, 0, `il bootstrap doveva riuscire:\n${output}`);
  const requested = urls.split('\n').filter((line) => line.startsWith('URL '));
  // Il manifest PRIMA, poi esattamente i moduli che elenca: la lista non la
  // dice piu' lo YAML della PR.
  assert.equal(requested.length, FAKE_MANIFEST.modules.length + 1,
    `richieste attese: il manifest piu' i suoi moduli (${requested.length})`);
  assert.ok(requested[0].endsWith('scripts/ci/review-gate-bootstrap-manifest.json'),
    'il manifest deve essere la PRIMA cosa letta dal ref trusted');
  for (const line of requested) {
    assert.ok(line.includes(TIP_SHA),
      `un modulo e' stato chiesto a un ref diverso dalla punta di main: ${line}`);
    assert.ok(!line.includes(BASE_SHA),
      `un modulo e' stato chiesto a base.sha — e' il difetto della #1599: ${line}`);
  }
});

test('il caso della #1599: base.sha vecchio, modulo aggiunto a main dopo', () => {
  // Il curl finto serve SOLO la punta: il modulo non esiste sulla fotografia
  // di main da cui la PR e' nata. Col vecchio bootstrap, che chiedeva
  // `base.sha`, questo caso dava 404 su ogni PR aperta prima del commit che
  // ha aggiunto il modulo — indipendentemente dal suo diff.
  const { status, urls } = runBootstrap({ servedSha: TIP_SHA });
  assert.equal(status, 0,
    'una PR la cui base non contiene un modulo aggiunto dopo deve comunque poter girare');
  assert.ok(!urls.includes(BASE_SHA), 'nessuna richiesta deve essere andata a base.sha');
});

test('un modulo elencato ma assente nomina il file e il ref, non solo `curl: (22)`', () => {
  // E' il caso «modulo rinominato senza aggiornare la lista di bootstrap».
  // Il messaggio deve far partire la diagnosi dal modulo, non dal job.
  const notFound = runBootstrap({ missingModule: 'scripts/lib/pr-body-contract-eval.mjs' });
  assert.notEqual(notFound.status, 0, 'un 404 su un modulo deve fermare lo step');
  assert.match(notFound.output, new RegExp(`Modulo del review gate assente su main @ ${TIP_SHA}`, 'u'),
    'il messaggio non nomina il ref');
  assert.match(notFound.output, /scripts\/lib\/pr-body-contract-eval\.mjs/u,
    'il messaggio non nomina il file mancante');
});

test('un manifest assente o malformato ferma il gate dicendo che e\' il manifest', () => {
  const absent = runBootstrap({ servedSha: 'deadbeef' });
  assert.notEqual(absent.status, 0);
  assert.match(absent.output, /Manifest di bootstrap del review gate non leggibile/u);

  // Il manifest arriva dalla rete: una voce che esce dalla directory isolata
  // non deve mai diventare un path.
  const traversal = runBootstrap({
    manifest: { entrypoint: 'scripts/ci/review-gate.mjs', modules: ['scripts/ci/review-gate.mjs', '../../etc/passwd'] },
  });
  assert.notEqual(traversal.status, 0, 'una voce con `..` deve essere rifiutata');
  assert.match(traversal.output, /Manifest di bootstrap del review gate non valido/u);
  assert.ok(!traversal.urls.includes('etc/passwd'), 'la voce non conforme non deve essere scaricata');

  const noEntry = runBootstrap({
    manifest: { entrypoint: 'scripts/ci/review-gate.mjs', modules: ['scripts/ci/lib/constants.mjs'] },
  });
  assert.notEqual(noEntry.status, 0, 'un manifest senza il suo entrypoint e\' incoerente');
});

test('il contenuto scaricato si valida per estensione, non sempre con node --check', () => {
  // Preparazione della PR concatenata: quando il bootstrap leggera' il
  // manifest dal ref pinnato, `node --check` su un `.json` fallirebbe SEMPRE
  // e il messaggio direbbe «download fallito (HTTP 200)», cioe' la cosa
  // sbagliata. Il guard sta qui perche' il difetto e' dello scaricatore, non
  // del manifest.
  const workflow = fs.readFileSync(path.join(ROOT, WORKFLOW), 'utf8');
  assert.match(workflow, /validate_download\(\) \{[\s\S]{0,300}\*\.json\)/u,
    'lo scaricatore non distingue un JSON da un modulo');
  assert.match(workflow, /validate_download "\$destination"/u,
    'lo scaricatore non usa la validazione per estensione');
});

test('senza una punta di main verificabile si fallisce, non si ricade su base.sha', () => {
  // Il fallback silenzioso e' il modo in cui questo difetto tornerebbe: rosso
  // solo quando la rete e' lenta, cioe' invisibile finche' non e' urgente.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-bootstrap-fail-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho main\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\necho 200\nexit 0\n', { mode: 0o755 });
  const script = [
    'set -euo pipefail',
    `export PATH=${JSON.stringify(bin)}:$PATH`,
    `export REPO=owner/repo PR_NUMBER=1 PR_BASE_REF=main PR_BASE_SHA=${BASE_SHA}`,
    `export RUNNER_TEMP=${JSON.stringify(path.join(dir, 'runner'))}`,
    `export GITHUB_ENV=${JSON.stringify(path.join(dir, 'env'))}`,
    'mkdir -p "$RUNNER_TEMP"; : > "$GITHUB_ENV"',
    bootstrapScript().replace(/sleep "\$\(\(attempt \* 5\)\)"/gu, 'true'),
  ].join('\n');
  let status = 0;
  let output = '';
  try {
    execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout || ''}${error.stderr || ''}`;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.notEqual(status, 0, 'senza punta di main il bootstrap deve fallire');
  assert.match(output, /Punta di main non risolvibile/u);
  assert.ok(!output.includes(BASE_SHA) || !/raw\.githubusercontent/u.test(output),
    'non si deve ricadere su base.sha');
});

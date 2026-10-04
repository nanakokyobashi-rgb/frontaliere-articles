/**
 * loop-health-report-workflow.test.mjs — il tracker «📊 Loop health report
 * (tracker)» di questo repo (issue 1644) deve avere un generatore.
 * Run with `node --test generator/tests/loop-health-report-workflow.test.mjs`.
 *
 * ## Il buco che chiude
 *
 * Il tracker e' stato aperto «per costruzione» (label `agent:no-age-out`, non
 * va chiuso) ma niente lo alimentava: un solo report in 52 commenti, postato a
 * mano il 2026-09-20, e `gh run list --workflow loop-health-report.yml` su
 * questo repo rispondeva 404. Lo script del sito era gia' portabile
 * (`GH_REPO`, revisore per repo), mancavano la copia qui e il cron.
 *
 * Se uno di questi pezzi sparisce, il tracker torna muto senza che nessun
 * check se ne accorga: per questo il contratto vive in un test e non solo nel
 * workflow.
 *
 * Titolo di fallimento: «Loop health: tracker del corpus dichiarato senza un
 * workflow che lo alimenta».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT_REL = 'scripts/ci/loop-health-report.mjs';
const WORKFLOW_REL = '.github/workflows/loop-health-report.yml';
const CORPUS_REPO = 'nanakokyobashi-rgb/frontaliere-articles';
const FAILURE = 'Loop health: tracker del corpus dichiarato senza un workflow che lo alimenta';

const read = (rel) => {
  const abs = path.join(ROOT, rel);
  assert.ok(fs.existsSync(abs), `${FAILURE}: manca ${rel}`);
  return fs.readFileSync(abs, 'utf8');
};

test('il workflow gira lo script del tracker a cron e su richiesta', () => {
  const workflow = read(WORKFLOW_REL);
  read(SCRIPT_REL);
  const schedule = /^[ \t]+schedule:[ \t]*\n((?:[ \t]*(?:#.*)?\n)*)[ \t]+-[ \t]*cron:[ \t]*'[^']+'/m;
  assert.match(workflow, schedule, `${FAILURE}: nessun cron`);
  assert.match(workflow, /^\s*workflow_dispatch:/m, 'serve il dispatch manuale per la prima prova');
  assert.match(
    workflow,
    /^\s*node scripts\/ci\/loop-health-report\.mjs\b/m,
    `${FAILURE}: il workflow non esegue ${SCRIPT_REL}`,
  );
});

test('il workflow usa solo il GITHUB_TOKEN di questo repo e misura il repo corrente', () => {
  const workflow = read(WORKFLOW_REL);
  const secrets = [...workflow.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(secrets.length > 0, 'GH_TOKEN deve arrivare da secrets.GITHUB_TOKEN');
  assert.deepEqual([...new Set(secrets)], ['GITHUB_TOKEN'], 'nessun token cross-repo o PAT');
  assert.match(workflow, /^\s*GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}\s*$/m);
  assert.match(workflow, /^\s*GH_REPO:\s*\$\{\{\s*github\.repository\s*\}\}\s*$/m);
  assert.doesNotMatch(workflow, /frontaliere-si-o-no/, 'il report del corpus non deve puntare al sito');
});

test('i permessi sono il minimo per leggere run e PR e commentare il tracker', () => {
  const workflow = read(WORKFLOW_REL);
  const block = /^permissions:\s*\n((?:[ \t]+.*\n|[ \t]*#.*\n|\s*\n)+)/m.exec(workflow);
  assert.ok(block, 'serve un blocco permissions esplicito a livello di workflow');
  const perms = Object.fromEntries(
    [...block[1].matchAll(/^[ \t]+([a-z-]+):\s*([a-z]+)\s*$/gm)].map((m) => [m[1], m[2]]),
  );
  assert.deepEqual(perms, {
    contents: 'read',
    issues: 'write',
    actions: 'read',
    'pull-requests': 'read',
  });
  assert.doesNotMatch(workflow, /^[ \t]+permissions:/m, 'nessun permesso aggiuntivo a livello di job');
});

test('ogni action del workflow e\' pinnata a uno SHA completo', () => {
  const workflow = read(WORKFLOW_REL);
  const uses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const ref of uses) {
    assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `action non pinnata per SHA: ${ref}`);
  }
});

test('lo script e\' un gemello `identical` del sito, quindi resta allineato dal drift check', () => {
  const manifest = JSON.parse(read('scripts/ci/loop-sync-manifest.json'));
  const entry = manifest.files.find((f) => f.path === SCRIPT_REL);
  assert.ok(entry, `${SCRIPT_REL} deve avere una voce nel manifest`);
  assert.equal(entry.mode, 'identical');
  assert.match(String(entry.baseline?.site), /^[0-9a-f]{16}$/);
  assert.equal(entry.baseline.corpus, entry.baseline.site, 'una voce identical nasce con i due lati uguali');
});

test('lo script gira senza npm ci: solo import di `node:*`', () => {
  // Il workflow non installa dipendenze, e un `identical` con un import
  // relativo dovrebbe portarsi dietro anche quel file.
  const source = read(SCRIPT_REL);
  const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gms)].map((m) => m[1]);
  assert.ok(specifiers.length > 0);
  for (const spec of specifiers) assert.match(spec, /^node:/, `import non builtin: ${spec}`);
  assert.doesNotMatch(source, /\bimport\(\s*['"](?!node:)/, 'nessun import dinamico non builtin');
});

test('lo script riconosce questo repo e misura workflow che qui esistono', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, SCRIPT_REL)).href);
  assert.equal(typeof mod.reviewBotFor, 'function');
  // Nel corpus il revisore pubblica come `github-actions` con il marcatore
  // d'ingresso: con la regola del sito ogni PR risulterebbe senza review.
  assert.ok(mod.reviewBotFor(CORPUS_REPO).login.test('github-actions[bot]'));

  const source = read(SCRIPT_REL);
  const list = /const AUTOMATION_WORKFLOWS = \[([^\]]*)\]/.exec(source);
  assert.ok(list, 'elenco AUTOMATION_WORKFLOWS non trovato nello script');
  const names = [...list[1].matchAll(/'([^']+\.ya?ml)'/g)].map((m) => m[1]);
  assert.ok(names.length > 0);
  for (const name of names) {
    assert.ok(
      fs.existsSync(path.join(ROOT, '.github/workflows', name)),
      `il report misura ${name}, che in questo repo non esiste: la riga sarebbe un errore ogni giorno`,
    );
  }
});

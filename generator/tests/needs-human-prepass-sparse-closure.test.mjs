/**
 * needs-human-prepass-sparse-closure.test.mjs — il checkout sparse del job
 * `prepass` copre la CHIUSURA TRANSITIVA degli import del pre-pass?
 *
 * ## Il difetto che chiude, riprodotto
 *
 * `needs-human-sweep.yml` fa un checkout sparse per non materializzare i 240 MB
 * di `content/`. Il job `prepass` dichiarava `/scripts/ci/` e basta — le
 * cartelle «ovvie» guardando gli import di primo livello. Ma
 * `scripts/ci/needs-human-prepass.mjs` importa
 * `close-recovered-failure-issues.mjs`, che importa
 * `scripts/lib/github-issue-creator.mjs`: FUORI dall'albero checkato.
 *
 * Gli import ESM sono STATICI — il grafo dei moduli si risolve prima che
 * `main()` esegua una sola riga — quindi non è un ramo che fallisce ogni tanto:
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find module
 *     '.../scripts/lib/github-issue-creator.mjs' imported from
 *     '.../scripts/ci/close-recovered-failure-issues.mjs'
 *
 * a OGNI invocazione — cron giornaliero, cron del lunedì e `workflow_dispatch`.
 * Cioè: la metà «zero-Claude, zero quota» che fa tutto il drenaggio non sarebbe
 * mai partita, e la sola prova sarebbe stata un job rosso in un workflow che
 * nessuno guarda finché le issue non si accumulano di nuovo.
 *
 * ## Perché serviva un test NUOVO, e perché quelli esistenti non bastavano
 *
 * `needs-human-prepass.test.mjs` importa lo stesso modulo e resta VERDE: gira su
 * un checkout completo, dove `scripts/lib/` c'è. Nessun test che *importa* il
 * pre-pass può vedere questo difetto — la condizione che lo produce è l'assenza
 * di file, non una logica sbagliata. Va confrontata la DICHIARAZIONE nel
 * workflow con la chiusura calcolata dal sorgente, che è ciò che fa questo file.
 *
 * È la stessa forma di `SiteShellContract` che CLAUDE.md indica come trappola: un
 * requisito reale che non ha forma di import controllabile a runtime, e che
 * quindi passa sotto CI verde.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = '.github/workflows/needs-human-sweep.yml';
const ENTRY = 'scripts/ci/needs-human-prepass.mjs';

/** Ogni specificatore relativo `from '...'`, import ed export riesportante. */
const REL_IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^'";]*from\s*['"](\.[^'"]+)['"]/g;

/**
 * La chiusura transitiva degli import RELATIVI a partire da `entry`, in path
 * relativi alla radice del repo. I builtin (`node:*`) e i pacchetti non
 * compaiono: non stanno nell'albero e non c'entrano con la sparsità.
 */
export function importClosure(entry, { root = ROOT } = {}) {
  const seen = new Set();
  const missing = [];
  const stack = [entry];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src;
    try {
      src = fs.readFileSync(path.join(root, rel), 'utf-8');
    } catch {
      missing.push(rel);
      continue;
    }
    for (const m of src.matchAll(REL_IMPORT_RE)) {
      stack.push(path.normalize(path.join(path.dirname(rel), m[1])));
    }
  }
  return { files: [...seen].sort(), missing };
}

/**
 * Le righe del blocco `sparse-checkout: |` del job indicato.
 *
 * Parsing a righe e non con un parser YAML di proposito: gli script del ciclo
 * sono zero-dep (`node --test`, `node:assert`) e aggiungere una dipendenza a un
 * gate che gira su ogni PR sarebbe il costo sbagliato da pagare.
 */
export function sparsePatternsFor(workflowText, jobName) {
  const jobRe = new RegExp(`\\n  ${jobName}:\\n`);
  const jm = jobRe.exec(workflowText);
  assert.ok(jm, `job \`${jobName}\` non trovato in ${WORKFLOW}`);
  // dal job in poi, fino al prossimo job di pari indentazione (2 spazi)
  const after = workflowText.slice(jm.index + jm[0].length);
  const end = /\n {2}[a-z0-9_-]+:\n/.exec(after);
  const jobBody = end ? after.slice(0, end.index) : after;

  const sm = /sparse-checkout:\s*\|\s*\n([\s\S]*?)(?=\n\s*[a-z-]+:)/.exec(jobBody);
  assert.ok(sm, `blocco \`sparse-checkout: |\` non trovato nel job \`${jobName}\``);
  return sm[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

test('il job `prepass` checkouta tutto ciò che il pre-pass importa', () => {
  const wf = fs.readFileSync(path.join(ROOT, WORKFLOW), 'utf-8');
  const patterns = sparsePatternsFor(wf, 'prepass');
  const { files, missing } = importClosure(ENTRY);

  assert.deepEqual(
    missing, [],
    'la chiusura degli import nomina file che non esistono nel repo:\n  ' + missing.join('\n  '),
  );

  // Ogni file della chiusura deve essere coperto da un pattern: la sua cartella
  // (`/scripts/lib/`) oppure il file stesso.
  const uncovered = files.filter((f) => !patterns.some(
    (p) => p === `/${f}` || (p.endsWith('/') && `/${f}`.startsWith(p)),
  ));

  assert.deepEqual(
    uncovered, [],
    'Questi file sono importati (anche in modo TRANSITIVO) dal pre-pass ma non\n'
    + `sono nel checkout sparse del job \`prepass\` in ${WORKFLOW}:\n  `
    + uncovered.join('\n  ')
    + '\n\nGli import ESM sono statici: il modulo non risolve e lo step muore con\n'
    + 'ERR_MODULE_NOT_FOUND a OGNI run, prima che main() esegua una riga.\n'
    + `Pattern dichiarati: ${JSON.stringify(patterns)}`,
  );
});

test('la chiusura contiene davvero il file fuori da /scripts/ci/ che ha causato il difetto', () => {
  // Guardia sulla GUARDIA: se un domani il pre-pass smettesse di importare
  // `close-recovered-failure-issues.mjs`, il test sopra resterebbe verde in modo
  // vacuo (chiusura piccola, tutto coperto) e non direbbe più niente. Questo
  // ancora il test al caso reale che lo ha motivato.
  const { files } = importClosure(ENTRY);
  assert.ok(
    files.includes('scripts/lib/github-issue-creator.mjs'),
    'la chiusura non passa piu\' per scripts/lib/github-issue-creator.mjs: '
    + 'se e\' voluto, aggiorna questo test; se non lo e\', il pre-pass ha perso un import.\n'
    + `chiusura: ${JSON.stringify(files)}`,
  );
  assert.ok(files.length >= 4, `chiusura sospettosamente corta: ${JSON.stringify(files)}`);
});

test('il parser del blocco sparse non legge righe di un altro job', () => {
  // `sweep` ha un suo `sparse-checkout` con `/*` e `!/content/`: se il parser
  // sconfinasse, `prepass` sembrerebbe coprire tutto e il test sopra non
  // fallirebbe mai.
  const wf = fs.readFileSync(path.join(ROOT, WORKFLOW), 'utf-8');
  const prepass = sparsePatternsFor(wf, 'prepass');
  assert.ok(!prepass.includes('/*'), `il parser ha sconfinato nel job sweep: ${JSON.stringify(prepass)}`);
  assert.ok(!prepass.some((p) => p.startsWith('!')), `pattern di negazione inattesi: ${JSON.stringify(prepass)}`);
  assert.ok(sparsePatternsFor(wf, 'sweep').includes('/*'), 'il job `sweep` dovrebbe dichiarare `/*`');
});

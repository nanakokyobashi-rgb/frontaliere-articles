/**
 * issue-workflow-concurrency-key.test.mjs — nessun workflow innescato da eventi
 * issue puo' serializzare su una chiave di concorrenza COSTANTE.
 *
 * ## Il modo silenzioso in cui questo si rompe
 *
 * `concurrency` e' valutata a livello di WORKFLOW, cioe' PRIMA dell'`if:` del
 * job. Con un `group:` costante ogni evento issue del repo entra nella stessa
 * coda — compresi quelli che l'`if:` avrebbe scartato come `skipped` — e con
 * `cancel-in-progress: false` GitHub tiene UNA sola run pending per gruppo: ogni
 * nuova pending SFRATTA (`cancelled`) la precedente. La profondita' e' 1, non N.
 *
 * Non esplode niente. La run sfrattata muore prima di eseguire uno step, non
 * lascia nessun commento `FIX_OUTCOME`, e poiche' `on: issues` e' one-shot
 * l'evento e' consumato: la label resta sulla issue e niente la ri-arma. Il
 * RESCUE del drainer la ritrova orfana e le addebita un `fu-attempt` — per una
 * run che non e' mai partita. Tre giri cosi' e la issue e' `fu-parked` senza che
 * un solo tentativo sia avvenuto.
 *
 * Misurato su questo repo il 2026-09-05, prima della fix:
 *  - `issue-fix` 09-04: 290 run, 73 `cancelled`, 50 `success`;
 *  - `issue-decompose` 09-04: 290 run, 67 `cancelled`, 6 `success`;
 *  - `issue-triage` 09-04: 32 run, 7 `cancelled`, 25 `success`.
 * Sul sito, dove il volume e' un ordine di grandezza sopra, la stessa causa ha
 * prodotto 88 issue parcheggiate senza un solo verdetto in 36 ore
 * (valerielinc-ops/frontaliere-si-o-no#7497).
 *
 * Il rename o lo spostamento di un `group:` e' esattamente il tipo di modifica
 * che sembra innocua: questo test e' l'unica cosa che lega quei tre file alla
 * regola.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_DIR = path.join(ROOT, '.github/workflows');

/**
 * Legge il `group:` del blocco `concurrency:` di un workflow.
 * Accetta il blocco top-level e quello a livello di job, salta i commenti, e
 * ancora `group:` a inizio riga: una nota `# group: ...` non deve decidere al
 * posto di quello vero.
 * @returns {string|null} il valore del gruppo, o `null` se non c'e' concurrency
 */
function concurrencyGroup(yaml) {
  const lines = yaml.split('\n');
  const indentOf = (l) => /^[ \t]*/.exec(l)[0].length;
  const isComment = (l) => /^\s*#/.test(l);
  const start = lines.findIndex((l) => /^\s*concurrency:/.test(l) && !isComment(l));
  if (start < 0) return null;
  const base = indentOf(lines[start]);
  for (let j = start + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (l.trim() === '') continue;
    if (indentOf(l) <= base) break;
    if (isComment(l)) continue;
    const m = /^\s*group:\s*(.+?)\s*$/.exec(l);
    if (m) return m[1];
  }
  return null;
}

/** Il workflow e' innescato da eventi `issues:`? */
function triggersOnIssues(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^on:/.test(l));
  if (start < 0) return false;
  for (let j = start + 1; j < lines.length; j += 1) {
    if (lines[j].trim() !== '' && !/^\s/.test(lines[j])) break;
    if (/^\s+issues:/.test(lines[j])) return true;
  }
  return false;
}

test('nessun workflow su eventi issue serializza su una chiave costante', () => {
  const offenders = [];
  for (const file of fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml'))) {
    const yaml = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    if (!triggersOnIssues(yaml)) continue;
    const group = concurrencyGroup(yaml);
    if (group === null) continue; // nessuna coda: niente da sfrattare
    if (!group.includes('${{')) offenders.push(`${file} → group: ${group}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `Chiave di concorrenza COSTANTE su un workflow innescato da eventi issue.\n${offenders.join('\n')}\n`
      + 'Con un gruppo costante ogni evento issue del repo entra nella stessa coda profonda 1 e '
      + 'sfratta la pending, anche quelli che l\'`if:` del job scarterebbe. Usa una chiave per-issue '
      + '(`${{ github.event.issue.number || ... }}`); il fallback dipende dai trigger di QUEL file — '
      + '`github.run_id` se l\'unico trigger e\' `issues`, una costante condivisa se ci sono anche '
      + '`schedule`/`workflow_dispatch`, che altrimenti girerebbero in parallelo con se stessi.',
  );
});

test('i tre workflow del ciclo sono coperti dal controllo, non solo teoricamente', () => {
  // Senza questo caso il test sopra resterebbe verde anche se qualcuno
  // rinominasse i file o togliesse loro il trigger `issues:` — cioe' passerebbe
  // per assenza di popolazione invece che per assenza di difetto.
  const covered = fs.readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml'))
    .filter((f) => triggersOnIssues(fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8')));
  for (const expected of ['issue-fix.yml', 'issue-decompose.yml', 'issue-triage.yml']) {
    assert.ok(covered.includes(expected), `${expected} non e' piu' riconosciuto come workflow su eventi issue`);
  }
});

test('il fallback del triage e\' una costante condivisa, non run_id', () => {
  // `issue-triage.yml` ha tre trigger e per `schedule`/`workflow_dispatch` non
  // c'e' nessuna issue nel payload. Con `github.run_id` ogni sweep avrebbe una
  // chiave propria e due sweep potrebbero girare insieme instradando la stessa
  // coda due volte: il verso giusto del fallback dipende dai trigger, e questa
  // e' la differenza che non va persa in un copia-incolla dagli altri due file.
  const yaml = fs.readFileSync(path.join(WORKFLOW_DIR, 'issue-triage.yml'), 'utf8');
  const group = concurrencyGroup(yaml);
  assert.match(group, /github\.event\.issue\.number/, 'la chiave del triage deve essere per-issue sugli eventi issue');
  assert.doesNotMatch(group, /github\.run_id/, 'con run_id due sweep potrebbero girare insieme');
});

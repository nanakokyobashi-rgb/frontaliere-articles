/**
 * issue-workflow-concurrency-key.test.mjs — ogni workflow innescato da eventi
 * issue deve serializzare su una chiave PER-ISSUE, cioe' che interpola
 * `github.event.issue.number`.
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
 *
 * ## Perche' la condizione e' "interpola l'issue" e non "interpola qualcosa"
 *
 * La prima versione del gate (#908) chiedeva solo che il `group:` contenesse
 * `${{`. Ma su un evento `issues:` quasi tutto il contesto e' costante: per
 * `issues:` `github.ref` e' SEMPRE il default branch, e `github.workflow` /
 * `github.repository` non cambiano mai. `issue-fix-${{ github.ref }}` sfratta
 * dunque esattamente come la costante letterale che il gate esiste per vietare,
 * e passava il controllo: la stessa regressione sarebbe tornata VERDE. Da qui
 * (#918) l'unica cosa che conta e' `github.event.issue.number`, e la regola sta
 * in `isPerIssueKey`, testata anche sui suoi controesempi.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_DIR = path.join(ROOT, '.github/workflows');

/**
 * L'UNICA espressione che rende la chiave davvero per-issue. Tenuta in una
 * costante sola perche' e' la stessa regola che il caso sul fallback del triage
 * applica: due regex separate divergerebbero al primo ritocco.
 */
const PER_ISSUE_KEY = /github\.event\.issue\.number/;

/**
 * La chiave varia per issue? Estratta dal ciclo perche' e' LA regola del gate, e
 * una regola che nessun test esercita direttamente puo' allentarsi senza che
 * niente diventi rosso — che e' precisamente com'e' passato `${{ github.ref }}`.
 * @param {string} group valore di `concurrency.group`
 */
function isPerIssueKey(group) {
  return PER_ISSUE_KEY.test(group);
}

/**
 * Legge tutti i `group:` dei blocchi `concurrency:` di un workflow.
 * Accetta i blocchi top-level e quelli a livello di job, oltre alle forme
 * flow-style e quotate; salta i commenti, e ancora `group:` a inizio riga: una
 * nota `# group: ...` non deve decidere al posto di quello vero.
 * @returns {string[]} tutti i valori dei gruppi, nell'ordine del file
 */
function concurrencyGroup(yaml) {
  const lines = yaml.split('\n');
  const indentOf = (l) => /^[ \t]*/.exec(l)[0].length;
  const isComment = (l) => /^\s*#/.test(l);
  const key = (name, line) => {
    if (isComment(line)) return null;
    return new RegExp(`^\\s*(?:(['"])${name}\\1|${name})\\s*:\\s*(.*)$`).exec(line);
  };
  const groups = [];
  for (let i = 0; i < lines.length; i += 1) {
    const start = key('concurrency', lines[i]);
    if (!start) continue;
    const base = indentOf(lines[i]);
    const inline = start[2].trim();
    if (inline) {
      const flow = /(?:^|[,{])\s*['"]?group['"]?\s*:\s*(.*?)(?:\s*,\s*['"]?[A-Za-z0-9_-]+['"]?\s*:|\s*}\s*$)/.exec(inline);
      if (flow) groups.push(flow[1].trim());
      else if (!inline.startsWith('#') && !inline.startsWith('{')) groups.push(inline);
    }
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j];
      if (l.trim() === '') continue;
      if (indentOf(l) <= base) break;
      const m = key('group', l);
      if (m) groups.push(m[2].trim());
    }
  }
  return groups;
}

/** Il workflow e' innescato da eventi `issues:`? */
function triggersOnIssues(yaml) {
  const lines = yaml.split('\n');
  const onKey = (line) => {
    if (/^\s*#/.test(line)) return null;
    return /^(\s*)(?:(['"])on\2|on)\s*:\s*(.*)$/.exec(line);
  };
  const start = lines.findIndex((l) => {
    const m = onKey(l);
    return m && m[1].length === 0;
  });
  if (start < 0) return false;
  const on = onKey(lines[start]);
  const rest = on[3].replace(/\s+#.*$/, '').trim();
  if (/^['"]?issues['"]?$/.test(rest)
      || /(?:^|[,{[])\s*['"]?issues['"]?\s*(?::|[,}\]])/.test(rest)) return true;
  for (let j = start + 1; j < lines.length; j += 1) {
    if (lines[j].trim() !== '' && !/^\s/.test(lines[j])) break;
    if (/^\s+['"]?issues['"]?\s*:/.test(lines[j])) return true;
  }
  return false;
}

test('ogni workflow su eventi issue serializza su una chiave per-issue', () => {
  const offenders = [];
  for (const file of fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml'))) {
    const yaml = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    if (!triggersOnIssues(yaml)) continue;
    const groups = concurrencyGroup(yaml);
    if (!groups.length) {
      offenders.push(`${file} → manca concurrency per un workflow issue-triggered`);
      continue;
    }
    // La condizione non e' "interpola qualcosa" ma "interpola L'ISSUE": su un
    // evento `issues:` la maggior parte delle espressioni di contesto e'
    // COSTANTE. `${{ github.ref }}` e' sempre il default branch, `github.workflow`
    // e `github.repository` non cambiano mai — chiavi che sfrattano esattamente
    // come la costante letterale che questo gate esiste per vietare, ma che un
    // controllo su `${{` lascia passare (follow-up #918).
    for (const group of groups) {
      if (!isPerIssueKey(group)) offenders.push(`${file} → group: ${group}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Chiave di concorrenza non per-issue su un workflow innescato da eventi issue.\n${offenders.join('\n')}\n`
      + 'Il gruppo deve interpolare `github.event.issue.number`: qualunque altra chiave — costante '
      + 'letterale, ma anche `${{ github.ref }}` / `${{ github.workflow }}` / `${{ github.repository }}`, '
      + 'che su un evento `issues:` valgono sempre lo stesso — fa entrare ogni evento issue del repo '
      + 'nella stessa coda profonda 1, sfrattando la pending anche quando l\'`if:` del job la '
      + 'scarterebbe. Usa `${{ github.event.issue.number || ... }}`; il fallback dipende dai trigger '
      + 'di QUEL file — `github.run_id` se l\'unico trigger e\' `issues`, una costante condivisa se ci '
      + 'sono anche `schedule`/`workflow_dispatch`, che altrimenti girerebbero in parallelo con se stessi.',
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
  const groups = concurrencyGroup(yaml);
  assert.equal(groups.length, 1);
  assert.match(groups[0], PER_ISSUE_KEY, 'la chiave del triage deve essere per-issue sugli eventi issue');
  assert.doesNotMatch(groups[0], /github\.run_id/, 'con run_id due sweep potrebbero girare insieme');
});

test('il gate rifiuta le espressioni COSTANTI per un evento issue, non solo le costanti letterali', () => {
  // I controesempi sono quelli che la versione `includes('${{')` del gate
  // lasciava passare: sintatticamente interpolati, semanticamente fissi su un
  // evento `issues:`. Senza questo caso il gate resterebbe verde se qualcuno
  // riportasse la condizione debole, ed e' proprio il gate a essere l'unica
  // cosa che tiene i tre workflow sulla regola.
  for (const group of [
    'issue-fix',                              // costante letterale (la regressione originale)
    'issue-fix-${{ github.ref }}',            // per `issues:` e' sempre il default branch
    'issue-fix-${{ github.workflow }}',
    'issue-fix-${{ github.repository }}',
    'issue-fix-${{ github.event_name }}',
  ]) {
    assert.equal(isPerIssueKey(group), false, `il gate accetta una chiave che sfratta: ${group}`);
  }
  for (const group of [
    'issue-fix-${{ github.event.issue.number || github.run_id }}',
    "issue-triage-${{ github.event.issue.number || 'sweep' }}",
  ]) {
    assert.equal(isPerIssueKey(group), true, `il gate rifiuta una chiave per-issue valida: ${group}`);
  }
});

test('#1087: il gate raccoglie ogni concurrency e riconosce trigger YAML quotati e flow-style', () => {
  const issueKey = '${{ github.event.issue.number }}';
  const yaml = [
    '"on": {"issues": [opened], "workflow_dispatch": {}}',
    'concurrency:',
    `  group: issue-fix-${issueKey}`,
    'jobs:',
    '  build:',
    '    concurrency: {group: issue-build-${{ github.event.issue.number }}, cancel-in-progress: false}',
    '    runs-on: ubuntu-latest',
  ].join('\n');
  assert.equal(triggersOnIssues(yaml), true, 'il parser deve riconoscere on: quotato e mapping flow-style');
  assert.deepEqual(concurrencyGroup(yaml), [
    `issue-fix-${issueKey}`,
    'issue-build-${{ github.event.issue.number }}',
  ], 'il gate deve sorvegliare tutti i blocchi, non solo il primo');
  assert.ok(concurrencyGroup(yaml).every(isPerIssueKey));
  assert.equal(triggersOnIssues('on: [issues, workflow_dispatch]'), true,
    'il parser deve riconoscere anche la lista flow-style');
});

test('#1087: un workflow issue-triggered senza concurrency è un errore del gate', () => {
  const yaml = [
    "'on': {issues: [labeled]}",
    'jobs:',
    '  fixer:',
    '    runs-on: ubuntu-latest',
  ].join('\n');
  assert.equal(triggersOnIssues(yaml), true);
  assert.deepEqual(concurrencyGroup(yaml), [], 'il workflow senza chiave deve restare senza gruppi');
  assert.equal(concurrencyGroup(yaml).length > 0, false);
  assert.match(fs.readFileSync(new URL(import.meta.url), 'utf8'), /manca concurrency per un workflow issue-triggered/);
});

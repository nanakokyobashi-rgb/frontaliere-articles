/**
 * claude-action-bash-sandbox.test.mjs — nessuno step Claude puo' finire sul
 * percorso sandbox rotto senza accorgersene. Run with `node --test`.
 *
 * ## Il guasto che questo test rende impossibile ripetere (issue #127)
 *
 * `post-merge-followup.yml` ha girato VERDE per 17 run producendo zero triage.
 * Ogni invocazione del tool Bash — anche `pwd` — moriva con
 *
 *     Exit code 1
 *     bwrap: Can't create file at /home/.mcp.json: Permission denied
 *
 * Il sandbox bwrap non parte su questa immagine di runner. Non e' pero' quello
 * il motivo per cui il difetto ha colpito UN solo workflow: il sandbox e'
 * acceso di default per tutti. La differenza sta nel recupero.
 *
 * Quando un comando sandboxato fallisce, Claude Code lo RIPROVA fuori dal
 * sandbox (`allowUnsandboxedCommands`, default true) passando pero' dal flusso
 * dei permessi. Quindi:
 *
 *   - con `--dangerously-skip-permissions` il retry e' auto-approvato, gira, e
 *     il sandbox rotto resta INVISIBILE (issue-fix, pr-review-loop,
 *     pr-redflag-fixer: verdi e funzionanti, per puro effetto collaterale);
 *   - con `--allowedTools` scoped il `permissionMode` resta `"default"`, il
 *     retry chiede un'approvazione che in CI nessuno puo' dare, e OGNI comando
 *     muore (post-merge-followup, lessons-harvester).
 *
 * La riparazione mirata e' spegnere il componente rotto — `settings` con
 * `{"sandbox":{"enabled":false}}` — invece di buttare via lo scoping degli
 * strumenti, che e' una proprieta' di sicurezza voluta.
 *
 * ## Perche' serve un test e non basta la fix
 *
 * Il difetto e' della classe peggiore: **verde e silenzioso**. Non esiste
 * nessun segnale, in nessun log, che dica «questo step e' sul percorso rotto» —
 * bisogna leggere l'execution file e contare i `tool_result`. Il prossimo
 * workflow Claude aggiunto al repo, se copia lo scheletro di uno dei due file
 * riparati ma non la riga `settings`, ricomincia a girare a vuoto senza che
 * niente diventi rosso. `lessons-harvester.yml` e' gia' un caso reale di
 * questo: e' stato aggiunto sul percorso `--allowedTools` mesi dopo, ha lo
 * stesso guasto, e non se n'era accorto nessuno perche' il suo step Claude e'
 * quasi sempre `skipped`.
 *
 * Il test asserisce quindi sulla REGOLA, non sui due file: chi concede Bash
 * senza bypassare i permessi deve spegnere il sandbox.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WF_DIR = resolve(here, '../../.github/workflows');

/**
 * Estrae il valore di una chiave `chiave: <valore>` da un blocco di step.
 * Guarda SOLO le righe che sono davvero quella chiave: i commenti di questi
 * workflow nominano `--dangerously-skip-permissions` in prosa (raccontano il
 * rollback #3269), e un grep sul testo intero classificherebbe come "bypassa i
 * permessi" proprio i due step che non lo fanno.
 */
function valoreChiave(blocco, chiave) {
  const m = new RegExp(`^\\s*${chiave}:\\s*(.+)$`, 'm').exec(blocco);
  return m ? m[1].trim() : '';
}

/** Spezza un workflow negli step di primo livello (`      - ...`, 6 spazi). */
function stepDi(testo) {
  const righe = testo.split('\n');
  const blocchi = [];
  let corrente = null;
  for (const riga of righe) {
    if (/^ {6}- /.test(riga)) {
      if (corrente) blocchi.push(corrente.join('\n'));
      corrente = [riga];
    } else if (corrente) {
      corrente.push(riga);
    }
  }
  if (corrente) blocchi.push(corrente.join('\n'));
  return blocchi;
}

/** Tutti gli step che invocano claude-code-action, in tutti i workflow. */
function stepClaude() {
  const out = [];
  for (const file of readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const testo = readFileSync(join(WF_DIR, file), 'utf8');
    for (const blocco of stepDi(testo)) {
      if (!/uses:\s*anthropics\/claude-code-action/.test(blocco)) continue;
      const claudeArgs = valoreChiave(blocco, 'claude_args');
      out.push({
        file,
        nome: (valoreChiave(blocco, '- name') || valoreChiave(blocco, 'name') || '(senza nome)').replace(/^- /, ''),
        claudeArgs,
        settings: valoreChiave(blocco, 'settings'),
        bypassaPermessi: claudeArgs.includes('--dangerously-skip-permissions'),
        // `Bash(...)` nell'allowlist, oppure il bypass che concede tutto.
        concedeBash: /Bash\(/.test(claudeArgs) || claudeArgs.includes('--dangerously-skip-permissions'),
      });
    }
  }
  return out;
}

test('il censimento degli step Claude non e\' vuoto', () => {
  // Un gate che non trova niente passa sempre. Se il parsing si rompe (indent
  // cambiato, step riscritti, action rinominata) questo test deve diventare
  // rosso invece di lasciar passare in silenzio tutto il resto del file.
  const step = stepClaude();
  assert.ok(
    step.length >= 5,
    `attesi almeno 5 step claude-code-action, trovati ${step.length}: il parser non vede piu' i workflow`,
  );
  const conBash = step.filter((s) => s.concedeBash);
  assert.ok(
    conBash.length >= 5,
    `attesi almeno 5 step che concedono Bash, trovati ${conBash.length}`,
  );
});

test('chi concede Bash senza bypassare i permessi DEVE spegnere il sandbox', () => {
  const colpevoli = stepClaude()
    .filter((s) => s.concedeBash && !s.bypassaPermessi)
    .filter((s) => !/"sandbox"\s*:\s*\{\s*"enabled"\s*:\s*false\s*\}/.test(s.settings));

  assert.deepEqual(
    colpevoli.map((s) => `${s.file} → ${s.nome}`),
    [],
    'Questi step girano sul percorso `--allowedTools` (permissionMode "default") con il ' +
    'sandbox bwrap ACCESO. Su questa immagine di runner il sandbox non parte, il retry ' +
    'non-sandboxato viene negato perche\' nessuno puo\' approvarlo in CI, e OGNI comando ' +
    'Bash fallisce — con lo step che esce comunque `success`. Aggiungi ' +
    "`settings: '{\"sandbox\":{\"enabled\":false}}'` allo step (vedi issue #127), oppure " +
    'passa `--dangerously-skip-permissions` se per quello step lo scoping non serve.',
  );
});

test('i due workflow riparati da #127 restano riparati', () => {
  // La regola sopra e' generale; questi due sono i casi misurati, e vale
  // pinnarli per nome: sono gli unici due consumatori del percorso
  // `--allowedTools` del repo, e la loro regressione non produrrebbe rosso.
  const perFile = new Map(stepClaude().filter((s) => s.concedeBash).map((s) => [s.file, s]));
  for (const file of ['post-merge-followup.yml', 'lessons-harvester.yml']) {
    const s = perFile.get(file);
    assert.ok(s, `${file}: step Claude non trovato`);
    assert.match(
      s.settings,
      /"sandbox"\s*:\s*\{\s*"enabled"\s*:\s*false\s*\}/,
      `${file}: senza sandbox spento questo workflow torna a girare a vuoto in verde`,
    );
    assert.ok(
      !s.bypassaPermessi,
      `${file}: lo scoping --allowedTools e' voluto (sessione read-mostly). ` +
      'Se serve davvero il bypass, va discusso: non e\' il modo di aggirare il sandbox.',
    );
  }
});

/**
 * claude-action-bash-sandbox.test.mjs — `allowed_non_write_users` accende da
 * solo un wrapper bwrap che su questi runner rompe OGNI comando di shell.
 * Chi lo valorizza deve spegnere la subprocess isolation. Run with `node --test`.
 *
 * ## Il guasto che questo test rende impossibile ripetere (issue #127)
 *
 * `post-merge-followup.yml` ha girato VERDE per 17 run producendo zero triage.
 * Ogni invocazione del tool Bash — anche `pwd` — moriva con
 *
 *     Exit code 1
 *     bwrap: Can't create file at /home/.mcp.json: Permission denied
 *
 * Il bwrap NON e' il sandbox di Claude Code: e' la **subprocess isolation di
 * claude-code-action**, che l'action accende da sola, senza che il workflow la
 * chieda, quando `allowed_non_write_users` e' valorizzato. Dall'action.yml:
 *
 *     - name: Install subprocess isolation dependencies
 *       if: ${{ inputs.allowed_non_write_users != '' && runner.os == 'Linux' }}
 *       run: … apt-get install -y bubblewrap socat …
 *
 *     CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: ${{ env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
 *       || (inputs.allowed_non_write_users != '' && '1') || '' }}
 *
 * Ed e' per questo che `dangerouslyDisableSandbox: true` non aiutava: quel flag
 * spegne il sandbox di Claude Code, che qui non c'entra.
 *
 * ## Perche' un test, e perche' su QUESTA condizione
 *
 * La correlazione e' esatta e verificabile in un colpo d'occhio: nel repo
 * `allowed_non_write_users` e' valorizzato in un solo workflow, ed e' l'unico
 * rotto. Le due ipotesi precedenti — il proxy Headroom, e lo scoped
 * `--allowedTools` — sono state entrambe smentite proprio da questo confronto:
 * `lessons-harvester.yml` gira sugli stessi trigger, con lo stesso
 * `--allowedTools`, e sta bene.
 *
 * Il difetto e' della classe peggiore: **verde e silenzioso**. Nessun log dice
 * «questo step ha la subprocess isolation accesa» — l'unico modo di accorgersene
 * e' leggere l'execution file e contare i `tool_result` in errore. Un domani chi
 * aggiunge `allowed_non_write_users` a un altro workflow (e' un input che si
 * aggiunge per far passare il gate write-access di un bot, cioe' per un motivo
 * che non ha niente a che vedere con bwrap) accenderebbe l'isolamento senza
 * saperlo e tornerebbe a girare a vuoto in verde.
 *
 * Il test asserisce quindi sull'ACCOPPIAMENTO, non sui nomi dei file: chi
 * valorizza `allowed_non_write_users` deve anche disattivare esplicitamente la
 * subprocess isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const WF_DIR = resolve(here, '../../.github/workflows');

/**
 * Valore di `chiave: <valore>` dentro un blocco di step, cercato solo sulle
 * righe che sono davvero quella chiave. I commenti di questi workflow nominano
 * in prosa sia `allowed_non_write_users` sia lo scrub — un grep sul testo
 * intero classificherebbe male proprio gli step che documentano il problema.
 */
function valoreChiave(blocco, chiave) {
  const m = new RegExp(`^\\s*${chiave}:\\s*(.+?)\\s*$`, 'm').exec(blocco);
  return m ? m[1].trim() : '';
}

/** Spezza un workflow negli step di primo livello (`      - `, 6 spazi). */
function stepDi(testo) {
  const blocchi = [];
  let corrente = null;
  for (const riga of testo.split('\n')) {
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
      if (!/^\s*uses:\s*anthropics\/claude-code-action/m.test(blocco)) continue;
      out.push({
        file,
        nome: valoreChiave(blocco, 'name').replace(/^- /, '') || '(senza nome)',
        nonWriteUsers: valoreChiave(blocco, 'allowed_non_write_users'),
        // L'opt-out documentato dall'action: "Subprocess isolation opted out
        // via CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0".
        scrubSpento: /^\s*CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:\s*['"]?0['"]?\s*$/m.test(blocco),
      });
    }
  }
  return out;
}

test('il censimento degli step Claude non e\' vuoto', () => {
  // Un gate che non trova niente passa sempre. Se il parsing si rompe (indent
  // cambiato, action rinominata, step riscritti) questo test deve diventare
  // rosso invece di lasciar passare in silenzio tutto il resto del file.
  const step = stepClaude();
  assert.ok(
    step.length >= 5,
    `attesi almeno 5 step claude-code-action, trovati ${step.length}: il parser non vede piu' i workflow`,
  );
  assert.ok(
    step.some((s) => s.nonWriteUsers !== ''),
    'nessuno step valorizza allowed_non_write_users: il test non sta piu' +
    ' esercitando la condizione che deve proteggere',
  );
});

test('chi valorizza allowed_non_write_users DEVE spegnere la subprocess isolation', () => {
  const colpevoli = stepClaude().filter((s) => s.nonWriteUsers !== '' && !s.scrubSpento);

  assert.deepEqual(
    colpevoli.map((s) => `${s.file} → ${s.nome}`),
    [],
    'Questi step valorizzano `allowed_non_write_users`, e con quell\'input ' +
    'claude-code-action accende DA SOLA la subprocess isolation: installa bubblewrap ' +
    'e avvolge ogni comando in bwrap. Su questa immagine di runner bwrap non parte, ' +
    'quindi OGNI Bash fallisce — anche `pwd` — mentre lo step esce comunque `success`. ' +
    'Aggiungi `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: 0` all\'`env:` dello step (vedi issue ' +
    '#127), oppure togli `allowed_non_write_users` se il gate write-access non serve.',
  );
});

test('post-merge-followup resta riparato, e con entrambe le meta\' accoppiate', () => {
  // Le due righe sono una coppia: `allowed_non_write_users` serve a far passare
  // il gate write-access del bot (root cause di PR #3157, senza cui la run muore
  // a turno 0), e lo scrub a 0 e' il prezzo che quella riga impone. Togliere la
  // prima senza la seconda rimette il guasto; togliere la seconda senza la prima
  // fa fallire il gate. Il test le pinna insieme.
  const s = stepClaude().find((x) => x.file === 'post-merge-followup.yml' && x.nonWriteUsers !== '');
  assert.ok(s, 'post-merge-followup.yml: step Claude con allowed_non_write_users non trovato');
  assert.ok(
    s.scrubSpento,
    'senza CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: 0 questo workflow torna a girare a vuoto in verde',
  );
});

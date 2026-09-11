/**
 * rungate-fault-loud.test.mjs — un gate che NON ha girato non può essere
 * silenzioso come un gate che ha girato e non sa decidere.
 *
 * ## L'invariante, e perché non è quello dell'altro test
 *
 * `generator/tests/rungate-targets-exist.test.mjs` verifica STATICAMENTE che i
 * gate invocati per nome esistano e che i loro import nominati risolvano: è
 * l'invariante di CI, e in CI il checkout è quello che il test ha appena
 * ispezionato. Questo test copre l'altra metà, il RUNTIME: quando in produzione
 * il gate manca comunque (checkout parziale, file rinominato, mirror a metà),
 * `collect-followup-batch.mjs` deve dirlo forte invece di ricadere in silenzio
 * sul proceed-safe. Sono due invarianti diversi e nessuno dei due implica
 * l'altro.
 *
 * Il costo misurato del silenzio, il 2026-09-07: i due gate non esistevano in
 * questo repo, `runGate` ne inghiottiva l'ENOENT, e «inconclusive» non era raro
 * ma sistematico — 46 PR su 46 in tre run, zero soppressioni in assoluto,
 * contro 58 su 96 sul sito. A valle, 90 follow-up su 285 (31,6%) erano nipoti.
 *
 * ## Come è costruito, e perché così
 *
 * Lo script NON viene importato: in questo workspace un `import()` di uno script
 * del ciclo ha già scritto dati veri in produzione. Viene COPIATO in una
 * directory temporanea (importa solo builtin Node, quindi la copia è
 * autosufficiente) ed ESEGUITO come sottoprocesso. La copia in una directory
 * vuota è ciò che rende riproducibile il caso «gate assente»: `HERE` diventa la
 * temp, e i gate veri restano fuori portata senza toccare il repo.
 *
 * `gh` è sostituito da uno stub in PATH che risponde JSON canonico, così il
 * codice arriva davvero fino a `runGate` senza rete e senza credenziali.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/ci/collect-followup-batch.mjs');

/** Una PR mergiata di un autore ammesso: basta a far arrivare il flusso ai gate. */
const PR_LIST = JSON.stringify([
  { number: 4242, title: 'feat: qualcosa', author: { login: 'valerielinc-ops' }, mergedAt: '2026-09-07T00:00:00Z', headRefName: 'feat/x' },
]);

/**
 * Sandbox: copia dello script + stub `gh` in PATH + `$GITHUB_STEP_SUMMARY` su
 * file. `gates` mappa nome-file → sorgente, per piantare un gate rotto o sano.
 */
function runInSandbox(gates = {}) {
  // realpath: su macOS `os.tmpdir()` passa da /var → /private/var, e il loader
  // ESM di Node risolve i symlink mentre `process.argv[1]` no. Senza questo la
  // guardia da CLI dello script non riconosce se stessa e main() non parte.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rungate-fault-')));
  fs.copyFileSync(SCRIPT, path.join(dir, 'collect-followup-batch.mjs'));
  for (const [name, source] of Object.entries(gates)) {
    fs.writeFileSync(path.join(dir, name), source);
  }

  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // `gh run list` → nessuna run (watermark = fallback), `gh pr list` → una PR,
  // `gh pr view --json comments` → nessun commento di triage.
  fs.writeFileSync(
    path.join(bin, 'gh'),
    '#!/bin/sh\n' +
    'case "$1 $2" in\n' +
    '  "run list") echo "[]" ;;\n' +
    `  "pr list") cat <<'JSON'\n${PR_LIST}\nJSON\n  ;;\n` +
    '  "pr view") echo "{\\"comments\\":[]}" ;;\n' +
    '  *) echo "" ;;\n' +
    'esac\n',
    { mode: 0o755 },
  );

  const summary = path.join(dir, 'summary.md');
  // `spawnSync` e non `execFileSync`: da quando un gate ASSENTE e' fatale
  // (decisione del proprietario, 2026-09-07) l'uscita non-zero e' un ESITO da
  // osservare, non un errore da propagare. `execFileSync` lancerebbe, e il test
  // che verifica il guasto morirebbe prima di poterlo leggere.
  const run = spawnSync(process.execPath, [path.join(dir, 'collect-followup-batch.mjs')], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_OUTPUT: '',
      GH_REPO: 'nanakokyobashi-rgb/frontaliere-articles',
      GITHUB_REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
      FOLLOWUP_ELIGIBLE_AUTHORS: 'valerielinc-ops',
    },
  });
  const stdout = String(run.stdout || '');
  return { stdout, status: run.status, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf-8') : '' };
}

test('gate ASSENTE: annotation ::error:: e sezione nel run summary', () => {
  const { stdout, summary } = runInSandbox(); // nessun gate accanto alla copia

  assert.match(
    stdout,
    /::error title=Gate del follow-up assente::is-followup-fix-pr\.mjs/,
    'Un gate che non esiste deve produrre una annotation GitHub Actions, ' +
    'non ricadere in silenzio sul proceed-safe.\nstdout:\n' + stdout,
  );
  assert.match(summary, /Gate del follow-up NON eseguiti/, 'Il guasto deve comparire nel $GITHUB_STEP_SUMMARY.\n' + summary);
  assert.match(summary, /is-followup-fix-pr\.mjs.*assente/, 'Il summary deve nominare il gate e il tipo di guasto.\n' + summary);
  assert.match(summary, /followup-has-candidates\.mjs.*assente/, 'Entrambi i gate mancanti vanno elencati.\n' + summary);

  // Il verso del proceed-safe NON cambia: la PR resta nel batch.
  assert.match(stdout, /batch_prs=4242/, 'Il proceed-safe deve restare invariato: la PR va tenuta.\n' + stdout);
});

test('gate PRESENTE ma non caricabile: guasto distinto, non inconclusive', () => {
  const { stdout, summary } = runInSandbox({
    // Import nominato che non risolve → SyntaxError al caricamento del modulo.
    'is-followup-fix-pr.mjs': "import { inesistente } from 'node:path';\nconsole.log('is_followup_fix=true');\n",
    'followup-has-candidates.mjs': "console.log('has_candidates=true');\n",
  });

  assert.match(
    stdout,
    /::error title=Gate del follow-up non caricabile::is-followup-fix-pr\.mjs/,
    'Un gate che esiste ma non si carica è un guasto, non un esito incerto.\nstdout:\n' + stdout,
  );
  assert.doesNotMatch(
    summary,
    /followup-has-candidates\.mjs/,
    'Il gate sano non deve comparire fra i guasti.\n' + summary,
  );
  assert.match(stdout, /batch_prs=4242/, 'Proceed-safe invariato.\n' + stdout);
});

test('gate che consegna il verdetto prima dell’exit non-zero: il verdetto resta autorevole', () => {
  const { stdout, summary } = runInSandbox({
    'is-followup-fix-pr.mjs':
      "console.log('is_followup_fix=true');\n" +
      "process.exit(1);\n",
    'followup-has-candidates.mjs': "console.log('has_candidates=true');\n",
  });

  assert.match(stdout, /follow-up FIX \(grandchild-suppression\) → skip/);
  assert.doesNotMatch(stdout, /non eseguibile/, 'Un verdetto già emesso non è un gate senza verdetto.\n' + stdout);
  assert.doesNotMatch(summary, /Gate del follow-up NON eseguiti/, 'Il verdetto non deve produrre un falso fault.\n' + summary);
  assert.match(stdout, /batch_prs=\n/, 'La soppressione deve restare effettiva.\n' + stdout);
});

test('SyntaxError runtime: esecuzione fallita, non modulo non caricabile', () => {
  const { stdout } = runInSandbox({
    'is-followup-fix-pr.mjs': "throw new SyntaxError('runtime parser failure');\n",
    'followup-has-candidates.mjs': "console.log('has_candidates=true');\n",
  });

  assert.match(stdout, /::error title=Gate del follow-up non eseguibile::is-followup-fix-pr\.mjs/);
  assert.doesNotMatch(stdout, /::error title=Gate del follow-up non caricabile::is-followup-fix-pr\.mjs/);
  assert.match(stdout, /SyntaxError: runtime parser failure/, 'Il dettaglio deve indicare la causa reale.\n' + stdout);
  assert.match(stdout, /batch_prs=4242/);
});

test('il dettaglio preferisce la riga Error alla cornice interna di Node', () => {
  const { stdout } = runInSandbox({
    'is-followup-fix-pr.mjs': "throw new Error('causa reale del gate');\n",
    'followup-has-candidates.mjs': "console.log('has_candidates=true');\n",
  });

  assert.match(stdout, /::error title=Gate del follow-up non eseguibile::is-followup-fix-pr\.mjs/);
  assert.match(stdout, /Error: causa reale del gate/, 'L’annotation deve mostrare la causa, non node:internal.\n' + stdout);
});

test('gate che termina per errore d’ambiente: errore visibile, non verdetto', () => {
  const { stdout, summary } = runInSandbox({
    // Un gate che non riesce a eseguire una dipendenza non ha prodotto un verdetto.
    'is-followup-fix-pr.mjs':
      "import { execFileSync } from 'node:child_process';\n" +
      "execFileSync('rungate-dipendenza-inesistente', []);\n",
    'followup-has-candidates.mjs': "console.log('has_candidates=true');\n",
  });

  assert.match(
    stdout,
    /::error title=Gate del follow-up non eseguibile::is-followup-fix-pr\.mjs/,
    'Un errore d’ambiente deve essere visibile, non diventare inconclusive silenzioso.\nstdout:\n' + stdout,
  );
  assert.match(summary, /is-followup-fix-pr\.mjs.*non eseguibile/, 'Il summary deve conservare il guasto.\n' + summary);
  assert.match(stdout, /batch_prs=4242/, 'Il proceed-safe resta: senza verdetto la PR va tenuta.\n' + stdout);
});

test('gate presente con verdetto SOPPRIMI: la PR non entra nel batch', () => {
  const { stdout } = runInSandbox({
    'is-followup-fix-pr.mjs': "console.log('is_followup_fix=true');\n",
    'followup-has-candidates.mjs': "console.log('has_candidates=true');\n",
  });

  assert.match(stdout, /follow-up FIX \(grandchild-suppression\) → skip/);
  assert.match(stdout, /batch_prs=\n/, 'Una soppressione reale deve lasciare il batch vuoto.\n' + stdout);
  assert.doesNotMatch(stdout, /batch_prs=4242/);
});

test('gate presente con verdetto NO-OP: la PR non entra nel batch', () => {
  const { stdout } = runInSandbox({
    'is-followup-fix-pr.mjs': "console.log('is_followup_fix=false');\n",
    'followup-has-candidates.mjs': "console.log('has_candidates=false');\n",
  });

  assert.match(stdout, /no plausible candidate .*skip/);
  assert.match(stdout, /batch_prs=\n/, 'Una soppressione reale deve lasciare il batch vuoto.\n' + stdout);
  assert.doesNotMatch(stdout, /batch_prs=4242/);
});

test('gate girato e INCONCLUSIVE: resta silenzioso (proceed-safe legittimo)', () => {
  const { stdout, summary } = runInSandbox({
    // Gira, esce 0, ma non stampa la chiave attesa → incertezza vera.
    'is-followup-fix-pr.mjs': "console.log('niente di parsabile');\n",
    'followup-has-candidates.mjs': "console.log('has_candidates=true');\n",
  });

  assert.doesNotMatch(stdout, /::error/, 'Un gate che ha girato e non sa decidere non è un guasto.\n' + stdout);
  assert.equal(summary.includes('Gate del follow-up NON eseguiti'), false, 'Nessuna sezione guasti attesa.\n' + summary);
  assert.match(stdout, /grandchild gate inconclusive/, 'Resta il log proceed-safe di sempre.\n' + stdout);
  assert.match(stdout, /batch_prs=4242/, 'Proceed-safe invariato.\n' + stdout);
});

// ── FATALE SOLO SU «assente» — decisione del proprietario, 2026-09-07 ────────
//
// L'asimmetria e' il punto, e senza test si perde al primo refactor. Un gate
// che MANCA e' una configurazione rotta: non si ripara da sola, e finche' dura
// ogni run conia senza soppressione — 90 nipoti su 285 (31,6%) e' quanto e'
// costato il silenzio. Un gate che c'e' ma non si CARICA puo' essere un rosso
// transitorio (deploy a meta', dipendenza che arriva un minuto dopo), e fermare
// il ciclo del corpus — che alimenta la generazione degli articoli — costerebbe
// piu' di quanto salva.

test('gate ASSENTE: la run FALLISCE (watermark fermo, finestra ri-coperta)', () => {
  const { status, stdout } = runInSandbox();
  assert.equal(status, 1, 'un gate assente deve rendere la run fallita');
  assert.match(stdout, /::error title=Gate del follow-up assente::/);
});

test('gate NON CARICABILE: urla ma NON fa fallire la run', () => {
  const { status, stdout } = runInSandbox({
    'is-followup-fix-pr.mjs': "import { inesistente } from 'node:path';\nconsole.log('is_followup_fix=true');\n",
    'followup-has-candidates.mjs': "console.log('has_candidates=true');\n",
  });
  assert.equal(status, 0, 'un modulo che non risolve puo\' essere transitorio: non ferma il ciclo');
  assert.doesNotMatch(stdout, /::error title=Gate del follow-up assente::/);
});

test('il batch viene comunque emesso: il verdetto non cancella cio\' che lo spiega', () => {
  // `process.exitCode` e non `process.exit()`. Se qualcuno lo cambiasse in un
  // `exit()` immediato, `batch_prs` non verrebbe mai stampato e la run fallita
  // sarebbe muta proprio dove deve spiegarsi.
  const { stdout } = runInSandbox();
  assert.match(stdout, /batch_prs=/);
  assert.match(stdout, /batch_count=/);
});

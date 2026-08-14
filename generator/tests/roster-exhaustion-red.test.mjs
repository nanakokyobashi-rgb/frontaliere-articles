/**
 * ── L'OSSERVATORE CHE MANCAVA (issue #313 / #348) ───────────────────────────
 *
 * Il difetto non e' che al roster manchi un modello grande. E' che
 * L'ESAURIMENTO DEL ROSTER NON ERA UN ERRORE: `Generate Blog Article` e' uscita
 * `success` 60+ volte di fila, dalle 06:06Z alle 16:30Z del 2026-08-14, senza
 * produrre un articolo, e `scan-failed-runs.mjs` — che raccoglie solo le run
 * `failure` — non aveva niente da raccogliere. Dieci ore di silenzio verde.
 *
 * Questo file prova le DUE meta' della guardia, e le prova in modi diversi
 * perche' vivono in due linguaggi diversi:
 *
 *   1. la DECISIONE (`lib/exhaustion-disposition.mjs`) — eseguita davvero, sui
 *      numeri veri della run 31817957722;
 *   2. la PROPAGAZIONE (il blocco bash dello step «Generate the article» in
 *      `.github/workflows/generate-article.yml`) — eseguita davvero anche
 *      quella, estraendo il `run:` dal YAML e lanciandolo con un `node` finto
 *      che esce con il codice scelto. Non e' una riscrittura del blocco: e'
 *      QUEL blocco, letto dal file che gira in produzione. Se qualcuno toglie
 *      l'`exit 1`, questo test diventa rosso.
 *
 * PERCHE' L'ORACOLO E' IL CODICE DI USCITA E NON IL TESTO. Un harness che
 * faceva `grep` sull'output di un runner di test e' stato accecato dalle
 * sequenze ANSI e ha dato 10 «verdi» su 10 mutazioni reali. Qui ogni asserzione
 * guarda `status` del processo, mai il suo stdout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT_ROSTER_CANNOT_SERVE_PROMPT,
  EXIT_NO_ARTICLE_DECLARED,
  isInputCapDeferralVeto,
  inputCapVetoSummary,
} from '../scripts/lib/exhaustion-disposition.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'generate-article.yml');
const CREATE_ARTICLE = path.join(REPO, 'generator', 'scripts', 'create-article.mjs');

// ── 1. LA DECISIONE ────────────────────────────────────────────────────────

/**
 * La forma ESATTA dell'errore risalito dalla run 31817957722. I numeri non sono
 * inventati: 53/53/1 sono il riconteggio dei 107 errori del messaggio aggregato
 * con le due regex di `classifyExhaustionCause`, e 38/9740/8000 vengono dalla
 * riga «📏 Prompt budget» dello stesso log.
 */
function productionExhaustionError({ transient = 53, persistent = 53, capCount = 38 } = {}) {
  const err = new Error('All AI models failed. Chain: [...]. Errors: ...');
  err.code = 'ALL_MODELS_EXHAUSTED';
  err.exhaustionBreakdown = { transient, persistent, total: 107 };
  err.transientExhaustion = transient > 0 && transient >= persistent;
  err.inputCapReport = capCount > 0
    ? { count: capCount, maxSkippedReqLimit: 8000, minSkippedReqLimit: 3000, estimatedRequestTokens: 9740 }
    : null;
  return err;
}

test('la run 31817957722 (pareggio 53/53, 38 rifiuti su taglia) NON e\' un differimento', () => {
  const err = productionExhaustionError();
  // La classificazione a monte diceva «transitorio»: e' quella che ha prodotto
  // le dieci ore di verde. Il veto deve contraddirla proprio qui.
  assert.equal(err.transientExhaustion, true, 'la premessa del difetto: il voto dice transitorio');
  assert.equal(isInputCapDeferralVeto(err), true, 'il veto deve vincere sul voto');
  const s = inputCapVetoSummary(err);
  assert.deepEqual(s, { estimatedRequestTokens: 9740, maxSkippedReqLimit: 8000, over: 1740, refusals: 38 });
});

test('senza rifiuti su taglia il pareggio continua a differire (comportamento invariato)', () => {
  // La meta' che protegge dal rosso gratuito: una cascata svuotata solo da
  // quote e 429 si cura da sola a mezzanotte UTC, e differire resta giusto.
  assert.equal(isInputCapDeferralVeto(productionExhaustionError({ capCount: 0 })), false);
  // LE DUE FORME DI «nessun rifiuto su taglia» VANNO ENTRAMBE COPERTE. `callLLM`
  // oggi passa `inputCapReport: null`, e quel caso da solo lasciava passare una
  // mutazione: la guardia `count > 0` era irraggiungibile dietro il controllo
  // sul null, quindi toglierla non rompeva niente (mutazione 3 del giro
  // documentato nel body della PR — verde su un difetto vero). Un report
  // presente ma a zero e' la forma che rende la guardia osservabile, ed e'
  // quella che un futuro refactor di callLLM produrrebbe per primo.
  const zeroed = productionExhaustionError();
  zeroed.inputCapReport = { count: 0, maxSkippedReqLimit: 8000, minSkippedReqLimit: 3000, estimatedRequestTokens: 9740 };
  assert.equal(isInputCapDeferralVeto(zeroed), false, 'un report a zero rifiuti non e\' un veto');
});

test('il transitorio che domina STRETTAMENTE differisce anche con rifiuti su taglia', () => {
  assert.equal(isInputCapDeferralVeto(productionExhaustionError({ transient: 54, persistent: 53 })), false);
  // ...e un solo voto in meno lo riporta al rosso: e' la soglia, non un'euristica.
  assert.equal(isInputCapDeferralVeto(productionExhaustionError({ transient: 53, persistent: 53 })), true);
});

test('un errore che non e\' una cascata svuotata non viene mai vetato', () => {
  assert.equal(isInputCapDeferralVeto(null), false);
  assert.equal(isInputCapDeferralVeto(new Error('boom')), false);
  const other = new Error('boom');
  other.code = 'SOMETHING_ELSE';
  other.inputCapReport = { count: 9, maxSkippedReqLimit: 8000, estimatedRequestTokens: 9740 };
  assert.equal(isInputCapDeferralVeto(other), false);
});

// ── 2. IL CABLAGGIO IN create-article.mjs ──────────────────────────────────

test('il veto e\' cablato PRIMA del differimento nel catch di primo livello', () => {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf8');
  const veto = src.indexOf('if (isInputCapDeferralVeto(e))');
  const defer = src.indexOf('if (isQuotaExhaustedError(e))');
  assert.ok(veto > 0, 'il veto deve essere invocato nel catch di primo livello');
  assert.ok(defer > 0, 'il ramo di differimento deve esistere ancora');
  // L'ORDINE E' LA GUARDIA. Dopo il differimento il veto e' codice morto: quel
  // ramo fa `process.exit(0)` e non ritorna.
  assert.ok(veto < defer, 'il veto deve precedere isQuotaExhaustedError, altrimenti e\' irraggiungibile');
  // Una sola definizione di «uscita per roster esaurito»: il numero letterale
  // non deve ricomparire scritto a mano, o le due meta' possono divergere.
  assert.ok(
    src.includes('process.exit(EXIT_ROSTER_CANNOT_SERVE_PROMPT)'),
    'l\'uscita deve usare la costante condivisa, non un letterale',
  );
});

// ── 3. LA PROPAGAZIONE: il blocco bash VERO del workflow ───────────────────

/**
 * Estrae il `run:` dello step con `id: generate` da generate-article.yml.
 * Nessun parser YAML tra le dipendenze del corpus, e non ne serve uno: il
 * blocco e' l'ultima chiave dello step ed e' indentato in modo uniforme.
 */
function extractGenerateRunBlock() {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
  const idAt = lines.findIndex((l) => /^\s*id:\s*generate\s*$/.test(l));
  assert.ok(idAt > 0, 'lo step con `id: generate` deve esistere in generate-article.yml');
  const runAt = lines.findIndex((l, i) => i > idAt && /^\s*run:\s*\|\s*$/.test(l));
  assert.ok(runAt > idAt, 'lo step generate deve avere un blocco `run: |`');
  const bodyIndent = (lines[runAt + 1].match(/^\s*/) || [''])[0].length;
  const out = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === '') { out.push(''); continue; }
    const indent = (l.match(/^\s*/) || [''])[0].length;
    if (indent < bodyIndent) break;
    out.push(l.slice(bodyIndent));
  }
  const block = out.join('\n');
  assert.ok(block.includes('article_body_added'), 'estratto il blocco sbagliato');
  return block;
}

/**
 * Esegue quel blocco con un `node` finto che esce con `nodeExit`, e un `timeout`
 * finto (non esiste su ogni piattaforma, e qui non deve limitare niente).
 * `writesArticle` fa scrivere allo stub un corpo per-locale, cioe' l'unico
 * segnale che il blocco riconosce come «articolo prodotto».
 *
 * Ritorna il CODICE DI USCITA del blocco. E' l'unico oracolo di questa sezione.
 */
function runGenerateBlock({ nodeExit, writesArticle = false }) {
  const block = extractGenerateRunBlock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-red-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // `timeout --signal=TERM --kill-after=60s <cap>s node …` → tre argomenti da
    // scartare, poi si esegue il resto.
    fs.writeFileSync(path.join(bin, 'timeout'), '#!/bin/sh\nshift 3\nexec "$@"\n');
    const write = writesArticle
      ? 'mkdir -p content/blog-body/it && printf "export default {}\\n" > content/blog-body/it/stub-article.ts\n'
      : '';
    fs.writeFileSync(
      path.join(bin, 'node'),
      `#!/bin/sh\n${write}exit ${nodeExit}\n`,
    );
    fs.chmodSync(path.join(bin, 'timeout'), 0o755);
    fs.chmodSync(path.join(bin, 'node'), 0o755);

    // `article_body_added()` interroga l'index di git: serve un repo vero.
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    git('add', '-A');
    git('commit', '-qm', 'base');

    const script = path.join(dir, 'step.sh');
    fs.writeFileSync(script, block);
    const outFile = path.join(dir, 'gh-output');
    fs.writeFileSync(outFile, '');

    const res = spawnSync('bash', [script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TARGET_SECTION: 'svizzera',
        SOURCE_URL: '',
        EVENT_NAME: 'schedule',
        GITHUB_OUTPUT: outFile,
        // Secondi invece di decine di minuti: il blocco stesso li espone per
        // rendere l'aritmetica del budget guidabile da un test.
        GENERATE_BUDGET_S: '64',
        GENERATE_HARD_KILL_S: '32',
      },
    });
    return { status: res.status, stdout: res.stdout || '', outputs: fs.readFileSync(outFile, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('IL DIFETTO: roster esaurito e nessun articolo → lo step esce ROSSO', () => {
  const r = runGenerateBlock({ nodeExit: EXIT_ROSTER_CANNOT_SERVE_PROMPT });
  assert.equal(r.status, 1, 'una run che non genera niente perche\' il roster non puo\' servirla deve essere rossa');
  // Il verdetto resta leggibile: gli step `if: always()` a valle non diventano
  // ciechi solo perche' questo e' fallito.
  assert.match(r.outputs, /article=false/);
});

// ── QUI STAVANO DUE ASSERZIONI CHE ORA SONO FALSE, E VANNO LETTE ───────────
//
// Fino alla seconda passata su #313/#348 questo file affermava che «un'uscita
// non-zero qualunque resta assorbita come no-article-this-run» e che «exit 0
// senza articolo resta verde». Erano vere, e sono ESATTAMENTE la superficie su
// cui il difetto e' tornato: la run 31823202761 — la prima genuinamente dopo la
// #357 — e' uscita `success` senza un articolo perche' la sua miscela di errori
// non era la condizione nominata dall'exit 3, e una regola della forma «assorbi
// tutto tranne X» lascia passare per costruzione ogni difetto che non e' X.
//
// La regola e' invertita: senza articolo e' rosso, tranne quando OGNI tentativo
// dichiara una delle sei ragioni legittime uscendo EXIT_NO_ARTICLE_DECLARED (4).
// Le asserzioni corrispondenti vivono ora in `no-article-not-green.test.mjs`,
// che copre la matrice intera; qui resta la sola meta' che riguarda l'exit 3.
//
// Questa nota NON e' archeologia: chi in futuro rimettesse l'assorbimento
// generale troverebbe due test verdi a dargli ragione, ed e' successo una volta.

test('exit 4 (ragione legittima DICHIARATA) resta assorbito', () => {
  // L'unico assorbimento rimasto. Le sei ragioni: pool evergreen saturo,
  // nessuna keyword disponibile, tentativi esauriti, duplicato, rigetto
  // qualita', quota davvero esaurita.
  assert.equal(runGenerateBlock({ nodeExit: EXIT_NO_ARTICLE_DECLARED }).status, 0);
});

test('la congiunzione: roster bloccato MA articolo prodotto → verde', () => {
  // Se un tentativo scrive comunque un corpo, il roster ha servito: fallire qui
  // butterebbe via un articolo buono.
  const r = runGenerateBlock({ nodeExit: EXIT_ROSTER_CANNOT_SERVE_PROMPT, writesArticle: true });
  assert.equal(r.status, 0);
  assert.match(r.outputs, /article=true/);
});

/**
 * ── «NESSUN ARTICOLO ⇒ NON VERDE» (issue #313 / #348, seconda passata) ───────
 *
 * La #357 ha reso rossa UNA condizione nominata (il roster che non puo' servire
 * il prompt, exit 3). Non bastava, e il modo in cui non bastava e' la lezione:
 * la run 31823202761 — la prima genuinamente post-fix — e' uscita `success`
 * senza un articolo, perche' la sua miscela di errori non era la condizione
 * nominata. Una regola della forma «assorbi tutto tranne X» lascia passare per
 * costruzione ogni difetto che non e' ancora X.
 *
 * Qui si prova la regola invertita: **se non c'e' un articolo, e' rosso, tranne
 * quando OGNI tentativo ha dichiarato una delle sei ragioni legittime** uscendo
 * con `EXIT_NO_ARTICLE_DECLARED`.
 *
 * TRE ORACOLI, TUTTI SUL CODICE DI USCITA:
 *
 *   1. la DECISIONE sul differimento per quota
 *      (`isLegitimateQuotaDeferral`) — eseguita sui numeri veri della run
 *      31823202761, riclassificati con le regex di `classifyExhaustionCause`;
 *   2. il CABLAGGIO in `create-article.mjs` — letto come testo, perche' quel
 *      file non e' importabile (761 KB, e la prima cosa che fa e' rete);
 *   3. la PROPAGAZIONE — il blocco `run:` VERO dello step «Generate the
 *      article», estratto dal YAML che gira in produzione ed eseguito contro un
 *      `node` finto. Se qualcuno rimette un `exit 0`, questo file diventa rosso.
 *
 * PERCHE' MAI SULLO STDOUT. Un harness che faceva `grep` sull'output di un
 * runner di test e' stato accecato dalle sequenze ANSI e ha dato 10 «verdi» su
 * 10 mutazioni reali; un altro ha letto `EXIT=0` che era il `$?` di `tail`.
 * Ogni asserzione qui guarda `status` del processo.
 *
 * NB: i corpi dei test sono SINCRONI di proposito dove possono esserlo — un
 * corpo sincrono sotto `testTimeout` viene riportato «timed out» anche quando
 * passa, e l'unico modo di non incappare nell'ambiguita' e' non avere lavoro
 * asincrono da attendere.
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
  isLegitimateQuotaDeferral,
  quotaDeferralShare,
  QUOTA_DEFERRAL_MIN_TRANSIENT_SHARE,
} from '../scripts/lib/exhaustion-disposition.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'generate-article.yml');
const CREATE_ARTICLE = path.join(REPO, 'generator', 'scripts', 'create-article.mjs');

// ── 1. LA DECISIONE: un differimento per quota va DIMOSTRATO ────────────────

/**
 * La forma esatta dell'errore risalito dalla run 31823202761 (2026-08-14T17:45Z).
 * I numeri sono il riconteggio dei 106 errori del messaggio aggregato con le due
 * regex di `classifyExhaustionCause`:
 *
 *   transient  53  — tutti «daily limit»
 *   persistent 52  — 38 input cap, 12 «no API key», 2 × HTTP 404
 *   ambiguo     1  — «claude CLI timed out after 120000ms», che `transientRe`
 *                    non matcha (cerca `timeout`, il messaggio dice `timed out`)
 */
function run31823202761({ transient = 53, persistent = 52, total = 106 } = {}) {
  const err = new Error('All AI models failed. Chain: [...]. Errors: ...');
  err.code = 'ALL_MODELS_EXHAUSTED';
  err.exhaustionBreakdown = { transient, persistent, total };
  err.transientExhaustion = transient > 0 && transient >= persistent;
  err.inputCapReport = null;
  return err;
}

test('la run 31823202761 (53 su 106) NON e\' un differimento per quota', () => {
  const err = run31823202761();
  // La premessa del difetto: il voto a monte dice «transitorio», ed e' quello
  // che ha prodotto il verde.
  assert.equal(err.transientExhaustion, true, 'premessa: il voto di maggioranza dice transitorio');
  assert.equal(isLegitimateQuotaDeferral(err), false, 'meta\' del roster non e\' «tutti i modelli esauriti»');
  const s = quotaDeferralShare(err);
  assert.equal(s.ambiguous, 1, 'la riga ambigua deve restare nel denominatore, non sparire');
  assert.equal(s.share, 53 / 106);
});

test('una notte di quota vera resta un differimento (niente rosso gratuito)', () => {
  // E' la meta' che protegge dal rumore: se ogni modello risponde «daily
  // limit», aspettare mezzanotte UTC e' la cosa giusta e la run resta verde.
  assert.equal(isLegitimateQuotaDeferral(run31823202761({ transient: 106, persistent: 0, total: 106 })), true);
  assert.equal(isLegitimateQuotaDeferral(run31823202761({ transient: 90, persistent: 10, total: 106 })), true);
});

test('la soglia e\' una maggioranza STRETTA sul totale, e si vede al confine', () => {
  // Esattamente meta' → non basta. Un errore in piu' → basta. Non e'
  // un'euristica: e' la soglia, e questi due casi la fissano.
  assert.equal(isLegitimateQuotaDeferral(run31823202761({ transient: 50, persistent: 50, total: 100 })), false);
  assert.equal(isLegitimateQuotaDeferral(run31823202761({ transient: 51, persistent: 49, total: 100 })), true);
  assert.equal(QUOTA_DEFERRAL_MIN_TRANSIENT_SHARE, 0.5);
});

test('il confronto e\' sul TOTALE, non fra i due secchi — e la differenza si misura', () => {
  // 40 transitori contro 30 persistenti: il vecchio confronto fra secchi
  // direbbe «transitorio domina» (40 >= 30). Ma sono 40 su 100, cioe' 60
  // fallimenti che una finestra di quota non ripara. Il denominatore e'
  // l'intera fix.
  const err = run31823202761({ transient: 40, persistent: 30, total: 100 });
  assert.equal(err.transientExhaustion, true, 'il vecchio criterio direbbe di differire');
  assert.equal(isLegitimateQuotaDeferral(err), false, 'il nuovo no, e per la ragione giusta');
});

test('senza denominatore non si differisce (l\'affermazione non dimostrata vale rosso)', () => {
  assert.equal(isLegitimateQuotaDeferral(run31823202761({ transient: 5, persistent: 0, total: 0 })), false);
  assert.equal(isLegitimateQuotaDeferral(null), false);
  assert.equal(isLegitimateQuotaDeferral(new Error('boom')), false);
  const other = new Error('boom');
  other.code = 'SOMETHING_ELSE';
  other.exhaustionBreakdown = { transient: 100, persistent: 0, total: 100 };
  assert.equal(isLegitimateQuotaDeferral(other), false, 'solo una cascata svuotata si differisce');
});

// ── 2. IL CABLAGGIO in create-article.mjs ──────────────────────────────────

test('le sei ragioni legittime escono TUTTE con la costante, e nessun\'altra', () => {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf8');
  // L'invariante e' la COSTANTE, non il nome della funzione che esce: dal
  // 2026-08-18 le uscite passano da `exitAfterFlush()`, che scrive il ledger
  // dei punteggi prima di terminare (`process.exit()` non fa scattare
  // `beforeExit`, quindi i successi dell'ultima finestra si perdevano). Il
  // conteggio resta 6 e il letterale resta bocciato, sotto.
  const declared = src.match(/(?:process\.exit|await exitAfterFlush)\(EXIT_NO_ARTICLE_DECLARED\)/g) || [];
  assert.equal(
    declared.length, 6,
    'le sei ragioni legittime (3 evergreen + duplicato + qualita\' + quota) devono uscire con la costante condivisa',
  );
  // Il letterale scritto a mano e' la via con cui le due meta' divergono.
  assert.ok(!/(?:process\.exit|exitAfterFlush)\(4\)/.test(src), 'nessun `process.exit(4)` letterale: solo la costante');
});

test('il differimento per quota e\' subordinato alla prova, e il ramo rosso esiste', () => {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf8');
  assert.ok(
    /if\s*\(isQuotaExhaustedError\(e\)\)/.test(src),
    'il ramo di differimento deve esistere ancora',
  );
  assert.ok(
    /if\s*\(isLegitimateQuotaDeferral\(e\)\)/.test(src),
    'e deve essere subordinato alla prova che la quota sia davvero la causa dominante',
  );
  // Il marker machine-readable e' cio' che un watchdog leggera': deve esserci.
  assert.ok(src.includes('::error::roster-down-not-deferrable:'), 'il rifiuto del differimento deve essere osservabile');
  // L'ordine: il veto per input cap resta il primo gate, altrimenti e' morto.
  const veto = src.indexOf('if (isInputCapDeferralVeto(e))');
  const quota = src.indexOf('if (isQuotaExhaustedError(e))');
  assert.ok(veto > 0 && quota > veto, 'il veto per input cap deve restare prima del ramo quota');
});

test('un\'uscita muta di main() e\' un esito, non un exit 0', () => {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf8');
  assert.ok(src.includes('::error::no-article-undeclared-exit:'), 'main() che ritorna senza dichiarare deve gridare');
  // `main().catch(...)` da solo non vede il ritorno normale: serve il `.then`.
  assert.ok(/main\(\)\s*\.then\(/.test(src), 'serve il ramo `.then` — il solo `.catch` non osserva un ritorno');
});

// ── 3. LA PROPAGAZIONE: il blocco bash VERO del workflow ───────────────────

/**
 * Estrae il `run:` dello step con `id: generate` da generate-article.yml.
 * Nessun parser YAML fra le dipendenze del corpus, e non ne serve uno: il blocco
 * e' l'ultima chiave dello step ed e' indentato in modo uniforme.
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
 * Esegue QUEL blocco con un `node` finto che esce con il codice scelto, e un
 * `timeout` finto (non esiste su ogni piattaforma, e qui non deve limitare
 * niente). `writesArticle` fa scrivere allo stub un corpo per-locale, l'unico
 * segnale che il blocco riconosce come «articolo prodotto».
 *
 * `exitPerAttempt` permette di dare codici DIVERSI ai due tentativi: e' l'unico
 * modo di provare la congiunzione «uno dichiara, l'altro no».
 *
 * Ritorna il CODICE DI USCITA del blocco. E' l'unico oracolo di questa sezione.
 */
function runGenerateBlock({
  nodeExit, exitPerAttempt = null, writesArticle = false, writesOnAttempt = 1, budgetS = '64',
}) {
  const block = extractGenerateRunBlock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-article-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // `timeout --signal=TERM --kill-after=60s <cap>s node …` → tre argomenti da
    // scartare, poi si esegue il resto.
    fs.writeFileSync(path.join(bin, 'timeout'), '#!/bin/sh\nshift 3\nexec "$@"\n');
    // Un contatore su file: lo stub e' un processo nuovo a ogni tentativo.
    const counter = path.join(dir, 'attempt-count');
    const codes = exitPerAttempt || [nodeExit, nodeExit];
    const stub = [
      '#!/bin/sh',
      `n=$(cat "${counter}" 2>/dev/null || echo 0)`,
      'n=$((n + 1))',
      `printf '%s' "$n" > "${counter}"`,
      writesArticle
        ? `if [ "$n" = "${writesOnAttempt}" ]; then mkdir -p content/blog-body/it && printf 'export default {}\\n' > content/blog-body/it/stub-article.ts; fi`
        : ':',
      `case "$n" in`,
      ...codes.map((c, i) => `  ${i + 1}) exit ${c} ;;`),
      `  *) exit ${codes[codes.length - 1]} ;;`,
      'esac',
    ].join('\n');
    fs.writeFileSync(path.join(bin, 'node'), `${stub}\n`);
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
        // Le diagnostiche del watchdog dello stallo vanno sotto RUNNER_TEMP, e
        // lo step ne fa `rm -rf` all'avvio: senza questa riga sarebbero
        // /tmp/generate-diagnostics per tutti, cioe' una cartella condivisa fra
        // i file di test che `node --test` esegue in parallelo.
        RUNNER_TEMP: dir,
        // Secondi invece di decine di minuti: il blocco stesso li espone per
        // rendere l'aritmetica del budget guidabile da un test.
        GENERATE_BUDGET_S: budgetS,
        GENERATE_HARD_KILL_S: '32',
        // Nessuno di questi scenari e' uno stallo: lo stub esce subito. Il
        // default non conterebbe comunque, ma fissare la soglia qui rende il
        // file indipendente da esso — il default vive in
        // generate-article-chain.test.mjs, che e' il posto dove cambiarlo.
        GENERATE_STALL_S: '600',
      },
    });
    return {
      status: res.status,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      outputs: fs.readFileSync(outFile, 'utf8'),
      // Il file non esiste quando lo stub non e' mai partito: e' proprio lo
      // scenario «zero tentativi», quindi l'assenza va letta come 0, non come
      // un errore dell'harness.
      attempts: fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8').trim() || 0) : 0,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('IL DIFETTO: exit 0 senza articolo NON e\' piu\' verde', () => {
  // La riga che questo file esiste per tenere ferma. Era verde, e la sua
  // verdezza e' indistinguibile da quella di una generazione riuscita.
  const r = runGenerateBlock({ nodeExit: 0 });
  assert.equal(r.status, 1, 'uscire 0 senza scrivere un corpo e senza dichiarare niente deve essere rosso');
  assert.match(r.outputs, /article=false/, 'il verdetto resta leggibile per gli step `if: always()`');
});

test('exit 4 senza articolo resta verde: e\' l\'unica eccezione', () => {
  const r = runGenerateBlock({ nodeExit: EXIT_NO_ARTICLE_DECLARED });
  assert.equal(r.status, 0, 'una ragione legittima DICHIARATA deve restare assorbita');
  assert.match(r.outputs, /article=false/);
  assert.equal(r.attempts, 2, 'la sezione gemella va comunque tentata');
});

test('i codici prima assorbiti come «no-article-this-run» ora sono rossi', () => {
  // Erano tutti verdi: e' la superficie su cui qualunque miscela di errori
  // poteva tornare, ed e' la ragione per cui la #357 non ha chiuso il difetto.
  for (const code of [1, 2, 5, 124, 137]) {
    const r = runGenerateBlock({ nodeExit: code });
    assert.equal(r.status, 1, `exit ${code} senza articolo deve essere rosso`);
  }
});

test('exit 3 (roster non serve il prompt) resta rosso — invariato dalla #357', () => {
  const r = runGenerateBlock({ nodeExit: EXIT_ROSTER_CANNOT_SERVE_PROMPT });
  assert.equal(r.status, 1);
});

test('LA CONGIUNZIONE: un articolo prodotto chiude la questione', () => {
  // Se una sezione scrive un corpo la run e' un successo qualunque cosa sia
  // successa all'altra: fallirla getterebbe via un articolo gia' pagato in LLM,
  // quattro traduzioni DeepL e un'immagine hero.
  for (const code of [EXIT_ROSTER_CANNOT_SERVE_PROMPT, 0, 1]) {
    const r = runGenerateBlock({ nodeExit: code, writesArticle: true });
    assert.equal(r.status, 0, `exit ${code} con un articolo prodotto deve restare verde`);
    assert.match(r.outputs, /article=true/);
  }
});

test('IL KILL DURO E\' L\'ECCEZIONE alla congiunzione, e deve restarlo', () => {
  // Scritto perche' la prima stesura di questo file asseriva il contrario e il
  // test l'ha colto. Il `break` su 124/137 precede di proposito la probe sul
  // corpo: `create-article.mjs` registra un articolo attraverso ~10 file, e un
  // processo ucciso a meta' puo' averne scritti alcuni — e' l'ipotesi da cui
  // nasce il `cancel-in-progress: false` del job. Contare quei byte come «un
  // articolo prodotto» pubblicherebbe un corpus scritto a meta'; non contarli
  // costa una rigenerazione al giro dopo. Il rosso e' quindi doppiamente
  // giusto: niente articolo utilizzabile, e nessuna ragione dichiarata.
  const r = runGenerateBlock({ nodeExit: 124, writesArticle: true });
  assert.equal(r.status, 1, 'un kill duro non produce un articolo, anche se ha lasciato dei byte');
  assert.match(r.outputs, /article=false/);
});

test('zero tentativi eseguiti e\' rosso, non «nessuna ragione da dichiarare»', () => {
  // Il buco che la prima stesura lasciava aperto: con `all_declared` ancora
  // `true` per vacuita', una run che non prova NEMMENO un tentativo passava
  // dritta al ramo verde. Il budget a 0 e' il modo di raggiungerlo davvero —
  // `min_attempt_s` ha un pavimento a 1, quindi il primo giro non parte.
  const r = runGenerateBlock({ nodeExit: EXIT_NO_ARTICLE_DECLARED, budgetS: '0' });
  assert.equal(r.attempts, 0, 'la premessa: nessuna invocazione di create-article.mjs');
  assert.equal(r.status, 1, 'una run che non prova nemmeno non e\' un differimento');
  // Lo step «Chain» legge `declared`, non lo status del job: con `declared`
  // rimasto vero per vacuita' avrebbe dispatchato il successore su una run che
  // non ha nemmeno invocato create-article.mjs.
  assert.match(r.outputs, /declared=false/, 'zero tentativi non e\' una dichiarazione: la Chain non deve dispatchare');
});

test('UN SOLO tentativo non dichiarato basta a far rosso il paio', () => {
  // La sezione gemella che dichiara non assolve quella che tace: sono due
  // tentativi della stessa run, e la run non ha prodotto niente.
  const r = runGenerateBlock({ exitPerAttempt: [EXIT_NO_ARTICLE_DECLARED, 1] });
  assert.equal(r.status, 1);
  assert.equal(r.attempts, 2);
});

test('ma il tentativo non dichiarato SEGUITO da un articolo resta verde', () => {
  // L'ordine opposto del test sopra, con un corpo scritto al secondo giro:
  // prova che il fallimento non e' «appiccicoso» a scapito di un articolo vero.
  const r = runGenerateBlock({ exitPerAttempt: [1, 0], writesArticle: true, writesOnAttempt: 2 });
  assert.equal(r.status, 0);
  assert.match(r.outputs, /article=true/);
});

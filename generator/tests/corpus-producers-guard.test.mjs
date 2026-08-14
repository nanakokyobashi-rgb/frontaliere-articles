/**
 * corpus-producers-guard.test.mjs — la guardia sul percorso di SCRITTURA vale
 * per OGNI produttore del corpus, e rifiuta DAVVERO.
 *
 * ## Il difetto che chiude (issue #275, residuo della DoD di #267)
 *
 * La PR #277 ha messo la coppia `article-fabrication-guard` +
 * `prompt-placeholder-guard` in due punti: il preflight di `publish-api.yml`
 * (impedisce di PUBBLICARE) e lo step di guardia di `generate-article.yml`
 * (impedisce di SCRIVERE). Il secondo copriva **un produttore su sei**: gli
 * altri cinque — `publish-journalist-articles`, `batch-faq-articles`,
 * `generate-daily-brief`, `generate-border-wait-ranking-weekly`,
 * `refresh-events-digest` — facevano `git push "$REMOTE" "HEAD:$TARGET"` su
 * `content/` senza che niente li guardasse. Misurato il 2026-08-14: zero
 * occorrenze di `article-fabrication-guard` o `prompt-placeholder-guard` nei
 * cinque file.
 *
 * La rete di `publish-api.yml` impedisce l'ANNUNCIO, non la scrittura: un
 * corpo fabbricato restava su `main`, teneva rossi i gate corpus-wide di
 * entrambi i repo, e il cron 2x/giorno di `sync-articles-sitemaps.yml` del
 * sito poteva portarlo al sito comunque, in ritardo e senza che nessuno
 * collegasse le due cose.
 *
 * ## Perche' la lista dei produttori e' DERIVATA e non scritta qui
 *
 * Una lista di sei nomi copre i sei di oggi. Il difetto che ha prodotto #275 e'
 * proprio che il settimo — o il quinto dimenticato — non fa rumore: entra in
 * silenzio, e nessun test diventa rosso.
 *
 * Qui il produttore si RICONOSCE: e' un workflow che mette in staging qualcosa
 * sotto `content/` (o fa `git add -A`) e pusha sul branch su cui gira
 * (`HEAD:$TARGET`). Chi soddisfa quella definizione deve portare la guardia.
 * Un workflow nuovo che domani scrive articoli nasce quindi ROSSO finche' non
 * la aggiunge, senza che nessuno debba ricordarsi di aggiornare questo file.
 *
 * `issue-fix.yml` fa `git add -A` ma pusha su `fix/issue-N`, un branch di PR,
 * non su `main`: non e' un produttore del corpus, ed e' la condizione sul
 * push a tenerlo fuori — non un'eccezione scritta a mano.
 *
 * ## Tre strati, e il terzo e' quello che #275 chiedeva
 *
 *   1. DERIVAZIONE — chi sono i produttori, e sono tutti guardati.
 *   2. STRUTTURA   — la guardia sta PRIMA del commit, nomina ENTRAMBE le
 *                    suite, non e' advisory, e nessuno step fra lei e il
 *                    commit ha un `always()` che la scavalcherebbe.
 *   3. RIFIUTO ESEGUITO — un corpo FABBRICATO messo su disco fa uscire !=0 il
 *                    comando esatto dello step, e il fallimento NOMINA quel
 *                    file. E' la prova che la guardia non e' decorativa: la
 *                    stessa domanda posta a #295 su un guard gemello aveva
 *                    risposto «0 rossi su 85».
 *
 * Lo strato 2 da solo pinna una forma, non un esito — ed e' esattamente cosi'
 * che un guard diventa decorativo senza che nessuno se ne accorga.
 *
 * Run with `node --test generator/tests/corpus-producers-guard.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');

/** Le due suite che la guardia DEVE invocare. Una sola dimezza il gate. */
const SUITES = ['generator/tests/article-fabrication-guard.test.mjs', 'generator/tests/prompt-placeholder-guard.test.mjs'];

/**
 * Solo le righe eseguibili. I commenti di questi workflow CITANO i difetti
 * («un corpo fabbricato arriva su main») e li descriverebbero come presenti.
 */
const activeOf = (src) =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

/** Le continuazioni di riga della shell unite: un `git add a \<nl> b` va letto intero. */
const joinContinuations = (src) => src.replace(/\\\n\s*/g, ' ');

const workflows = fs
  .readdirSync(WF_DIR)
  .filter((f) => f.endsWith('.yml'))
  .sort()
  .map((f) => {
    const src = fs.readFileSync(path.join(WF_DIR, f), 'utf8');
    return { file: f, src, active: activeOf(src), joined: joinContinuations(activeOf(src)) };
  });

/**
 * Un PRODUTTORE DEL CORPUS: mette in staging qualcosa sotto `content/` (o fa
 * `git add -A`, che lo comprende) e pusha sul branch su cui gira. Le due
 * condizioni insieme sono la definizione operativa di «questo workflow puo'
 * far atterrare un articolo su main».
 */
const isProducer = (w) =>
  (/git add[^\n]*\bcontent\//.test(w.joined) || /git add -A\b/.test(w.joined)) && /git push[^\n]*HEAD:/.test(w.joined);

const producers = workflows.filter(isProducer);

/**
 * Il corpo di uno step `run: |`. Volutamente senza parser YAML: il repo non ha
 * node_modules e questi test girano col solo `node --test`.
 */
function extractRun(src, stepNamePrefix) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`      - name: ${stepNamePrefix}`));
  if (start === -1) return null;
  const runAt = lines.findIndex((l, i) => i > start && l === '        run: |');
  if (runAt === -1) return null;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') {
      body.push('');
      continue;
    }
    if (!l.startsWith('          ')) break;
    body.push(l.slice(10));
  }
  return body.join('\n');
}

const GUARD_NAME = 'Guard —';
const guardIndexOf = (src) => src.indexOf(`      - name: ${GUARD_NAME}`);
const commitIndexOf = (src) => src.indexOf('      - name: Commit and push');

// ═══════════════════════════════════════════════════════════════════════════
// 1. DERIVAZIONE — chi scrive il corpus, e sono tutti guardati
// ═══════════════════════════════════════════════════════════════════════════

test('la derivazione trova i produttori del corpus e non passa a vuoto', () => {
  // Il pavimento anti-falso-verde: se la derivazione si rompe (una `git add`
  // riformattata, un `git push` estratto in una action) l'insieme diventa
  // vuoto e OGNI asserzione sotto passerebbe senza guardare niente.
  assert.ok(producers.length >= 6, `derivati solo ${producers.length} produttori: la derivazione e' rotta, non il repo`);
  // I sei noti al 2026-08-14. NON e' la fonte di verita' — quella e'
  // `isProducer` — ma se uno di questi sparisce dall'insieme la derivazione ha
  // smesso di vederlo, ed e' un difetto silenzioso.
  const nomi = producers.map((p) => p.file);
  for (const atteso of [
    'batch-faq-articles.yml',
    'generate-article.yml',
    'generate-border-wait-ranking-weekly.yml',
    'generate-daily-brief.yml',
    'publish-journalist-articles.yml',
    'refresh-events-digest.yml',
  ]) {
    assert.ok(nomi.includes(atteso), `${atteso} non e' piu' riconosciuto come produttore: la derivazione lo ha perso`);
  }
});

test('un workflow che pusha su un branch di PR non e\' un produttore del corpus', () => {
  // `issue-fix.yml` fa `git add -A` ma pusha su `fix/issue-N`. Se un giorno
  // finisse fra i produttori, la ragione sarebbe che ha iniziato a pushare su
  // main — e allora la guardia gli servirebbe davvero.
  const issueFix = workflows.find((w) => w.file === 'issue-fix.yml');
  assert.ok(issueFix, 'issue-fix.yml non esiste piu\': aggiornare questo test');
  assert.ok(!isProducer(issueFix), 'issue-fix.yml pusha su main? allora deve portare la guardia');
});

test('OGNI produttore del corpus ha lo step di guardia', () => {
  const senza = producers.filter((p) => guardIndexOf(p.src) === -1).map((p) => p.file);
  assert.deepEqual(
    senza,
    [],
    `${senza.length} produttori scrivono su main senza la coppia di guardie fra la scrittura e il push.\n` +
      'Ognuno va coperto con lo step `Guard — …` (vedi gli altri), oppure smette di pushare su main.\n  ' +
      senza.join('\n  '),
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. STRUTTURA — la forma che rende la guardia capace di fermare il commit
// ═══════════════════════════════════════════════════════════════════════════

for (const p of producers) {
  test(`${p.file}: la guardia invoca ENTRAMBE le suite`, () => {
    const guard = extractRun(p.src, GUARD_NAME);
    assert.ok(guard, `blocco run della guardia non estraibile in ${p.file}`);
    for (const suite of SUITES) {
      assert.ok(
        guard.includes(suite),
        `${p.file}: la guardia non invoca ${suite}. Le due suite coprono classi diverse ` +
          '(allucinazioni vs segnaposto del prompt): una sola dimezza il gate senza dirlo',
      );
    }
  });

  test(`${p.file}: la guardia gira PRIMA del commit, non dopo`, () => {
    const g = guardIndexOf(p.src);
    const c = commitIndexOf(p.src);
    assert.notEqual(c, -1, `${p.file}: step di commit non trovato`);
    assert.ok(
      g < c,
      `${p.file}: una guardia dopo il commit non impedisce niente — l'articolo sarebbe gia' su main, ` +
        'e il cron 2x/giorno del sync del sito potrebbe portarlo al sito comunque',
    );
  });

  test(`${p.file}: la guardia non e' advisory e nessuno step la scavalca`, () => {
    const g = guardIndexOf(p.src);
    const c = commitIndexOf(p.src);
    const block = p.src.slice(g, c);
    assert.ok(
      !/continue-on-error/.test(block),
      `${p.file}: con continue-on-error lo step diventa decorazione — fallisce, si vede rosso, e il commit parte lo stesso`,
    );
    // Gli step successivi hanno un `if:` senza status function, quindi GitHub
    // applica `success()` implicito: uno step fallito qui li salta. E' quella
    // proprieta' a impedire il commit, quindi va pinnata la sua PRECONDIZIONE.
    assert.ok(
      !/if:\s*always\(\)/.test(block),
      `${p.file}: un always() fra la guardia e il commit rimetterebbe l'articolo bocciato sulla strada di main`,
    );
  });

  test(`${p.file}: il blocco della guardia non interpola nulla`, () => {
    const guard = extractRun(p.src, GUARD_NAME);
    assert.ok(
      !/\$\{\{/.test(guard),
      `${p.file}: un'interpolazione \${{ }} nel blocco e' shell injection, e rende il blocco non eseguibile qui`,
    );
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3a. RIFIUTO ESEGUITO — il blocco della guardia, eseguito davvero
// ═══════════════════════════════════════════════════════════════════════════
//
// Una regex su «c'e' un exit 1» passa anche su un blocco che non lo raggiunge
// mai. I due comportamenti che contano si dimostrano solo eseguendo:
//
//   · corpus PULITO in questo run → esce 0 senza nemmeno lanciare le suite.
//     E' la condizione che impedisce a un produttore di morire su un difetto
//     che non ha scritto lui. Se venisse scritta male al contrario — «salta
//     sempre» — la guardia sarebbe disarmata su tutti e cinque, e nessuna
//     asserzione strutturale se ne accorgerebbe.
//   · corpus SCRITTO + suite rosse → esce !=0. E' il rifiuto.
//
// `node` viene stubbato: qui si prova il blocco, non le suite (quelle sono
// provate sul serio in 3b).

/**
 * L'ambiente per un `node --test` FIGLIO.
 *
 * ATTENZIONE, ed e' il difetto che questo test ha prodotto su se stesso al
 * primo giro: `node --test` esporta `NODE_TEST_CONTEXT=child-v8`, e un
 * `node --test` che lo trova nell'ambiente stampa «run() is being called
 * recursively within a test file. skipping running files» ed **esce 0 in 50
 * millisecondi senza eseguire niente**. Ereditando l'ambiente, l'asserzione
 * «il comando della guardia fallisce» sarebbe stata verde per la ragione
 * opposta a quella cercata: non perche' la guardia boccia, ma perche' non ha
 * mai girato. E' la forma esatta del guard vacuo di #295, riprodotta dentro il
 * test che serve a escluderla.
 */
function childTestEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST_')) delete env[k];
  return env;
}

/** Un repo git usa e getta, con `content/` dentro. */
function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-block-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test']);
  fs.mkdirSync(path.join(dir, 'content'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'content', 'seed.ts'), 'export const seed = 1;\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'seed']);
  return dir;
}

/** Esegue il blocco con un finto `node` che esce `nodeExit`. */
function runGuardBlock(block, { dir, nodeExit }) {
  const bin = path.join(dir, '.stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  const stub = path.join(bin, 'node');
  fs.writeFileSync(stub, `#!/bin/sh\necho "stub node $*" >> "${path.join(dir, 'node-calls.log')}"\nexit ${nodeExit}\n`);
  fs.chmodSync(stub, 0o755);
  const summary = path.join(dir, 'summary.md');
  fs.writeFileSync(summary, '');
  const script = path.join(dir, 'guard.sh');
  fs.writeFileSync(script, block);
  const res = { status: 0, stdout: '' };
  try {
    // `bash -e`, non `sh`: e' la shell che GitHub usa davvero per un `run:`
    // (`bash -e {0}`), e la differenza non e' teorica — su Linux `/bin/sh` e'
    // dash, dove `set -o pipefail` e' un errore di sintassi e il blocco esce 2
    // PRIMA di arrivare al probe. Il test sarebbe stato rosso in CI e verde su
    // macOS (dove sh e' bash), cioe' avrebbe misurato la shell del runner
    // invece della guardia.
    res.stdout = execFileSync('/bin/bash', ['-e', script], {
      cwd: dir,
      encoding: 'utf8',
      env: childTestEnv({ PATH: `${bin}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary }),
    });
  } catch (e) {
    res.status = e.status;
    res.stdout = `${e.stdout || ''}${e.stderr || ''}`;
  }
  res.summary = fs.readFileSync(summary, 'utf8');
  res.nodeCalls = fs.existsSync(path.join(dir, 'node-calls.log')) ? fs.readFileSync(path.join(dir, 'node-calls.log'), 'utf8') : '';
  return res;
}

for (const p of producers.filter((x) => x.file !== 'generate-article.yml')) {
  // `generate-article.yml` e' escluso da questo strato e da nessun altro: la
  // sua guardia e' condizionata a `steps.generate.outputs.article`, un output
  // di GitHub Actions che non esiste dentro il blocco shell — la sua
  // equivalente e' gia' pinnata in generate-article-chain.test.mjs.
  test(`${p.file}: senza scritture sotto content/ la guardia esce 0 e non scansiona`, () => {
    const dir = makeTempRepo();
    try {
      const res = runGuardBlock(extractRun(p.src, GUARD_NAME), { dir, nodeExit: 1 });
      assert.equal(res.status, 0, `${p.file}: un run che non tocca content/ non deve morire su un difetto altrui`);
      assert.equal(res.nodeCalls, '', `${p.file}: le suite sono state lanciate su un corpus che questo run non ha toccato`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${p.file}: con una scrittura sotto content/ e suite rosse la guardia esce !=0`, () => {
    const dir = makeTempRepo();
    try {
      fs.writeFileSync(path.join(dir, 'content', 'nuovo-articolo.ts'), 'export const x = 1;\n');
      const res = runGuardBlock(extractRun(p.src, GUARD_NAME), { dir, nodeExit: 1 });
      assert.notEqual(res.status, 0, `${p.file}: la guardia ha lasciato passare una scrittura con le suite rosse`);
      for (const suite of SUITES) {
        assert.ok(res.nodeCalls.includes(suite), `${p.file}: ${suite} non e' stata lanciata sulla scrittura`);
      }
      assert.match(res.summary, /RIFIUTATA/, `${p.file}: il rifiuto non arriva nel job summary, quindi nessuno lo vede`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${p.file}: con una scrittura sotto content/ e suite verdi la guardia esce 0`, () => {
    const dir = makeTempRepo();
    try {
      fs.writeFileSync(path.join(dir, 'content', 'nuovo-articolo.ts'), 'export const x = 1;\n');
      const res = runGuardBlock(extractRun(p.src, GUARD_NAME), { dir, nodeExit: 0 });
      assert.equal(res.status, 0, `${p.file}: una scrittura pulita non deve essere bloccata`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3b. RIFIUTO ESEGUITO — un corpo FABBRICATO, sul corpus vero
// ═══════════════════════════════════════════════════════════════════════════
//
// E' il test che #275 chiede per nome: «un corpo FABBRICATO passato dal punto
// di scrittura, e la verifica che venga rifiutato». Qui il corpo viene scritto
// dove i produttori lo scrivono (`content/blog-body/it/<id>.ts`) e viene
// lanciato il comando ESATTO dello step di guardia. Se esce 0, la guardia e'
// decorativa e questo test e' rosso.
//
// Le due stringhe piantate sono reali: `LTL 1995` e' l'acronimo inventato che
// il 2026-08-11 ha tenuto rosso `main` DEL SITO per ~13 ore bloccando sei PR,
// e la FAQ segnaposto e' quella che 24 articoli hanno pubblicato come
// FAQPage JSON-LD con «Domanda frequente 1» al posto di una domanda.
//
// PULIZIA: il file vive in `finally`. Se questo processo venisse ucciso in
// mezzo, resterebbe un file NON tracciato in un checkout usa e getta — mai un
// commit, perche' nessuno step di questi workflow fa `git add` durante un test.

test('un corpo FABBRICATO piantato sul corpus fa fallire il comando della guardia, e lo NOMINA', () => {
  const id = `zz-guard-e2e-${process.pid}-${Date.now()}`;
  const file = path.join(ROOT, 'content', 'blog-body', 'it', `${id}.ts`);
  assert.ok(fs.existsSync(path.dirname(file)), 'content/blog-body/it non esiste: checkout sparse, questo test non e\' eseguibile qui');
  assert.ok(!fs.existsSync(file), 'collisione di id: il file di prova esiste gia\'');

  const faqSegnaposto = JSON.stringify([
    { q: "Domanda frequente 1 basata sui fatti dell'articolo?", a: 'Risposta con dati DALLA FONTE. 50-100 parole.' },
    { q: 'Domanda frequente 2?', a: 'Risposta pratica basata sulla fonte.' },
  ]).replace(/'/g, "\\'");

  const corpo =
    'export const blogBodyItTest: Record<string, string> = {\n' +
    `    'blog.article.${id}.body1': 'Secondo la LTL 1995 il frontaliere deve annunciarsi entro trenta giorni. ` +
    "L\\'Ufficio federale del lavoro transfrontaliero conferma la procedura. Max 125 char',\n" +
    `    'blog.article.${id}.faq': '${faqSegnaposto}',\n` +
    '};\nexport default blogBodyItTest;\n';

  let res;
  try {
    fs.writeFileSync(file, corpo);
    try {
      execFileSync(process.execPath, ['--test', ...SUITES], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', env: childTestEnv() });
      res = { status: 0, out: '' };
    } catch (e) {
      res = { status: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  } finally {
    fs.rmSync(file, { force: true });
  }

  assert.notEqual(
    res.status,
    0,
    'il comando della guardia e\' uscito 0 con un corpo fabbricato sul corpus: la guardia e\' DECORATIVA — ' +
      'e\' la stessa risposta che #295 ha misurato sul guard gemello (0 rossi su 85)',
  );
  // LA CAUSALITA', senza pagare un secondo giro da 5 secondi su corpus pulito:
  // il fallimento deve NOMINARE il file piantato. Un corpus gia' rotto per
  // conto suo farebbe uscire !=0 lo stesso, e l'asserzione sopra passerebbe
  // senza che questa guardia abbia visto il corpo fabbricato.
  assert.ok(
    res.out.includes(id),
    `il fallimento non nomina ${id}: la guardia e' rossa per un'altra ragione, e questo test starebbe passando per caso`,
  );
  // Il rifiuto e' leggibile: chi apre il log deve capire QUALE classe ha
  // bocciato, altrimenti un articolo scartato in silenzio e' un articolo perso.
  assert.match(res.out, /LTL|acronimi|fabricated/i, 'il log non dice che la classe allucinazioni ha bocciato');
  assert.match(res.out, /segnaposto|placeholder|Domanda frequente/i, 'il log non dice che la classe segnaposto ha bocciato');
});

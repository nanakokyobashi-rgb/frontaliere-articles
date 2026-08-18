/**
 * scripts/ci/check-blog-body-syntax.mjs — suite del gate.
 *
 * PORTATO da valerielinc-ops/frontaliere-si-o-no `tests/blog-body-typescript-syntax.test.ts`,
 * ma NON come copia: la' il gate E' il test, qui il gate e' un eseguibile e il
 * test copre la sua logica. La ragione e' misurata e sta nell'intestazione dello
 * script — fino al 2026-08-18 `tests.yml` girava su `pull_request` e
 * `push: branches-ignore: [main]`, mentre gli articoli atterrano per push diretto
 * su main, quindi un gate scritto come test di PR non vedrebbe mai un articolo.
 * (Da quella data il `branches-ignore` non c'e' piu' — serve il VERDETTO su
 * `main` a `mainTestsRuns()` di `pr-autorebase.mjs` — ma la diagnosi sul
 * contenuto generato resta separata, in
 * `.github/workflows/content-gates-main.yml`.)
 *
 * ## Cosa copre questa suite, e cosa NO
 *
 * NON esegue la scansione vera dei 15k corpi: richiede esbuild, e questo repo
 * gira `node --test` senza `node_modules` per progetto. La scansione vera vive
 * in `publish-api.yml`, che e' l'unico posto dove ha senso.
 *
 * Copre invece le tre cose che possono rendere quel gate DECORATIVO senza che
 * nessuno se ne accorga, che sono la parte davvero fragile:
 *   1. i pavimenti anti-falso-verde (compreso quello per radice, che e' l'unico
 *      a vedere una delle due radici sparire);
 *   2. il fatto che l'assenza del parser sia un ERRORE e non uno skip;
 *   3. il fatto che publish-api.yml lo invochi davvero, con l'env che gli serve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BLOG_BODY_ROOTS,
  MIN_FILES_TOTAL,
  collectTypeScriptFiles,
  filesToScan,
  floorViolations,
  formatOffender,
  loadEsbuild,
  parseChangedFiles,
} from '../../scripts/ci/check-blog-body-syntax.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const GATE = path.join(ROOT, 'scripts/ci/check-blog-body-syntax.mjs');
const WORKFLOW = path.join(ROOT, '.github/workflows/publish-api.yml');

// ── I pavimenti ─────────────────────────────────────────────────────────────

test('conteggi realistici non producono violazioni', () => {
  // I numeri misurati su origin/main il 2026-08-09.
  const perRoot = [
    { rel: 'content/blog-body', minFiles: 3000, count: 12548 },
    { rel: 'content/blog-body-ch', minFiles: 1000, count: 2596 },
  ];
  assert.deepEqual(floorViolations(perRoot), []);
});

test('un checkout sparse (zero file ovunque) fa fallire il gate', () => {
  // In un worktree sparse `content/` non esiste affatto. E' il falso verde piu'
  // facile da produrre su questo repo, e il gate deve rifiutarsi di dirsi verde.
  const perRoot = BLOG_BODY_ROOTS.map((r) => ({ ...r, count: 0 }));
  const v = floorViolations(perRoot);
  assert.equal(v.length, 3, 'due radici a zero + il totale a zero');
  assert.ok(v.some((m) => m.startsWith('TOTALE:')), 'il pavimento totale deve scattare');
});

test('UNA sola radice a zero fa fallire, anche se il totale abbonda', () => {
  // È l'asserzione che il pavimento sul totale NON puo' fare, ed e' esattamente
  // il buco del 2026-07-29: blog-body da solo fa 12.5k file, quindi qualunque
  // soglia sul totale resta soddisfatta anche se blog-body-ch risolve a zero —
  // cartella rinominata, symlink orfano — e la sezione svizzera tornerebbe
  // scoperta con la CI verde.
  const perRoot = [
    { rel: 'content/blog-body', minFiles: 3000, count: 12548 },
    { rel: 'content/blog-body-ch', minFiles: 1000, count: 0 },
  ];
  const v = floorViolations(perRoot);
  assert.equal(v.length, 1);
  assert.match(v[0], /^content\/blog-body-ch: 0 file scanditi/);
  assert.ok(
    !v.some((m) => m.startsWith('TOTALE:')),
    'il totale qui e\' soddisfatto: e\' proprio il motivo per cui il pavimento per radice esiste',
  );
});

test('il pavimento totale e\' almeno 3000 e ogni radice ne ha uno', () => {
  assert.ok(MIN_FILES_TOTAL >= 3000, `pavimento totale ${MIN_FILES_TOTAL}: troppo basso`);
  assert.ok(BLOG_BODY_ROOTS.length >= 2, 'entrambe le radici devono essere sorvegliate');
  for (const r of BLOG_BODY_ROOTS) {
    assert.ok(r.minFiles > 0, `${r.rel}: un pavimento a 0 non e\' un pavimento`);
  }
  assert.deepEqual(
    BLOG_BODY_ROOTS.map((r) => r.rel).sort(),
    ['content/blog-body', 'content/blog-body-ch'],
    'le due radici dei corpi di questo repo',
  );
});

// ── La raccolta dei file ────────────────────────────────────────────────────

test('collectTypeScriptFiles ricorre, prende solo .ts, e su una radice assente ritorna []', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-body-gate-'));
  try {
    fs.mkdirSync(path.join(dir, 'it'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'fr', 'annidata'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'it', 'uno.ts'), 'export default ``;');
    fs.writeFileSync(path.join(dir, 'fr', 'due.ts'), 'export default ``;');
    fs.writeFileSync(path.join(dir, 'fr', 'annidata', 'tre.ts'), 'export default ``;');
    fs.writeFileSync(path.join(dir, 'fr', 'non-un-corpo.json'), '{}');
    fs.writeFileSync(path.join(dir, 'fr', 'nemmeno.tsx'), 'x');

    const found = collectTypeScriptFiles(dir).map((f) => path.relative(dir, f)).sort();
    assert.deepEqual(found, ['fr/annidata/tre.ts', 'fr/due.ts', 'it/uno.ts']);

    assert.deepEqual(collectTypeScriptFiles(path.join(dir, 'non-esiste')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Lo scoping ai corpi toccati dal push ────────────────────────────────────

test('parseChangedFiles scarta righe vuote, input assente => []', () => {
  assert.deepEqual(parseChangedFiles(''), []);
  assert.deepEqual(parseChangedFiles(undefined), []);
  assert.deepEqual(
    parseChangedFiles('content/blog-body/it/uno.ts\n\ncontent/blog-body-ch/fr/due.ts\n'),
    ['content/blog-body/it/uno.ts', 'content/blog-body-ch/fr/due.ts'],
  );
});

test('filesToScan: scanMode diverso da "changed" e\' SEMPRE scansione piena', () => {
  const perRoot = [
    { rel: 'content/blog-body', files: [path.join(ROOT, 'content/blog-body/it/a.ts')] },
    { rel: 'content/blog-body-ch', files: [path.join(ROOT, 'content/blog-body-ch/fr/b.ts')] },
  ];
  assert.deepEqual(filesToScan(perRoot, { scanMode: 'full' }), perRoot.flatMap((r) => r.files));
  assert.deepEqual(filesToScan(perRoot, {}), perRoot.flatMap((r) => r.files), 'default = piena');
  assert.deepEqual(
    filesToScan(perRoot, { scanMode: 'qualunque-altra-cosa', changedFiles: [] }),
    perRoot.flatMap((r) => r.files),
    'solo scanMode === "changed" scopa, ogni altro valore e\' scansione piena a prescindere da changedFiles',
  );
});

test('filesToScan: scanMode "changed" intersects con changedFiles', () => {
  const a = path.join(ROOT, 'content/blog-body/it/a.ts');
  const b = path.join(ROOT, 'content/blog-body/it/b.ts');
  const c = path.join(ROOT, 'content/blog-body-ch/fr/c.ts');
  const perRoot = [
    { rel: 'content/blog-body', files: [a, b] },
    { rel: 'content/blog-body-ch', files: [c] },
  ];
  const result = filesToScan(perRoot, {
    scanMode: 'changed',
    changedFiles: ['content/blog-body/it/b.ts', 'content/blog-body-ch/fr/nonesiste.ts'],
  });
  assert.deepEqual(result, [b], 'solo i file sia raccolti che nel diff, un path assente non produce nulla');
});

test('filesToScan: "changed" con lista vuota e\' un push legittimo che non tocca corpi, non un fallback', () => {
  const perRoot = [{ rel: 'content/blog-body', files: [path.join(ROOT, 'content/blog-body/it/a.ts')] }];
  assert.deepEqual(filesToScan(perRoot, { scanMode: 'changed', changedFiles: [] }), []);
});

// ── Il parser: assente = errore, MAI skip ───────────────────────────────────

test('senza esbuild il gate LANCIA, invece di dichiararsi saltato', () => {
  // La differenza con `scripts/ci/lib/mergePreviewCheck.mjs`, che se `typescript`
  // manca si dichiara saltato: la' e' un check advisory al merge, qui e' un gate
  // di pubblicazione. Uno skip su un gate e' il falso verde perfetto — verde
  // perche' non ha guardato niente. Se qualcuno un giorno "ripara" questo gate
  // rendendolo saltabile, questo test si mette di traverso.
  const vuota = fs.mkdtempSync(path.join(os.tmpdir(), 'no-esbuild-'));
  try {
    assert.throws(
      () => loadEsbuild(vuota),
      (err) => {
        assert.match(err.message, /esbuild non risolvibile/);
        assert.match(err.message, /PREFLIGHT_ESBUILD_DIR/);
        return true;
      },
    );
  } finally {
    fs.rmSync(vuota, { recursive: true, force: true });
  }
});

test('il gate non importa esbuild staticamente', () => {
  // `generator/tests/loop-scripts-closure.test.mjs` rifiuta gli import di
  // pacchetti non dichiarati in package.json per tutto scripts/ci/, perche' il
  // ciclo gira senza `npm ci`. esbuild non e' fra le dipendenze e non deve
  // diventarlo: verrebbe installato a ogni merge insieme a playwright, sharp e
  // transformers. La risoluzione a runtime e' quello che tiene le due cose
  // insieme, e trasformarla in un import statico romperebbe l'altro guard —
  // con un messaggio che non spiega perche'. Questo lo spiega.
  const src = fs.readFileSync(GATE, 'utf8');
  const statico = src
    .split('\n')
    .filter((l) => /^\s*import\s+(?:.*?\s+from\s+)?['"]esbuild['"]/.test(l));
  assert.deepEqual(
    statico,
    [],
    'esbuild va risolto a runtime (createRequire), non importato staticamente.',
  );
});

test('formatOffender riporta il path relativo e i messaggi di esbuild', () => {
  const out = formatOffender(path.join(ROOT, 'content/blog-body/fr/x.ts'), {
    errors: [{ text: "Expected identifier but found \"'\"" }],
  });
  assert.equal(out, 'content/blog-body/fr/x.ts\nExpected identifier but found "\'"');
});

// ── Il cablaggio: il gate deve essere davvero invocato ──────────────────────

test('publish-api.yml esegue il gate, e gli passa la directory del parser', () => {
  // La meta' della fix che marcisce per prima e' sempre il rewire: uno script di
  // gate che nessuno invoca e' lo stesso difetto con un file in piu'.
  const src = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(
    src,
    /node scripts\/ci\/check-blog-body-syntax\.mjs/,
    'publish-api.yml non invoca piu\' il gate: i corpi rotti tornano a detonare sul sito',
  );
  assert.match(
    src,
    /PREFLIGHT_ESBUILD_DIR:/,
    'senza PREFLIGHT_ESBUILD_DIR il gate non trova il parser e fallisce ogni pubblicazione',
  );
  assert.match(
    src,
    /esbuild@\d+\.\d+\.\d+/,
    'il parser va pinnato a una versione esatta: un gate che cambia oracolo da solo puo\' ' +
      'iniziare a fermare le pubblicazioni senza che nessuno abbia toccato una riga',
  );

  // Il gate deve stare PRIMA del build: un corpo rotto si scopre in una decina
  // di secondi, senza montare segreti ne' produrre un artefatto da buttare.
  //
  // Si cerca l'INVOCAZIONE, non il path nudo: `scripts/build-api.mjs` compare
  // anche nel filtro `paths:` in cima al file, quindi un indexOf sul path
  // trovava la riga del trigger e l'ordine risultava sempre sbagliato. Preso
  // da questo stesso test alla prima esecuzione.
  const iGate = src.indexOf('node scripts/ci/check-blog-body-syntax.mjs');
  const iBuild = src.indexOf('npx -y tsx@4 scripts/build-api.mjs');
  assert.ok(iGate > 0, 'invocazione del gate non trovata');
  assert.ok(iBuild > 0, 'invocazione del build non trovata');
  assert.ok(iGate < iBuild, 'il preflight deve precedere la costruzione della superficie dati');
});

test('publish-api.yml scopa il preflight ai corpi toccati, con fallback esplicito', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');

  assert.match(
    src,
    /fetch-depth:\s*0/,
    'senza fetch-depth: 0 github.event.before non e\' raggiungibile e lo scoping degrada sempre a piena',
  );
  assert.match(
    src,
    /Determine which article bodies this push touched/,
    'manca lo step che calcola il diff sui corpi per lo scoping',
  );
  assert.match(
    src,
    /PREFLIGHT_SCAN_MODE:\s*\$\{\{\s*steps\.changed-bodies\.outputs\.scan-mode\s*\}\}/,
    'il preflight non riceve la modalita\' di scansione calcolata dallo step precedente',
  );
  assert.match(
    src,
    /PREFLIGHT_CHANGED_FILES:\s*\$\{\{\s*steps\.changed-bodies\.outputs\.changed-files\s*\}\}/,
    'il preflight non riceve la lista dei corpi cambiati calcolata dallo step precedente',
  );

  // Il fallback su scansione piena, mai su lista vuota, e' l'invariante che
  // impedisce a un corpo nuovo rotto di passare inosservato quando il diff
  // non e' calcolabile (workflow_dispatch, before assente/irraggiungibile).
  assert.match(src, /scan_mode="full"/, 'il default dello step deve essere la scansione piena');
  assert.match(
    src,
    /git cat-file -e "\$\{BEFORE\}\^\{commit\}"/,
    'before va verificato raggiungibile prima di calcolare il diff, altrimenti si ricade su scansione piena',
  );

  const iDetermine = src.indexOf('Determine which article bodies this push touched');
  const iGate = src.indexOf('node scripts/ci/check-blog-body-syntax.mjs');
  assert.ok(iDetermine > 0 && iGate > 0 && iDetermine < iGate, 'il diff va calcolato prima di invocare il gate');
});

test('il job di pubblicazione ha un tetto di tempo', () => {
  // La concurrency `publish-api` non cancella (`cancel-in-progress: false`):
  // senza tetto un job appeso non fallisce, mette in coda ogni pubblicazione
  // successiva dietro di se', per il default di GitHub che e' SEI ORE.
  const src = fs.readFileSync(WORKFLOW, 'utf8');
  const m = /^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(src);
  assert.ok(m, 'publish-api.yml non ha timeout-minutes');
  assert.ok(Number(m[1]) <= 60, `timeout-minutes ${m[1]}: troppo alto per un job da ~45s`);
});

// ── Integrazione vera, solo se il parser c'e' ───────────────────────────────

test('scansione reale dei corpi (solo se PREFLIGHT_ESBUILD_DIR e\' impostata)', async (t) => {
  // Volutamente opt-in: in `tests.yml` non c'e' esbuild, e la scansione vera ha
  // casa in publish-api.yml. Serve a poter rieseguire in locale l'oracolo esatto
  // del gate — non a sostituirlo.
  if (!process.env.PREFLIGHT_ESBUILD_DIR) {
    t.skip('PREFLIGHT_ESBUILD_DIR non impostata: la scansione vera gira in publish-api.yml');
    return;
  }
  const esbuild = loadEsbuild();
  const files = BLOG_BODY_ROOTS.flatMap((r) => collectTypeScriptFiles(path.join(ROOT, r.rel)));
  assert.ok(files.length > MIN_FILES_TOTAL, `solo ${files.length} corpi trovati`);

  const failures = [];
  for (let i = 0; i < files.length; i += 500) {
    const res = await Promise.all(
      files.slice(i, i + 500).map(async (f) => {
        try {
          await esbuild.transform(fs.readFileSync(f, 'utf8'), {
            loader: 'ts',
            format: 'esm',
            target: 'es2022',
          });
          return null;
        } catch (err) {
          return formatOffender(f, err);
        }
      }),
    );
    for (const r of res) if (r) failures.push(r);
  }
  assert.deepEqual(failures, [], `Corpi non parsanti:\n${failures.slice(0, 10).join('\n\n')}`);
});

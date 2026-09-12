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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BLOG_BODY_ROOTS,
  collectTypeScriptFiles,
  deriveFloorModel,
  filesToScan,
  floorViolations,
  formatOffender,
  loadEsbuild,
  parseChangedFiles,
  run,
} from '../../scripts/ci/check-blog-body-syntax.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const GATE = path.join(ROOT, 'scripts/ci/check-blog-body-syntax.mjs');
const WORKFLOW = path.join(ROOT, '.github/workflows/publish-api.yml');

// Questa e' la forma unica della guardia: deve riconoscere import/export
// statici, anche braced su piu' righe, ma non una stringa `esbuild` in coda a
// un commento sulla riga di un import builtin.
const STATIC_ESBUILD_RE = /^\s*(?:import|export)(?:\s|(?=[{*'"]))(?:(?:[^'";]*?[\s}*]from\s*)?['"]esbuild['"])/gm;
const LOCAL_IMPORT_RE = /^\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"](\.\.?\/[^'"]+)['"]/gm;
const LOCAL_MODULE_EXTENSIONS = ['', '.mjs', '.js', '.cjs'];

function staticEsbuildImports(source) {
  return [...String(source).matchAll(STATIC_ESBUILD_RE)].map((match) => match[0]);
}

function resolveLocalModule(importer, specifier) {
  const raw = path.resolve(path.dirname(importer), specifier);
  const candidates = path.extname(raw)
    ? [raw]
    : LOCAL_MODULE_EXTENSIONS.map((extension) => `${raw}${extension}`);
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || null;
}

function collectLocalModuleSources(entry) {
  const queue = [entry];
  const seen = new Set();
  const modules = [];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    modules.push({ file, source });
    for (const match of source.matchAll(LOCAL_IMPORT_RE)) {
      const dependency = resolveLocalModule(file, match[1]);
      if (dependency && !seen.has(dependency)) queue.push(dependency);
    }
  }
  return modules;
}

// ── I pavimenti ─────────────────────────────────────────────────────────────

test('conteggi realistici non producono violazioni', () => {
  const model = deriveFloorModel(ROOT);
  const perRoot = model.perRoot.map((r) => ({ ...r, count: r.expectedFiles }));
  assert.deepEqual(floorViolations(perRoot), []);
});

test('un checkout sparse (zero file ovunque) fa fallire il gate', () => {
  // In un worktree sparse `content/` non esiste affatto. E' il falso verde piu'
  // facile da produrre su questo repo, e il gate deve rifiutarsi di dirsi verde.
  const model = deriveFloorModel(ROOT);
  const perRoot = model.perRoot.map((r) => ({ ...r, count: 0 }));
  const v = floorViolations(perRoot);
  assert.equal(v.length, 3, 'due radici a zero + il totale a zero');
  assert.ok(v.some((m) => m.startsWith('TOTALE:')), 'il pavimento totale deve scattare');
});

test('UNA sola radice a zero fa fallire, anche se il totale abbonda', () => {
  // Il pavimento per radice deve vedere la sezione svizzera sparire anche se
  // l'altra radice resta piena; il totale derivato deve inoltre vedere che la
  // fotografia complessiva e' incompleta.
  const model = deriveFloorModel(ROOT);
  const perRoot = model.perRoot.map((r, index) => ({
    ...r,
    count: index === 0 ? r.expectedFiles : 0,
  }));
  const v = floorViolations(perRoot);
  assert.equal(v.length, 2);
  assert.ok(v.some((m) => /^content\/blog-body-ch: 0 file scanditi/.test(m)));
  assert.ok(
    v.some((m) => m.startsWith('TOTALE:')),
    'il totale derivato deve scattare quando manca una sezione intera',
  );
});

test('i pavimenti derivano dai registri moltiplicati per i locali presenti', () => {
  assert.equal(BLOG_BODY_ROOTS.length, 2, 'entrambe le radici devono essere sorvegliate');
  assert.deepEqual(
    BLOG_BODY_ROOTS.map((r) => r.rel).sort(),
    ['content/blog-body', 'content/blog-body-ch'],
    'le due radici dei corpi di questo repo',
  );
  assert.ok(BLOG_BODY_ROOTS.every((r) => r.section), 'ogni radice deve avere una sezione derivabile');
  const model = deriveFloorModel(ROOT);
  assert.ok(model.perRoot.every((r) => r.expectedFiles > 0));
  assert.equal(
    model.expectedTotal,
    model.perRoot.reduce((sum, r) => sum + r.expectedFiles, 0),
  );
  const source = fs.readFileSync(GATE, 'utf8');
  assert.doesNotMatch(source, /MIN_FILES_TOTAL|\bminFiles\s*:/, 'il gate non deve contenere soglie assolute');
});

test('il modello non conta la directory del gate e rifiuta un riferimento assente', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-body-floor-reference-'));
  try {
    const content = path.join(dir, 'content');
    fs.mkdirSync(path.join(content, 'blog-body', 'it'), { recursive: true });
    fs.writeFileSync(path.join(content, 'blog-body', 'it', 'extra.ts'), 'export default ``;');
    fs.writeFileSync(path.join(content, 'blog-articles-data.ts'), "id: 'a'\nid: 'b'\n");
    fs.writeFileSync(path.join(content, 'swiss-articles-data.ts'), "id: 's'\n");
    for (const locale of ['it', 'en', 'de', 'fr']) {
      fs.writeFileSync(
        path.join(content, `blog-meta-${locale}.ts`),
        "'blog.article.a.title': 'A',\n'blog.article.b.title': 'B',\n",
      );
      fs.writeFileSync(
        path.join(content, `blog-meta-ch-${locale}.ts`),
        "'blog.article.s.title': 'S',\n",
      );
    }

    const model = deriveFloorModel(dir);
    assert.deepEqual(model.perRoot.map((r) => r.expectedFiles), [8, 4]);

    const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-body-floor-missing-'));
    try {
      fs.mkdirSync(path.join(missing, 'content'), { recursive: true });
      const errors = [];
      const status = await run({ root: missing, log() {}, error: (message) => errors.push(message), env: {} });
      assert.equal(status, 1);
      assert.match(errors.join('\n'), /riferimento del pavimento assente/);
      assert.throws(() => deriveFloorModel(missing), /content\/blog-articles-data\.ts/);
    } finally {
      fs.rmSync(missing, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('un registro troncato viene confrontato con il high-water della revisione precedente', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-body-floor-history-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  const writeCorpus = (frontIds, swissIds) => {
    fs.writeFileSync(
      path.join(dir, 'content', 'blog-articles-data.ts'),
      frontIds.map((id) => `id: '${id}'`).join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(dir, 'content', 'swiss-articles-data.ts'),
      swissIds.map((id) => `id: '${id}'`).join('\n') + '\n',
    );
    for (const locale of ['it', 'en', 'de', 'fr']) {
      fs.writeFileSync(
        path.join(dir, 'content', `blog-meta-${locale}.ts`),
        frontIds.map((id) => `'blog.article.${id}.title': 'A',`).join('\n') + '\n',
      );
      fs.writeFileSync(
        path.join(dir, 'content', `blog-meta-ch-${locale}.ts`),
        swissIds.map((id) => `'blog.article.${id}.title': 'S',`).join('\n') + '\n',
      );
    }
  };

  try {
    fs.mkdirSync(path.join(dir, 'content'), { recursive: true });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    writeCorpus(Array.from({ length: 10 }, (_, i) => `front-${i}`), ['swiss-0']);
    git('add', 'content');
    git('commit', '-qm', 'complete corpus');
    writeCorpus(Array.from({ length: 5 }, (_, i) => `front-${i}`), ['swiss-0']);
    git('add', 'content');
    git('commit', '-qm', 'truncated corpus');

    assert.throws(
      () => deriveFloorModel(dir),
      (error) => /registro troncato/.test(error.message) && /10 nella revisione Git precedente/.test(error.message),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('una meta con cardinalità plausibile ma ID sostituito viene rifiutata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-body-floor-meta-identity-'));
  try {
    const content = path.join(dir, 'content');
    fs.mkdirSync(content, { recursive: true });
    fs.writeFileSync(path.join(content, 'blog-articles-data.ts'), "id: 'a'\nid: 'b'\n");
    fs.writeFileSync(path.join(content, 'swiss-articles-data.ts'), "id: 's'\n");
    for (const locale of ['it', 'en', 'de', 'fr']) {
      fs.writeFileSync(
        path.join(content, `blog-meta-${locale}.ts`),
        locale === 'en'
          ? "'blog.article.a.title': 'A',\n'blog.article.replacement.title': 'X',\n"
          : "'blog.article.a.title': 'A',\n'blog.article.b.title': 'B',\n",
      );
      fs.writeFileSync(path.join(content, `blog-meta-ch-${locale}.ts`), "'blog.article.s.title': 'S',\n");
    }

    assert.throws(
      () => deriveFloorModel(dir),
      (error) => /blog-meta-en\.ts: meta incompleta/.test(error.message)
        && /mancano 1: b/.test(error.message),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('la guardia esbuild copre commenti, import multilinea ed export', () => {
  const fixture = [
    "import { createRequire } from 'node:module'; // risolve 'esbuild' a runtime",
    'import {',
    '  build,',
    "} from 'esbuild';",
    "export { transform } from 'esbuild';",
  ].join('\n');
  const statico = staticEsbuildImports(fixture);
  assert.equal(statico.length, 2);
  assert.ok(statico.every((line) => line.includes("'esbuild'")));
  assert.ok(!statico.some((line) => line.includes('createRequire')));
});

test('il gate e tutti i suoi import locali non importano esbuild staticamente', () => {
  // `generator/tests/loop-scripts-closure.test.mjs` rifiuta gli import di
  // pacchetti non dichiarati in package.json per tutto scripts/ci/, perche' il
  // ciclo gira senza `npm ci`. esbuild non e' fra le dipendenze e non deve
  // diventarlo: verrebbe installato a ogni merge insieme a playwright, sharp e
  // transformers. La risoluzione a runtime e' quello che tiene le due cose
  // insieme, e trasformarla in un import statico romperebbe l'altro guard —
  // con un messaggio che non spiega perche'. Questo lo spiega.
  const modules = collectLocalModuleSources(GATE);
  const statico = modules.flatMap(({ file, source }) =>
    staticEsbuildImports(source).map((line) => path.relative(ROOT, file) + ': ' + line),
  );
  assert.deepEqual(
    statico,
    [],
    'esbuild va risolto a runtime (createRequire), non importato staticamente nel gate o nei suoi helper locali.',
  );
});

test('la guardia segue gli helper locali del gate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-body-esbuild-helper-'));
  try {
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'gate.mjs'), "import './lib/helper.mjs';\n");
    fs.writeFileSync(path.join(dir, 'lib/helper.mjs'), "export { transform } from 'esbuild';\n");

    const modules = collectLocalModuleSources(path.join(dir, 'gate.mjs'));
    const statico = modules.flatMap(({ source }) => staticEsbuildImports(source));
    assert.equal(statico.length, 1, 'un import statico in un helper locale deve essere rilevato');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  const model = deriveFloorModel(ROOT);
  const perRoot = model.perRoot.map((r) => ({
    ...r,
    files: collectTypeScriptFiles(path.join(ROOT, r.rel)),
  }));
  const files = perRoot.flatMap((r) => r.files);
  assert.deepEqual(
    floorViolations(perRoot.map((r) => ({ ...r, count: r.files.length }))),
    [],
    `pavimenti derivati non soddisfatti: ${files.length} corpi trovati`,
  );

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

/**
 * retire-article-leftover-check.test.mjs — la verifica finale di
 * `scripts/retire-article.mjs` distingue l'id da un id che lo CONTIENE.
 *
 * ## Il difetto che sorveglia
 *
 * Al passo 12 lo script rilegge le superfici da disco e, se l'id compare
 * ancora, esce 1 con `RIMOZIONE PARZIALE`. La verifica deve restare larga —
 * a servire è proprio il residuo che nessuno si aspetta — ma con un
 * `includes(id)` nudo era anche indiscriminata: gli id si annidano
 * (`frontalieri-disoccupazione-svizzera-2026` contiene
 * `disoccupazione-svizzera-2026`, ed è già così nel corpus), quindi ritirare
 * l'id corto su una superficie che ospita il lungo gridava `RIMOZIONE
 * PARZIALE` su una rimozione in realtà completa — dopo aver già scritto tutto,
 * e con una issue di workflow aperta su un corpus sano.
 *
 * È la stessa classe del needle nudo di `registerLockTargets()`
 * (`generator/tests/register-lock.test.mjs`), con l'esito opposto: là il falso
 * `present` nasconde uno split, qui il falso leftover ne inventa uno.
 *
 * ## Perché la funzione sta in un modulo a parte
 *
 * `retire-article.mjs` chiama `main()` a fine file: importarlo lo eseguirebbe.
 * Ma la stessa regola serve a un secondo chiamante — il gate di PR
 * `retired-articles-fully-removed.test.mjs`, che rilegge le stesse superfici —
 * e una seconda copia è il modo garantito per farle divergere. Quindi la
 * funzione vive in `scripts/lib/mentions-id.mjs`, questo file la importa da lì
 * (nessuna estrazione, nessuna copia) e l'ultimo caso verifica che i due
 * chiamanti non se la siano ri-scritta in casa.
 *
 * Lancia con:
 *   node --test generator/tests/retire-article-leftover-check.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './lib/reachable-source.mjs';
import { mentionsId } from '../../scripts/lib/mentions-id.mjs';
import { ARTICLE_SECTION_CORE } from '../../engine/shared/articleSectionCore.mjs';
import { corpusPath } from '../../generator/scripts/lib/corpus-paths.mjs';
import {
  IMAGES_LEDGER,
  LOCALES,
  SECTIONS,
  leftoverSurfacesFor,
  requiredSurfaceFilesFor,
  surfaceMentionsArticleId,
  surfaceArticleIdStatus,
  SURFACE_ARTICLE_ID_STATUS,
  assertRegularFileIfPresent,
  requireRegularFile,
  seoFilesFor,
  surfacePathStatus,
  SURFACE_PATH_STATUS,
} from '../../scripts/lib/article-surfaces.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** I chiamanti della regola: devono usarla, non ri-scriverla. */
const CALLERS = [
  { rel: 'scripts/retire-article.mjs', symbol: 'surfaceArticleIdStatus' },
  { rel: 'generator/tests/retired-articles-fully-removed.test.mjs', symbol: 'surfaceMentionsArticleId' },
];

const ID = 'disoccupazione-svizzera-2026';
const LONGER = `frontalieri-${ID}`;

test('la verifica finale non scambia un id piu\' lungo per un residuo', () => {
  // Le forme reali con cui l'id LUNGO vive sulle superfici: riga slug,
  // proprieta' del registro, chiave SEO, chiave i18n, membro della union,
  // chiave/valore dei ledger JSON. Nessuna di queste e' un residuo dell'id
  // corto, e nessuna deve far uscire 1 lo script.
  for (const text of [
    `  '${LONGER}': { it: 'x', en: 'x', de: 'x', fr: 'x' },\n`,
    `    id: '${LONGER}',\n`,
    `  'blog-${LONGER}': {\n`,
    `'blog.article.${LONGER}.title': 'x',\n`,
    `type _BlogId9 = | 'altro' | '${LONGER}';\n`,
    `{ "${LONGER}": "https://example.org/foto.jpg" }\n`,
    `{ "https://example.org/news/x": "${LONGER}" }\n`,
  ]) {
    assert.equal(mentionsId(text, ID), false, `falso residuo su: ${text.trim()}`);
  }
});

test('la verifica finale vede ancora il residuo VERO, in ogni forma scritta', () => {
  // L'altra meta': un needle che non matcha mai passerebbe il test qui sopra
  // e trasformerebbe il gate in decorazione. Ognuna di queste e' una rimozione
  // lasciata a meta', e deve continuare a uscire 1.
  for (const text of [
    `  '${ID}': { it: 'x', en: 'x', de: 'x', fr: 'x' },\n`,
    `    id: '${ID}',\n`,
    `  'blog-${ID}': {\n`,
    `'blog.article.${ID}.title': 'x',\n`,
    `type _BlogId9 = | 'altro' | '${ID}';\n`,
    `{ "${ID}": "https://example.org/foto.jpg" }\n`,
    `{ "https://example.org/news/x": "${ID}" }\n`,
    // Anche mescolato all'id lungo nello stesso file: e' il caso reale di una
    // rimozione parziale su una superficie che ospita entrambi.
    `  '${LONGER}': { it: 'x' },\n  '${ID}': { it: 'x' },\n`,
  ]) {
    assert.equal(mentionsId(text, ID), true, `residuo non visto in: ${text.trim()}`);
  }
});

test('la regola ha una sorgente sola: nessun chiamante se la ri-scrive', () => {
  // Il difetto che questo caso ferma non è un falso residuo, è la DERIVA: la
  // verifica finale dello script e il gate di PR guardano le stesse superfici,
  // e finché la regola è una sola i due casi qui sopra parlano per entrambi.
  // Una copia locale in uno dei due li scollegherebbe in silenzio.
  for (const { rel, symbol } of CALLERS) {
    const src = readFileSync(path.join(ROOT, rel), 'utf-8');
    const code = codeOnly(src);
    assert.match(
      code,
      new RegExp(`^[ \\t]*import[ \\t]*\\{[^}]*\\b${symbol}\\b[^}]*\\}[ \\t]*from[ \\t]*'[^']*lib/article-surfaces\\.mjs'`, 'ms'),
      `${rel}: non importa ${symbol} dal modulo delle superfici nel codice eseguibile`,
    );
    assert.doesNotMatch(
      code,
      /function mentionsId\s*\(/,
      `${rel}: ri-definisce mentionsId invece di importarla — due copie della `
      + 'stessa regola divergono, ed è esattamente il difetto per cui il modulo esiste.',
    );
    assert.doesNotMatch(
      code,
      /readSurface\([^)]*\)\.includes\(id\)|\bread\(f\)\.includes\(id\)/,
      `${rel}: includes(id) nudo su una superficie — un id annidato inventa un residuo.`,
    );
  }
});

test('il ledger dei ritirati usa lo stesso writer atomico del resto della catena', () => {
  const src = readFileSync(path.join(ROOT, 'scripts/retire-article.mjs'), 'utf-8');
  assert.match(src, /import\s+\{\s*writeJsonAtomic\s*\}\s+from\s+'\.\.\/generator\/scripts\/lib\/atomic-write-json\.mjs'/);
  assert.match(src, /writeJsonAtomic\(ledgerPath, ledger\)/);
});

test('il controllo finale distingue residui reali da superfici illeggibili', () => {
  const src = codeOnly(readFileSync(path.join(ROOT, 'scripts/retire-article.mjs'), 'utf-8'));
  assert.match(src, /status === SURFACE_ARTICLE_ID_STATUS\.PRESENT\) leftovers\.push/);
  assert.match(src, /status === SURFACE_ARTICLE_ID_STATUS\.UNREADABLE\) unreadable\.push/);
  assert.match(src, /RIMOZIONE PARZIALE/);
  assert.match(src, /VERIFICA INCOMPLETA/);
});

test('il retirement rimuove anche la provenienza dello slug nello stesso buffer della mappa', () => {
  const src = readFileSync(path.join(ROOT, 'scripts/retire-article.mjs'), 'utf-8');
  assert.match(src, /function removeFallbackProvenanceRow\(/);
  assert.match(src, /cfg\.fallbackReasonsConstName/);
  assert.match(src, /fallbackRow = removeFallbackProvenanceRow\(/);
  assert.match(src, /slugDataSrc = fallbackRow\.src/);
});

test('un id vuoto non coincide con ogni superficie', () => {
  assert.equal(mentionsId('id: altro-articolo', ''), false);
});

test('il ledger confronta i valori, non il segmento dell\'URL chiave', () => {
  const key = `https://example.org/${ID}`;
  assert.equal(
    surfaceMentionsArticleId('data/article-source-urls.json', JSON.stringify({ [key]: 'altro-id' }), ID),
    false,
  );
  assert.equal(
    surfaceMentionsArticleId('data/article-source-urls.json', JSON.stringify({ [key]: ID }), ID),
    true,
  );
});

test('un ledger illeggibile è distinto da un residuo reale, ma resta bloccante', () => {
  const rel = 'data/article-source-urls.json';
  assert.equal(
    surfaceArticleIdStatus(rel, '{ non-json', ID),
    SURFACE_ARTICLE_ID_STATUS.UNREADABLE,
  );
  assert.equal(
    surfaceArticleIdStatus(rel, JSON.stringify([ID]), ID),
    SURFACE_ARTICLE_ID_STATUS.UNREADABLE,
  );
  assert.equal(
    surfaceArticleIdStatus(rel, JSON.stringify({ '/source': ID }), ID),
    SURFACE_ARTICLE_ID_STATUS.PRESENT,
  );
  assert.equal(
    surfaceArticleIdStatus(rel, JSON.stringify({ '/source': 'altro-id' }), ID),
    SURFACE_ARTICLE_ID_STATUS.ABSENT,
  );
  assert.equal(surfaceMentionsArticleId(rel, '{ non-json', ID), true);
});

test('il ledger immagini può contenere l\'id ma non è una superficie residua', () => {
  const fixture = JSON.stringify({ [ID]: 'images/blog/disoccupazione.webp' });
  assert.equal(surfaceArticleIdStatus(IMAGES_LEDGER, fixture, ID), SURFACE_ARTICLE_ID_STATUS.PRESENT);
  assert.equal(leftoverSurfacesFor('frontaliere').includes(IMAGES_LEDGER), false);
  assert.equal(leftoverSurfacesFor('svizzera').includes(IMAGES_LEDGER), false);
});

test('le superfici principali derivano dalla tupla canonica e dal mapper corpus', () => {
  for (const section of ['frontaliere', 'svizzera']) {
    const core = ARTICLE_SECTION_CORE[section];
    const cfg = SECTIONS[section];
    assert.equal(cfg.registryFile, corpusPath(core.registryFile));
    assert.equal(cfg.slugDataFile, corpusPath(core.slugDataFile));
    assert.deepEqual(
      cfg.metaFiles,
      LOCALES.map((locale) => corpusPath(`services/locales/${core.metaPrefix}-${locale}.ts`)),
    );
    assert.equal(cfg.bodyDir, corpusPath(`services/locales/${core.bodyDir}`));
  }
});

test('una superficie obbligatoria mancante fallisce esplicitamente', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'article-surfaces-'));
  try {
    // Una directory con il nome del registro non è una superficie leggibile:
    // `existsSync` da sola la avrebbe accettata e il ritiro sarebbe partito.
    mkdirSync(path.join(root, SECTIONS.frontaliere.registryFile), { recursive: true });
    const required = [SECTIONS.frontaliere.slugDataFile, ...SECTIONS.frontaliere.metaFiles];
    for (const rel of required) {
      const abs = path.join(root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, 'fixture\n', 'utf-8');
    }
    assert.throws(
      () => requiredSurfaceFilesFor('frontaliere', root),
      /superfici obbligatorie mancanti.*content\/blog-articles-data\.ts/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEO distingue assenza da directory, FIFO e path illeggibile', () => {
  const fixtures = [
    {
      label: 'directory',
      create(target) { mkdirSync(target, { recursive: true }); },
    },
    {
      label: 'FIFO',
      create(target) {
        const run = spawnSync('mkfifo', [target], { encoding: 'utf8' });
        assert.equal(run.status, 0, `${run.stderr || run.stdout || 'mkfifo fallito'}`);
      },
    },
    {
      label: 'symlink loop illeggibile',
      create(target) { symlinkSync('seo-blog.ts', target); },
    },
  ];

  for (const { label, create } of fixtures) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'article-seo-surface-'));
    try {
      const seoDir = path.join(root, 'content/seo');
      mkdirSync(seoDir, { recursive: true });
      create(path.join(seoDir, 'seo-blog.ts'));
      assert.throws(
        () => seoFilesFor('frontaliere', root),
        /superficie SEO[\s\S]*non è un file regolare leggibile/,
        `${label}: una superficie SEO presente ma inutilizzabile è stata filtrata`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const fixedRoot = mkdtempSync(path.join(os.tmpdir(), 'article-seo-fixed-'));
  try {
    const target = path.join(fixedRoot, 'content/seo/seo-blog-ch.ts');
    mkdirSync(target, { recursive: true });
    assert.throws(
      () => seoFilesFor('svizzera', fixedRoot),
      /superficie SEO[\s\S]*non è un file regolare leggibile/,
      'anche il ramo SEO elencato non deve trattare una directory come assente',
    );
  } finally {
    rmSync(fixedRoot, { recursive: true, force: true });
  }

  const invalidRoot = mkdtempSync(path.join(os.tmpdir(), 'article-seo-root-file-'));
  try {
    mkdirSync(path.join(invalidRoot, 'content'), { recursive: true });
    writeFileSync(path.join(invalidRoot, 'content/seo'), 'not-a-directory\n', 'utf8');
    assert.throws(
      () => seoFilesFor('frontaliere', invalidRoot),
      /superficie SEO[\s\S]*non è una directory leggibile/,
      'la directory SEO stessa non deve passare come contenitore valido',
    );
  } finally {
    rmSync(invalidRoot, { recursive: true, force: true });
  }
});

test('leftoverSurfacesFor non omette una SEO presente ma non regolare', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'article-leftover-surface-'));
  try {
    for (const file of requiredSurfaceFilesFor('frontaliere', ROOT)) {
      const abs = path.join(root, file);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, 'fixture\n', 'utf8');
    }
    const seo = path.join(root, 'content/seo/seo-blog.ts');
    mkdirSync(seo, { recursive: true });
    assert.throws(
      () => leftoverSurfacesFor('frontaliere', root),
      /superficie SEO[\s\S]*non è un file regolare leggibile/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('la predicate dei target delete distingue assenza, inode non regolare e file', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'article-delete-target-'));
  try {
    assert.equal(assertRegularFileIfPresent(root, 'missing.ts', 'target'), false);

    const directory = path.join(root, 'directory.ts');
    mkdirSync(directory);
    assert.equal(surfacePathStatus(root, 'directory.ts'), SURFACE_PATH_STATUS.DIRECTORY);
    assert.throws(
      () => assertRegularFileIfPresent(root, 'directory.ts', 'target'),
      /non è un file regolare leggibile/,
    );

    const loop = path.join(root, 'loop.ts');
    symlinkSync('loop.ts', loop);
    assert.equal(surfacePathStatus(root, 'loop.ts'), SURFACE_PATH_STATUS.UNREADABLE);
    assert.throws(
      () => requireRegularFile(root, 'loop.ts', 'target'),
      /non è un file regolare leggibile/,
    );

    writeFileSync(path.join(root, 'body.ts'), 'fixture\n', 'utf8');
    assert.equal(assertRegularFileIfPresent(root, 'body.ts', 'target'), true);
    assert.equal(requireRegularFile(root, 'body.ts', 'target'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retire-article fa il preflight delle superfici obbligatorie prima di ogni write', () => {
  const src = readFileSync(path.join(ROOT, 'scripts/retire-article.mjs'), 'utf8');
  const sectionAt = src.indexOf('const section = findSection(id);');
  const preflightAt = src.indexOf('requiredSurfaceFilesFor(section);');
  const firstWriteAt = src.indexOf('for (const [file, text] of writes) write(file, text);');
  const dryRunAt = src.indexOf('if (dryRun)');
  assert.ok(sectionAt >= 0 && preflightAt > sectionAt, 'il preflight deve seguire la risoluzione della sezione');
  assert.ok(preflightAt < firstWriteAt, 'le superfici mancanti devono fallire prima delle scritture');
  assert.ok(preflightAt < dryRunAt, 'anche --dry-run deve validare le superfici obbligatorie');
});

test('retire-article valida tutti i target delete prima del primo write', () => {
  const src = codeOnly(readFileSync(path.join(ROOT, 'scripts/retire-article.mjs'), 'utf8'));
  const validateAt = src.indexOf('validateDeleteTargets(deletes);');
  const firstWriteAt = src.indexOf('for (const [file, text] of writes) write(file, text);');
  assert.match(src, /function queueDeleteTarget\(/);
  assert.match(src, /queueDeleteTarget\(deletes, planned, bodyFile, 'corpo'\)/);
  assert.match(src, /queueDeleteTarget\(deletes, planned, sidecar, 'sidecar'\)/);
  assert.match(src, /queueDeleteTarget\(deletes, planned, asset, 'asset'\)/);
  assert.match(src, /function validateDeleteTargets\(/);
  assert.ok(validateAt >= 0 && validateAt < firstWriteAt, 'i target delete devono fallire prima di ogni write');
  assert.doesNotMatch(src, /existsSync\(rel\(bodyFile\)\)/);
  assert.doesNotMatch(src, /existsSync\(rel\(sidecar\)\)/);
  assert.doesNotMatch(src, /existsSync\(rel\(asset\)\)/);
});

test('retire-article rifiuta un id mancante, vuoto o fatto di spazi prima di scrivere', () => {
  const script = path.join(ROOT, 'scripts/retire-article.mjs');
  for (const args of [[], [''], ['   ']]) {
    const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 2, `argv=${JSON.stringify(args)}: ${run.stderr}`);
    assert.match(run.stderr, /uso: node scripts\/retire-article\.mjs/);
  }
});

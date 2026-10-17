import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  canonicalArticleLinkTarget,
  findNonCanonicalArticleLinks,
  sanitizeArticleMarkdownLinks,
} from '../../scripts/lib/article-link-contract.mjs';
import { BLOG_BODY_ROOTS, ROOT, scanBlogBodyLinks } from '../../scripts/ci/check-blog-body-links.mjs';
import { escapeForSingleQuoteTS } from '../scripts/lib/article-meta-block.mjs';

test('il contratto ripara solo le destinazioni legacy con una mappatura pubblica', () => {
  assert.equal(canonicalArticleLinkTarget('calculator'), 'nav:calculator');
  assert.equal(canonicalArticleLinkTarget('calculator:cost-of-living'), 'nav:cost-of-living');
  assert.equal(canonicalArticleLinkTarget('health:companies'), 'nav:health');
  assert.equal(canonicalArticleLinkTarget('municipalities:list'), 'nav:municipalities');
  assert.equal(canonicalArticleLinkTarget('statistics/', 'en'), '/en/statistics/');
  assert.equal(canonicalArticleLinkTarget('Gehaltsabrechnung/', 'de'), '/de/gehalt-berechnen/');
  assert.equal(canonicalArticleLinkTarget('calculez-salaire/', 'fr'), '/fr/calculer-salaire/');
  assert.equal(canonicalArticleLinkTarget('border:rental'), null);
  assert.equal(canonicalArticleLinkTarget('nav:unknown-action'), null);
  assert.equal(canonicalArticleLinkTarget('tel:+41123456789'), null);
  assert.equal(canonicalArticleLinkTarget('discovery://orphan/example'), null);
  assert.equal(canonicalArticleLinkTarget('https://'), null);
  assert.equal(canonicalArticleLinkTarget('http://?missing-host'), null);
  assert.equal(canonicalArticleLinkTarget(String.raw`/\evil`), null);
  assert.equal(canonicalArticleLinkTarget(`/bad${String.fromCharCode(1)}path`), null);
  assert.equal(canonicalArticleLinkTarget(`#bad${String.fromCharCode(127)}`), null);
  assert.equal(canonicalArticleLinkTarget('link al calcolatore'), null);
});

test('la sanitizzazione conserva il testo e non indovina URL sconosciute', () => {
  const source = [
    '[Calcolatore](calculator)',
    '[Costo della vita](calculator:cost-of-living)',
    '[Statistiche](statistiche/)',
    '[Affitti](border:rental)',
    '[Link senza host](https://)',
    '[Link\nmultilinea](relative/path)',
  ].join(' ');
  assert.equal(
    sanitizeArticleMarkdownLinks(source, 'it'),
    '[Calcolatore](nav:calculator) [Costo della vita](nav:cost-of-living) [Statistiche](/statistiche/) Affitti Link senza host Link\nmultilinea',
  );
  assert.deepEqual(
    findNonCanonicalArticleLinks('[Link\nmultilinea](relative/path)').map(({ label, target, replacement }) => ({ label, target, replacement })),
    [{ label: 'Link\nmultilinea', target: 'relative/path', replacement: null }],
  );
});

test('la sanitizzazione rimuove i delimitatori angolari dai target canonici', () => {
  const links = '[Pagina](</en/foo>) [Email](<mailto:a@b>) [Lavori](<nav:jobs>)';
  assert.equal(
    sanitizeArticleMarkdownLinks(links, 'it'),
    '[Pagina](/en/foo) [Email](mailto:a@b) [Lavori](nav:jobs)',
  );
  assert.deepEqual(
    findNonCanonicalArticleLinks(links, 'it').map(({ target, replacement }) => ({ target, replacement })),
    [
      { target: '/en/foo', replacement: '/en/foo' },
      { target: 'mailto:a@b', replacement: 'mailto:a@b' },
      { target: 'nav:jobs', replacement: 'nav:jobs' },
    ],
  );
});

test('la sanitizzazione valida href HTML e rimuove gli attributi duplicati', () => {
  const source = '<a class="article" href="calculator">Calcola</a> '
    + '<a href="relative/path">Relativo</a> '
    + '<a href="/en/legal">Canonico</a> '
    + '<a href="relative/path" href="/en/legal">Duplicato</a> '
    + '<a href="nav:calculator">Azione</a>';
  assert.equal(
    sanitizeArticleMarkdownLinks(source, 'it'),
    '<a class="article">Calcola</a> '
      + '<a>Relativo</a> '
      + '<a href="/en/legal">Canonico</a> '
      + '<a>Duplicato</a> '
      + '<a>Azione</a>',
  );
  assert.deepEqual(
    findNonCanonicalArticleLinks(source, 'it').map(({ target, replacement, htmlAnchor }) => ({
      target,
      replacement,
      htmlAnchor,
    })),
    [
      { target: 'calculator', replacement: null, htmlAnchor: true },
      { target: 'relative/path', replacement: null, htmlAnchor: true },
      { target: 'relative/path', replacement: null, htmlAnchor: true },
      { target: 'nav:calculator', replacement: null, htmlAnchor: true },
    ],
  );
});

test('il gate decodifica i body TypeScript e copre tutte le radici attive senza leggere link dentro il codice', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-gate-'));
  const markdown = [
    '~~~markdown',
    '[esempio](calculator)',
    '<a href="calculator">esempio</a>',
    '~~~',
    '[legacy](calculator)',
    '[azione sconosciuta](nav:unknown-action)',
    '[telefono](tel:+41123456789)',
    '<a href="calculator">legacy HTML</a>',
    '<a href="relative/path">relativo</a>',
    '<a href="/en/legal">canonico</a>',
    '<!-- <a href="relative/commented">commentato</a> -->',
  ].join('\n');
  const changedFiles = [];
  try {
    for (const bodyRoot of BLOG_BODY_ROOTS) {
      const relative = `${bodyRoot}/it/link-gate-fixture.ts`;
      const file = path.join(fixtureRoot, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `const body = {\n  'blog.article.fixture.body1': '${escapeForSingleQuoteTS(markdown)}',\n};\n`, 'utf8');
      changedFiles.push(relative);
    }

    const scoped = scanBlogBodyLinks(fixtureRoot, [changedFiles.at(-1)]);
    assert.equal(scoped.files.length, 1, 'il filtro include anche una radice attiva non primaria');
    assert.deepEqual(scoped.offenders.map(({ label }) => label), [
      'legacy', 'azione sconosciuta', 'telefono', '<a href>', '<a href>',
    ]);
    assert.deepEqual(scoped.errors, []);

    const full = scanBlogBodyLinks(fixtureRoot);
    assert.equal(full.files.length, BLOG_BODY_ROOTS.length);
    assert.equal(full.offenders.length, BLOG_BODY_ROOTS.length * 5);
    assert.deepEqual(full.errors, []);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('il gate rifiuta espressioni concatenate dopo un literal invece di saltarle', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-expression-'));
  const relative = `${BLOG_BODY_ROOTS[0]}/it/concatenated.ts`;
  const file = path.join(fixtureRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "const body = { 'blog.article.fixture.body1': 'safe' + '[x](https://example.com)' };\n", 'utf8');
  try {
    const result = scanBlogBodyLinks(fixtureRoot);
    assert.deepEqual(result.offenders, []);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /espressione TypeScript non letterale non verificabile/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('il rilevatore distingue il target legacy dal testo già canonico', () => {
  const offenders = findNonCanonicalArticleLinks(
    '[ok](nav:calculator) [legacy](calculator) [external](https://example.com/x)',
    'it',
  );
  assert.deepEqual(offenders.map(({ target, replacement }) => ({ target, replacement })), [
    { target: 'calculator', replacement: 'nav:calculator' },
  ]);
});

test('il rilevatore considera non canonici anche gli angle-delimited e gli anchor HTML', () => {
  const offenders = findNonCanonicalArticleLinks(
    '[angle](<nav:jobs>) <a href="calculator">html</a> <a href="/ok">ok</a>',
    'it',
  );
  assert.deepEqual(offenders.map(({ target, replacement }) => ({ target, replacement })), [
    { target: 'nav:jobs', replacement: 'nav:jobs' },
    { target: 'calculator', replacement: 'nav:calculator' },
  ]);
});

test('publish-api esegue il link gate prima della pubblicazione', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/publish-api.yml'), 'utf8');
  const linkGate = workflow.indexOf('node scripts/ci/check-blog-body-links.mjs');
  const linkGateStepStart = workflow.lastIndexOf('      - name:', linkGate);
  const nextStep = workflow.indexOf('\n      - name:', linkGate);
  const linkGateStep = workflow.slice(linkGateStepStart, nextStep > linkGateStepStart ? nextStep : undefined);
  const gateInputStart = workflow.indexOf('gate_input_paths=(');
  const gateInputEnd = workflow.indexOf('\n            )', gateInputStart);
  const gateInputBlock = workflow.slice(gateInputStart, gateInputEnd > gateInputStart ? gateInputEnd : undefined);
  const build = workflow.indexOf('npx -y tsx@4.23.15 scripts/build-api.mjs');
  const pushPaths = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('permissions:'));
  assert.ok(linkGate > 0, 'publish-api.yml non invoca il link gate');
  assert.ok(build > linkGate, 'il link gate deve precedere la pubblicazione della superficie API');
  assert.ok(pushPaths.includes("'scripts/ci/check-blog-body-links.mjs'"), 'le modifiche al gate devono riattivare publish-api');
  assert.ok(pushPaths.includes("'scripts/lib/article-link-contract.mjs'"), 'le modifiche al contratto devono riattivare publish-api');
  assert.ok(pushPaths.includes("'generator/data/canton-url-slugs.json'"), 'la sorgente delle radici attive deve riattivare publish-api');
  assert.match(linkGateStep, /PREFLIGHT_SCAN_MODE/);
  assert.match(workflow, /engine\/shared\/cantonArticleSectionCore\.generated\.mjs/);
  assert.match(gateInputBlock, /generator\/data\/canton-url-slugs\.json/);
  assert.match(workflow, /generator\/data\/canton-url-slugs\.json/);
});

test('i publisher rapidi eseguono il link gate prima di ogni pubblicazione', () => {
  for (const file of ['fast-publish-article.yml', 'fast-publish-section.yml']) {
    const workflow = readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
    const linkGate = workflow.indexOf('node scripts/ci/check-blog-body-links.mjs');
    const publishJob = workflow.indexOf('\n  publish:');
    assert.ok(linkGate > 0, `${file} non invoca il link gate`);
    assert.ok(publishJob > linkGate, `${file} deve terminare il gate prima del job di pubblicazione`);
  }
});

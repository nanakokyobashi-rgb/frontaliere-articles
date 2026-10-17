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
  assert.equal(canonicalArticleLinkTarget('link al calcolatore'), null);
});

test('la sanitizzazione conserva il testo e non indovina URL sconosciute', () => {
  const source = [
    '[Calcolatore](calculator)',
    '[Costo della vita](calculator:cost-of-living)',
    '[Statistiche](statistiche/)',
    '[Affitti](border:rental)',
  ].join(' ');
  assert.equal(
    sanitizeArticleMarkdownLinks(source, 'it'),
    '[Calcolatore](nav:calculator) [Costo della vita](nav:cost-of-living) [Statistiche](/statistiche/) Affitti',
  );
});

test('la sanitizzazione canonicalizza link angle-delimited e anchor HTML nel funnel condiviso', () => {
  const source = [
    '[Root](</en/foo>)',
    '[Mail](<mailto:a@b>)',
    '[Azione](<nav:jobs>)',
    '[ref]: <nav:jobs>',
    '<a class="tool" href="calculator">Calcolatore</a>',
    '<a href="/en/foo">Route</a>',
    '<a href="relative/unknown">Sconosciuto</a>',
    '~~~markdown',
    '[codice](<calculator>) <a href="relative/code">codice</a>',
    '~~~',
  ].join('\n');
  assert.equal(
    sanitizeArticleMarkdownLinks(source, 'en'),
    [
      '[Root](/en/foo)',
      '[Mail](mailto:a@b)',
      '[Azione](nav:jobs)',
      '[ref]: nav:jobs',
      '<a class="tool" href="nav:calculator">Calcolatore</a>',
      '<a href="/en/foo">Route</a>',
      'Sconosciuto',
      '~~~markdown',
      '[codice](<calculator>) <a href="relative/code">codice</a>',
      '~~~',
    ].join('\n'),
  );
});

test('il gate decodifica i body TypeScript e copre tutte le radici attive senza leggere link dentro il codice', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-gate-'));
  const markdown = [
    '~~~markdown',
    '[esempio](calculator)',
    '~~~',
    '[legacy](calculator)',
    '[azione sconosciuta](nav:unknown-action)',
    '[telefono](tel:+41123456789)',
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
    assert.deepEqual(scoped.offenders.map(({ label }) => label), ['legacy', 'azione sconosciuta', 'telefono']);
    assert.deepEqual(scoped.errors, []);

    const full = scanBlogBodyLinks(fixtureRoot);
    assert.equal(full.files.length, BLOG_BODY_ROOTS.length);
    assert.equal(full.offenders.length, BLOG_BODY_ROOTS.length * 3);
    assert.deepEqual(full.errors, []);
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
  assert.match(gateInputBlock, /engine\/shared\/cantonArticleSectionCore\.generated\.mjs/);
  assert.match(gateInputBlock, /generator\/data\/canton-url-slugs\.json/);
  assert.match(linkGateStep, /PREFLIGHT_SCAN_MODE/);
});

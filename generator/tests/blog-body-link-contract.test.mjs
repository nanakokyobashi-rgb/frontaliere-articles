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
  assert.equal(canonicalArticleLinkTarget('https://example.com/a(b)'), null);
  assert.equal(
    canonicalArticleLinkTarget('https://example.com/a%28b%29'),
    'https://example.com/a%28b%29',
  );
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

test('writer e gate sanificano ogni link elaborato dal renderer, anche immagini, code span e fence', () => {
  const source = [
    '![immagine](relative/image)',
    '`[codice](relative/code)`',
    '~~~markdown',
    '[fence](relative/fence)',
    '~~~',
    '<!-- [commento](relative/comment) -->',
  ].join('\n');
  assert.deepEqual(
    findNonCanonicalArticleLinks(source).map(({ target, replacement }) => ({ target, replacement })),
    [
      { target: 'relative/image', replacement: null },
      { target: 'relative/code', replacement: null },
      { target: 'relative/fence', replacement: null },
      { target: 'relative/comment', replacement: null },
    ],
  );
  const sanitized = sanitizeArticleMarkdownLinks(source);
  assert.equal(sanitized, [
    '!immagine',
    '`codice`',
    '~~~markdown',
    'fence',
    '~~~',
    '<!-- commento -->',
  ].join('\n'));
  assert.deepEqual(findNonCanonicalArticleLinks(sanitized), []);
});

test('la sanitizzazione rimuove i delimitatori angolari dai target canonici', () => {
  const links = '[Pagina](</en/foo>) [Email](<mailto:a@b>) [Lavori](<nav:jobs>) '
    + '[Sito](<https://example.com>)';
  assert.equal(
    sanitizeArticleMarkdownLinks(links, 'it'),
    '[Pagina](/en/foo) [Email](mailto:a@b) [Lavori](nav:jobs) [Sito](https://example.com)',
  );
  assert.deepEqual(
    findNonCanonicalArticleLinks(links, 'it').map(({ target, replacement }) => ({ target, replacement })),
    [
      { target: '/en/foo', replacement: '/en/foo' },
      { target: 'mailto:a@b', replacement: 'mailto:a@b' },
      { target: 'nav:jobs', replacement: 'nav:jobs' },
      { target: 'https://example.com', replacement: 'https://example.com' },
    ],
  );
  assert.deepEqual(findNonCanonicalArticleLinks(sanitizeArticleMarkdownLinks(links)), []);
});

test('il renderer non riceve URL angolari con spazi o titoli Markdown', () => {
  const source = '[Spazio](<https://example.com/a b>) '
    + '[Titolo](https://example.com "titolo") '
    + '[Titolo angolare](<https://example.com> "titolo")';
  assert.equal(sanitizeArticleMarkdownLinks(source), 'Spazio Titolo Titolo angolare');
  assert.deepEqual(
    findNonCanonicalArticleLinks(source).map(({ target, replacement }) => ({ target, replacement })),
    [
      { target: 'https://example.com/a b', replacement: null },
      { target: 'https://example.com', replacement: null },
      { target: 'https://example.com', replacement: null },
    ],
  );
  assert.deepEqual(findNonCanonicalArticleLinks(sanitizeArticleMarkdownLinks(source)), []);
});

test('il writer rifiuta le parentesi letterali che il renderer tronca', () => {
  const source = '[esterno](https://example.test/a(b)) [relativo](/percorso(a)) '
    + '[codificato](https://example.test/a%28b%29)';
  assert.equal(
    sanitizeArticleMarkdownLinks(source),
    'esterno) relativo) [codificato](https://example.test/a%28b%29)',
  );
  assert.deepEqual(
    findNonCanonicalArticleLinks(source).map(({ target, replacement }) => ({ target, replacement })),
    [
      { target: 'https://example.test/a(b', replacement: null },
      { target: '/percorso(a', replacement: null },
    ],
  );
});

test('writer e gate seguono i delimitatori reali del renderer su link malformati', () => {
  const source = '[escaped\\](bare) [parenthesis](/foo(bar) [angle](<foo)';
  assert.equal(sanitizeArticleMarkdownLinks(source), 'escaped\\ parenthesis angle');
  assert.deepEqual(
    findNonCanonicalArticleLinks(source).map(({ target, replacement }) => ({ target, replacement })),
    [
      { target: 'bare', replacement: null },
      { target: '/foo(bar', replacement: null },
      { target: '<foo', replacement: null },
    ],
  );
});

test('il writer rimuove i target con suffisso non quotato che il renderer considera href', () => {
  const source = '[relativo](foo bar) [esterno](https://example.test/percorso token) '
    + '[codificato](https://example.test/percorso%20token)';
  assert.equal(
    sanitizeArticleMarkdownLinks(source),
    'relativo esterno [codificato](https://example.test/percorso%20token)',
  );
  assert.deepEqual(
    findNonCanonicalArticleLinks(source).map(({ target, replacement }) => ({ target, replacement })),
    [
      { target: 'foo bar', replacement: null },
      { target: 'https://example.test/percorso token', replacement: null },
    ],
  );
});

test('writer e gate rimuovono suffissi attaccati a un target angolare', () => {
  const source = '[malformato](<https://example.com>tail)';
  assert.equal(sanitizeArticleMarkdownLinks(source), 'malformato');
  assert.deepEqual(
    findNonCanonicalArticleLinks(source).map(({ target, replacement }) => ({ target, replacement })),
    [{ target: 'https://example.com>tail', replacement: null }],
  );
});

test('il writer e il gate visitano i link annidati nella label di un link esterno', () => {
  const source = '[outer [inner](bare-target)](https://example.com/article)';
  assert.equal(
    sanitizeArticleMarkdownLinks(source),
    '[outer inner](https://example.com/article)',
  );
  assert.deepEqual(
    findNonCanonicalArticleLinks(source).map(({ label, target, replacement }) => ({
      label,
      target,
      replacement,
    })),
    [{ label: 'inner', target: 'bare-target', replacement: null }],
  );
});

test('writer e gate visitano anchor HTML annidati nella label Markdown', () => {
  const source = '[outer <a href="relative/path">inner</a>](https://example.com/article)';
  assert.equal(
    sanitizeArticleMarkdownLinks(source),
    '[outer <a>inner</a>](https://example.com/article)',
  );
  assert.deepEqual(
    findNonCanonicalArticleLinks(source).map(({ label, target, replacement, htmlAnchor }) => ({
      label,
      target,
      replacement,
      htmlAnchor,
    })),
    [{ label: '<a href>', target: 'relative/path', replacement: null, htmlAnchor: true }],
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

test('il gate decodifica i body TypeScript e allinea i confini al renderer statico', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-gate-'));
  const markdown = [
    '~~~markdown',
    '[esempio](calculator)',
    '<a href="calculator">esempio</a>',
    '~~~',
    '[legacy](calculator)',
    '![immagine](relative/image)',
    '`[codice](relative/code)`',
    '\\[escaped](relative/escaped)',
    '<!-- [commento](relative/comment-markdown) -->',
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
      'esempio', '<a href>', 'legacy', 'immagine', 'codice', 'escaped', 'commento',
      'azione sconosciuta', 'telefono', '<a href>', '<a href>', '<a href>',
    ]);
    assert.deepEqual(scoped.errors, []);

    const full = scanBlogBodyLinks(fixtureRoot);
    assert.equal(full.files.length, BLOG_BODY_ROOTS.length);
    assert.equal(full.offenders.length, BLOG_BODY_ROOTS.length * 12);
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

test('il gate fallisce chiuso sulle chiavi body computed e riporta l’espressione', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-computed-key-'));
  const relative = `${BLOG_BODY_ROOTS[0]}/it/computed-key.ts`;
  const file = path.join(fixtureRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  const sources = [
    "const body = { [`blog.article.${id}.body1`]: '[x](bare-target)' };\n",
    "const body = { [bodyKey]: '[x](bare-target)' };\n",
    "const body = { [`blog.article.${id}.${field}`]: '[x](bare-target)' };\n",
    "const body = { [/(?:\\])/.source]: '[x](bare-target)' };\n",
  ];
  try {
    for (const [index, source] of sources.entries()) {
      writeFileSync(file, source, 'utf8');
      const result = scanBlogBodyLinks(fixtureRoot);
      assert.deepEqual(result.offenders, []);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0].message, /chiave TypeScript computata non verificabile/);
      assert.ok(result.errors[0].message.includes([
        'blog.article.${id}.body1',
        'bodyKey',
        'blog.article.${id}.${field}',
        '/(?:\\])/.source',
      ][index]));
    }
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
    { target: 'calculator', replacement: null },
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
  assert.ok(pushPaths.includes("'generator/scripts/lib/article-excerpt.mjs'"), 'la dipendenza transitiva del writer deve riattivare publish-api');
  assert.ok(pushPaths.includes("'generator/data/canton-url-slugs.json'"), 'la sorgente delle radici attive deve riattivare publish-api');
  assert.match(linkGateStep, /PREFLIGHT_SCAN_MODE/);
  assert.match(workflow, /engine\/shared\/cantonArticleSectionCore\.generated\.mjs/);
  assert.match(gateInputBlock, /generator\/data\/canton-url-slugs\.json/);
  assert.match(gateInputBlock, /generator\/scripts\/lib\/article-excerpt\.mjs/);
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

test('i publisher rapidi usano la stessa chiusura delle dipendenze del gate di publish-api', () => {
  const api = readFileSync(path.join(ROOT, '.github/workflows/publish-api.yml'), 'utf8');
  const apiStart = api.indexOf('gate_input_paths=(');
  const apiEnd = api.indexOf('\n            )', apiStart);
  const apiPaths = [...api.slice(apiStart, apiEnd).matchAll(/^\s+([^\s()]+)$/gm)]
    .map((match) => match[1]);
  assert.ok(apiPaths.length > 0, 'publish-api.yml deve dichiarare le dipendenze del gate');
  for (const dependency of ['engine/articleSeoFallback.ts', 'engine/rssFeeds.mjs']) {
    assert.ok(apiPaths.includes(dependency), `publish-api.yml deve includere ${dependency}`);
  }

  for (const file of ['fast-publish-article.yml', 'fast-publish-section.yml']) {
    const workflow = readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
    const start = workflow.indexOf('gate_input_paths=(');
    const end = workflow.indexOf('\n          )', start);
    const paths = [...workflow.slice(start, end).matchAll(/^\s+([^\s()]+)$/gm)]
      .map((match) => match[1]);
    const gate = workflow.slice(start, workflow.indexOf('node scripts/ci/check-blog-body-links.mjs', start));
    assert.deepEqual(paths, apiPaths, `${file} deve condividere la chiusura di publish-api`);
    assert.match(gate, /git diff --quiet "\$BEFORE" "\$AFTER" -- "\$\{gate_input_paths\[@\]\}"/);
    assert.match(gate, /git diff --name-only "\$BEFORE" "\$AFTER" -- content/);
  }
});

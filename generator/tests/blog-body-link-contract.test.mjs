import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  canonicalArticleLinkTarget,
  findNonCanonicalArticleLinks,
  sanitizeArticleFaqMarkdown,
  sanitizeArticleMarkdownLinks,
} from '../../scripts/lib/article-link-contract.mjs';
import { findItalianNavLinkLabels } from '../../scripts/lib/nav-link-labels.mjs';
import {
  BLOG_BODY_ROOTS,
  ROOT,
  bodyFilesForArticleIds,
  scanBlogBodyLinks,
} from '../../scripts/ci/check-blog-body-links.mjs';
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
  const backslash = String.fromCharCode(92);
  for (const target of [
    `https://example.com/a${backslash}path`,
    `https://example.com/a${String.fromCharCode(1)}path`,
    `mailto:reader${backslash}@example.com`,
    `mailto:reader${String.fromCharCode(1)}@example.com`,
  ]) {
    assert.equal(canonicalArticleLinkTarget(target), null, target);
    assert.equal(sanitizeArticleMarkdownLinks(`[invalid](${target})`), 'invalid', target);
  }
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

test('la FAQ normalizza solo q/a e conserva le chiavi extra', () => {
  const extra = '[Nota](calculator)';
  const faq = [{
    q: '[Domanda](calculator)',
    a: '[Risposta](statistics/)',
    note: extra,
    rank: 1,
  }];

  assert.deepEqual(sanitizeArticleFaqMarkdown(faq, 'en'), [{
    q: '[Domanda](nav:calculator)',
    a: '[Risposta](/en/statistics/)',
    note: extra,
    rank: 1,
  }]);
  assert.equal(faq[0].note, extra, 'la sanitizzazione non deve mutare la coppia sorgente');
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
      { target: 'https://example.com "titolo"', replacement: null },
      { target: 'https://example.com> "titolo"', replacement: null },
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

test('writer e gate seguono il primo delimitatore del renderer su suffissi titolo malformati', () => {
  const sources = [
    '[quoted](bare "title)',
    '[parentetico](bare (title)',
  ];
  for (const source of sources) {
    const occurrences = findNonCanonicalArticleLinks(source);
    assert.equal(occurrences.length, 1, source);
    assert.equal(occurrences[0].replacement, null, source);
    assert.equal(sanitizeArticleMarkdownLinks(source), source.slice(1, source.indexOf(']')), source);
  }
});

test('writer e gate riconoscono anchor con il confine `<a\\b` usato dal renderer', () => {
  const source = '<a-foo href="bare">x</a> <abbr href="bare">y</abbr>';
  assert.equal(sanitizeArticleMarkdownLinks(source), '<a-foo>x</a> <abbr href="bare">y</abbr>');
  assert.deepEqual(
    findNonCanonicalArticleLinks(source).map(({ target, replacement, htmlAnchor }) => ({
      target,
      replacement,
      htmlAnchor,
    })),
    [{ target: 'bare', replacement: null, htmlAnchor: true }],
  );
});

test('writer e gate riconoscono gli alias href accettati dal matcher del renderer', () => {
  const source = '<a data-href="bare">Data</a> '
    + '<a aria-href="relative/path">Aria</a> '
    + '<a data-href="/en/legal">Canonico</a>';
  assert.equal(
    sanitizeArticleMarkdownLinks(source, 'it'),
    '<a>Data</a> <a>Aria</a> <a data-href="/en/legal">Canonico</a>',
  );
  assert.deepEqual(
    findNonCanonicalArticleLinks(source, 'it').map(({ target, replacement, htmlAnchor }) => ({
      target,
      replacement,
      htmlAnchor,
    })),
    [
      { target: 'bare', replacement: null, htmlAnchor: true },
      { target: 'relative/path', replacement: null, htmlAnchor: true },
    ],
  );
});

test('writer e gate attraversano le righe vuote in una label quando è dentro un fence', () => {
  const fenced = '~~~markdown\n[x\n\n](bare)\n~~~';
  assert.deepEqual(
    findNonCanonicalArticleLinks(fenced).map(({ target, replacement }) => ({ target, replacement })),
    [{ target: 'bare', replacement: null }],
  );
  assert.equal(sanitizeArticleMarkdownLinks(fenced).includes('](bare)'), false);

  const separateParagraphs = '[x\n\n](bare)';
  assert.deepEqual(findNonCanonicalArticleLinks(separateParagraphs), []);
  assert.equal(sanitizeArticleMarkdownLinks(separateParagraphs), separateParagraphs);
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

test('writer e gate rispettano la precedenza degli anchor HTML del renderer', () => {
  const safeOuterAnchor = '<a href="/x">[testo](bare)</a>';
  assert.equal(sanitizeArticleMarkdownLinks(safeOuterAnchor), safeOuterAnchor);
  assert.deepEqual(findNonCanonicalArticleLinks(safeOuterAnchor), []);

  const unsafeOuterAnchor = '<a href="bare">[testo](inner-bare)</a>';
  assert.equal(sanitizeArticleMarkdownLinks(unsafeOuterAnchor), '<a>testo</a>');
  assert.deepEqual(
    findNonCanonicalArticleLinks(unsafeOuterAnchor).map(({ label, target, htmlAnchor }) => ({
      label,
      target,
      htmlAnchor,
    })),
    [
      { label: '<a href>', target: 'bare', htmlAnchor: true },
      { label: 'testo', target: 'inner-bare', htmlAnchor: false },
    ],
  );

  const noHrefOuterAnchor = '<a>[testo](bare)</a>';
  assert.equal(sanitizeArticleMarkdownLinks(noHrefOuterAnchor), '<a>testo</a>');
  assert.deepEqual(
    findNonCanonicalArticleLinks(noHrefOuterAnchor).map(({ label, target, htmlAnchor }) => ({
      label,
      target,
      htmlAnchor,
    })),
    [{ label: 'testo', target: 'bare', htmlAnchor: false }],
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

test('il preflight di un publisher esplicito limita il gate agli id e alle quattro locali', () => {
  assert.deepEqual(
    bodyFilesForArticleIds('frontaliere', ['target-article']),
    [
      'content/blog-body/it/target-article.ts',
      'content/blog-body/en/target-article.ts',
      'content/blog-body/de/target-article.ts',
      'content/blog-body/fr/target-article.ts',
    ],
  );
  assert.deepEqual(bodyFilesForArticleIds('frontaliere', []), []);
  assert.throws(
    () => bodyFilesForArticleIds('frontaliere', ['../outside']),
    /article id publisher non valido/,
  );
  assert.throws(
    () => bodyFilesForArticleIds('not-active', ['target-article']),
    /sezione publisher non attiva/,
  );

  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-target-scope-'));
  const targetFiles = bodyFilesForArticleIds('frontaliere', ['target-article']);
  try {
    for (const relative of [
      ...targetFiles,
      'content/blog-body/it/unrelated-legacy-body.ts',
    ]) {
      const file = path.join(fixtureRoot, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      const markdown = relative.endsWith('unrelated-legacy-body.ts')
        ? '[legacy](bare-target)'
        : '[ok](https://example.com/target)';
      writeFileSync(file, `const body = {\n  'blog.article.fixture.body1': '${escapeForSingleQuoteTS(markdown)}',\n};\n`, 'utf8');
    }
    const scoped = scanBlogBodyLinks(fixtureRoot, targetFiles);
    assert.equal(scoped.files.length, targetFiles.length);
    assert.deepEqual(scoped.offenders, []);
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

test('il gate ammette destrutturazione array in helper accanto a body statici', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-array-destructure-'));
  const relative = `${BLOG_BODY_ROOTS[0]}/it/helper.ts`;
  const file = path.join(fixtureRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, [
    'const split = (head, [tail]) => tail;',
    'const splitTyped = (head: string, [tail]: string[]) => tail;',
    "const body = { 'blog.article.fixture.body1': '[ok](https://example.com)' };",
    '',
  ].join('\n'), 'utf8');
  try {
    const result = scanBlogBodyLinks(fixtureRoot);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.offenders, []);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('il gate ammette destrutturazione object in helper accanto a body statici', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-object-helper-'));
  const relative = `${BLOG_BODY_ROOTS[0]}/it/object-helper.ts`;
  const file = path.join(fixtureRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, [
    'const pick = ({ extraFields }) => extraFields;',
    'const rest = ({ ...extraFields }) => extraFields;',
    "const body = { 'blog.article.fixture.body1': '[ok](https://example.com)' };",
    '',
  ].join('\n'), 'utf8');
  try {
    const result = scanBlogBodyLinks(fixtureRoot);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.offenders, []);
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
    "const body = { 'blog.article.fixture.body1': 'safe', get [bodyKey]() { return 'optional'; } };\n",
    "const body = { 'blog.article.fixture.body1': 'safe', *[bodyKey]() { return 'optional'; } };\n",
    "const body = { [`blog.article.${id}.${field}`]: '[x](bare-target)' };\n",
    "const body = { [/(?:\\])/.source]: '[x](bare-target)' };\n",
    "const body = { [value.return / /]/]: '[x](bare-target)' };\n",
    "const body = { [(() => { if (enabled) {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { function check() {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { class Check {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { function generic<T, U>() {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [function check() {} / /foo\\]/.test(value)]: '[x](bare-target)' };\n",
    "const body = { [class Check {} / /foo\\]/.test(value)]: '[x](bare-target)' };\n",
    "const body = { [(() => { async function checkAsync() {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { function f<T,U>() {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { function check(): (x: unknown) => unknown { return x => x; } /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { function typed(): { value: { nested: unknown } } | null { {} /foo\\]/.test(value); return null; } return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { class Check<T extends { value: unknown }> {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { class Check extends mixin({}) {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { class Pick extends (x < y ? Left : Right) {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { class Indexed extends foo[x < y] {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { class ArrowIndexed extends foo[x => {}] {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { class ObjectIndexed extends foo[{ key: value }] {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { class Generic extends Base<{ value: unknown }> {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { class Outer extends mixin(class Inner {}) {} /foo\\]/.test(value); return 'id'; })()]: '[x](bare-target)' };\n",
    "const body = { [(() => { async () => { function nested() {} /foo\\]/.test(value); }; return 'id'; })()]: '[x](bare-target)' };\n",
  ];
  try {
    for (const [index, source] of sources.entries()) {
      writeFileSync(file, source, 'utf8');
      const result = scanBlogBodyLinks(fixtureRoot);
      assert.deepEqual(result.offenders, []);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0].message, /chiave TypeScript computata non verificabile/u);
      assert.ok(result.errors[0].message.includes([
        'blog.article.${id}.body1',
        'bodyKey',
        'bodyKey',
        'bodyKey',
        'blog.article.${id}.${field}',
        '/(?:\\])/.source',
        'value.return / /]',
        "if (enabled) {} /foo\\]/.test(value)",
        "{} /foo\\]/.test(value)",
        "function check() {} /foo\\]/.test(value)",
        "class Check {} /foo\\]/.test(value)",
        "function generic<T, U>() {} /foo\\]/.test(value)",
        "function check() {} / /foo\\]/.test(value)",
        "class Check {} / /foo\\]/.test(value)",
        "async function checkAsync() {} /foo\\]/.test(value)",
        "function f<T,U>() {} /foo\\]/.test(value)",
        "function check(): (x: unknown) => unknown { return x => x; } /foo\\]/.test(value)",
        "function typed(): { value: { nested: unknown } } | null { {} /foo\\]/.test(value); return null; }",
        "class Check<T extends { value: unknown }> {} /foo\\]/.test(value)",
        "class Check extends mixin({}) {} /foo\\]/.test(value)",
        "class Pick extends (x < y ? Left : Right) {} /foo\\]/.test(value)",
        "class Indexed extends foo[x < y] {} /foo\\]/.test(value)",
        "class ArrowIndexed extends foo[x => {}] {} /foo\\]/.test(value)",
        "class ObjectIndexed extends foo[{ key: value }] {} /foo\\]/.test(value)",
        "class Generic extends Base<{ value: unknown }> {} /foo\\]/.test(value)",
        "class Outer extends mixin(class Inner {}) {} /foo\\]/.test(value)",
        "async () => { function nested() {} /foo\\]/.test(value); }",
      ][index]));
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('il gate fallisce chiuso su spread e shorthand object dinamici', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-dynamic-member-'));
  const relative = `${BLOG_BODY_ROOTS[0]}/it/dynamic-member.ts`;
  const file = path.join(fixtureRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  const sources = [
    [
      "const extraFields = { 'blog.article.fixture.body2': '[x](bare-target)' };",
      "const body = { 'blog.article.fixture.body1': 'safe', ...extraFields };",
    ].join('\n'),
    [
      "const extraFields = { 'blog.article.fixture.body2': '[x](bare-target)' };",
      "const body = { 'blog.article.fixture.body1': 'safe', extraFields };",
    ].join('\n'),
  ];
  try {
    for (const source of sources) {
      writeFileSync(file, source + '\n', 'utf8');
      const result = scanBlogBodyLinks(fixtureRoot);
      assert.deepEqual(result.offenders, []);
      assert.equal(result.errors.length, 1);
      assert.match(result.errors[0].message, /membro object dinamico non verificabile/u);
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('il gate fallisce chiuso sui membri computed dopo operatori logici e attraversa commenti CR', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-logical-member-'));
  const relative = `${BLOG_BODY_ROOTS[0]}/it/logical-member.ts`;
  const file = path.join(fixtureRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    for (const operator of ['&&', '||']) {
      writeFileSync(file, `const body = enabled ${operator} { [dynamicKey]: 'value' };\n`, 'utf8');
      const result = scanBlogBodyLinks(fixtureRoot);
      assert.deepEqual(result.offenders, []);
      assert.equal(result.errors.length, 1, operator);
      assert.match(result.errors[0].message, /chiave TypeScript computata non verificabile/u, operator);
    }

    writeFileSync(file, [
      'const body = {',
      "  'blog.article.fixture.body1': 'safe', // comment\r  'blog.article.fixture.body2': '[bad](bare-target)',",
      "  'blog.article.fixture.body3': 'safe',",
      '};',
      '',
    ].join('\n'), 'utf8');
    const result = scanBlogBodyLinks(fixtureRoot);
    assert.deepEqual(result.errors, []);
    assert.equal(result.offenders.length, 1);
    assert.equal(result.offenders[0].target, 'bare-target');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('il gate continua a controllare i body dopo regex di controllo e divisione con non-null assertion', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-regex-context-'));
  const relative = `${BLOG_BODY_ROOTS[0]}/it/dynamic-regex-context.ts`;
  const file = path.join(fixtureRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, [
    'const helper = `prefix ${(() => { if (enabled) {} /}/.test(value); {} /}/.test(value); function check() {} /}/.test(value); async function checkAsync() {} /}/.test(value); class Check {} /}/.test(value); function typed(): (x: unknown) => unknown { return x => x; } /}/.test(value); return [function expression() {} / /}/.test(value), class Expression {} / /}/.test(value), value! / divisor]; })()}`;',
    "const body = { 'blog.article.fixture.body1': '[x](bare-target)' };",
    '',
  ].join('\n'), 'utf8');
  try {
    const result = scanBlogBodyLinks(fixtureRoot);
    assert.equal(result.errors.length, 0);
    assert.equal(result.offenders.length, 1);
    assert.equal(result.offenders[0].target, 'bare-target');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('il gate conserva il confine delle template expression con tipi TypeScript strutturali', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-typescript-context-'));
  const relative = `${BLOG_BODY_ROOTS[0]}/it/dynamic-typescript-context.ts`;
  const file = path.join(fixtureRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, [
    'const helper = `prefix ${(() => {',
    'function typed(): { value: { nested: unknown } } | null { {} /}/.test(value); return null; }',
    'class Constrained<T extends { value: unknown }> {} /}/.test(value);',
    'class Heritage extends mixin({}) {} /}/.test(value);',
    'async () => { function nested() {} /}/.test(value); };',
    'return true;',
    '})()}`;',
    "const body = { 'blog.article.fixture.body1': '[x](bare-target)' };",
    '',
  ].join('\n'), 'utf8');
  try {
    const result = scanBlogBodyLinks(fixtureRoot);
    assert.equal(result.errors.length, 0);
    assert.equal(result.offenders.length, 1);
    assert.equal(result.offenders[0].target, 'bare-target');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('il gate riconosce mapped type nei parametri e nei return type senza trattarlo come chiave runtime', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-mapped-type-context-'));
  const relative = `${BLOG_BODY_ROOTS[0]}/it/mapped-type-context.ts`;
  const file = path.join(fixtureRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, [
    'type Alias = { [Key in keyof Source]: string };',
    'function typed(input: { [Key in keyof Source]: string }): { [Key in keyof Source]: string } { return input; }',
    'const arrow = (input: string): { [Key in keyof Source]: string } => input as never;',
    'class Example { method(input: { [Key in keyof Source]: string }): { [Key in keyof Source]: string } { return input; } }',
    "const body = { 'blog.article.fixture.body1': '[ok](https://example.com)' };",
    '',
  ].join('\n'), 'utf8');
  try {
    const result = scanBlogBodyLinks(fixtureRoot);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.offenders, []);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('i tre body del follow-up 3083 non reintroducono label nav italiane', () => {
  const fixtures = [
    ['content/blog-body/en/pizzautobus-varese-inclusione.ts', 'en'],
    ['content/blog-body-ch/fr/premi-lamal-san-gallo-riduzione.ts', 'fr'],
    ['content/blog-body-ch/fr/yumo-piattaforma-giovani-finanza.ts', 'fr'],
  ];
  for (const [relative, locale] of fixtures) {
    const findings = findItalianNavLinkLabels(readFileSync(path.join(ROOT, relative), 'utf8'), locale);
    assert.deepEqual(findings, [], relative);
  }
});

test('il gate non tronca una template expression su una graffa dentro una regex', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-regex-template-'));
  const relative = `${BLOG_BODY_ROOTS[0]}/it/dynamic-regex-template.ts`;
  const file = path.join(fixtureRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "const body = { 'blog.article.fixture.body1': `prefix ${/}/.test(value) ? `[fake](/bare-target)` : ''} suffix` };\n", 'utf8');
  try {
    const result = scanBlogBodyLinks(fixtureRoot);
    assert.deepEqual(result.offenders, []);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /template TypeScript dinamico non verificabile/u);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('il gate non espone il contenuto dopo una regex con new in una template expression annidata', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'article-body-link-regex-new-'));
  const relative = `${BLOG_BODY_ROOTS[0]}/it/dynamic-regex-new.ts`;
  const file = path.join(fixtureRoot, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, [
    "const helper = `prefix ${false ? new /}/ : `nested ${value}`} const body = { 'blog.article.fake.body1': '[fake](bare-target)' };`;",
    "const body = { 'blog.article.fixture.body1': '[ok](https://example.com)' };",
    '',
  ].join('\n'), 'utf8');
  try {
    const result = scanBlogBodyLinks(fixtureRoot);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.offenders, []);
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
  assert.ok(pushPaths.includes("'scripts/lib/typescript-expression-scanner.mjs'"), 'le modifiche allo scanner devono riattivare publish-api');
  assert.ok(pushPaths.includes("'generator/scripts/lib/article-excerpt.mjs'"), 'la dipendenza transitiva del writer deve riattivare publish-api');
  assert.ok(pushPaths.includes("'generator/data/canton-url-slugs.json'"), 'la sorgente delle radici attive deve riattivare publish-api');
  assert.match(linkGateStep, /PREFLIGHT_SCAN_MODE/);
  assert.match(workflow, /engine\/shared\/cantonArticleSectionCore\.generated\.mjs/);
  assert.match(gateInputBlock, /generator\/data\/canton-url-slugs\.json/);
  assert.match(gateInputBlock, /generator\/scripts\/lib\/article-excerpt\.mjs/);
  assert.match(gateInputBlock, /scripts\/lib\/typescript-expression-scanner\.mjs/);
  assert.match(gateInputBlock, /engine\/ogPagesPlugin\.ts/);
  assert.match(gateInputBlock, /engine\/shared\/normalizeArticleMarkdown\.ts/);
  assert.match(workflow, /generator\/data\/canton-url-slugs\.json/);
});

test('i publisher rapidi eseguono il link gate prima di ogni pubblicazione', () => {
  for (const file of ['fast-publish-article.yml', 'fast-publish-section.yml']) {
    const workflow = readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
    const linkGate = workflow.indexOf('node scripts/ci/check-blog-body-links.mjs');
    const syntaxGate = workflow.indexOf('node scripts/ci/check-blog-body-syntax.mjs');
    const publishJob = workflow.indexOf('\n  publish:');
    const pushPaths = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('permissions:'));
    assert.ok(linkGate > 0, `${file} non invoca il link gate`);
    assert.ok(syntaxGate > linkGate, `${file} deve eseguire il syntax gate dopo il link gate`);
    assert.ok(publishJob > linkGate, `${file} deve terminare il gate prima del job di pubblicazione`);
    assert.ok(publishJob > syntaxGate, `${file} deve terminare il syntax gate prima del job di pubblicazione`);
    for (const dependency of [
      'scripts/ci/check-blog-body-links.mjs',
      'scripts/ci/check-blog-body-syntax.mjs',
      'scripts/lib/article-link-contract.mjs',
      'scripts/lib/typescript-expression-scanner.mjs',
      'generator/scripts/lib/article-meta-block.mjs',
      'generator/scripts/lib/article-excerpt.mjs',
    ]) {
      assert.ok(pushPaths.includes(`'${dependency}'`), `${file} deve ripartire quando cambia ${dependency}`);
    }
    assert.match(workflow, /PREFLIGHT_ARTICLE_IDS/);
    assert.match(workflow, /PREFLIGHT_SECTION/);
  }
});

test('i publisher rapidi usano la stessa chiusura delle dipendenze del gate di publish-api', () => {
  const api = readFileSync(path.join(ROOT, '.github/workflows/publish-api.yml'), 'utf8');
  const apiStart = api.indexOf('gate_input_paths=(');
  const apiEnd = api.indexOf('\n            )', apiStart);
  const apiPaths = [...api.slice(apiStart, apiEnd).matchAll(/^\s+([^\s()]+)$/gm)]
    .map((match) => match[1]);
  assert.ok(apiPaths.length > 0, 'publish-api.yml deve dichiarare le dipendenze del gate');
  for (const dependency of [
    'engine/articleSeoFallback.ts',
    'engine/ogPagesPlugin.ts',
    'engine/rssFeeds.mjs',
    'engine/shared/normalizeArticleMarkdown.ts',
    'scripts/lib/typescript-expression-scanner.mjs',
  ]) {
    assert.ok(apiPaths.includes(dependency), `publish-api.yml deve includere ${dependency}`);
  }
  assert.ok(apiPaths.includes('.github/workflows/publish-api.yml'));

  for (const file of ['fast-publish-article.yml', 'fast-publish-section.yml']) {
    const workflow = readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
    const start = workflow.indexOf('gate_input_paths=(');
    const end = workflow.indexOf('\n          )', start);
    const paths = [...workflow.slice(start, end).matchAll(/^\s+([^\s()]+)$/gm)]
      .map((match) => match[1]);
    const gate = workflow.slice(start, workflow.indexOf('node scripts/ci/check-blog-body-links.mjs', start));
    const selfPath = `.github/workflows/${file}`;
    assert.ok(paths.includes(selfPath), `${file} deve riattivare il gate quando cambia`);
    assert.deepEqual(
      paths.filter((filePath) => filePath !== selfPath),
      apiPaths,
      `${file} deve condividere la chiusura di publish-api oltre al proprio path`,
    );
    assert.match(gate, /git diff --quiet "\$BEFORE" "\$AFTER" -- "\$\{gate_input_paths\[@\]\}"/);
    assert.match(gate, /git diff --name-only "\$BEFORE" "\$AFTER" -- content/);
  }
});

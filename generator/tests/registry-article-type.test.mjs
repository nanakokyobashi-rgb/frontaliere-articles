/**
 * Il registry degli articoli registra COSA e' l'articolo (`articleType`) e
 * COSA e' stato verificato (`verifiedAt`).
 *
 * Content gate di `main` (`scripts/ci/content-gates-main.mjs`): gira dopo il
 * push dei bot e SENZA `npm ci`. Per questo importa soltanto
 * `generator/scripts/lib/registry-article-type.mjs` e builtin `node:`; il
 * generatore (`create-article.mjs`, che trascina jsdom) e' letto come TESTO.
 *
 * Diventa rosso quando:
 *   - un produttore registra senza tipo (la voce lancia in `renderRegistryEntry`);
 *   - una voce nata da `typedFrom` (`data/article-type-cutover.json`) non ha
 *     `articleType: 'news'|'evergreen'`;
 *   - un `verifiedAt` non ha la sua prova nel ledger
 *     `data/evergreen-verifications.json` (niente bump di data travestito);
 *   - `create-article.mjs` smette di usare il modulo del registry.
 *
 * Titolo di fallimento: «articleType assente su voce di registry nuova (gate
 * content su main)».
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REGISTRY_ARTICLE_TYPES,
  registryArticleType,
  registryArticleTypeForRun,
  resolveArticleType,
  renderRegistryEntry,
  readRegistryEntries,
  scanRegistryTyping,
  verifiedAtProblems,
} from '../scripts/lib/registry-article-type.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const REGISTRIES = [
  // Il pavimento dice «il parser ha letto il registry», non quante voci deve
  // avere: i bot appendono, il conteggio cresce.
  { file: path.join(ROOT, 'content', 'blog-articles-data.ts'), floor: 4000 },
  { file: path.join(ROOT, 'content', 'swiss-articles-data.ts'), floor: 1000 },
];
const CUTOVER_FILE = path.join(ROOT, 'data', 'article-type-cutover.json');
const LEDGER_FILE = path.join(ROOT, 'data', 'evergreen-verifications.json');
const GENERATOR_FILE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');

const DAY_MS = 24 * 60 * 60 * 1000;
const todayYmd = () => new Date().toISOString().slice(0, 10);
const LAYOUT = { objIndent: ' ', propIndent: ' ', today: '2026-10-05T07:00:00.000Z', imagePath: '/images/blog/x.webp' };

describe('registryArticleType: il tipo scelto dal generatore primario', () => {
  test('evergreen_static / evergreen_dynamic → evergreen', () => {
    assert.equal(registryArticleType('evergreen_static'), 'evergreen');
    assert.equal(registryArticleType('evergreen_dynamic'), 'evergreen');
  });
  test('news, experimental, null, undefined → news', () => {
    for (const v of ['news', 'experimental', null, undefined]) {
      assert.equal(registryArticleType(v), 'news', String(v));
    }
  });
});

describe('registryArticleTypeForRun: il percorso AI primario', () => {
  test('un URL evergreen:// e\' una guida anche con etichetta experimental o null', () => {
    // Tier experimental del ranker → evergreen://<keyword>; modalita' manuale
    // con evergreen:// lascia selectedArticleType a null.
    for (const sel of ['experimental', null, undefined, 'news']) {
      assert.equal(registryArticleTypeForRun(sel, 'evergreen://permesso%20G'), 'evergreen', String(sel));
    }
  });
  test('senza evergreen:// decide l\'etichetta del run', () => {
    assert.equal(registryArticleTypeForRun('evergreen_static', 'evergreen://x'), 'evergreen');
    assert.equal(registryArticleTypeForRun('evergreen_dynamic', null), 'evergreen');
    assert.equal(registryArticleTypeForRun('news', 'https://www.rsi.ch/news/x'), 'news');
    assert.equal(registryArticleTypeForRun('experimental', 'https://www.rsi.ch/news/x'), 'news');
    assert.equal(registryArticleTypeForRun(null, 'stats-bfs://salari'), 'news');
    assert.equal(registryArticleTypeForRun(undefined, undefined), 'news');
  });
});

describe('resolveArticleType: i produttori di registerArticleFiles()', () => {
  test('skipNews: true → evergreen; nessuna opzione → news', () => {
    assert.equal(resolveArticleType({ id: 'a' }, { skipNews: true }), 'evergreen');
    assert.equal(resolveArticleType({ id: 'a' }, {}), 'news');
    assert.equal(resolveArticleType({ id: 'a' }), 'news');
  });
  test('un articleType esplicito vince su skipNews', () => {
    assert.equal(resolveArticleType({ id: 'a', articleType: 'news' }, { skipNews: true }), 'news');
    assert.equal(resolveArticleType({ id: 'a', articleType: 'evergreen' }, {}), 'evergreen');
  });
  test('un valore non ammesso lancia', () => {
    for (const bad of ['guide', 'evergreen_static', '', null]) {
      assert.throws(() => resolveArticleType({ id: 'a', articleType: bad }), /non ammesso/, JSON.stringify(bad));
    }
  });
});

describe('renderRegistryEntry: l\'unico scrittore del registry', () => {
  const base = {
    id: 'guida-x',
    category: 'pratico',
    hasCalculator: false,
    author: { slug: 'redazione', name: "Redazione Frontaliere Ticino d'Italia" },
  };

  for (const type of REGISTRY_ARTICLE_TYPES) {
    test(`emette articleType: '${type}' subito dopo hasCalculator`, () => {
      const lines = renderRegistryEntry({ ...base, articleType: type }, LAYOUT);
      const hc = lines.findIndex((l) => l.includes('hasCalculator:'));
      assert.ok(hc > 0, 'riga hasCalculator assente');
      assert.equal(lines[hc + 1], ` articleType: '${type}',`);
      assert.equal(lines[0], ' {');
      assert.equal(lines.at(-1), ' },');
      // Il byline resta, con l'escape a singoli apici.
      assert.ok(lines.includes(" authorName: 'Redazione Frontaliere Ticino d\\'Italia',"), lines.join('\n'));
      // La voce emessa e' letta dallo stesso parser del gate.
      const [entry] = readRegistryEntries(lines.join('\n'));
      assert.equal(entry.articleType, type);
      assert.equal(entry.date, LAYOUT.today);
    });
  }

  test('senza articleType (produttore che non passa dal mapping) lancia', () => {
    assert.throws(() => renderRegistryEntry(base, LAYOUT), /articleType assente/);
    assert.throws(() => renderRegistryEntry({ ...base, articleType: 'evergreen_dynamic' }, LAYOUT), /articleType assente/);
  });
});

describe('create-article.mjs usa il modulo del registry (letto come testo)', () => {
  const src = fs.readFileSync(GENERATOR_FILE, 'utf8');

  test('importa da ./lib/registry-article-type.mjs', () => {
    assert.match(src, /from '\.\/lib\/registry-article-type\.mjs'/);
  });

  test('modifyBlogArticlesTsx costruisce la voce con renderRegistryEntry(', () => {
    const start = src.indexOf('function modifyBlogArticlesTsx(');
    assert.ok(start >= 0, 'modifyBlogArticlesTsx non trovata');
    const end = src.indexOf('\n}\n', start);
    const body = src.slice(start, end);
    assert.ok(body.includes('renderRegistryEntry('), 'modifyBlogArticlesTsx non usa renderRegistryEntry(');
    assert.ok(!/hasCalculator:\s*\$\{/.test(body), 'modifyBlogArticlesTsx emette ancora le righe inline');
  });

  test('registerArticleFiles chiama resolveArticleType( prima di modifyBlogArticlesTsx', () => {
    const start = src.indexOf('export async function registerArticleFiles(');
    assert.ok(start >= 0, 'registerArticleFiles non trovata');
    const end = src.indexOf('\n}\n', start);
    const body = src.slice(start, end);
    const resolveAt = body.indexOf('resolveArticleType(');
    const writeAt = body.indexOf('modifyBlogArticlesTsx(data)');
    assert.ok(resolveAt >= 0, 'registerArticleFiles non chiama resolveArticleType(');
    assert.ok(writeAt > resolveAt, 'resolveArticleType( deve precedere modifyBlogArticlesTsx(data)');
  });

  test('ogni chiamata di modifyBlogArticlesTsx(data) e\' preceduta dall\'assegnazione del tipo', () => {
    const calls = [...src.matchAll(/^\s*modifyBlogArticlesTsx\(data\);/gm)];
    assert.ok(calls.length >= 2, `attese almeno 2 chiamate, trovate ${calls.length}`);
    for (const c of calls) {
      const window = src.slice(Math.max(0, c.index - 1500), c.index);
      assert.match(
        window,
        /data\.articleType = (?:registryArticleTypeForRun|resolveArticleType)\(/,
        `chiamata a offset ${c.index} senza data.articleType = registryArticleTypeForRun(/resolveArticleType( poco prima`,
      );
    }
    // Il percorso primario decide dall'URL di generazione, non solo dall'etichetta.
    assert.match(src, /data\.articleType = registryArticleTypeForRun\(RUN_REPORT\.selectedArticleType, url\)/);
  });
});

describe('cutover: data/article-type-cutover.json', () => {
  test('typedFrom e\' una data valida e non oltre 2 giorni da oggi', () => {
    const { typedFrom } = JSON.parse(fs.readFileSync(CUTOVER_FILE, 'utf8'));
    assert.match(typedFrom, /^\d{4}-\d{2}-\d{2}$/);
    const t = Date.parse(`${typedFrom}T00:00:00Z`);
    assert.ok(Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === typedFrom, `typedFrom invalida: ${typedFrom}`);
    // Un cutover spinto avanti spegnerebbe il gate.
    assert.ok(t <= Date.now() + 2 * DAY_MS, `typedFrom ${typedFrom} oltre 2 giorni da oggi: il gate non guarderebbe niente`);
  });
});

describe('scanRegistryTyping: le voci nuove hanno articleType', () => {
  const synthetic = [
    'const RAW_ARTICLES = [',
    " {\n id: 'vecchia',\n category: 'pratico',\n date: '2026-09-01',\n image: '/a.webp',\n hasCalculator: false,\n },",
    " {\n id: 'nuova-tipata',\n category: 'pratico',\n date: '2026-10-06T08:00:00.000Z',\n image: '/b.webp',\n hasCalculator: false,\n articleType: 'evergreen',\n },",
    " {\n id: 'nuova-senza-tipo',\n category: 'novita',\n date: '2026-10-06T09:00:00.000Z',\n image: '/c.webp',\n hasCalculator: false,\n authorSlug: 'redazione',\n },",
    " {\n id: 'nuova-tipo-invalido',\n category: 'novita',\n date: '2026-10-05',\n image: '/d.webp',\n hasCalculator: false,\n articleType: 'guide',\n },",
    '] satisfies Article[];',
  ].join('\n');

  test('segnala la voce posteriore a typedFrom senza campo (e con valore invalido)', () => {
    const r = scanRegistryTyping(synthetic, '2026-10-05');
    assert.equal(r.total, 4);
    assert.deepEqual(r.offenders, ['nuova-senza-tipo', 'nuova-tipo-invalido']);
  });

  test('le voci anteriori a typedFrom non contano', () => {
    assert.deepEqual(scanRegistryTyping(synthetic, '2026-10-07').offenders, []);
  });

  test('typedFrom malformata lancia invece di passare', () => {
    assert.throws(() => scanRegistryTyping(synthetic, '05/10/2026'), /YYYY-MM-DD/);
  });

  test('registry reali: nessuna voce da typedFrom in poi senza articleType', () => {
    const { typedFrom } = JSON.parse(fs.readFileSync(CUTOVER_FILE, 'utf8'));
    for (const { file, floor } of REGISTRIES) {
      const rel = path.relative(ROOT, file);
      const r = scanRegistryTyping(fs.readFileSync(file, 'utf8'), typedFrom);
      assert.ok(r.total >= floor, `${rel}: il parser ha letto ${r.total} voci (< ${floor}): non ha guardato niente`);
      assert.deepEqual(
        r.offenders,
        [],
        `articleType assente su voce di registry nuova (gate content su main): ${rel}, voci nate da ${typedFrom} `
          + `senza articleType: ${r.offenders.join(', ')}`,
      );
    }
  });
});

describe('verifiedAt: solo con la prova nel ledger delle verifiche', () => {
  const entry = (id, date, verifiedAt) => ({ id, date, verifiedAt });
  const proof = (verifiedAt) => ({
    verifiedAt,
    sources: ['https://www.ti.ch/fonte'],
    unchanged: ['aliquota invariata al 4%'],
  });

  test('voce verificata con prova coerente: nessun difetto', () => {
    assert.deepEqual(
      verifiedAtProblems([entry('g', '2026-01-10T07:00:00.000Z', '2026-10-01')], { g: proof('2026-10-01') }, '2026-10-04'),
      [],
    );
  });

  test('verifiedAt senza voce nel ledger: rosso (bump di data travestito)', () => {
    const p = verifiedAtProblems([entry('g', '2026-01-10', '2026-10-01')], {}, '2026-10-04');
    assert.equal(p.length, 1);
    assert.match(p[0], /senza voce nel ledger/);
  });

  test('ledger con data diversa, senza https, senza fatti: rosso', () => {
    const p = verifiedAtProblems(
      [entry('g', '2026-01-10', '2026-10-01')],
      { g: { verifiedAt: '2026-09-30', sources: ['http://x'], unchanged: ['  '] } },
      '2026-10-04',
    );
    assert.equal(p.length, 3, p.join('\n'));
  });

  test('formato invalido, futuro, anteriore a date: rosso', () => {
    assert.match(verifiedAtProblems([entry('g', '2026-01-10', '2026-13-01')], {}, '2026-10-04')[0], /YYYY-MM-DD/);
    assert.ok(
      verifiedAtProblems([entry('g', '2026-01-10', '2026-10-09')], { g: proof('2026-10-09') }, '2026-10-04')
        .some((m) => /nel futuro/.test(m)),
    );
    assert.ok(
      verifiedAtProblems([entry('g', '2026-03-10T08:00:00.000Z', '2026-03-01')], { g: proof('2026-03-01') }, '2026-10-04')
        .some((m) => /anteriore a date/.test(m)),
    );
  });

  test('voce di ledger senza verifiedAt nel registry: rosso', () => {
    const p = verifiedAtProblems([entry('g', '2026-01-10', undefined)], { g: proof('2026-10-01') }, '2026-10-04');
    assert.deepEqual(p, ['g: voce di ledger senza verifiedAt nel registry']);
  });

  test('registry reali e ledger: coerenti', () => {
    const ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    const entries = REGISTRIES.flatMap(({ file }) => readRegistryEntries(fs.readFileSync(file, 'utf8')));
    assert.deepEqual(verifiedAtProblems(entries, ledger, todayYmd()), []);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyRegistryArticleTypes,
  registryArticleTypeForRun,
  renderArticleTypeLine,
  renderRegistryEntry,
  readRegistryEntries,
} from '../scripts/lib/registry-article-type.mjs';
import * as backfillType from '../scripts/backfill-article-type.mjs';
import * as backfillCantons from '../scripts/backfill-article-cantons.mjs';
import * as tsStringMap from '../scripts/lib/ts-string-map.mjs';

const { articleTypeFromItalianBody, readTsStringMap } = backfillType;
const CREATE_ARTICLE = readFileSync(
  new URL('../scripts/create-article.mjs', import.meta.url),
  'utf8',
);

const SOURCE = '*Fonte: [tio.ch](https://www.tio.ch/ticino/attualita/123)*';

describe('articleType dal corpo italiano', () => {
  test('riconosce la citazione finale unica del generatore come news', () => {
    assert.equal(articleTypeFromItalianBody(`Testo della notizia.\n\n${SOURCE}`), 'news');
  });

  test('lascia senza tipo una citazione non finale o non unica', () => {
    assert.equal(articleTypeFromItalianBody(`${SOURCE}\n\nAltro testo.`), undefined);
    assert.equal(articleTypeFromItalianBody(`Primo\n\n${SOURCE}\n\nSecondo\n\n${SOURCE}`), undefined);
  });

  test('le citazioni statistiche BFS e ASTRA ricevono il tipo che il writer da\' a quelle run', () => {
    // Lo Step 3e di create-article.mjs sostituisce la chiave sintetica con la
    // pagina pubblica, ma il tipo lo decide l'URL della run: il backfill deve
    // dare allo stock lo stesso tipo che un articolo nuovo riceve oggi.
    const casi = [
      ['stats-bfs://2026-Q2', 'https://www.bfs.admin.ch/bfs/it/home/statistiche/industria-servizi.html', 'bfs.admin.ch'],
      ['stats-astra://2026-W38', 'https://www.astra.admin.ch/astra/it/home/documentazione/dati-aperti/veicoli.html', 'astra.admin.ch'],
    ];
    for (const [runUrl, citationUrl, domain] of casi) {
      const writer = registryArticleTypeForRun(null, runUrl);
      assert.equal(writer, 'news', runUrl);
      assert.equal(
        articleTypeFromItalianBody(`Dati del periodo.\n\n*Fonte: [${domain}](${citationUrl})*`),
        writer,
        `${domain}: il backfill deve coincidere col writer`,
      );
    }
  });

  test('richiede il dominio nel link, come la citazione del generatore', () => {
    assert.equal(
      articleTypeFromItalianBody('Testo.\n\n*Fonte: [Ufficio federale](https://www.tio.ch/ticino/attualita/123)*'),
      undefined,
    );
  });

  test('una voce ambigua resta senza tipo', () => {
    assert.equal(articleTypeFromItalianBody('Guida pratica senza fonte unica.'), undefined);
  });
});

describe('premesse sul generatore: chi porta la citazione e\' nato da una run non evergreen', () => {
  test('la citazione finale e\' scritta da un solo punto e mai per un URL evergreen://', () => {
    const scritture = CREATE_ARTICLE.split('\n')
      .filter((line) => line.includes('[${sourceDomain}](${citationUrl})'));
    assert.equal(scritture.length, 1, 'un solo punto di create-article.mjs scrive la citazione Fonte');
    const guardia = CREATE_ARTICLE.indexOf("if (citationUrl && !citationUrl.startsWith('evergreen://')) {");
    const scrittura = CREATE_ARTICLE.indexOf(scritture[0]);
    assert.ok(guardia > 0, 'la guardia evergreen:// dello Step 3e deve esistere');
    assert.ok(
      scrittura > guardia && scrittura - guardia < 1200,
      'la scrittura della citazione deve stare dentro la guardia evergreen://',
    );
  });

  test('un\'etichetta evergreen_* nasce solo insieme a un URL evergreen://', () => {
    const righe = CREATE_ARTICLE.split('\n');
    const assegnazioni = righe
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /selectedArticleType\s*=.*evergreen_(static|dynamic)/u.test(line));
    assert.ok(assegnazioni.length >= 1, 'il generatore deve assegnare le etichette evergreen_*');
    for (const { index } of assegnazioni) {
      const vicine = righe.slice(index, index + 4).join('\n');
      assert.match(
        vicine,
        /RUN_REPORT\.selectedUrl = `evergreen:\/\//u,
        `riga ${index + 1}: evergreen_* senza URL evergreen:// subito dopo`,
      );
    }
  });

  test('il writer decide il tipo con registryArticleTypeForRun, la stessa funzione del backfill', () => {
    assert.match(
      CREATE_ARTICLE,
      /data\.articleType = registryArticleTypeForRun\(RUN_REPORT\.selectedArticleType, url\);/u,
    );
    assert.equal(registryArticleTypeForRun(undefined, 'https://www.tio.ch/ticino/attualita/123'), 'news');
    assert.equal(registryArticleTypeForRun('news', 'evergreen://guida'), 'evergreen');
  });
});

describe('lettore TS condiviso', () => {
  test('i due backfill del registry usano lo stesso decodificatore, non una copia', () => {
    for (const name of ['readTsStringLiteral', 'readTsStringMap']) {
      assert.equal(backfillType[name], tsStringMap[name], `backfill-article-type: ${name}`);
      assert.equal(backfillCantons[name], tsStringMap[name], `backfill-article-cantons: ${name}`);
    }
  });
});

describe('scrittura del registry', () => {
  const entry = (id, extra = '') => [
    '  {',
    `    id: '${id}',`,
    "    category: 'pratico',",
    "    date: '2026-03-01',",
    "    image: '/images/blog/x.webp',",
    '    hasCalculator: false,',
    extra,
    '    verifiedAt: \'2026-10-01\',',
    '  },',
  ].filter(Boolean).join('\n');

  test('inserisce la riga del generatore e non tocca gli altri campi', () => {
    const before = `const articles = [\n${entry('ambigua')}\n];\n`;
    const first = applyRegistryArticleTypes(before, new Map([['ambigua', 'news']]));
    assert.equal(first.changed, 1);
    const expected = before.replace(
      '    hasCalculator: false,\n',
      "    hasCalculator: false,\n    articleType: 'news',\n",
    );
    assert.equal(first.source, expected);
    const renderedType = renderArticleTypeLine('news', '    ');
    assert.equal(renderedType, "    articleType: 'news',");
    const generated = renderRegistryEntry({ id: 'x', category: 'pratico', articleType: 'news' }, {
      objIndent: '  ', propIndent: '    ', today: '2026-10-06', imagePath: '/x.webp',
    });
    assert.ok(generated.includes(renderedType));
  });

  test('è idempotente e lascia intatta la voce ambigua', () => {
    const before = `const articles = [\n${entry('certa')}\n${entry('ambigua')}\n];\n`;
    const first = applyRegistryArticleTypes(before, new Map([['certa', 'news']]));
    const second = applyRegistryArticleTypes(first.source, new Map([['certa', 'news']]));
    assert.equal(first.changed, 1);
    assert.equal(second.changed, 0);
    assert.equal(second.source, first.source);
    const rows = readRegistryEntries(second.source);
    assert.deepEqual(rows.map((row) => [row.id, row.articleType]), [['certa', 'news'], ['ambigua', undefined]]);
  });
});

test('il lettore TS decodifica il body3 italiano con apostrofi ed escape', () => {
  const source = "'blog.article.demo.body3': 'L\\'articolo\\n\\nFonte',";
  assert.equal(readTsStringMap(source).get('blog.article.demo.body3'), "L'articolo\n\nFonte");
});

describe('ledger di lettura e piano di backfill', () => {
  test('il ledger reale copre i 210 stale con forma e conteggi attesi', () => {
    const rows = backfillType.readArticleTypeReadings();
    const counts = Object.fromEntries(['news', 'evergreen', 'unclassified'].map((decision) => [
      decision,
      rows.filter((row) => row.decision === decision).length,
    ]));
    assert.equal(rows.length, 210);
    assert.deepEqual(counts, { news: 47, evergreen: 22, unclassified: 141 });
    assert.equal(new Set(rows.map((row) => row.id)).size, 210);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['basis', 'decision', 'id', 'readAt', 'reason']);
      assert.equal(row.basis, 'reading');
      assert.match(row.readAt, /^\d{4}-\d{2}-\d{2}$/u);
      assert.ok(row.reason.length > 0);
    }
  });

  test('il ledger rifiuta id assenti e decisioni non ammesse', () => {
    withFixture((root) => {
      const rows = backfillType.readArticleTypeReadings(root);
      rows[0].id = 'non-presente-nel-registry';
      writeLedger(root, rows);
      assert.throws(() => backfillType.readArticleTypeReadings(root), /id assente dal registry/u);

      rows[0].id = 'ledger-news';
      rows[0].decision = 'not-a-type';
      writeLedger(root, rows);
      assert.throws(() => backfillType.readArticleTypeReadings(root), /decisione non valida/u);
    });
  });

  test('il manifesto rifiuta una riga editoriale omessa prima del fallback per citazione', () => {
    withFixture((root) => {
      const rows = backfillType.readArticleTypeReadings(root);
      rows.push({
        id: 'citation-news',
        decision: 'unclassified',
        reason: 'Lettura editoriale non conclusiva.',
        readAt: '2026-10-06',
        basis: 'reading',
      });
      writeLedger(root, rows);
      const truncated = rows.filter((row) => row.id !== 'citation-news');
      writeFileSync(join(root, 'data/article-type-readings.json'), `${JSON.stringify(truncated, null, 2)}\n`);

      assert.throws(() => backfillType.planBackfill(root), /copertura incompleta/u);
    });
  });

  test('il manifesto rifiuta contenuto alterato anche se il numero di righe non cambia', () => {
    withFixture((root) => {
      const rows = backfillType.readArticleTypeReadings(root);
      writeLedger(root, rows);
      const altered = rows.map((row, index) => index === 0 ? { ...row, reason: 'motivo alterato' } : row);
      writeFileSync(join(root, 'data/article-type-readings.json'), `${JSON.stringify(altered, null, 2)}\n`);

      assert.throws(
        () => backfillType.readArticleTypeReadings(root),
        /digest di copertura non corrispondente/u,
      );
    });
  });

  test('il ledger rifiuta readAt successivi al giorno di verifica', () => {
    withFixture((root) => {
      const rows = backfillType.readArticleTypeReadings(root);
      rows[0].readAt = '2026-10-07';
      writeLedger(root, rows);

      assert.equal(backfillType.isReadAtNotFuture('2026-10-07', '2026-10-06'), false);
      assert.throws(
        () => backfillType.readArticleTypeReadings(root, { todayYmd: '2026-10-06' }),
        /readAt nel futuro/u,
      );
    });
  });

  function withFixture(callback) {
    const root = mkdtempSync(join(tmpdir(), 'frontaliere-backfill-'));
    mkdirSync(join(root, 'content/blog-body/it'), { recursive: true });
    mkdirSync(join(root, 'content/blog-body-ch/it'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    const entry = (id, articleType = '') => [
      '  {',
      `    id: '${id}',`,
      "    category: 'pratico',",
      "    date: '2026-03-01',",
      "    image: '/images/blog/x.webp',",
      '    hasCalculator: false,',
      articleType ? `    articleType: '${articleType}',` : '',
      "    verifiedAt: '2026-10-01',",
      '  },',
    ].filter(Boolean).join('\n');
    writeFileSync(
      join(root, 'content/blog-articles-data.ts'),
      `const articles = [\n${[
        entry('ledger-news'),
        entry('ledger-guide'),
        entry('ledger-uncertain'),
        entry('citation-news'),
        entry('already-typed', 'news'),
      ].join('\n')}\n];\n`,
    );
    writeFileSync(join(root, 'content/swiss-articles-data.ts'), `const articles = [\n${entry('swiss-citation')}\n];\n`);
    writeFileSync(
      join(root, 'content/blog-body/it/citation-news.ts'),
      "const fields = {\n  'blog.article.citation-news.body3': 'Testo.\\n\\n*Fonte: [tio.ch](https://www.tio.ch/ticino/attualita/123)*',\n};\n",
    );
    writeFileSync(
      join(root, 'content/blog-body-ch/it/swiss-citation.ts'),
      "const fields = {\n  'blog.article.swiss-citation.body3': 'Testo.\\n\\n*Fonte: [tio.ch](https://www.tio.ch/ticino/attualita/124)*',\n};\n",
    );
    writeLedger(root, [
      { id: 'ledger-news', decision: 'news', reason: 'Cronaca datata inequivocabile.', readAt: '2026-10-06', basis: 'reading' },
      { id: 'ledger-guide', decision: 'evergreen', reason: 'Guida pratica inequivocabile.', readAt: '2026-10-06', basis: 'reading' },
      { id: 'ledger-uncertain', decision: 'unclassified', reason: 'La lettura non distingue con certezza il tipo.', readAt: '2026-10-06', basis: 'reading' },
    ]);
    try {
      return callback(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test('il piano usa il ledger solo per frontaliere e conserva il fallback per citazione', () => {
    withFixture((root) => {
      const plan = backfillType.planBackfill(root);
      assert.deepEqual(
        [...plan.frontaliere.typesById.entries()].sort(),
        [['citation-news', 'news'], ['ledger-guide', 'evergreen'], ['ledger-news', 'news']],
      );
      assert.equal(plan.frontaliere.withoutType, 1);
      assert.equal(plan.frontaliere.missingBody, 1);
      assert.deepEqual([...plan.svizzera.typesById.entries()], [['swiss-citation', 'news']]);
    });
  });

  test("apply e' idempotente e scrive solo articleType, senza verifiedAt", () => {
    withFixture((root) => {
      const beforeFront = readFileSync(join(root, 'content/blog-articles-data.ts'), 'utf8');
      const beforeSwiss = readFileSync(join(root, 'content/swiss-articles-data.ts'), 'utf8');
      const plan = backfillType.planBackfill(root);
      const expectedFront = applyRegistryArticleTypes(beforeFront, plan.frontaliere.typesById).source;
      const expectedSwiss = applyRegistryArticleTypes(beforeSwiss, plan.svizzera.typesById).source;
      assert.deepEqual(backfillType.applyPlan(plan), { frontaliere: 3, svizzera: 1 });
      assert.equal(readFileSync(join(root, 'content/blog-articles-data.ts'), 'utf8'), expectedFront);
      assert.equal(readFileSync(join(root, 'content/swiss-articles-data.ts'), 'utf8'), expectedSwiss);
      assert.equal(
        (readFileSync(join(root, 'content/blog-articles-data.ts'), 'utf8').match(/verifiedAt:/gu) || []).length,
        5,
      );

      const secondPlan = backfillType.planBackfill(root);
      const frontAfterFirst = readFileSync(join(root, 'content/blog-articles-data.ts'), 'utf8');
      assert.deepEqual(backfillType.applyPlan(secondPlan), { frontaliere: 0, svizzera: 0 });
      assert.equal(readFileSync(join(root, 'content/blog-articles-data.ts'), 'utf8'), frontAfterFirst);
    });
  });

  test('apply ripristina il primo registry se il rename del secondo fallisce', () => {
    withFixture((root) => {
      const plan = backfillType.planBackfill(root);
      const frontFile = join(root, 'content/blog-articles-data.ts');
      const before = readFileSync(frontFile, 'utf8');
      const blockedSwissPath = join(root, 'swiss-registry-is-a-directory');
      mkdirSync(blockedSwissPath);
      plan.svizzera.registryFile = blockedSwissPath;

      assert.throws(() => backfillType.applyPlan(plan), /EISDIR|EEXIST|directory/u);
      assert.equal(readFileSync(frontFile, 'utf8'), before, 'il primo registry deve tornare ai byte originali');
      assert.deepEqual(readdirSync(join(root, 'content')).filter((name) => name.endsWith('.tmp')), []);
      assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.pair.tmp')), []);
    });
  });

  function writeLedger(root, rows) {
    const manifest = {
      schemaVersion: 1,
      expectedRows: rows.length,
      rowsSha256: backfillType.articleTypeReadingsDigest(rows),
    };
    writeFileSync(join(root, 'data/article-type-readings.json'), `${JSON.stringify(rows, null, 2)}\n`);
    writeFileSync(join(root, 'data/article-type-readings.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }
});

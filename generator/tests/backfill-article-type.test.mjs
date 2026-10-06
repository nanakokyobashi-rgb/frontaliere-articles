import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

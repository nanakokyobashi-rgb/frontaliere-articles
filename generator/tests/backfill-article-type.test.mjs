import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRegistryArticleTypes,
  renderArticleTypeLine,
  renderRegistryEntry,
  readRegistryEntries,
} from '../scripts/lib/registry-article-type.mjs';
import {
  articleTypeFromItalianBody,
  readTsStringMap,
} from '../scripts/backfill-article-type.mjs';

const SOURCE = '*Fonte: [tio.ch](https://www.tio.ch/ticino/attualita/123)*';

describe('articleType dal corpo italiano', () => {
  test('riconosce la citazione finale unica del generatore come news', () => {
    assert.equal(articleTypeFromItalianBody(`Testo della notizia.\n\n${SOURCE}`), 'news');
  });

  test('lascia senza tipo una citazione non finale o non unica', () => {
    assert.equal(articleTypeFromItalianBody(`${SOURCE}\n\nAltro testo.`), undefined);
    assert.equal(articleTypeFromItalianBody(`Primo\n\n${SOURCE}\n\nSecondo\n\n${SOURCE}`), undefined);
  });

  test('esclude le citazioni statistiche BFS e ASTRA', () => {
    assert.equal(
      articleTypeFromItalianBody(
        'Dati BFS.\n\n*Fonte: [bfs.admin.ch](https://www.bfs.admin.ch/bfs/it/home/statistiche/industria-servizi.html)*',
      ),
      undefined,
    );
    assert.equal(
      articleTypeFromItalianBody(
        'Dati ASTRA.\n\n*Fonte: [astra.admin.ch](https://www.astra.admin.ch/astra/it/home/documentazione/dati-aperti/veicoli.html)*',
      ),
      undefined,
    );
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

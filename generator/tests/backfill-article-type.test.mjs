import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
import { legacyNewsUrlKey, newsUrlKey } from '../scripts/lib/source-url-ledger.mjs';

const { articleTypeFromItalianBody, readTsStringMap } = backfillType;
const { isGeneratedSourceCitation } = backfillType;
const CREATE_ARTICLE = readFileSync(
  new URL('../scripts/create-article.mjs', import.meta.url),
  'utf8',
);

const SOURCE = '*Fonte: [tio.ch](https://www.tio.ch/ticino/attualita/123)*';
const SOURCE_URL = 'https://www.tio.ch/ticino/attualita/123';
const generatedSource = (articleId, url = SOURCE_URL) => ({
  [newsUrlKey(url)]: { articleId, ts: '2026-10-06T12:00:00.000Z' },
});

describe('articleType dal corpo italiano', () => {
  test('riconosce la citazione solo se il ledger la collega allo stesso articolo', () => {
    const body = `Testo della notizia.\n\n${SOURCE}`;
    assert.equal(isGeneratedSourceCitation(body, 'article-1', generatedSource('article-1')), true);
    assert.equal(articleTypeFromItalianBody(body, 'article-1', generatedSource('article-1')), 'news');
    assert.equal(isGeneratedSourceCitation(body, 'article-2', generatedSource('article-1')), false);
    assert.equal(isGeneratedSourceCitation(body, 'article-1', {}), false);
    assert.equal(
      isGeneratedSourceCitation(body, 'article-1', { [newsUrlKey(SOURCE_URL)]: 'article-1' }),
      true,
      'mantiene compatibilità con le voci storiche del ledger',
    );
    assert.equal(
      isGeneratedSourceCitation(body, 'article-1', {
        [newsUrlKey(SOURCE_URL + '#ft-item=012345abcdef')]: { articleId: 'article-1' },
      }),
      true,
      'l’identità del feed resta nel ledger ma non nella citazione pubblica',
    );
  });

  test('riconosce URL Markdown con parentesi bilanciate', () => {
    const balanced = String.raw`Testo della notizia.

*Fonte: [tio.ch](https://www.tio.ch/ticino/attualita/articolo_(completo).html)*`;
    assert.equal(
      articleTypeFromItalianBody(
        balanced,
        'article-balanced',
        generatedSource('article-balanced', 'https://www.tio.ch/ticino/attualita/articolo_(completo).html'),
      ),
      'news',
    );
  });

  test('riconosce parentesi escaped e conserva la citazione semplice', () => {
    const escaped = String.raw`Testo della notizia.

*Fonte: [tio.ch](https://www.tio.ch/ticino/attualita/articolo\(completo\).html)*`;
    assert.equal(
      articleTypeFromItalianBody(
        escaped,
        'article-escaped',
        generatedSource('article-escaped', 'https://www.tio.ch/ticino/attualita/articolo(completo).html'),
      ),
      'news',
    );
    assert.equal(
      articleTypeFromItalianBody(`Testo della notizia.\n\n${SOURCE}`, 'article-1', generatedSource('article-1')),
      'news',
    );
  });

  test('decodifica gli escape TS dell URL e riconosce la parentesi chiusa risultante', () => {
    const cases = [
      ['\\)', 'https://example.ch/a)b'],
      ['\\x29', 'https://example.ch/a)b'],
      ['\\u0029', 'https://example.ch/a)b'],
      ['\\u{0029}', 'https://example.ch/a)b'],
    ];
    for (const [escape, url] of cases) {
      const source = `'blog.article.demo.body3': 'Testo.\\n\\n*Fonte: [example.ch](https://example.ch/a${escape}b)*',`;
      const body = readTsStringMap(source).get('blog.article.demo.body3');
      assert.equal(body, `Testo.\n\n*Fonte: [example.ch](${url})*`, escape);
      assert.equal(
        articleTypeFromItalianBody(body, 'article-escaped-ts', generatedSource('article-escaped-ts', url)),
        'news',
        escape,
      );
    }
  });

  test('mantiene la compatibilita\u0300 con una chiave storica senza query identificante', () => {
    const url = 'https://example.ch/news?id=7';
    const body = `Testo della notizia.\n\n*Fonte: [example.ch](${url})*`;
    assert.equal(
      articleTypeFromItalianBody(
        body,
        'article-historical-query',
        { [legacyNewsUrlKey(url)]: 'article-historical-query' },
      ),
      'news',
    );
    assert.equal(
      isGeneratedSourceCitation(
        body,
        'article-query-7',
        { [newsUrlKey('https://example.ch/news?id=8')]: { articleId: 'article-query-7', keyForm: 2 } },
      ),
      false,
      'una voce corrente con un id diverso non deve ricadere sul path storico',
    );
  });

  test('una chiave storica path-only non prova una citazione con identita\u0300 item', () => {
    const urlWithItem = `${SOURCE_URL}#ft-item=012345abcdef`;
    const body = `Testo della notizia.\n\n*Fonte: [tio.ch](${urlWithItem})*`;
    const oldLedger = { [legacyNewsUrlKey(SOURCE_URL)]: 'article-item-2' };
    assert.equal(isGeneratedSourceCitation(body, 'article-item-2', oldLedger), false);
    assert.equal(articleTypeFromItalianBody(body, 'article-item-2', oldLedger), undefined);
  });

  test('lascia senza tipo una citazione non finale o non unica', () => {
    assert.equal(articleTypeFromItalianBody(`${SOURCE}\n\nAltro testo.`, 'article-1', generatedSource('article-1')), undefined);
    assert.equal(articleTypeFromItalianBody(`Primo\n\n${SOURCE}\n\nSecondo\n\n${SOURCE}`, 'article-1', generatedSource('article-1')), undefined);
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
        articleTypeFromItalianBody(
          `Dati del periodo.\n\n*Fonte: [${domain}](${citationUrl})*`,
          domain,
          generatedSource(domain, runUrl),
        ),
        writer,
        `${domain}: il backfill deve coincidere col writer`,
      );
    }
  });

  test('richiede il dominio nel link, come la citazione del generatore', () => {
    assert.equal(
      articleTypeFromItalianBody(
        'Testo.\n\n*Fonte: [Ufficio federale](https://www.tio.ch/ticino/attualita/123)*',
        'article-1',
        generatedSource('article-1'),
      ),
      undefined,
    );
  });

  test('una voce ambigua resta senza tipo', () => {
    assert.equal(articleTypeFromItalianBody('Guida pratica senza fonte unica.', 'article-1', generatedSource('article-1')), undefined);
  });
});

describe('premesse sul generatore: chi porta la citazione e\' nato da una run non evergreen', () => {
  test('la postcondizione cantonale usa lo stripper Fonte condiviso e bilanciato', () => {
    const at = CREATE_ARTICLE.indexOf('function bodyTextForCantonPostcondition(data) {');
    const end = CREATE_ARTICLE.indexOf('\n}\n', at);
    assert.ok(at !== -1 && end !== -1, 'postcondizione cantonale non trovata');
    const body = CREATE_ARTICLE.slice(at, end);
    assert.match(body, /stripSourceCitations\(/);
    assert.doesNotMatch(body, /\\\*Fonte:/);
  });

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

  test('mantiene testo simile a interpolazione in stringhe, template escaped e commenti', () => {
    const source = [
      "// 'blog.article.line-comment.body1': 'fake', `${commentValue}`",
      "/* 'blog.article.block-comment.body1': 'fake', `${blockValue}` */",
      `const prose = "'blog.article.string.body1': 'fake', \${quotedValue}";`,
      "'blog.article.demo.title': 'testo ${quotedValue}',",
      "'blog.article.demo.body1': `testo \\${escapedValue}` ,",
    ].join('\n');

    assert.deepEqual([...readTsStringMap(source)], [
      ['blog.article.demo.title', 'testo ${quotedValue}'],
      ['blog.article.demo.body1', 'testo ${escapedValue}'],
    ]);
  });

  test('rifiuta il file intero per template dinamici anche prima o dopo le chiavi', () => {
    const before = [
      'const unrelated = `prefix ${beforeValue}`;',
      "'blog.article.demo.body1': 'reale',",
    ].join('\n');
    const after = [
      "'blog.article.demo.body1': 'reale',",
      'const unrelated = `suffix ${afterValue}`;',
    ].join('\n');
    const nestedFakeKey = [
      "'blog.article.demo.body1': 'reale',",
      "const unrelated = `prefix ${(render({ 'blog.article.fake.body4': 'fake' }))}`;",
    ].join('\n');
    const nestedExpression = [
      "'blog.article.demo.title': 'campo precedente',",
      "'blog.article.demo.body1': `inizio ${(() => /[}]/u.test(input) ? `interno ${value}` : '')()} fine`,",
      "'blog.article.demo.body2': 'campo successivo',",
    ].join('\n');

    for (const source of [before, after, nestedFakeKey, nestedExpression]) {
      assert.throws(() => readTsStringMap(source), /Interpolated template literal is not supported/u);
    }
  });

  test('non interpreta come proprietà chiavi contenute in commenti o prosa', () => {
    const source = [
      "// 'blog.article.comment.body1': 'fake',",
      "/* 'blog.article.block.body1': 'fake', */",
      `const prose = "'blog.article.string.body1': 'fake',";`,
      "'blog.article.real.body1': 'actual',",
    ].join('\n');

    assert.deepEqual([...readTsStringMap(source)], [
      ['blog.article.real.body1', 'actual'],
    ]);
  });

  test('ignora regex literal con virgolette e classi che sembrano dati o chiavi computate', () => {
    const source = [
      String.raw`const keyLikePattern = /["']blog\.article\.fake\.title["']:\s*["']fake["']/u;`,
      "'blog.article.real.title': 'actual',",
    ].join('\n');

    assert.deepEqual([...readTsStringMap(source)], [
      ['blog.article.real.title', 'actual'],
    ]);
  });

  test('ignora slash escaped che altrimenti sembrano commenti dentro un regex literal', () => {
    const source = [
      String.raw`const trailingSlash = /https?:\/\/example\.ch\//u;`,
      "'blog.article.real.title': 'actual',",
    ].join('\n');

    assert.deepEqual([...readTsStringMap(source)], [
      ['blog.article.real.title', 'actual'],
    ]);
  });

  test('non tratta la divisione dopo ++, -- o ! postfix come l apertura di un regex', () => {
    const source = [
      "let n = 1; n++ / /'blog.article.fake.increment': 'fake',/ / /x/;",
      "n-- / /'blog.article.fake.decrement': 'fake',/ / /x/;",
      "const value = n! / /'blog.article.fake.nonnull': 'fake',/ / /x/;",
      "'blog.article.real.title': 'actual',",
    ].join('\n');

    assert.deepEqual([...readTsStringMap(source)], [
      ['blog.article.real.title', 'actual'],
    ]);
  });

  test('ignora regex usati come corpo dopo le parentesi di controllo', () => {
    const source = [
      String.raw`if (condition) /["']blog\.article\.fake\.if["']:\s*["']fake["']/u;`,
      String.raw`while (condition) /["']blog\.article\.fake\.while["']:\s*["']fake["']/u;`,
      "'blog.article.real.title': 'actual',",
    ].join('\n');

    assert.deepEqual([...readTsStringMap(source)], [
      ['blog.article.real.title', 'actual'],
    ]);
  });

  test('non apre regex per keyword usate come membri e riconosce default', () => {
    const source = [
      "const member = obj.return / /'blog.article.fake.member': 'fake',/ / /x/;",
      "export default /'blog.article.fake.default': 'fake'/;",
      "'blog.article.real.title': 'actual',",
    ].join('\n');

    assert.deepEqual([...readTsStringMap(source)], [
      ['blog.article.real.title', 'actual'],
    ]);
  });

  test('ignora regex dopo la chiusura di un blocco senza confonderla con divisione', () => {
    const source = [
      "if (condition) {} /'blog.article.fake.block': 'fake',/;",
      "'blog.article.real.title': 'actual',",
    ].join('\n');

    assert.deepEqual([...readTsStringMap(source)], [
      ['blog.article.real.title', 'actual'],
    ]);
  });

  test('preserva il contesto fra dichiarazioni, tipi e case annidati', () => {
    const source = [
      "try {} catch {} /'blog.article.fake.catch': 'fake',/ / /x/;",
      "switch (value) { case value ? { nested: true } : other: {} /'blog.article.fake.case': 'fake',/ / /x/; }",
      "switch (value) { case maybe ?? fallback: {} /'blog.article.fake.nullish': 'fake',/ / /x/; }",
      "const fn = async function<T extends {}>(): Promise<{ value: string }> {} / /'blog.article.fake.expression': 'fake',/ / /x/;",
      "function declared<T extends {}>(): () => void {} /'blog.article.fake.declaration': 'fake',/ / /x/;",
      "label: {} /'blog.article.fake.label': 'fake',/ / /x/;",
      "'blog.article.real.title': 'actual',",
    ].join('\n');

    assert.deepEqual([...readTsStringMap(source)], [
      ['blog.article.real.title', 'actual'],
    ]);
  });

  test('ignora regex dopo break, continue, debugger e catch senza binding', () => {
    const source = [
      "break\n/'blog.article.fake.break': 'fake',/u;",
      "continue\n/'blog.article.fake.continue': 'fake',/u;",
      "debugger\n/'blog.article.fake.debugger': 'fake',/u;",
      "try {} catch {} /'blog.article.fake.catch': 'fake',/u;",
      "'blog.article.real.title': 'actual',",
    ].join('\n');

    assert.deepEqual([...readTsStringMap(source)], [
      ['blog.article.real.title', 'actual'],
    ]);
  });

  test('non estrae chiavi da annotazioni, asserzioni, generics o blocchi non runtime', () => {
    const source = [
      "function typed(x?: { 'blog.article.fake.parameter': 'fake', }) {}",
      "const typed: { 'blog.article.fake.variable': 'fake', } = {};",
      "const compound: { 'blog.article.fake.compound.a': 'fake', } & { 'blog.article.fake.compound.b': 'fake', } = {};",
      "const asserted = value as { 'blog.article.fake.assertion': 'fake', };",
      "const compoundAssertion = value as { 'blog.article.fake.assertion.a': 'fake', } & { 'blog.article.fake.assertion.b': 'fake', };",
      "type Key = keyof { 'blog.article.fake.keyof': 'fake', };",
      "type Match<T> = T extends { 'blog.article.fake.extends': 'fake', } ? true : false;",
      "const readonlyAssertion = value as readonly { 'blog.article.fake.readonly': 'fake', };",
      "const angleAssertion = <{ 'blog.article.fake.angle': 'fake', }>input;",
      "type SemicolonType = { foo: string; } & { 'blog.article.fake.semicolon.type': 'fake' };",
      "const semicolonAssertion = value as { foo: string; } & { 'blog.article.fake.semicolon.assertion': 'fake' };",
      "const satisfied = value satisfies { 'blog.article.fake.satisfies': 'fake', };",
      "const branch = condition ? value : { 'blog.article.fake.ternary.second': 'fake' };",
      "const generic = <T extends { 'blog.article.fake.generic': 'fake', }>() => {};",
      "call<{ 'blog.article.fake.call': 'fake', }>();",
      "call</* > */ { 'blog.article.fake.call-comment': 'fake', }>();",
      "call<// comment\r { 'blog.article.fake.call-cr-comment': 'fake', }>();",
      "interface Contract { 'blog.article.fake.interface': 'fake'; }",
      "declare global { interface Ambient { 'blog.article.fake.global': 'fake'; } }",
      "{}\n/'blog.article.fake.empty': 'fake',/ / /x/;",
      "{ foo() {} }\n/'blog.article.fake.method': 'fake',/ / /x/;",
      "import {} from 'module'\n/'blog.article.fake.import': 'fake',/ / /x/;",
      "export {} from 'module'\n/'blog.article.fake.export': 'fake',/ / /x/;",
      "function empty(): {} {}\n/'blog.article.fake.return': 'fake',/ / /x/;",
      "const emptyArrow = (): {} => {}\n/'blog.article.fake.arrow-return': 'fake',/ / /x/;",
      "const previous = {}\ntype Asi = { 'blog.article.fake.asi': 'fake' };",
      "const previousArrow = () => {}\ntype AsiArrow = { 'blog.article.fake.asi-arrow': 'fake' };",
      "let value: string\n/'blog.article.fake.asi-type': 'fake',/ / /x/;",
      "'blog.article.real.title': 'actual',",
    ].join('\n');

    assert.deepEqual([...readTsStringMap(source)], [
      ['blog.article.real.title', 'actual'],
    ]);
  });

  test('distingue confronti, type specifier dei moduli e asserzioni angolari', () => {
    const source = [
      "const comparison = (left) < right;",
      "import { type Foo } from 'module'",
      "const angle = <{ 'blog.article.fake.angle.type': string }>{ 'blog.article.real.angle': 'actual' };",
      "const namedAngle = <Foo & { 'blog.article.fake.angle.named': string }>input;",
      "const unionAngle = <Foo | { 'blog.article.fake.angle.union': string }>input;",
      "const nestedAngle = <Array<{ 'blog.article.fake.angle.nested': string }>>input;",
      "'blog.article.real.title': 'actual',",
    ].join('\n');

    assert.deepEqual([...readTsStringMap(source)], [
      ['blog.article.real.angle', 'actual'],
      ['blog.article.real.title', 'actual'],
    ]);
  });

  test('rimuove le continuazioni di riga CRLF dal valore decodificato', () => {
    assert.equal(tsStringMap.readTsStringLiteral("'prima\\\r\nseconda'", 0).value, 'primaseconda');
  });

  test('conta le barre prima di una interpolazione escaped', () => {
    const genuinelyInterpolated = "'blog.article.demo.body1': `literal \\\\${value}`,";
    assert.throws(
      () => readTsStringMap(genuinelyInterpolated),
      /Interpolated template literal is not supported/u,
    );
  });

  test('rifiuta valori concatenati, chiamate postfix e valori non letterali senza restituire campi precedenti', () => {
    const invalidSources = [
      "'blog.article.demo.body1': 'valid',\n'blog.article.demo.body2': 'head' + getTail(),",
      "'blog.article.demo.body1': 'valid',\n'blog.article.demo.body2': 'head'.trim(),",
      "'blog.article.demo.body1': 'valid',\n'blog.article.demo.body2': buildBody(),",
    ];

    for (const source of invalidSources) {
      assert.throws(() => readTsStringMap(source), /Non-static value|Unexpected token/u);
    }
  });

  test('rifiuta chiavi computate prima di restituire una mappa parziale', () => {
    const invalidSources = [
      "'blog.article.demo.body1': 'valid',\n['blog.article.' + id + '.title']: 'dynamic',",
      "'blog.article.demo.body1': 'valid',\n['blog.article.demo.title']: 'computed',",
    ];

    for (const source of invalidSources) {
      assert.throws(
        () => readTsStringMap(source),
        /Computed article map keys are not supported/u,
      );
    }
  });

  test('rifiuta metodi, accessor e spread prima di restituire una mappa parziale', () => {
    const invalidSources = [
      "'blog.article.demo.title'() { return 'dynamic'; },\n'blog.article.demo.body1': 'valid',",
      "get ['blog.article.demo.title']() { return 'dynamic'; },\n'blog.article.demo.body1': 'valid',",
      "...dynamic,\n'blog.article.demo.body1': 'valid',",
    ];

    for (const source of invalidSources) {
      assert.throws(
        () => readTsStringMap(source),
        /(?:methods and accessors|Spread members)/u,
      );
    }
  });

  test('rifiuta un commento non chiuso invece di restituire la mappa parziale', () => {
    const source = "'blog.article.demo.body1': 'valid',\n/* commento incompleto";
    assert.throws(() => readTsStringMap(source), /Unterminated comment/u);
  });

  test('rifiuta un valore mancante a EOF invece di restituire i campi precedenti', () => {
    const source = "'blog.article.demo.body1': 'valid',\n'blog.article.demo.body2':";
    assert.throws(() => readTsStringMap(source), /Non-static value/u);
  });

  test('il lettore del backfill interrompe la lettura di meta e body interpolati in una locale sorella', () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-string-map-caller-'));
    const spec = {
      registry: 'registry.ts',
      meta: 'meta-fr.ts',
      sourceLedger: 'missing-ledger.json',
      sidecarDir: 'sidecars',
      bodyDir: 'body/fr',
    };

    try {
      mkdirSync(join(root, 'body/fr'), { recursive: true });
      writeFileSync(join(root, spec.registry), "const articles = [{ id: 'demo', date: '2026-10-01' }];\n");
      writeFileSync(join(root, spec.meta), "'blog.article.demo.title': `titolo ${resolveTitle()}`,\n");
      writeFileSync(join(root, spec.bodyDir, 'demo.ts'), "'blog.article.demo.body1': 'testo statico',\n");

      assert.throws(
        () => backfillCantons.loadSectionInputs(root, spec),
        /Interpolated template literal is not supported/u,
      );

      writeFileSync(join(root, spec.meta), "'blog.article.demo.title': 'titolo statico',\n");
      writeFileSync(join(root, spec.bodyDir, 'demo.ts'), "'blog.article.demo.body1': `testo ${resolveBody()}`,\n");
      assert.throws(
        () => backfillCantons.loadSectionInputs(root, spec),
        /Interpolated template literal is not supported/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
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

test('il lettore TS rifiuta template interpolati ma preserva l’interpolazione escapata', () => {
  const dynamic = "'blog.article.demo.body1': `prefix ${bodyText}`,";
  assert.throws(
    () => readTsStringMap(dynamic),
    /Interpolated template literal is not supported in static article string source/u,
  );

  const escaped = "'blog.article.demo.body1': `literal \\${bodyText}`,";
  assert.equal(readTsStringMap(escaped).get('blog.article.demo.body1'), 'literal ${bodyText}');
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
    writeFileSync(
      join(root, 'data/article-source-urls.json'),
      JSON.stringify({
        [SOURCE_URL]: { articleId: 'citation-news', ts: '2026-10-06T12:00:00.000Z' },
      }),
    );
    writeFileSync(
      join(root, 'data/swiss-article-source-urls.json'),
      JSON.stringify({
        'https://www.tio.ch/ticino/attualita/124': { articleId: 'swiss-citation', ts: '2026-10-06T12:00:00.000Z' },
      }),
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

  test('una citazione senza corrispondenza URL→ID non autorizza il tipo', () => {
    withFixture((root) => {
      writeFileSync(join(root, 'data/article-source-urls.json'), JSON.stringify({
        [SOURCE_URL]: { articleId: 'un-altro-articolo', ts: '2026-10-06T12:00:00.000Z' },
      }));
      const plan = backfillType.planBackfill(root);
      assert.equal(plan.frontaliere.typesById.has('citation-news'), false);
      assert.equal(plan.frontaliere.withoutType, 2);
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
      const swissFile = join(root, 'content/swiss-articles-data.ts');
      const before = readFileSync(frontFile, 'utf8');
      const swissBefore = readFileSync(swissFile, 'utf8');
      let renames = 0;
      const fsImpl = {
        ...fs,
        renameSync(from, to) {
          renames += 1;
          if (renames === 2) {
            const error = new Error('injected second rename failure');
            error.code = 'EIO';
            throw error;
          }
          fs.renameSync(from, to);
        },
      };

      assert.throws(() => backfillType.applyPlan(plan, { fsImpl }), /injected second rename failure/u);
      assert.equal(readFileSync(frontFile, 'utf8'), before, 'il primo registry deve tornare ai byte originali');
      assert.equal(readFileSync(swissFile, 'utf8'), swissBefore, 'il secondo registry deve restare invariato');
      assert.deepEqual(readdirSync(join(root, 'content')).filter((name) => name.endsWith('.tmp')), []);
      assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.pair.tmp')), []);
      assert.equal(readdirSync(join(root, 'content')).includes('.registry-pair-write.lock'), false);
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

/**
 * I tag XML si contano sul MARKUP, non sul testo. Run with `node --test`.
 *
 * IL DIFETTO. `rssItems` e `sitemapBlogUrls` venivano contati con uno
 * `split('<item>')` / `split('<url>')` sul testo grezzo del documento. Una
 * `description` RSS viaggia dentro `<![CDATA[ ... ]]>` e il corpus contiene
 * articoli che parlano di feed: una description che cita letteralmente
 * `<item>` viene contata come un elemento del feed.
 *
 * PERCHE' E' PEGGIO DI UN NUMERO SBAGLIATO. Il gate di `manifest.counts` in
 * scripts/build-api.mjs confronta il numero DICHIARATO dal writer con quello
 * RI-DERIVATO dai byte su disco. Con lo stesso needle da entrambe le parti, il
 * CDATA gonfia i due lati identicamente e il gate resta verde su un `rssItems`
 * sbagliato — nella direzione che MASCHERA un troncamento, perche' un feed che
 * ha perso un item ma ne cita uno nel testo torna a pareggiare. Dal lato dei
 * pavimenti (scripts/ci/verify-api-floors.mjs, issue #917) lo stesso `<item>`
 * fantasma alza la misura sopra la soglia.
 *
 * PERCHE' UNA FUNZIONE SOLA. Writer, gate e pavimenti devono contare con la
 * STESSA formula (AGENTS.md #6): due formule che divergono sono esattamente il
 * modo in cui un gate smette di poter fallire. Questo test copre sia il
 * comportamento della funzione sia il fatto che i tre chiamanti la usino.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { countXmlTags, stripNonMarkup } from '../../scripts/lib/count-xml-tags.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf-8');

const CALLERS = [
  'scripts/build-api.mjs',
  'scripts/ci/verify-api-floors.mjs',
];

test('un <item> citato dentro un CDATA non e’ un elemento del feed', () => {
  const feed = [
    '<rss><channel>',
    '<item><title>Come si legge un feed</title>',
    '<description><![CDATA[Ogni <item> del feed porta un <link>.]]></description>',
    '</item>',
    '</channel></rss>',
  ].join('\n');
  assert.equal(countXmlTags(feed, 'item'), 1);
  assert.equal(countXmlTags(feed, 'link'), 0);
});

test('un tag commentato non conta', () => {
  assert.equal(countXmlTags('<rss><!-- <item>vecchio</item> --><item></item></rss>', 'item'), 1);
});

test('<url> non collide con <urlset>, e gli attributi non fanno perdere il tag', () => {
  const sitemap = '<urlset xmlns="x"><url><loc>a</loc></url><url foo="bar"><loc>b</loc></url></urlset>';
  assert.equal(countXmlTags(sitemap, 'url'), 2);
  assert.equal(countXmlTags(sitemap, 'urlset'), 1);
});

test('un troncamento resta visibile: il conteggio segue gli elementi veri', () => {
  // La regressione che conta: due feed con lo stesso numero di `<item>`
  // testuali ma un elemento in meno devono dare numeri DIVERSI.
  const whole = '<rss><item>a</item><item>b</item></rss>';
  const truncated = '<rss><item><description><![CDATA[cita <item>]]></description></item></rss>';
  assert.equal(countXmlTags(whole, 'item'), 2);
  assert.equal(countXmlTags(truncated, 'item'), 1);
});

test('input assente o non stringa non fa esplodere un gate di publish', () => {
  assert.equal(countXmlTags(undefined, 'item'), 0);
  assert.equal(stripNonMarkup(null), '');
});

test('il nome del tag è un QName XML escapato, non una regex fornita dal chiamante', () => {
  assert.equal(countXmlTags('<rss><news:item/><news:item/></rss>', 'news:item'), 2);
  assert.throws(() => countXmlTags('<rss><item/></rss>', 'item|url'), /QName XML/);
  assert.throws(() => countXmlTags('<rss><item/></rss>', 'item\\'), /QName XML/);
});

test('writer, gate e pavimenti contano con la stessa funzione', () => {
  for (const file of CALLERS) {
    const src = read(file);
    assert.match(
      src,
      /import \{ countXmlTags \} from '\.[./]*\/lib\/count-xml-tags\.mjs';/,
      `${file} deve importare il contatore condiviso invece di riscriverlo`,
    );
  }
});

test('il manifest del build riconosce gli RSS col contatore documentale', () => {
  const src = read('scripts/build-api.mjs');
  assert.match(src, /\.filter\(\(xml\) => countXmlTags\(xml, 'rss'\) > 0\)/);
  assert.doesNotMatch(src, /\.filter\(\(xml\) => xml\.includes\('<rss'\)\)/);
});

test('publish-api usa il contatore condiviso anche per i due gate News XML', () => {
  const workflow = read('.github/workflows/publish-api.yml');
  assert.match(workflow, /countXmlTags/);
  assert.doesNotMatch(workflow, /grep -c ['"]<url>['"]/);
  assert.doesNotMatch(workflow, /grep -c ['"]<news:publication_date>['"]/);
});

test('nessun chiamante torna al needle testuale', () => {
  // Il needle e' il difetto, non un dettaglio di stile: se torna in UNO dei tre
  // il gate ricomincia a confrontare due formule diverse (o due formule
  // sbagliate allo stesso modo, che e' peggio).
  for (const file of CALLERS) {
    const src = read(file);
    for (const needle of ["'<item>'", "'<url>'", '/<item>/g', '/<url>/g']) {
      assert.ok(
        !src.includes(needle),
        `${file} conta ancora col needle testuale ${needle}: usa countXmlTags()`,
      );
    }
  }
});

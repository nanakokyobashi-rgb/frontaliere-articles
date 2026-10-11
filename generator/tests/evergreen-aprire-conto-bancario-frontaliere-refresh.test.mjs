import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #2622: the guide presented Credit Suisse as an active bank and
// repeated an unsupported 2026 fee range. The current pages are checked
// against the official bank and cantonal sources listed in each body.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'aprire-conto-bancario-frontaliere';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-10-11';
const SOURCES = [
  'https://www.ubs.com/global/en/our-firm/governance/former-credit-suisse-ag.html',
  'https://www.ubs.com/global/en/media/display-page-ndp/en-20260318-client-migration.html',
  'https://www.ubs.com/ch/it/services/accounts-and-cards/accounts/current-account.html',
  'https://www.ubs.com/content/dam/assets/rc/services/accounts-and-cards/static/fact-sheets/services-prices-it.pdf',
  'https://www.ubs.com/ch/it/services/payments/international-payments/key4fx.html',
  'https://www.bancastato.ch/DMS/prodottieservizi/prima/PUBLIC-PRIMA_Factsheet.pdf',
  'https://www.bancastato.ch/DMS/prodottieservizi/PUBLIC-ServiziPrezziBancaStato.pdf',
  'https://www.postfinance.ch/it/privati/pagamenti-risparmio/conti/conto-privato-chf.html',
  'https://www.postfinance.ch/it/privati/pagamenti-risparmio/conti/conto-privato-valuta-estera.html',
  'https://www4.ti.ch/di/spop/stranieri/richiesta-nuovo-g/',
  'https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/nicht_eu_efta/ausweis_g__grenzgaengerbewilligung.html',
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function bodyFields(locale) {
  const source = read(`content/blog-body/${locale}/${SLUG}.ts`);
  const fields = new Map();
  for (const match of source.matchAll(/'([^'\n]+)':\s*'((?:[^'\\]|\\.)*)'/g)) {
    fields.set(
      match[1],
      match[2].replace(/\\n/g, '\n').replace(/\\'/g, "'"),
    );
  }
  return { source, fields };
}

function article(locale) {
  const { source, fields } = bodyFields(locale);
  const body = [1, 2, 3]
    .map((number) => fields.get(`blog.article.${SLUG}.body${number}`))
    .join('\n');
  const faq = JSON.parse(fields.get(`blog.article.${SLUG}.faq`));
  return { source, body, faq };
}

function metaField(locale, field) {
  const source = read(`content/blog-meta-${locale}.ts`);
  const match = source.match(new RegExp(
    `'blog\\.article\\.${SLUG}\\.${field}':\\s*'((?:[^'\\\\]|\\\\.)*)'`,
  ));
  assert.ok(match, `${locale}: campo meta ${field} presente`);
  return match[1].replace(/\\'/g, "'");
}

function seoEntry() {
  const source = read('content/seo/seo-blog.ts');
  const start = source.indexOf(`'blog-${SLUG}': {`);
  assert.notEqual(start, -1, 'voce SEO presente');
  const end = source.indexOf("\n 'blog-", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

test('registry: data di refresh presente accanto all’articolo', () => {
  const registry = read('content/blog-articles-data.ts');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

test('content gate: questo controllo è registrato nel gate principale', () => {
  const gates = read('scripts/ci/content-gates-main.mjs');
  assert.match(gates, /generator\/tests\/evergreen-aprire-conto-bancario-frontaliere-refresh\.test\.mjs/);
});

for (const locale of LOCALES) {
  test(`${locale}: body source-backed, stato Credit Suisse corretto e fatti correnti`, () => {
    const { source, body, faq } = article(locale);
    for (const url of SOURCES) assert.ok(source.includes(url), `${locale}: fonte ${url}`);
    for (const term of ['Credit Suisse', 'UBS', 'BancaStato', 'PostFinance', 'CHF 25']) {
      assert.match(body, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${locale}: fatto ${term}`);
    }
    assert.match(body, /2024/);
    assert.match(body, /2025/);
    assert.match(body, /2026/);
    assert.match(body, /11 ottobre 2026|11 October 2026|11\. Oktober 2026|11 octobre 2026/);
    assert.equal(faq.length, 3, `${locale}: tre FAQ`);
    assert.ok(faq.every((entry) => entry.q && entry.a), `${locale}: FAQ complete`);
  });

  test(`${locale}: residui della scheda precedente rimossi`, () => {
    const { body, faq } = article(locale);
    const all = body + '\n' + JSON.stringify(faq);
    assert.doesNotMatch(all, /150\s*(?:-|–|to|bis|à|e|and|und|et)\s*250/i, `${locale}: vecchia forchetta annuale`);
    assert.doesNotMatch(all, /10\s*(?:-|–|to|bis|à|e|and|und|et)\s*15\s*CHF/i, `${locale}: vecchia forchetta mensile`);
    assert.doesNotMatch(all, /(?:CHF\s*12|12\s*CHF)/i, `${locale}: vecchio pacchetto`);
    assert.doesNotMatch(all, /(?:migliori banche|best banks|besten Banken|meilleures banques)/i, `${locale}: classifica non verificata`);
    assert.doesNotMatch(all, /(?:conto|account|Konto|compte)[^.!?\n]{0,90}(?:attivato solo dopo|only be activated after|erst nach Vorlage|sera activé qu’après)/i, `${locale}: promessa procedurale non verificata`);
    assert.doesNotMatch(all, /(?:UBS|Credit Suisse|Banca Stato|BancaStato)[^.!?\n]{0,100}(?:Credit Suisse|Banca Stato|BancaStato|Raiffeisen)[^.!?\n]{0,40}(?:Raiffeisen|Credit Suisse)/i, `${locale}: elenco di banche ereditato`);
  });

  test(`${locale}: meta aggiornata senza claim di classifica`, () => {
    const title = metaField(locale, 'title');
    const excerpt = metaField(locale, 'excerpt');
    assert.match(`${title} ${excerpt}`, /(?:CHF|Swiss|svizzero|Schweizer|suisse|Kosten|coûts|costi)/i);
    assert.doesNotMatch(`${title} ${excerpt}`, /(?:migliori banche|best banks|besten Banken|meilleures banques)/i);
    assert.doesNotMatch(`${title} ${excerpt}`, /150\s*(?:-|–|to|bis|à|e|and|und|et)\s*250|10\s*(?:-|–|to|bis|à|e|and|und|et)\s*15\s*CHF/i);
  });
}

test('SEO: descrizione e structured data riflettono il refresh', () => {
  const seo = seoEntry();
  assert.match(seo, /Conto svizzero per frontalieri: costi e documenti/);
  assert.match(seo, /requisiti variabili, permesso G, cambio CHF\/EUR/);
  assert.match(seo, /dateModified": "2026-10-11T00:00:00\+01:00"/);
  assert.doesNotMatch(seo, /migliori banche|150\s*(?:-|–|e)\s*250|10\s*(?:-|–|e)\s*15\s*CHF/i);
});

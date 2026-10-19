import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findItalianNavLinkLabels,
  localizeNavLinkLabels,
  NAV_LINK_LABELS,
} from '../../scripts/lib/nav-link-labels.mjs';
import { sanitizeArticleMarkdownLinks } from '../../scripts/lib/article-link-contract.mjs';
import { codexTranslatePromptsForTests } from '../scripts/lib/free-translate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BODY_KEY_RE = /^blog\.article\.[^'"\r\n]+\.(body(?:[1-9]|1[0-9]|20))$/u;
const STRING_QUOTES = new Set(["'", '"', '`']);

// The writer emits quoted body fields. Reading those fields instead of the
// whole TypeScript source keeps FAQ JSON and comments out of this content gate.
function readTsString(source, offset) {
  const quote = source[offset];
  if (!STRING_QUOTES.has(quote)) return null;
  let value = '';
  for (let i = offset + 1; i < source.length; i += 1) {
    if (source[i] === '\\') {
      const next = source[++i];
      value += next === 'n' ? '\n'
        : next === 'r' ? '\r'
          : next === 't' ? '\t'
            : next === 'b' ? '\b'
              : next === 'f' ? '\f'
                : next === 'v' ? '\v'
                  : next === '0' ? '\0'
                    : next ?? '';
      continue;
    }
    if (source[i] === quote) return { value, end: i + 1 };
    value += source[i];
  }
  return null;
}

function bodyValues(source) {
  const values = [];
  for (let i = 0; i < source.length;) {
    const key = readTsString(source, i);
    if (!key) {
      i += 1;
      continue;
    }
    let next = key.end;
    while (/\s/u.test(source[next] ?? '')) next += 1;
    if (BODY_KEY_RE.test(key.value) && source[next] === ':') {
      let valueStart = next + 1;
      while (/\s/u.test(source[valueStart] ?? '')) valueStart += 1;
      const value = readTsString(source, valueStart);
      if (value) values.push(value.value);
    }
    i = key.end;
  }
  return values;
}

function countItalianNavLabels(locale, relativeRoot) {
  let count = 0;
  const directory = path.join(ROOT, relativeRoot, locale);
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(directory, file), 'utf8');
    for (const body of bodyValues(source)) count += findItalianNavLinkLabels(body, locale).length;
  }
  return count;
}

const CONTENT_BASELINE = Object.freeze({
  de: Object.freeze({ blogBody: 1365, blogBodyCh: 3572 }),
  fr: Object.freeze({ blogBody: 1286, blogBodyCh: 2492 }),
  en: Object.freeze({ blogBody: 1287, blogBodyCh: 2503 }),
});

test('sostituisce una label italiana e lascia invariato il target completo', () => {
  const source = '[calcolatore stipendio netto](nav:calculator "target invariato")';
  assert.equal(
    localizeNavLinkLabels(source, 'de'),
    '[Nettolohnrechner](nav:calculator "target invariato")',
  );
});

test('sostituisce anche la forma ibrida usando il body italiano come evidenza', () => {
  const itBody = '[costo della vita Ticino vs Italia](nav:cost-of-living)';
  const hybrid = '[costo della vita Tessin vs Italia](nav:cost-of-living)';
  assert.equal(
    localizeNavLinkLabels(hybrid, 'fr', { itBody }),
    '[coût de la vie au Tessin vs. Italie](nav:cost-of-living)',
  );
});

test('il passaggio comune del writer applica la localizzazione prima della scrittura', () => {
  assert.equal(
    sanitizeArticleMarkdownLinks('[annunci di lavoro](nav:jobs)', 'en'),
    '[job listings](nav:jobs)',
  );
});

test('storico traffico e code conserva storico e code nella traduzione', () => {
  const source = '[storico traffico e code ai valichi](nav:traffic-history)';
  assert.equal(
    localizeNavLinkLabels(source, 'en'),
    '[traffic history and queues at border crossings](nav:traffic-history)',
  );
  assert.equal(
    localizeNavLinkLabels(source, 'fr'),
    '[historique du trafic et des files aux postes-frontières](nav:traffic-history)',
  );
});

test('mappa dei valichi resta una mappa, non un comparatore di percorsi', () => {
  const source = '[mappa dei valichi](nav:border-map)';
  assert.equal(
    localizeNavLinkLabels(source, 'en'),
    '[map of border crossings](nav:border-map)',
  );
  assert.equal(
    localizeNavLinkLabels(source, 'fr'),
    '[carte des postes-frontières](nav:border-map)',
  );
});

test('costo auto pendolare non diventa costo del carburante', () => {
  assert.equal(
    localizeNavLinkLabels('[costo auto pendolare](nav:car-cost)', 'fr'),
    '[coût de la voiture pour les navetteurs](nav:car-cost)',
  );
});

test('calcolatore fiscale non dipende dal target nav', () => {
  assert.equal(
    localizeNavLinkLabels('[calcolatore fiscale](nav:calculator)', 'de'),
    '[Steuerrechner](nav:calculator)',
  );
  assert.equal(
    localizeNavLinkLabels('[calcolatore fiscale](nav:tax-return)', 'de'),
    '[Steuerrechner](nav:tax-return)',
  );
});

test('il confronto Tessin vs Italia non perde luogo e confronto', () => {
  assert.equal(
    localizeNavLinkLabels('[costo della vita Tessin vs Italia](nav:cost-of-living)', 'de'),
    '[Lebenshaltungskosten im Tessin vs. Italien](nav:cost-of-living)',
  );
});

test('una label italiana sconosciuta resta e viene segnalata', () => {
  const source = '[calcolatore sconosciuto](nav:calculator "target invariato")';
  assert.equal(localizeNavLinkLabels(source, 'fr'), source);
  assert.deepEqual(
    findItalianNavLinkLabels(source, 'fr').map(({ label, target, canonicalLabel }) => ({
      label,
      target,
      canonicalLabel,
    })),
    [{ label: 'calcolatore sconosciuto', target: 'calculator', canonicalLabel: null }],
  );
});

test('non traduce sigle o nomi propri senza parole italiane', () => {
  const source = '[XYZ](nav:health) [Brogeda](nav:border)';
  assert.equal(localizeNavLinkLabels(source, 'en'), source);
});

test('la guardia individua anche una label italiana di una sola parola', () => {
  const hits = findItalianNavLinkLabels('[calcolatore](nav:calculator)', 'fr');
  assert.deepEqual(hits.map(({ label, target }) => ({ label, target })), [
    { label: 'calcolatore', target: 'calculator' },
  ]);
});

test('le voci della mappa senza parole dell allowlist vengono localizzate', () => {
  const cases = [
    ['assistenza legale', { de: 'Rechtliche Unterstützung', fr: 'Assistance juridique', en: 'Legal assistance' }],
    ['cantone ticino', { de: 'Kanton Tessin', fr: 'canton du Tessin', en: 'Ticino canton' }],
    ['imposta alla fonte', { de: 'Quellensteuer', fr: 'impôt à la source', en: 'withholding tax' }],
  ];
  for (const [label, translations] of cases) {
    for (const [locale, translation] of Object.entries(translations)) {
      assert.equal(
        localizeNavLinkLabels(`[${label}](nav:calculator)`, locale),
        `[${translation}](nav:calculator)`,
        `${label} (${locale})`,
      );
    }
  }
});

test('le sigle federali usano la forma ufficiale per lingua senza passare dalla guardia italiana', () => {
  const cases = [
    ['LAMal', { de: 'KVG', fr: 'LAMal', en: 'LAMal' }],
    ['AVS', { de: 'AHV', fr: 'AVS', en: 'AVS' }],
    ['LPP', { de: 'BVG', fr: 'LPP', en: 'LPP' }],
    ['AVS/LPP', { de: 'AHV/BVG', fr: 'AVS/LPP', en: 'AVS/LPP' }],
    ['LPP/BVG', { de: 'BVG', fr: 'LPP', en: 'LPP' }],
    ['LAMal/KVG', { de: 'KVG', fr: 'LAMal', en: 'LAMal' }],
    ['AVS/AHV', { de: 'AHV', fr: 'AVS', en: 'AVS' }],
    ['AVS/AI/IPG', { de: 'AHV/IV/EO', fr: 'AVS/AI/APG', en: 'AVS/AI/IPG' }],
    ['LAMal/CMI', { de: 'LAMal/CMI', fr: 'LAMal/CMI', en: 'LAMal/CMI' }],
    ['DFE', { de: 'DFE', fr: 'DFE', en: 'DFE' }],
    ['SECO', { de: 'SECO', fr: 'SECO', en: 'SECO' }],
  ];
  for (const [label, translations] of cases) {
    for (const [locale, translation] of Object.entries(translations)) {
      const source = `[${label}](nav:pension)`;
      assert.equal(localizeNavLinkLabels(source, locale), `[${translation}](nav:pension)`, `${label} (${locale})`);
      assert.deepEqual(findItalianNavLinkLabels(source, locale), [], `${label} (${locale}) non è italiano`);
    }
  }
});

test('una congiunzione italiana rende italiana una sequenza di sigle', () => {
  const source = '[AVS e LPP](nav:pension)';
  assert.equal(localizeNavLinkLabels(source, 'fr'), '[AVS et LPP](nav:pension)');
  assert.equal(findItalianNavLinkLabels(source, 'fr').length, 1);
  assert.equal(localizeNavLinkLabels('[XYZ e ABC](nav:pension)', 'fr'), '[XYZ e ABC](nav:pension)');
  assert.equal(findItalianNavLinkLabels('[XYZ e ABC](nav:pension)', 'fr').length, 1);
});

test('domini e URL non sono italiani, ma le parole italiane fuori dal dominio sì', () => {
  const domains = ['trasporti.ch', 'www.frontaliere.ch', 'frontalieri-supsi.ch', 'www.caseificiaperti.ch'];
  for (const domain of domains) {
    assert.deepEqual(
      findItalianNavLinkLabels(`[${domain}](nav:transport)`, 'en'),
      [],
      domain,
    );
    assert.deepEqual(
      findItalianNavLinkLabels(`[${domain} guida](nav:transport)`, 'en')
        .map(({ label, target }) => ({ label, target })),
      [{ label: `${domain} guida`, target: 'transport' }],
      domain,
    );
  }
  assert.deepEqual(
    findItalianNavLinkLabels('[https://www.frontaliere.ch/trasporti](nav:transport)', 'en'),
    [],
  );
});

test('i nomi ufficiali riconosciuti non contano le loro parole italiane', () => {
  const officialNames = [
    'Dipartimento delle Finanze ed Economia del Ticino (DFE)',
    '730 or the Modello Redditi',
  ];
  for (const name of officialNames) {
    assert.deepEqual(
      findItalianNavLinkLabels(`[${name}](nav:tax-return)`, 'en'),
      [],
      name,
    );
    assert.deepEqual(
      findItalianNavLinkLabels(`[guida ${name}](nav:tax-return)`, 'en')
        .map(({ label, target }) => ({ label, target })),
      [{ label: `guida ${name}`, target: 'tax-return' }],
      name,
    );
  }
});

test('il marchio non rende italiana una label inglese, ma non nasconde l’italiano fuori dal marchio', () => {
  assert.deepEqual(
    findItalianNavLinkLabels('[Frontaliere Ticino calculator](nav:calculator)', 'en'),
    [],
  );
  assert.deepEqual(
    findItalianNavLinkLabels('[Frontaliere Ticino](nav:calculator)', 'en'),
    [],
  );
  for (const brand of ['FRONTALIERETICINO', 'frontaliereticino.ch']) {
    assert.deepEqual(
      findItalianNavLinkLabels(`[${brand} calculator](nav:calculator)`, 'en'),
      [],
    );
  }
  assert.deepEqual(
    findItalianNavLinkLabels('[calcolatore di Frontaliere Ticino](nav:calculator)', 'en')
      .map(({ label, target }) => ({ label, target })),
    [{ label: 'calcolatore di Frontaliere Ticino', target: 'calculator' }],
  );
  assert.deepEqual(
    findItalianNavLinkLabels('[frontaliere calculator](nav:calculator)', 'en')
      .map(({ label, target }) => ({ label, target })),
    [{ label: 'frontaliere calculator', target: 'calculator' }],
  );
  assert.deepEqual(
    findItalianNavLinkLabels('[kontrolli-frontalieri](nav:traffic-history)', 'de')
      .map(({ label, target }) => ({ label, target })),
    [{ label: 'kontrolli-frontalieri', target: 'traffic-history' }],
  );
  assert.deepEqual(
    findItalianNavLinkLabels('[Frontaliere-Tool](nav:calculator)', 'en'),
    [],
  );
  assert.deepEqual(
    findItalianNavLinkLabels('[Frontaliere-Stipendio-Tool](nav:calculator)', 'en')
      .map(({ label, target }) => ({ label, target })),
    [{ label: 'Frontaliere-Stipendio-Tool', target: 'calculator' }],
  );
  assert.deepEqual(
    findItalianNavLinkLabels('[Steuererklärung Frontaliere/B-Inhaber](nav:tax-return)', 'de'),
    [],
  );
  assert.deepEqual(
    findItalianNavLinkLabels('[Frontaliere calculator](nav:calculator)', 'en'),
    [],
  );
  assert.deepEqual(
    findItalianNavLinkLabels('[strumento Frontaliere](nav:calculator)', 'en'),
    [],
  );
});

test('le etichette comparative restano confronti o comparatori in ogni lingua', () => {
  const comparisonEntries = Object.entries(NAV_LINK_LABELS)
    .filter(([label]) => /\b(?:comparatore|confronto)\b/u.test(label));
  assert.ok(comparisonEntries.length > 0);
  for (const [label, translations] of comparisonEntries) {
    for (const locale of ['de', 'fr', 'en']) {
      assert.doesNotMatch(
        translations[locale],
        locale === 'de'
          ? /(?:rechner|umrechner)/iu
          : /(?:calculateur|convertisseur|calculator|converter)/iu,
        `${label} (${locale}) non deve diventare un calcolatore o un convertitore`,
      );
    }
  }
});

test('corregge la guida LAMal e il comparatore di cambio valuta', () => {
  assert.equal(
    localizeNavLinkLabels('[guida alla lamal per frontalieri](nav:health)', 'fr'),
    '[Guide de la LAMal pour les frontaliers](nav:health)',
  );
  assert.equal(
    localizeNavLinkLabels('[comparatore di cambio valuta](nav:exchange)', 'de'),
    '[Wechselkursvergleich](nav:exchange)',
  );
});

test('i prompt Codex singolo e batch dichiarano label visibili e registro', () => {
  const prompts = [
    codexTranslatePromptsForTests.single('testo', 'it', 'fr')[0].content,
    codexTranslatePromptsForTests.batch(['testo'], 'it', 'fr')[0].content,
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /Translate the visible text of every Markdown link/);
    assert.match(prompt, /leave the complete link target exactly unchanged/);
    assert.match(prompt, /French «vous»/);
  }
  assert.match(codexTranslatePromptsForTests.single('testo', 'it', 'de')[0].content, /German «Sie»/);
  assert.match(codexTranslatePromptsForTests.batch(['testo'], 'it', 'en')[0].content, /neutral English register/);
});

for (const [locale, expected] of Object.entries(CONTENT_BASELINE)) {
  test(`ratchet content nav labels ${locale}: blog-body e blog-body-ch non salgono`, () => {
    const blogBody = countItalianNavLabels(locale, 'content/blog-body');
    const blogBodyCh = countItalianNavLabels(locale, 'content/blog-body-ch');
    assert.ok(blogBody <= expected.blogBody, `${locale} blog-body: ${blogBody} > ${expected.blogBody}`);
    assert.ok(blogBodyCh <= expected.blogBodyCh, `${locale} blog-body-ch: ${blogBodyCh} > ${expected.blogBodyCh}`);
  });
}

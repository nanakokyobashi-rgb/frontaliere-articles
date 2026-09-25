import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1799 (sito #9629): la «mappa delle aliquote 2026» era una stima
// datata 15 ottobre 2025 (Como 0,8%, Maslianico 0,75%, Cernobbio 0,6%,
// Campione d'Italia «a tassazione zero o molto bassa») e l'esempio dava 314
// euro a Cernobbio. Stesse fonti e stessi valori di
// `addizionale-irpef-mappa-comuni` (#1798), verificati il 2026-09-25:
// - aliquote 2026 per comune del Dipartimento delle Finanze (Cernobbio
//   delibera 65/2025; Luino e Varese senza delibera 2026 pubblicata, vale la
//   2025): https://www1.finanze.gov.it/finanze2/dipartimentopolitichefiscali/fiscalitalocale/nuova_addcomirpef/sceltaregione.htm
// - aliquote per scaglioni IRPEF e soglia di esenzione:
//   https://www.finanze.gov.it/it/fiscalita/fiscalita-regionale-e-locale/Addizionale-comunale-allIRPEF/disciplina-del-tributo/
// - senza delibera pubblicata si applicano le aliquote dell'anno precedente:
//   https://www.finanze.gov.it/it/fiscalita/fiscalita-regionale-e-locale/Addizionale-comunale-allIRPEF/delibere-comunali-adempimenti-dei-comuni/

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'mappa-fiscale-comuni-frontiera';
const TWIN_SLUG = 'addizionale-irpef-mappa-comuni';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';
const MEF_RATES_URL = 'https://www1.finanze.gov.it/finanze2/dipartimentopolitichefiscali/fiscalitalocale/nuova_addcomirpef/sceltaregione.htm';

function bodySource(locale, slug = SLUG) {
  return fs
    .readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${slug}.ts`), 'utf8')
    .replace(/\\'/g, "'");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Valore della voce di elenco `- **<label>** <valore>` fino al `\n` letterale. */
function listValue(source, label) {
  const match = source.match(new RegExp(`\\\\n- \\*\\*${escapeRegExp(label)}\\*\\* ([^\\\\]*)`));
  return match ? match[1] : null;
}

// Il francese dei due articoli scrive `0,8 %` e `0,8%`: il confronto fra
// articoli ignora solo quello spazio.
const sameRate = (value) => (value === null ? null : value.replace(/\s+%/g, '%'));

const OWN_RATES = {
  it: {
    'Luino (VA):': "0,8% (esenzione fino a 15.000 €; senza una delibera 2026 pubblicata resta in vigore l'aliquota 2025)",
    'Cernobbio (CO):': '0,3% fino a 28.000 €, 0,4% da 28.000 a 50.000 €, 0,75% oltre (esenzione fino a 20.000 €)',
  },
  en: {
    'Luino (VA):': '0.8% (exemption up to €15,000; with no 2026 resolution published, the 2025 rate remains in force)',
    'Cernobbio (CO):': '0.3% up to €28,000, 0.4% from €28,000 to €50,000, 0.75% above (exemption up to €20,000)',
  },
  de: {
    'Luino (VA):': '0,8% (Befreiung bis 15.000 €; ohne veröffentlichten Beschluss 2026 gilt weiter der Satz 2025)',
    'Cernobbio (CO):': '0,3% bis 28.000 €, 0,4% von 28.000 bis 50.000 €, 0,75% darüber (Befreiung bis 20.000 €)',
  },
  fr: {
    'Luino (VA) :': "0,8% (exonération jusqu'à 15 000 € ; sans délibération 2026 publiée, le taux 2025 reste en vigueur)",
    'Cernobbio (CO) :': "0,3% jusqu'à 28 000 €, 0,4% de 28 000 à 50 000 €, 0,75% au-delà (exonération jusqu'à 20 000 €)",
  },
};

// [etichetta in questo articolo, etichetta nel gemello #1798]
const SHARED_LABELS = {
  it: [['Como (città):', 'Como (CO):'], ['Varese (città):', 'Varese (VA):'], ['Lavena Ponte Tresa (VA):', 'Lavena Ponte Tresa (VA):'], ['Maslianico (CO):', 'Maslianico (CO):'], ["Campione d'Italia:", "Campione d'Italia (CO):"]],
  en: [['Como (city):', 'Como (CO):'], ['Varese (city):', 'Varese (VA):'], ['Lavena Ponte Tresa (VA):', 'Lavena Ponte Tresa (VA):'], ['Maslianico (CO):', 'Maslianico (CO):'], ["Campione d'Italia:", "Campione d'Italia (CO):"]],
  de: [['Como (Stadt):', 'Como (CO):'], ['Varese (Stadt):', 'Varese (VA):'], ['Lavena Ponte Tresa (VA):', 'Lavena Ponte Tresa (VA):'], ['Maslianico (CO):', 'Maslianico (CO):'], ["Campione d'Italia:", "Campione d'Italia (CO):"]],
  fr: [['Côme (ville) :', 'Côme (CO) :'], ['Varèse (ville) :', 'Varèse (VA) :'], ['Lavena Ponte Tresa (VA) :', 'Lavena Ponte Tresa (VA) :'], ['Maslianico (CO) :', 'Maslianico (CO) :'], ["Campione d'Italia :", "Campione d'Italia (CO) :"]],
};

// L'esempio: 65.000 CHF al cambio ipotizzato di 0,96 = 62.400 euro, meno la
// franchigia di 10.000 = 52.400 euro di imponibile.
const BASE = 52_400;
const VARESE = Math.round(BASE * 0.008);
const COMO = Math.round(BASE * 0.007);
const CERNOBBIO = Math.round(28_000 * 0.003 + 22_000 * 0.004 + (BASE - 50_000) * 0.0075);
const GAP_EUR = VARESE - CERNOBBIO;
const GAP_CHF = Math.round(GAP_EUR / 0.96);

const EXAMPLE = {
  it: [new RegExp(`Varese pagherebbe \\*\\*${VARESE} €\\*\\*`), new RegExp(`Como \\*\\*${COMO} €\\*\\*`), new RegExp(`invece \\*\\*${CERNOBBIO} €\\*\\*`), new RegExp(`${GAP_EUR} euro rispetto a Varese, circa ${GAP_CHF} CHF`)],
  en: [new RegExp(`Varese would pay \\*\\*€${VARESE}\\*\\*`), new RegExp(`Como \\*\\*€${COMO}\\*\\*`), new RegExp(`instead pay \\*\\*€${CERNOBBIO}\\*\\*`), new RegExp(`${GAP_EUR} euros compared with Varese, about ${GAP_CHF} CHF`)],
  de: [new RegExp(`Varese \\*\\*${VARESE} €\\*\\*`), new RegExp(`Como \\*\\*${COMO} €\\*\\*`), new RegExp(`hingegen \\*\\*${CERNOBBIO} €\\*\\*`), new RegExp(`${GAP_EUR} Euro gegenüber Varese, beim angenommenen Wechselkurs etwa ${GAP_CHF} CHF`)],
  fr: [new RegExp(`Varèse paierait \\*\\*${VARESE} €\\*\\*`), new RegExp(`Côme \\*\\*${COMO} €\\*\\*`), new RegExp(`revanche \\*\\*${CERNOBBIO} €\\*\\*`), new RegExp(`${GAP_EUR} euros par rapport à Varèse, soit environ ${GAP_CHF} CHF`)],
};

test('la voce del registro porta la data del refresh fattuale', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

test("l'esempio usa i valori attesi", () => {
  assert.deepEqual([VARESE, COMO, CERNOBBIO, GAP_EUR, GAP_CHF], [419, 367, 190, 229, 239]);
});

for (const locale of LOCALES) {
  test(`${locale}: aliquote di Luino e Cernobbio pubblicate dal Dipartimento delle Finanze`, () => {
    const source = bodySource(locale);
    for (const [label, expected] of Object.entries(OWN_RATES[locale])) {
      assert.equal(listValue(source, label), expected, `aliquota di ${label}`);
    }
  });

  test(`${locale}: i comuni in comune con ${TWIN_SLUG} hanno gli stessi valori`, () => {
    const source = bodySource(locale);
    const twin = bodySource(locale, TWIN_SLUG);
    for (const [label, twinLabel] of SHARED_LABELS[locale]) {
      const value = sameRate(listValue(source, label));
      assert.ok(value, `voce ${label} presente`);
      assert.equal(value, sameRate(listValue(twin, twinLabel)), `${label} come nel gemello`);
    }
  });

  test(`${locale}: esempio di calcolo coerente con le aliquote e fonte ufficiale`, () => {
    const source = bodySource(locale);
    for (const pattern of EXAMPLE[locale]) assert.match(source, pattern);
    assert.ok(source.includes(MEF_RATES_URL), 'link alle aliquote del Dipartimento delle Finanze');
  });

  test(`${locale}: nessun valore superato`, () => {
    const source = bodySource(locale);
    assert.doesNotMatch(source, /\b314\b/, 'Cernobbio a 314 euro');
    assert.doesNotMatch(source, /105 CHF/, 'differenza di 105 CHF');
    assert.doesNotMatch(source, /Cernobbio[^"\\]{0,20}0[,.]6 ?%/, 'Cernobbio allo 0,6%');
    assert.doesNotMatch(source, /Maslianico[^"\\]{0,20}0[,.]75/, 'Maslianico allo 0,75%');
    assert.doesNotMatch(source, /(?:Como|Côme) \((?:città|city|Stadt|ville)\) ?:\*\* 0[,.]8/, 'Como allo 0,8%');
    assert.doesNotMatch(
      source,
      /tassazione zero|zero or very low taxation|null oder sehr niedrige|taxation nulle/,
      "Campione d'Italia a tassazione zero",
    );
    assert.doesNotMatch(
      source,
      /stime basate su dati attuali|estimates based on current data|Schätzungen basierend auf aktuellen Daten|estimations basées sur les données actuelles/,
      'mappa dichiarata come stima',
    );
    assert.doesNotMatch(source, /15 Ottobre 2025|October 15, 2025|15\. Oktober 2025|15 octobre 2025/, 'data della vecchia elaborazione');
  });
}

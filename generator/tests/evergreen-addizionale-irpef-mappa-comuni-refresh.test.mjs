import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1798 (sito #9629): l'articolo dava Como allo 0,8%, Clivio allo
// 0,6%, Maslianico allo 0,75% e Campione d'Italia fuori dall'addizionale, con
// un esempio Como-Clivio da 80 euro e la residenza «entro il 31 dicembre».
// Fonti (verificate il 2026-09-25):
// - aliquote 2026 per comune del Dipartimento delle Finanze (Como delibera
//   98/2025, Maslianico 44/2025, Campione d'Italia 21/2025, Clivio 21/2025,
//   Lavena Ponte Tresa 33/2025; Varese senza delibera 2026 pubblicata, vale la
//   2025): https://www1.finanze.gov.it/finanze2/dipartimentopolitichefiscali/fiscalitalocale/nuova_addcomirpef/sceltaregione.htm
// - soglia di esenzione, aliquote per scaglioni IRPEF, domicilio fiscale al
//   1° gennaio: https://www.finanze.gov.it/it/fiscalita/fiscalita-regionale-e-locale/Addizionale-comunale-allIRPEF/disciplina-del-tributo/
// - senza delibera pubblicata si applicano le aliquote dell'anno precedente:
//   https://www.finanze.gov.it/it/fiscalita/fiscalita-regionale-e-locale/Addizionale-comunale-allIRPEF/delibere-comunali-adempimenti-dei-comuni/
// - variazione di residenza efficace dal sessantesimo giorno (entro il 2
//   novembre 2025 per il domicilio al 1/1/2026), franchigia di 10.000 euro:
//   https://www.agenziaentrate.gov.it/portale/documents/d/guest/730_-istruzioni_2026

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'addizionale-irpef-mappa-comuni';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';
const MEF_RATES_URL = 'https://www1.finanze.gov.it/finanze2/dipartimentopolitichefiscali/fiscalitalocale/nuova_addcomirpef/sceltaregione.htm';
const AE_730_URL = 'https://www.agenziaentrate.gov.it/portale/documents/d/guest/730_-istruzioni_2026';

// Il body e' un letterale TS con `\'` e `\n` scritti come testo: si toglie solo
// l'escape dell'apostrofo, cosi' i valori attesi restano leggibili.
function bodySource(locale) {
  return fs
    .readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8')
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

const RATES = {
  it: {
    'Como (CO):': '0,7% (esenzione fino a 15.000 €)',
    'Varese (VA):': "0,8% (esenzione fino a 8.000 €; senza una delibera 2026 pubblicata resta in vigore l'aliquota 2025)",
    'Lavena Ponte Tresa (VA):': '0,8%',
    'Maslianico (CO):': '0,58% fino a 28.000 €, 0,78% da 28.000 a 50.000 €, 0,8% oltre (esenzione fino a 8.500 €)',
    "Campione d'Italia (CO):": '0,3% fino a 28.000 €, 0,4% da 28.000 a 50.000 €, 0,5% oltre (esenzione fino a 15.000 €)',
    'Clivio (VA):': '0,7% (esenzione fino a 12.000 €)',
  },
  en: {
    'Como (CO):': '0.7% (exemption up to €15,000)',
    'Varese (VA):': '0.8% (exemption up to €8,000; with no 2026 resolution published, the 2025 rate remains in force)',
    'Lavena Ponte Tresa (VA):': '0.8%',
    'Maslianico (CO):': '0.58% up to €28,000, 0.78% from €28,000 to €50,000, 0.8% above (exemption up to €8,500)',
    "Campione d'Italia (CO):": '0.3% up to €28,000, 0.4% from €28,000 to €50,000, 0.5% above (exemption up to €15,000)',
    'Clivio (VA):': '0.7% (exemption up to €12,000)',
  },
  de: {
    'Como (CO):': '0,7% (Befreiung bis 15.000 €)',
    'Varese (VA):': '0,8% (Befreiung bis 8.000 €; ohne veröffentlichten Beschluss 2026 gilt weiter der Satz 2025)',
    'Lavena Ponte Tresa (VA):': '0,8%',
    'Maslianico (CO):': '0,58% bis 28.000 €, 0,78% von 28.000 bis 50.000 €, 0,8% darüber (Befreiung bis 8.500 €)',
    "Campione d'Italia (CO):": '0,3% bis 28.000 €, 0,4% von 28.000 bis 50.000 €, 0,5% darüber (Befreiung bis 15.000 €)',
    'Clivio (VA):': '0,7% (Befreiung bis 12.000 €)',
  },
  fr: {
    'Côme (CO) :': "0,7 % (exonération jusqu'à 15 000 €)",
    'Varèse (VA) :': "0,8 % (exonération jusqu'à 8 000 € ; sans délibération 2026 publiée, le taux 2025 reste en vigueur)",
    'Lavena Ponte Tresa (VA) :': '0,8 %',
    'Maslianico (CO) :': "0,58 % jusqu'à 28 000 €, 0,78 % de 28 000 à 50 000 €, 0,8 % au-delà (exonération jusqu'à 8 500 €)",
    "Campione d'Italia (CO) :": "0,3 % jusqu'à 28 000 €, 0,4 % de 28 000 à 50 000 €, 0,5 % au-delà (exonération jusqu'à 15 000 €)",
    'Clivio (VA) :': "0,7 % (exonération jusqu'à 12 000 €)",
  },
};

// 40.000 euro di imponibile: Varese 0,8% = 320, Como 0,7% = 280 (entrambi
// sopra la soglia di esenzione, quindi aliquota sull'intero reddito).
const EXAMPLE = {
  it: /Varese \(320 €\) e a Como \(280 €\) è di \*\*40 euro\*\*/,
  en: /Varese \(€320\) and Como \(€280\) is \*\*€40\*\*/,
  de: /Varese \(320 €\) und Como \(280 €\) netto \*\*40 €\*\*/,
  fr: /Varèse \(320 €\) et à Côme \(280 €\) est de \*\*40 €\*\*/,
};
const COMO_SINCE_2025 = {
  it: /Como dal 2025 applica lo 0,7%/,
  en: /Como has applied 0\.7% since 2025/,
  de: /Como dagegen seit 2025 0,7%/,
  fr: /Côme applique 0,7 % depuis 2025/,
};
const RESIDENCE_DEADLINE = {
  it: [/\*\*2 novembre\*\*/, /2 novembre 2025/],
  en: [/\*\*November 2\*\*/, /2 November 2025/],
  de: [/\*\*2\. November\*\*/, /2\. November 2025/],
  fr: [/\*\*2 novembre\*\*/, /2 novembre 2025/],
};

test('la voce del registro porta la data del refresh fattuale', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: aliquote 2026 per comune come pubblicate dal Dipartimento delle Finanze`, () => {
    const source = bodySource(locale);
    for (const [label, expected] of Object.entries(RATES[locale])) {
      assert.equal(listValue(source, label), expected, `aliquota di ${label}`);
    }
  });

  test(`${locale}: esempio Varese-Como, termine di residenza e fonti ufficiali`, () => {
    const source = bodySource(locale);
    assert.match(source, EXAMPLE[locale], 'esempio su 40.000 euro');
    assert.match(source, COMO_SINCE_2025[locale], 'Como allo 0,7% dal 2025');
    for (const pattern of RESIDENCE_DEADLINE[locale]) {
      assert.match(source, pattern, 'variazione di residenza entro il 2 novembre');
    }
    assert.ok(source.includes(MEF_RATES_URL), 'link alle aliquote del Dipartimento delle Finanze');
    assert.ok(source.includes(AE_730_URL), 'link alle istruzioni del 730/2026');
  });

  test(`${locale}: nessun valore superato`, () => {
    const source = bodySource(locale);
    assert.doesNotMatch(source, /(?:Como|Côme)[^"\\]{0,30}0[,.]8 ?%/, 'Como allo 0,8%');
    assert.doesNotMatch(source, /Clivio[^"\\]{0,60}0[,.]6 ?%/, 'Clivio allo 0,6%');
    assert.doesNotMatch(source, /Maslianico[^"\\]{0,20}0[,.]75/, 'Maslianico allo 0,75%');
    assert.doesNotMatch(
      source,
      /non applica l'addizionale|does not apply the standard|Standard-IRPEF-Zuschlag nicht|n'applique pas la surtaxe/,
      "Campione d'Italia fuori dall'addizionale",
    );
    assert.doesNotMatch(source, /\*\*80 euro\*\*|\*\*€80\*\*|\*\*80 €\*\*|Clivio \(€?240/, 'esempio Como-Clivio da 80 euro');
    assert.doesNotMatch(
      source,
      /31 dicembre|December 31|31 December|31\. Dezember|31 décembre/,
      'residenza entro il 31 dicembre',
    );
    assert.doesNotMatch(
      source,
      /aliquote indicative|indicative rates|Richtwerte|taux indicatifs/,
      'aliquote dichiarate indicative',
    );
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1796 (sito #9629). L'articolo dava 62 milioni di ristorni nel 2026,
// una «trattenuta» ticinese salita «dal 20% al 30%», un'imposta cantonale del
// 22-25% su 50'000 CHF e una fonte interna del 2023. Fonti ufficiali:
// - Accordo CH-IT del 23.12.2020, art. 9 (40% fino all'anno fiscale 2033,
//   versamento nel primo semestre dell'anno successivo, ripartizione ai comuni
//   da parte delle autorita' italiane con le Regioni), ratificato con legge
//   13.6.2023 n. 83: https://www.gazzettaufficiale.it/eli/id/2023/06/30/23G00087/sg
// - Messaggio del Consiglio federale FF 2021 1917 (accordo del 1974: 38,8% dal
//   1985, la Svizzera tratteneva il 61,2%): https://www.fedlex.admin.ch/eli/fga/2021/1917/it
// - Consiglio di Stato TI, «Versamento dei ristorni», 30.6.2026 (109'110'460 CHF,
//   50'221'177 sospesi, 58'889'283 versati):
//   https://www4.ti.ch/tich/area-media/comunicati/dettaglio-comunicato/?NEWS_ID=260164
// - Divisione delle contribuzioni TI, tabella A 2026 (A0, 49'801-50'400 CHF: 6,80%).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'ristorni-fiscali-ticino';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

test('ristorni-fiscali-ticino: registry con updatedAt del refresh fattuale', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: importi del comunicato del Consiglio di Stato del 30 giugno 2026`, () => {
    const source = bodySource(locale);
    assert.match(source, /109\\'110\\'460/, 'totale ristorni');
    assert.match(source, /100\\'442\\'354/, 'quota Lombardia');
    assert.match(source, /8\\'668\\'106/, 'quota Piemonte');
    assert.match(source, /50\\'221\\'177/, 'importo sospeso');
    assert.match(source, /58\\'889\\'283/, 'importo versato');
    assert.match(source, /46\s?%/, 'quota sospesa sul totale');
    assert.match(source, /30 (?:giugno|June|juin) 2026|30\. Juni 2026/, 'data della decisione');
  });

  test(`${locale}: quote dell'Accordo 2020 e del regime 1974`, () => {
    const source = bodySource(locale);
    assert.match(source, /40\s?%/, 'compensazione del 40%');
    assert.match(source, /60\s?%/, 'quota che resta in Svizzera');
    assert.match(source, /2033/, 'fine del regime transitorio');
    assert.match(source, /38[.,]8\s?%/, 'quota 1974 dal 1985');
    assert.match(source, /61[.,]2\s?%/, 'quota trattenuta in Svizzera col 1974');
    assert.match(source, /1985/, 'adeguamento del 1985');
    assert.match(source, /17 (?:luglio|July|juillet) 2023|17\. Juli 2023/, 'entrata in vigore');
    assert.match(source, /80\s?%/, 'limite per i nuovi frontalieri');
  });

  test(`${locale}: esempio con la tabella A0 2026`, () => {
    const source = bodySource(locale);
    assert.match(source, /6[.,]80\s?%/, 'aliquota A0 a 50\'000 CHF');
    assert.match(source, /3\\'400/, 'imposta alla fonte');
    assert.match(source, /2\\'040/, 'quota che resta in Svizzera');
    assert.match(source, /1\\'360/, 'quota versata all\'Italia');
  });

  test(`${locale}: fonti ufficiali citate`, () => {
    const source = bodySource(locale);
    assert.match(source, /gazzettaufficiale\.it\/eli\/id\/2023\/06\/30\/23G00087/, 'legge 83/2023');
    assert.match(source, /fedlex\.admin\.ch\/eli\/fga\/2021\/1917/, 'messaggio FF 2021 1917');
    assert.match(source, /ti\.ch\/tich\/area-media\/comunicati\/dettaglio-comunicato\/\?NEWS_ID=260164/, 'comunicato 30.6.2026');
    assert.match(source, /Aliquote_2026\/Ticino_tabella_A_2026\.pdf/, 'tabella A 2026');
  });

  test(`${locale}: niente valori superati o inventati`, () => {
    const source = bodySource(locale);
    assert.doesNotMatch(source, /62 (?:milioni|million|Millionen|millions)/, 'totale 62 milioni');
    assert.doesNotMatch(source, /20\s?% (?:al|to|auf|à) 30\s?%/, 'trattenuta dal 20% al 30%');
    assert.doesNotMatch(source, /(?:^|[^\d.,])30\s?%/, 'trattenuta o quota del 30%');
    assert.doesNotMatch(source, /(?:^|[^\d.,])70\s?%/, 'trattenuta del 70%');
    assert.doesNotMatch(source, /22[-–]25\s?%/, 'imposta cantonale 22-25%');
    assert.doesNotMatch(source, /11[.,]000|7[.,]700|3[.,]300/, 'esempio con imposta al 22%');
    assert.doesNotMatch(source, /Editoriale? Frontaliere/, 'fonte interna del 2023');
    assert.doesNotMatch(
      source,
      /continua a versare|weiterhin 40|continue de verser|keeps transferring/,
      '40% presentato come quota invariata rispetto al 1974',
    );
  });
}

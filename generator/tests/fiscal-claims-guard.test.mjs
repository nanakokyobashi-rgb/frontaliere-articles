/**
 * Le affermazioni fiscali smentite dalle fonti primarie (scheda del 2026-10-31) e il
 * gate YMYL che le usa. Ogni caso negativo e' una frase vera del corpus: un guard
 * che scattasse su queste fermerebbe articoli corretti.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findFiscalClaims, findFiscalErrors, findTaxHealthParameterErrors } from '../scripts/lib/fiscal-claims-guard.mjs';
import {
  OFFICIAL_SOURCE_LINKS,
  assertNoFiscalErrorsInLocales,
  assertYmylPublishable,
  checkYmylPublishable,
  isOfficialSourceUrl,
  isYmylArticle,
} from '../scripts/lib/article-ymyl-gate.mjs';
import { repairFiscalText } from '../scripts/repair-fiscal-claims.mjs';

const ids = (text) => findFiscalClaims(text).map((claim) => claim.id);

test('franchigia 7.500: in ogni lingua, grafia e valuta', () => {
  for (const sentence of [
    'I vecchi frontalieri beneficiano di un\'esenzione di 7.500 euro nel regime transitorio.',
    'Old frontier workers benefit from an exemption of €7,500.',
    'Alte Grenzgänger profitieren von einer Befreiung von 7.500 Euro.',
    'Les anciens frontaliers ont droit à une franchise de 7 500 € par an.',
    'Franchigia: CHF 7.500 per i vecchi frontalieri.',
    "Neues Abkommen: Freibeträge €7\\'500 (alte Grenzgänger).",
  ]) {
    assert.deepEqual(ids(sentence), ['franchigia-7500'], sentence);
  }
});

test('franchigia 7.500: il valore storico e gli importi qualunque non scattano', () => {
  for (const sentence of [
    'Fino al 2023 la franchigia era di 7.500 euro, dal 2024 e\' di 10.000 euro.',
    'Prima del 2024 la franchigia era di 7.500 euro.',
    'Lo stipendio medio e\' di CHF 7.500 al mese.',
    'La Finanza ha sequestrato 7500 euro a un 62enne.',
    'Il contributo vale 47.500 euro.',
  ]) {
    assert.deepEqual(ids(sentence), [], sentence);
  }
});

test('gli altri falsi: forfait sanitario, 38,8%, credito 80%, retrocessione, entrambi i Paesi, data', () => {
  assert.deepEqual(ids('Si aggiunge la deduzione forfetaria sanitaria di 3.000 €.'), ['deduzione-forfetaria-sanitaria']);
  assert.deepEqual(ids('L\'Italia riceve il 38,8% dell\'imposta alla fonte come ristorno.'), ['ristorni-38-8']);
  assert.deepEqual(ids('Dichiarano in Italia con credito d\'imposta fino all\'80% del prelievo svizzero.'), ['credito-80']);
  assert.deepEqual(ids('L\'80% resta in Svizzera e il 20% viene retrocesso al comune italiano di residenza.'), ['retrocessione-20']);
  assert.deepEqual(ids('Imposta trattenuta SOLO in Svizzera, mai in entrambi i Paesi.'), ['mai-in-entrambi']);
  assert.deepEqual(ids('Il Nuovo Accordo Frontalieri, in vigore dal 1° gennaio 2024, cambia le regole.'), ['accordo-in-vigore-2024']);
});

test('le frasi corrette passano', () => {
  for (const sentence of [
    'La Svizzera preleva al massimo l\'80% dell\'imposta ordinaria e l\'Italia riconosce il credito entro la quota IRPEF.',
    'La quota secondo l\'accordo del 1974 era il 38,8% (40% ridotto nel 1985).',
    'L\'utile netto e\' sceso a 138,8 milioni di franchi.',
    'L\'Accordo e\' in vigore dal 17 luglio 2023 e si applica dal 1° gennaio 2024.',
    'Il fatturato e\' calato del 20% e la retrocessione delle azioni e\' sospesa.',
  ]) {
    assert.deepEqual(ids(sentence), [], sentence);
  }
});

test('quota SSN: base lorda o aliquota fuori forchetta, non un sondaggio o un aumento', () => {
  assert.equal(findTaxHealthParameterErrors('La tassa sulla salute è fissata al 5% del reddito lordo.').length, 1);
  assert.equal(findTaxHealthParameterErrors('La tassa salute è pari a 0,8% del reddito annuo.').length, 1);
  assert.equal(findTaxHealthParameterErrors('La tassa salute vale il 4% del salario netto.').length, 0);
  assert.equal(findTaxHealthParameterErrors('L\'87,8% dei frontalieri giudica negativa la tassa salute.').length, 0);
  assert.equal(findTaxHealthParameterErrors('Con uno stipendio di 50.000 € la tassa salute avrebbe rappresentato lo 0,4% dello stipendio lordo.').length, 0);
});

test('il prompt non insegna piu\' cio\' che il guard rifiuta', () => {
  const source = readFileSync(new URL('../scripts/create-article.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const VERIFIED_DOMAIN_FACTS = `');
  const end = source.indexOf('const EVERGREEN_FACTS_BRIEF_CH = `');
  assert.ok(start !== -1 && end > start);
  assert.deepEqual(findFiscalErrors(source.slice(start, end)).map((error) => error.sentence), []);
});

test('YMYL: fonte ufficiale obbligatoria, nel testo o come fonte dell\'articolo', () => {
  const data = { id: 'franchigia-frontalieri-2026', content: { it: { title: 'Franchigia IRPEF per i frontalieri', excerpt: '', body1: 'La franchigia vale 10.000 euro dal 2024.' } } };
  assert.deepEqual(checkYmylPublishable(data).problems, ['nessun link a una fonte ufficiale']);
  assert.throws(() => assertYmylPublishable(data), (error) => error.topicGateAbort === true);

  assert.deepEqual(checkYmylPublishable(data, { sourceUrl: 'https://www.news.admin.ch/it/nsb' }).problems, []);
  const linked = structuredClone(data);
  linked.content.it.body2 = 'Vedi [Agenzia delle Entrate](https://www.agenziaentrate.gov.it/portale/norme-per-i-pendolari-transfrontalieri-dei-paesi-confinanti).';
  assert.deepEqual(checkYmylPublishable(linked).problems, []);
});

test('YMYL: il controllo dei parametri blocca anche con la fonte ufficiale', () => {
  const data = { id: 'tassa-salute-2026', content: { it: { title: 'Tassa salute: la guida', excerpt: '', body1: 'La franchigia per i vecchi frontalieri è di 7.500 euro.' } } };
  const { ymyl, problems } = checkYmylPublishable(data, { sourceUrl: 'https://www.admin.ch/x' });
  assert.equal(ymyl, true);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /franchigia-7500/);
});

test('YMYL: un articolo fuori tema fiscale non passa da qui', () => {
  const data = { id: 'lugano-festival-2026', content: { it: { title: 'Il festival di Lugano', excerpt: '', body1: 'Musica in piazza.' } } };
  assert.deepEqual(checkYmylPublishable(data), { ymyl: false, problems: [] });
  assert.equal(isYmylArticle({ id: 'ristorni-congelati-gobbi-2026', title: 'Ristorni congelati' }), true);
});

test('domini ufficiali: sottodomini si, omonimi no', () => {
  assert.equal(isOfficialSourceUrl('https://www.estv.admin.ch/dam/x.pdf'), true);
  assert.equal(isOfficialSourceUrl('https://m4.ti.ch/fileadmin/x.pdf'), true);
  assert.equal(isOfficialSourceUrl('https://admin.ch.evil.example/x'), false);
  assert.equal(isOfficialSourceUrl('https://www.fakeadmin.ch/x'), false);
  assert.equal(isOfficialSourceUrl('non un url'), false);
  for (const { url } of OFFICIAL_SOURCE_LINKS) assert.equal(isOfficialSourceUrl(url), true, url);
});

test('le traduzioni non reintroducono un errore che l\'italiano non ha', () => {
  assert.throws(
    () => assertNoFiscalErrorsInLocales({ en: { body1: 'Old frontier workers benefit from an exemption of €7,500.' } }),
    (error) => error.qualityReject === true && /franchigia-7500/.test(error.message),
  );
  assert.doesNotThrow(() => assertNoFiscalErrorsInLocales({ en: { body1: 'The allowance is €10,000.' } }));
});

test('riparazione: la coppia di importi lascia la frase e toglie il falso', () => {
  const { text } = repairFiscalText('La franchigia (€7.500 o €10.000) incide sul reddito. Altro.', 'blog-body/it/x.ts');
  assert.equal(text, 'La franchigia (10.000 €) incide sul reddito. Altro.');
  const plural = repairFiscalText('Guida con franchigie 7.500/10.000 € e credito.', 'seo/seo-blog-5.ts').text;
  assert.equal(plural, 'Guida con franchigia 10.000 € e credito.');
});

test('riparazione: la frase falsa diventa quella corretta una volta, e la seconda esce', () => {
  const source = 'Primo paragrafo. I vecchi frontalieri hanno un\'esenzione di 7.500 euro. Altro fatto. I vecchi hanno esenzione di €7.500 fino al 2033. Fine.';
  const { text } = repairFiscalText(source, 'blog-body/it/x.ts');
  assert.equal(findFiscalClaims(text).length, 0);
  assert.equal(text.split('art. 9').length - 1, 1);
  assert.match(text, /^Primo paragrafo\. I vecchi frontalieri \(art\. 9/);
  assert.match(text, /Altro fatto\. Fine\.$/);
});

test('riparazione: bullet, cella e domanda conservano la struttura', () => {
  const bullet = repairFiscalText('- **Regime**: esenzione €7.500 fino al 2033\\n- Altro: x', 'blog-body/it/x.ts').text;
  assert.match(bullet, /^- \*\*Regime\*\*: I vecchi frontalieri/);
  assert.match(bullet, /\\n- Altro: x$/);
  const cell = repairFiscalText('| Alte Grenzgänger | Befreiung 7.500 € | x |', 'blog-body/de/x.ts').text;
  assert.equal(cell, '| Alte Grenzgänger | nur in der Schweiz besteuert (Art. 9) | x |');
  const question = repairFiscalText('{"q":"Qual è la differenza tra esenzione €7.500 ed esenzione maggiore?","a":"Testo."}', 'blog-body/it/x.ts').text;
  assert.match(question, /"q":"Quale franchigia IRPEF si applica ai frontalieri\?"/);
});

test('riparazione: un calcolo non si tocca, perche\' le righe dopo ne dipendono', () => {
  const source = 'Passo 1: franchigia €50.000 − €7.500 = €42.500 imponibile.';
  const { text, arith } = repairFiscalText(source, 'blog-body/it/x.ts');
  assert.equal(text, source);
  assert.equal(arith.length, 1);
});

test('riparazione: «mai in entrambi» e data di vigore cambiano solo l\'inciso', () => {
  assert.equal(
    repairFiscalText('Trattenuta SOLO in Svizzera, mai in entrambi i paesi.', 'blog-body/it/x.ts').text,
    'Trattenuta SOLO in Svizzera.',
  );
  assert.equal(
    repairFiscalText('Il Nuovo Accordo, in vigore dal 1° gennaio 2024, vale.', 'blog-body/it/x.ts').text,
    'Il Nuovo Accordo, applicato dal 1° gennaio 2024, vale.',
  );
});

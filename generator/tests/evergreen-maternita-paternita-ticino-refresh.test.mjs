/**
 * Refresh evergreen di `maternita-paternita-ticino` (sito, issue 7295).
 *
 * Fissa nelle quattro lingue i fatti verificati il 2026-10-06/07 e fallisce
 * se tornano i valori smentiti dalle fonti ufficiali:
 *  - indennita' di maternita': 80 % del reddito medio per 98 giorni (14
 *    settimane), al massimo CHF 220 lordi al giorno. Il massimale non nasce
 *    nel 2026: e' gia' nel promemoria AVS/AI 6.02 (stato al 1.1.2025);
 *  - altro genitore: 14 indennita' giornaliere entro un termine quadro di sei
 *    mesi (IAS Ticino, informazioni valide dal 1.1.2026);
 *  - condizioni: assicurata AVS nei 9 mesi immediatamente precedenti il parto
 *    e almeno 5 mesi di attivita' lucrativa; contano anche i periodi in Stati
 *    UE o AELS e nel Regno Unito (promemoria 6.02) — non «9 mesi nei 12» ne'
 *    un requisito di permesso;
 *  - richiesta: sui moduli ufficiali (318.750), alla cassa di compensazione
 *    competente, per le salariate tramite il datore di lavoro (6.02, n. 8) —
 *    non «copia del permesso G» ne' per forza la cassa cantonale;
 *  - termine: il diritto si esercita fino a cinque anni dopo le 14 settimane
 *    del congedo (6.02, n. 9), non «dalla nascita»; in Italia un anno dal
 *    giorno successivo alla fine del congedo (INPS);
 *  - Italia: indennita' INPS pari all'80 % della retribuzione media
 *    giornaliera, non al 100 % (INPS);
 *  - coordinamento: Accordo sulla libera circolazione e regolamenti UE
 *    883/2004 e 987/2009, non una convenzione bilaterale;
 *  - il «+3 % del costo della vita in Ticino nel 2026» non ha fonte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'maternita-paternita-ticino';
const REFRESHED_ON = '2026-10-07';

const LOCALES = {
  it: {
    capSince2026: /dal 1° gennaio 2026/,
    italy80: /80 ?% della retribuzione media giornaliera/,
    fromBirth: /5 anni dalla nascita|1 anno dalla nascita/,
    afterLeave: /cinque anni dopo le 14 settimane/,
    permit: /copia (?:del )?permesso G/,
    cantonalFund: /Cassa cantonale/,
    nineInTwelve: /9 mesi nei 12/,
    bilateral: /Convenzione bilaterale/,
    costOfLiving: /aumentato del 3 ?%|Aumento del 3 ?%/,
  },
  en: {
    capSince2026: /from 1 January 2026/,
    italy80: /80 ?% of average daily pay/,
    fromBirth: /within 5 years of the (?:child.{1,2}s birth|birth of the child)|1 year from the birth/,
    afterLeave: /five years after the 14 weeks/,
    permit: /copy of (?:the )?G permit/,
    cantonalFund: /Cantonal Compensation Fund/,
    nineInTwelve: /9 months in the 12/,
    bilateral: /bilateral agreement between Switzerland and Italy/i,
    costOfLiving: /[Ii]ncreased by 3 ?%/,
  },
  de: {
    capSince2026: /ab 1\. Januar 2026/,
    italy80: /80 ?% des durchschnittlichen Tageslohns/,
    fromBirth: /5 Jahren? nach der Geburt|1 Jahr nach der Geburt/,
    afterLeave: /fünf Jahre nach den 14 Wochen/,
    permit: /Kopie der G-Bewilligung/,
    cantonalFund: /kantonalen? Kasse/,
    nineInTwelve: /9 Monate in den (?:letzten )?12/,
    bilateral: /bilaterale Abkommen zwischen der Schweiz und Italien/,
    costOfLiving: /3 ?% Anstieg|um 3 ?% gestiegen|\+3 ?%/,
  },
  fr: {
    capSince2026: /dès le 1er janvier 2026/,
    italy80: /80 ?% du salaire journalier moyen/,
    fromBirth: /5 ans (?:après|suivant) la naissance|1 an après la naissance/,
    afterLeave: /cinq ans après les 14 semaines/,
    permit: /copie du permis G/,
    cantonalFund: /Caisse cantonale/,
    nineInTwelve: /9 mois (?:dans|sur|au cours des) (?:les )?12/,
    bilateral: /[Cc]onvention bilatérale/,
    costOfLiving: /augmenté de 3 ?%|\+3 ?%/,
  },
};

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function faqOf(source) {
  const match = source.match(/\.faq':\s*'((?:[^'\\]|\\.)*)'/);
  assert.ok(match, 'campo faq presente');
  return JSON.parse(match[1].replace(/\\'/g, "'"));
}

test('il registry porta updatedAt del refresh fattuale', () => {
  const registry = read('content/blog-articles-data.ts');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

for (const [locale, expected] of Object.entries(LOCALES)) {
  test(`${locale}: importi e durata delle indennita svizzere e italiane`, () => {
    const source = read(`content/blog-body/${locale}/${SLUG}.ts`);
    assert.match(source, /\b98\b/, '98 giorni di indennita di maternita');
    assert.match(source, /CHF 220|220 CHF/, 'massimale giornaliero IPG');
    assert.doesNotMatch(source, expected.capSince2026, 'massimale presentato come novita del 2026');
    assert.match(source, /\b14\b/, '14 indennita giornaliere per l altro genitore');
    assert.match(source, expected.italy80, 'indennita INPS all 80 %');
    assert.doesNotMatch(source, expected.costOfLiving, 'rincaro del 3 % senza fonte');
  });

  test(`${locale}: condizioni, richiesta, termini e coordinamento`, () => {
    const source = read(`content/blog-body/${locale}/${SLUG}.ts`);
    assert.doesNotMatch(source, expected.nineInTwelve, '«9 mesi nei 12»');
    assert.match(source, /318\.750/, 'modulo ufficiale di richiesta');
    assert.doesNotMatch(source, expected.permit, 'copia del permesso G come requisito');
    assert.doesNotMatch(source, expected.cantonalFund, 'cassa cantonale come unico ente');
    assert.match(source, expected.afterLeave, 'termine dopo le 14 settimane del congedo');
    assert.doesNotMatch(source, expected.fromBirth, 'termini contati dalla nascita');
    assert.match(source, /883\/2004/, 'regolamento UE 883/2004');
    assert.doesNotMatch(source, expected.bilateral, 'convenzione bilaterale come base del coordinamento');
    assert.doesNotMatch(source, /EU\/EEA|UE\/EEE/, 'SEE al posto di AELS');
  });

  test(`${locale}: la FAQ porta le condizioni di legge e il termine corretto`, () => {
    const faq = faqOf(read(`content/blog-body/${locale}/${SLUG}.ts`));
    assert.equal(faq.length, 3, 'tre domande');
    const [amount, deadline, conditions] = faq.map((item) => item.a);
    assert.match(amount, /\b98\b/, '98 giorni');
    assert.match(amount, /220/, 'massimale giornaliero');
    assert.match(deadline, expected.afterLeave, 'termine dopo le 14 settimane');
    assert.match(conditions, /\b9\b/, '9 mesi di assicurazione');
    assert.match(conditions, /\b5\b/, '5 mesi di attivita lucrativa');
    assert.match(conditions, expected.afterLeave, 'termine dopo le 14 settimane');
  });
}

test('de: chi lavora in Svizzera e assicurato in Svizzera, non «in entrambi i Paesi»', () => {
  const source = read(`content/blog-body/de/${SLUG}.ts`);
  assert.doesNotMatch(source, /Grenzgänger zahlen in beiden Ländern/, 'contributi in entrambi i Paesi');
  assert.match(source, /Erwerbsortprinzip/, 'principio dello Stato di lavoro');
});

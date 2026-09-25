import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1856 (gemello della sezione CH di #1802/#1803/#1832, PR #1830 e
// #1851): la guida chiedeva 18 settimane (13 nel DE) e 30 giornate di lavoro
// effettivo nei 12 mesi, indicava come eccezione alle dimissioni volontarie il
// «licenziamento» per giusta causa e diceva che la NASpI del frontaliere si
// basa sui contributi versati in Italia. Valori vigenti, con le stesse fonti
// di #1830/#1851:
// - 13 settimane nei 4 anni (D.Lgs. 22/2015 art. 3), periodi svizzeri
//   compresi con il documento portatile U1; 30 giornate abolite per gli
//   eventi dall'1.1.2022 (art. 3 c. 1-bis; INPS circolare n. 2/2022);
// - eccezione: dimissioni per giusta causa (Ministero del Lavoro, scheda NASpI);
// - 75% fino a 1.456,72 + 25% oltre, massimale 1.584,70 (INPS circolare
//   n. 4/2026); riduzione del 3% dal sesto mese, dall'ottavo con 55 anni
//   (art. 4 c. 3);
// - frontaliere residente in Italia disoccupato completo: paga l'INPS come
//   Stato di residenza, con i periodi svizzeri del documento U1 e la
//   retribuzione svizzera (artt. 61, 62 e 65 regolamento (CE) 883/2004).
// La guida e' della sezione Svizzera: corpo in content/blog-body-ch/, voce in
// content/swiss-articles-data.ts.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'naspi-ex-frontalieri-guida';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body-ch', locale, `${SLUG}.ts`), 'utf8');
}

test('la voce del registro svizzero porta la data del refresh fattuale', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'swiss-articles-data.ts'), 'utf8');
  const entries = registry.match(new RegExp(`id: '${SLUG}'`, 'g')) ?? [];
  assert.equal(entries.length, 1, 'una sola voce per lo slug nel registro svizzero');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,160}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: requisiti, importi 2026, frontalieri e fonti ufficiali`, () => {
    const source = bodySource(locale);
    assert.match(source, /\b13 (?:settimane|Beitragswochen|weeks|semaines)/, '13 settimane di contribuzione');
    assert.match(source, /quattro anni|four years|vier Jahren|quatre années/, 'finestra di 4 anni');
    assert.match(source, /1° gennaio 2022|1 January 2022|1\. Januar 2022|1er janvier 2022/, 'abolizione delle 30 giornate dal 2022');
    assert.match(source, /1[., ]456[.,]72/, 'soglia di calcolo 2026');
    assert.match(source, /1[., ]584[.,]70/, 'massimale mensile 2026');
    assert.match(source, /sesto mese|sixth month|sechsten Bezugsmonat|sixième mois/, 'riduzione dal sesto mese');
    assert.match(source, /ottavo mese|eighth month|achten Monat|huitième mois/, 'riduzione dall\'ottavo mese con 55 anni');
    assert.match(
      source,
      /dimissioni per giusta causa|resignation for just cause|Eigenkündigung aus wichtigem Grund|démission pour juste cause/,
      'eccezione: dimissioni per giusta causa',
    );
    assert.match(source, /\bU1\b[\s\S]*\bU1\b/, 'documento U1 nei requisiti e nel confronto con la Svizzera');
    assert.match(source, /(?:art\.|Art\.) 65/, 'art. 65 del regolamento 883/2004');
    assert.match(source, /normattiva\.it\/uri-res\/N2Ls\?urn:nir:stato:decreto\.legislativo:2015-03-04;22/);
    assert.match(source, /lavoro\.gov\.it\/temi-e-priorita\/ammortizzatori-sociali\/focus-on\/indennita-disoccupazione\/naspi/);
    assert.match(source, /circolare-numero-2-del-04-01-2022/);
    assert.match(source, /circolare-numero-4-del-28-01-2026/);
    assert.match(source, /schede-servizi\.50188\./, 'scheda INPS sui frontalieri');
    assert.match(source, /CELEX:02004R0883/);
  });

  test(`${locale}: niente valori superati`, () => {
    const source = bodySource(locale);
    assert.doesNotMatch(source, /\b18 (?:settimane|Wochen|Beitragswochen|weeks|semaines)/, '18 settimane');
    assert.doesNotMatch(
      source,
      /(?:almeno|minimo(?: di)?|mindestens|at least|a minimum of|au moins|un minimum de) 30 (?:giorn|Tage|effektive|Arbeitstage|actual days|days|jours)/i,
      '30 giornate come requisito vigente',
    );
    assert.doesNotMatch(
      source,
      /licenziamento per giusta causa|dismissal for just cause|(?<!Eigen)Kündigung aus wichtigem Grund|licenciement pour bonne cause/,
      'licenziamento indicato come eccezione alle dimissioni volontarie',
    );
    assert.doesNotMatch(
      source,
      /contributi versati in Italia, anche per|contributions paid in Italy, even for|in Italien gezahlten Beiträgen|cotisations versées en Italie, y compris/,
      'NASpI del frontaliere basata sui contributi italiani',
    );
  });

  test(`${locale}: la FAQ resta JSON valido`, () => {
    const source = bodySource(locale);
    const match = source.match(new RegExp(`'blog\\.article\\.${SLUG}\\.faq': '(.*)',\\n`));
    assert.ok(match, 'chiave faq presente');
    const faq = JSON.parse(match[1].replace(/\\'/g, "'"));
    assert.equal(faq.length, 5);
    assert.match(faq[2].a, /1[., ]584[.,]70/, 'massimale 2026 nella FAQ sull\'importo');
  });
}

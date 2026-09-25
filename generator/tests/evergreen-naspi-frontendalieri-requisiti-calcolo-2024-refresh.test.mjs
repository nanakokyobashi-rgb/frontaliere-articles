import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1858 (gemello della sezione CH di #1830, #1851 e #1857): l'articolo
// presentava la NASpI come una prestazione «introdotta» dal Nuovo Accordo
// Frontalieri dal 1° gennaio 2024 e le attribuiva requisiti che nessuna fonte
// prevede (12 mesi di lavoro nei 18 mesi precedenti, reddito minimo di
// CHF 2'000, 2 ore al giorno per 26 settimane, reddito annuo di 30.000 CHF,
// eta' fra 20 e 64 anni, una «LFP 2» del 1982). Gli esempi di calcolo usavano
// salari orari in CHF e un «25% di contributo». Valori vigenti, con le stesse
// fonti delle PR gemelle:
// - 13 settimane nei 4 anni (D.Lgs. 22/2015 art. 3), periodi svizzeri
//   compresi con il documento portatile U1; 30 giornate abolite per gli
//   eventi dall'1.1.2022 (art. 3 c. 1-bis; INPS circolare n. 2/2022);
// - retribuzione media: imponibile di 4 anni / settimane x 4,33 (art. 4 c. 1);
//   75% fino a 1.456,72 + 25% oltre, massimale 1.584,70 (INPS circolare
//   n. 4/2026), quindi massimale da 3.425,36 di retribuzione media; riduzione
//   del 3% dal sesto mese, dall'ottavo con 55 anni (art. 4 c. 3);
// - durata: meta' delle settimane dei 4 anni (art. 5); domanda entro 68 giorni
//   (art. 6);
// - frontaliere residente in Italia disoccupato completo: paga l'INPS come
//   Stato di residenza, sulla retribuzione svizzera (artt. 61, 62 e 65
//   regolamento (CE) 883/2004; SECO, pagina sul regolamento 883/2004);
// - art. 7 legge 83/2023: formulazione e stato di #1830.
// Gli esempi in EUR sono aritmetica sui valori 2026: 1.400 -> 1.050,00;
// 2.000 -> 1.092,54 + 135,82 = 1.228,36; 3.000 -> 1.478,36; 5.000 -> 1.978,36,
// ridotto al massimale 1.584,70, poi 1.537,16 dal sesto mese.
// La guida e' della sezione Svizzera: corpo in content/blog-body-ch/, voce in
// content/swiss-articles-data.ts, meta in content/blog-meta-ch-<locale>.ts,
// SEO in content/seo/seo-blog-ch.ts.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'naspi-frontendalieri-requisiti-calcolo-2024';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';

function read(...segments) {
  return fs.readFileSync(path.join(ROOT, 'content', ...segments), 'utf8');
}

function bodySource(locale) {
  return read('blog-body-ch', locale, `${SLUG}.ts`);
}

function metaLine(locale, field) {
  const source = read(`blog-meta-ch-${locale}.ts`);
  const match = source.match(new RegExp(`'blog\\.article\\.${SLUG}\\.${field}': '((?:[^'\\\\]|\\\\.)*)',`));
  assert.ok(match, `${locale}: ${field} presente`);
  return match[1];
}

// Un importo in euro nelle quattro grafie: 1.456,72 (it/de), 1,456.72 (en),
// 1 456,72 (fr). Le cifre dopo le migliaia e i decimali sono fisse.
function euro(thousands, rest, cents) {
  return new RegExp(`${thousands}[., ]${rest}[.,]${cents}`);
}

test('la voce del registro svizzero porta la data del refresh fattuale', () => {
  const registry = read('swiss-articles-data.ts');
  const entries = registry.match(new RegExp(`id: '${SLUG}'`, 'g')) ?? [];
  assert.equal(entries.length, 1, 'una sola voce per lo slug nel registro svizzero');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,160}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: requisiti, calcolo 2026, frontalieri e fonti ufficiali`, () => {
    const source = bodySource(locale);
    assert.match(source, /\b13 (?:settimane|Beitragswochen|weeks|semaines)/, '13 settimane di contribuzione');
    assert.match(source, /quattro anni|four years|vier Jahren|quatre années/, 'finestra di 4 anni');
    assert.match(source, /1° gennaio 2022|1 January 2022|1\. Januar 2022|1er janvier 2022/, 'abolizione delle 30 giornate dal 2022');
    assert.match(source, /4[.,]33/, 'coefficiente 4,33 della retribuzione media');
    assert.match(source, euro(1, 456, 72), 'soglia di calcolo 2026');
    assert.match(source, euro(1, 584, 70), 'massimale mensile 2026');
    assert.match(source, euro(3, 425, 36), 'retribuzione media da cui scatta il massimale');
    assert.match(source, euro(1, '050', '00'), 'esempio 1: 75% di 1.400');
    assert.match(source, euro(1, 228, 36), 'esempio 2: 1.092,54 + 135,82');
    assert.match(source, euro(1, 478, 36), 'esempio 3: 1.092,54 + 385,82');
    assert.match(source, euro(1, 978, 36), 'esempio 4: calcolo prima del massimale');
    assert.match(source, euro(1, 537, 16), 'esempio 4: primo mese ridotto del 3%');
    assert.match(source, /sesto mese|sixth month|sechsten (?:Bezugsm|M)onat|sixième mois/, 'riduzione dal sesto mese');
    assert.match(source, /ottavo mese|eighth month|achten Monat|huitième mois/, 'riduzione dall\'ottavo mese con 55 anni');
    assert.match(source, /\b68 (?:giorni|days|Tagen|jours)/, 'domanda entro 68 giorni');
    assert.match(source, /24 (?:mesi|months|Monate|mois)/, 'durata massima');
    assert.match(
      source,
      /dimissioni per giusta causa|resignation for just cause|Eigenkündigung aus wichtigem Grund|démission pour juste cause/,
      'eccezione: dimissioni per giusta causa',
    );
    assert.match(source, /\bU1\b[\s\S]*\bU1\b/, 'documento U1 nei requisiti e nella domanda');
    assert.match(source, /(?:art\.|Art\.) 65/, 'art. 65 del regolamento 883/2004');
    assert.match(source, /(?:art\.|Art\.) 62/, 'art. 62: retribuzione svizzera');
    assert.match(source, /83\/2023/, 'art. 7 della legge 83/2023');
    assert.match(source, /(?:settembre|September|septembre) 2026/, 'stato di applicazione dell\'art. 7');
    assert.match(source, /normattiva\.it\/uri-res\/N2Ls\?urn:nir:stato:decreto\.legislativo:2015-03-04;22/);
    assert.match(source, /lavoro\.gov\.it\/temi-e-priorita\/ammortizzatori-sociali\/focus-on\/indennita-disoccupazione\/naspi/);
    assert.match(source, /circolare-numero-2-del-04-01-2022/);
    assert.match(source, /circolare-numero-4-del-28-01-2026/);
    assert.match(source, /schede-servizi\.50188\./, 'scheda INPS sui frontalieri');
    assert.match(source, /CELEX:02004R0883/);
    assert.match(source, /arbeit\.swiss\/it\/centro-dinformazione\/regolamento-8832004-ue/, 'SECO sul regolamento 883/2004');
    assert.match(source, /urn:nir:stato:legge:2023-06-13;83~art7/);
    assert.match(source, /admin\.ch\/it\/nsb\?id=96751/, 'Consiglio federale: entrata in vigore dell\'Accordo');
  });

  test(`${locale}: niente requisiti inventati né esempi in salari orari`, () => {
    const source = bodySource(locale);
    assert.doesNotMatch(
      source,
      /introduzione del NASPI|introduction of NASPI|Einführung des NASPI|introduction du (?:ruban|NASPI)/i,
      'NASpI presentata come introdotta dal Nuovo Accordo',
    );
    assert.doesNotMatch(source, /(?:Quando|When|Wann|Quand) ?: (?:dal|from|ab dem|à partir du) 1/, 'decorrenza 2024 fra i fatti chiave');
    assert.doesNotMatch(source, /CHF 2\\?'000|CHF 2,000/, 'reddito mensile minimo di CHF 2\'000');
    assert.doesNotMatch(
      source,
      /12 mesi consecutivi|12 consecutive|12 aufeinanderfolgende|12 mois consécutifs/,
      '12 mesi di lavoro nei 18 mesi precedenti',
    );
    assert.doesNotMatch(
      source,
      /(?:almeno|at least|mindestens|au moins) 12 (?:mesi|months|Monate|mois)/,
      '12 mesi di lavoro come requisito',
    );
    assert.doesNotMatch(source, /2 ore al giorno|2 hours per day|2 Stunden pro Tag|2 heures par jour/, '2 ore al giorno per 26 settimane');
    assert.doesNotMatch(source, /30\.000 CHF|CHF 30,000|30 000 CHF|7\.200 CHF/, 'reddito e contributo annui minimi');
    assert.doesNotMatch(source, /CHF\/(?:ora|hour|Stunde|heure)|per hour/, 'esempi su salari orari in CHF');
    assert.doesNotMatch(source, /25% di contributo|25% contribution|25% Beitrag|25 % de contribution/, 'contributo del 25%');
    assert.doesNotMatch(source, /LFP 2|BBl 2|25 giugno 1982|25 June 1982|25\. Juni 1982|25 juin 1982/, 'legge federale inesistente');
    assert.doesNotMatch(source, /4'650|4,650|4\\'650/, 'reddito medio svizzero di CHF 4\'650');
    assert.doesNotMatch(source, /20 e 64 anni|20 and 64|20 und 64|20 et 64 ans/, 'requisito di età inventato');
    assert.doesNotMatch(source, /2\.400 CHF|CHF 2,400/, 'importo massimo di 2.400 CHF');
    assert.doesNotMatch(source, /entro [36] mesi|within [36] months|innerhalb von [36] Monaten|dans les [36] mois/, 'termine di 3 o 6 mesi');
    assert.doesNotMatch(source, /ruban|Masques/, 'traduzione FR di NASpI sbagliata');
  });

  test(`${locale}: la FAQ resta JSON valido e coerente con i valori 2026`, () => {
    const source = bodySource(locale);
    const match = source.match(new RegExp(`'blog\\.article\\.${SLUG}\\.faq': '(.*)',\\n`));
    assert.ok(match, 'chiave faq presente');
    const faq = JSON.parse(match[1].replace(/\\'/g, "'"));
    assert.equal(faq.length, 5);
    assert.match(faq[0].a, /\b13\b/, '13 settimane nella FAQ sui requisiti');
    assert.match(faq[1].a, /2022/, 'abolizione delle 30 giornate nella FAQ');
    assert.match(faq[2].a, euro(1, 584, 70), 'massimale 2026 nella FAQ sull\'importo');
    assert.match(faq[2].a, euro(1, 228, 36), 'esempio su 2.000 nella FAQ sull\'importo');
    assert.match(faq[4].a, /\b68\b/, '68 giorni nella FAQ sulla domanda');
  });

  test(`${locale}: excerpt senza la NASpI «introdotta» dal Nuovo Accordo`, () => {
    const excerpt = metaLine(locale, 'excerpt');
    assert.doesNotMatch(excerpt, /introduzione del NASPI|introduction of NASPI|Einführung des NASPI|ruban adhésif/i);
    assert.match(excerpt, /\b13\b/, '13 settimane nell\'excerpt');
    assert.match(excerpt, /INPS/, 'paga l\'INPS');
  });
}

test('fr: il titolo parla di NASpI e non di «masques»', () => {
  const title = metaLine('fr', 'title');
  assert.doesNotMatch(title, /Masques|ex-frontières/);
  assert.match(title, /^NASPI pour ex-frontaliers/);
});

test('SEO: descrizioni senza la NASpI «introdotta» e dentro i tetti', () => {
  const seo = read('seo', 'seo-blog-ch.ts');
  const start = seo.indexOf(`'blog-${SLUG}': {`);
  assert.ok(start >= 0, 'voce SEO presente');
  const block = seo.slice(start, seo.indexOf('\n  },\n', start));
  assert.doesNotMatch(block, /introduzione del NASPI/);
  const description = block.match(/\n {4}description: '((?:[^'\\]|\\.)*)',/)[1].replace(/\\'/g, "'");
  const ogDescription = block.match(/\n {4}ogDescription: '((?:[^'\\]|\\.)*)',/)[1].replace(/\\'/g, "'");
  assert.ok(description.length <= 160, `description ${description.length} > 160`);
  assert.ok(ogDescription.length <= 250, `ogDescription ${ogDescription.length} > 250`);
  assert.match(block, /"description": "La NASpI del frontaliere residente in Italia/);
  assert.match(block, new RegExp(`"dateModified": "${REFRESHED_ON}T`));
});

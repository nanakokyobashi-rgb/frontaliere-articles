import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1832 (gemello di #1802/#1803, PR #1830). Lo slug e' ritirato dal
// registro (A.4 in content/blog-articles-data.ts: il sito lo reindirizza a
// naspi-ex-frontalieri-2026), ma il corpo resta nel corpus e riportava gli
// stessi valori superati: 18 settimane e 30 giornate, residenza «al momento
// della domanda», riduzione dal quarto mese, 75% piatto (1.500 EUR su 2.000),
// periodi svizzeri ignorati, accesso con PIN e un «modulo di trasferimento
// dei contributi» che non esiste. Valori vigenti:
// - 13 settimane nei 4 anni (D.Lgs. 22/2015 art. 3), 30 giornate abolite
//   dall'1.1.2022 (art. 3 c. 1-bis; INPS circolare n. 2/2022);
// - 75% fino a 1.456,72 + 25% oltre, massimale 1.584,70 (INPS circolare
//   n. 4/2026): su 2.000 EUR sono 1.228,36; riduzione del 3% dal sesto mese,
//   dall'ottavo con 55 anni (art. 4 c. 3);
// - residenza in Italia durante l'ultimo impiego, periodi svizzeri attestati
//   dal documento portatile U1 (art. 65 regolamento (CE) 883/2004; scheda
//   INPS sui frontalieri);
// - accesso ai servizi INPS con SPID, CIE o CNS (D.L. 76/2020 art. 24);
// - Svizzera: 70-80% del guadagno assicurato, tetto 12.350 CHF al mese; 400
//   indennita' giornaliere, 520 dai 55 anni con 22 mesi di contributi (SECO,
//   opuscolo 2026; Cantone Ticino, Sezione del lavoro);
// - art. 7 legge 83/2023 citato con il suo stato: non applicato a settembre
//   2026.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'naspi-disoccupazione-frontalieri';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

test('slug ritirato: nessuna voce di registro senza la data del refresh', () => {
  // Oggi lo slug non ha una voce nel registro, quindi non c'e' un updatedAt da
  // aggiornare. Se tornasse pubblicato, la voce deve portare la data del
  // refresh fattuale del suo corpo.
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  if (!registry.includes(`id: '${SLUG}'`)) return;
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '(\\d{4}-\\d{2}-\\d{2})'`));
  const [, updatedAt] = registry.match(new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '(\\d{4}-\\d{2}-\\d{2})'`));
  assert.ok(updatedAt >= REFRESHED_ON, `updatedAt ${updatedAt} precede il refresh ${REFRESHED_ON}`);
});

for (const locale of LOCALES) {
  test(`${locale}: requisiti, importi 2026, residenza e fonti ufficiali`, () => {
    const source = bodySource(locale);
    assert.match(source, /\b13 (?:settimane|Beitragswochen|weeks|semaines)/, '13 settimane di contribuzione');
    assert.match(source, /2022/, 'abolizione delle 30 giornate dal 2022');
    assert.match(source, /1[.,]584[.,]70/, 'massimale mensile 2026');
    assert.match(source, /1[.,]456[.,]72/, 'soglia di calcolo 2026');
    assert.match(source, /1[.,]228[.,]36/, 'importo iniziale dell\'esempio su 2.000 EUR');
    assert.match(source, /sesto mese|sechsten|sixth month|sixième mois/, 'riduzione dal sesto mese');
    assert.match(source, /(?:art\.|Art\.|Artikel|Article|article|l\\'article) 65/, 'art. 65 del regolamento 883/2004');
    assert.match(source, /\bU1\b/, 'documento portatile U1');
    assert.match(source, /SPID, CIE (?:o|or|oder|ou) CNS/, 'credenziali INPS vigenti');
    assert.match(source, /12[.,]350/, 'tetto svizzero del guadagno assicurato');
    assert.match(source, /\b520\b/, 'indennita\' giornaliere svizzere dai 55 anni');
    assert.match(source, /83\/2023/, 'art. 7 della legge 83/2023');
    assert.match(source, /(?:settembre|September|septembre) 2026/, 'stato di applicazione dell\'art. 7');
    assert.match(source, /normattiva\.it\/uri-res\/N2Ls\?urn:nir:stato:decreto\.legislativo:2015-03-04;22/);
    assert.match(source, /lavoro\.gov\.it\/temi-e-priorita\/ammortizzatori-sociali\/focus-on\/indennita-disoccupazione\/naspi/);
    assert.match(source, /circolare-numero-2-del-04-01-2022/);
    assert.match(source, /circolare-numero-4-del-28-01-2026/);
    assert.match(source, /schede-servizi\.50188\./, 'scheda INPS sui frontalieri');
    assert.match(source, /CELEX:02004R0883/);
    assert.match(source, /urn:nir:stato:legge:2023-06-13;83~art7/);
    assert.match(source, /urn:nir:stato:decreto\.legge:2020-07-16;76~art24/, 'D.L. 76/2020 art. 24');
    assert.match(source, /arbeit\.swiss\/dam\/secoalv/, 'opuscolo SECO');
    assert.match(source, /ti\.ch\/dfe\/de\/sdl\/persone-in-cerca-dimpiego\//, 'Sezione del lavoro TI');
  });

  test(`${locale}: niente valori superati`, () => {
    const source = bodySource(locale);
    assert.doesNotMatch(source, /\b18 (?:settimane|Wochen|Beitragswochen|weeks|semaines)/, '18 settimane');
    assert.doesNotMatch(
      source,
      /(?:almeno|minimo(?: di)?|mindestens|at least|a minimum of|au moins|un minimum de) 30 (?:giorn|tatsächliche|wirksame|Tage|actual days|effective days|days|jours)/i,
      '30 giornate come requisito vigente',
    );
    assert.doesNotMatch(source, /30 giorni (?:di lavoro|lavorati)|30 jours de travail dans les 12/, '30 giornate nel riepilogo');
    assert.doesNotMatch(source, /quarto mese|vierten Monat|fourth month|quatrième mois/, 'riduzione dal quarto mese');
    assert.doesNotMatch(source, /1[.,]500\s?€|€1[.,]500\b/, 'esempio al 75% piatto');
    assert.doesNotMatch(
      source,
      /al momento della domanda|at the time of application|zum Zeitpunkt der Antragstellung in Italien|zum Zeitpunkt des Antrags in Italien|au moment de la demande/,
      'residenza al momento della domanda',
    );
    assert.doesNotMatch(
      source,
      /non tiene conto di eventuali contributi|does not take into account contributions|berücksichtigt keine in der Schweiz|ne tient pas compte des éventuelles cotisations/,
      'periodi svizzeri ignorati',
    );
    assert.doesNotMatch(source, /\bPIN\b/, 'accesso INPS con PIN');
    assert.doesNotMatch(
      source,
      /modulo di trasferimento|contribution transfer form|Übertragungsform|forme de transfert/,
      'modulo di trasferimento dei contributi',
    );
  });
}

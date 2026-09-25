import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1832 (gemello di #1802/#1803, PR #1830): l'articolo chiedeva 18
// settimane (13 nel DE) «negli ultimi 2 anni» e 30 giornate di lavoro, usava
// i valori 2024 (soglia 1.208,15, massimale 1.314,30), escludeva i periodi
// svizzeri dal requisito, faceva partire l'indennita' dal giorno successivo
// alla cessazione e nella tabella dava alla disoccupazione svizzera un
// massimo di 2.360 CHF, una durata «estendibile a 4 anni per over 55» e una
// iscrizione all'URC «entro 10 giorni». Valori vigenti:
// - 13 settimane nei 4 anni (D.Lgs. 22/2015 art. 3), 30 giornate abolite
//   dall'1.1.2022 (art. 3 c. 1-bis; INPS circolare n. 2/2022);
// - 75% fino a 1.456,72 + 25% oltre, massimale 1.584,70 (INPS circolare
//   n. 4/2026); riduzione del 3% dal sesto mese, dall'ottavo con 55 anni
//   (art. 4 c. 3);
// - decorrenza dall'ottavo giorno dopo la cessazione o dal giorno dopo la
//   domanda (art. 6 c. 2);
// - frontaliere residente in Italia: paga l'INPS, con i periodi svizzeri
//   attestati dal documento portatile U1 e la retribuzione svizzera (art. 65
//   regolamento (CE) 883/2004; scheda INPS sui frontalieri);
// - Svizzera: 70-80% del guadagno assicurato, tetto 12.350 CHF al mese; 400
//   indennita' giornaliere, 520 dai 55 anni con 22 mesi di contributi; URC al
//   piu' tardi il primo giorno per cui si chiede l'indennita' (SECO, opuscolo
//   2026; Cantone Ticino, Sezione del lavoro);
// - art. 7 legge 83/2023 citato con il suo stato: non applicato a settembre
//   2026.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'naspi-frontalieri-italia-requisiti-calcolo-domanda';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';

function bodySource(locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${SLUG}.ts`), 'utf8');
}

test('la voce del registro porta la data del refresh fattuale', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

test('it: esempio di calcolo con i valori 2026', () => {
  const source = bodySource('it');
  assert.match(source, /€1\.456,72 × 75% = €1\.092,54/);
  assert.match(source, /\(€2\.000 - €1\.456,72\) × 25% = €135,82/);
  assert.match(source, /Totale: €1\.228,36\/mese/);
});

for (const locale of LOCALES) {
  test(`${locale}: requisiti, importi 2026, frontalieri e fonti ufficiali`, () => {
    const source = bodySource(locale);
    assert.match(source, /\b13 (?:settimane|Beitragswochen|weeks|semaines)/, '13 settimane di contribuzione');
    assert.match(source, /\b4 (?:anni|Jahren|years|années|dernières années)/, 'finestra di 4 anni');
    assert.match(source, /2022/, 'abolizione delle 30 giornate dal 2022');
    assert.match(source, /1[., ]584[.,]70/, 'massimale mensile 2026');
    assert.match(source, /1[., ]456[.,]72/, 'soglia di calcolo 2026');
    assert.match(source, /sesto mese|sechsten|sixth month|sixième mois/, 'riduzione dal sesto mese');
    assert.match(source, /ottavo giorno|achten Tag|eighth day|huitième jour/, 'decorrenza dall\'ottavo giorno');
    assert.match(source, /\bU1\b/, 'documento portatile U1');
    assert.match(source, /(?:art\.|Art\.|Artikel|Article|article|l\\'article) 65/, 'art. 65 del regolamento 883/2004');
    assert.match(source, /12[.,' ]350/, 'tetto svizzero del guadagno assicurato');
    assert.match(source, /\b400\b[\s\S]*\b520\b/, 'indennita\' giornaliere svizzere');
    assert.match(source, /83\/2023/, 'art. 7 della legge 83/2023');
    assert.match(source, /(?:settembre|September|septembre) 2026/, 'stato di applicazione dell\'art. 7');
    assert.match(source, /normattiva\.it\/uri-res\/N2Ls\?urn:nir:stato:decreto\.legislativo:2015-03-04;22/);
    assert.match(source, /lavoro\.gov\.it\/temi-e-priorita\/ammortizzatori-sociali\/focus-on\/indennita-disoccupazione\/naspi/);
    assert.match(source, /circolare-numero-2-del-04-01-2022/);
    assert.match(source, /circolare-numero-4-del-28-01-2026/);
    assert.match(source, /schede-servizi\.50188\./, 'scheda INPS sui frontalieri');
    assert.match(source, /CELEX:02004R0883/);
    assert.match(source, /urn:nir:stato:legge:2023-06-13;83~art7/);
    assert.match(source, /arbeit\.swiss\/dam\/secoalv/, 'opuscolo SECO');
    assert.match(source, /ti\.ch\/dfe\/de\/sdl\/persone-in-cerca-dimpiego\/a-quanto-ammonta/, 'Sezione del lavoro TI, importo');
    assert.match(source, /ti\.ch\/dfe\/de\/sdl\/persone-in-cerca-dimpiego\/qual-e-il-numero-massimo/, 'Sezione del lavoro TI, durata');
  });

  test(`${locale}: niente valori superati`, () => {
    const source = bodySource(locale);
    assert.doesNotMatch(source, /\b18 (?:settimane|Wochen|Beitragswochen|weeks|semaines)/, '18 settimane');
    assert.doesNotMatch(
      source,
      /(?:almeno|minimo(?: di)?|mindestens|at least|a minimum of|au moins|un minimum de) 30 (?:giorn|Tage|Arbeitstage|actual days|days|jours)/i,
      '30 giornate come requisito vigente',
    );
    assert.doesNotMatch(source, /\+ 30 (?:giorni|days|effektive|jours)/, '30 giornate nel riepilogo');
    assert.doesNotMatch(
      source,
      /ultimi 2 anni|last 2 years|letzten 2 Jahren|2 dernières années|24 mesi precedenti|previous 24 months|24 months prior|letzten 24 Monaten|24 Monaten vor|24 mois précédant|24 mois précédents|24 pre-unemployment|24 mesi pre-disoccupazione|minimo 13 in 2 anni|minimum 13 in 2 years|mindestens 13 in 2 Jahren|minimum 13 en 2 ans/,
      'finestra contributiva di 2 anni',
    );
    assert.doesNotMatch(source, /1[., ]314[.,]30|1[.,]314\/mese|1[.,]208[.,]15|1\.104,05/, 'valori NASpI 2024');
    assert.doesNotMatch(source, /2[.,]360/, 'massimo svizzero inventato');
    assert.doesNotMatch(source, /10 (?:giorni|days|Tagen|jours)\b/, 'iscrizione all\'URC entro 10 giorni');
    assert.doesNotMatch(source, /(?:estendibile|extendable|erweiterbar|extensible) (?:a|to|auf|à) 4/, 'durata svizzera estendibile a 4 anni');
    assert.doesNotMatch(source, /1[.,]5 (?:settimane|weeks|Wochen|semaines)/, 'durata calcolata a 1,5 settimane per mese');
    assert.doesNotMatch(
      source,
      /1° giorno successivo|1st day following|am 1\. Tag nach|du 1er jour suivant/,
      'decorrenza dal giorno successivo alla cessazione',
    );
    assert.doesNotMatch(
      source,
      /non generano diritti NASpI|Not entitled to NASpI|keinen Anspruch auf NASpI|pas droit à la NASpI|non riconosce automaticamente|does not automatically recognise|nicht automatisch an|ne reconnaît pas automatiquement/,
      'periodi svizzeri esclusi',
    );
    assert.doesNotMatch(
      source,
      /Devi scegliere quale sistema|You have to choose which system|Sie müssen wählen, welches System|Vous devez choisir quel système/,
      'scelta fra NASpI e indennita\' svizzera',
    );
  });
}

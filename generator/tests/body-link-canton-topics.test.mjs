/**
 * F6.3d: destinazioni tematiche per cantone nei link del corpo (eventi, valichi, targhe, stipendi,
 * strutture sanitarie, pagine del Ticino). Offline: l'elenco e' generator/data/body-link-destinations.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichArticleInternalLinks } from '../scripts/lib/contextual-article-links.mjs';
import { destinationPaths, loadBodyLinkDestinations } from '../scripts/lib/body-link-destinations.mjs';
import { build, FACILITY_CANTON, TICINO_PAGES } from '../../scripts/ci/build-body-link-destinations.mjs';

const bodySections = (c) => Object.fromEntries(Object.entries(c).filter(([k]) => /^body\d+$/.test(k)));
const run = (content, sectionName) => {
  const data = { content: structuredClone(content) };
  enrichArticleInternalLinks(data, { isPending: () => false, bodySections, sectionName });
  return data.content;
};
const links = (text) => [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((m) => ({ anchor: m[1], target: m[2] }));
const one = (locale, text, section) => links(run({ [locale]: { body1: text } }, section)[locale].body1);
// Solo pagine del sito: gli strumenti `nav:` (matcher storico) non sono oggetto di F6.3d.
const sitePages = (text, section, locale = 'it') => one(locale, text, section).filter((l) => !l.target.startsWith('nav:'));

test('eventi: locuzione di evento con il cantone della sezione nella frase, quattro lingue', () => {
  assert.deepEqual(one('it', 'Il festival di Zurigo richiama migliaia di persone.', 'canton-zh'), [{ anchor: 'festival', target: '/eventi/zurigo/' }]);
  assert.deepEqual(one('en', 'The Zurich festival draws thousands of visitors.', 'canton-zh'), [{ anchor: 'festival', target: '/en/events/zurich/' }]);
  assert.deepEqual(one('de', 'Das Festival in Zürich zieht Tausende an.', 'canton-zh'), [{ anchor: 'Festival', target: '/de/veranstaltungen/zurich/' }]);
  assert.deepEqual(one('fr', 'Le festival de Zurich attire des milliers de visiteurs.', 'canton-zh'), [{ anchor: 'festival', target: '/fr/evenements/zurich/' }]);
  // «N eventi tra ...» e «eventi in <cantone>»: l'ancora include il cantone o il conteggio.
  assert.deepEqual(one('it', 'Questo weekend nel Canton Zugo ci sono 48 eventi tra concerti, mostre e mercati.', 'canton-zg'), [{ anchor: '48 eventi', target: '/eventi/zugo/' }]);
  assert.deepEqual(one('en', 'This weekend there are 48 events in Zug — concerts and markets.', 'canton-zg'), [{ anchor: 'events in Zug', target: '/en/events/zug/' }]);
  assert.deepEqual(one('de', 'Am Wochenende gibt es 48 Veranstaltungen im Kanton Zug.', 'canton-zg'), [{ anchor: 'Veranstaltungen im Kanton Zug', target: '/de/veranstaltungen/zug/' }]);
  assert.deepEqual(one('fr', 'Ce week-end, il y a 48 événements dans le canton de Zoug.', 'canton-zg'), [{ anchor: 'événements dans le canton de Zoug', target: '/fr/evenements/zoug/' }]);
});

test('eventi: nessun link per eventi non culturali, altro cantone o frase senza il cantone', () => {
  for (const [locale, text, section] of [
    ['it', 'Eventi meteorologici estremi hanno colpito Zurigo.', 'canton-zh'],
    ['it', 'Il Consiglio di Stato di Zurigo agisce di concerto con la Confederazione.', 'canton-zh'],
    ['it', 'Il festival si terrà a Berna.', 'canton-zh'],
    ['it', 'Il festival della birra attira molti visitatori.', 'canton-zh'],
    ['it', 'Dopo 3 eventi sismici in Argovia, il cantone ha reagito.', 'canton-ag'],
    ['de', 'Veranstaltungen sind in Zürich vorübergehend verboten.', 'canton-zh'],
    ['en', 'The festival in Bern was cancelled; Zurich was not affected.', 'canton-zh'],
  ]) assert.deepEqual(one(locale, text, section), [], text);
  // Un altro cantone nominato nella stessa frase: il tema non e' del cantone della sezione.
  assert.deepEqual(one('it', 'Il festival tra Zurigo e Berna è stato annullato.', 'canton-zh'), []);
  // Sezioni non cantonali non usano le pagine per cantone.
  assert.deepEqual(one('it', 'Il festival di Zurigo richiama migliaia di persone.', 'frontaliere'), []);
});

test('valichi: serve la locuzione di coda/attesa; il paese nella frase sceglie la pagina, altrimenti l hub', () => {
  assert.deepEqual(one('it', 'Code ai valichi di frontiera con l’Austria nel fine settimana.', 'canton-gr'), [{ anchor: 'Code ai valichi', target: '/traffico-dogane/grigioni-austria/' }]);
  assert.deepEqual(one('it', 'I tempi di attesa al confine sono saliti a Basilea.', 'canton-basilea'), [{ anchor: 'tempi di attesa al confine', target: '/traffico-dogane/' }]);
  assert.deepEqual(one('it', 'Le code alla dogana di Chiasso superano i 40 minuti.', 'canton-ti'), [{ anchor: 'code alla dogana', target: '/traffico-dogane/ticino-como/' }]);
  assert.deepEqual(one('it', 'Le code alla dogana di Stabio e Gaggiolo superano i 40 minuti.', 'canton-ti'), [{ anchor: 'code alla dogana', target: '/traffico-dogane/ticino-varese/' }]);
  assert.deepEqual(one('en', 'Border queues towards Germany grew in Schaffhausen.', 'canton-sh'), [{ anchor: 'Border queues', target: '/en/border-wait/sciaffusa-germania/' }]);
  assert.equal(one('de', 'Wartezeiten am Zoll nach Frankreich in Genf.', 'canton-ge')[0]?.target, '/de/wartezeit-grenze/geneve-francia/');
  assert.equal(one('fr', 'Les files d’attente à la frontière avec la France augmentent à Genève.', 'canton-ge')[0]?.target, '/fr/temps-attente-douane/geneve-francia/');
  // Locuzione di valico senza coda/attesa, canton senza pagine di confine: nessun link.
  assert.deepEqual(sitePages('Un incidente al valico di frontiera ha ferito due persone.', 'canton-gr'), []);
  assert.deepEqual(one('de', 'Die Polizei kontrollierte die Grenzübergänge in St. Gallen.', 'canton-sg'), []);
  assert.deepEqual(sitePages('Code ai valichi di frontiera con la Germania.', 'canton-lu'), []);
  assert.deepEqual(one('it', 'Il valico alpino resta chiuso per neve e il traffico è deviato.', 'canton-gr'), []);
});

test('aste targhe, stipendio per professione e strutture sanitarie: solo del cantone della sezione', () => {
  assert.equal(one('it', 'L’asta di targhe del cantone ha incassato 1,2 milioni.', 'canton-zh')[0]?.target, '/aste-targhe-svizzera/zurigo-zh/');
  assert.equal(one('de', 'Die Autonummern-Auktion brachte 1,2 Millionen ein.', 'canton-zh')[0]?.target, '/de/schweizer-nummernschildauktionen/zurich-zh/');
  // I gruppi di mezzi cantoni hanno due pagine di targhe: nessun link.
  assert.deepEqual(one('it', 'L’asta di targhe ha incassato 1,2 milioni.', 'canton-basilea'), []);

  assert.deepEqual(one('it', 'Gli stipendi degli infermieri in Argovia sono saliti.', 'canton-ag'), [{ anchor: 'stipendi degli infermieri', target: '/stipendio-infermiere-argovia/' }]);
  assert.deepEqual(one('en', 'Nurse salaries in Aargau rose.', 'canton-ag'), [{ anchor: 'Nurse salaries', target: '/en/salary-nurse-aargau/' }]);
  assert.equal(one('de', 'Der Lohn der Apotheker im Aargau steigt.', 'canton-ag')[0]?.target, '/de/gehalt-apotheker-aargau/');
  assert.equal(one('fr', 'Le salaire des psychologues en Argovie progresse.', 'canton-ag')[0]?.target, '/fr/salaire-psychologue-argovie/');
  // Il cantone viene sempre dalla sezione: mai la pagina di un altro cantone.
  assert.deepEqual(one('it', 'Gli stipendi degli infermieri in Argovia sono saliti.', 'canton-sg').filter((l) => l.target.startsWith('/stipendio-')), []);
  assert.deepEqual(one('it', 'Gli stipendi degli infermieri sono saliti.', 'canton-sg').map((l) => l.target), ['/stipendio-infermiere-san-gallo/']);

  const luks = 'Il Luzerner Kantonsspital ha annunciato nuove assunzioni di personale infermieristico.';
  assert.equal(one('it', luks, 'canton-lu')[0]?.target, '/strutture-sanitarie/luks/');
  assert.deepEqual(one('it', luks, 'canton-zh').filter((l) => l.target.startsWith('/strutture-sanitarie/')), []);
  // Un servizio di soccorso in un rapporto di polizia non e' un rinvio alla pagina di lavoro.
  assert.deepEqual(one('de', 'Drei Mitglieder des Rettungsdienstes der Spitäler Schaffhausen waren vor Ort.', 'canton-sh'), []);
  assert.deepEqual(one('it', 'Il Luzerner Kantonsspital ha annunciato tagli al reparto.', 'canton-lu'), []);
  assert.deepEqual(one('it', 'Il personale delle ambulanze del Luzerner Kantonsspital e i collaboratori hanno partecipato all’esercitazione.', 'canton-lu'), []);
});

test('Ticino: meteo, farmacie, giorni festivi, vacanze scolastiche, costo della vita e carburanti solo in canton-ti', () => {
  assert.equal(one('it', 'Servono le previsioni meteo a Lugano per il fine settimana.', 'canton-ti')[0]?.target, '/meteo-frontalieri/lugano/');
  assert.equal(one('en', 'See the weather forecast for Bellinzona.', 'canton-ti')[0]?.target, '/en/commute-weather/bellinzona/');
  assert.equal(one('it', 'Le farmacie di turno restano aperte.', 'canton-ti')[0]?.target, '/farmacie-di-turno/');
  assert.equal(one('it', 'I giorni festivi in Ticino per il 2027 sono dodici.', 'canton-ti')[0]?.target, '/giorni-festivi-ticino/');
  assert.deepEqual(one('it', 'I giorni festivi sono dodici.', 'canton-ti'), []);
  assert.equal(one('it', 'Le vacanze scolastiche 2027 cambiano.', 'canton-ti')[0]?.target, '/vita-in-ticino/vacanze-scolastiche-ticino-2027/');
  assert.deepEqual(one('it', 'Le vacanze scolastiche cambiano.', 'canton-ti'), []);
  assert.equal(one('it', 'Il costo della vita a Lugano cresce.', 'canton-ti')[0]?.target, '/costo-vita-lugano-ticino/');
  assert.equal(one('it', 'Il prezzo del diesel scende.', 'canton-ti')[0]?.target, '/prezzi-diesel/oggi/');
  assert.equal(one('de', 'Der Dieselpreis sinkt.', 'canton-ti')[0]?.target, '/de/dieselpreis-schweiz/heute/');
  for (const section of ['canton-ag', 'canton-vd', 'svizzera', 'frontaliere']) {
    assert.deepEqual(one('it', 'Le previsioni meteo a Lugano e le farmacie di turno.', section).filter((l) => /meteo-frontalieri|farmacie/.test(l.target)), [], section);
  }
});

test('frasi che escludono l argomento non producono link (negazioni in quattro lingue)', () => {
  for (const [locale, text, section] of [
    ['it', 'Il comunicato non quantifica gli stipendi degli infermieri in Argovia.', 'canton-ag'],
    ['it', 'Restano fuori dal testo i premi LAMal, le trattenute AVS e la cassa pensione.', 'canton-vs'],
    ['en', 'The bulletin does not measure the minimum wage or the cost of living in Neuchâtel.', 'canton-ne'],
    ['de', 'Der Bericht beziffert die Krankenkassenprämien im Wallis nicht.', 'canton-vs'],
    ['de', 'Der Bericht nennt die Löhne der Pflegefachpersonen im Aargau nicht, nicht beziffert.', 'canton-ag'],
    ['it', 'Non descrive nemmeno cambiamenti per i pazienti del Kantonsspital Baden, nuove assunzioni o effetti.', 'canton-ag'],
    ['en', 'The text therefore leaves out the AVS deductions and the KVG premiums in Valais.', 'canton-vs'],
    ['de', 'In der Meldung ist nicht von Staus oder Wartezeiten an den Grenzübergängen im Kanton Graubünden die Rede.', 'canton-gr'],
    ['de', 'Es wird auf Wartezeiten hingewiesen, ohne anzugeben, wie viele Minuten an den Grenzübergängen entstehen.', 'canton-ti'],
    ['fr', 'Le communiqué ne chiffre pas les primes d’assurance maladie à Genève.', 'canton-ge'],
  ]) assert.deepEqual(one(locale, text, section).filter((l) => l.target.startsWith('/') && !l.target.startsWith('nav:')), [], text);
});

test('mestiere usato come aggettivo («poste comptable», «équipe médicale et infirmière») non e un annuncio', () => {
  assert.deepEqual(one('fr', 'L’arrêt ne transforme pas chaque poste comptable en prêt, selon le travail du canton.', 'canton-zh'), []);
  assert.deepEqual(one('fr', 'Le travail de l’équipe médicale et infirmière spécialisée est salué.', 'canton-appenzello'), []);
  assert.equal(one('fr', 'La pénurie d’infirmiers aggrave le recrutement.', 'canton-vd')[0]?.target, '/fr/travail-vaud-infirmier/');
});

test('idempotenza e nessun link a un URL non verificato', () => {
  const content = {
    it: { body1: 'Il festival di Zurigo e le code ai valichi di frontiera con la Germania. Gli stipendi degli infermieri in Argovia.' },
    en: { body1: 'The Zurich festival and border queues towards Germany.' },
  };
  const once = run(content, 'canton-zh');
  assert.deepEqual(run(once, 'canton-zh'), once);
  const data = loadBodyLinkDestinations();
  assert.deepEqual(data.rejected, []);
  const known = Object.fromEntries(['it', 'en', 'de', 'fr'].map((l) => [l, new Set(Object.values(destinationPaths(l, data)))]));
  for (const section of ['canton-zh', 'canton-ti', 'canton-gr', 'canton-ag', 'canton-lu']) {
    for (const [locale, text] of [
      ['it', 'Il festival, le code ai valichi di frontiera, l’asta di targhe, gli stipendi degli infermieri e le farmacie di turno: Zurigo Grigioni Argovia Lucerna Ticino, 48 eventi tra concerti.'],
      ['de', 'Das Festival, Wartezeiten am Zoll, die Löhne der Krankenpfleger, Veranstaltungen in Zürich.'],
    ]) {
      for (const l of links(run({ [locale]: { body1: text } }, section)[locale].body1)) {
        if (l.target.startsWith('/')) assert.ok(known[locale].has(l.target), `${section} ${locale} ${l.target}`);
      }
    }
  }
});

test('elenco F6.3d: tutte le strutture e le pagine del Ticino attese sono presenti, nessuna URL con le quattro lingue incomplete', () => {
  const data = loadBodyLinkDestinations();
  assert.equal(Object.keys(data.eventsLanding).length, 24);
  assert.equal(Object.keys(data.plateAuctions).length, 22);
  assert.ok(data.borderTraffic.hub && data.borderTraffic['TI/como'] && data.borderTraffic['GR/austria']);
  assert.deepEqual(Object.keys(data.facilityLanding).map((k) => k.split('/')[1]).sort(), Object.keys(FACILITY_CANTON).sort());
  assert.deepEqual(Object.keys(data.ticinoPages).sort(), Object.keys(TICINO_PAGES).sort());
  for (const table of [data.eventsLanding, data.borderTraffic, data.plateAuctions, data.salaryProfession, data.facilityLanding, data.ticinoPages]) {
    for (const quad of Object.values(table)) assert.deepEqual(Object.keys(quad).sort(), ['de', 'en', 'fr', 'it']);
  }
});

test('builder F6.3d: pagine tematiche dalle sitemap, gemelli dagli hreflang, scarto di cio che non verifica', async () => {
  const loc = (...paths) => `<urlset>${paths.map((p) => `<url><loc>https://frontaliereticino.ch${p}</loc></url>`).join('')}</urlset>`;
  const xml = {
    'sitemap-eventi.xml': loc('/eventi/zurigo/', '/eventi/ticino/', '/eventi/zurigo/zurich/'),
    'sitemap-border-wait.xml': loc('/traffico-dogane/', '/traffico-dogane/sciaffusa-germania/', '/traffico-dogane/ticino-como/', '/traffico-dogane/gaggiolo/oggi/'),
    'sitemap-plate-auctions.xml': loc('/aste-targhe-svizzera/zurigo-zh/', '/aste-targhe-svizzera/basilea-citta-bs/'),
    'sitemap-salary-profession-cantons.xml': loc('/stipendio-infermiere-argovia/', '/stipendio-assistente-sociale-san-gallo/'),
    'sitemap-health-facilities.xml': loc('/strutture-sanitarie/luks/'),
    'sitemap-weather.xml': loc('/meteo-frontalieri/', '/meteo-frontalieri/lugano/'),
    'sitemap-farmacie.xml': loc('/farmacie-di-turno/'),
  };
  const data = await build({
    readXml: async (name) => xml[name] ?? '',
    readAlternates: async (p) => ({ it: p, en: `/en${p}`, de: `/de${p}`, fr: `/fr${p}` }),
    verifyPaths: async (paths) => new Map(paths.map((p) => [p, p === '/de/eventi/ticino/' ? { ok: false, status: 404, canonical: null } : { ok: true }])),
  });
  assert.deepEqual(Object.keys(data.eventsLanding), ['ZH']);
  assert.deepEqual(Object.keys(data.borderTraffic).sort(), ['SH/germania', 'TI/como', 'hub']);
  assert.deepEqual(Object.keys(data.plateAuctions), ['ZH']);
  assert.deepEqual(Object.keys(data.salaryProfession).sort(), ['AG/infermiere', 'SG/assistente-sociale']);
  assert.deepEqual(Object.keys(data.facilityLanding), ['LU/luks']);
  assert.deepEqual(Object.keys(data.ticinoPages).sort(), ['pharmacies:on-duty', 'weather:hub', 'weather:lugano']);
  assert.deepEqual(data.rejected, [{ path: '/de/eventi/ticino/', status: 404, canonical: null }]);
});

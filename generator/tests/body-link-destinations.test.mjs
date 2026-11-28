/**
 * F6.3b: link nel corpo verso landing lavoro, professioni e pagine tematiche per cantone.
 * Offline: l'elenco delle destinazioni e' generator/data/body-link-destinations.json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { enrichArticleInternalLinks } from '../scripts/lib/contextual-article-links.mjs';
import { createBodyLinkMatcher, destinationPaths, loadBodyLinkDestinations, cantonCodeOfSection } from '../scripts/lib/body-link-destinations.mjs';
import { build, canonicalOf, hreflangAlternates, quadsOf } from '../../scripts/ci/build-body-link-destinations.mjs';

const bodySections = (c) => Object.fromEntries(Object.entries(c).filter(([k]) => /^body\d+$/.test(k)));
const run = (content, sectionName, opts = {}) => {
  const data = { content: structuredClone(content) };
  enrichArticleInternalLinks(data, { isPending: () => false, bodySections, sectionName, ...opts });
  return data.content;
};
const links = (text) => [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((m) => ({ anchor: m[1], target: m[2] }));
const internal = (content) => links(Object.values(content).flatMap((c) => Object.values(c)).join('\n')).filter((l) => l.target.startsWith('/') || l.target.startsWith('nav:'));

test('articolo cantonale che cita una professione: landing del PROPRIO cantone, nelle quattro lingue', () => {
  const out = run({
    it: { body1: 'La carenza di infermieri nelle strutture di cura aumenta le assunzioni.' },
    en: { body1: 'The shortage of nurses in care homes is raising hiring.' },
    de: { body1: 'Der Mangel an Krankenpflegern in Pflegeheimen erhöht die Anstellungen.' },
    fr: { body1: 'La pénurie d’infirmiers dans les EMS augmente les embauches.' },
  }, 'canton-ag');
  assert.deepEqual(links(out.it.body1), [{ anchor: 'infermieri', target: '/lavoro-argovia-infermiere/' }]);
  assert.deepEqual(links(out.en.body1), [{ anchor: 'nurses', target: '/en/jobs-aargau-nurse/' }]);
  assert.deepEqual(links(out.de.body1), [{ anchor: 'Krankenpflegern', target: '/de/arbeit-aargau-krankenpfleger/' }]);
  assert.deepEqual(links(out.fr.body1), [{ anchor: 'infirmiers', target: '/fr/travail-argovie-infirmier/' }]);
});

test('frontaliere: professione verso il landing del Ticino; svizzera e cantoni senza pagina: nessun link', () => {
  const body = { it: { body1: 'Cercano elettricisti e muratori: le assunzioni crescono.' } };
  assert.equal(links(run(body, 'frontaliere').it.body1)[0]?.target, '/lavoro-ticino-elettricista/');
  assert.deepEqual(links(run(body, 'svizzera').it.body1), []);
  // Un cantone senza la combinazione professione x cantone non ripiega sul Ticino.
  assert.deepEqual(links(run({ it: { body1: 'Cercano saldatori: le assunzioni crescono.' } }, 'canton-uri').it.body1), []);
});

test('nessuna destinazione pertinente: il testo resta identico', () => {
  const text = 'Il Gran Consiglio di Argovia ha votato il preventivo. Nel Canton Argovia nevica.';
  assert.equal(run({ it: { body1: text } }, 'canton-ag').it.body1, text);
});

test('nomi di mestiere ambigui servono solo con la formula esplicita di lavoro', () => {
  assert.deepEqual(links(run({ it: { body1: 'Gli operai hanno scioperato davanti alla fabbrica.' } }, 'frontaliere').it.body1), []);
  assert.deepEqual(links(run({ it: { body1: 'Un autista ha perso il controllo del mezzo e si è ribaltato.' } }, 'frontaliere').it.body1), []);
  assert.equal(links(run({ it: { body1: 'Ci sono posti di lavoro come operaio nel settore.' } }, 'frontaliere').it.body1)[0]?.target, '/lavoro-ticino-operaio/');
  // Un mestiere «strong» senza contesto di lavoro nella frase non e' un rinvio.
  assert.deepEqual(links(run({ it: { body1: 'L’architetto ha presentato il rendering della piazza.' } }, 'frontaliere').it.body1), []);
});

test('ricerca lavoro: serve la locuzione di ricerca col cantone; i composti e la prosa generica no', () => {
  assert.equal(links(run({ it: { body1: 'Le offerte di lavoro in Argovia sono in crescita.' } }, 'canton-ag').it.body1)[0]?.target, '/cerca-lavoro-argovia/');
  assert.equal(links(run({ en: { body1: 'Jobs in Zurich are growing.' } }, 'canton-zh').en.body1)[0]?.target, '/en/find-jobs-zurich/');
  assert.equal(links(run({ de: { body1: 'Stellenangebote im Kanton Aargau wachsen.' } }, 'canton-ag').de.body1)[0]?.target, '/de/jobs-im-aargau/');
  assert.equal(links(run({ fr: { body1: 'Les offres d’emploi à Genève augmentent.' } }, 'canton-ge').fr.body1)[0]?.target, '/fr/trouver-emploi-geneve/');
  for (const text of [
    'Chi vive o lavora in Argovia vede il cantone cambiare.',
    'Once finished their work in Switzerland they moved back.',
    'Per chi finisce il lavoro in Svizzera la residenza resta in Italia.',
    'Posti di lavoro in Basel-Landschaft restano stabili.'.replace('Posti di lavoro in', 'Jobs in'),
  ]) {
    const out = run({ it: { body1: text } }, 'canton-ag').it.body1;
    assert.deepEqual(links(out), [], text);
  }
});

test('premi cassa malati e salario minimo: pagina del cantone nominato nella frase, poi della sezione, poi hub', () => {
  assert.equal(links(run({ it: { body1: 'I premi di cassa malati salgono a Soletta.' } }, 'canton-ag').it.body1)[0]?.target, '/premi-cassa-malati/soletta/');
  assert.equal(links(run({ it: { body1: 'I premi della cassa malati salgono ancora.' } }, 'canton-ag').it.body1)[0]?.target, '/premi-cassa-malati/argovia/');
  assert.equal(links(run({ it: { body1: 'I premi della cassa malati salgono ancora.' } }, 'svizzera').it.body1)[0]?.target, '/premi-cassa-malati/');
  assert.equal(links(run({ en: { body1: 'Health insurance premiums rise in Zurich.' } }, 'svizzera').en.body1)[0]?.target, '/en/health-insurance-premiums/zurich/');
  assert.equal(links(run({ it: { body1: 'Ginevra ha il salario minimo più alto.' } }, 'svizzera').it.body1)[0]?.target, '/salario-minimo/ginevra/');
  // Il salario minimo ha senso solo nelle sezioni che ne trattano; non nelle altre cantonali.
  assert.deepEqual(links(run({ it: { body1: 'Il Cantone fissa un salario minimo per i pre-tirocini.' } }, 'canton-lu').it.body1), []);
});

test('frasi che escludono l’argomento non diventano link', () => {
  const text = 'Non sono documentati effetti su salario minimo, premi cassa malati o assunzioni.';
  // (il `nav:` storico sugli strumenti non e' oggetto di questa prova: contano solo i percorsi del sito)
  const paths = (out) => links(out).filter((l) => l.target.startsWith('/'));
  assert.deepEqual(paths(run({ it: { body1: text } }, 'canton-ge').it.body1), []);
  assert.deepEqual(paths(run({ it: { body1: 'Nessun legame con le imposte né con premi della cassa malati.' } }, 'canton-ge').it.body1), []);
});

test('tetto: al piu 2 link verso destinazioni e 4 link interni nel corpo, anche con nav gia presenti', () => {
  const text = 'Gli infermieri e gli elettricisti: le assunzioni crescono. Le offerte di lavoro in Argovia e i premi della cassa malati. '
    + 'Calcola lo [stipendio netto](nav:calculator) e il [cambio franco euro](nav:exchange) e la [pensione](nav:pension).';
  const out = run({ it: { body1: text } }, 'canton-ag');
  const destination = links(out.it.body1).filter((l) => l.target.startsWith('/'));
  assert.ok(destination.length >= 1 && destination.length <= 2, JSON.stringify(destination));
  assert.ok(internal(out).length <= 4, JSON.stringify(internal(out)));
  const fresh = run({ it: { body1: 'Gli infermieri, gli elettricisti, i muratori e i cuochi: le assunzioni crescono. Le offerte di lavoro in Argovia.' } }, 'canton-ag');
  // La ricerca lavoro del cantone ha la precedenza sui mestieri quando il budget e' di due.
  assert.deepEqual(links(fresh.it.body1).map((l) => l.target), ['/lavoro-argovia-infermiere/', '/cerca-lavoro-argovia/']);
});

test('idempotente, e un link gia presente alla stessa destinazione non si duplica', () => {
  const once = run({ it: { body1: 'Gli infermieri sono richiesti: le assunzioni crescono. Servono altri infermieri.' } }, 'frontaliere');
  assert.deepEqual(run(once, 'frontaliere'), once);
  const manual = { it: { body1: 'Vedi [lavoro infermieri Ticino](/lavoro-ticino-infermiere/). Gli infermieri sono richiesti: le assunzioni crescono.' } };
  assert.equal(run(manual, 'frontaliere').it.body1, manual.it.body1);
});

test('traduzione in attesa: nessun link e nessun cambio', () => {
  const content = { it: { body1: 'Gli infermieri: le assunzioni crescono.' }, en: { body1: 'The nurses: hiring is growing.' } };
  const out = run(content, 'frontaliere', { isPending: (_d, locale) => locale === 'en' });
  assert.equal(out.en.body1, content.en.body1);
  assert.equal(links(out.it.body1).length, 1);
});

test('titoli, codice e link esistenti restano letterali', () => {
  const text = '## Infermieri: le assunzioni\n\n`infermieri assunzioni`\n\n[infermieri](https://example.org/x) e infermieri.';
  assert.equal(run({ it: { body1: text } }, 'frontaliere').it.body1.split('\n')[0], '## Infermieri: le assunzioni');
  assert.ok(!/\]\(\/lavoro-ticino-infermiere\/\)[^\n]*\n\n`/.test(run({ it: { body1: text } }, 'frontaliere').it.body1));
});

test('elenco destinazioni: lingua giusta in ogni URL, nessuna scartata, completo per le quattro lingue', () => {
  const data = loadBodyLinkDestinations();
  assert.ok(data && data.schema === 1);
  assert.deepEqual(data.rejected, []);
  const prefix = { it: (p) => !/^\/(en|de|fr)\//.test(p), en: (p) => p.startsWith('/en/'), de: (p) => p.startsWith('/de/'), fr: (p) => p.startsWith('/fr/') };
  for (const locale of ['it', 'en', 'de', 'fr']) {
    const paths = destinationPaths(locale, data);
    assert.ok(Object.keys(paths).length > 200);
    for (const [id, p] of Object.entries(paths)) {
      assert.ok(prefix[locale](p) && p.startsWith('/') && p.endsWith('/') && !/[\s<>"'()]/.test(p), `${id} ${locale} ${p}`);
    }
  }
  assert.ok(data.cantonLanding.TI && data.cantonLanding.ZH && data.nationalLanding);
  assert.ok(Object.keys(data.professionLanding).length === 19);
});

test('sezione -> codice cantone', () => {
  assert.equal(cantonCodeOfSection('canton-ag'), 'AG');
  assert.equal(cantonCodeOfSection('canton-basilea'), 'BASILEA');
  assert.equal(cantonCodeOfSection('frontaliere'), null);
  assert.equal(cantonCodeOfSection('canton-xx'), null);
});

test('builder: canonical con attributi senza virgolette, hreflang, gruppi di quattro, scarto di cio che non verifica', async () => {
  assert.equal(canonicalOf('<link rel=canonical href="https://frontaliereticino.ch/a/">'), '/a/');
  assert.equal(canonicalOf('<link rel="canonical" href=https://frontaliereticino.ch/b/>'), '/b/');
  assert.equal(canonicalOf('<link rel="alternate" href="https://frontaliereticino.ch/c/">'), null);
  assert.deepEqual(hreflangAlternates('<link rel=alternate hreflang=en href="https://frontaliereticino.ch/en/x/"><link rel=alternate hreflang=x-default href="https://frontaliereticino.ch/x/">'), { en: '/en/x/' });
  assert.deepEqual(quadsOf(['/a/', '/en/a/', '/de/a/']), []);
  assert.equal(quadsOf(['/a/', '/en/a/', '/de/a/', '/fr/a/']).length, 1);

  const loc = (...paths) => `<urlset>${paths.map((p) => `<url><loc>https://frontaliereticino.ch${p}</loc></url>`).join('')}</urlset>`;
  const quad = (it, en, de, fr) => [it, `/en/${en}`, `/de/${de}`, `/fr/${fr}`];
  const xml = {
    'sitemap-jobs.xml': loc(...quad('/cerca-lavoro-ticino/', 'find-jobs-ticino/', 'jobs-im-tessin/', 'trouver-emploi-tessin/')),
    'sitemap-jobs-argovia.xml': loc(...quad('/cerca-lavoro-argovia/', 'find-jobs-aargau/', 'jobs-im-aargau/', 'trouver-emploi-argovie/')),
    'sitemap-jobs-svizzera.xml': loc(...quad('/cerca-lavoro-svizzera/', 'find-jobs-switzerland/', 'jobs-in-schweiz/', 'trouver-emploi-suisse/')),
    'sitemap-professions.xml': loc(...quad('/lavoro-ticino-cuoco/', 'jobs-ticino-cook/', 'arbeit-tessin-koch/', 'travail-tessin-cuisinier/')),
    'sitemap-profession-cantons.xml': loc(...quad('/lavoro-argovia-cuoco/', 'jobs-aargau-cook/', 'arbeit-aargau-koch/', 'travail-argovie-cuisinier/')),
    'sitemap-health-premiums.xml': loc('/premi-cassa-malati/', '/premi-cassa-malati/argovia/'),
    'sitemap-minimum-wage.xml': loc('/salario-minimo/'),
  };
  const data = await build({
    readXml: async (name) => xml[name] ?? '',
    readAlternates: async (p) => ({ it: p, en: `/en${p}`, de: `/de${p}`, fr: `/fr${p}` }),
    // Il landing professione x cantone in tedesco non supera la verifica: l'intero gruppo esce.
    verifyPaths: async (paths) => new Map(paths.map((p) => [p, p === '/de/arbeit-aargau-koch/' ? { ok: false, status: 404, canonical: null } : { ok: true }])),
  });
  assert.deepEqual(Object.keys(data.cantonLanding).sort(), ['AG', 'TI']);
  assert.deepEqual(Object.keys(data.professionLanding), ['cuoco']);
  assert.deepEqual(data.professionCantonLanding, {});
  assert.deepEqual(data.rejected, [{ path: '/de/arbeit-aargau-koch/', status: 404, canonical: null }]);
  assert.deepEqual(Object.keys(data.topicLanding['health-premiums']).sort(), ['AG', 'CH']);
});

test('il matcher non produce nulla senza elenco o in lingua sconosciuta', () => {
  const matcher = createBodyLinkMatcher({ sectionName: 'frontaliere', destinations: null });
  assert.deepEqual(matcher('infermieri: assunzioni', 'it'), []);
  assert.deepEqual(createBodyLinkMatcher({ sectionName: 'frontaliere' })('infermieri: assunzioni', 'es'), []);
  assert.ok(fs.existsSync(new URL('../data/body-link-destinations.json', import.meta.url)));
});

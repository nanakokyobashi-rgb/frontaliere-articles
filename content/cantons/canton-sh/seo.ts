// Metadati SEO degli articoli della sezione canton-sh (Sciaffusa).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-esplosione-bancomat-thayngen': {
    title: 'Thayngen: esploso un bancomat, ferito un sospetto',
    description: 'Esplosione di un bancomat a Thayngen il 30 settembre 2026: un presunto autore olandese è gravemente ferito, due complici fuggono verso la Germania; area chiusa.',
    keywords: 'frontalieri, ticino, svizzera, italia, thayngen, esploso, bancomat, ferito',
    ogTitle: 'Esplosione di un bancomat a Thayngen',
    ogDescription: 'Bancomat esploso davanti alla stazione di Thayngen: un cittadino olandese è gravemente ferito, due presunti autori sono fuggiti verso la Germania. L\'area è chiusa per esplosivo non detonato e la polizia cerca testimoni.',
    canonicalPath: '/articoli-sciaffusa/esplosione-bancomat-thayngen/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Thayngen: esploso un bancomat, ferito un sospetto",
      "description": "Esplosione di un bancomat a Thayngen il 30 settembre 2026: un presunto autore olandese è gravemente ferito, due complici fuggono verso la Germania; area chiusa.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-esplosione-bancomat-thayngen.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Area chiusa attorno alla stazione di Thayngen dopo l'esplosione di un bancomat."
      },
      "datePublished": "2026-10-07T23:37:11+00:00",
      "dateModified": "2026-10-07T23:37:11+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/esplosione-bancomat-thayngen/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-sciaffusa-formazione-farmacie': {
    title: 'Sciaffusa: e-learning per farmacie sulla violenza domestica',
    description: 'Sciaffusa: e-learning volontario per il personale delle farmacie; segnali di violenza domestica, colloquio riservato e rinvio ai servizi di sostegno.',
    keywords: 'frontalieri, ticino, svizzera, italia, sciaffusa, e-learning, farmacie, sulla',
    ogTitle: 'Farmacie di Sciaffusa: formazione sulla violenza domestica',
    ogDescription: 'Sciaffusa: offerta digitale e volontaria per farmaciste, farmacisti e personale specializzato. Si impara a riconoscere segnali, parlare in modo riservato e rinviare a servizi di sostegno e consulenza; i costi sono assunti dal Cantone.',
    canonicalPath: '/articoli-sciaffusa/sciaffusa-formazione-farmacie/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Sciaffusa: e-learning per farmacie sulla violenza domestica",
      "description": "Sciaffusa: e-learning volontario per il personale delle farmacie; segnali di violenza domestica, colloquio riservato e rinvio ai servizi di sostegno.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-sciaffusa-formazione-farmacie.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Personale di farmacia in formazione sulla violenza domestica a Sciaffusa"
      },
      "datePublished": "2026-10-08T08:29:37+00:00",
      "dateModified": "2026-10-08T08:29:37+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/sciaffusa-formazione-farmacie/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-seehas-affollamento-mattutino': {
    title: 'Seehas più pieno e viaggi più lunghi sulla Konstanz-Singen',
    description: 'La chiusura della Schwarzwaldbahn ferma il Regionalexpress tra Konstanz e Singen, aumenta l\'uso della S-Bahn Seehas, provoca affollamento mattutino e allunga',
    keywords: 'frontalieri, ticino, svizzera, italia, seehas, pieno, viaggi, lunghi',
    ogTitle: 'Seehas più pieno e viaggi più lunghi sulla Konstanz-Singen',
    ogDescription: 'A causa della sospensione del Regionalexpress sulla linea Konstanz-Singen, dovuta alla chiusura della Schwarzwaldbahn, sempre più passeggeri si spostano sulla S-Bahn Seehas. Questo provoca un maggiore affollamento, soprattutto nelle ore del mattino',
    canonicalPath: '/articoli-sciaffusa/seehas-affollamento-mattutino/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Seehas più pieno e viaggi più lunghi sulla Konstanz-Singen",
      "description": "La chiusura della Schwarzwaldbahn ferma il Regionalexpress tra Konstanz e Singen, aumenta l'uso della S-Bahn Seehas, provoca affollamento mattutino e allunga",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-seehas-affollamento-mattutino.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-08T09:19:35+00:00",
      "dateModified": "2026-10-08T09:19:35+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/seehas-affollamento-mattutino/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-sciaffusa-dati-lavoro-2026': {
    title: 'Disoccupazione nel Canton Sciaffusa: dati settembre 2026',
    description: 'Il Centro regionale di collocamento comunica i dati sulla disoccupazione nel Canton Sciaffusa per settembre 2026; il lead pubblico non riporta le cifre.',
    keywords: 'frontalieri, ticino, svizzera, italia, disoccupazione, canton, sciaffusa, dati',
    ogTitle: 'Disoccupazione nel Canton Sciaffusa: settembre 2026',
    ogDescription: 'Il Centro regionale di collocamento ha comunicato i dati sulla disoccupazione del Canton Sciaffusa per settembre 2026. Il materiale pubblico identifica ente, territorio e periodo, ma non espone i valori numerici.',
    canonicalPath: '/articoli-sciaffusa/sciaffusa-dati-lavoro-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Disoccupazione nel Canton Sciaffusa: dati settembre 2026",
      "description": "Il Centro regionale di collocamento comunica i dati sulla disoccupazione nel Canton Sciaffusa per settembre 2026; il lead pubblico non riporta le cifre.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-sciaffusa-dati-lavoro-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-09T12:18:54+00:00",
      "dateModified": "2026-10-09T12:18:54+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/sciaffusa-dati-lavoro-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-finanze-cantone-sciaffusa-2027': {
    title: 'Sciaffusa: previste cifre rosse tra il 2027 e il 2030',
    description: 'Il governo di Sciaffusa prevede cifre rosse 2027-2030. Walter Hotz chiede chiarimenti sul dopo-2031 e misure per le società internazionali.',
    keywords: 'frontalieri, ticino, svizzera, italia, sciaffusa, previste, cifre, rosse',
    ogTitle: 'Sciaffusa: previste cifre rosse tra il 2027 e il 2030',
    ogDescription: 'Il governo cantonale di Sciaffusa attende risultati negativi per il quadriennio 2027-2030. Walter Hotz chiede misure per trattenere le imprese internazionali e prospettive per il 2031.',
    canonicalPath: '/articoli-sciaffusa/finanze-cantone-sciaffusa-2027/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Sciaffusa: previste cifre rosse tra il 2027 e il 2030",
      "description": "Il governo di Sciaffusa prevede cifre rosse 2027-2030. Walter Hotz chiede chiarimenti sul dopo-2031 e misure per le società internazionali.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-finanze-cantone-sciaffusa-2027.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Edifici governativi del Canton Sciaffusa"
      },
      "datePublished": "2026-10-10T21:14:11+00:00",
      "dateModified": "2026-10-10T21:14:11+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/finanze-cantone-sciaffusa-2027/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-singen-chiusura-schaffhauser-strasse': {
    title: 'Singen, chiusa la Schaffhauser Straße dal 26 al 30 ottobre',
    description: 'Schaffhauser Straße chiusa a Singen dal 26 al 30 ottobre 2026: lavori alla fermata Landesgartenschau, passaggio per pedoni e ciclisti, deviazioni segnalate.',
    keywords: 'frontalieri, ticino, svizzera, italia, singen, chiusa, schaffhauser, straße',
    ogTitle: 'Singen: Schaffhauser Straße chiusa per lavori',
    ogDescription: 'Durante le ferie autunnali, la Schaffhauser Straße sarà completamente chiusa a Singen dal 26 al 30 ottobre 2026. Pedoni e ciclisti potranno passare; autobus di linea e soccorsi useranno la Roseneggstraße, mentre il resto del traffico seguirà',
    canonicalPath: '/articoli-sciaffusa/singen-chiusura-schaffhauser-strasse/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Singen, chiusa la Schaffhauser Straße dal 26 al 30 ottobre",
      "description": "Schaffhauser Straße chiusa a Singen dal 26 al 30 ottobre 2026: lavori alla fermata Landesgartenschau, passaggio per pedoni e ciclisti, deviazioni segnalate.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-singen-chiusura-schaffhauser-strasse.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-17T01:47:28+00:00",
      "dateModified": "2026-10-17T01:47:28+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/singen-chiusura-schaffhauser-strasse/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-eventi-weekend-sciaffusa': {
    title: 'Eventi del weekend nel Canton Sciaffusa: cosa fare',
    description: 'Agenda degli eventi del weekend nel Canton Sciaffusa: concerti, mostre, feste e mercati, comune per comune, aggiornata ogni giorno.',
    keywords: 'eventi nel Canton Sciaffusa, eventi weekend nel Canton Sciaffusa, cosa fare nel Canton Sciaffusa, agenda eventi nel Canton Sciaffusa',
    ogTitle: 'Eventi del weekend nel Canton Sciaffusa',
    ogDescription: 'Concerti, mostre, feste e mercati questo weekend nel Canton Sciaffusa, comune per comune. Aggiornato ogni giorno.',
    canonicalPath: '/articoli-sciaffusa/eventi-weekend-sciaffusa/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Eventi del weekend nel Canton Sciaffusa: cosa fare sabato e domenica",
      "description": "Agenda degli eventi del weekend nel Canton Sciaffusa: concerti, mostre, feste e mercati, comune per comune, aggiornata ogni giorno.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/places/lugano-view.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Eventi del weekend nel Canton Sciaffusa"
      },
      "datePublished": "2026-10-17T11:30:26+00:00",
      "dateModified": "2026-10-17T11:30:26+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/eventi-weekend-sciaffusa/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-treni-zurigo-stoccarda': {
    title: 'SBB e DB pianificano riserve tra Zurigo e Stoccarda',
    description: 'Tra Zurigo e Stoccarda SBB e DB pianificano riserve per collegamenti più stabili. La decisione sui treni senza cambio ogni ora è prevista nella primavera 2027.',
    keywords: 'frontalieri, ticino, svizzera, italia, pianificano, riserve, zurigo, stoccarda',
    ogTitle: 'Riserve ferroviarie tra Zurigo e Stoccarda',
    ogDescription: 'Per rendere più stabili i collegamenti tra Zurigo e Stoccarda, SBB e DB stanno pianificando riserve di percorrenza aggiuntive. Nella primavera 2027 decideranno se tornare ai treni senza cambio ogni ora sul tratto.',
    canonicalPath: '/articoli-sciaffusa/treni-zurigo-stoccarda/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "SBB e DB pianificano riserve tra Zurigo e Stoccarda",
      "description": "Tra Zurigo e Stoccarda SBB e DB pianificano riserve per collegamenti più stabili. La decisione sui treni senza cambio ogni ora è prevista nella primavera 2027.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-treni-zurigo-stoccarda.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Treno passeggeri sul collegamento ferroviario tra Zurigo e Stoccarda"
      },
      "datePublished": "2026-10-18T06:56:56+00:00",
      "dateModified": "2026-10-18T06:56:56+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/treni-zurigo-stoccarda/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-pulizie-tunnel-sciaffusa': {
    title: 'Bundesamt für Strassen chiuderà tre tunnel di notte',
    description: 'Dal 19 al 23 ottobre il Bundesamt für Strassen chiude ogni notte i tunnel Fäsenstaub, Cholfirst e Galgenbuck per lavori di pulizia, dalle 20 fino alle 5.',
    keywords: 'frontalieri, ticino, svizzera, italia, bundesamt, strassen, chiuderà, tunnel',
    ogTitle: 'Tre tunnel chiusi di notte per lavori di pulizia',
    ogDescription: 'Il Bundesamt für Strassen fermerà ogni notte i tunnel Fäsenstaub, Cholfirst e Galgenbuck per lavori di pulizia. La finestra indicata va dal 19 al 23 ottobre, con chiusura dalle 20 fino alle 5 del giorno successivo.',
    canonicalPath: '/articoli-sciaffusa/pulizie-tunnel-sciaffusa/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Bundesamt für Strassen chiuderà tre tunnel di notte",
      "description": "Dal 19 al 23 ottobre il Bundesamt für Strassen chiude ogni notte i tunnel Fäsenstaub, Cholfirst e Galgenbuck per lavori di pulizia, dalle 20 fino alle 5.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-pulizie-tunnel-sciaffusa.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Tunnel Fäsenstaub, Cholfirst e Galgenbuck chiusi di notte per lavori di pulizia"
      },
      "datePublished": "2026-10-19T12:03:42+00:00",
      "dateModified": "2026-10-19T12:03:42+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/pulizie-tunnel-sciaffusa/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-svp-sciaffusa-candidati-2027': {
    title: 'SVP Sciaffusa definisce candidati per le elezioni 2027',
    description: 'La SVP di Sciaffusa ha fissato le candidature per il 2027: Gnädinger agli Stati, Hurter e Müller al Nazionale. Voto previsto per il 24 ottobre 2027.',
    keywords: 'frontalieri, ticino, svizzera, italia, sciaffusa, definisce, candidati, elezioni',
    ogTitle: 'SVP Sciaffusa definisce candidati per le elezioni 2027',
    ogDescription: 'L\'assemblea della SVP a Oberhallau ha scelto i nomi per le elezioni del 24 ottobre 2027: Andreas Gnädinger per gli Stati e Thomas Hurter e Thomas Müller per il Nazionale.',
    canonicalPath: '/articoli-sciaffusa/svp-sciaffusa-candidati-2027/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "SVP Sciaffusa definisce candidati per le elezioni 2027",
      "description": "La SVP di Sciaffusa ha fissato le candidature per il 2027: Gnädinger agli Stati, Hurter e Müller al Nazionale. Voto previsto per il 24 ottobre 2027.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-svp-sciaffusa-candidati-2027.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-20T06:05:14+00:00",
      "dateModified": "2026-10-20T06:05:14+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/svp-sciaffusa-candidati-2027/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-beringen-vbsh-fermate-chiuse': {
    title: 'Bancomat esploso a Beringen: tre fermate VBSH non servite',
    description: 'A Beringen, dopo le esplosioni a Enge, VBSH non serve tre fermate fino alle 13:30; la Schaffhauserstrasse resta chiusa nella mattina del 19 ottobre 2026.',
    keywords: 'frontalieri, ticino, svizzera, italia, bancomat, esploso, beringen, fermate',
    ogTitle: 'Beringen: tre fermate VBSH non servite',
    ogDescription: 'Le esplosioni di un Bancomat nella Beringer Enge hanno portato alla sospensione fino alle 13:30 delle fermate VBSH Enge, Hägli e Sonne. La Schaffhauserstrasse risulta ancora chiusa nel bollettino delle 11:30 del 19 ottobre 2026.',
    canonicalPath: '/articoli-sciaffusa/beringen-vbsh-fermate-chiuse/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Bancomat esploso a Beringen: tre fermate VBSH non servite",
      "description": "A Beringen, dopo le esplosioni a Enge, VBSH non serve tre fermate fino alle 13:30; la Schaffhauserstrasse resta chiusa nella mattina del 19 ottobre 2026.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-beringen-vbsh-fermate-chiuse.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-20T06:41:00+00:00",
      "dateModified": "2026-10-20T06:41:00+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/beringen-vbsh-fermate-chiuse/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-schleitheim-scooter-incidente-2026': {
    title: 'Incidente scooter a Schleitheim: donna ferita, Hohbrugg chiusa',
    description: 'Incidente sulla Hohbrugg a Schleitheim il 18 ottobre 2026: scooterista 61enne cade 12 metri nel pendio, elitrasporto in ospedale, strada chiusa per rilievi',
    keywords: 'frontalieri, ticino, svizzera, italia, incidente, scooter, schleitheim, donna',
    ogTitle: 'Incidente scooter a Schleitheim: donna elitrasportata, Hohbrugg bloccata',
    ogDescription: 'Domenica 18 ottobre 2026 sulla Hohbrugg verso Siblingen: una 61enne perde il controllo dello scooter nella curva prima dello Zwärenbach, finisce 12 metri oltre il guardrail nel pendio. Ferite gravi, soccorsa da ambulanza ed elicottero Lions 1. Strada',
    canonicalPath: '/articoli-sciaffusa/schleitheim-scooter-incidente-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Incidente scooter a Schleitheim: donna ferita, Hohbrugg chiusa",
      "description": "Incidente sulla Hohbrugg a Schleitheim il 18 ottobre 2026: scooterista 61enne cade 12 metri nel pendio, elitrasporto in ospedale, strada chiusa per rilievi",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-schleitheim-scooter-incidente-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-20T07:10:47+00:00",
      "dateModified": "2026-10-20T07:10:47+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/schleitheim-scooter-incidente-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-parcheggi-cascate-reno': {
    title: 'Sciaffusa e Zurigo installano il sistema parcheggi al Reno',
    description: 'Nuovo sistema tra Sciaffusa e Zurigo per i parcheggi liberi alle Cascate del Reno; avvio nell\'estate 2027, costo circa CHF 400\'000.',
    keywords: 'frontalieri, ticino, svizzera, italia, sciaffusa, zurigo, installano, sistema',
    ogTitle: 'Cascate del Reno: nuovo sistema per i parcheggi',
    ogDescription: 'Alle Cascate del Reno, due grandi pannelli sull\'autostrada saranno il fulcro del sistema inter-cantonale. Le indicazioni sull\'occupazione dei parcheggi guideranno i visitatori verso il lato con posti liberi. L\'avvio è previsto nell\'estate 2027.',
    canonicalPath: '/articoli-sciaffusa/parcheggi-cascate-reno/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Sciaffusa e Zurigo installano il sistema parcheggi al Reno",
      "description": "Nuovo sistema tra Sciaffusa e Zurigo per i parcheggi liberi alle Cascate del Reno; avvio nell'estate 2027, costo circa CHF 400'000.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-parcheggi-cascate-reno.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-21T20:45:07+00:00",
      "dateModified": "2026-10-21T20:45:07+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/parcheggi-cascate-reno/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-sciaffusa-banche-riforma-federale': {
    title: 'Banche Sciaffusa: Governo respinge regole federali',
    description: 'Il Governo di Sciaffusa critica la riforma bancaria federale, chiedendo regole mirate per evitare oneri sproporzionati agli istituti locali.',
    keywords: 'frontalieri, ticino, svizzera, italia, banche, sciaffusa, governo, respinge',
    ogTitle: 'Banche Sciaffusa: Governo respinge regole federali',
    ogDescription: 'Dopo la crisi di Credit Suisse, il Consiglio federale propone nuove regole. Il Governo di Sciaffusa respinge la forma attuale per oneri sproporzionati, chiedendo criteri misurabili e basati sul rischio per gli istituti locali.',
    canonicalPath: '/articoli-sciaffusa/sciaffusa-banche-riforma-federale/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Banche Sciaffusa: Governo respinge regole federali",
      "description": "Il Governo di Sciaffusa critica la riforma bancaria federale, chiedendo regole mirate per evitare oneri sproporzionati agli istituti locali.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-sciaffusa-banche-riforma-federale.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-22T01:01:24+00:00",
      "dateModified": "2026-10-22T01:01:24+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/sciaffusa-banche-riforma-federale/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-neunkirch-supervisore-cantonale': {
    title: 'Neunkirch accetta il supervisore cantonale | Frontaliere Ticino',
    description: 'Il Cantone di Sciaffusa invia Stephan Rawyler a Neunkirch: istruzioni, sedute comunali, rapporto d\'inchiesta e possibili nuove misure.',
    keywords: 'frontalieri, ticino, svizzera, italia, neunkirch, accetta, supervisore, cantonale',
    ogTitle: 'Neunkirch e la supervisione cantonale',
    ogDescription: 'Dopo diverse segnalazioni di vigilanza, il Cantone ha rilevato carenze nel Comune di Neunkirch. L\'inviato Stephan Rawyler potrà impartire istruzioni, assistere alle sedute e alle assemblee, quindi presentare un rapporto al Governo.',
    canonicalPath: '/articoli-sciaffusa/neunkirch-supervisore-cantonale/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Neunkirch accetta il supervisore cantonale",
      "description": "Il Cantone di Sciaffusa invia Stephan Rawyler a Neunkirch: istruzioni, sedute comunali, rapporto d'inchiesta e possibili nuove misure.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-neunkirch-supervisore-cantonale.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-22T02:31:34+00:00",
      "dateModified": "2026-10-22T02:31:34+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/neunkirch-supervisore-cantonale/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-nuova-app-schaffhauser-nachrichten-2026': {
    title: 'Schaffhauser Nachrichten: lanciata la nuova app nel 2026',
    description: 'Scopra le novità della nuova app Schaffhauser Nachrichten lanciata il 21 ottobre 2026: più contenuti, notifiche tematiche e aggiornamento automatico.',
    keywords: 'frontalieri, ticino, svizzera, italia, schaffhauser, nachrichten, lanciata, nuova',
    ogTitle: 'Schaffhauser Nachrichten: rollout della nuova app 2026',
    ogDescription: 'Il 21 ottobre 2026 è stata lanciata la nuova app delle Schaffhauser Nachrichten. Scopri come gestire le notifiche push per temi e l\'aggiornamento automatico per restare informati sui fatti del Canton Sciaffusa.',
    canonicalPath: '/articoli-sciaffusa/nuova-app-schaffhauser-nachrichten-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Schaffhauser Nachrichten: lanciata la nuova app nel 2026",
      "description": "Scopra le novità della nuova app Schaffhauser Nachrichten lanciata il 21 ottobre 2026: più contenuti, notifiche tematiche e aggiornamento automatico.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-nuova-app-schaffhauser-nachrichten-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-22T03:16:50+00:00",
      "dateModified": "2026-10-22T03:16:50+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/nuova-app-schaffhauser-nachrichten-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-sciaffusa-regole-datencenter-beringen': {
    title: 'Sciaffusa inasprisce regole datacenter | Frontaliere Ticino',
    description: 'Il Canton Sciaffusa inasprisce le normative per i datacenter. Citato il progetto di Stack a Beringen e la gestione del calore residuo.',
    keywords: 'frontalieri, ticino, svizzera, italia, sciaffusa, inasprisce, regole, datacenter',
    ogTitle: 'Sciaffusa: inasprimento regole datacenter',
    ogDescription: 'Il Canton Sciaffusa pianifica regole più severe per i datacenter. Il nuovo impianto di Stack a Beringen è al centro della notizia, con focus sulla produzione di calore residuo.',
    canonicalPath: '/articoli-sciaffusa/sciaffusa-regole-datencenter-beringen/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Sciaffusa inasprisce regole datacenter",
      "description": "Il Canton Sciaffusa inasprisce le normative per i datacenter. Citato il progetto di Stack a Beringen e la gestione del calore residuo.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-sciaffusa-regole-datencenter-beringen.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-23T01:48:34+00:00",
      "dateModified": "2026-10-23T01:48:34+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/sciaffusa-regole-datencenter-beringen/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-sciaffusa-regole-datacenter': {
    title: 'Sciaffusa: proposta su elettricità, acqua e data center',
    description: 'A Sciaffusa una proposta prevede prelievi su elettricità e acqua per le imprese ad alto consumo; il Governo cantonale la sostiene.',
    keywords: 'frontalieri, ticino, svizzera, italia, sciaffusa, proposta, elettricità, acqua',
    ogTitle: 'Sciaffusa: regole su acqua ed elettricità per data center',
    ogDescription: 'Sciaffusa propone prelievi sui consumi di elettricità e acqua: il primo alimenterebbe il fondo energia e clima, il secondo si aggiungerebbe oltre una certa misura. Il Governo ha deciso requisiti più severi per i data center pianificati.',
    canonicalPath: '/articoli-sciaffusa/sciaffusa-regole-datacenter/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Sciaffusa: proposta su elettricità, acqua e data center",
      "description": "A Sciaffusa una proposta prevede prelievi su elettricità e acqua per le imprese ad alto consumo; il Governo cantonale la sostiene.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-sciaffusa-regole-datacenter.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-23T03:48:32+00:00",
      "dateModified": "2026-10-23T03:48:32+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/sciaffusa-regole-datacenter/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-coop-aumento-salari-2027': {
    title: 'Coop: aumento salari 2027 per dipendenti sotto i 4.900 franchi',
    description: 'Coop e partner sociali concordano aumento salariale di almeno l\'1,1% per i dipendenti con stipendi fino a 4.900 franchi mensili nel 2027.',
    keywords: 'frontalieri, ticino, svizzera, italia, coop, aumento, salari, dipendenti',
    ogTitle: 'Coop: aumento salari 2027 per chi dipendenti sotto i 4.900 CHF',
    ogDescription: 'Nel 2027, i dipendenti Coop con stipendi fino a 4.900 franchi mensili riceveranno un aumento generale di almeno l\'1,1% per mantenere il potere d\'acquisto.',
    canonicalPath: '/articoli-sciaffusa/coop-aumento-salari-2027/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Coop: aumento salari 2027 per dipendenti sotto i 4.900 franchi",
      "description": "Coop e partner sociali concordano aumento salariale di almeno l'1,1% per i dipendenti con stipendi fino a 4.900 franchi mensili nel 2027.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-coop-aumento-salari-2027.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-23T12:36:39+00:00",
      "dateModified": "2026-10-23T12:36:39+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/coop-aumento-salari-2027/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

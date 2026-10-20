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

};

export default CANTON_SEO_METADATA;

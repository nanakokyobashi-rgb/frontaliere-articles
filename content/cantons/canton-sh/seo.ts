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
        "url": `${BASE_URL}/images/blog/article-canton-san-gallo-stabile-ricerca-lavoro-cala-disoccupazione.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Scena simbolica sul mercato del lavoro nel Canton Sciaffusa"
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

};

export default CANTON_SEO_METADATA;

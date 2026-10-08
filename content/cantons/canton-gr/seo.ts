// Metadati SEO degli articoli della sezione canton-gr (Grigioni).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-strada-calanca-chiusura-preventiva': {
    title: 'Strada della Calanca: chiusura totale tra Molina e Arvigo',
    description: 'Chiusura totale da mercoledì alle 21',
    keywords: 'frontalieri, ticino, svizzera, italia, strada, calanca, chiusura, totale',
    ogTitle: 'Strada della Calanca: chiusura totale tra Molina e Arvigo',
    ogDescription: 'Chiusura totale da mercoledì alle 21',
    canonicalPath: '/articoli-grigioni/strada-calanca-chiusura-preventiva/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Strada della Calanca: chiusura totale tra Molina e Arvigo",
      "description": "Chiusura totale da mercoledì alle 21",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-strada-calanca-chiusura-preventiva.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Strada della Calanca chiusa per maltempo tra Molina Nord e Arvigo."
      },
      "datePublished": "2026-10-07T06:43:54+00:00",
      "dateModified": "2026-10-07T06:43:54+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/strada-calanca-chiusura-preventiva/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-benzina-grigioni-deviazione': {
    title: 'Prezzi benzina in Grigioni: quando conviene deviare',
    description: 'In Grigioni, prezzi della benzina a livelli record: il calcolatore mostra quando il risparmio giustifica una deviazione verso una stazione più economica.',
    keywords: 'frontalieri, ticino, svizzera, italia, prezzi, benzina, grigioni, quando',
    ogTitle: 'Calcolatore benzina in Grigioni: prezzo e deviazione',
    ogDescription: 'L\'articolo di Julian Reich del 5 ottobre 2026 presenta il calcolatore grigionese per valutare il rifornimento presso una stazione più economica: il prezzo da raggiungere e la distanza della deviazione sono i due elementi da confrontare.',
    canonicalPath: '/articoli-grigioni/benzina-grigioni-deviazione/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Prezzi benzina in Grigioni: quando conviene deviare",
      "description": "In Grigioni, prezzi della benzina a livelli record: il calcolatore mostra quando il risparmio giustifica una deviazione verso una stazione più economica.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/benzina-diesel-prezzi-calano.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Auto davanti a un distributore lungo una strada dei Grigioni"
      },
      "datePublished": "2026-10-07T06:53:48+00:00",
      "dateModified": "2026-10-07T06:53:48+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/benzina-grigioni-deviazione/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-lavoro-grigioni-settembre-2026': {
    title: 'Disoccupazione nei Grigioni: 1,1% a settembre 2026',
    description: 'A settembre 2026 i Grigioni hanno registrato 1.237 disoccupati, pari all\'1,1%. Le persone in cerca di lavoro sono 2.267, contro 2.180 nel mese precedente.',
    keywords: 'frontalieri, ticino, svizzera, italia, disoccupazione, grigioni, settembre, hanno',
    ogTitle: 'Disoccupazione nei Grigioni: 1,1% a settembre 2026',
    ogDescription: 'Il comunicato del 6 ottobre 2026 fotografa il mercato del lavoro dei Grigioni: 1.237 disoccupati, 1.030 persone in cerca di lavoro non disoccupate e 2.267 cercatori complessivi. L\'Amt für Industrie, Gewerbe und Arbeit pubblica la statistica',
    canonicalPath: '/articoli-grigioni/lavoro-grigioni-settembre-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Disoccupazione nei Grigioni: 1,1% a settembre 2026",
      "description": "A settembre 2026 i Grigioni hanno registrato 1.237 disoccupati, pari all'1,1%. Le persone in cerca di lavoro sono 2.267, contro 2.180 nel mese precedente.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-lavoro-grigioni-settembre-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Paesaggio alpino dei Grigioni vicino a un centro regionale per l'impiego"
      },
      "datePublished": "2026-10-08T08:16:34+00:00",
      "dateModified": "2026-10-08T08:16:34+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/lavoro-grigioni-settembre-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-grigioni-valanghe-scuola-rossa-roveredo': {
    title: 'Grigioni: fondi per valanghe a Rossa e aula a Roveredo',
    description: 'Il governo retico ha approvato 265\'650 franchi per Pighé.',
    keywords: 'frontalieri, ticino, svizzera, italia, grigioni, fondi, valanghe, rossa',
    ogTitle: 'Grigioni: fondi per valanghe a Rossa e aula a Roveredo',
    ogDescription: 'Il governo retico ha approvato 265\'650 franchi per Pighé.',
    canonicalPath: '/articoli-grigioni/grigioni-valanghe-scuola-rossa-roveredo/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Grigioni: fondi per valanghe a Rossa e aula a Roveredo",
      "description": "Il governo retico ha approvato 265'650 franchi per Pighé.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-grigioni-valanghe-scuola-rossa-roveredo.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Strutture antivalanga a Pighé, Rossa, e un'aula nel bosco a Roveredo, Canton Grigioni."
      },
      "datePublished": "2026-10-08T08:38:47+00:00",
      "dateModified": "2026-10-08T08:38:47+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/grigioni-valanghe-scuola-rossa-roveredo/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

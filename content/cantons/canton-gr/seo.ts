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
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-benzina-grigioni-deviazione.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
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

  'blog-code-domenicali-landquart': {
    title: 'Code domenicali al Fashion Outlet di Landquart',
    description: 'A Landquart le code si formano regolarmente la domenica all\'uscita autostradale: la fonte esamina il ruolo del Fashion Outlet e le misure contro il traffico.',
    keywords: 'frontalieri, ticino, svizzera, italia, code, domenicali, fashion, outlet',
    ogTitle: 'Code domenicali al Fashion Outlet di Landquart',
    ogDescription: 'La domenica l\'uscita autostradale di Landquart è interessata regolarmente da code. Il materiale pubblico pone al centro due domande: quanto incide il Fashion Outlet e quali interventi vengono considerati per il traffico.',
    canonicalPath: '/articoli-grigioni/code-domenicali-landquart/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Code domenicali al Fashion Outlet di Landquart",
      "description": "A Landquart le code si formano regolarmente la domenica all'uscita autostradale: la fonte esamina il ruolo del Fashion Outlet e le misure contro il traffico.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-code-domenicali-landquart.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Code domenicali all'uscita autostradale vicino al Fashion Outlet di Landquart"
      },
      "datePublished": "2026-10-09T11:20:41+00:00",
      "dateModified": "2026-10-09T11:20:41+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/code-domenicali-landquart/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-flaesch-strada-sentieri-chiusi': {
    title: 'Fläsch chiude strada, sentieri e area d\'arrampicata',
    description: 'Sopra Fläsch una possibile caduta di roccia porta alla chiusura precauzionale di strada, sentieri e palestra d\'arrampicata. Gli esperti valutano le misure.',
    keywords: 'frontalieri, ticino, svizzera, italia, fläsch, chiude, strada, sentieri',
    ogTitle: 'Rischio di roccia sopra Fläsch: chiusure precauzionali',
    ogDescription: 'Una possibile caduta di roccia minaccia l\'area sopra Fläsch: il Comune chiude strada, sentieri escursionistici e palestra d\'arrampicata. Gli esperti stanno valutando le misure, mentre la notizia segnala un impatto finanziario favorevole per l\'ente.',
    canonicalPath: '/articoli-grigioni/flaesch-strada-sentieri-chiusi/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Fläsch chiude strada, sentieri e area d'arrampicata",
      "description": "Sopra Fläsch una possibile caduta di roccia porta alla chiusura precauzionale di strada, sentieri e palestra d'arrampicata. Gli esperti valutano le misure.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-flaesch-strada-sentieri-chiusi.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-09T11:33:58+00:00",
      "dateModified": "2026-10-09T11:33:58+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/flaesch-strada-sentieri-chiusi/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-parco-solare-nalps-tujetsch': {
    title: 'Avanza il progetto del parco solare alpino di Nalps',
    description: 'Il progetto del parco solare alpino di Nalps a Tujetsch sta facendo progressi. Scopri i dettagli del servizio di Telesguard trasmesso su Play RTR.',
    keywords: 'frontalieri, ticino, svizzera, italia, avanza, progetto, parco, solare',
    ogTitle: 'Avanza il progetto del parco solare alpino di Nalps',
    ogDescription: 'Il progetto per un parco solare alpino a Nalps, nella località di Tujetsch, sta facendo progressi. Il servizio completo è disponibile tramite il programma Telesguard su Play RTR.',
    canonicalPath: '/articoli-grigioni/parco-solare-nalps-tujetsch/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Avanza il progetto del parco solare alpino di Nalps",
      "description": "Il progetto del parco solare alpino di Nalps a Tujetsch sta facendo progressi. Scopri i dettagli del servizio di Telesguard trasmesso su Play RTR.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-parco-solare-nalps-tujetsch.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Paesaggio alpino della regione di Tujetsch nel Canton Grigioni"
      },
      "datePublished": "2026-10-10T18:34:27+00:00",
      "dateModified": "2026-10-10T18:34:27+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/parco-solare-nalps-tujetsch/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

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

  'blog-lido-grono-estate-2027': {
    title: 'Lido Grono, apertura confermata per l\'estate 2027',
    description: 'Apertura del Lido Grono confermata per l\'estate 2027 Cantiere della nuova piscina comunale ancora in corso Costi previsti: circa 5 milioni Annuncio del sindaco',
    keywords: 'frontalieri, ticino, svizzera, italia, lido, grono, apertura, confermata',
    ogTitle: 'Lido Grono: apertura confermata nell\'estate 2027',
    ogDescription: 'Apertura del Lido Grono confermata per l\'estate 2027 Cantiere della nuova piscina comunale ancora in corso Costi previsti: circa 5 milioni Annuncio del sindaco',
    canonicalPath: '/articoli-grigioni/lido-grono-estate-2027/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Lido Grono, apertura confermata per l'estate 2027",
      "description": "Apertura del Lido Grono confermata per l'estate 2027 Cantiere della nuova piscina comunale ancora in corso Costi previsti: circa 5 milioni Annuncio del sindaco",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-lido-grono-estate-2027.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Cantiere della nuova piscina comunale di Grono per l'apertura confermata nell'estate 2027."
      },
      "datePublished": "2026-10-10T18:56:18+00:00",
      "dateModified": "2026-10-10T18:56:18+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/lido-grono-estate-2027/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-acqua-domleschg-feldis-scheid': {
    title: 'Domleschg: camion cisterna per l\'acqua a Feldis e Scheid',
    description: 'Domleschg intende portare acqua potabile a Feldis e Scheid. La carenza idrica è segnalata già da giugno. A Feldis il problema potrebbe presentarsi a inizio',
    keywords: 'frontalieri, ticino, svizzera, italia, domleschg, camion, cisterna, acqua',
    ogTitle: 'Domleschg: camion cisterna per l\'acqua a Feldis e Scheid',
    ogDescription: 'Domleschg intende portare acqua potabile a Feldis e Scheid.',
    canonicalPath: '/articoli-grigioni/acqua-domleschg-feldis-scheid/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Domleschg: camion cisterna per l'acqua a Feldis e Scheid",
      "description": "Domleschg intende portare acqua potabile a Feldis e Scheid. La carenza idrica è segnalata già da giugno. A Feldis il problema potrebbe presentarsi a inizio",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-acqua-domleschg-feldis-scheid.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-20T10:34:42+00:00",
      "dateModified": "2026-10-20T10:34:42+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/acqua-domleschg-feldis-scheid/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-sconti-vereina-locali-ospiti': {
    title: 'Vereina: il parlamento chiede di valutare sconti',
    description: 'Il parlamento cantonale dei Grigioni chiede di esaminare prezzi ridotti al Vereina per i residenti. Beneficiari e data restano aperti.',
    keywords: 'frontalieri, ticino, svizzera, italia, vereina, parlamento, chiede, valutare',
    ogTitle: 'Vereina: il parlamento chiede di valutare sconti',
    ogDescription: 'Il parlamento cantonale dei Grigioni ha dato al governo un mandato per esaminare riduzioni di prezzo per i viaggi attraverso l\'Autoverlad Vereina. La fonte non indica ancora chi beneficerà della misura né da quando.',
    canonicalPath: '/articoli-grigioni/sconti-vereina-locali-ospiti/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Vereina: il parlamento chiede di valutare sconti",
      "description": "Il parlamento cantonale dei Grigioni chiede di esaminare prezzi ridotti al Vereina per i residenti. Beneficiari e data restano aperti.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-sconti-vereina-locali-ospiti.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-21T03:29:46+00:00",
      "dateModified": "2026-10-21T03:29:46+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/sconti-vereina-locali-ospiti/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-a13-code-grigioni-vacanze-zurighesi': {
    title: 'A13: code tra Rothenbrunnen e Reichenau per vacanze zurighesi',
    description: 'Il traffico sulla A13 in Grigioni ha visto code quotidiane tra Rothenbrunnen e Reichenau, con il tunnel Isla-Bella come collo di bottiglia',
    keywords: 'frontalieri, ticino, svizzera, italia, code, rothenbrunnen, reichenau, vacanze',
    ogTitle: 'A13 Grigioni: code tra Rothenbrunnen e Reichenau, Isla-Bella',
    ogDescription: 'Il fine settimana ha registrato un significativo accumulo di traffico sulla A13 in Grigioni, con code quotidiane tra Rothenbrunnen e Reichenau. Il tunnel Isla-Bella è stato identificato come il principale collo di bottiglia, un fenomeno legato',
    canonicalPath: '/articoli-grigioni/a13-code-grigioni-vacanze-zurighesi/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "A13: code tra Rothenbrunnen e Reichenau per vacanze zurighesi",
      "description": "Il traffico sulla A13 in Grigioni ha visto code quotidiane tra Rothenbrunnen e Reichenau, con il tunnel Isla-Bella come collo di bottiglia",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-a13-code-grigioni-vacanze-zurighesi.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-21T04:02:54+00:00",
      "dateModified": "2026-10-21T04:02:54+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/a13-code-grigioni-vacanze-zurighesi/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-rhb-albula-chiusura-thusis-preda': {
    title: 'RhB chiude la linea dell\'Albula tra Thusis e Preda',
    description: 'La RhB chiude al traffico ferroviario la linea dell\'Albula tra Thusis e Preda dal 29 ottobre al 13 novembre per lavori di costruzione.',
    keywords: 'frontalieri, ticino, svizzera, italia, chiude, linea, dell, albula',
    ogTitle: 'RhB chiude la linea dell\'Albula tra Thusis e Preda',
    ogDescription: 'Dal 29 ottobre al 13 novembre la Rhätische Bahn sospende il traffico ferroviario sulla tratta dell\'Albula compresa tra Thusis e Preda. La fonte indica come motivo i lavori di costruzione, senza dettagli su servizi sostitutivi.',
    canonicalPath: '/articoli-grigioni/rhb-albula-chiusura-thusis-preda/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "RhB chiude la linea dell'Albula tra Thusis e Preda",
      "description": "La RhB chiude al traffico ferroviario la linea dell'Albula tra Thusis e Preda dal 29 ottobre al 13 novembre per lavori di costruzione.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-rhb-albula-chiusura-thusis-preda.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-23T12:26:06+00:00",
      "dateModified": "2026-10-23T12:26:06+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/rhb-albula-chiusura-thusis-preda/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-cuira-alloggi-acqua-sursaissa': {
    title: 'Cuira: voto su alloggi accessibili e controproposta',
    description: 'A Cuira si vota il 29 novembre su alloggi accessibili e controproposta; Sursaissa Mundaun invita a risparmiare acqua in vista dell\'inverno.',
    keywords: 'frontalieri, ticino, svizzera, italia, cuira, voto, alloggi, accessibili',
    ogTitle: 'Cuira: voto su alloggi accessibili e controproposta',
    ogDescription: 'Il magazine del 26 ottobre 2026 presenta due notizie locali: a Cuira un\'iniziativa lanciata nel 2024 sarà votata insieme a una controproposta; a Sursaissa Mundaun il comune invita a risparmiare acqua, anche in vista dell\'inverno.',
    canonicalPath: '/articoli-grigioni/cuira-alloggi-acqua-sursaissa/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Cuira: voto su alloggi accessibili e controproposta",
      "description": "A Cuira si vota il 29 novembre su alloggi accessibili e controproposta; Sursaissa Mundaun invita a risparmiare acqua in vista dell'inverno.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-cuira-alloggi-acqua-sursaissa.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-27T02:19:08+00:00",
      "dateModified": "2026-10-27T02:19:08+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/cuira-alloggi-acqua-sursaissa/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-cantiere-caraa-guera-interrogazione': {
    title: 'Interrogazione Cantiere Caraa de Guèra: chiarezza su lavori e costi',
    description: 'Cantiere sulla Caraa de Guèra, tra Maron e Ai Tecc Rifacimento di reti e posa di acciottolato di fiume Sette domande al Municipio su approvazioni',
    keywords: 'frontalieri, ticino, svizzera, italia, interrogazione, cantiere, caraa, guèra',
    ogTitle: 'Cantiere Caraa de Guèra: chiarezza su lavori e costi',
    ogDescription: 'Cantiere sulla Caraa de Guèra, tra Maron e Ai Tecc Rifacimento di reti e posa di acciottolato di fiume Sette domande al Municipio su approvazioni e costi',
    canonicalPath: '/articoli-grigioni/cantiere-caraa-guera-interrogazione/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Interrogazione Cantiere Caraa de Guèra: chiarezza su lavori e costi",
      "description": "Cantiere sulla Caraa de Guèra, tra Maron e Ai Tecc Rifacimento di reti e posa di acciottolato di fiume Sette domande al Municipio su approvazioni",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-cantiere-caraa-guera-interrogazione.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-27T07:03:29+00:00",
      "dateModified": "2026-10-27T07:03:29+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/cantiere-caraa-guera-interrogazione/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-val-calanca-strada-chiusa': {
    title: 'Val Calanca: chiusura strada per due settimane, chiede sostegno per isolamento',
    description: 'Val Calanca: strada chiusa per due settimane dopo smottamenti Censi chiede strumenti permanenti al governo retico Fondo ipotizzato dal terzo giorno',
    keywords: 'frontalieri, ticino, svizzera, italia, calanca, chiusura, strada, settimane',
    ogTitle: 'Val Calanca: chiusura strada e richiesta sostegno',
    ogDescription: 'Val Calanca: strada chiusa per due settimane dopo smottamenti Censi chiede strumenti permanenti al governo retico Fondo ipotizzato dal terzo giorno',
    canonicalPath: '/articoli-grigioni/val-calanca-strada-chiusa/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Val Calanca: chiusura strada per due settimane, chiede sostegno per isolamento",
      "description": "Val Calanca: strada chiusa per due settimane dopo smottamenti Censi chiede strumenti permanenti al governo retico Fondo ipotizzato dal terzo giorno",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-val-calanca-strada-chiusa.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-27T08:27:00+00:00",
      "dateModified": "2026-10-27T08:27:00+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/val-calanca-strada-chiusa/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-brigels-sette-milioni-impianti': {
    title: 'Brigels approva 7 milioni di CHF per risanare gli impianti',
    description: 'Brigels approva 7 milioni di CHF per risanare gli impianti di risalita: il sostegno punta a garantire l\'operatività e la manutenzione.',
    keywords: 'frontalieri, ticino, svizzera, italia, brigels, approva, milioni, risanare',
    ogTitle: 'Brigels approva 7 milioni di CHF per risanare gli impianti',
    ogDescription: 'Dopo il sì, gli impianti di risalita di Brigels ricevono un sostegno di 7 milioni di CHF per il risanamento. La fonte indica due obiettivi: garantire l\'operatività e mantenere le strutture esistenti. Calendario e ripartizione non sono indicati.',
    canonicalPath: '/articoli-grigioni/brigels-sette-milioni-impianti/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Brigels approva 7 milioni di CHF per risanare gli impianti",
      "description": "Brigels approva 7 milioni di CHF per risanare gli impianti di risalita: il sostegno punta a garantire l'operatività e la manutenzione.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-brigels-sette-milioni-impianti.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-27T09:37:54+00:00",
      "dateModified": "2026-10-27T09:37:54+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/brigels-sette-milioni-impianti/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-bus-sostitutivi-grigioni': {
    title: 'Bus sostitutivi RhB tra Thusis e Preda per un cantiere',
    description: 'La fonte segnala bus sostitutivi tra Thusis e Preda a causa di un cantiere RhB; il Verkehrsticker segue lo stato delle vie di traffico grigionesi.',
    keywords: 'frontalieri, ticino, svizzera, italia, sostitutivi, thusis, preda, cantiere',
    ogTitle: 'Cantiere RhB, bus sostitutivi tra Thusis e Preda',
    ogDescription: 'La fonte segnala bus sostitutivi tra Thusis e Preda a causa di un cantiere della RhB. Il Verkehrsticker segue le condizioni delle vie di traffico grigionesi e cita ingorghi, frane e altri eventi speciali.',
    canonicalPath: '/articoli-grigioni/bus-sostitutivi-grigioni/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Bus sostitutivi RhB tra Thusis e Preda per un cantiere",
      "description": "La fonte segnala bus sostitutivi tra Thusis e Preda a causa di un cantiere RhB; il Verkehrsticker segue lo stato delle vie di traffico grigionesi.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-bus-sostitutivi-grigioni.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-29T15:42:15+00:00",
      "dateModified": "2026-10-29T15:42:15+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-grigioni/bus-sostitutivi-grigioni/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

// Metadati SEO degli articoli della sezione canton-ur (Uri).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-uri-misure-energia-clima': {
    title: 'Canton Uri punta sulle misure energetiche per il clima',
    description: 'Il Canton Uri punta sulle misure energetiche per la protezione del clima: il titolo della notizia indica l\'orientamento, senza dettagli operativi.',
    keywords: 'frontalieri, ticino, svizzera, italia, canton, punta, sulle, misure',
    ogTitle: 'Canton Uri: misure energetiche per il clima',
    ogDescription: 'Il Canton Uri lega la protezione del clima alle misure energetiche. La notizia identifica questo orientamento territoriale, ma il materiale disponibile non consente di ricavare interventi, cifre, date o procedure per residenti e lavoratori.',
    canonicalPath: '/articoli-uri/uri-misure-energia-clima/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Canton Uri punta sulle misure energetiche per il clima",
      "description": "Il Canton Uri punta sulle misure energetiche per la protezione del clima: il titolo della notizia indica l'orientamento, senza dettagli operativi.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-uri-misure-energia-clima.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Paesaggio del Canton Uri associato alle misure energetiche per la protezione del clima"
      },
      "datePublished": "2026-10-07T09:07:12+00:00",
      "dateModified": "2026-10-07T09:07:12+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-uri/uri-misure-energia-clima/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-uri-chiusura-passhoehe': {
    title: 'Passhöhe-Urnerboden: chiusura notturna della strada',
    description: 'Tra martedì 14 e mercoledì 15 ottobre la strada cantonale tra Passhöhe e Urnerboden sarà chiusa di notte per la posa della pavimentazione. Con maltempo, rinvio.',
    keywords: 'frontalieri, ticino, svizzera, italia, passhöhe-urnerboden, chiusura, notturna, strada',
    ogTitle: 'Passhöhe-Urnerboden, chiusura notturna',
    ogDescription: 'Il tratto della strada cantonale tra Passhöhe e Urnerboden viene chiuso nelle ore notturne tra il 14 e il 15 ottobre per la posa della pavimentazione. Se arriva il maltempo, i lavori saranno rinviati.',
    canonicalPath: '/articoli-uri/uri-chiusura-passhoehe/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Passhöhe-Urnerboden: chiusura notturna della strada",
      "description": "Tra martedì 14 e mercoledì 15 ottobre la strada cantonale tra Passhöhe e Urnerboden sarà chiusa di notte per la posa della pavimentazione. Con maltempo, rinvio.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-strada-calanca-chiusura-preventiva.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Strada cantonale tra Passhöhe e Urnerboden durante i lavori di posa della pavimentazione"
      },
      "datePublished": "2026-10-08T23:39:16+00:00",
      "dateModified": "2026-10-08T23:39:16+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-uri/uri-chiusura-passhoehe/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

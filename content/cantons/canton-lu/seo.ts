// Metadati SEO degli articoli della sezione canton-lu (Lucerna).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-lucerna-salute-mentale-banchi': {
    title: 'Lucerna: giornata sulla salute mentale il 10 ottobre',
    description: '## In breve - 10 ottobre 2026: giornata cantonale a Lucerna - Dalle 10 alle 16 alla Matthäuskirche nella città vecchia - Ingresso libero e senza prenotazione',
    keywords: 'frontalieri, ticino, svizzera, italia, lucerna, giornata, sulla, salute',
    ogTitle: 'Salute mentale: evento gratuito a Lucerna il 10 ottobre',
    ogDescription: '## In breve - 10 ottobre 2026: giornata cantonale a Lucerna - Dalle 10 alle 16 alla Matthäuskirche nella città vecchia - Ingresso libero e senza prenotazione',
    canonicalPath: '/articoli-lucerna/lucerna-salute-mentale-banchi/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Lucerna: giornata sulla salute mentale il 10 ottobre",
      "description": "## In breve - 10 ottobre 2026: giornata cantonale a Lucerna - Dalle 10 alle 16 alla Matthäuskirche nella città vecchia - Ingresso libero e senza prenotazione",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-lucerna-salute-mentale-banchi.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Banchine per conversazioni sulla salute mentale davanti alla Matthäuskirche di Lucerna"
      },
      "datePublished": "2026-10-07T17:52:11+00:00",
      "dateModified": "2026-10-07T17:52:11+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-lucerna/lucerna-salute-mentale-banchi/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },
};

export default CANTON_SEO_METADATA;

// Metadati SEO degli articoli della sezione canton-gl (Glarona).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-revisione-fiscale-canton-glarona': {
    title: 'Glarona: dieci anni per compensare le perdite fiscali',
    description: 'Il Governo cantonale di Glarona ha approvato una revisione della legge fiscale che estende a dieci anni la compensazione delle perdite, divide a metà',
    keywords: 'frontalieri, ticino, svizzera, italia, glarona, dieci, anni, compensare',
    ogTitle: 'Glarona: dieci anni per compensare le perdite fiscali',
    ogDescription: 'Il 29 settembre 2026 il Governo di Glarona ha adottato una proposta di modifica della legge fiscale da sottoporre alla Landsgemeinde. La revisione aumenta da sette a dieci anni il periodo di compensazione delle perdite fiscali (valido dal periodo',
    canonicalPath: '/articoli-glarona/revisione-fiscale-canton-glarona/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Glarona: dieci anni per compensare le perdite fiscali",
      "description": "Il Governo cantonale di Glarona ha approvato una revisione della legge fiscale che estende a dieci anni la compensazione delle perdite, divide a metà",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-revisione-fiscale-canton-glarona.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Vista delle Alpi della Glarona con documento di modifica della legge fiscale su tavolo"
      },
      "datePublished": "2026-10-07T08:45:21+00:00",
      "dateModified": "2026-10-07T08:45:21+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-glarona/revisione-fiscale-canton-glarona/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-premi-standard-glarona': {
    title: 'Glarona: di nuovo i premi standard più bassi | Frontaliere Ticino',
    description: 'La Glarner Krankenversicherung torna ai premi standard più bassi. In passato, lo stesso primato aveva portato la cassa in serie difficoltà. Dati aggiornati 2026',
    keywords: 'frontalieri, ticino, svizzera, italia, glarona, nuovo, premi, standard',
    ogTitle: 'Glarona: di nuovo i premi standard più bassi',
    ogDescription: 'La Glarner Krankenversicherung torna ai premi standard più bassi. Lo stesso risultato si era già verificato e aveva portato la cassa in serie difficoltà. La fonte segnala però una differenza importante questa volta.',
    canonicalPath: '/articoli-glarona/premi-standard-glarona/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Glarona: di nuovo i premi standard più bassi",
      "description": "La Glarner Krankenversicherung torna ai premi standard più bassi. In passato, lo stesso primato aveva portato la cassa in serie difficoltà. Dati aggiornati 2026",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-premi-standard-glarona.webp`,
        "width": 1200,
        "height": 675,
        "caption": "La Glarner Krankenversicherung torna ad avere i premi standard più bassi"
      },
      "datePublished": "2026-10-08T13:30:13+00:00",
      "dateModified": "2026-10-08T13:30:13+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-glarona/premi-standard-glarona/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

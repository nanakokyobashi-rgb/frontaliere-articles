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
        "url": `${BASE_URL}/images/blog/asilo-nido-custodia-bambini-canton-glarona.webp`,
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
};

export default CANTON_SEO_METADATA;

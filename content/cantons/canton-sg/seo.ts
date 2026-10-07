// Metadati SEO degli articoli della sezione canton-sg (San Gallo).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-canton-san-gallo-stabile-ricerca-lavoro-cala-disoccupazione': {
    title: 'Canton San Gallo: stabile ricerca lavoro, cala disoccupazione',
    description: '## In breve - 11\'251 persone cercavano lavoro a fine settembre - 5\'768 erano disoccupate - 3\'955 posti vacanti risultavano segnalati - 754 dipendenti erano',
    keywords: 'frontalieri, ticino, svizzera, italia, canton, gallo, stabile, ricerca',
    ogTitle: 'Canton San Gallo: stabile ricerca lavoro, cala',
    ogDescription: '## In breve - 11\'251 persone cercavano lavoro a fine settembre - 5\'768 erano disoccupate - 3\'955 posti vacanti risultavano segnalati - 754 dipendenti erano',
    canonicalPath: '/articoli-san-gallo/canton-san-gallo-stabile-ricerca-lavoro-cala-disoccupazione/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Canton San Gallo: stabile ricerca lavoro, cala disoccupazione",
      "description": "## In breve - 11'251 persone cercavano lavoro a fine settembre - 5'768 erano disoccupate - 3'955 posti vacanti risultavano segnalati - 754 dipendenti erano",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/mercato-lavoro-canton-grigioni.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine editoriale relativa a: Canton San Gallo: stabile ricerca lavoro, cala disoccupazione"
      },
      "datePublished": "2026-10-07T10:15:11+00:00",
      "dateModified": "2026-10-07T10:15:11+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-san-gallo/canton-san-gallo-stabile-ricerca-lavoro-cala-disoccupazione/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },
};

export default CANTON_SEO_METADATA;

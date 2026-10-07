// Metadati SEO degli articoli della sezione canton-vs (Vallese).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-disoccupazione-vallese-fine-estate': {
    title: 'Disoccupazione Vallese: 5’755 iscritti a settembre 2026',
    description: '## In breve - 5’755 disoccupati iscritti agli ORP a fine settembre - Tasso cantonale stabile al 3,1% - Fine stagione estiva: +76 disoccupati in alberghi',
    keywords: 'frontalieri, ticino, svizzera, italia, disoccupazione, vallese, iscritti, settembre',
    ogTitle: 'Vallese: disoccupazione al 3,1% a settembre',
    ogDescription: '## In breve - 5’755 disoccupati iscritti agli ORP a fine settembre - Tasso cantonale stabile al 3,1% - Fine stagione estiva: +76 disoccupati in alberghi',
    canonicalPath: '/articoli-vallese/disoccupazione-vallese-fine-estate/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Disoccupazione Vallese: 5’755 iscritti a settembre 2026",
      "description": "## In breve - 5’755 disoccupati iscritti agli ORP a fine settembre - Tasso cantonale stabile al 3,1% - Fine stagione estiva: +76 disoccupati in alberghi",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/disoccupazione-settembre-ticino-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Paesaggio alpino del Vallese con un ufficio regionale di collocamento"
      },
      "datePublished": "2026-10-07T08:50:45+00:00",
      "dateModified": "2026-10-07T08:50:45+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-vallese/disoccupazione-vallese-fine-estate/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },
};

export default CANTON_SEO_METADATA;

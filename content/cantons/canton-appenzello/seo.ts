// Metadati SEO degli articoli della sezione canton-appenzello (Appenzello).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-lavoro-ar-rav-settembre-2026': {
    title: 'Appenzello Esterno: disoccupazione al 1,5% a settembre',
    description: 'A settembre 2026 in Appenzello Esterno gli iscritti al RAV scendono a 819, 24 in meno; i disoccupati sono 455, 15 in meno, e il tasso passa dall\'1,6% all\'1,5%.',
    keywords: 'frontalieri, ticino, svizzera, italia, appenzello, esterno, disoccupazione, settembre',
    ogTitle: 'Appenzello Esterno: disoccupazione al 1,5% a settembre',
    ogDescription: 'Nel Canton Appenzello Esterno, la statistica di settembre 2026 registra 819 persone in cerca d\'impiego al RAV, 24 in meno rispetto ad agosto; i disoccupati sono 455, 15 in meno, con tasso dall\'1,6% all\'1,5%.',
    canonicalPath: '/articoli-appenzello/lavoro-ar-rav-settembre-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Appenzello Esterno: disoccupazione al 1,5% a settembre",
      "description": "A settembre 2026 in Appenzello Esterno gli iscritti al RAV scendono a 819, 24 in meno; i disoccupati sono 455, 15 in meno, e il tasso passa dall'1,6% all'1,5%.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/disoccupazione-settembre-ticino-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Centro regionale di collocamento nel Canton Appenzello Esterno"
      },
      "datePublished": "2026-10-07T10:17:50+00:00",
      "dateModified": "2026-10-07T10:17:50+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-appenzello/lavoro-ar-rav-settembre-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },
};

export default CANTON_SEO_METADATA;

// Metadati SEO degli articoli della sezione canton-ag (Argovia).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-argovia-disoccupazione-settembre': {
    title: 'Argovia: disoccupazione al 3,2% a settembre 2026',
    description: 'A settembre 2026 i sette RAV dell\'Argovia hanno registrato 12.451 disoccupati: tasso fermo al 3,2%, 3.735 posti vacanti e ricerca media di 261 giorni',
    keywords: 'frontalieri, ticino, svizzera, italia, argovia, disoccupazione, settembre, contava',
    ogTitle: 'Argovia: disoccupati al 3,2% nel settembre 2026',
    ogDescription: 'A settembre 2026 i sette RAV dell\'Argovia hanno registrato 12.451 disoccupati e 19.319 persone in cerca di lavoro. I posti vacanti segnalati sono scesi a 3.735, mentre la ricerca media è durata 261 giorni.',
    canonicalPath: '/articoli-argovia/argovia-disoccupazione-settembre/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Argovia: disoccupazione al 3,2% a settembre 2026",
      "description": "A settembre 2026 i sette RAV dell'Argovia hanno registrato 12.451 disoccupati: tasso fermo al 3,2%, 3.735 posti vacanti e ricerca media di 261 giorni",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/disoccupazione-settembre-ticino-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Centro regionale per l'impiego in Argovia sul tema della disoccupazione"
      },
      "datePublished": "2026-10-07T08:49:25+00:00",
      "dateModified": "2026-10-07T08:49:25+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-argovia/argovia-disoccupazione-settembre/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },
};

export default CANTON_SEO_METADATA;

// Metadati SEO degli articoli della sezione canton-ju (Giura).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-disoccupazione-giura-settembre-2026': {
    title: 'Disoccupazione in Giura scende al 4,2% a settembre 2026',
    description: 'Disoccupazione in Giura al 4,2% a settembre 2026, con 2.573 iscritti all\'ORP e un calo di 0,1 punti rispetto ad agosto. Confronto nazionale e dati distrettuali.',
    keywords: 'frontalieri, ticino, svizzera, italia, disoccupazione, giura, scende, settembre',
    ogTitle: 'Disoccupazione in Giura scende al 4,2% a settembre 2026',
    ogDescription: 'Il bollettino ufficiale dell\'ORP del Giura segnala a fine settembre 2026 un tasso di disoccupazione del 4,2%, in lieve calo rispetto ad agosto (-0,1 punti) e su base annua (-0,9 punti). Sono 2.573 gli iscritti, di cui 1.663 disoccupati e 910',
    canonicalPath: '/articoli-giura/disoccupazione-giura-settembre-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Disoccupazione in Giura scende al 4,2% a settembre 2026",
      "description": "Disoccupazione in Giura al 4,2% a settembre 2026, con 2.573 iscritti all'ORP e un calo di 0,1 punti rispetto ad agosto. Confronto nazionale e dati distrettuali.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-disoccupazione-giura-settembre-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Via di Delémont con bacheca di offerte di lavoro, autunno"
      },
      "datePublished": "2026-10-07T08:42:08+00:00",
      "dateModified": "2026-10-07T08:42:08+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-giura/disoccupazione-giura-settembre-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },
};

export default CANTON_SEO_METADATA;

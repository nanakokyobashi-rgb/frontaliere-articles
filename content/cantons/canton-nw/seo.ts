// Metadati SEO degli articoli della sezione canton-nw (Nidvaldo).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-lopper-luce-pedoni-bici': {
    title: 'Lopper: illuminazione sul percorso tra Stansstad e Hergiswil',
    description: 'Circa 1,2 km del percorso pedonale e ciclabile sul Lopper, tra Stansstad e Hergiswil, saranno illuminati. Lavori da ottobre, accensione a fine novembre 2026.',
    keywords: 'frontalieri, ticino, svizzera, italia, lopper, illuminazione, percorso, stansstad',
    ogTitle: 'Lopper: illuminazione tra Stansstad e Hergiswil',
    ogDescription: 'Il collegamento sul Lopper tra Stansstad e Hergiswil sarà illuminato per circa 1,2 chilometri. Il cantiere partirà nella seconda settimana di ottobre; il passaggio resterà possibile e l\'accensione è prevista per fine novembre 2026.',
    canonicalPath: '/articoli-nidvaldo/lopper-luce-pedoni-bici/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Lopper: illuminazione sul percorso tra Stansstad e Hergiswil",
      "description": "Circa 1,2 km del percorso pedonale e ciclabile sul Lopper, tra Stansstad e Hergiswil, saranno illuminati. Lavori da ottobre, accensione a fine novembre 2026.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/benzina-confine-svizzera-agosto-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Percorso pedonale e ciclabile sul Lopper tra Stansstad e Hergiswil"
      },
      "datePublished": "2026-10-07T18:27:16+00:00",
      "dateModified": "2026-10-07T18:27:16+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-nidvaldo/lopper-luce-pedoni-bici/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },
};

export default CANTON_SEO_METADATA;

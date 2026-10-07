// Metadati SEO degli articoli della sezione canton-sh (Sciaffusa).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-esplosione-bancomat-thayngen': {
    title: 'Thayngen: esploso un bancomat, ferito un sospetto',
    description: 'Esplosione di un bancomat a Thayngen il 30 settembre 2026: un presunto autore olandese è gravemente ferito, due complici fuggono verso la Germania; area chiusa.',
    keywords: 'frontalieri, ticino, svizzera, italia, thayngen, esploso, bancomat, ferito',
    ogTitle: 'Esplosione di un bancomat a Thayngen',
    ogDescription: 'Bancomat esploso davanti alla stazione di Thayngen: un cittadino olandese è gravemente ferito, due presunti autori sono fuggiti verso la Germania. L\'area è chiusa per esplosivo non detonato e la polizia cerca testimoni.',
    canonicalPath: '/articoli-sciaffusa/esplosione-bancomat-thayngen/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Thayngen: esploso un bancomat, ferito un sospetto",
      "description": "Esplosione di un bancomat a Thayngen il 30 settembre 2026: un presunto autore olandese è gravemente ferito, due complici fuggono verso la Germania; area chiusa.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-esplosione-bancomat-thayngen.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Area chiusa attorno alla stazione di Thayngen dopo l'esplosione di un bancomat."
      },
      "datePublished": "2026-10-07T23:37:11+00:00",
      "dateModified": "2026-10-07T23:37:11+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-sciaffusa/esplosione-bancomat-thayngen/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },
};

export default CANTON_SEO_METADATA;

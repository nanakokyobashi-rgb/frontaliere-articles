// Metadati SEO degli articoli della sezione canton-ow (Obvaldo).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-rtvv-obvaldo-categorie-aziendali': {
    title: 'RTVV a Obvaldo: revisione delle categorie aziendali',
    description: 'Obvaldo segnala una revisione parziale della RTVV: adeguamento delle categorie tariffarie del contributo aziendale. Riferimento: Staatskanzlei di Sarnen.',
    keywords: 'frontalieri, ticino, svizzera, italia, rtvv, obvaldo, revisione, categorie',
    ogTitle: 'RTVV a Obvaldo: revisione delle categorie aziendali',
    ogDescription: 'La comunicazione pubblicata a Sarnen riguarda la revisione parziale della Radio- und Fernsehverordnung (RTVV) e l\'adeguamento delle categorie tariffarie collegate al contributo aziendale. Il testo disponibile non riporta importi o scadenze.',
    canonicalPath: '/articoli-obvaldo/rtvv-obvaldo-categorie-aziendali/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "RTVV a Obvaldo: revisione delle categorie aziendali",
      "description": "Obvaldo segnala una revisione parziale della RTVV: adeguamento delle categorie tariffarie del contributo aziendale. Riferimento: Staatskanzlei di Sarnen.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-rtvv-obvaldo-categorie-aziendali.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Rathaus di Sarnen, sede indicata per la Staatskanzlei di Obvaldo"
      },
      "datePublished": "2026-10-07T10:19:16+00:00",
      "dateModified": "2026-10-07T10:19:16+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-obvaldo/rtvv-obvaldo-categorie-aziendali/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },
};

export default CANTON_SEO_METADATA;

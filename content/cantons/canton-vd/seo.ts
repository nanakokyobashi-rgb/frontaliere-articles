// Metadati SEO degli articoli della sezione canton-vd (Vaud).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-cdhr-frontalieri-vaud-2026': {
    title: 'CDHR: quando i frontalieri francesi pagano l\'acconto del 95%',
    description: '## In breve - La CDHR mira a un\'imposizione minima del 20% - Il reddito fiscale di riferimento determina il perimetro - Le soglie indicate sono 250.000',
    keywords: 'frontalieri, ticino, svizzera, italia, cdhr, quando, francesi, pagano',
    ogTitle: 'CDHR frontalieri francesi: soglie 250‑500k€ e acconto 95%',
    ogDescription: '## In breve - La CDHR mira a un\'imposizione minima del 20% - Il reddito fiscale di riferimento determina il perimetro - Le soglie indicate sono 250.000',
    canonicalPath: '/articoli-vaud/cdhr-frontalieri-vaud-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "CDHR: quando i frontalieri francesi pagano l'acconto del 95%",
      "description": "## In breve - La CDHR mira a un'imposizione minima del 20% - Il reddito fiscale di riferimento determina il perimetro - Le soglie indicate sono 250.000",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/frontalieri-regime-fiscale-nuovo-accordo.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Vista del lago di Ginevra con le montagne del Vallese sullo sfondo, rappresentante il Canton Vaud"
      },
      "datePublished": "2026-10-07T10:21:57+00:00",
      "dateModified": "2026-10-07T10:21:57+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-vaud/cdhr-frontalieri-vaud-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },
};

export default CANTON_SEO_METADATA;

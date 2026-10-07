// Metadati SEO degli articoli della sezione canton-zh (Zurigo).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-disoccupazione-zurigo-rav-2026': {
    title: 'Disoccupazione a Zurigo stabile al 2,9% a settembre',
    description: 'A settembre il Canton Zurigo mantiene il 2,9% di disoccupazione: 25’695 iscritti ai RAV, 7’605 posti vacanti in agosto e aspettative aziendali positive.',
    keywords: 'frontalieri, ticino, svizzera, italia, disoccupazione, zurigo, stabile, settembre',
    ogTitle: 'Zurigo, disoccupazione stabile al 2,9%',
    ogDescription: 'Il dato cantonale di settembre resta al 2,9%, ma le persone registrate come disoccupate diminuiscono di 355. In agosto i posti aperti ai RAV salgono a 7’605: costruzione e finiture segnano l’aumento più forte.',
    canonicalPath: '/articoli-zurigo/disoccupazione-zurigo-rav-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Disoccupazione a Zurigo stabile al 2,9% a settembre",
      "description": "A settembre il Canton Zurigo mantiene il 2,9% di disoccupazione: 25’695 iscritti ai RAV, 7’605 posti vacanti in agosto e aspettative aziendali positive.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/disoccupazione-settembre-ticino-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Pendolari e lavoratori nel centro di Zurigo in una mattina di settembre"
      },
      "datePublished": "2026-10-07T08:44:53+00:00",
      "dateModified": "2026-10-07T08:44:53+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-zurigo/disoccupazione-zurigo-rav-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },
};

export default CANTON_SEO_METADATA;

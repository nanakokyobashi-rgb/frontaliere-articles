// Metadati SEO degli articoli della sezione canton-be (Berna).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-simplificazione-imposta-trasferimento-berna': {
    title: 'Imposta trasferimenti Berna: franchigia 800k | Frontaliere Ticino',
    description: 'Il Governo di Berna propone di allentare le regole sull\'uso esclusivo e di introdurre il rimborso entro 4 anni. Franchigia di 800.000 CHF confermata.',
    keywords: 'frontalieri, ticino, svizzera, italia, imposta, trasferimenti, berna, franchigia',
    ogTitle: 'Imposta trasferimenti Berna: franchigia 800k',
    ogDescription: 'Il Governo cantonale di Berna propone una revisione della legge sull\'imposta di trasferimento. La franchigia resta a 800.000 CHF, ma l\'uso esclusivo non è più obbligatorio. Scopri i nuovi termini per il rimborso e le scadenze della consultazione',
    canonicalPath: '/articoli-berna/simplificazione-imposta-trasferimento-berna/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Imposta trasferimenti Berna: franchigia 800k",
      "description": "Il Governo di Berna propone di allentare le regole sull'uso esclusivo e di introdurre il rimborso entro 4 anni. Franchigia di 800.000 CHF confermata.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/imposta-successione-donazione-berna.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Edificio abitativo a Berna con piano architettonico in mano"
      },
      "datePublished": "2026-10-07T06:54:25+00:00",
      "dateModified": "2026-10-07T06:54:25+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/simplificazione-imposta-trasferimento-berna/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },
};

export default CANTON_SEO_METADATA;

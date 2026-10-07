// Metadati SEO degli articoli della sezione canton-zg (Zugo).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-zugo-bilancio-2027-avanzzo-15-6-milioni-tasso-52': {
    title: 'Zugo prevede avanzo 15,6 milioni nel 2027 con tasso al 52%',
    description: 'Il Comune di Zugo prevede per il 2027 un avanzo di CHF 15,6 milioni, mantiene il tasso fiscale al 52% e pianifica investimenti netti per CHF 86,4 milioni',
    keywords: 'frontalieri, ticino, svizzera, italia, zugo, prevede, avanzo, milioni',
    ogTitle: 'Zugo prevede avanzo 15,6 milioni nel 2027 con tasso al 52%',
    ogDescription: 'Il preventivo 2027 del Comune di Zugo indica un avanzo di CHF 15,6 milioni, entrate per CHF 446,6 milioni e uscite per CHF 431,1 milioni. Il tasso fiscale richiesto è confermato al 52 per cento. Gli investimenti netti ammontano a CHF 86,4 milioni',
    canonicalPath: '/articoli-zugo/zugo-bilancio-2027-avanzzo-15-6-milioni-tasso-52/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Zugo prevede avanzo 15,6 milioni nel 2027 con tasso al 52%",
      "description": "Il Comune di Zugo prevede per il 2027 un avanzo di CHF 15,6 milioni, mantiene il tasso fiscale al 52% e pianifica investimenti netti per CHF 86,4 milioni",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/galleria-moscia-acapulco-180-milioni.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Vista aerea della vecchia città di Zugo sul lago di Zugo con edifici moderni e spazi verdi"
      },
      "datePublished": "2026-10-07T08:41:12+00:00",
      "dateModified": "2026-10-07T08:41:12+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-zugo/zugo-bilancio-2027-avanzzo-15-6-milioni-tasso-52/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },
};

export default CANTON_SEO_METADATA;

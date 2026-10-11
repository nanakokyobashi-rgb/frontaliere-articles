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
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-lopper-luce-pedoni-bici.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
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

  'blog-postauto-orario-nidvaldo-2026': {
    title: 'PostAuto, nuovo orario in Nidvaldo dal 13 dicembre 2026',
    description: 'Dal 13 dicembre 2026 cambia l\'orario PostAuto nei Cantoni Obvaldo e Nidvaldo: la comunicazione annuncia modifiche all\'offerta e indica dove leggere i dettagli.',
    keywords: 'frontalieri, ticino, svizzera, italia, postauto, nuovo, orario, nidvaldo',
    ogTitle: 'PostAuto, nuovo orario in Nidvaldo dal 13 dicembre 2026',
    ogDescription: 'Il nuovo orario PostAuto è annunciato dal 13 dicembre 2026. La comunicazione riguarda l\'offerta nei Cantoni Obvaldo e Nidvaldo e segnala che le principali modifiche sono riportate nella nota sottostante.',
    canonicalPath: '/articoli-nidvaldo/postauto-orario-nidvaldo-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "PostAuto, nuovo orario in Nidvaldo dal 13 dicembre 2026",
      "description": "Dal 13 dicembre 2026 cambia l'orario PostAuto nei Cantoni Obvaldo e Nidvaldo: la comunicazione annuncia modifiche all'offerta e indica dove leggere i dettagli.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-postauto-orario-nidvaldo-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-10T17:33:10+00:00",
      "dateModified": "2026-10-10T17:33:10+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-nidvaldo/postauto-orario-nidvaldo-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

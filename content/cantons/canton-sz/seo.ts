// Metadati SEO degli articoli della sezione canton-sz (Svitto).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-chiusura-strade-gallusmarkt-svitto': {
    title: 'Einsiedeln: chiusure stradali per il Gallusmarkt 2026',
    description: 'Avviso chiusure stradali a Einsiedeln per il Gallusmarkt: Hauptstrasse e Sagenplatz inaccessibili dalle 5.00 alle 20.00. Info su rumori e perimetri.',
    keywords: 'frontalieri, ticino, svizzera, italia, einsiedeln, chiusure, stradali, gallusmarkt',
    ogTitle: 'Einsiedeln: chiusure stradali per il Gallusmarkt 2026',
    ogDescription: 'Attenzione a chi vive o lavora a Einsiedeln: Hauptstrasse (da Dorfplatz a Haus Pfauen) e Sagenplatz saranno chiuse dalle 5.00 alle 20.00 il giorno del mercato.',
    canonicalPath: '/articoli-svitto/chiusura-strade-gallusmarkt-svitto/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Einsiedeln: chiusure stradali per il Gallusmarkt 2026",
      "description": "Avviso chiusure stradali a Einsiedeln per il Gallusmarkt: Hauptstrasse e Sagenplatz inaccessibili dalle 5.00 alle 20.00. Info su rumori e perimetri.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-chiusura-strade-gallusmarkt-svitto.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Strade di Einsiedeln durante l'allestimento del mercato"
      },
      "datePublished": "2026-10-07T09:21:09+00:00",
      "dateModified": "2026-10-07T09:21:09+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-svitto/chiusura-strade-gallusmarkt-svitto/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-svitto-cambio-cassa-malati': {
    title: 'Concorrenza sleale nel cambio cassa malati a Svitto',
    description: 'Le offerte per cambiare cassa malati spesso ingannano: una cassa locale di Svitto deve fare i conti con un business descritto come concorrenza sleale.',
    keywords: 'frontalieri, ticino, svizzera, italia, concorrenza, sleale, cambio, cassa',
    ogTitle: 'Cambio cassa malati: il caso di Svitto',
    ogDescription: 'Il caso di Svitto riguarda offerte per cambiare cassa malati: la fonte segnala un\'apparenza ingannevole e una cassa locale alle prese con questo business. Il lettore deve distinguere premio LAMal/KVG, sussidi cantonali e altre voci del bilancio.',
    canonicalPath: '/articoli-svitto/svitto-cambio-cassa-malati/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Concorrenza sleale nel cambio cassa malati a Svitto",
      "description": "Le offerte per cambiare cassa malati spesso ingannano: una cassa locale di Svitto deve fare i conti con un business descritto come concorrenza sleale.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-tf-nega-sconto-cassa-malati-padre-affidamento-alternato.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Scena del Canton Svitto per un articolo sul cambio di cassa malati"
      },
      "datePublished": "2026-10-08T14:43:30+00:00",
      "dateModified": "2026-10-08T14:43:30+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-svitto/svitto-cambio-cassa-malati/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

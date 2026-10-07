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

  'blog-wabern-tram-risanamento': {
    title: 'Approvati il tram di Kleinwabern e il risanamento di Wabern',
    description: 'Il BAV ha approvato tram e risanamento a Wabern: linea 9 fino a Kleinwabern, nodo tra S-Bahn, bus e tram, lavori non prima del 2028, ricorso in corso.',
    keywords: 'frontalieri, ticino, svizzera, italia, approvati, tram, kleinwabern, risanamento',
    ogTitle: 'Tram Kleinwabern approvato: lavori non prima del 2028',
    ogDescription: '«Tram Kleinwabern» estenderà la linea 9 fino a Kleinwabern e creerà un nodo con S-Bahn, bus e tram. «Sanierung Zentrum Wabern» prevede il risanamento della Seftigenstrasse per ciclisti e pedoni; i lavori partiranno non prima del 2028.',
    canonicalPath: '/articoli-berna/wabern-tram-risanamento/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Approvati il tram di Kleinwabern e il risanamento di Wabern",
      "description": "Il BAV ha approvato tram e risanamento a Wabern: linea 9 fino a Kleinwabern, nodo tra S-Bahn, bus e tram, lavori non prima del 2028, ricorso in corso.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/tram-treno-lugano-lavori-inizio.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Progetti del tram di Kleinwabern e risanamento del centro di Wabern"
      },
      "datePublished": "2026-10-07T07:11:43+00:00",
      "dateModified": "2026-10-07T07:11:43+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/wabern-tram-risanamento/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

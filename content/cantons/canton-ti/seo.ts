// Metadati SEO degli articoli della sezione canton-ti (Ticino).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-a2-mendrisio-melano-risanamento': {
    title: 'A2 Mendrisio-Melano: il progetto MeMe di risanamento',
    description: '## In breve - L’USTRA ha pubblicato il progetto A2 tra Mendrisio e Melano. - I lavori potrebbero iniziare non prima del 2031. - Previsti asfalto fonoassorbente',
    keywords: 'frontalieri, ticino, svizzera, italia, mendrisio-melano, progetto, meme, risanamento',
    ogTitle: 'A2 Mendrisio-Melano: il progetto MeMe di risanamento',
    ogDescription: '## In breve - L’USTRA ha pubblicato il progetto A2 tra Mendrisio e Melano. - I lavori potrebbero iniziare non prima del 2031. - Previsti asfalto fonoassorbente',
    canonicalPath: '/articoli-ticino/a2-mendrisio-melano-risanamento/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "A2 Mendrisio-Melano: il progetto MeMe di risanamento",
      "description": "## In breve - L’USTRA ha pubblicato il progetto A2 tra Mendrisio e Melano. - I lavori potrebbero iniziare non prima del 2031. - Previsti asfalto fonoassorbente",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-a2-mendrisio-melano-risanamento.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Tratto autostradale A2 tra Mendrisio e Melano"
      },
      "datePublished": "2026-10-07T06:12:18+00:00",
      "dateModified": "2026-10-07T06:12:18+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-ticino/a2-mendrisio-melano-risanamento/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-scambio-dati-salariali-2027': {
    title: 'Frontalieri, dal 2027 lo scambio dati sugli stipendi',
    description: '## In breve - Dal 1 gennaio 2027 entra in vigore la nuova LSADS - Decisione del Consiglio federale: 19 agosto 2026 - Accordo Svizzera-Italia applicabile dal 1',
    keywords: 'frontalieri, ticino, svizzera, italia, scambio, dati, sugli, stipendi',
    ogTitle: 'Frontalieri, dal 2027 scambio automatico dati stipendi',
    ogDescription: '## In breve - Dal 1 gennaio 2027 entra in vigore la nuova LSADS - Decisione del Consiglio federale: 19 agosto 2026 - Accordo Svizzera-Italia applicabile dal 1',
    canonicalPath: '/articoli-ticino/scambio-dati-salariali-2027/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Frontalieri, dal 2027 lo scambio dati sugli stipendi",
      "description": "## In breve - Dal 1 gennaio 2027 entra in vigore la nuova LSADS - Decisione del Consiglio federale: 19 agosto 2026 - Accordo Svizzera-Italia applicabile dal 1",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-scambio-dati-salariali-2027.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Veduta di Lugano con edifici moderni e uffici."
      },
      "datePublished": "2026-10-07T06:25:44+00:00",
      "dateModified": "2026-10-07T06:25:44+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-ticino/scambio-dati-salariali-2027/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

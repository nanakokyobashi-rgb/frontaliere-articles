// Metadati SEO degli articoli della sezione canton-ti (Ticino).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-a2-mendrisio-melano-risanamento': {
    title: 'A2 Mendrisio-Melano: il progetto MeMe di risanamento',
    description: 'L’USTRA ha pubblicato il progetto A2 tra Mendrisio e Melano.',
    keywords: 'frontalieri, ticino, svizzera, italia, mendrisio-melano, progetto, meme, risanamento',
    ogTitle: 'A2 Mendrisio-Melano: il progetto MeMe di risanamento',
    ogDescription: 'L’USTRA ha pubblicato il progetto A2 tra Mendrisio e Melano.',
    canonicalPath: '/articoli-ticino/a2-mendrisio-melano-risanamento/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "A2 Mendrisio-Melano: il progetto MeMe di risanamento",
      "description": "L’USTRA ha pubblicato il progetto A2 tra Mendrisio e Melano.",
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
    description: 'Dal 1 gennaio 2027 entra in vigore la nuova LSADS',
    keywords: 'frontalieri, ticino, svizzera, italia, scambio, dati, sugli, stipendi',
    ogTitle: 'Frontalieri, dal 2027 scambio automatico dati stipendi',
    ogDescription: 'Dal 1 gennaio 2027 entra in vigore la nuova LSADS',
    canonicalPath: '/articoli-ticino/scambio-dati-salariali-2027/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Frontalieri, dal 2027 lo scambio dati sugli stipendi",
      "description": "Dal 1 gennaio 2027 entra in vigore la nuova LSADS",
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

  'blog-decreto-tassa-salute-frontalieri-pubblicato-via-libera-regioni': {
    title: 'Decreto tassa salute frontalieri pubblicato: via libera regioni',
    description: 'Decreto pubblicato in Gazzetta Ufficiale a ridosso delle festività',
    keywords: 'frontalieri, ticino, svizzera, italia, decreto, tassa, salute, pubblicato',
    ogTitle: 'Decreto tassa salute frontalieri pubblicato: via libera',
    ogDescription: 'Decreto pubblicato in Gazzetta Ufficiale a ridosso delle festività',
    canonicalPath: '/articoli-ticino/decreto-tassa-salute-frontalieri-pubblicato-via-libera-regioni/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Decreto tassa salute frontalieri pubblicato: via libera regioni",
      "description": "Decreto pubblicato in Gazzetta Ufficiale a ridosso delle festività",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/tassa-salute-frontalieri-ticino-settembre.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine editoriale relativa a: Decreto tassa salute frontalieri pubblicato: via libera regioni"
      },
      "datePublished": "2026-10-08T11:44:40+00:00",
      "dateModified": "2026-10-08T11:44:40+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/laura-bianchi/#person",
        "name": "Laura Bianchi",
        "url": "https://frontaliereticino.ch/autori/laura-bianchi/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-ticino/decreto-tassa-salute-frontalieri-pubblicato-via-libera-regioni/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-capitale-lpp-rimborso-imposta-fonte': {
    title: 'Capitale LPP: Ticino nega rimborso imposta alla fonte',
    description: 'Dal 2024 il Ticino nega il rimborso dell\'imposta alla fonte',
    keywords: 'frontalieri, ticino, svizzera, italia, capitale, nega, rimborso, imposta',
    ogTitle: 'Capitale LPP: Ticino nega rimborso imposta alla fonte',
    ogDescription: 'Dal 2024 il Ticino nega il rimborso dell\'imposta alla fonte',
    canonicalPath: '/articoli-ticino/capitale-lpp-rimborso-imposta-fonte/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Capitale LPP: Ticino nega rimborso imposta alla fonte",
      "description": "Dal 2024 il Ticino nega il rimborso dell'imposta alla fonte",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-capitale-lpp-rimborso-imposta-fonte.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Edifici amministrativi a Bellinzona, sede di autorità fiscali del Canton Ticino"
      },
      "datePublished": "2026-10-08T12:15:50+00:00",
      "dateModified": "2026-10-08T12:15:50+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-ticino/capitale-lpp-rimborso-imposta-fonte/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

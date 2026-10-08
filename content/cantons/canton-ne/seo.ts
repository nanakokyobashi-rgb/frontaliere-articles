// Metadati SEO degli articoli della sezione canton-ne (Neuchâtel).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-neuchatel-rinnova-politica-abitativa-con-24-milioni': {
    title: 'Neuchâtel rinnova politica abitativa con 24 milioni',
    description: '## In breve - Il 28 settembre 2026 il Consiglio di Stato ha adottato il rapporto - Credito-quadro di 24 milioni di franchi su otto anni - Prosegue la politica',
    keywords: 'frontalieri, ticino, svizzera, italia, neuch, rinnova, politica, abitativa',
    ogTitle: 'Neuchâtel rinnova politica abitativa con 24 milioni',
    ogDescription: '## In breve - Il 28 settembre 2026 il Consiglio di Stato ha adottato il rapporto - Credito-quadro di 24 milioni di franchi su otto anni - Prosegue la politica',
    canonicalPath: '/articoli-neuchatel/neuchatel-rinnova-politica-abitativa-con-24-milioni/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Neuchâtel rinnova politica abitativa con 24 milioni",
      "description": "## In breve - Il 28 settembre 2026 il Consiglio di Stato ha adottato il rapporto - Credito-quadro di 24 milioni di franchi su otto anni - Prosegue la politica",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-neuchatel-rinnova-politica-abitativa-con-24-milioni.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine editoriale relativa a: Neuchâtel rinnova politica abitativa con 24 milioni"
      },
      "datePublished": "2026-10-07T09:07:42+00:00",
      "dateModified": "2026-10-07T09:07:42+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-neuchatel/neuchatel-rinnova-politica-abitativa-con-24-milioni/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-disoccupazione-stabile-4-4-neuchatel-settembre-2026': {
    title: 'Disoccupazione stabile 4,4% Neuchâtel settembre 2026',
    description: '## In breve - 3.945 disoccupati in settembre 2026 - Tasso neocastellano stabile al 4,4% - Disoccupazione giovanile al 5,3% - Dati DECS aggiornati al 6 ottobre',
    keywords: 'frontalieri, ticino, svizzera, italia, disoccupazione, stabile, neuch, settembre',
    ogTitle: 'Disoccupazione stabile 4,4% Neuchâtel settembre 2026',
    ogDescription: '## In breve - 3.945 disoccupati in settembre 2026 - Tasso neocastellano stabile al 4,4% - Disoccupazione giovanile al 5,3% - Dati DECS aggiornati al 6 ottobre',
    canonicalPath: '/articoli-neuchatel/disoccupazione-stabile-4-4-neuchatel-settembre-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Disoccupazione stabile 4,4% Neuchâtel settembre 2026",
      "description": "## In breve - 3.945 disoccupati in settembre 2026 - Tasso neocastellano stabile al 4,4% - Disoccupazione giovanile al 5,3% - Dati DECS aggiornati al 6 ottobre",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-disoccupazione-stabile-4-4-neuchatel-settembre-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine editoriale relativa a: Disoccupazione stabile 4,4% Neuchâtel settembre 2026"
      },
      "datePublished": "2026-10-07T09:30:57+00:00",
      "dateModified": "2026-10-07T09:30:57+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-neuchatel/disoccupazione-stabile-4-4-neuchatel-settembre-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

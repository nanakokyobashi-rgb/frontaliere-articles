// Metadati SEO degli articoli della sezione canton-ge (Ginevra).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-economia-ginevrina-ripresa-globale': {
    title: 'Economia ginevrina: beneficio dalla ripresa globale',
    description: 'L\'economia ginevrina beneficia della ripresa dell\'attività mondiale: il titolo segnala il trend, senza cifre, settori o misure operative concrete.',
    keywords: 'frontalieri, ticino, svizzera, italia, economia, ginevrina, beneficio, dalla',
    ogTitle: 'Economia ginevrina: ripresa globale',
    ogDescription: 'L\'aggiornamento della Repubblica e Cantone di Ginevra indica un beneficio per l\'economia ginevrina legato al recupero dell\'attività mondiale. Il materiale disponibile non riporta però cifre, settori, date o misure concrete.',
    canonicalPath: '/articoli-ginevra/economia-ginevrina-ripresa-globale/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Economia ginevrina: beneficio dalla ripresa globale",
      "description": "L'economia ginevrina beneficia della ripresa dell'attività mondiale: il titolo segnala il trend, senza cifre, settori o misure operative concrete.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/crescita-economia-svizzera-seco-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "L'economia ginevrina beneficia della ripresa dell'attività mondiale"
      },
      "datePublished": "2026-10-07T08:41:49+00:00",
      "dateModified": "2026-10-07T08:41:49+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-ginevra/economia-ginevrina-ripresa-globale/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-accordo-cure-oncologiche-ginevra': {
    title: 'Accordo Ginevra-Francia per cure oncologiche pediatriche',
    description: '## In breve - Accordo tra autorità ginevrine e francesi - Cure HUG per bambini del Pays de Gex e Haute-Savoie - Regola questioni mediche e amministrative',
    keywords: 'frontalieri, ticino, svizzera, italia, accordo, ginevra-francia, cure, oncologiche',
    ogTitle: 'Accordo Ginevra-Francia per cure pediatriche HUG',
    ogDescription: '## In breve - Accordo tra autorità ginevrine e francesi - Cure HUG per bambini del Pays de Gex e Haute-Savoie - Regola questioni mediche e amministrative',
    canonicalPath: '/articoli-ginevra/accordo-cure-oncologiche-ginevra/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Accordo Ginevra-Francia per cure oncologiche pediatriche",
      "description": "## In breve - Accordo tra autorità ginevrine e francesi - Cure HUG per bambini del Pays de Gex e Haute-Savoie - Regola questioni mediche e amministrative",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/carenze-dogane-sicurezza-ticino.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Accordo transfrontaliero per cure oncologiche pediatriche a Ginevra"
      },
      "datePublished": "2026-10-07T08:57:01+00:00",
      "dateModified": "2026-10-07T08:57:01+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-ginevra/accordo-cure-oncologiche-ginevra/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

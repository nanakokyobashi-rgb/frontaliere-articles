// Metadati SEO degli articoli della sezione canton-ow (Obvaldo).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-rtvv-obvaldo-categorie-aziendali': {
    title: 'RTVV a Obvaldo: revisione delle categorie aziendali',
    description: 'Obvaldo segnala una revisione parziale della RTVV: adeguamento delle categorie tariffarie del contributo aziendale. Riferimento: Staatskanzlei di Sarnen.',
    keywords: 'frontalieri, ticino, svizzera, italia, rtvv, obvaldo, revisione, categorie',
    ogTitle: 'RTVV a Obvaldo: revisione delle categorie aziendali',
    ogDescription: 'La comunicazione pubblicata a Sarnen riguarda la revisione parziale della Radio- und Fernsehverordnung (RTVV) e l\'adeguamento delle categorie tariffarie collegate al contributo aziendale. Il testo disponibile non riporta importi o scadenze.',
    canonicalPath: '/articoli-obvaldo/rtvv-obvaldo-categorie-aziendali/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "RTVV a Obvaldo: revisione delle categorie aziendali",
      "description": "Obvaldo segnala una revisione parziale della RTVV: adeguamento delle categorie tariffarie del contributo aziendale. Riferimento: Staatskanzlei di Sarnen.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-rtvv-obvaldo-categorie-aziendali.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Rathaus di Sarnen, sede indicata per la Staatskanzlei di Obvaldo"
      },
      "datePublished": "2026-10-07T10:19:16+00:00",
      "dateModified": "2026-10-07T10:19:16+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-obvaldo/rtvv-obvaldo-categorie-aziendali/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-obvaldo-verkehr45-mobilita': {
    title: 'Obvaldo: proposta di mobilità Verkehr\'45 | Frontaliere Ticino',
    description: 'La pagina del Canton Obvaldo dedicata a Verkehr\'45 indica una proposta sulle esigenze di mobilità attraverso più modi di trasporto e cita la Staatskanzlei',
    keywords: 'frontalieri, ticino, svizzera, italia, obvaldo, proposta, mobilità, verkehr',
    ogTitle: 'Obvaldo: la proposta di mobilità Verkehr\'45',
    ogDescription: 'La pagina collegata a ow.ch riporta il titolo Verkehr\'45 e parla di una proposta per affrontare le esigenze di mobilità attraverso diversi modi di trasporto. La stessa schermata indica la Staatskanzlei, Rathaus, Dorfplatz 8, 6061 Sarnen.',
    canonicalPath: '/articoli-obvaldo/obvaldo-verkehr45-mobilita/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Obvaldo: proposta di mobilità Verkehr'45",
      "description": "La pagina del Canton Obvaldo dedicata a Verkehr'45 indica una proposta sulle esigenze di mobilità attraverso più modi di trasporto e cita la Staatskanzlei",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-obvaldo-verkehr45-mobilita.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Proposta di mobilità Verkehr'45 nel Canton Obvaldo"
      },
      "datePublished": "2026-10-09T11:28:57+00:00",
      "dateModified": "2026-10-09T11:28:57+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-obvaldo/obvaldo-verkehr45-mobilita/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

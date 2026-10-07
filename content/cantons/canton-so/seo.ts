// Metadati SEO degli articoli della sezione canton-so (Soletta).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-soletta-disoccupazione-settembre': {
    title: 'Soletta: disoccupazione al 3,0% a settembre 2026',
    description: 'A settembre 2026 il Canton Soletta registra 4\'551 disoccupati, 46 in meno sul mese precedente: il tasso scende dal 3,1% al 3,0% e il calo riguarda gli under 25.',
    keywords: 'frontalieri, ticino, svizzera, italia, soletta, disoccupazione, settembre, canton',
    ogTitle: 'Soletta: disoccupazione al 3,0% a settembre 2026',
    ogDescription: 'Settembre 2026 nel Canton Soletta: 4\'551 disoccupati registrati, 46 in meno sul mese precedente e tasso dal 3,1% al 3,0%. L\'Amt für Wirtschaft und Arbeit collega il calo agli under 25; la pagina rinvia alle statistiche federali e cantonali.',
    canonicalPath: '/articoli-soletta/soletta-disoccupazione-settembre/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Soletta: disoccupazione al 3,0% a settembre 2026",
      "description": "A settembre 2026 il Canton Soletta registra 4'551 disoccupati, 46 in meno sul mese precedente: il tasso scende dal 3,1% al 3,0% e il calo riguarda gli under 25.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/disoccupazione-settembre-ticino-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Persone davanti a un ufficio pubblico per il lavoro nel Canton Soletta"
      },
      "datePublished": "2026-10-07T10:37:25+00:00",
      "dateModified": "2026-10-07T10:37:25+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-soletta/soletta-disoccupazione-settembre/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-premi-malattia-soletta-2027': {
    title: 'Canton Soletta: premi della cassa malati +6% nel 2027',
    description: 'Nel 2027 i premi della cassa malati in Canton Soletta salgono del 6%: +23.50 CHF, media a 417.50 CHF, sopra il dato svizzero. Possibile sollievo nel 2028.',
    keywords: 'frontalieri, ticino, svizzera, italia, canton, soletta, premi, cassa',
    ogTitle: 'Canton Soletta: premi malattia +6% nel 2027',
    ogDescription: 'Il premio medio nel Canton Soletta salirà a 417.50 CHF, 23.50 CHF in più e 5.50 CHF sopra la media svizzera. Solo Jura e Schaffhausen registrano rincari superiori; Eberhard indica la quota degli over 65 e le cure fuori Cantone tra i fattori.',
    canonicalPath: '/articoli-soletta/premi-malattia-soletta-2027/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Canton Soletta: premi della cassa malati +6% nel 2027",
      "description": "Nel 2027 i premi della cassa malati in Canton Soletta salgono del 6%: +23.50 CHF, media a 417.50 CHF, sopra il dato svizzero. Possibile sollievo nel 2028.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/premi-cassa-malati-lamal-2026-canton-zurigo.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Canton Soletta associato all'aumento dei premi della cassa malati nel 2027"
      },
      "datePublished": "2026-10-07T10:54:53+00:00",
      "dateModified": "2026-10-07T10:54:53+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-soletta/premi-malattia-soletta-2027/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

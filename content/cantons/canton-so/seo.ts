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
        "url": `${BASE_URL}/images/blog/article-soletta-disoccupazione-settembre.webp`,
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
    title: 'Premi cassa malati a Soletta: +6% nel 2027 | Frontaliere Ticino',
    description: 'Nel 2027 il premio medio della cassa malati nel Canton Soletta salirà del 6%, a CHF 417.50: CHF 5.50 sopra la media svizzera di CHF 412.0 per il 2027.',
    keywords: 'frontalieri, ticino, svizzera, italia, premi, cassa, malati, soletta',
    ogTitle: 'Soletta: premi cassa malati +6% nel 2027',
    ogDescription: 'Nel Canton Soletta la crescita dei premi sarà tra le più alte nel 2027. Il premio medio raggiungerà CHF 417.50, mentre Berna, i due Basilea e il Giura restano più cari; tra le cause indicate ci sono età della popolazione e cure fuori cantone.',
    canonicalPath: '/articoli-soletta/premi-malattia-soletta-2027/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Premi cassa malati a Soletta: +6% nel 2027",
      "description": "Nel 2027 il premio medio della cassa malati nel Canton Soletta salirà del 6%, a CHF 417.50: CHF 5.50 sopra la media svizzera di CHF 412.0 per il 2027.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/premi-cassa-malati-lamal-2026-canton-zurigo.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Premi della cassa malati nel Canton Soletta nel 2027"
      },
      "datePublished": "2026-10-07T11:11:51+00:00",
      "dateModified": "2026-10-07T11:11:51+00:00",
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

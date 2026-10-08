// Metadati SEO degli articoli della sezione canton-fr (Friburgo).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-disoccupazione-friburgo-settembre-2026': {
    title: 'Disoccupazione a Friburgo scende al 2,5% in settembre 2026',
    description: '## In breve - Disoccupazione friburghese al 2,5% a settembre 2026 - 4’509 disoccupati, 185 in meno rispetto ad agosto - Richiedenti d’impiego al 5,1%, stabili',
    keywords: 'frontalieri, ticino, svizzera, italia, disoccupazione, friburgo, scende, settembre',
    ogTitle: 'Disoccupazione a Friburgo scende al 2,5% in settembre 2026',
    ogDescription: '## In breve - Disoccupazione friburghese al 2,5% a settembre 2026 - 4’509 disoccupati, 185 in meno rispetto ad agosto - Richiedenti d’impiego al 5,1%, stabili',
    canonicalPath: '/articoli-friburgo/disoccupazione-friburgo-settembre-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Disoccupazione a Friburgo scende al 2,5% in settembre 2026",
      "description": "## In breve - Disoccupazione friburghese al 2,5% a settembre 2026 - 4’509 disoccupati, 185 in meno rispetto ad agosto - Richiedenti d’impiego al 5,1%, stabili",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-disoccupazione-friburgo-settembre-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Scena di Friburgo con persone in cerca di lavoro, catturata in pieno giorno."
      },
      "datePublished": "2026-10-07T08:52:59+00:00",
      "dateModified": "2026-10-07T08:52:59+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-friburgo/disoccupazione-friburgo-settembre-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-fribourg-modifica-licd': {
    title: 'Fribourg adegua imposte dirette alla progressione a freddo',
    description: '## In breve - Voto: 97 favorevoli, 1 contrario, nessuna astensione - La revisione della LICD comprende nove aspetti - Scale fiscali e deduzioni sociali si',
    keywords: 'frontalieri, ticino, svizzera, italia, fribourg, adegua, imposte, dirette',
    ogTitle: 'Fribourg adegua imposte dirette alla progressione a freddo',
    ogDescription: '## In breve - Voto: 97 favorevoli, 1 contrario, nessuna astensione - La revisione della LICD comprende nove aspetti - Scale fiscali e deduzioni sociali si',
    canonicalPath: '/articoli-friburgo/fribourg-modifica-licd/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Fribourg adegua imposte dirette alla progressione a freddo",
      "description": "## In breve - Voto: 97 favorevoli, 1 contrario, nessuna astensione - La revisione della LICD comprende nove aspetti - Scale fiscali e deduzioni sociali si",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-fribourg-modifica-licd.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Ufficio pubblico a Friburgo con contribuenti che compilano la dichiarazione dei redditi su un computer"
      },
      "datePublished": "2026-10-07T10:27:22+00:00",
      "dateModified": "2026-10-07T10:27:22+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-friburgo/fribourg-modifica-licd/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

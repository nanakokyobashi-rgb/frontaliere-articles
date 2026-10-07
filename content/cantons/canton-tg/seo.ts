// Metadati SEO degli articoli della sezione canton-tg (Turgovia).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-baugesuch-juchstrasse-frauenfeld': {
    title: 'Domanda edilizia a Frauenfeld: Juchstrasse 22-22b',
    description: 'A Frauenfeld il Baugesuch per Juchstrasse 22, 22a e 22b è consultabile al Bankplatz 3 dal 7 al 26 ottobre 2026. Opposizioni scritte motivate allo Stadtrat.',
    keywords: 'frontalieri, ticino, svizzera, italia, domanda, edilizia, frauenfeld, juchstrasse',
    ogTitle: 'Domanda edilizia a Frauenfeld: Juchstrasse 22-22b',
    ogDescription: 'Il progetto per Juchstrasse 22, 22a e 22b prevede l\'allestimento del primo e secondo piano, il cambio d\'uso di garage e locali commerciali e nuove strutture per biciclette e carrelli. Atti al Bankplatz 3.',
    canonicalPath: '/articoli-turgovia/baugesuch-juchstrasse-frauenfeld/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Domanda edilizia a Frauenfeld: Juchstrasse 22-22b",
      "description": "A Frauenfeld il Baugesuch per Juchstrasse 22, 22a e 22b è consultabile al Bankplatz 3 dal 7 al 26 ottobre 2026. Opposizioni scritte motivate allo Stadtrat.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/calcolatore-salariale-edilizia-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Edificio commerciale e strada urbana a Frauenfeld, tema di una domanda edilizia pubblica"
      },
      "datePublished": "2026-10-07T10:39:32+00:00",
      "dateModified": "2026-10-07T10:39:32+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/baugesuch-juchstrasse-frauenfeld/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },
};

export default CANTON_SEO_METADATA;

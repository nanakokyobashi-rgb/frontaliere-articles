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

  'blog-rapporti-thurmed-turgovia': {
    title: 'Rapporti 2025 thurmed e Spital Thurgau | Frontaliere Ticino',
    description: 'La pagina di Spital Thurgau AG raccoglie il rapporto 2025 di thurmed, il rapporto di sostenibilità e le statistiche 2021-2025: ecco la struttura dell\'archivio.',
    keywords: 'frontalieri, ticino, svizzera, italia, rapporti, thurmed, spital, thurgau',
    ogTitle: 'Rapporti thurmed e Spital Thurgau 2025',
    ogDescription: 'Archivio thurmed Gruppe e Spital Thurgau AG: per il 2025 sono elencati il Geschäftsbericht, il Nachhaltigkeitsbericht e Statistiken & Zahlen. La stessa pagina riporta Geschäftsbericht e statistiche per il 2021-2024.',
    canonicalPath: '/articoli-turgovia/rapporti-thurmed-turgovia/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Rapporti 2025 thurmed e Spital Thurgau",
      "description": "La pagina di Spital Thurgau AG raccoglie il rapporto 2025 di thurmed, il rapporto di sostenibilità e le statistiche 2021-2025: ecco la struttura dell'archivio.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/aiuti-malattie-rare-2025.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Edificio ospedaliero nel Canton Turgovia per i rapporti thurmed e Spital Thurgau AG"
      },
      "datePublished": "2026-10-07T10:52:51+00:00",
      "dateModified": "2026-10-07T10:52:51+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/rapporti-thurmed-turgovia/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

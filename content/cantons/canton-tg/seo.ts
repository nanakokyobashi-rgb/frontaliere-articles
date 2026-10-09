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
        "url": `${BASE_URL}/images/blog/article-baugesuch-juchstrasse-frauenfeld.webp`,
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
        "url": `${BASE_URL}/images/blog/article-rapporti-thurmed-turgovia.webp`,
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

  'blog-chiusura-strada-kesswil': {
    title: 'Kesswil: Uttwilerstrasse chiusa dal 15 al 18 ottobre 2026',
    description: 'La Uttwilerstrasse di Kesswil sarà chiusa dal 15 ottobre 2026 alle 7 al 18 ottobre alle 17. Traffico deviato e possibile rinvio per pioggia o freddo.',
    keywords: 'frontalieri, ticino, svizzera, italia, kesswil, uttwilerstrasse, chiusa, ottobre',
    ogTitle: 'Kesswil: Uttwilerstrasse chiusa dal 15 al 18 ottobre 2026',
    ogDescription: 'Dal 15 al 18 ottobre 2026 la Uttwilerstrasse di Kesswil sarà completamente chiusa per l\'asfalto finale e la marcatura sulla H13. Il traffico sarà deviato; piogge prolungate o freddo possono rinviare i lavori alla primavera 2027.',
    canonicalPath: '/articoli-turgovia/chiusura-strada-kesswil/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Kesswil: Uttwilerstrasse chiusa dal 15 al 18 ottobre 2026",
      "description": "La Uttwilerstrasse di Kesswil sarà chiusa dal 15 ottobre 2026 alle 7 al 18 ottobre alle 17. Traffico deviato e possibile rinvio per pioggia o freddo.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-chiusura-strada-kesswil.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-08T11:25:33+00:00",
      "dateModified": "2026-10-08T11:25:33+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/chiusura-strada-kesswil/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-turgovia-occupazione-rav-settembre': {
    title: 'Disoccupazione in Turgovia: quota stabile al 2,2%',
    description: 'Turgovia: 3.558 disoccupati a fine settembre, quota al 2,2%. Le persone in cerca d\'impiego sono 7.155; i posti vacanti salgono a 1.824, 236 in più ad agosto.',
    keywords: 'frontalieri, ticino, svizzera, italia, disoccupazione, turgovia, quota, stabile',
    ogTitle: 'Turgovia: disoccupazione stabile a settembre',
    ogDescription: 'Il rapporto di settembre in Turgovia registra 3.558 persone disoccupate e una quota ferma al 2,2%. Le persone in cerca d\'impiego sono 7.155; i posti vacanti salgono a 1.824, mentre i settori mostrano andamenti diversi.',
    canonicalPath: '/articoli-turgovia/turgovia-occupazione-rav-settembre/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Disoccupazione in Turgovia: quota stabile al 2,2%",
      "description": "Turgovia: 3.558 disoccupati a fine settembre, quota al 2,2%. Le persone in cerca d'impiego sono 7.155; i posti vacanti salgono a 1.824, 236 in più ad agosto.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-turgovia-occupazione-rav-settembre.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Centro regionale per l'impiego in Turgovia con annunci di lavoro"
      },
      "datePublished": "2026-10-08T11:37:03+00:00",
      "dateModified": "2026-10-08T11:37:03+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/turgovia-occupazione-rav-settembre/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

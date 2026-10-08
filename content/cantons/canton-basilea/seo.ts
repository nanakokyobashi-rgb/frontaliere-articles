// Metadati SEO degli articoli della sezione canton-basilea (Basilea).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-permessi-edilizi-digitali-basel': {
    title: 'Permessi edilizi a Basilea: solo digitali dal 2027',
    description: 'Dal 1° gennaio 2027 il Canton Basilea-Stadt renderà digitali tutte le domande edilizie: oggi è ancora possibile scegliere tra carta e formato digitale.',
    keywords: 'frontalieri, ticino, svizzera, italia, permessi, edilizi, basilea, solo',
    ogTitle: 'Basilea: permessi edilizi solo digitali dal 2027',
    ogDescription: 'La procedura edilizia di Basilea-Stadt è digitale da febbraio 2026, ma per ora resta possibile scegliere tra carta e formato digitale. Dal 1° gennaio 2027 il Bau- und Gastgewerbeinspektorat renderà obbligatorio l\'invio digitale per i Baugesuche.',
    canonicalPath: '/articoli-basilea/permessi-edilizi-digitali-basel/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Permessi edilizi a Basilea: solo digitali dal 2027",
      "description": "Dal 1° gennaio 2027 il Canton Basilea-Stadt renderà digitali tutte le domande edilizie: oggi è ancora possibile scegliere tra carta e formato digitale.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-permessi-edilizi-digitali-basel.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Domanda edilizia digitale su uno schermo in un ufficio di Basilea"
      },
      "datePublished": "2026-10-07T08:43:35+00:00",
      "dateModified": "2026-10-07T08:43:35+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-basilea/permessi-edilizi-digitali-basel/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-detrazioni-figli-basel': {
    title: 'Basilea Città: detrazioni figli quattro volte più alte',
    description: 'A Basilea Città un\'iniziativa propone di quadruplicare la detrazione fiscale per ogni figlio: la proposta riguarda i genitori del cantone sul piano fiscale.',
    keywords: 'frontalieri, ticino, svizzera, italia, basilea, città, detrazioni, figli',
    ogTitle: 'Basilea Città: detrazioni figli quattro volte più alte',
    ogDescription: 'Nel Canton Basilea Città un\'iniziativa propone di aumentare di quattro volte la detrazione fiscale per ogni figlio. Il titolo riguarda i genitori, ma non indica ancora importi in franchi, date o modalità di applicazione.',
    canonicalPath: '/articoli-basilea/detrazioni-figli-basel/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Basilea Città: detrazioni figli quattro volte più alte",
      "description": "A Basilea Città un'iniziativa propone di quadruplicare la detrazione fiscale per ogni figlio: la proposta riguarda i genitori del cantone sul piano fiscale.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/asilo-nido-e-custodia-bambini-canton-basilea-citta.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Genitori con figli in una scena urbana di Basilea Città sulle detrazioni fiscali"
      },
      "datePublished": "2026-10-07T11:11:39+00:00",
      "dateModified": "2026-10-07T11:11:39+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-basilea/detrazioni-figli-basel/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

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
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-detrazioni-figli-basel.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
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

  'blog-phishing-email-fisco-basel': {
    title: 'Canton Basilea: allerta per e-mail fiscali false',
    description: 'La Steuerverwaltung Basel-Stadt segnala false e-mail su rimborsi, solleciti e fatture fiscali: usare solo posta o eBill, senza aprire link o allegati.',
    keywords: 'frontalieri, ticino, svizzera, italia, canton, basilea, allerta, e-mail',
    ogTitle: 'Basilea: allerta per false e-mail fiscali',
    ogDescription: 'La frode usa falsi rimborsi, solleciti e fatture fiscali per imitare la Steuerverwaltung Basel-Stadt. La regola resta semplice: le comunicazioni autentiche arrivano per posta o eBill; le e-mail sospette vanno cancellate senza aprire link o allegati.',
    canonicalPath: '/articoli-basilea/phishing-email-fisco-basel/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Canton Basilea: allerta per e-mail fiscali false",
      "description": "La Steuerverwaltung Basel-Stadt segnala false e-mail su rimborsi, solleciti e fatture fiscali: usare solo posta o eBill, senza aprire link o allegati.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-phishing-email-fisco-basel.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Scrivania con e-mail fiscale sospetta, busta postale ed eBill a Basilea"
      },
      "datePublished": "2026-10-08T15:47:21+00:00",
      "dateModified": "2026-10-08T15:47:21+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-basilea/phishing-email-fisco-basel/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-tempo30-birsfelden-ottobre': {
    title: 'Tempo 30 a Birsfelden dal 12 ottobre 2026 | Frontaliere Ticino',
    description: 'Birsfelden introdurrà il Tempo 30 nel Baselbiet da ottobre 2026; Münchenstein dovrà attendere. Il titolo indica due tempi diversi per la misura locale.',
    keywords: 'frontalieri, ticino, svizzera, italia, tempo, birsfelden, ottobre, baselbiet',
    ogTitle: 'Birsfelden: Tempo 30 dal 12 ottobre 2026',
    ogDescription: 'Nel Baselbiet, Birsfelden passerà al Tempo 30 da ottobre 2026, mentre Münchenstein dovrà attendere. La notizia mette a confronto i tempi di attuazione nelle due località e aiuta a distinguere il calendario locale per gli spostamenti.',
    canonicalPath: '/articoli-basilea/tempo30-birsfelden-ottobre/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Tempo 30 a Birsfelden dal 12 ottobre 2026",
      "description": "Birsfelden introdurrà il Tempo 30 nel Baselbiet da ottobre 2026; Münchenstein dovrà attendere. Il titolo indica due tempi diversi per la misura locale.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-tempo30-birsfelden-ottobre.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-08T16:01:18+00:00",
      "dateModified": "2026-10-08T16:01:18+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-basilea/tempo30-birsfelden-ottobre/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-basel-klimpact-programma-2026': {
    title: 'Basel lancia Klimpact per un quotidiano più verde',
    description: 'Basel-Stadt avvia Klimpact per ridurre le emissioni. Dati aggiornati 2026 per frontalieri in Ticino.',
    keywords: 'frontalieri, ticino, svizzera, italia, basel, lancia, klimpact, quotidiano',
    ogTitle: 'Basel lancia Klimpact per un quotidiano più verde',
    ogDescription: 'Basel-Stadt avvia Klimpact per ridurre le emissioni.',
    canonicalPath: '/articoli-basilea/basel-klimpact-programma-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Basel lancia Klimpact per un quotidiano più verde",
      "description": "Basel-Stadt avvia Klimpact per ridurre le emissioni. Dati aggiornati 2026 per frontalieri in Ticino.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/varese-whp-programma-lombardia-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Cittadini di Basilea che usano biciclette e mercati locali in una via soleggiata"
      },
      "datePublished": "2026-10-09T21:07:09+00:00",
      "dateModified": "2026-10-09T21:07:09+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-basilea/basel-klimpact-programma-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-barfusserplatz-riqualificazione-urbana': {
    title: 'Barfüsserplatz, il difficile progetto di riqualificazione',
    description: 'La ristrutturazione di Barfüsserplatz a Basilea al centro del confronto sul paesaggio urbano: il giudizio della Commissione sulla qualità della futura piazza.',
    keywords: 'frontalieri, ticino, svizzera, italia, barfüsserplatz, difficile, progetto, riqualificazione',
    ogTitle: 'Barfüsserplatz, la sfida della riqualificazione urbana',
    ogDescription: 'Il rifacimento di Barfüsserplatz è al centro del confronto sul paesaggio urbano di Basilea. Il capo della Commissione giudica quasi impossibile creare una piazza davvero bella: la sfida è la qualità del risultato, non una semplice opera materiale.',
    canonicalPath: '/articoli-basilea/barfusserplatz-riqualificazione-urbana/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Barfüsserplatz, il difficile progetto di riqualificazione",
      "description": "La ristrutturazione di Barfüsserplatz a Basilea al centro del confronto sul paesaggio urbano: il giudizio della Commissione sulla qualità della futura piazza.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-barfusserplatz-riqualificazione-urbana.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Barfüsserplatz a Basilea in una scena sul progetto di riqualificazione urbana"
      },
      "datePublished": "2026-10-09T21:31:16+00:00",
      "dateModified": "2026-10-09T21:31:16+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-basilea/barfusserplatz-riqualificazione-urbana/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

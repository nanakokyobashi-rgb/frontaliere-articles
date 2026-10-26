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
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-basel-klimpact-programma-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
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

  'blog-basilea-larvicida-quattro-settimane': {
    title: 'Basilea, zanzara tigre: trattamenti ogni 4 settimane',
    description: 'Basel-Stadt: la tesi di Tim Kirrmann su 180 caditoie indica quattro settimane per il larvicida contro la zanzara tigre nel quartiere St. Johann di Basilea.',
    keywords: 'frontalieri, ticino, svizzera, italia, basilea, zanzara, tigre, trattamenti',
    ogTitle: 'Basilea: larvicida contro la zanzara tigre ogni 4 settimane',
    ogDescription: 'Nel quartiere St. Johann, Tim Kirrmann ha analizzato 180 caditoie trattate a intervalli diversi. Il risultato: quattro settimane è la cadenza ottimale per il larvicida VectoMax FG, già recepita dal Tiefbauamt.',
    canonicalPath: '/articoli-basilea/basilea-larvicida-quattro-settimane/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Basilea, zanzara tigre: trattamenti ogni 4 settimane",
      "description": "Basel-Stadt: la tesi di Tim Kirrmann su 180 caditoie indica quattro settimane per il larvicida contro la zanzara tigre nel quartiere St. Johann di Basilea.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-basilea-larvicida-quattro-settimane.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-11T00:07:19+00:00",
      "dateModified": "2026-10-11T00:07:19+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-basilea/basilea-larvicida-quattro-settimane/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-claraplatz-basel-cantieri': {
    title: 'Basilea, cantieri a Claraplatz: negozi in difficoltà',
    description: 'A Claraplatz a Basilea i cantieri causano cali di fatturato fino al 40% per i negozi. Lavori previsti fino al 2028 e ipotesi di un fondo di sostegno.',
    keywords: 'frontalieri, ticino, svizzera, italia, basilea, cantieri, claraplatz, negozi',
    ogTitle: 'Basilea, cantieri a Claraplatz: negozi in difficoltà e calo di fatturato',
    ogDescription: 'I cantieri tra Claraplatz e la Kaserne a Basilea mettono in difficoltà i negozi locali con cali di fatturato e disagi fino alla primavera 2028.',
    canonicalPath: '/articoli-basilea/claraplatz-basel-cantieri/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Basilea, cantieri a Claraplatz: negozi in difficoltà",
      "description": "A Claraplatz a Basilea i cantieri causano cali di fatturato fino al 40% per i negozi. Lavori previsti fino al 2028 e ipotesi di un fondo di sostegno.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-claraplatz-basel-cantieri.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-11T00:21:48+00:00",
      "dateModified": "2026-10-11T00:21:48+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-basilea/claraplatz-basel-cantieri/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-basilea-cantieri-alle-sei': {
    title: 'Parlamento di Basilea: mozione per iniziare i cantieri alle 6',
    description: 'Il Gran Consiglio di Basilea ha trasmesso una mozione per consentire lavori edili alle 6 da giugno ad agosto; quelli rumorosi resterebbero dalle 7.',
    keywords: 'frontalieri, ticino, svizzera, italia, parlamento, basilea, mozione, iniziare',
    ogTitle: 'Basilea: mozione, cantieri alle 6, lavori rumorosi alle 7',
    ogDescription: 'La mozione di Luca Urgese (FDP) è stata trasmessa con 84 voti contro 8 e 4 astensioni. Chiede di modificare l\'ordinanza sulla protezione dal rumore: lavori edili alle 6 nei giorni feriali da giugno ad agosto, attività rumorose dalle 7.',
    canonicalPath: '/articoli-basilea/basilea-cantieri-alle-sei/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Parlamento di Basilea: mozione per iniziare i cantieri alle 6",
      "description": "Il Gran Consiglio di Basilea ha trasmesso una mozione per consentire lavori edili alle 6 da giugno ad agosto; quelli rumorosi resterebbero dalle 7.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-basilea-cantieri-alle-sei.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-23T02:22:16+00:00",
      "dateModified": "2026-10-23T02:22:16+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-basilea/basilea-cantieri-alle-sei/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-domande-edilizie-solo-digitale-2027': {
    title: 'Domande edilizie solo digitali dal 1° gennaio 2027 nel Canton Basilea',
    description: 'Dal 1° gennaio 2027 le domande edilizie nel Canton Basilea Città devono essere solo digitali. Il procedimento è digitale da febbraio 2026.',
    keywords: 'frontalieri, ticino, svizzera, italia, domande, edilizie, solo, digitali',
    ogTitle: 'Domande edilizie solo digitali dal 1° gennaio 2027',
    ogDescription: 'Il Bau- und Gastgewerbeinspektorat ha comunicato che dal 1° gennaio 2027 le domande di autorizzazione edilizia dovranno essere presentate solo digitalmente nel Canton Basilea Città.',
    canonicalPath: '/articoli-basilea/domande-edilizie-solo-digitale-2027/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Domande edilizie solo digitali dal 1° gennaio 2027 nel Canton Basilea",
      "description": "Dal 1° gennaio 2027 le domande edilizie nel Canton Basilea Città devono essere solo digitali. Il procedimento è digitale da febbraio 2026.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-domande-edilizie-solo-digitale-2027.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-23T21:50:50+00:00",
      "dateModified": "2026-10-23T21:50:50+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-basilea/domande-edilizie-solo-digitale-2027/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-basel-stadt-siti-online-di-nuoto': {
    title: 'Canton Basilea Città riattiva siti dopo panne tecnico',
    description: 'Il Canton Basilea Città riattiva progressivamente i siti e le applicazioni dopo una vulnerabilità PHP. Nessun incidente di sicurezza rilevante è stato',
    keywords: 'frontalieri, ticino, svizzera, italia, canton, basilea, città, riattiva',
    ogTitle: 'Basilea Città: siti web riattivati dopo panne tecnico',
    ogDescription: 'Il Canton Basilea Città ripristina i servizi online in modo progressivo dopo un problema tecnico legato a PHP. Confermata l\'assenza di incidenti di sicurezza rilevanti.',
    canonicalPath: '/articoli-basilea/basel-stadt-siti-online-di-nuoto/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Canton Basilea Città riattiva siti dopo panne tecnico",
      "description": "Il Canton Basilea Città riattiva progressivamente i siti e le applicazioni dopo una vulnerabilità PHP. Nessun incidente di sicurezza rilevante è stato",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-basel-stadt-siti-online-di-nuoto.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-25T05:03:14+00:00",
      "dateModified": "2026-10-25T05:03:14+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-basilea/basel-stadt-siti-online-di-nuoto/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-salario-minimo-basilea-2027': {
    title: 'Salario minimo Basilea aumenta a 22.50 CHF lordi dal 2027',
    description: 'Dal 1° gennaio 2027 il minimo sarà 22,50 CHF lordi L’aumento previsto è di 30 centesimi per ora L’adeguamento segue l’indice misto svizzero Cantone →',
    keywords: 'frontalieri, ticino, svizzera, italia, salario, minimo, basilea, aumenta',
    ogTitle: 'Salario minimo Basilea 2027: 22.50 CHF all\'ora',
    ogDescription: 'Dal 1° gennaio 2027 il minimo sarà 22,50 CHF lordi L’aumento previsto è di 30 centesimi per ora L’adeguamento segue l’indice misto svizzero Cantone →',
    canonicalPath: '/articoli-basilea/salario-minimo-basilea-2027/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Salario minimo Basilea aumenta a 22.50 CHF lordi dal 2027",
      "description": "Dal 1° gennaio 2027 il minimo sarà 22,50 CHF lordi L’aumento previsto è di 30 centesimi per ora L’adeguamento segue l’indice misto svizzero Cantone →",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-salario-minimo-basilea-2027.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-26T11:06:00+00:00",
      "dateModified": "2026-10-26T11:06:00+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-basilea/salario-minimo-basilea-2027/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

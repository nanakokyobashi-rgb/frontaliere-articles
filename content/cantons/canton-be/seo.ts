// Metadati SEO degli articoli della sezione canton-be (Berna).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-simplificazione-imposta-trasferimento-berna': {
    title: 'Imposta trasferimenti Berna: franchigia 800k | Frontaliere Ticino',
    description: 'Il Governo di Berna propone di allentare le regole sull\'uso esclusivo e di introdurre il rimborso entro 4 anni. Franchigia di 800.000 CHF confermata.',
    keywords: 'frontalieri, ticino, svizzera, italia, imposta, trasferimenti, berna, franchigia',
    ogTitle: 'Imposta trasferimenti Berna: franchigia 800k',
    ogDescription: 'Il Governo cantonale di Berna propone una revisione della legge sull\'imposta di trasferimento. La franchigia resta a 800.000 CHF, ma l\'uso esclusivo non è più obbligatorio. Scopri i nuovi termini per il rimborso e le scadenze della consultazione',
    canonicalPath: '/articoli-berna/simplificazione-imposta-trasferimento-berna/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Imposta trasferimenti Berna: franchigia 800k",
      "description": "Il Governo di Berna propone di allentare le regole sull'uso esclusivo e di introdurre il rimborso entro 4 anni. Franchigia di 800.000 CHF confermata.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-simplificazione-imposta-trasferimento-berna.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Edificio abitativo a Berna con piano architettonico in mano"
      },
      "datePublished": "2026-10-07T06:54:25+00:00",
      "dateModified": "2026-10-07T06:54:25+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/simplificazione-imposta-trasferimento-berna/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-wabern-tram-risanamento': {
    title: 'Approvati il tram di Kleinwabern e il risanamento di Wabern',
    description: 'Il BAV ha approvato tram e risanamento a Wabern: linea 9 fino a Kleinwabern, nodo tra S-Bahn, bus e tram, lavori non prima del 2028, ricorso in corso.',
    keywords: 'frontalieri, ticino, svizzera, italia, approvati, tram, kleinwabern, risanamento',
    ogTitle: 'Tram Kleinwabern approvato: lavori non prima del 2028',
    ogDescription: '«Tram Kleinwabern» estenderà la linea 9 fino a Kleinwabern e creerà un nodo con S-Bahn, bus e tram. «Sanierung Zentrum Wabern» prevede il risanamento della Seftigenstrasse per ciclisti e pedoni; i lavori partiranno non prima del 2028.',
    canonicalPath: '/articoli-berna/wabern-tram-risanamento/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Approvati il tram di Kleinwabern e il risanamento di Wabern",
      "description": "Il BAV ha approvato tram e risanamento a Wabern: linea 9 fino a Kleinwabern, nodo tra S-Bahn, bus e tram, lavori non prima del 2028, ricorso in corso.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-wabern-tram-risanamento.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Progetti del tram di Kleinwabern e risanamento del centro di Wabern"
      },
      "datePublished": "2026-10-07T07:11:43+00:00",
      "dateModified": "2026-10-07T07:11:43+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/wabern-tram-risanamento/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-disoccupazione-berna-settembre-2026-stabile': {
    title: 'Disoccupazione stabile a Berna settembre 2026: +78 persone',
    description: 'A settembre 2026 il Canton Berna conta 12.208 disoccupati (+78), tasso 2,2%, giovani 1.435 (-11), settore alberghiero +64, sanitario +35, MEM -50.',
    keywords: 'frontalieri, ticino, svizzera, italia, disoccupazione, stabile, berna, settembre',
    ogTitle: 'Disoccupazione stabile a Berna settembre 2026: +78 persone',
    ogDescription: 'A settembre 2026 il Canton Berna conta 12.208 disoccupati (+78), tasso 2,2%, giovani 1.435 (-11), settore alberghiero +64, sanitario +35, MEM -50.',
    canonicalPath: '/articoli-berna/disoccupazione-berna-settembre-2026-stabile/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Disoccupazione stabile a Berna settembre 2026: +78 persone",
      "description": "A settembre 2026 il Canton Berna conta 12.208 disoccupati (+78), tasso 2,2%, giovani 1.435 (-11), settore alberghiero +64, sanitario +35, MEM -50.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-disoccupazione-berna-settembre-2026-stabile.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-07T19:58:52+00:00",
      "dateModified": "2026-10-07T19:58:52+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/disoccupazione-berna-settembre-2026-stabile/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-ipsach-gru-linea-strada': {
    title: 'Ipsach: cede una gru, chiuse ferrovia e strada',
    description: 'Incidente a Ipsach il 6 ottobre 2026: una gru cade su ferrovia e strada. Chiusa la linea Nidau-Sutz-Lattrigen, bus sostitutivi e deviazioni stradali attive.',
    keywords: 'frontalieri, ticino, svizzera, italia, ipsach, cede, chiuse, ferrovia',
    ogTitle: 'Ipsach: cede una gru, chiuse ferrovia e strada',
    ogDescription: 'La gru di un cantiere si è piegata sulla Hauptstrasse 63 di Ipsach, colpendo un edificio, la ferrovia e la strada. La linea tra Nidau e Sutz-Lattrigen è chiusa; bus sostitutivi tra Nidau e Lattrigen e deviazione via Bellmund e Sutz-Lattrigen.',
    canonicalPath: '/articoli-berna/ipsach-gru-linea-strada/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Ipsach: cede una gru, chiuse ferrovia e strada",
      "description": "Incidente a Ipsach il 6 ottobre 2026: una gru cade su ferrovia e strada. Chiusa la linea Nidau-Sutz-Lattrigen, bus sostitutivi e deviazioni stradali attive.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-ipsach-gru-linea-strada.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Gru da cantiere caduta su ferrovia e strada a Ipsach"
      },
      "datePublished": "2026-10-08T19:26:56+00:00",
      "dateModified": "2026-10-08T19:26:56+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/ipsach-gru-linea-strada/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-berna-familiari-curanti-incontro': {
    title: 'Berna invita i familiari curanti a un incontro',
    description: 'Il Canton Berna invita i familiari curanti a uno scambio e a un incontro: il titolo presenta l\'iniziativa e il pubblico a cui si rivolge nel Canton Berna.',
    keywords: 'frontalieri, ticino, svizzera, italia, berna, invita, familiari, curanti',
    ogTitle: 'Berna: incontro per familiari curanti',
    ogDescription: 'La comunicazione del Canton Berna si rivolge ai familiari curanti e presenta un momento di scambio e incontro. Il contenuto disponibile resta concentrato su questo invito e non aggiunge indicazioni organizzative.',
    canonicalPath: '/articoli-berna/berna-familiari-curanti-incontro/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Berna invita i familiari curanti a un incontro",
      "description": "Il Canton Berna invita i familiari curanti a uno scambio e a un incontro: il titolo presenta l'iniziativa e il pubblico a cui si rivolge nel Canton Berna.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-berna-familiari-curanti-incontro.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-09T06:53:22+00:00",
      "dateModified": "2026-10-09T06:53:22+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/berna-familiari-curanti-incontro/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-cyberattacco-casse-pensione-berna': {
    title: 'Cyberattacco alla fornitrice delle casse pensioni bernesi',
    description: 'Fornitrice software di BPK e BLVK colpita a fine settembre: la Procura federale indaga. Nessuna indicazione di dati rubati, ma l\'esclusione non è completa.',
    keywords: 'frontalieri, ticino, svizzera, italia, cyberattacco, alla, fornitrice, casse',
    ogTitle: 'Cyberattacco alla fornitrice delle casse pensioni bernesi',
    ogDescription: 'Una fornitrice esterna di software di BPK e BLVK è stata attaccata a fine settembre. La Procura federale indaga. Al momento non ci sono indicazioni di dati rubati, ma l\'ipotesi non è completamente esclusa: le casse informeranno se confermata.',
    canonicalPath: '/articoli-berna/cyberattacco-casse-pensione-berna/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Cyberattacco alla fornitrice delle casse pensioni bernesi",
      "description": "Fornitrice software di BPK e BLVK colpita a fine settembre: la Procura federale indaga. Nessuna indicazione di dati rubati, ma l'esclusione non è completa.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-cyberattacco-casse-pensione-berna.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Edificio amministrativo nel Canton Berna legato alla previdenza professionale"
      },
      "datePublished": "2026-10-09T23:26:36+00:00",
      "dateModified": "2026-10-09T23:26:36+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/laura-bianchi/#person",
        "name": "Laura Bianchi",
        "url": "https://frontaliereticino.ch/autori/laura-bianchi/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/cyberattacco-casse-pensione-berna/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-traffico-berna-manifestazione': {
    title: 'Berna: possibili disagi per manifestazione non autorizzata',
    description: 'Berna segnala possibili chiusure stradali e disagi domenica 11 ottobre 2026 per una manifestazione non autorizzata: indicazioni per chi viaggia in città.',
    keywords: 'frontalieri, ticino, svizzera, italia, berna, possibili, disagi, manifestazione',
    ogTitle: 'Berna: possibili disagi per manifestazione non autorizzata',
    ogDescription: 'La Polizia cantonale bernese annuncia un dispositivo di sicurezza per domenica 11 ottobre 2026. Nel pomeriggio e in serata sono possibili chiusure temporanee, rallentamenti e deviazioni del trasporto pubblico: Bernmobil fornirà gli aggiornamenti.',
    canonicalPath: '/articoli-berna/traffico-berna-manifestazione/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Berna: possibili disagi per manifestazione non autorizzata",
      "description": "Berna segnala possibili chiusure stradali e disagi domenica 11 ottobre 2026 per una manifestazione non autorizzata: indicazioni per chi viaggia in città.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-traffico-berna-manifestazione.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Strade di Berna con possibili limitazioni del traffico domenica 11 ottobre 2026"
      },
      "datePublished": "2026-10-10T07:15:47+00:00",
      "dateModified": "2026-10-10T07:15:47+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/traffico-berna-manifestazione/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-berna-tassa-ecclesiastica': {
    title: 'Berna mantiene la tassa ecclesiastica per le imprese',
    description: 'Il Governo bernese ha preso atto della petizione per rendere volontaria la tassa ecclesiastica delle persone giuridiche. Il Gran Consiglio la mantiene.',
    keywords: 'frontalieri, ticino, svizzera, italia, berna, mantiene, tassa, ecclesiastica',
    ogTitle: 'Tassa ecclesiastica: Berna mantiene la forma attuale',
    ogDescription: 'La petizione chiedeva di rendere volontaria la tassa ecclesiastica per le persone giuridiche nel Canton Berna. Il Governo ha mostrato comprensione, ma richiama la decisione del Gran Consiglio nella sessione autunnale 2026: la forma attuale resta.',
    canonicalPath: '/articoli-berna/berna-tassa-ecclesiastica/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Berna mantiene la tassa ecclesiastica per le imprese",
      "description": "Il Governo bernese ha preso atto della petizione per rendere volontaria la tassa ecclesiastica delle persone giuridiche. Il Gran Consiglio la mantiene.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-berna-tassa-ecclesiastica.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Edificio istituzionale nel Canton Berna sul tema della tassa ecclesiastica"
      },
      "datePublished": "2026-10-19T06:36:37+00:00",
      "dateModified": "2026-10-19T06:36:37+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/berna-tassa-ecclesiastica/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-amministrazione-fiscale-berna-chiusura-2026': {
    title: 'Amministrazione fiscale Berna: chiusura dal 23 ottobre al 1 novembre 2026',
    description: 'Chiusura temporanea per l\'Amministrazione fiscale del Canton Berna dal 23 ottobre al 1 novembre 2026. Scadenza dichiarazione 2025 prorogata al 30 novembre.',
    keywords: 'frontalieri, ticino, svizzera, italia, amministrazione, fiscale, berna, chiusura',
    ogTitle: 'Amministrazione fiscale Berna: chiusura servizi e proroga dichiarazione 2025',
    ogDescription: 'Scopri le date dell\'interruzione programmata dei servizi dell\'Amministrazione fiscale del Canton Berna dal 23 ottobre al 1 novembre 2026 e la proroga della dichiarazione al 30 novembre.',
    canonicalPath: '/articoli-berna/amministrazione-fiscale-berna-chiusura-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Amministrazione fiscale Berna: chiusura dal 23 ottobre al 1 novembre 2026",
      "description": "Chiusura temporanea per l'Amministrazione fiscale del Canton Berna dal 23 ottobre al 1 novembre 2026. Scadenza dichiarazione 2025 prorogata al 30 novembre.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-amministrazione-fiscale-berna-chiusura-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Amministrazione fiscale del Canton Berna durante la chiusura temporanea"
      },
      "datePublished": "2026-10-19T06:59:44+00:00",
      "dateModified": "2026-10-19T06:59:44+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/amministrazione-fiscale-berna-chiusura-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-berna-governo-kita-gratuite': {
    title: 'Berna, il Governo respinge le Kita gratuite | Frontaliere Ticino',
    description: 'Il Governo bernese respinge le Kita gratuite: la gratuità costerebbe oltre 160 milioni CHF annui a Cantone e Comuni per gli attuali beneficiari dei buoni.',
    keywords: 'frontalieri, ticino, svizzera, italia, berna, governo, respinge, kita',
    ogTitle: 'Berna, il Governo respinge le Kita gratuite',
    ogDescription: 'La risposta del Governo bernese a una mozione di SP e Verdi descrive il confronto tra buoni per la custodia legati al reddito e gratuità delle Kita. La cifra indicata per Cantone e Comuni supera 160 milioni CHF l\'anno.',
    canonicalPath: '/articoli-berna/berna-governo-kita-gratuite/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Berna, il Governo respinge le Kita gratuite",
      "description": "Il Governo bernese respinge le Kita gratuite: la gratuità costerebbe oltre 160 milioni CHF annui a Cantone e Comuni per gli attuali beneficiari dei buoni.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-berna-governo-kita-gratuite.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-19T18:54:07+00:00",
      "dateModified": "2026-10-19T18:54:07+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/berna-governo-kita-gratuite/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-corridoio-linea-wynigen': {
    title: 'Swissgrid pianifica una linea aerea tra Berna e Lucerna',
    description: 'Swissgrid indica il corridoio per sostituire la linea quasi centenaria tra Berna e Lucerna: consultazione di 30 giorni e decisione attesa entro metà 2027.',
    keywords: 'frontalieri, ticino, svizzera, italia, swissgrid, pianifica, linea, aerea',
    ogTitle: 'Swissgrid: piano per la linea tra Berna e Lucerna',
    ogDescription: 'Il progetto prevede una linea aerea tra le sottostazioni di Bickigen BE e Mettlen LU, usando soprattutto spazi infrastrutturali esistenti. La consultazione pubblica durerà 30 giorni; il corridoio definitivo è atteso entro metà 2027.',
    canonicalPath: '/articoli-berna/corridoio-linea-wynigen/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Swissgrid pianifica una linea aerea tra Berna e Lucerna",
      "description": "Swissgrid indica il corridoio per sostituire la linea quasi centenaria tra Berna e Lucerna: consultazione di 30 giorni e decisione attesa entro metà 2027.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-corridoio-linea-wynigen.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-20T02:20:36+00:00",
      "dateModified": "2026-10-20T02:20:36+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/corridoio-linea-wynigen/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-voto-comunale-stranieri-berna': {
    title: 'Commissione Berna: voto comunale facoltativo per stranieri',
    description: 'La SAK bernese appoggia il voto comunale volontario per stranieri con permesso di domicilio e lunga residenza. Decidono i comuni. Anche nuova regola',
    keywords: 'frontalieri, ticino, svizzera, italia, commissione, berna, voto, comunale',
    ogTitle: 'Berna: commissione per voto comunale facoltativo agli stranieri integrati',
    ogDescription: 'La maggioranza della commissione cantonale propone ai comuni di Berna la facoltà di concedere il voto locale a stranieri con permesso di domicilio residenti da 10 anni in Svizzera, 5 nel Cantone e 3 mesi nel comune. Il diritto varrebbe solo',
    canonicalPath: '/articoli-berna/voto-comunale-stranieri-berna/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Commissione Berna: voto comunale facoltativo per stranieri",
      "description": "La SAK bernese appoggia il voto comunale volontario per stranieri con permesso di domicilio e lunga residenza. Decidono i comuni. Anche nuova regola",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-voto-comunale-stranieri-berna.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-20T22:00:47+00:00",
      "dateModified": "2026-10-20T22:00:47+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/voto-comunale-stranieri-berna/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-weissenbach-incidente-quattro-auto': {
    title: 'Weissenbach: cinque feriti nello scontro tra quattro auto',
    description: 'A Weissenbach, nel Comune di Boltigen, quattro auto sono state coinvolte in collisioni: cinque feriti e strada chiusa per quasi due ore.',
    keywords: 'frontalieri, ticino, svizzera, italia, weissenbach, cinque, feriti, nello',
    ogTitle: 'Incidente a Weissenbach: cinque feriti',
    ogDescription: 'Lunedì 19 ottobre 2026, poco dopo le 16.30, un\'auto ha invaso la corsia opposta a Weissenbach. Quattro auto sono state coinvolte, cinque persone ferite e la strada principale è rimasta chiusa per quasi due ore.',
    canonicalPath: '/articoli-berna/weissenbach-incidente-quattro-auto/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Weissenbach: cinque feriti nello scontro tra quattro auto",
      "description": "A Weissenbach, nel Comune di Boltigen, quattro auto sono state coinvolte in collisioni: cinque feriti e strada chiusa per quasi due ore.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-weissenbach-incidente-quattro-auto.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-20T22:21:08+00:00",
      "dateModified": "2026-10-20T22:21:08+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/weissenbach-incidente-quattro-auto/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-berna-stato-pagina-non-disponibile': {
    title: 'Stato della pagina dell\'amministrazione bernese',
    description: 'Il contenuto della pagina web indicata non è disponibile. Non sono verificabili date o modalità operative per i servizi dell\'amministrazione',
    keywords: 'frontalieri, ticino, svizzera, italia, stato, pagina, dell, amministrazione',
    ogTitle: 'Stato della pagina dell\'amministrazione bernese',
    ogDescription: 'Il contenuto della pagina web indicata non è disponibile. Non sono verificabili date o modalità operative per i servizi dell\'amministrazione cantonale nel 2026.',
    canonicalPath: '/articoli-berna/berna-stato-pagina-non-disponibile/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Stato della pagina dell'amministrazione bernese",
      "description": "Il contenuto della pagina web indicata non è disponibile. Non sono verificabili date o modalità operative per i servizi dell'amministrazione",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-berna-stato-pagina-non-disponibile.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-21T02:11:38+00:00",
      "dateModified": "2026-10-21T02:11:38+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/berna-stato-pagina-non-disponibile/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-kurzarbeit-regole-ordinarie': {
    title: 'Consiglio federale: Kurzarbeit verso il regime ordinario',
    description: 'Il Consiglio federale prepara il ritorno graduale al regime ordinario: Kurzarbeit da 24 a 12 mesi e Karenzzeit da un giorno a un massimo di tre',
    keywords: 'frontalieri, ticino, svizzera, italia, consiglio, federale, kurzarbeit, verso',
    ogTitle: 'Kurzarbeit verso il regime ordinario',
    ogDescription: 'Il Consiglio federale collega il ritorno graduale alle migliori prospettive economiche. Oggi la Kurzarbeit può durare 24 mesi e la Karenzzeit è di un giorno; il regime ordinario prevede 12 mesi e fino a tre giorni.',
    canonicalPath: '/articoli-berna/kurzarbeit-regole-ordinarie/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Consiglio federale: Kurzarbeit verso il regime ordinario",
      "description": "Il Consiglio federale prepara il ritorno graduale al regime ordinario: Kurzarbeit da 24 a 12 mesi e Karenzzeit da un giorno a un massimo di tre",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-kurzarbeit-regole-ordinarie.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-21T15:33:53+00:00",
      "dateModified": "2026-10-21T15:33:53+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/kurzarbeit-regole-ordinarie/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-primo-adeguamento-lpp-superstiti-e-invalidita-2-1-1-1-2': {
    title: 'Primo adeguamento LPP superstiti e invalidità: 2,1%, 1%, 1,2%',
    description: 'Aumento 2,1% per rendite dal 2023, 1% per prima rivalutazione 2026, 1,2% per ultima modifica 2025.',
    keywords: 'frontalieri, ticino, svizzera, italia, primo, adeguamento, superstiti, invalidità',
    ogTitle: 'Primo adeguamento LPP superstiti e invalidità: 2,1%, 1%',
    ogDescription: 'Aumento 2,1% per rendite dal 2023, 1% per prima rivalutazione 2026, 1,2% per ultima modifica 2025.',
    canonicalPath: '/articoli-berna/primo-adeguamento-lpp-superstiti-e-invalidita-2-1-1-1-2/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Primo adeguamento LPP superstiti e invalidità: 2,1%, 1%, 1,2%",
      "description": "Aumento 2,1% per rendite dal 2023, 1% per prima rivalutazione 2026, 1,2% per ultima modifica 2025.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-primo-adeguamento-lpp-superstiti-e-invalidita-2-1-1-1-2.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-22T12:06:19+00:00",
      "dateModified": "2026-10-22T12:06:19+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/primo-adeguamento-lpp-superstiti-e-invalidita-2-1-1-1-2/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-energy-tagli-radio-svizzera': {
    title: 'Gruppo radiofonico: annunciati fino a 15 tagli in Svizzera',
    description: 'Energy annuncia fino a 15 tagli in Svizzera: il numero sarà deciso dopo la consultazione, mentre programma e organizzazione saranno adeguati.',
    keywords: 'frontalieri, ticino, svizzera, italia, gruppo, radiofonico, annunciati, fino',
    ogTitle: 'Energy: fino a 15 tagli, decisione dopo la consultazione',
    ogDescription: 'Energy, con sedi a Basilea, Berna e Zurigo, ha annunciato fino a 15 tagli. La consultazione è in corso: il numero definitivo dipenderà dalle proposte dei dipendenti. Il gruppo segnala ricavi pubblicitari sotto pressione nonostante ascolti elevati',
    canonicalPath: '/articoli-berna/energy-tagli-radio-svizzera/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Gruppo radiofonico: annunciati fino a 15 tagli in Svizzera",
      "description": "Energy annuncia fino a 15 tagli in Svizzera: il numero sarà deciso dopo la consultazione, mentre programma e organizzazione saranno adeguati.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-energy-tagli-radio-svizzera.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-22T12:35:58+00:00",
      "dateModified": "2026-10-22T12:35:58+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/energy-tagli-radio-svizzera/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-contributi-rotbach-saanen': {
    title: 'Berna approva contributi per Rotbach e Saanen | Frontaliere Ticino',
    description: 'Il Governo bernese approva circa CHF 590\'000 per il Rotbach e CHF 720\'000 per la protezione dalle piene a Saanen, nel Canton Berna.',
    keywords: 'frontalieri, ticino, svizzera, italia, berna, approva, contributi, rotbach',
    ogTitle: 'Berna: contributi per Rotbach e Saanen',
    ogDescription: 'Il Governo cantonale ha approvato circa CHF 590\'000 per la rivitalizzazione del Rotbach tra Dürrenroth e Walterswil e circa CHF 720\'000 per la protezione dalle piene di Louibach e Turpachbach a Saanen.',
    canonicalPath: '/articoli-berna/contributi-rotbach-saanen/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Berna approva contributi per Rotbach e Saanen",
      "description": "Il Governo bernese approva circa CHF 590'000 per il Rotbach e CHF 720'000 per la protezione dalle piene a Saanen, nel Canton Berna.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-contributi-rotbach-saanen.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-23T02:11:10+00:00",
      "dateModified": "2026-10-23T02:11:10+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/contributi-rotbach-saanen/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-nuove-funzioni-piano-digitale': {
    title: 'Nuove funzioni nel piano digitale della città di Berna',
    description: 'Dal 26 ottobre 2026 nuovi contenuti nel piano digitale Nomi ufficiali visibili sotto «Nomenclatura» Download gratuito dal Geoportale della città',
    keywords: 'frontalieri, ticino, svizzera, italia, nuove, funzioni, piano, digitale',
    ogTitle: 'Nuove funzioni piano digitale Berna',
    ogDescription: 'Dal 26 ottobre 2026 nuovi contenuti nel piano digitale Nomi ufficiali visibili sotto «Nomenclatura» Download gratuito dal Geoportale della città Aggiornati nomi',
    canonicalPath: '/articoli-berna/nuove-funzioni-piano-digitale/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Nuove funzioni nel piano digitale della città di Berna",
      "description": "Dal 26 ottobre 2026 nuovi contenuti nel piano digitale Nomi ufficiali visibili sotto «Nomenclatura» Download gratuito dal Geoportale della città",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-nuove-funzioni-piano-digitale.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-27T01:42:07+00:00",
      "dateModified": "2026-10-27T01:42:07+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-berna/nuove-funzioni-piano-digitale/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

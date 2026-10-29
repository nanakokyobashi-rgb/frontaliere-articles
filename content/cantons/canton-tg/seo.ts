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

  'blog-aadorf-spese-sociali-2027': {
    title: 'Aadorf: fine status S, più spese sociali nel 2027',
    description: 'Aadorf: il budget 2027 prevede costi sociali nettamente più alti e maggiori entrate fiscali. La fine dei contributi federali per gli ucraini può pesare ancora.',
    keywords: 'frontalieri, ticino, svizzera, italia, aadorf, fine, status, spese',
    ogTitle: 'Aadorf: fine status S, più spese sociali nel 2027',
    ogDescription: 'Il budget 2027 di Aadorf combina due segnali: costi sociali nettamente più alti e maggiori entrate fiscali. Il venir meno dei contributi federali per le persone ucraine potrà incidere ancora di più sulle spese future del comune.',
    canonicalPath: '/articoli-turgovia/aadorf-spese-sociali-2027/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Aadorf: fine status S, più spese sociali nel 2027",
      "description": "Aadorf: il budget 2027 prevede costi sociali nettamente più alti e maggiori entrate fiscali. La fine dei contributi federali per gli ucraini può pesare ancora.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-aadorf-spese-sociali-2027.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Municipio e centro di Aadorf, nel Canton Turgovia, in una giornata autunnale"
      },
      "datePublished": "2026-10-09T15:46:11+00:00",
      "dateModified": "2026-10-09T15:46:11+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/marco-ferrari/#person",
        "name": "Marco Ferrari",
        "url": "https://frontaliereticino.ch/autori/marco-ferrari/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/aadorf-spese-sociali-2027/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-sicurezza-lavoro-turgovia-regole': {
    title: 'Sicurezza e salute sul lavoro nel Canton Turgovia',
    description: 'La sicurezza sul lavoro previene infortuni e malattie professionali. Dati aggiornati 2026 per frontalieri in Ticino.',
    keywords: 'frontalieri, ticino, svizzera, italia, sicurezza, salute, lavoro, canton',
    ogTitle: 'Sicurezza e salute sul lavoro nel Canton Turgovia',
    ogDescription: 'La sicurezza sul lavoro previene infortuni e malattie professionali.',
    canonicalPath: '/articoli-turgovia/sicurezza-lavoro-turgovia-regole/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Sicurezza e salute sul lavoro nel Canton Turgovia",
      "description": "La sicurezza sul lavoro previene infortuni e malattie professionali. Dati aggiornati 2026 per frontalieri in Ticino.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-sicurezza-lavoro-turgovia-regole.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-09T16:02:21+00:00",
      "dateModified": "2026-10-09T16:02:21+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/laura-bianchi/#person",
        "name": "Laura Bianchi",
        "url": "https://frontaliereticino.ch/autori/laura-bianchi/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/sicurezza-lavoro-turgovia-regole/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-servizi-imprese-turgovia-rav': {
    title: 'Lavoro in Turgovia: aiuto alle imprese e permessi',
    description: 'Tre RAV in Turgovia aiutano le imprese a trovare personale. Offerte gratuite su arbeit.swiss e consulenza su permessi, lavoro ridotto e tutela sul lavoro.',
    keywords: 'frontalieri, ticino, svizzera, italia, lavoro, turgovia, aiuto, alle',
    ogTitle: 'Turgovia: servizi RAV per imprese e permessi',
    ogDescription: 'Amriswil, Frauenfeld e Kreuzlingen sono le tre sedi RAV per aiutare le imprese a trovare personale. La consulenza copre autorizzazioni, lavoro ridotto, maltempo, tutela sul lavoro, rumore, libera circolazione, procedure di notifica e lavoro nero.',
    canonicalPath: '/articoli-turgovia/servizi-imprese-turgovia-rav/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Lavoro in Turgovia: aiuto alle imprese e permessi",
      "description": "Tre RAV in Turgovia aiutano le imprese a trovare personale. Offerte gratuite su arbeit.swiss e consulenza su permessi, lavoro ridotto e tutela sul lavoro.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-servizi-imprese-turgovia-rav.webp`,
        "width": 1200,
        "height": 675,
        "caption": "RAV e servizi per i datori di lavoro nel Canton Turgovia"
      },
      "datePublished": "2026-10-12T00:12:21+00:00",
      "dateModified": "2026-10-12T00:12:21+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/servizi-imprese-turgovia-rav/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-sportello-digitale-turgovia': {
    title: 'Turgovia: Sportello digitale per pratiche e documenti',
    description: 'Lo Sportello digitale del Canton Turgovia raccoglie i servizi più usati, offre informazioni e video brevi e riunisce documenti e permessi in un\'area protetta.',
    keywords: 'frontalieri, ticino, svizzera, italia, turgovia, sportello, digitale, pratiche',
    ogTitle: 'Turgovia, Sportello digitale per pratiche e documenti',
    ogDescription: 'Il portale Digitaler Schalter raccoglie i servizi più usati per ordini e domande, offre informazioni sul servizio, brevi video sulle domande più importanti e un\'area protetta con estratti, permessi e altri documenti da consultare.',
    canonicalPath: '/articoli-turgovia/sportello-digitale-turgovia/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Turgovia: Sportello digitale per pratiche e documenti",
      "description": "Lo Sportello digitale del Canton Turgovia raccoglie i servizi più usati, offre informazioni e video brevi e riunisce documenti e permessi in un'area protetta.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-sportello-digitale-turgovia.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-12T00:30:28+00:00",
      "dateModified": "2026-10-12T00:30:28+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/sportello-digitale-turgovia/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-kreuzlingen-barenplatz-chilbi': {
    title: 'Kreuzlingen: Bärenplatz chiuso per la fiera | Frontaliere Ticino',
    description: 'A Kreuzlingen i bus sono deviati dal 25 ottobre alle 09.00 del 27; la fermata Bärenplatz va alla stazione principale. Possibili ritardi nel traffico locale.',
    keywords: 'frontalieri, ticino, svizzera, italia, kreuzlingen, bärenplatz, chiuso, fiera',
    ogTitle: 'Kreuzlingen, bus deviati per la fiera',
    ogDescription: 'La chiusura del Bärenplatz per l\'allestimento della Chilbi modifica il servizio autobus a Kreuzlingen: la fermata si sposta alla stazione principale, la linea 924 segue un percorso diretto e sono possibili ritardi.',
    canonicalPath: '/articoli-turgovia/kreuzlingen-barenplatz-chilbi/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Kreuzlingen: Bärenplatz chiuso per la fiera",
      "description": "A Kreuzlingen i bus sono deviati dal 25 ottobre alle 09.00 del 27; la fermata Bärenplatz va alla stazione principale. Possibili ritardi nel traffico locale.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-kreuzlingen-barenplatz-chilbi.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Autobus alla stazione principale di Kreuzlingen durante l'allestimento della Chilbi"
      },
      "datePublished": "2026-10-17T00:40:57+00:00",
      "dateModified": "2026-10-17T00:40:57+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/kreuzlingen-barenplatz-chilbi/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-turgovia-sicurezza-lavoro-orari': {
    title: 'Turgovia: sicurezza sul lavoro, orari e tutela della salute',
    description: 'Scopri le regole su sicurezza sul lavoro, tutela della salute, orari e riposi nel Canton Turgovia. Informazioni per datori e lavoratori.',
    keywords: 'frontalieri, ticino, svizzera, italia, turgovia, sicurezza, lavoro, orari',
    ogTitle: 'Sicurezza sul lavoro e orari nel Canton Turgovia',
    ogDescription: 'Approfondimento sulla sicurezza sul lavoro, la tutela della salute, gli orari e i periodi di riposo nel Canton Turgovia secondo le normative vigenti e il supporto dell\'Ispettorato del lavoro.',
    canonicalPath: '/articoli-turgovia/turgovia-sicurezza-lavoro-orari/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Turgovia: sicurezza sul lavoro, orari e tutela della salute",
      "description": "Scopri le regole su sicurezza sul lavoro, tutela della salute, orari e riposi nel Canton Turgovia. Informazioni per datori e lavoratori.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-turgovia-sicurezza-lavoro-orari.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-17T01:07:58+00:00",
      "dateModified": "2026-10-17T01:07:58+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/turgovia-sicurezza-lavoro-orari/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-tredicesima-rendita-avs-2026': {
    title: '13ª rendita AVS pagata con la pensione di dicembre 2026',
    description: 'La 13ª rendita AVS arriva con la rendita di dicembre 2026 Non serve presentare domande o svolgere pratiche Spetta a chi riceve una rendita AVS di vecchiaia',
    keywords: 'frontalieri, ticino, svizzera, italia, rendita, pagata, pensione, dicembre',
    ogTitle: '13ª rendita AVS: pagamento con la rendita di dicembre',
    ogDescription: 'La 13ª rendita AVS arriva con la rendita di dicembre 2026 Non serve presentare domande o svolgere pratiche Spetta a chi riceve una rendita AVS di vecchiaia',
    canonicalPath: '/articoli-turgovia/tredicesima-rendita-avs-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "13ª rendita AVS pagata con la pensione di dicembre 2026",
      "description": "La 13ª rendita AVS arriva con la rendita di dicembre 2026 Non serve presentare domande o svolgere pratiche Spetta a chi riceve una rendita AVS di vecchiaia",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-tredicesima-rendita-avs-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Persona anziana in Turgovia controlla la rendita AVS di dicembre"
      },
      "datePublished": "2026-10-17T09:16:03+00:00",
      "dateModified": "2026-10-17T09:16:03+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/laura-bianchi/#person",
        "name": "Laura Bianchi",
        "url": "https://frontaliereticino.ch/autori/laura-bianchi/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/tredicesima-rendita-avs-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-eventi-weekend-turgovia': {
    title: 'Eventi del weekend in Turgovia: cosa fare',
    description: 'Agenda degli eventi del weekend in Turgovia: concerti, mostre, feste e mercati, comune per comune, aggiornata ogni giorno.',
    keywords: 'eventi in Turgovia, eventi weekend in Turgovia, cosa fare in Turgovia, agenda eventi in Turgovia',
    ogTitle: 'Eventi del weekend in Turgovia',
    ogDescription: 'Concerti, mostre, feste e mercati questo weekend in Turgovia, comune per comune. Aggiornato ogni giorno.',
    canonicalPath: '/articoli-turgovia/eventi-weekend-turgovia/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Eventi del weekend in Turgovia: cosa fare sabato e domenica",
      "description": "Agenda degli eventi del weekend in Turgovia: concerti, mostre, feste e mercati, comune per comune, aggiornata ogni giorno.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/places/lugano-view.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Eventi del weekend in Turgovia"
      },
      "datePublished": "2026-10-17T11:31:41+00:00",
      "dateModified": "2026-10-17T11:31:41+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/eventi-weekend-turgovia/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-felben-wellhausen-cantiere': {
    title: 'Strada principale di Felben-Wellhausen: risanamento',
    description: 'A Felben-Wellhausen, dal 19 ottobre 2026 a metà luglio 2027, la Hauptstrasse sarà risanata: Römerstrasse chiusa a tratti, Römerhof spostata o soppressa.',
    keywords: 'frontalieri, ticino, svizzera, italia, strada, principale, felben-wellhausen, risanamento',
    ogTitle: 'Risanamento della strada principale a Felben-Wellhausen',
    ogDescription: 'Il progetto del Canton Turgovia unisce risanamento e sicurezza: piste ciclabili su entrambi i lati, innesto Römerstrasse ottimizzato, fermata Römerhof senza barriere e attraversamento pedonale. Durante i lavori, l\'uscita Römerstrasse sarà chiusa',
    canonicalPath: '/articoli-turgovia/felben-wellhausen-cantiere/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Strada principale di Felben-Wellhausen: risanamento",
      "description": "A Felben-Wellhausen, dal 19 ottobre 2026 a metà luglio 2027, la Hauptstrasse sarà risanata: Römerstrasse chiusa a tratti, Römerhof spostata o soppressa.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-felben-wellhausen-cantiere.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Illustrazione generata per questo articolo"
      },
      "datePublished": "2026-10-18T03:25:32+00:00",
      "dateModified": "2026-10-18T03:25:32+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/felben-wellhausen-cantiere/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-supporto-imprese-turgovia': {
    title: 'Turgovia: supporto alle imprese che valutano l\'insediamento',
    description: 'Il Canton Turgovia offre alle imprese informazioni, consulenza e sostegno per condizioni quadro, immobili, autorizzazioni e contatti con uffici e autorità.',
    keywords: 'frontalieri, ticino, svizzera, italia, turgovia, supporto, alle, imprese',
    ogTitle: 'Turgovia: supporto alle imprese che valutano l\'insediamento',
    ogDescription: 'Il servizio economico del Canton Turgovia accompagna le aziende già attive e quelle che valutano un insediamento, offrendo orientamento su immobili, linee guida, autorizzazioni e contatti con uffici e autorità.',
    canonicalPath: '/articoli-turgovia/supporto-imprese-turgovia/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Turgovia: supporto alle imprese che valutano l'insediamento",
      "description": "Il Canton Turgovia offre alle imprese informazioni, consulenza e sostegno per condizioni quadro, immobili, autorizzazioni e contatti con uffici e autorità.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-supporto-imprese-turgovia.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-18T11:06:15+00:00",
      "dateModified": "2026-10-18T11:06:15+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/supporto-imprese-turgovia/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-turgovia-servizi-datori-lavoro': {
    title: 'Turgovia: servizi di ricerca personale e tutela lari',
    description: 'Scopri i servizi di ricerca personale tramite RAV Amriswil, Frauenfeld e Kreuzlingen e arbeit.swiss, permessi stranieri e indennità lavoro ridotto in Turgovia.',
    keywords: 'frontalieri, ticino, svizzera, italia, turgovia, servizi, ricerca, personale',
    ogTitle: 'Turgovia: servizi RAV e supporto datori di lavoro',
    ogDescription: 'Il Canton Turgovia offre supporto ai datori di lavoro tramite le sedi RAV di Amriswil, Frauenfeld e Kreuzlingen, pubblicazioni gratuite su arbeit.swiss e consulenza su permessi e tutela lari',
    canonicalPath: '/articoli-turgovia/turgovia-servizi-datori-lavoro/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Turgovia: servizi di ricerca personale e tutela lari",
      "description": "Scopri i servizi di ricerca personale tramite RAV Amriswil, Frauenfeld e Kreuzlingen e arbeit.swiss, permessi stranieri e indennità lavoro ridotto in Turgovia.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-turgovia-servizi-datori-lavoro.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-19T15:27:38+00:00",
      "dateModified": "2026-10-19T15:27:38+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/turgovia-servizi-datori-lavoro/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-pbv-rpg2-turgovia-2026': {
    title: 'Turgovia: approvata PBV revisionata per RPG2 | Frontaliere Ticino',
    description: 'Il Governo ha approvato la PBV revisionata RPG2 riguarda le costruzioni fuori dalle zone edificabili L\'obiettivo è limitare la crescita a un massimo',
    keywords: 'frontalieri, ticino, svizzera, italia, turgovia, approvata, revisionata, rpg2',
    ogTitle: 'Turgovia: approvata PBV revisionata per RPG2',
    ogDescription: 'Il Governo ha approvato la PBV revisionata RPG2 riguarda le costruzioni fuori dalle zone edificabili L\'obiettivo è limitare la crescita a un massimo del 2%',
    canonicalPath: '/articoli-turgovia/pbv-rpg2-turgovia-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Turgovia: approvata PBV revisionata per RPG2",
      "description": "Il Governo ha approvato la PBV revisionata RPG2 riguarda le costruzioni fuori dalle zone edificabili L'obiettivo è limitare la crescita a un massimo",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-pbv-rpg2-turgovia-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-23T01:44:38+00:00",
      "dateModified": "2026-10-23T01:44:38+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/pbv-rpg2-turgovia-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-turgovia-modifica-piano-direttore-2027': {
    title: 'Turgovia: modifica piano direttore per sedi economiche',
    description: 'Consultazione aperta nel Canton Turgovia per la modifica del piano direttore: nuovi criteri per sedi industriali e commerciali fino al 2027.',
    keywords: 'frontalieri, ticino, svizzera, italia, turgovia, modifica, piano, direttore',
    ogTitle: 'Turgovia: nuova pianificazione sedi economiche',
    ogDescription: 'Il Canton Turgovia rivede il piano direttore per potenziare i poli economici. Scopri i criteri per il trasporto pubblico e i collegamenti stradali validi fino alla consultazione del 2027.',
    canonicalPath: '/articoli-turgovia/turgovia-modifica-piano-direttore-2027/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Turgovia: modifica piano direttore per sedi economiche",
      "description": "Consultazione aperta nel Canton Turgovia per la modifica del piano direttore: nuovi criteri per sedi industriali e commerciali fino al 2027.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-turgovia-modifica-piano-direttore-2027.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-23T03:27:25+00:00",
      "dateModified": "2026-10-23T03:27:25+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/turgovia-modifica-piano-direttore-2027/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-sedi-rav-lavoratori-tg': {
    title: 'Sedi RAV e servizi per datori di lavoro in Canton Turgovia',
    description: 'Informazioni sulle sedi RAV (Amriswil, Frauenfeld, Kreuzlingen), pubblicazione gratuita vacancy su arbeit.swiss e consulenza per datori di lavoro',
    keywords: 'frontalieri, ticino, svizzera, italia, sedi, servizi, datori, lavoro',
    ogTitle: 'Sedi RAV e servizi datori di lavoro Turgovia',
    ogDescription: 'Scopri le sedi RAV ad Amriswil, Frauenfeld e Kreuzlingen e come pubblicare offerte di lavoro gratuitamente su arbeit.swiss per le imprese del Canton Turgovia.',
    canonicalPath: '/articoli-turgovia/sedi-rav-lavoratori-tg/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Sedi RAV e servizi per datori di lavoro in Canton Turgovia",
      "description": "Informazioni sulle sedi RAV (Amriswil, Frauenfeld, Kreuzlingen), pubblicazione gratuita vacancy su arbeit.swiss e consulenza per datori di lavoro",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-sedi-rav-lavoratori-tg.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-25T12:02:52+00:00",
      "dateModified": "2026-10-25T12:02:52+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/sedi-rav-lavoratori-tg/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-imprenditori-cantone-turgovia-sostegno': {
    title: 'Imprenditori nel Canton Turgovia: condizioni quadro attrattive',
    description: 'Informazioni sul supporto per imprenditrici e imprenditori nel Canton Turgovia: condizioni quadro attrattive, permessi, immobili e collaborazione',
    keywords: 'frontalieri, ticino, svizzera, italia, imprenditori, canton, turgovia, condizioni',
    ogTitle: 'Imprenditori Canton Turgovia: condizioni quadro attrattive',
    ogDescription: 'Il Canton Turgovia supporta imprenditrici e imprenditori con accompagnamento, informazioni e consulenza per un insediamento attrattivo, coprendo immobili e permessi.',
    canonicalPath: '/articoli-turgovia/imprenditori-cantone-turgovia-sostegno/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Imprenditori nel Canton Turgovia: condizioni quadro attrattive",
      "description": "Informazioni sul supporto per imprenditrici e imprenditori nel Canton Turgovia: condizioni quadro attrattive, permessi, immobili e collaborazione",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-imprenditori-cantone-turgovia-sostegno.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-25T12:54:45+00:00",
      "dateModified": "2026-10-25T12:54:45+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/imprenditori-cantone-turgovia-sostegno/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-frauenfeld-revisione-regolamento-salariale': {
    title: 'Frauenfeld: pubblicata la revisione parziale del regolamento salariale',
    description: 'Scopri la pubblicazione referendaria di Frauenfeld sulla revisione parziale del regolamento salariale con allegato PDF da 88 KB.',
    keywords: 'frontalieri, ticino, svizzera, italia, frauenfeld, pubblicata, revisione, parziale',
    ogTitle: 'Frauenfeld: pubblicata la revisione parziale del regolamento salariale',
    ogDescription: 'La città di Frauenfeld ha pubblicato la voce referendaria sulla revisione parziale del regolamento salariale con allegato PDF di 88 KB. Leggi i dettagli documentali disponibili sul sito comunale.',
    canonicalPath: '/articoli-turgovia/frauenfeld-revisione-regolamento-salariale/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Frauenfeld: pubblicata la revisione parziale del regolamento salariale",
      "description": "Scopri la pubblicazione referendaria di Frauenfeld sulla revisione parziale del regolamento salariale con allegato PDF da 88 KB.",
      "image": {
        "@type": "ImageObject",
        "acquireLicensePage": "https://openai.com/policies/terms-of-use/",
        "copyrightNotice": "Generated media; provider terms apply.",
        "license": "https://openai.com/policies/terms-of-use/",
        "creator": { "@type": "Organization", "@id": "https://frontaliereticino.ch/#organization", "name": "frontaliereticino.ch", "url": "https://frontaliereticino.ch/" },
        "creditText": "frontaliereticino.ch",
        "url": `${BASE_URL}/images/blog/article-frauenfeld-revisione-regolamento-salariale.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Immagine illustrativa pertinente al tema dell’articolo"
      },
      "datePublished": "2026-10-29T23:14:34+00:00",
      "dateModified": "2026-10-29T23:14:34+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-turgovia/frauenfeld-revisione-regolamento-salariale/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

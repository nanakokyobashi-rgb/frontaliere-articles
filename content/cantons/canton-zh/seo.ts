// Metadati SEO degli articoli della sezione canton-zh (Zurigo).
// Stessa forma voce di seo-blog-ch.ts; scritto da create-article.mjs.

import type { SEOMetadata } from '../../seo/seoMetadataType';

const BASE_URL = 'https://frontaliereticino.ch';

const CANTON_SEO_METADATA: Record<string, SEOMetadata> = {

  'blog-disoccupazione-zurigo-rav-2026': {
    title: 'Disoccupazione a Zurigo stabile al 2,9% a settembre',
    description: 'A settembre il Canton Zurigo mantiene il 2,9% di disoccupazione: 25’695 iscritti ai RAV, 7’605 posti vacanti in agosto e aspettative aziendali positive.',
    keywords: 'frontalieri, ticino, svizzera, italia, disoccupazione, zurigo, stabile, settembre',
    ogTitle: 'Zurigo, disoccupazione stabile al 2,9%',
    ogDescription: 'Il dato cantonale di settembre resta al 2,9%, ma le persone registrate come disoccupate diminuiscono di 355. In agosto i posti aperti ai RAV salgono a 7’605: costruzione e finiture segnano l’aumento più forte.',
    canonicalPath: '/articoli-zurigo/disoccupazione-zurigo-rav-2026/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Disoccupazione a Zurigo stabile al 2,9% a settembre",
      "description": "A settembre il Canton Zurigo mantiene il 2,9% di disoccupazione: 25’695 iscritti ai RAV, 7’605 posti vacanti in agosto e aspettative aziendali positive.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-disoccupazione-zurigo-rav-2026.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Pendolari e lavoratori nel centro di Zurigo in una mattina di settembre"
      },
      "datePublished": "2026-10-07T08:44:53+00:00",
      "dateModified": "2026-10-07T08:44:53+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-zurigo/disoccupazione-zurigo-rav-2026/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

  'blog-mappa-affitti-zurigo-trasloco': {
    title: 'Affitti a Zurigo: il rincaro dopo il trasloco | Frontaliere Ticino',
    description: 'Mappa interattiva sugli affitti a Zurigo: il confronto mostra il rincaro della pigione dopo un trasloco e chiarisce cauzione, disdetta e contestazione.',
    keywords: 'frontalieri, ticino, svizzera, italia, affitti, zurigo, rincaro, dopo',
    ogTitle: 'Mappa interattiva: affitti più cari a Zurigo',
    ogDescription: 'Chi valuta un trasloco a Zurigo può partire dalla mappa interattiva dedicata alle pigioni. Il confronto sul rincaro va letto insieme alle regole svizzere per deposito cauzionale, disdetta del locatore e contestazione entro 30 giorni.',
    canonicalPath: '/articoli-zurigo/mappa-affitti-zurigo-trasloco/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      "headline": "Affitti a Zurigo: il rincaro dopo il trasloco",
      "description": "Mappa interattiva sugli affitti a Zurigo: il confronto mostra il rincaro della pigione dopo un trasloco e chiarisce cauzione, disdetta e contestazione.",
      "image": {
        "@type": "ImageObject",
        "url": `${BASE_URL}/images/blog/article-mappa-affitti-zurigo-trasloco.webp`,
        "width": 1200,
        "height": 675,
        "caption": "Palazzi residenziali a Zurigo, tema del confronto tra affitti e traslochi"
      },
      "datePublished": "2026-10-07T08:59:16+00:00",
      "dateModified": "2026-10-07T08:59:16+00:00",
      "inLanguage": "it",
      "author": {
        "@type": "Person",
        "@id": "https://frontaliereticino.ch/autori/redazione/#person",
        "name": "Redazione Frontaliere Ticino",
        "url": "https://frontaliereticino.ch/autori/redazione/"
      },
      "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
      "mainEntityOfPage": `${BASE_URL}/articoli-zurigo/mappa-affitti-zurigo-trasloco/`,
      "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] }
    }
  },

};

export default CANTON_SEO_METADATA;

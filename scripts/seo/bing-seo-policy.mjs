/**
 * Canonical source policy for the 16 Bing title findings observed on
 * frontaliereticino.ch. The publisher owns these strings; the site audits the
 * resulting HTTP surface without importing this repository.
 */

export const BING_TITLE_MAX_CHARS = 66;

export const BING_TITLE_FIXES = [
  {
    url: 'https://frontaliereticino.ch/articoli-svizzera/dati-tasse-frontalieri-italia/',
    source: 'content/seo/seo-blog-ch.ts',
    kind: 'seo',
    articleId: 'blog-dati-tasse-frontalieri-italia',
    title: 'Dati e tasse dei vecchi frontalieri: cosa è successo',
  },
  {
    url: 'https://frontaliereticino.ch/articoli-svizzera/frontaliere-assicurazione-auto-confronto/',
    source: 'content/seo/seo-blog-ch.ts',
    kind: 'seo',
    articleId: 'blog-frontaliere-assicurazione-auto-confronto',
    title: 'Assicurazione auto frontalieri: Svizzera o Italia?',
  },
  {
    url: 'https://frontaliereticino.ch/articoli-svizzera/frontaliere-credito-imposta-2026-famiglia-con-figli/',
    source: 'content/seo/seo-blog-ch.ts',
    kind: 'seo',
    articleId: 'blog-frontaliere-credito-imposta-2026-famiglia-con-figli',
    title: "Credito d'imposta frontalieri 2026: guida pratica",
  },
  {
    url: 'https://frontaliereticino.ch/articoli-svizzera/frontaliere-doppia-imposizione-credito-imposta/',
    source: 'content/seo/seo-blog-ch.ts',
    kind: 'seo',
    articleId: 'blog-frontaliere-doppia-imposizione-credito-imposta',
    title: "Credito d'imposta e doppia tassazione: guida",
  },
  {
    url: 'https://frontaliereticino.ch/articoli-svizzera/frontaliere-licenziamento-diritti-2026/',
    source: 'content/seo/seo-blog-ch.ts',
    kind: 'seo',
    articleId: 'blog-frontaliere-licenziamento-diritti-2026',
    title: 'Licenziamento frontalieri 2026: diritti e preavviso',
  },
  {
    url: 'https://frontaliereticino.ch/articoli-svizzera/frontaliere-pensionamento-anticipato-2026-oltre-20km/',
    source: 'content/seo/seo-blog-ch.ts',
    kind: 'seo',
    articleId: 'blog-frontaliere-pensionamento-anticipato-2026-oltre-20km',
    title: 'Pensionamento anticipato frontalieri: AVS e LPP',
  },
  {
    url: 'https://frontaliereticino.ch/articoli-svizzera/parrucchieri-frontaliere-ticino/',
    source: 'content/seo/seo-blog-ch.ts',
    kind: 'seo',
    articleId: 'blog-parrucchieri-frontaliere-ticino',
    title: 'Parrucchiera in Ticino da frontaliere: guida',
  },
  {
    url: 'https://frontaliereticino.ch/articoli-svizzera/quadro-rw-2026-chi-dichiara-conto-svizzero/',
    source: 'content/seo/seo-blog-ch.ts',
    kind: 'seo',
    articleId: 'blog-quadro-rw-2026-chi-dichiara-conto-svizzero',
    title: 'Quadro RW 2026: conto svizzero, chi dichiara',
  },
  {
    url: 'https://frontaliereticino.ch/de/grenzgaenger-artikel/antikmarkt-mendrisio-2026/',
    source: 'content/blog-meta-de.ts',
    kind: 'meta',
    metadataKey: 'blog.article.fiera-antiquariato-mendrisio-2026.title',
    title: 'Antiquitätenmesse Mendrisio 2026: Infos und Termine',
  },
  {
    url: 'https://frontaliereticino.ch/de/grenzgaenger-artikel/gesundheitssteuer-grenzgaenger-tessin-2026/',
    source: 'content/blog-meta-de.ts',
    kind: 'meta',
    metadataKey: 'blog.article.tassa-salute-frontalieri-ticino-2026.title',
    title: 'Gesundheitssteuer für Grenzgänger: aktuelle Änderungen',
  },
  {
    url: 'https://frontaliereticino.ch/de/grenzgaenger-artikel/monte-lema-bahn-saison-2026/',
    source: 'content/blog-meta-de.ts',
    kind: 'meta',
    metadataKey: 'blog.article.funivia-monte-lema-stagione-2026.title',
    title: 'Monte Lema Bahn 2026: Saison, Zeiten und Preise',
  },
  {
    url: 'https://frontaliereticino.ch/de/schweiz-artikel/aufenthaltsbewilligung-b-quellensteuer-2026/',
    source: 'content/blog-meta-ch-de.ts',
    kind: 'meta',
    metadataKey: 'blog.article.aufenthaltsbewilligung-b-quellensteuer.title',
    title: 'Bewilligung B und Quellensteuer 2026: Ratgeber',
  },
  {
    url: 'https://frontaliereticino.ch/fr/articles-frontalier/autoroute-a9-fermee-la-nuit-2026/',
    source: 'content/blog-meta-fr.ts',
    kind: 'meta',
    metadataKey: 'blog.article.autostrada-a9-chiude-de-notti-2026.title',
    title: 'Autoroute A9 Chiasso : fermetures nocturnes 2026',
  },
  {
    url: 'https://frontaliereticino.ch/fr/articles-frontalier/frais-de-transit-suisse/',
    source: 'content/blog-meta-fr.ts',
    kind: 'meta',
    metadataKey: 'blog.article.tassa-transito-svizzera-2023.title',
    title: 'Taxe de transit suisse 2026 : changements',
  },
  {
    url: 'https://frontaliereticino.ch/fr/articles-frontalier/heures-de-travail-semanelles-suisses-en-2025/',
    source: 'content/blog-meta-fr.ts',
    kind: 'meta',
    metadataKey: 'blog.article.orario-lavoro-settimanale-svizzera-2025.title',
    title: 'Heures de travail en Suisse : 40 h 3 en 2025',
  },
  {
    url: 'https://frontaliereticino.ch/fr/articles-frontalier/permis-g-vs-b-frontalier-2026-erreurs-communes/',
    source: 'content/blog-meta-fr.ts',
    kind: 'meta',
    metadataKey: 'blog.article.permesso-g-vs-b-frontalieri-2026-errori-comuni.title',
    title: 'Permis G ou B : erreurs fréquentes des frontaliers',
  },
];

export const BING_TITLE_AUDIT_URLS = BING_TITLE_FIXES.map((item) => item.url);

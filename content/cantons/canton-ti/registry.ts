/**
 * Articoli della sezione canton-ti (Ticino). Stessa forma `Article` del
 * registro frontaliere; scritto da generator/scripts/create-article.mjs
 * --section=canton-ti.
 */
import type { Article } from '../../blog-articles-data';

export const CANTON_ARTICLES: Article[] = [
 {
 id: 'a2-mendrisio-melano-risanamento',
 category: 'novita',
 date: '2026-10-07T06:12:18.855Z',
 image: '/images/blog/mendrisio-melano-progetto-meme-risanamento-fonico.webp',
 hasCalculator: true,
 articleType: 'news',
 canton: ['TI'],
 authorSlug: 'redazione',
 authorName: 'Redazione Frontaliere Ticino',
 },
 {
 id: 'scambio-dati-salariali-2027',
 category: 'fiscale',
 date: '2026-10-07T06:25:44.294Z',
 image: '/images/blog/fairtiq-bonus-ticino-2026-2027.webp',
 hasCalculator: true,
 articleType: 'news',
 canton: ['TI'],
 authorSlug: 'redazione',
 authorName: 'Redazione Frontaliere Ticino',
 },
];

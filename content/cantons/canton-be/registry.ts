/**
 * Articoli della sezione canton-be (Berna). Stessa forma `Article` del
 * registro frontaliere; scritto da generator/scripts/create-article.mjs
 * --section=canton-be.
 */
import type { Article } from '../../blog-articles-data';

export const CANTON_ARTICLES: Article[] = [
 {
 id: 'simplificazione-imposta-trasferimento-berna',
 category: 'fiscale',
 date: '2026-10-07T06:54:25.689Z',
 image: '/images/blog/imposta-successione-donazione-berna.webp',
 hasCalculator: true,
 articleType: 'news',
 canton: ['BE'],
 authorSlug: 'marco-ferrari',
 authorName: 'Marco Ferrari',
 },
 {
 id: 'wabern-tram-risanamento',
 category: 'pratico',
 date: '2026-10-07T07:11:43.423Z',
 image: '/images/blog/tram-treno-lugano-lavori-inizio.webp',
 hasCalculator: true,
 articleType: 'news',
 canton: ['BE'],
 authorSlug: 'redazione',
 authorName: 'Redazione Frontaliere Ticino',
 },
];

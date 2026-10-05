/**
 * Per-canton plumbing of the weekend events digest producer
 * (generate-events-digest-article.mjs), P9a sezioni cantonali.
 *
 * Kept out of the producer on purpose: the producer imports create-article.mjs
 * and with it npm dependencies, while these helpers must stay importable by the
 * dependency-free unit job (`node --test 'generator/tests/*.test.mjs'`, no
 * `npm ci`). Corpus-only: the site's copy of the producer is dormant.
 */
import { resolveDigestCanton, CANTON_DIGEST_ARTICLES } from './events-digest-content.mjs';

/**
 * Evergreen SEO block of a non-Ticino canton digest, from the canton's
 * "in <canton>" phrase (registered once, never refreshed, like the Ticino
 * STATIC_META.seo of the producer).
 */
export function cantonDigestSeo(groupKey) {
  const entry = CANTON_DIGEST_ARTICLES[groupKey];
  if (!entry) throw new Error(`events digest: no canton digest for "${groupKey}"`);
  const place = entry.place.it;
  return {
    title: `Eventi del weekend ${place}: cosa fare`,
    description: `Agenda degli eventi del weekend ${place}: concerti, mostre, feste e mercati, comune per comune, aggiornata ogni giorno.`,
    keywords: `eventi ${place}, eventi weekend ${place}, cosa fare ${place}, agenda eventi ${place}`,
    ogTitle: `Eventi del weekend ${place}`,
    ogDescription: `Concerti, mostre, feste e mercati questo weekend ${place}, comune per comune. Aggiornato ogni giorno.`,
    headline: `Eventi del weekend ${place}: cosa fare sabato e domenica`,
    breadcrumbName: 'Eventi del weekend',
  };
}

/**
 * Canton requested on the command line (`--canton GR` / `--canton=GR`) or via
 * EVENTS_DIGEST_CANTON; undefined means Ticino. Validated by
 * resolveDigestCanton, which throws on an unknown code.
 */
export function digestCantonFromArgs(argv = process.argv.slice(2), env = process.env) {
  const index = argv.indexOf('--canton');
  const raw = index >= 0 ? argv[index + 1] : argv.find((arg) => arg.startsWith('--canton='))?.slice('--canton='.length);
  const value = String(raw ?? env.EVENTS_DIGEST_CANTON ?? '').trim();
  if (index >= 0 && (!value || value.startsWith('--'))) throw new Error('--canton needs a canton code');
  return value ? resolveDigestCanton(value) : undefined;
}

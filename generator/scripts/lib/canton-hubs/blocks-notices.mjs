/**
 * blocks-notices.mjs — blocco «avvisi ufficiali» degli hub, dal dataset
 * `canton-notices.json` (contratto REWIRE `canton-notices`, cache scritta da
 * `refresh-canton-notices.mjs`): titolo, link e data dei comunicati delle
 * fonti istituzionali lente del cantone (D10), per categoria di hub. Il titolo
 * resta quello della fonte: niente riscrittura, niente traduzione.
 */
import { noticesFor } from '../canton-notices-data.mjs';
import { clip, httpsUrlOrNull } from './format.mjs';
import { BLOCK_THRESHOLDS, CLOCK_SKEW_MS, DAY_MS, freshnessProblem, isObj, omitted } from './blocks-common.mjs';

export const NOTICES_BLOCK_ID = 'avvisi-ufficiali';

const TXT = {
  it: { title: 'Avvisi ufficiali', description: 'Ultimi comunicati di amministrazioni ed enti del cantone su questo tema, con il link alla fonte. I titoli sono nella lingua originale.' },
  en: { title: 'Official notices', description: 'Latest releases on this topic from the canton’s administrations and public bodies, linked to the source. Titles are in the original wording.' },
  de: { title: 'Amtliche Mitteilungen', description: 'Neueste Mitteilungen von Verwaltung und Institutionen des Kantons zu diesem Thema, mit Link zur Quelle. Die Titel stehen im Originalwortlaut.' },
  fr: { title: 'Avis officiels', description: 'Derniers communiqués des administrations et organismes du canton sur ce thème, avec le lien vers l’origine. Les titres sont dans leur version originale.' },
};

/**
 * @param {any} dataset contenuto di `canton-notices.json`, o null
 * @param {{ canton: string, topic: string, nowMs: number }} ctx
 */
export function shapeNoticesBlock(dataset, { canton, topic, nowMs }) {
  const id = NOTICES_BLOCK_ID;
  const th = BLOCK_THRESHOLDS.notices;
  if (dataset == null) return omitted(id, 'missing', 'canton-notices.json non in cache');
  if (!isObj(dataset) || dataset.schemaVersion !== 1 || !Array.isArray(dataset.notices)) {
    return omitted(id, 'invalid', 'canton-notices.json: forma non riconosciuta');
  }
  const stale = freshnessProblem(dataset.generatedAt, nowMs, th.maxAgeMs, 'canton-notices.json');
  if (stale) return omitted(id, stale.code, stale.reason);

  const oldest = nowMs - th.maxItemAgeDays * DAY_MS;
  const seen = new Set();
  const rows = noticesFor(dataset, canton, { category: topic, limit: 200 })
    // Un avviso senza data non si puo' dire recente, e uno datato nel futuro
    // non e' ancora uscito: entrano solo i datati fino a ora (piu' lo
    // sfasamento d'orologio ammesso).
    .filter((n) => typeof n.publishedAt === 'string' && Date.parse(n.publishedAt) >= oldest && Date.parse(n.publishedAt) <= nowMs + CLOCK_SKEW_MS)
    .map((n) => ({ n, url: httpsUrlOrNull(n.url) }))
    .filter(({ url }) => url)
    .filter(({ url }) => (seen.has(url) ? false : (seen.add(url), true)))
    .slice(0, th.maxRows);
  if (rows.length < th.minRows) return omitted(id, 'empty', `nessun avviso ${topic} recente per ${canton}`);

  return {
    id,
    available: true,
    updatedAt: dataset.generatedAt,
    maxAgeMs: th.maxAgeMs,
    render(locale) {
      const t = TXT[locale];
      return {
        title: t.title,
        description: t.description,
        items: rows.map(({ n, url }) => ({ label: clip(n.title, 200), date: n.publishedAt, url })),
        keyFacts: [],
      };
    },
  };
}

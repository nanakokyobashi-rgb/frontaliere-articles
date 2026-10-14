/**
 * paths.mjs — dove vivono i file dati degli hub tematici di una sezione
 * cantonale: `content/cantons/<sezione>/hubs/<tema>.json`, accanto a registro,
 * slug e SEO della stessa sezione (D14).
 *
 * Modulo a se', senza altre dipendenze che il core: lo importa anche
 * `scripts/lib/article-surfaces.mjs`, che dichiara questi file fra le
 * superfici di scrittura della sezione (rebase e ritiro li vedono da li').
 */
import '../../../../host/cantonSectionsBootstrap.mjs';
import { ARTICLE_SECTION_CORE_ALL } from '../../../../engine/shared/articleSectionCore.mjs';
import { CANTON_HUB_TOPIC_KEYS } from '../../../../engine/shared/cantonArticleSectionCore.generated.mjs';

/** Cartella degli hub di una sezione cantonale, relativa alla radice del repo. */
export function hubDataDir(section) {
  if (ARTICLE_SECTION_CORE_ALL[section]?.kind !== 'canton') throw new Error(`canton-hubs: "${section}" non e' una sezione cantonale`);
  return `content/cantons/${section}/hubs`;
}

/** Path del file dati di un hub, relativo alla radice del repo. */
export function hubFilePath(section, topic) {
  if (!CANTON_HUB_TOPIC_KEYS.includes(topic)) throw new Error(`canton-hubs: tema sconosciuto "${topic}"`);
  return `${hubDataDir(section)}/${topic}.json`;
}

/** I sei file dati di una sezione cantonale, nell'ordine canonico dei temi. */
export function hubFilePaths(section) {
  return CANTON_HUB_TOPIC_KEYS.map((topic) => hubFilePath(section, topic));
}

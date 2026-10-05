#!/usr/bin/env node
/**
 * fast-publish-section.mjs — sezione e shard di un fast-publish, dal core.
 *
 * `fast-publish-article.yml` deduceva la sezione con un `case` sul path
 * (`content/blog-body-ch/*` → svizzera, tutto il resto → frontaliere) e lo
 * shard con un ternario (`svizzera` → articolisvizzera, altrimenti
 * articolifrontaliere), ripetuto in quattro step. Due difetti nella stessa
 * forma: una sezione nuova finiva in silenzio su frontaliere, e il suo
 * articolo veniva spinto nello shard di un'altra sezione.
 *
 * Qui tutto viene da `ARTICLE_SECTION_CORE` (sezioni ATTIVE):
 *
 *   body-regex             l'ERE che riconosce un corpo di QUALSIASI sezione
 *                          attiva (`^content/(blog-body|blog-body-ch)/[a-z]{2}/.+\.ts$`)
 *   section-of <path>      la sezione che possiede quel corpo (esce 1 se nessuna)
 *   shard-of <section>     lo shard Pages della sezione. Una sezione con
 *                          `shardKey: null` (le cantonali) e' servita da R2 +
 *                          Worker, non da uno shard: esce 1 con un errore
 *                          esplicito invece di ripiegare su uno shard altrui.
 *
 * Solo builtin Node: gira nel primo step del workflow, prima di setup-node.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE_LIST } from '../../engine/shared/articleSectionCore.mjs';
import { activeSourceSections, sectionForBodyPath } from '../lib/corpus-sections.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** L'ERE (grep -E) dei corpi delle sezioni attive. */
export function bodyRegex(coreList = ARTICLE_SECTION_CORE_LIST) {
  const dirs = activeSourceSections(coreList).map((s) => {
    if (!s.bodyDir.startsWith('content/')) throw new Error(`bodyDir fuori da content/: ${s.bodyDir}`);
    return escapeRe(s.bodyDir.slice('content/'.length));
  });
  return `^content/(${dirs.join('|')})/[a-z]{2}/.+\\.ts$`;
}

/** La sezione che possiede il corpo, o un errore. */
export function sectionOf(rel, coreList = ARTICLE_SECTION_CORE_LIST) {
  const hit = sectionForBodyPath(rel, coreList);
  if (!hit) throw new Error(`'${rel}' non e' il corpo di nessuna sezione attiva`);
  return hit.section;
}

/** Lo shard Pages di una sezione attiva, o un errore. */
export function shardOf(section, coreList = ARTICLE_SECTION_CORE_LIST) {
  const entry = coreList.find((core) => core.section === section);
  if (!entry) {
    throw new Error(
      `sezione '${section}' non attiva: attese ${coreList.map((c) => c.section).join(', ')}`,
    );
  }
  if (!entry.shardKey) {
    throw new Error(
      `la sezione '${section}' (tipo ${entry.kind}) non ha uno shard Pages: e' servita da R2 + Worker ` +
        '(D3 del piano sezioni cantonali). Il fast-publish verso gli shard non la pubblica; ' +
        'la sua pubblicazione arriva con publish-section-pages (P7).',
    );
  }
  return entry.shardKey;
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'body-regex') console.log(bodyRegex());
    else if (cmd === 'section-of' && arg) console.log(sectionOf(arg));
    else if (cmd === 'shard-of' && arg) console.log(shardOf(arg));
    else throw new Error('uso: fast-publish-section.mjs body-regex | section-of <path> | shard-of <section>');
  } catch (error) {
    console.error(`::error::fast-publish-section: ${error?.message ?? error}`);
    process.exit(1);
  }
}

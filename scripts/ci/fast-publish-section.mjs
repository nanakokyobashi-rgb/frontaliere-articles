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
 *   body-regex [shard|r2]  l'ERE che riconosce un corpo di QUALSIASI sezione
 *                          attiva (`^content/(blog-body|blog-body-ch)/[a-z]{2}/.+\.ts$`);
 *                          con `shard` solo le sezioni servite da uno shard
 *                          Pages (cio' che fast-publish-article.yml pubblica),
 *                          con `r2` solo quelle servite da R2 + Worker (le
 *                          cantonali, pubblicate da fast-publish-section.yml).
 *                          Senza sezioni del tipo chiesto l'ERE non combacia
 *                          con niente.
 *   r2-plan                legge da stdin i file cambiati (uno per riga; accetta
 *                          anche `git diff --name-status`) e stampa la matrice
 *                          JSON `[{section, ids, bootstrap}]` delle sezioni R2
 *                          da ripubblicare
 *   section-of <path>      la sezione che possiede quel corpo (esce 1 se nessuna)
 *   shard-of <section>     lo shard Pages della sezione. Una sezione con
 *                          `shardKey: null` (le cantonali) e' servita da R2 +
 *                          Worker, non da uno shard: esce 1 con un errore
 *                          esplicito invece di ripiegare su uno shard altrui.
 *
 * Solo builtin Node: gira nel primo step del workflow, prima di setup-node.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE_LIST } from '../../engine/shared/articleSectionCore.mjs';
import { activeSourceSections, sectionForBodyPath } from '../lib/corpus-sections.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Cambiare uno di questi moduli cambia il risultato di ogni publisher R2,
// non una sola sezione: il workflow deve quindi rifare il bootstrap di tutte
// le sezioni cantonali R2 attive, invece di produrre una matrice vuota.
const SHARED_R2_REFRESH_PATHS = new Set([
  'generator/scripts/lib/canton-hubs/paths.mjs',
  'generator/scripts/lib/control-char-write-report.mjs',
  'scripts/ci/fast-publish-section.mjs',
  'scripts/cf-purge-cache.mjs',
  'scripts/lib/article-render-pipeline.mjs',
  'scripts/lib/canton-hub-data.mjs',
  'scripts/lib/cdn-asset-existence.mjs',
  'scripts/lib/delete-cdn-file.sh',
  'scripts/lib/corpus-floors.mjs',
  'scripts/lib/corpus-sections.mjs',
  'scripts/lib/engine-corpus-view.mjs',
  'scripts/lib/sanitize-control-chars.mjs',
  'scripts/lib/section-registry.mjs',
  'scripts/lib/upload-cdn-file.sh',
  'scripts/ci/retry-cmd.sh',
  'scripts/offload-generated-images-cdn.mjs',
  'scripts/publish-section-edge.mjs',
  'scripts/publish-section-pages.mjs',
]);
const SHARED_R2_REFRESH_PREFIXES = Object.freeze(['engine/', 'host/']);

const isSharedR2RefreshPath = (rel) =>
  SHARED_R2_REFRESH_PATHS.has(rel) || SHARED_R2_REFRESH_PREFIXES.some((prefix) => rel.startsWith(prefix));

/**
 * L'ERE (grep -E) dei corpi delle sezioni attive. `served` restringe a chi le
 * serve: `shard` (Pages) o `r2` (Worker). Un commit di un articolo cantonale
 * non deve entrare nel fast-publish verso gli shard, dove `shard-of` lo
 * rifiuterebbe facendo fallire il workflow a ogni articolo.
 */
export function bodyRegex(coreList = ARTICLE_SECTION_CORE_LIST, { served } = {}) {
  if (served !== undefined && served !== 'shard' && served !== 'r2') throw new Error(`body-regex: tipo "${served}" sconosciuto (shard | r2)`);
  const sections = activeSourceSections(coreList).filter((s) => served === undefined || (served === 'shard') === Boolean(s.shardKey));
  // Nessuna sezione di quel tipo: un'ERE che non combacia con nessun path.
  if (sections.length === 0) return '^$';
  const dirs = sections.map((s) => {
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

/**
 * Le sezioni R2 (cantonali attive) toccate da un insieme di file cambiati, con
 * gli id degli articoli il cui corpo e' cambiato. `bootstrap: true` significa
 * che un input article-facing (registro, slug, SEO, meta) o una cancellazione
 * richiede il render completo degli id ancora presenti: gli id rimossi non
 * entrano mai in `ids`, quindi il controllo del renderer non fallisce su una
 * voce che il commit ha eliminato. I soli input hub (`.../hubs/*.json`) restano
 * `bootstrap: false` e con `ids: []`: rinfrescano landing, archivio e hub.
 *
 * @param {string[]} files path relativi alla radice del repo
 * @returns {Array<{ section: string, ids: string[], bootstrap: boolean }>} nell'ordine del core
 */
export function r2PublishPlan(files, coreList = ARTICLE_SECTION_CORE_LIST) {
  const sections = activeSourceSections(coreList).filter((s) => !s.shardKey);
  const plan = new Map();
  const touch = (section) => {
    if (!plan.has(section)) plan.set(section, { ids: new Set(), bootstrap: false });
    return plan.get(section);
  };
  const changedFiles = [];
  for (const raw of files) {
    const line = String(raw ?? '').trimEnd();
    if (!line.trim()) continue;
    const fields = line.split('\t');
    if (fields.length === 1) {
      changedFiles.push({ rel: fields[0].trim(), status: 'M' });
      continue;
    }
    const status = fields[0].trim().charAt(0) || 'M';
    // `--name-status` gives R<score> old new and C<score> old new. A rename
    // is a deletion plus an addition for publication purposes: seeing either
    // side is enough to force a complete refresh of the surviving registry.
    const paths = status === 'R' || status === 'C' ? fields.slice(1) : fields.slice(1, 2);
    for (const rel of paths) changedFiles.push({ rel: rel.trim(), status });
  }
  if (changedFiles.some(({ rel }) => isSharedR2RefreshPath(rel))) {
    for (const section of sections) touch(section.section).bootstrap = true;
  }
  for (const { rel, status } of changedFiles) {
    if (!rel) continue;
    const body = sectionForBodyPath(rel, coreList);
    if (body) {
      const target = sections.find((s) => s.section === body.section);
      if (!target) continue;
      const state = touch(target.section);
      if (status === 'D' || status === 'R') state.bootstrap = true;
      else state.ids.add(body.id);
      continue;
    }
    for (const s of sections) {
      const cantonRoot = `content/cantons/${s.section}/`;
      const hubRoot = `${cantonRoot}hubs/`;
      const isHubData = rel.startsWith(hubRoot);
      const own = rel.startsWith(cantonRoot) || rel.startsWith(`${s.metaPrefix}-`);
      if (!own) continue;
      const state = touch(s.section);
      // Hub JSON changes only refresh the non-article surfaces. Every other
      // canton source can alter article HTML/canonical/alternate output.
      if (!isHubData) state.bootstrap = true;
    }
  }
  return sections
    .filter((s) => plan.has(s.section))
    .map((s) => {
      const state = plan.get(s.section);
      return {
        section: s.section,
        ids: state.bootstrap ? [] : [...state.ids].sort(),
        bootstrap: state.bootstrap,
      };
    });
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
    if (cmd === 'body-regex') console.log(bodyRegex(ARTICLE_SECTION_CORE_LIST, { served: arg }));
    else if (cmd === 'r2-plan') console.log(JSON.stringify(r2PublishPlan(readFileSync(0, 'utf8').split('\n'))));
    else if (cmd === 'section-of' && arg) console.log(sectionOf(arg));
    else if (cmd === 'shard-of' && arg) console.log(shardOf(arg));
    else throw new Error('uso: fast-publish-section.mjs body-regex [shard|r2] | section-of <path> | shard-of <section> | r2-plan < files');
  } catch (error) {
    console.error(`::error::fast-publish-section: ${error?.message ?? error}`);
    process.exit(1);
  }
}

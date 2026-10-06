/**
 * engine-loader.mjs — carica la tassonomia dell'engine (`topicClusters.ts`,
 * `topicTaxonomy.ts`) da uno script `.mjs`.
 *
 * L'engine e' TypeScript con specificatori relativi SENZA estensione
 * (`from './relatedArticlesIndex'`), il motivo per cui il build usa `tsx`.
 * Sotto `tsx` l'import diretto funziona. Sotto `node` puro (>= 22.18, che
 * toglie i tipi da solo) manca solo la risoluzione dell'estensione: la
 * aggiunge un hook di `resolve` limitato agli import relativi fatti DA un file
 * `.ts`. Cosi' il producer degli hub e i suoi test girano senza `npx` (cioe'
 * senza rete) e senza `npm ci`, come il resto di `generator/tests/`.
 */
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../engine');

let hookRegistered = false;
/**
 * Registrato PRIMA del primo import, non dopo un tentativo fallito: su Node 22
 * un modulo il cui caricamento e' fallito resta in cache come fallito, e il
 * secondo `import()` dello stesso URL ripete l'errore anche con l'hook attivo.
 * Sotto `tsx` l'hook e' innocuo: tocca solo specificatori relativi senza
 * estensione il cui `.ts`/`.mjs` esiste, e passa il resto al resolver di tsx.
 * Su un Node senza `registerHooks` non fa nulla: li' serve `tsx`.
 */
function registerExtensionlessTsHook() {
  if (hookRegistered || typeof module.registerHooks !== 'function') return;
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (/^\.\.?\//.test(specifier) && context.parentURL?.endsWith('.ts') && !path.extname(specifier)) {
        const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
        for (const ext of ['.ts', '.mjs']) {
          if (fs.existsSync(base + ext)) return nextResolve(pathToFileURL(base + ext).href, context);
        }
      }
      return nextResolve(specifier, context);
    },
  });
  hookRegistered = true;
}

async function importEngine(file) {
  registerExtensionlessTsHook();
  try {
    return await import(pathToFileURL(path.join(ENGINE_DIR, file)).href);
  } catch (err) {
    if (['ERR_MODULE_NOT_FOUND', 'ERR_UNKNOWN_FILE_EXTENSION'].includes(err?.code)) {
      throw new Error(`engine/${file} non caricabile con questo Node (${process.version}): serve Node >= 22.18 oppure \`npx -y tsx@4.23.15\` — ${err.message}`);
    }
    throw err;
  }
}

let cached = null;

/**
 * @returns {Promise<{ assignArticlesToTopics: Function, buildCorpusModel: Function, tokenize: Function, TOPIC_CLUSTERS: ReadonlyArray<{ key: string, seedText: string }> }>}
 */
export async function loadTopicEngine() {
  if (cached) return cached;
  const clusters = await importEngine('topicClusters.ts');
  const taxonomy = await importEngine('topicTaxonomy.ts');
  const model = await importEngine('relatedArticlesIndex.ts');
  if (typeof clusters.assignArticlesToTopics !== 'function' || !Array.isArray(taxonomy.TOPIC_CLUSTERS)
    || typeof model.buildCorpusModel !== 'function' || typeof model.tokenize !== 'function') {
    throw new Error('engine: assignArticlesToTopics / TOPIC_CLUSTERS / buildCorpusModel / tokenize non trovati (mirror dell\'engine incompleto?)');
  }
  cached = {
    assignArticlesToTopics: clusters.assignArticlesToTopics,
    buildCorpusModel: model.buildCorpusModel,
    tokenize: model.tokenize,
    TOPIC_CLUSTERS: taxonomy.TOPIC_CLUSTERS,
  };
  return cached;
}

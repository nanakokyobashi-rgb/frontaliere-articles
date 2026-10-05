#!/usr/bin/env node
/**
 * publish-section-edge.mjs — porta all'edge (R2 + purge) il registro delle
 * sezioni cantonali e le loro sitemap, scritti da build-api.mjs in dist/api/.
 *
 * Gira in publish-api.yml dopo il deploy Pages, accanto alla spinta delle
 * sitemap blog. Il Worker del sito legge da R2:
 *
 *   edge/sections/registry.json            quale sezione e' live|draft|retired
 *   edge/sitemap-articles-<canton-id>.xml  servita solo se la sezione e' live
 *   edge/sitemap-cantons.xml               l'indice (dichiarato in robots.txt)
 *
 * ORDINE: prima le sitemap delle sezioni live, poi il registro, per ULTIMO
 * l'indice. Il registro e' cio' che rende visibile un cambio di stato, quindi
 * arriva quando le sitemap che il Worker servira' sono gia' al loro posto; se
 * un upload precedente non e' confermato il registro NON sale (resta lo stato
 * di prima, coerente con le copie che R2 ha davvero). L'indice e' solo un
 * annuncio e si scrive (o si cancella) SOLO dopo la conferma del registro: un
 * indice nuovo sopra un registro vecchio elencherebbe sitemap che il Worker
 * non serve, e lo step e' continue-on-error, quindi resterebbe cosi'.
 *
 * L'indice senza sezioni live non si riscrive vuoto (schema: minimo un
 * `<sitemap>`): si CANCELLA, cosi' il Worker torna al 404 di prima invece di
 * annunciare sitemap che non serve piu'.
 *
 * Registro assente in dist/api (kill-switch di Remote Config non verificato con
 * una sezione dichiarata live, vedi scripts/lib/section-registry.mjs): non si
 * tocca ne' il registro ne' l'indice su R2, che restano quelli dell'ultima
 * pubblicazione verificata.
 *
 * PURGE: ogni chiave scritta o cancellata si purga sia all'apex (l'URL che il
 * pubblico chiede) sia sul cdn (la subrequest del Worker ha un cacheTtl suo),
 * a blocchi di 30 (tetto del purge `files` del piano free, che
 * cf-purge-cache.mjs rifiuta di superare).
 *
 * Uso: node scripts/publish-section-edge.mjs [--dist dist/api] [--dry-run]
 * Esce 1 se un'operazione non e' andata a buon fine (lo step e'
 * continue-on-error: il fallimento resta visibile senza fermare un publish
 * buono).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EDGE_SECTION_REGISTRY_FILE,
  SECTIONS_CATALOG_FILE,
  SECTION_SITEMAP_INDEX_FILE,
} from './lib/section-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APEX = 'https://frontaliereticino.ch';
export const CDN = 'https://cdn.frontaliereticino.ch';
export const PURGE_CHUNK = 30;
/** Il Worker rilegge il registro ogni 60 s: un max-age piu' lungo al cdn ritarderebbe il flip. */
export const REGISTRY_CACHE_CONTROL = 'public,max-age=60';
/** Stessa classe delle sitemap blog spinte da publish-api.yml. */
export const SITEMAP_CACHE_CONTROL = 'public,max-age=600';

/**
 * Il piano delle operazioni, puro: legge solo cio' che build-api ha scritto.
 * @param {string} distDir
 * @returns {{ ops: Array<{ op: 'upload'|'delete', local?: string, key: string, cacheControl?: string, purge: string[] }>, notes: string[] }}
 */
export function planSectionEdge(distDir) {
  const at = (name) => path.join(distDir, name);
  const notes = [];
  const catalogPath = at(SECTIONS_CATALOG_FILE);
  if (!fs.existsSync(catalogPath)) throw new Error(`${SECTIONS_CATALOG_FILE} assente in ${distDir}: build-api non l'ha scritto`);
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const ops = [];
  const purgeFor = (file) => [`${APEX}/${file}`, `${CDN}/edge/${file}`];

  for (const entry of catalog.sections.filter((e) => e.status === 'live')) {
    const file = String(entry.sitemap ?? '').replace(/^\//, '');
    if (!/^sitemap-articles-canton-[a-z]+\.xml$/.test(file)) throw new Error(`${entry.id}: sitemap "${entry.sitemap}" fuori forma`);
    if (!fs.existsSync(at(file))) throw new Error(`${entry.id}: live ma ${file} manca in ${distDir}`);
    ops.push({ op: 'upload', local: at(file), key: `edge/${file}`, cacheControl: SITEMAP_CACHE_CONTROL, purge: purgeFor(file) });
  }

  if (!fs.existsSync(at(EDGE_SECTION_REGISTRY_FILE))) {
    notes.push(
      `${EDGE_SECTION_REGISTRY_FILE} non emesso (kill-switch non verificato): registro e indice su R2 restano quelli pubblicati`,
    );
    return { ops, notes };
  }

  ops.push({
    op: 'upload',
    local: at(EDGE_SECTION_REGISTRY_FILE),
    key: EDGE_SECTION_REGISTRY_FILE,
    cacheControl: REGISTRY_CACHE_CONTROL,
    purge: [`${CDN}/${EDGE_SECTION_REGISTRY_FILE}`],
    registry: true,
  });
  if (fs.existsSync(at(SECTION_SITEMAP_INDEX_FILE))) {
    ops.push({
      op: 'upload',
      local: at(SECTION_SITEMAP_INDEX_FILE),
      key: `edge/${SECTION_SITEMAP_INDEX_FILE}`,
      cacheControl: SITEMAP_CACHE_CONTROL,
      purge: purgeFor(SECTION_SITEMAP_INDEX_FILE),
    });
  } else {
    ops.push({ op: 'delete', key: `edge/${SECTION_SITEMAP_INDEX_FILE}`, purge: purgeFor(SECTION_SITEMAP_INDEX_FILE) });
  }
  return { ops, notes };
}

/** Le URL da purgare, a blocchi da `size`, senza duplicati. */
export function purgeChunks(urls, size = PURGE_CHUNK) {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`purgeChunks: size non valido (${size})`);
  const unique = [...new Set(urls)];
  const chunks = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(res.stdout ?? '');
  process.stderr.write(res.stderr ?? '');
  return { code: res.status ?? 1, stdout: res.stdout ?? '' };
}

export function main(argv = process.argv.slice(2)) {
  const distIdx = argv.indexOf('--dist');
  const distArg = distIdx >= 0 ? argv[distIdx + 1] : 'dist/api';
  if (!distArg || distArg.startsWith('--')) throw new Error('--dist richiede una cartella (es. --dist dist/api)');
  const distDir = path.resolve(ROOT, distArg);
  const dryRun = argv.includes('--dry-run');
  const { ops, notes } = planSectionEdge(distDir);
  for (const note of notes) console.log(`::notice::[section-edge] ${note}`);
  if (dryRun) {
    console.log(JSON.stringify(ops, null, 2));
    return 0;
  }
  let failures = 0;
  const purged = [];
  for (const op of ops) {
    if (op.registry && failures > 0) {
      console.log('::warning::[section-edge] registro NON caricato: un upload precedente non e\' confermato');
      failures++;
      break;
    }
    if (op.op === 'upload') {
      const { stdout } = run('bash', ['scripts/lib/upload-cdn-file.sh', op.local, op.key, op.cacheControl]);
      if (!stdout.includes('✅ uploaded')) {
        failures++;
        console.log(`::warning::[section-edge] upload non confermato: ${op.key}`);
        // Senza registro nuovo confermato l'indice non si tocca: resta quello
        // che il registro vecchio annuncia.
        if (op.registry) break;
        continue;
      }
    } else {
      const { stdout } = run('bash', ['scripts/lib/delete-cdn-file.sh', op.key]);
      if (!stdout.includes('✅ deleted')) {
        failures++;
        console.log(`::warning::[section-edge] cancellazione non confermata: ${op.key}`);
        continue;
      }
    }
    purged.push(...op.purge);
  }
  for (const chunk of purgeChunks(purged)) {
    const { code } = run('bash', ['scripts/ci/retry-cmd.sh', 'node', 'scripts/cf-purge-cache.mjs', `--files=${chunk.join(',')}`]);
    if (code !== 0) failures++;
  }
  console.log(`[section-edge] ${ops.length} operazioni, ${purged.length} URL purgate, ${failures} fallimenti`);
  return failures ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`::error::[section-edge] ${error.message}`);
    process.exitCode = 1;
  }
}

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
 * PRIMA DEL DEPLOY PAGES, e fail-closed quando conta. `sections.json` (il
 * catalogo che il sito legge) viaggia con Pages: catalogo e registro devono
 * descrivere lo stesso stato. Quindi publish-api.yml esegue questo script
 * prima di caricare l'artefatto Pages, e lo script:
 *   1. legge il registro che R2 ha ADESSO (`fetchPreviousRegistry`);
 *   2. se lo stato delle sezioni da pubblicare DIFFERISCE (accensione,
 *      spegnimento, ritiro, redirect/gone) il push e' OBBLIGATORIO: credenziali
 *      assenti o un'operazione non confermata fanno uscire 1 e fermano il
 *      publish, col catalogo di prima ancora su Pages;
 *   3. se il registro nuovo era gia' salito e un passo successivo fallisce,
 *      RIPRISTINA quello di prima, perche' Worker e catalogo non restino su
 *      due commit diversi;
 *   4. se lo stato e' lo stesso (oggi: tutto `draft`), il push cambia solo il
 *      `commit`: un problema di R2 e' un warning ed esce 0, e non ferma la
 *      pubblicazione degli articoli.
 *
 * Uso: node scripts/publish-section-edge.mjs [--dist dist/api] [--dry-run]
 *        [--previous <file>|absent|unknown]   stato precedente dato a mano (test, diagnosi)
 */
import fs from 'node:fs';
import os from 'node:os';
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

/**
 * Lo stato di un registro edge ridotto a cio' che il Worker applica: per ogni
 * sezione `status`, `redirects`, `gone` (una sezione assente vale `draft`,
 * come nel Worker). Il `commit` non e' stato.
 */
export function registryState(doc) {
  const out = {};
  for (const [id, entry] of Object.entries(doc?.sections ?? {})) {
    const status = entry?.status ?? 'draft';
    const redirects = Object.entries(entry?.redirects ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const gone = [...(entry?.gone ?? [])].sort();
    if (status === 'draft' && redirects.length === 0 && gone.length === 0) continue;
    out[id] = { status, redirects, gone };
  }
  return JSON.stringify(Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * Se questo push DEVE riuscire perche' il publish prosegua.
 *
 * `sections.json` esce con Pages subito dopo: catalogo e registro devono dire
 * lo stesso stato. Il push e' quindi obbligatorio ogni volta che lo stato da
 * pubblicare DIFFERISCE da quello che R2 ha gia' — in entrambe le direzioni:
 * un'accensione (il catalogo annuncerebbe una sezione che il Worker serve 404)
 * e uno spegnimento o un ritiro (il catalogo direbbe spenta una sezione che il
 * registro vecchio serve ancora). Se lo stato e' lo stesso, il push cambia
 * solo il `commit` e un problema di R2 non deve fermare gli articoli.
 *
 * `previous`: `{ state: 'ok', doc }` il registro letto da R2; `{ state:
 * 'absent' }` mai pubblicato (vale tutto `draft`); `{ state: 'unknown' }`
 * illeggibile — allora non si puo' dimostrare che lo stato coincide, e il
 * push e' obbligatorio appena il catalogo dichiara qualcosa di non-draft.
 *
 * @param {string} distDir
 * @param {{ state: 'ok' | 'absent' | 'unknown', doc?: unknown }} previous
 */
export function edgePushIsMandatory(distDir, previous) {
  const at = (name) => path.join(distDir, name);
  const catalog = JSON.parse(fs.readFileSync(at(SECTIONS_CATALOG_FILE), 'utf8'));
  const declaresSomething = (catalog.sections ?? []).some(
    (entry) => entry.status !== 'draft' || (entry.declaredStatus ?? 'draft') !== 'draft',
  );
  if (!previous || previous.state === 'unknown') return declaresSomething;
  // Registro non emesso (kill-switch non verificato): non c'e' niente da
  // spingere, il catalogo tiene draft le sezioni live e R2 resta com'e'.
  if (!fs.existsSync(at(EDGE_SECTION_REGISTRY_FILE))) return false;
  const next = JSON.parse(fs.readFileSync(at(EDGE_SECTION_REGISTRY_FILE), 'utf8'));
  return registryState(next) !== registryState(previous.state === 'ok' ? previous.doc : { sections: {} });
}

/**
 * Il registro che R2 ha ADESSO, letto dal CDN con un cache-buster.
 * @returns {Promise<{ state: 'ok', doc: unknown, raw: string } | { state: 'absent' } | { state: 'unknown' }>}
 */
export async function fetchPreviousRegistry(fetchImpl = fetch) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(`${CDN}/${EDGE_SECTION_REGISTRY_FILE}?_secb=${Date.now()}.${attempt}`, {
        headers: { 'user-agent': 'frontaliere-corpus-publisher/1 (+https://frontaliereticino.ch)' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 404) return { state: 'absent' };
      if (res.status === 200) {
        const raw = await res.text();
        return { state: 'ok', doc: JSON.parse(raw), raw };
      }
    } catch {
      /* ritenta, poi illeggibile */
    }
  }
  return { state: 'unknown' };
}

/** `--previous <file>|absent|unknown`: lo stato precedente dato a mano (test, diagnosi) invece che letto dal CDN. */
function previousFromArg(value) {
  if (value === 'absent' || value === 'unknown') return { state: value };
  const raw = fs.readFileSync(path.resolve(value), 'utf8');
  return { state: 'ok', doc: JSON.parse(raw), raw };
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

const VALUE_FLAGS = ['--dist', '--previous'];

function parseCli(argv) {
  const out = { dist: 'dist/api', dryRun: false, previous: null };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error(`${arg} va indicato una volta sola`);
    seen.add(arg);
    if (arg === '--dry-run') out.dryRun = true;
    else if (VALUE_FLAGS.includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} richiede un valore`);
      out[arg.slice(2)] = value;
    } else throw new Error(`argomenti sconosciuti: ${arg} (ammessi: --dist <cartella>, --previous <file|absent|unknown>, --dry-run)`);
  }
  return out;
}

/**
 * Riporta su R2 il registro di prima dopo un push riuscito a meta'. Il
 * workflow si ferma prima del deploy Pages, quindi il catalogo servito resta
 * quello vecchio: anche il registro deve tornare quello vecchio, o Worker e
 * catalogo descriverebbero due commit diversi.
 * @returns {boolean} true se il ripristino e' confermato
 */
function rollbackRegistry(previous, tmpDir) {
  let ok = false;
  if (previous.state === 'ok') {
    const file = path.join(tmpDir, 'previous-registry.json');
    fs.writeFileSync(file, previous.raw);
    ok = run('bash', ['scripts/lib/upload-cdn-file.sh', file, EDGE_SECTION_REGISTRY_FILE, REGISTRY_CACHE_CONTROL]).stdout.includes('✅ uploaded');
  } else if (previous.state === 'absent') {
    ok = run('bash', ['scripts/lib/delete-cdn-file.sh', EDGE_SECTION_REGISTRY_FILE]).stdout.includes('✅ deleted');
  }
  if (ok) run('bash', ['scripts/ci/retry-cmd.sh', 'node', 'scripts/cf-purge-cache.mjs', `--files=${CDN}/${EDGE_SECTION_REGISTRY_FILE}`]);
  return ok;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const cli = parseCli(argv);
  const distDir = path.resolve(ROOT, cli.dist);
  const { ops, notes } = planSectionEdge(distDir);
  for (const note of notes) console.log(`::notice::[section-edge] ${note}`);
  if (cli.dryRun) {
    console.log(JSON.stringify(ops, null, 2));
    return 0;
  }
  const previous = cli.previous ? previousFromArg(cli.previous) : await fetchPreviousRegistry();
  const mustSucceed = edgePushIsMandatory(distDir, previous);
  console.log(
    `[section-edge] registro su R2: ${previous.state}; push ${mustSucceed ? 'OBBLIGATORIO (lo stato delle sezioni cambia, o non e\' dimostrabile che coincida)' : 'facoltativo (stesso stato delle sezioni)'}`,
  );
  const stop = (what) => {
    if (mustSucceed) {
      console.log(`::error::[section-edge] ${what} — lo stato delle sezioni cambia: il publish si ferma, il catalogo su Pages resta quello di prima`);
      return 1;
    }
    console.log(`::warning::[section-edge] ${what} — lo stato delle sezioni su R2 e' gia' quello da pubblicare: il publish prosegue`);
    return 0;
  };
  const missingCreds = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_S3_ENDPOINT', 'R2_BUCKET', 'CF_API_TOKEN'].filter((name) => !env[name]);
  if (missingCreds.length) return stop(`credenziali assenti (${missingCreds.join(', ')}): registro e sitemap cantonali NON caricati`);

  let failures = 0;
  let registryUploaded = false;
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
      if (op.registry) registryUploaded = true;
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
  if (!failures) return 0;

  // Push riuscito a META' con un registro nuovo gia' su R2 e il publish che
  // sta per fermarsi: si ripristina il registro di prima, cosi' il Worker non
  // resta su uno stato che il catalogo servito non descrive.
  if (registryUploaded && mustSucceed) {
    const tmpDir = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'section-edge-'));
    const restored = rollbackRegistry(previous, tmpDir);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(
      restored
        ? '::warning::[section-edge] registro ripristinato allo stato precedente'
        : `::error::[section-edge] registro NON ripristinato (stato precedente: ${previous.state}): R2 ha il registro nuovo, Pages il catalogo vecchio — rilanciare publish-api`,
    );
  }
  return stop('operazioni non confermate');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`::error::[section-edge] ${error.message}`);
      process.exitCode = 1;
    },
  );
}

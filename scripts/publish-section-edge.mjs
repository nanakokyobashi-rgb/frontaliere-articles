#!/usr/bin/env node
/**
 * publish-section-edge.mjs — porta su R2 la RELEASE delle sezioni cantonali
 * (registro, payload hub, sitemap delle sezioni live, indice) scritta da build-api.mjs in
 * dist/api/, con un flip realmente versionato: UN solo PUT cambia cio' che il
 * Worker serve.
 *
 * ── Una sola fonte, un solo oggetto mutabile ───────────────────────────────
 *
 * Cio' che e' `live|draft|retired` lo dice UN documento: il registro su R2,
 * `edge/sections/registry.json`, che il Worker del sito applica
 * (`parseCorpusSectionRegistry` in infra/cloudflare-worker/locale-router.js).
 * `sections.json` su GitHub Pages e' un catalogo senza stato.
 *
 * Quel documento e' anche il PUNTATORE alla release: oltre ai campi di stato
 * (invariati, quelli che il Worker gia' legge) porta
 *
 *   release: {
 *     commit: "<snapshot sha>",
 *     base: "edge/sections/_releases/<snapshot sha>/",
 *     files: { "sitemap-cantons.xml": { sha256, bytes },
 *              "sitemap-articles-<id>.xml": { sha256, bytes }, … },
 *     previous: { base, files: [nomi] } | null      // la release che sostituisce
 *   }
 *
 * Il payload hub, le sitemap e l'indice stanno SOLO sotto `release.base`,
 * immutabili per snapshot effettivo: non esistono path fissi da sovrascrivere. Il Worker risolve
 * `/sitemap-cantons.xml` e `/sitemap-articles-<id>.xml` come `<base><nome>`
 * (404 se il nome non e' in `files`), quindi registro, sitemap e indice
 * cambiano TUTTI INSIEME con il puntatore, e non c'e' niente da ripristinare.
 *
 * ── Protocollo ─────────────────────────────────────────────────────────────
 *
 * 0. LETTURA. Si legge dal CDN il puntatore servito adesso e si rilegge OGNI
 *    file che dichiara in `release.files`. Lo stato precedente e' NOTO solo se
 *    il puntatore rispetta il contratto del Worker e ogni file c'e' con lo
 *    sha256 dichiarato; altrimenti e' `unknown`. Il push e' OBBLIGATORIO se la
 *    release differisce da quella servita (`releaseDiffers`) — nello stato
 *    delle sezioni (status, redirects, gone: accensione, spegnimento, ritiro)
 *    o nell'insieme/nei byte dei file — e SEMPRE se lo stato precedente e'
 *    `unknown` (mai exit 0 su uno stato non dimostrato, nemmeno per una
 *    release tutta `draft`: potrebbe essere uno spegnimento).
 *
 * 1. STAGING (niente di servito cambia). Ogni file sale sotto `release.base`
 *    e viene riletto dal CDN: sha256 e lunghezza dei byte serviti devono
 *    essere quelli locali. Fallimento: exit, nessun cambio.
 *
 * 1b. PAGINE. Il puntatore sta per dichiarare delle sitemap: OGNI URL che
 *    annunciano — le `<loc>` e gli `href` degli alternate, quindi tutte e
 *    quattro le lingue di ogni articolo, hub e pagina d'archivio — deve essere
 *    gia' su R2 (`edge/sections/<path>/index.html`, chiavi fisse scritte da
 *    publish-section-pages.mjs), o il flip pubblicherebbe link che rispondono
 *    404. Per una sezione che DIVENTA live si rileggono tutti; per una gia'
 *    live quelli che la sitemap servita non annunciava gia', piu' le 4
 *    landing. Ogni pagina deve rispondere 200 e portare il meta
 *    `ft-route-owner`. Le pagine mancanti si riprovano fino al deadline del
 *    lease (fast-publish-section parte dallo stesso push e puo' finire dopo);
 *    se alla fine ne manca una: exit, nessun cambio.
 *
 * 2. HANDSHAKE + FLIP. Il publisher prende con PUT condizionale i lease delle
 *    sezioni live, ricontrolla le pagine e fa UN PUT del puntatore. I lease
 *    vengono rilasciati dopo il flip, con retry bounded per ogni tombstone non
 *    confermato. E' l'unico passo che cambia cio' che il Worker serve.
 *    Fallimento del flip: la release servita resta quella di prima, intera.
 *
 * 3. PURGE (la release nuova e' gia' servita, intera). Il puntatore e le URL
 *    apex delle sitemap che la release precedente o la nuova espongono. Un
 *    purge fallito non rende incoerente niente (il Worker rilegge il
 *    puntatore entro 60 s, e i file di una release non cambiano mai): si esce
 *    con errore e il publish successivo riprova.
 *
 * 4. PULIZIA (best-effort). Si cancella la release che la PRECEDENTE aveva
 *    sostituito (`previous.release.previous`): mai la release puntata, mai la
 *    precedente (una richiesta in volo puo' ancora leggerla).
 *
 * ESITO. In un push obbligatorio un fallimento esce 1 e il job di
 * publish-api.yml risulta fallito. Lo step gira DOPO il deploy Pages e PRIMA
 * della notifica al sito: le superfici di famiglia (canton-articles.json,
 * slugs.json.cantons, i feed) escono con Pages, quindi il puntatore gira solo
 * quando Pages ha gia' la release nuova — un deploy fallito lascia R2 com'era,
 * e un flip fallito lascia Pages avanti di un catalogo che non porta stato e
 * FERMA il job prima di `Notify the site`, che annuncerebbe al sito una
 * superficie che R2 non serve ancora. Se niente di servito
 * cambia (oggi: tutto `draft`, nessun file) un problema di R2 e' un warning ed
 * esce 0.
 *
 * Registro assente in dist/api (kill-switch di Remote Config non verificato
 * con una sezione dichiarata live, vedi scripts/lib/section-registry.mjs):
 * nessuna release, R2 resta com'e'.
 *
 * Uso: node scripts/publish-section-edge.mjs [--dist dist/api] [--dry-run]
 */
import '../host/cantonSectionsBootstrap.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchWithRefTimeout, releaseFetchWithRefTimeout } from '../generator/scripts/lib/fetch-with-ref-timeout.mjs';

import { CORPUS_ROUTE_OWNER_META_TAG } from '../engine/shared/corpusRouteOwner.mjs';
import { familySectionPages } from './lib/build-sitemap.mjs';
import {
  parseSectionBootstrapLock,
  sectionBootstrapLockKey,
} from './lib/section-bootstrap-lock.mjs';
import {
  EDGE_SECTION_REGISTRY_FILE,
  SECTION_SITEMAP_INDEX_FILE,
  validateEdgeSectionRegistry,
} from './lib/section-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APEX = 'https://frontaliereticino.ch';
export const CDN = 'https://cdn.frontaliereticino.ch';
export const PURGE_CHUNK = 30;
export const RELEASES_PREFIX = 'edge/sections/_releases';
/** Payload runtime degli hub, servito dalla stessa release immutabile del registry. */
export const CANTON_HUBS_API = 'canton-hubs.json';
/** Il Worker rilegge il registro ogni 60 s: un max-age piu' lungo al cdn ritarderebbe il flip. */
export const REGISTRY_CACHE_CONTROL = 'public,max-age=60';
/** Una chiave di release non cambia mai contenuto. */
export const RELEASE_CACHE_CONTROL = 'public,max-age=31536000,immutable';
/**
 * Un oggetto appena caricato puo' essere leggibile da R2 prima che il CDN
 * abbia propagato la stessa chiave. Il controllo di staging resta bounded ma
 * non tratta la prima risposta vuota come un fallimento definitivo.
 */
export const STAGING_VERIFY_ATTEMPTS = 6;
export const STAGING_VERIFY_RETRY_MS = 4000;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Keep adapter/test overrides finite and ensure bounded loops still run. */
export function normalizeBoundedAttempts(value, fallback) {
  let numeric;
  try {
    numeric = Number(value);
  } catch {
    return fallback;
  }
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.floor(numeric));
}

export function normalizeStagingVerifyAttempts(value) {
  return normalizeBoundedAttempts(value, STAGING_VERIFY_ATTEMPTS);
}

export function hasResponseBody(response) {
  return ArrayBuffer.isView(response?.body);
}

/**
 * A fetch adapter must return bytes for a successful response.  Treat a
 * `200` without a body as an unverifiable read instead of dereferencing it in
 * one of the pre-flip consumers below.  The real adapter always returns a
 * Buffer, while tests and alternative adapters may use any typed array.
 */
const responseBytes = (response) => {
  const body = response?.body;
  if (!ArrayBuffer.isView(body)) return null;
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
};

/**
 * Verify a staged CDN response without trusting an adapter to provide a body.
 * A 200 without bytes is an incomplete propagation, not a successful staging
 * read; callers must keep the release fail-closed and retry within their bound.
 */
export function hasExpectedStagingBody(served, file) {
  const body = responseBytes(served);
  if (served?.status !== 200 || !body) return false;
  return body.byteLength === file.bytes && sha256(body) === file.sha256;
}

/**
 * Lo stato di un registro ridotto a cio' che il Worker applica: per ogni
 * sezione `status`, `redirects`, `gone` (una sezione assente vale `draft`,
 * come nel Worker). `commit` e `release` non sono stato.
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

/** Il prefisso (con `/` finale) dei file di una release. */
export const releaseBase = (commit) => `${RELEASES_PREFIX}/${commit}/`;

/**
 * Identita' della release effettiva quando lo stesso HEAD viene rigenerato con
 * un kill-switch diverso o con byte diversi. La prima pubblicazione conserva
 * la chiave `<registry.commit>` per compatibilita'; `publishRelease` usa questa
 * chiave solo quando rileva una collisione con la base gia' puntata.
 */
export function releaseSnapshotCommit(release) {
  const material = JSON.stringify({
    commit: release.commit,
    state: registryState(release.registry),
    files: release.files
      .map(({ name, sha256: hash, bytes }) => ({ name, sha256: hash, bytes }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
  return sha256(material).slice(0, 40);
}

const RELEASE_FILE_RE = /^(sitemap-articles-canton-[a-z]+\.xml|sitemap-cantons\.xml|canton-hubs\.json)$/;
const RELEASE_PURGE_FILE_RE = /^(sitemap-articles-canton-[a-z]+\.xml|sitemap-cantons\.xml)$/;

/** Purge idempotente delle superfici apex che una release puo' aver annunciato. */
function purgeApexUrls(io, ...fileSets) {
  const names = new Set([SECTION_SITEMAP_INDEX_FILE]);
  for (const files of fileSets) {
    for (const file of files ?? []) {
      const name = typeof file === 'string' ? file : file?.name;
      if (RELEASE_PURGE_FILE_RE.test(name ?? '')) names.add(name);
    }
  }
  return io.purge([`${CDN}/${EDGE_SECTION_REGISTRY_FILE}`, ...[...names].map((name) => `${APEX}/${name}`)]);
}

/**
 * I file che un puntatore dichiara, come `{ nome: sha256 }`, o `null` se la
 * dichiarazione non e' leggibile (manca `release` mentre una sezione e' live,
 * base fuori da `_releases/`, nomi o hash fuori forma): allora non si puo'
 * sapere cosa il Worker sta servendo.
 */
export function declaredFiles(doc) {
  const release = doc?.release;
  const anyLive = Object.values(doc?.sections ?? {}).some((entry) => entry?.status === 'live');
  if (release === undefined || release === null) return anyLive ? null : {};
  if (!isPlainObject(release) || !isPlainObject(release.files)) return null;
  if (typeof release.base !== 'string' || !/^edge\/sections\/_releases\/[0-9a-f]{7,40}\/$/.test(release.base)) return null;
  const out = {};
  for (const [name, meta] of Object.entries(release.files)) {
    if (!RELEASE_FILE_RE.test(name) || !isPlainObject(meta) || !/^[0-9a-f]{64}$/.test(meta.sha256 ?? '')) return null;
    out[name] = meta.sha256;
  }
  return out;
}

/**
 * La release da pubblicare, letta da cio' che build-api ha scritto; `null` se
 * build-api non ha emesso il registro (allora non c'e' niente da pubblicare).
 * Il puntatore si completa con `withPrevious` quando si conosce la release
 * che sostituisce.
 *
 * @returns {null | {
 *   commit: string, base: string, registry: object, live: string[],
 *   files: Array<{ name: string, local: string, sha256: string, bytes: number, key: string }>,
 *   pointer: object,
 * }}
 */
export function planRelease(distDir) {
  const at = (name) => path.join(distDir, name);
  if (!fs.existsSync(at(EDGE_SECTION_REGISTRY_FILE))) return null;
  const registry = JSON.parse(fs.readFileSync(at(EDGE_SECTION_REGISTRY_FILE), 'utf8'));
  if (!validateEdgeSectionRegistry(registry)) throw new Error(`${EDGE_SECTION_REGISTRY_FILE}: il Worker rifiuterebbe questo registro`);
  const live = Object.keys(registry.sections).filter((id) => registry.sections[id].status === 'live');
  const base = releaseBase(registry.commit);
  const names = live.map((id) => `sitemap-articles-${id}.xml`);
  const hasIndex = fs.existsSync(at(SECTION_SITEMAP_INDEX_FILE));
  if (hasIndex !== live.length > 0) {
    throw new Error(`${SECTION_SITEMAP_INDEX_FILE} ${hasIndex ? 'presente' : 'assente'} con ${live.length} sezioni live: release incoerente`);
  }
  if (hasIndex) names.push(SECTION_SITEMAP_INDEX_FILE);
  if (live.length > 0) {
    const hubFile = at(CANTON_HUBS_API);
    if (!fs.existsSync(hubFile)) throw new Error(`${CANTON_HUBS_API}: manca in ${distDir} (sezione live senza payload runtime?)`);
    let hubs;
    try {
      hubs = JSON.parse(fs.readFileSync(hubFile, 'utf8'));
    } catch (error) {
      throw new Error(`${CANTON_HUBS_API}: JSON illeggibile (${error.message})`, { cause: error });
    }
    const hubSections = isPlainObject(hubs?.sections) ? Object.keys(hubs.sections).sort() : [];
    if (hubs?.schema !== 1 || hubs.commit !== registry.commit || hubSections.join(',') !== live.slice().sort().join(',')) {
      throw new Error(`${CANTON_HUBS_API}: commit/sezioni non corrispondono al registry della release`);
    }
    // Il file sale sotto la base immutabile prima del flip del registry. Il
    // sito lo legge da qui, non dal JSON mutable di GitHub Pages/Fastly.
    names.push(CANTON_HUBS_API);
  }
  const files = names.map((name) => {
    if (!fs.existsSync(at(name))) throw new Error(`${name}: manca in ${distDir} (sezione live senza sitemap?)`);
    const body = fs.readFileSync(at(name));
    return { name, local: at(name), sha256: sha256(body), bytes: body.length, key: `${base}${name}` };
  });
  const pointer = {
    ...registry,
    release: {
      commit: registry.commit,
      base,
      files: Object.fromEntries(files.map((f) => [f.name, { sha256: f.sha256, bytes: f.bytes }])),
      previous: null,
    },
  };
  // Il puntatore E' il registro che il Worker legge: deve restare nel suo contratto.
  if (!validateEdgeSectionRegistry(pointer)) throw new Error('puntatore fuori dal contratto del Worker');
  return { commit: registry.commit, base, registry, live, files, pointer };
}

/**
 * Se la release da pubblicare differisce da quella servita: nello stato delle
 * sezioni o nei file (insieme dei nomi e sha256). Uno stato precedente non
 * dimostrato differisce sempre.
 * @param {{ registry: object, pointer: object }} release
 * @param {{ state: 'ok' | 'absent' | 'unknown', doc?: unknown }} previous
 */
export function releaseDiffers(release, previous) {
  if (!previous || previous.state === 'unknown') return true;
  const before = previous.state === 'ok' ? previous.doc : { sections: {} };
  if (registryState(release.registry) !== registryState(before)) return true;
  const next = declaredFiles(release.pointer) ?? {};
  const prev = declaredFiles(before);
  if (prev === null) return true;
  const sorted = (files) => JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  return sorted(next) !== sorted(prev);
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

function runAsync(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      resolve({ code, stdout, stderr });
    };
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      stderr += error.message;
      finish(1);
    });
    child.on('close', (status) => finish(status ?? 1));
  });
}

/** Le operazioni vere su R2 e Cloudflare; i test ne passano di finte. */
export const realIo = {
  upload: (local, key, cacheControl) => run('bash', ['scripts/lib/upload-cdn-file.sh', local, key, cacheControl]).stdout.includes('✅ uploaded'),
  remove: (key) => run('bash', ['scripts/lib/delete-cdn-file.sh', key]).stdout.includes('✅ deleted'),
  acquireBootstrapLock: async (section, commit) => {
    const result = await runAsync('node', [
      'scripts/ci/section-bootstrap-lock.mjs', 'acquire',
      '--section', section, '--commit', commit, '--role', 'edge-publisher',
    ]);
    if (result.code === 2) return 'busy';
    return result.code === 0 && result.stdout.includes('bootstrap lock acquisito atomicamente') ? 'acquired' : 'error';
  },
  releaseBootstrapLock: async (section) => {
    const result = await runAsync('node', [
      'scripts/ci/section-bootstrap-lock.mjs', 'release',
      '--section', section, '--role', 'edge-publisher',
    ]);
    return result.code === 0 && result.stdout.includes('bootstrap lock rilasciato atomicamente');
  },
  purge: (urls) =>
    purgeChunks(urls).every(
      (chunk) => run('bash', ['scripts/ci/retry-cmd.sh', 'node', 'scripts/cf-purge-cache.mjs', `--files=${chunk.join(',')}`]).code === 0,
    ),
  /** GET sul CDN con cache-buster: `{ status, body }`, o `{ status: 0 }` se la rete non risponde. */
  fetchBytes: async (url) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetchWithRefTimeout(`${url}?_secb=${Date.now()}.${attempt}`, {
          headers: { 'user-agent': 'frontaliere-corpus-publisher/1 (+https://frontaliereticino.ch)' },
        }, 15000);
        if (res.status === 200) return { status: 200, body: Buffer.from(await res.arrayBuffer()) };
        if (res.status === 404) {
          releaseFetchWithRefTimeout(res);
          return { status: 404 };
        }
        releaseFetchWithRefTimeout(res);
      } catch {
        /* ritenta */
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return { status: 0 };
  },
};

/**
 * OGNI URL che una sitemap di sezione annuncia, come path canonici: le `<loc>`
 * e gli `href` degli alternate (`xhtml:link`). Gli articoli cantonali hanno ora
 * una `<loc>` per ogni locale pubblicato; leggere anche gli alternate resta
 * necessario per verificare la coerenza dei collegamenti e coprire eventuali
 * release storiche. Un URL fuori dall'apex e' un errore.
 */
export function sitemapPaths(sitemapXml, label = 'sitemap') {
  const urls = [
    ...[...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]),
    ...[...sitemapXml.matchAll(/<xhtml:link\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]),
  ];
  const paths = new Set();
  for (const url of urls) {
    if (!url.startsWith(`${APEX}/`)) throw new Error(`${label}: URL fuori dall'apex (${url})`);
    paths.add(url.slice(APEX.length));
  }
  return paths;
}

/**
 * Le chiavi R2 delle pagine che devono esserci PRIMA che il puntatore dichiari
 * questa sitemap: ogni URL che la sitemap annuncia e che la release servita
 * non annunciava gia' (tutti, per una sezione che diventa live o se la sitemap
 * precedente non e' leggibile), piu' sempre le 4 landing. La lista viene dalla
 * sitemap della release, non da un secondo calcolo: e' esattamente cio' che si
 * sta per dichiarare ai crawler.
 *
 * @param {string} section
 * @param {{ sitemapXml: string, previousSitemapXml?: string | null }} opts
 */
export function requiredPageKeys(section, { sitemapXml, previousSitemapXml = null }) {
  if (typeof sitemapXml !== 'string') throw new Error(`requiredPageKeys: serve la sitemap di ${section} per verificarne le pagine`);
  const landings = familySectionPages(section, 0, 1)
    .filter((page) => page.key === 'landing')
    .flatMap((page) => Object.values(page.paths));
  const already = previousSitemapXml ? sitemapPaths(previousSitemapXml, `sitemap precedente di ${section}`) : new Set();
  const paths = new Set(landings);
  for (const p of sitemapPaths(sitemapXml, `sitemap di ${section}`)) if (!already.has(p)) paths.add(p);
  return [...paths].map((canonicalPath) => `edge/sections${canonicalPath}index.html`);
}

/**
 * Quanto il publisher puo' attendere il bootstrap e ogni quanto ritenta.
 * La finestra del publisher e' bounded a 100 minuti per lasciare spazio al
 * replay quando il producer e' ancora in coda. Il lease del producer copre
 * invece l'intero timeout di 360 minuti, con margine di cleanup; il ruolo
 * edge-publisher usa un TTL separato e bounded al proprio job.
 */
export const BOOTSTRAP_WAIT_MS = 100 * 60 * 1000;
export const BOOTSTRAP_RETRY_MS = 20 * 1000;
/** Un tombstone transitorio non deve lasciare un lease attivo fino al TTL. */
export const BOOTSTRAP_RELEASE_ATTEMPTS = 3;

/**
 * Attende che i bootstrap live in corso rilascino il gate R2.
 *
 * La verifica delle pagine resta necessaria, ma non basta: senza questo gate
 * il publisher API potrebbe leggere una release pronta e fare il flip mentre
 * fast-publish sta ancora sostituendo le chiavi. Il marker ha una scadenza:
 * un runner morto non puo' bloccare per sempre il publisher, e il TTL del
 * ruolo edge-publisher non eredita quello del producer.
 */
export async function waitForBootstrapLocks(
  sections,
  io,
  { waitMs = BOOTSTRAP_WAIT_MS, retryMs = BOOTSTRAP_RETRY_MS, sleep, now = Date.now, deadline: deadlineAt } = {},
) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const ids = [...new Set((sections ?? []).filter((section) => typeof section === 'string' && section))];
  const deadline = deadlineAt ?? now() + Math.max(0, waitMs);
  let pending = [];
  for (;;) {
    pending = [];
    for (const section of ids) {
      const key = sectionBootstrapLockKey(section);
      const got = await io.fetchBytes(`${CDN}/${key}`);
      if (got.status === 404) continue;
      if (got.status !== 200) {
        pending.push(`${section} (lock non verificabile: HTTP ${got.status || 'nessuna risposta'})`);
        continue;
      }
      if (!hasResponseBody(got)) {
        pending.push(`${section} (lock non verificabile: body assente)`);
        continue;
      }
      const state = parseSectionBootstrapLock(responseBytes(got), { section, now: now() });
      if (state.state === 'active') pending.push(`${section} (${state.doc.owner})`);
      else if (state.state === 'unknown') pending.push(`${section} (${state.reason})`);
    }
    if (pending.length === 0 || now() + retryMs > deadline) return pending;
    await pause(Math.max(0, retryMs));
  }
}

/**
 * Rilascia in gruppi bounded tutti i lease e conserva il sottoinsieme non
 * confermato fra i tentativi. Il publisher deve ritentare il tombstone: dopo
 * il flip il lock non puo' essere lasciato nel solo stato locale del processo,
 * che termina subito dopo un errore.
 */
export async function releaseBootstrapLocks(
  sections,
  io,
  { attempts = BOOTSTRAP_RELEASE_ATTEMPTS, log = () => {} } = {},
) {
  const ids = [...new Set((sections ?? []).filter((section) => typeof section === 'string' && section))];
  if (ids.length === 0) return { released: true, pending: [], failures: new Map() };
  if (typeof io?.releaseBootstrapLock !== 'function') {
    return {
      released: false,
      pending: ids,
      failures: new Map(ids.map((section) => [section, 'releaseBootstrapLock mancante'])),
    };
  }

  const maxAttempts = normalizeBoundedAttempts(attempts, BOOTSTRAP_RELEASE_ATTEMPTS);
  let pending = ids;
  let failures = new Map();
  for (let attempt = 1; attempt <= maxAttempts && pending.length > 0; attempt++) {
    const outcomes = await mapLimit(pending, 8, async (section) => {
      try {
        if (await io.releaseBootstrapLock(section)) return { section, released: true };
        const reason = 'release lock non confermato';
        log(`::error::[section-edge] bootstrap lock di ${section} non rilasciato (tentativo ${attempt}/${maxAttempts})`);
        return { section, reason };
      } catch (error) {
        const reason = `release lock fallito (${error?.message ?? error})`;
        log(`::error::[section-edge] release bootstrap lock di ${section} fallito (tentativo ${attempt}/${maxAttempts}): ${error?.message ?? error}`);
        return { section, reason };
      }
    });
    pending = outcomes.filter(({ released }) => !released).map(({ section }) => section);
    failures = new Map(outcomes.filter(({ released }) => !released).map(({ section, reason }) => [section, reason]));
    if (pending.length > 0 && attempt < maxAttempts) {
      log(`::warning::[section-edge] ritento il release di ${pending.length} bootstrap lock (${pending.join(', ')}) (${attempt + 1}/${maxAttempts})`);
    }
  }
  return { released: pending.length === 0, pending, failures };
}

/**
 * Acquisisce i lease di tutte le sezioni della release con PUT condizionali.
 * Il GET usato dal comando CLI serve solo a ottenere l'ETag per sostituire un
 * tombstone scaduto: la decisione che vince la gara e' sempre il PUT R2 con
 * `If-None-Match`/`If-Match`. Se una sezione e' occupata, i lease parziali
 * vengono rilasciati e l'intero set viene ritentato, cosi' il publisher non
 * puo' tenere bloccata una sezione mentre attende un'altra.
 */
export async function acquireBootstrapLocks(
  sections,
  commit,
  io,
  {
    waitMs = BOOTSTRAP_WAIT_MS,
    retryMs = BOOTSTRAP_RETRY_MS,
    releaseAttempts = BOOTSTRAP_RELEASE_ATTEMPTS,
    sleep,
    now = Date.now,
    deadline: deadlineAt,
    log,
  } = {},
) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const ids = [...new Set((sections ?? []).filter((section) => typeof section === 'string' && section))].sort();
  const deadline = deadlineAt ?? now() + Math.max(0, waitMs);
  if (ids.length === 0) return { held: [], error: null };
  if (typeof io.acquireBootstrapLock !== 'function' || typeof io.releaseBootstrapLock !== 'function') {
    return { held: [], error: 'io bootstrap lock incompleto: mancano acquireBootstrapLock/releaseBootstrapLock' };
  }

  for (;;) {
    const outcomes = await mapLimit(ids, 8, async (section) => {
      try {
        const result = await io.acquireBootstrapLock(section, commit);
        if (result === 'acquired') return { section, result };
        if (result === 'busy') return { section, result };
        return { section, result: 'error', failure: `${section}: acquire lock non confermato (${result ?? 'nessun risultato'})` };
      } catch (error) {
        return { section, result: 'error', failure: `${section}: acquire lock fallito (${error?.message ?? error})` };
      }
    });
    const held = outcomes.filter(({ result }) => result === 'acquired').map(({ section }) => section);
    const busy = outcomes.find(({ result }) => result === 'busy')?.section ?? null;
    const failure = outcomes.find(({ result }) => result === 'error')?.failure ?? null;

    if (!busy && !failure && held.length === ids.length) return { held, error: null };

    const released = await releaseBootstrapLocks(held, io, { attempts: releaseAttempts, log });
    if (!released.released) {
      const section = released.pending[0] ?? held[0];
      return { held: [], error: `${section}: ${released.failures.get(section) ?? 'release lock non confermato'}` };
    }
    if (failure) return { held: [], error: failure };
    if (now() + Math.max(0, retryMs) > deadline) {
      return { held: [], error: `bootstrap lock occupato fino alla scadenza (${busy})` };
    }
    await pause(Math.max(0, retryMs));
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Le pagine richieste che NON sono su R2 (200 con il meta di proprieta' della
 * route). Per una sezione gia' live si controllano gli URL NUOVI rispetto alla
 * sitemap servita: un articolo appena generato viene caricato su R2 da
 * fast-publish-section.yml, che parte dallo stesso push di publish-api.yml e
 * puo' finire dopo. Per questo le pagine mancanti si riprovano fino a `waitMs`
 * prima di rinunciare: senza l'attesa ogni articolo cantonale farebbe fallire
 * il publish per una gara fra due workflow.
 */
export async function missingBootstrapPages(
  release,
  previous,
  io,
  { waitMs = BOOTSTRAP_WAIT_MS, retryMs = BOOTSTRAP_RETRY_MS, sleep, deadline: deadlineAt } = {},
) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const wasLive = (id) => previous.state === 'ok' && previous.doc.sections?.[id]?.status === 'live';
  let pending = [];
  for (const id of release.live) {
    const name = `sitemap-articles-${id}.xml`;
    const sitemap = release.files.find((f) => f.name === name);
    let previousSitemapXml = null;
    if (wasLive(id) && previous.doc.release?.files?.[name]) {
      const got = await io.fetchBytes(`${CDN}/${previous.doc.release.base}${name}`);
      if (got.status === 200 && hasResponseBody(got)) previousSitemapXml = responseBytes(got).toString('utf8');
    }
    pending.push(...requiredPageKeys(id, { sitemapXml: sitemap ? fs.readFileSync(sitemap.local, 'utf8') : undefined, previousSitemapXml }));
  }
  const present = async (key) => {
    const got = await io.fetchBytes(`${CDN}/${key}`);
    return got.status === 200 && hasResponseBody(got) && responseBytes(got).toString('utf8').includes(CORPUS_ROUTE_OWNER_META_TAG);
  };
  const deadline = deadlineAt ?? Date.now() + waitMs;
  for (;;) {
    const ok = await mapLimit(pending, 8, present);
    pending = pending.filter((_, i) => !ok[i]);
    if (pending.length === 0 || Date.now() + retryMs > deadline) return pending;
    await pause(retryMs);
  }
}

/**
 * La release che R2 serve ADESSO. `ok` solo se il puntatore rispetta il
 * contratto del Worker, dichiara i suoi file in modo leggibile, e OGNI file
 * dichiarato c'e' sotto la sua base con lo sha256 dichiarato. Un 200 non
 * basta: una pagina d'errore in JSON, un puntatore troncato o una sitemap
 * mancante non dimostrano niente, e valgono `unknown`.
 * @returns {Promise<{ state: 'ok', doc: any } | { state: 'absent' } | { state: 'unknown', doc?: any }>}
 */
export async function readPreviousRelease(io) {
  const res = await io.fetchBytes(`${CDN}/${EDGE_SECTION_REGISTRY_FILE}`);
  if (res.status === 404) return { state: 'absent' };
  if (res.status !== 200) return { state: 'unknown' };
  if (!hasResponseBody(res)) return { state: 'unknown' };
  let doc;
  try {
    doc = JSON.parse(responseBytes(res).toString('utf8'));
  } catch {
    return { state: 'unknown' };
  }
  if (!validateEdgeSectionRegistry(doc)) return { state: 'unknown' };
  const files = declaredFiles(doc);
  if (files === null) return { state: 'unknown', doc };
  for (const [name, hash] of Object.entries(files)) {
    const got = await io.fetchBytes(`${CDN}/${doc.release.base}${name}`);
    if (got.status !== 200 || !hasResponseBody(got) || sha256(responseBytes(got)) !== hash) return { state: 'unknown', doc };
  }
  return { state: 'ok', doc };
}

/**
 * Esegue il protocollo dell'header su una release. Ritorna
 * `{ code, phase, flipped }`: `phase` e' dove si e' fermato (`done` se in fondo),
 * `flipped` se il puntatore e' stato scritto.
 */
export async function publishRelease(
  release,
  {
    io,
    env = process.env,
    log = console.log,
    tmpDir = os.tmpdir(),
    bootstrapWaitMs = BOOTSTRAP_WAIT_MS,
    bootstrapRetryMs = BOOTSTRAP_RETRY_MS,
    bootstrapReleaseAttempts = BOOTSTRAP_RELEASE_ATTEMPTS,
    stagingVerifyAttempts = STAGING_VERIFY_ATTEMPTS,
    stagingVerifyRetryMs = STAGING_VERIFY_RETRY_MS,
    sleep,
  },
) {
  const previous = await readPreviousRelease(io);
  const mandatory = releaseDiffers(release, previous);
  log(
    `[section-edge] release ${release.commit.slice(0, 8)}: release su R2 ${previous.state}; push ` +
      (mandatory
        ? 'OBBLIGATORIO (stato o file serviti cambiano, o la release servita non e\' dimostrabile)'
        : 'facoltativo (stesso stato, stessi file)'),
  );
  const stop = (phase, what, flipped, forceFailure = false) => {
    const where = flipped ? 'il Worker serve la release nuova, intera' : 'il Worker serve la release di prima, intera';
    if (mandatory || forceFailure) log(`::error::[section-edge] ${phase}: ${what} — ${where}; il publish si ferma`);
    else log(`::warning::[section-edge] ${phase}: ${what} — ${where}; niente di servito cambiava, il publish prosegue`);
    return { code: mandatory || forceFailure ? 1 : 0, phase, flipped };
  };

  const missingCreds = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_S3_ENDPOINT', 'R2_BUCKET', 'CF_API_TOKEN'].filter((name) => !env[name]);

  // Una base gia' usata e' immutable anche quando cambia il kill-switch a
  // parita' di HEAD. Se il puntatore corrente serve gia' un altro snapshot
  // dello stesso commit, la base nominale del commit e' una collisione anche
  // quando non e' piu' la base corrente: ritornare li' riscriverebbe un
  // oggetto che puo' ancora essere conservato o servito da una richiesta in
  // volo. In entrambi i casi si crea una chiave unica per lo snapshot
  // effettivo prima dello staging. Il confronto con lo snapshot gia' noto
  // avviene anche quando `mandatory` e' falso: altrimenti un retry identico
  // tornerebbe alla base nominale e potrebbe sovrascrivere una chiave immutable.
  const previousBase = previous.doc?.release?.base;
  const previousPreviousBase = previous.doc?.release?.previous?.base;
  const occupiedBases = [...new Set([previousBase, previousPreviousBase].filter((base) => typeof base === 'string'))];
  const sameRegistryCommit = previous.doc?.commit === release.commit;
  const snapshotCommit = releaseSnapshotCommit(release);
  // Se stato e byte sono gia' dimostrati uguali, la release effettiva e' nota
  // anche quando la sua base e' un digest derivato o il commit del puntatore
  // e' cambiato: il commit non fa parte dello stato servito da Worker.
  const sameKnownRelease = previous.state === 'ok' && !mandatory;
  if (missingCreds.length) return stop('credenziali', `assenti (${missingCreds.join(', ')}): niente caricato`, false, sameKnownRelease);
  if (!sameKnownRelease && (previous.state === 'unknown' || occupiedBases.includes(release.base) || sameRegistryCommit)) {
    let immutableCommit = snapshotCommit;
    // Collisione crittografica praticamente impossibile, ma la proprieta'
    // d'immutabilita' non deve dipendere da una probabilita': se lo stato
    // precedente e' unknown non si puo' ristagiare la stessa base, nemmeno
    // quando il digest dello snapshot coincide con quella occupata.
    while (immutableCommit === release.commit || occupiedBases.includes(releaseBase(immutableCommit))) {
      immutableCommit = sha256(`snapshot:${immutableCommit}:${occupiedBases.join('|')}`).slice(0, 40);
    }
    const base = releaseBase(immutableCommit);
    const files = release.files.map((file) => ({ ...file, key: `${base}${file.name}` }));
    release = {
      ...release,
      base,
      files,
      pointer: {
        ...release.pointer,
        release: {
          ...release.pointer.release,
          commit: immutableCommit,
          base,
          files: Object.fromEntries(files.map((file) => [file.name, { sha256: file.sha256, bytes: file.bytes }])),
        },
      },
    };
    log(`[section-edge] release ${release.commit.slice(0, 8)}: base gia' puntata, snapshot immutable ${immutableCommit}`);
  }

  // La stessa release gia' verificata non richiede un nuovo PUT o flip, ma il
  // purge va sempre ritentato: il precedente tentativo puo' aver flippato il
  // puntatore e fallito soltanto dopo. Un noop non conferma quindi il lavoro
  // finche' il purge idempotente non e' riuscito.
  if (sameKnownRelease) {
    const servedFiles = declaredFiles(previous.doc);
    const staleFiles = previous.doc?.release?.previous?.files ?? [];
    if (!purgeApexUrls(io, release.files, Object.keys(servedFiles ?? {}), staleFiles)) {
      return stop('purge', 'non confermato (il Worker rilegge il puntatore entro 60 s)', true, true);
    }
    log(`[section-edge] release ${release.commit.slice(0, 8)} gia' servita sotto ${previousBase}; purge confermato, nessun PUT`);
    return { code: 0, phase: 'noop', flipped: false };
  }

  // Se ci si ferma prima del flip, i file gia' caricati sotto la base di QUESTA
  // release non sono puntati da niente: si tolgono best-effort.
  const staged = [];
  let heldBootstrapLocks = [];
  const releaseHeldBootstrapLocks = async () => {
    const outcome = await releaseBootstrapLocks(heldBootstrapLocks, io, {
      attempts: bootstrapReleaseAttempts,
      log,
    });
    heldBootstrapLocks = outcome.pending;
    return outcome.released;
  };
  const stopBeforeFlip = async (phase, what) => {
    for (const key of staged) {
      if (!io.remove(key)) log(`::notice::[section-edge] file di staging non ripulito: ${key}`);
    }
    const released = await releaseHeldBootstrapLocks();
    return stop(phase, released ? what : `${what}; release bootstrap lock non confermato`, false, !released);
  };

  // 1. Staging sotto la base della release, con rilettura di sha256 e lunghezza.
  for (const file of release.files) {
    staged.push(file.key);
    if (!io.upload(file.local, file.key, RELEASE_CACHE_CONTROL)) return stopBeforeFlip('staging', `upload non confermato: ${file.key}`);
  }
  for (const file of release.files) {
    let served = { status: 0 };
    const attempts = normalizeStagingVerifyAttempts(stagingVerifyAttempts);
    let verified = false;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      served = await io.fetchBytes(`${CDN}/${file.key}`);
      verified = hasExpectedStagingBody(served, file);
      if (verified) break;
      if (attempt < attempts) {
        await (sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(stagingVerifyRetryMs);
      }
    }
    if (!verified) {
      return stopBeforeFlip('staging', `${file.key} sul CDN non corrisponde ai byte locali (HTTP ${served.status || 'nessuna risposta'})`);
    }
  }

  const bootstrapDeadline = Date.now() + Math.max(0, bootstrapWaitMs);
  const lockedBeforeBootstrap = await waitForBootstrapLocks(release.live, io, {
    retryMs: bootstrapRetryMs,
    sleep,
    deadline: bootstrapDeadline,
  });
  if (lockedBeforeBootstrap.length) {
    return stopBeforeFlip('bootstrap-lock', `bootstrap live ancora in corso (${lockedBeforeBootstrap.join(', ')})`);
  }

  // 1b. Bootstrap: le pagine delle sezioni che il puntatore dichiarera' live.
  const missingPages = await missingBootstrapPages(release, previous, io, {
    sleep,
    deadline: bootstrapDeadline,
  });
  if (missingPages.length) {
    return stopBeforeFlip(
      'bootstrap',
      `${missingPages.length} pagine annunciate dalle sitemap delle sezioni live non sono su R2 ` +
        `(es. ${missingPages.slice(0, 3).join(', ')}): prima le pagine (fast-publish-section), poi il flip`,
    );
  }

  // Il GET precedente non e' sufficiente: un bootstrap puo' partire subito
  // dopo aver visto il lock assente. L'acquisizione condizionale R2 chiude la
  // finestra: se vince il publisher, il bootstrap non puo' sovrascrivere le
  // pagine; se vince il bootstrap, il publisher aspetta senza fare il flip.
  const acquired = await acquireBootstrapLocks(release.live, release.commit, io, {
    retryMs: bootstrapRetryMs,
    releaseAttempts: bootstrapReleaseAttempts,
    sleep,
    deadline: bootstrapDeadline,
    log,
  });
  if (acquired.error) {
    return stopBeforeFlip('bootstrap-lock', acquired.error);
  }
  heldBootstrapLocks = acquired.held;

  // Il controllo finale e' deliberatamente dopo l'handshake, quando il
  // publisher possiede i lease di tutte le sezioni: non puo' piu' arrivare un
  // HTML nuovo a competere con il set che il registry sta per annunciare.
  const missingAfterLock = await missingBootstrapPages(release, previous, io, {
    waitMs: 0,
    retryMs: 0,
    sleep,
    deadline: Date.now(),
  });
  if (missingAfterLock.length) {
    return stopBeforeFlip(
      'bootstrap',
      `${missingAfterLock.length} pagine annunciate dalle sitemap delle sezioni live non sono su R2 dopo l'handshake ` +
        `(es. ${missingAfterLock.slice(0, 3).join(', ')}): il flip non e' sicuro`,
    );
  }

  // 2. Flip: UN PUT del puntatore. Ricorda la release che sostituisce, per la
  //    pulizia del giro successivo (solo se e' una release diversa e leggibile).
  const prevRelease = previous.doc?.release;
  const prevFiles = previous.doc ? declaredFiles(previous.doc) : null;
  const replaced = prevFiles && prevRelease?.base && prevRelease.base !== release.base ? { base: prevRelease.base, files: Object.keys(prevFiles) } : null;
  const pointer = { ...release.pointer, release: { ...release.pointer.release, previous: replaced } };
  let flipped = false;
  const pointerDir = fs.mkdtempSync(path.join(tmpDir, 'section-edge-'));
  try {
    const pointerFile = path.join(pointerDir, 'registry.json');
    fs.writeFileSync(pointerFile, JSON.stringify(pointer));
    flipped = io.upload(pointerFile, EDGE_SECTION_REGISTRY_FILE, REGISTRY_CACHE_CONTROL);
  } finally {
    fs.rmSync(pointerDir, { recursive: true, force: true });
  }
  if (!flipped) return stopBeforeFlip('flip', `puntatore non caricato: ${EDGE_SECTION_REGISTRY_FILE}`);
  if (!(await releaseHeldBootstrapLocks())) {
    return stop('bootstrap-lock-release', 'il puntatore e\' nuovo ma il lease non e\' stato rilasciato dopo i retry; riconciliazione necessaria', true, true);
  }

  // 3. Purge: il puntatore e le URL apex delle sitemap delle due release.
  const purged = purgeApexUrls(io, release.files, Object.keys(prevFiles ?? {}), prevRelease?.previous?.files ?? []);

  // 4. Pulizia (best-effort): la release che la precedente aveva sostituito.
  //    Mai la release puntata, mai la precedente.
  const stale = prevRelease?.previous;
  if (
    isPlainObject(stale) &&
    typeof stale.base === 'string' &&
    /^edge\/sections\/_releases\/[0-9a-f]{7,40}\/$/.test(stale.base) &&
    stale.base !== release.base &&
    stale.base !== prevRelease.base &&
    Array.isArray(stale.files)
  ) {
    for (const name of [...new Set(stale.files)].filter((n) => typeof n === 'string' && RELEASE_FILE_RE.test(n))) {
      if (!io.remove(`${stale.base}${name}`)) log(`::notice::[section-edge] release vecchia non ripulita: ${stale.base}${name}`);
    }
  }

  if (!purged) return stop('purge', 'non confermato (il Worker rilegge il puntatore entro 60 s)', true);
  log(`[section-edge] release ${release.commit.slice(0, 8)} pubblicata: ${release.files.length} file, ${release.live.length} sezioni live`);
  return { code: 0, phase: 'done', flipped: true };
}

function parseCli(argv) {
  const out = { dist: 'dist/api', dryRun: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error(`${arg} va indicato una volta sola`);
    seen.add(arg);
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--dist') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--dist richiede una cartella (es. --dist dist/api)');
      out.dist = value;
    } else throw new Error(`argomenti sconosciuti: ${arg} (ammessi: --dist <cartella>, --dry-run)`);
  }
  return out;
}

export async function main(argv = process.argv.slice(2), { env = process.env, io = realIo, log = console.log } = {}) {
  const cli = parseCli(argv);
  const distDir = path.resolve(ROOT, cli.dist);
  if (!fs.existsSync(distDir)) throw new Error(`${cli.dist}: cartella inesistente (build-api non ha girato?)`);
  const release = planRelease(distDir);
  if (!release) {
    log(`::notice::[section-edge] ${EDGE_SECTION_REGISTRY_FILE} non emesso (kill-switch non verificato): nessuna release, R2 resta com'e'`);
    return 0;
  }
  if (cli.dryRun) {
    log(JSON.stringify({ commit: release.commit, base: release.base, live: release.live, files: release.files.map((f) => f.key), pointer: release.pointer }, null, 2));
    return 0;
  }
  return (await publishRelease(release, { io, env, log, tmpDir: env.RUNNER_TEMP || os.tmpdir() })).code;
}

const invokedDirectly = (() => {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
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

#!/usr/bin/env node
/**
 * publish-section-edge.mjs — porta su R2 la RELEASE del registro delle sezioni
 * cantonali (registro, sitemap delle sezioni live, indice) scritta da
 * build-api.mjs in dist/api/, con un flip atomico.
 *
 * ── Una sola fonte dello stato servito ─────────────────────────────────────
 *
 * Cio' che e' `live|draft|retired` lo dice UN documento: il registro su R2,
 * `edge/sections/registry.json`, che il Worker del sito applica
 * (`parseCorpusSectionRegistry` in infra/cloudflare-worker/locale-router.js).
 * `sections.json` su GitHub Pages e' un catalogo senza stato (vedi
 * `buildSectionsCatalog`), quindi non esistono due superfici di stato che un
 * fallimento parziale possa far divergere.
 *
 * ── Protocollo di pubblicazione ────────────────────────────────────────────
 *
 * 0. LETTURA. Si legge dal CDN il registro che R2 ha adesso (il puntatore
 *    della release precedente). Il push e' OBBLIGATORIO se la release da
 *    pubblicare DIFFERISCE da quella servita (`releaseDiffers`):
 *      · nello stato delle sezioni (status, redirects, gone) — in OGNI
 *        direzione: accensione, spegnimento, ritiro;
 *      · o nei BYTE di un artefatto servito a path fisso (una sitemap di
 *        sezione, l'indice): stessi stati ma una sitemap nuova e' comunque una
 *        superficie che il Worker servirebbe vecchia;
 *      · o quando lo stato precedente non e' dimostrabile (CDN illeggibile, o
 *        un documento fuori dal contratto del Worker) — anche per una release
 *        tutta `draft`, che potrebbe essere uno spegnimento.
 *    Solo se niente di servito cambia (oggi: tutto `draft`, nessuna sitemap)
 *    la release cambia soltanto il `commit`, e il push e' facoltativo.
 *
 * 1. STAGING (niente di visibile cambia). Ogni file della release sale su una
 *    chiave VERSIONATA per commit,
 *    `edge/sections/_releases/<commit>/{registry.json,sitemap-articles-<id>.xml,sitemap-cantons.xml}`,
 *    e viene riletto dal CDN: lo sha256 dei byte serviti deve essere quello dei
 *    byte locali. Il Worker non legge mai `_releases/` (non e' un prefisso di
 *    sezione). Un fallimento qui: exit, nessun cambio, niente da ripristinare.
 *
 * 2. FLIP. Prima i file REFERENZIATI ai path fissi che il Worker legge — le
 *    sitemap delle sezioni live, `edge/sitemap-articles-<id>.xml`, che il
 *    Worker serve solo per le sezioni live nel registro ANCORA in vigore:
 *    scriverle non cambia quali URL rispondono — e per ULTIMO, con un solo
 *    PUT, il puntatore `edge/sections/registry.json`: il registro nel formato
 *    del Worker piu' `release` (commit, prefisso e sha256 dei file). E'
 *    l'UNICO passo che cambia cio' che il Worker serve. Un fallimento prima
 *    del PUT, o del PUT stesso: lo stato servito resta quello di prima.
 *
 * 3. DOPO IL FLIP. L'indice `edge/sitemap-cantons.xml` — scritto, o
 *    CANCELLATO se nessuna sezione e' live (un `<sitemapindex>` vuoto viola lo
 *    schema) — con fino a 3 tentativi. Sta dopo il flip perche' e' un annuncio
 *    derivato dal registro: scritto prima, un flip fallito lo lascerebbe ad
 *    annunciare sitemap che il Worker non serve. Se dopo i tentativi l'indice
 *    non e' aggiornato, registro nuovo e indice vecchio sarebbero una coppia
 *    incoerente: si RIPRISTINA il puntatore precedente (registro e indice
 *    tornano la coppia di prima) e si esce con errore.
 *    Poi le sitemap ai path fissi delle sezioni che NON sono piu' live
 *    (presenti nella release precedente, assenti in questa) vengono cancellate,
 *    e si purga l'UNIONE di cio' che la release precedente e la nuova
 *    servono: puntatore, indice, sitemap nuove e sitemap rimosse, su apex e
 *    cdn. Un purge o una cancellazione falliti non toccano lo stato (il
 *    Worker rilegge il registro entro 60 s e non serve la sitemap di una
 *    sezione non live): si esce con errore e il publish successivo riprova.
 *
 * 4. PULIZIA (best-effort). I file della release precedente, nominati dal
 *    puntatore precedente, vengono cancellati.
 *
 * ESITO. Un fallimento in un push OBBLIGATORIO esce 1: publish-api.yml si
 * ferma prima del deploy Pages, e lo stato servito e' — per costruzione —
 * quello di prima (fasi 0-2, o fase 3 con ripristino) o quello nuovo e
 * coerente. Se niente di servito cambiava, un problema di R2 e' un warning ed
 * esce 0: non ferma la pubblicazione degli articoli.
 *
 * Registro assente in dist/api (kill-switch di Remote Config non verificato
 * con una sezione dichiarata live, vedi scripts/lib/section-registry.mjs):
 * nessuna release, R2 resta com'e'.
 *
 * Uso: node scripts/publish-section-edge.mjs [--dist dist/api] [--dry-run]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
/** Il Worker rilegge il registro ogni 60 s: un max-age piu' lungo al cdn ritarderebbe il flip. */
export const REGISTRY_CACHE_CONTROL = 'public,max-age=60';
/** Stessa classe delle sitemap blog spinte da publish-api.yml. */
export const SITEMAP_CACHE_CONTROL = 'public,max-age=600';
/** Una chiave di release non cambia mai contenuto. */
export const RELEASE_CACHE_CONTROL = 'public,max-age=31536000,immutable';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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

/**
 * La release da pubblicare, letta da cio' che build-api ha scritto; `null` se
 * build-api non ha emesso il registro (allora non c'e' niente da pubblicare).
 *
 * @returns {null | {
 *   commit: string, prefix: string, registry: object, live: string[],
 *   files: Array<{ name: string, local: string, sha256: string, releaseKey: string }>,
 *   pointer: object,
 * }}
 */
export function planRelease(distDir) {
  const at = (name) => path.join(distDir, name);
  if (!fs.existsSync(at(EDGE_SECTION_REGISTRY_FILE))) return null;
  const registry = JSON.parse(fs.readFileSync(at(EDGE_SECTION_REGISTRY_FILE), 'utf8'));
  if (!validateEdgeSectionRegistry(registry)) throw new Error(`${EDGE_SECTION_REGISTRY_FILE}: il Worker rifiuterebbe questo registro`);
  const live = Object.keys(registry.sections).filter((id) => registry.sections[id].status === 'live');
  const prefix = `${RELEASES_PREFIX}/${registry.commit}`;
  const names = ['registry.json', ...live.map((id) => `sitemap-articles-${id}.xml`)];
  const hasIndex = fs.existsSync(at(SECTION_SITEMAP_INDEX_FILE));
  if (hasIndex !== live.length > 0) {
    throw new Error(`${SECTION_SITEMAP_INDEX_FILE} ${hasIndex ? 'presente' : 'assente'} con ${live.length} sezioni live: release incoerente`);
  }
  if (hasIndex) names.push(SECTION_SITEMAP_INDEX_FILE);
  const files = names.map((name) => {
    const local = at(name === 'registry.json' ? EDGE_SECTION_REGISTRY_FILE : name);
    if (!fs.existsSync(local)) throw new Error(`${name}: manca in ${distDir} (sezione live senza sitemap?)`);
    return { name, local, sha256: sha256(fs.readFileSync(local)), releaseKey: `${prefix}/${name}` };
  });
  const pointer = {
    ...registry,
    release: { commit: registry.commit, prefix, files: Object.fromEntries(files.map((f) => [f.name, f.sha256])) },
  };
  // Il puntatore E' il registro che il Worker legge: deve restare nel suo contratto.
  if (!validateEdgeSectionRegistry(pointer)) throw new Error('puntatore fuori dal contratto del Worker');
  return { commit: registry.commit, prefix, registry, live, files, pointer };
}

const FIXED_ARTIFACT_RE = /^(sitemap-articles-canton-[a-z]+\.xml|sitemap-cantons\.xml)$/;

/**
 * Gli artefatti che una release serve a un path FISSO (sitemap di sezione,
 * indice), come `{ nome: sha256 }`. Il registro non c'e': il suo contenuto
 * servito e' lo stato, che si confronta a parte (il `commit` cambia sempre).
 * Per un puntatore senza `release` (mai pubblicato da questo protocollo) le
 * sitemap delle sezioni live si assumono servite, con hash ignoto.
 */
export function fixedArtifacts(doc) {
  const out = {};
  for (const [id, entry] of Object.entries(doc?.sections ?? {})) {
    if (entry?.status === 'live') out[`sitemap-articles-${id}.xml`] = null;
  }
  for (const [name, hash] of Object.entries(doc?.release?.files ?? {})) {
    if (FIXED_ARTIFACT_RE.test(name)) out[name] = typeof hash === 'string' ? hash : null;
  }
  return out;
}

/**
 * Se la release da pubblicare differisce da quella servita: nello stato delle
 * sezioni, o nei byte di un artefatto a path fisso (fase 0 dell'header).
 * @param {{ registry: object, pointer: object }} release
 * @param {{ state: 'ok' | 'absent' | 'unknown', doc?: unknown }} previous
 */
export function releaseDiffers(release, previous) {
  // Stato precedente non dimostrabile: fail-closed, anche per una release
  // tutta draft (se R2 serviva una sezione live, questo e' uno spegnimento).
  if (!previous || previous.state === 'unknown') return true;
  const before = previous.state === 'ok' ? previous.doc : { sections: {} };
  if (registryState(release.registry) !== registryState(before)) return true;
  const next = fixedArtifacts(release.pointer);
  const prev = fixedArtifacts(before);
  const names = new Set([...Object.keys(next), ...Object.keys(prev)]);
  return [...names].some((name) => !next[name] || next[name] !== prev[name]);
}

/** Compatibilita' di nome: il push e' obbligatorio quando la release differisce. */
export function pushIsMandatory(registry, previous) {
  return releaseDiffers({ registry, pointer: registry }, previous);
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

/** Le operazioni vere su R2 e Cloudflare; i test ne passano di finte. */
export const realIo = {
  upload: (local, key, cacheControl) => run('bash', ['scripts/lib/upload-cdn-file.sh', local, key, cacheControl]).stdout.includes('✅ uploaded'),
  remove: (key) => run('bash', ['scripts/lib/delete-cdn-file.sh', key]).stdout.includes('✅ deleted'),
  purge: (urls) =>
    purgeChunks(urls).every(
      (chunk) => run('bash', ['scripts/ci/retry-cmd.sh', 'node', 'scripts/cf-purge-cache.mjs', `--files=${chunk.join(',')}`]).code === 0,
    ),
  /** GET sul CDN con cache-buster: `{ status, body }`, o `{ status: 0 }` se la rete non risponde. */
  fetchBytes: async (url) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${url}?_secb=${Date.now()}.${attempt}`, {
          headers: { 'user-agent': 'frontaliere-corpus-publisher/1 (+https://frontaliereticino.ch)' },
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 200) return { status: 200, body: Buffer.from(await res.arrayBuffer()) };
        if (res.status === 404) return { status: 404 };
      } catch {
        /* ritenta */
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return { status: 0 };
  },
};

/** Quante volte si prova a scrivere (o cancellare) l'indice dopo il flip. */
export const INDEX_ATTEMPTS = 3;

/** Riscrive su R2 il puntatore precedente (o lo cancella se non c'era). */
function restorePointer(previous, io, tmpDir) {
  if (previous.state === 'absent') return io.remove(EDGE_SECTION_REGISTRY_FILE);
  if (previous.state !== 'ok') return false;
  const dir = fs.mkdtempSync(path.join(tmpDir, 'section-edge-restore-'));
  try {
    const file = path.join(dir, 'registry.json');
    fs.writeFileSync(file, previous.raw);
    return io.upload(file, EDGE_SECTION_REGISTRY_FILE, REGISTRY_CACHE_CONTROL);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Il registro che R2 ha ADESSO. */
export async function readPreviousRegistry(io) {
  const res = await io.fetchBytes(`${CDN}/${EDGE_SECTION_REGISTRY_FILE}`);
  if (res.status === 404) return { state: 'absent' };
  if (res.status !== 200) return { state: 'unknown' };
  try {
    const raw = res.body.toString('utf8');
    const doc = JSON.parse(raw);
    // Un 200 non basta: conta come stato precedente solo un registro che il
    // Worker accetterebbe. Qualunque altra cosa (una pagina d'errore in JSON,
    // un documento troncato) non dimostra niente.
    return validateEdgeSectionRegistry(doc) ? { state: 'ok', doc, raw } : { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}

/**
 * Esegue il protocollo dell'header su una release. Ritorna
 * `{ code, phase, flipped }`: `phase` e' dove si e' fermato (`done` se in fondo),
 * `flipped` se il puntatore e' stato scritto.
 */
export async function publishRelease(release, { io, env = process.env, log = console.log, tmpDir = os.tmpdir() }) {
  const previous = await readPreviousRegistry(io);
  const mandatory = releaseDiffers(release, previous);
  log(
    `[section-edge] release ${release.commit.slice(0, 8)}: registro su R2 ${previous.state}; push ` +
      (mandatory
        ? 'OBBLIGATORIO (stato o artefatti serviti cambiano, o non e\' dimostrabile che coincidano)'
        : 'facoltativo (stesso stato, stessi artefatti serviti)'),
  );
  const stop = (phase, what, flipped) => {
    const where = flipped ? 'lo stato servito e\' gia\' quello nuovo e coerente' : 'lo stato servito resta quello di prima';
    if (mandatory) log(`::error::[section-edge] ${phase}: ${what} — ${where}; il publish si ferma`);
    else log(`::warning::[section-edge] ${phase}: ${what} — ${where}; niente di servito cambiava, il publish prosegue`);
    return { code: mandatory ? 1 : 0, phase, flipped };
  };

  const missingCreds = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_S3_ENDPOINT', 'R2_BUCKET', 'CF_API_TOKEN'].filter((name) => !env[name]);
  if (missingCreds.length) return stop('credenziali', `assenti (${missingCreds.join(', ')}): niente caricato`, false);

  // 1. Staging su chiavi versionate, con rilettura e confronto dello sha256.
  for (const file of release.files) {
    if (!io.upload(file.local, file.releaseKey, RELEASE_CACHE_CONTROL)) return stop('staging', `upload non confermato: ${file.releaseKey}`, false);
  }
  for (const file of release.files) {
    const served = await io.fetchBytes(`${CDN}/${file.releaseKey}`);
    if (served.status !== 200 || sha256(served.body) !== file.sha256) {
      return stop('staging', `${file.releaseKey} sul CDN non corrisponde ai byte locali (HTTP ${served.status || 'nessuna risposta'})`, false);
    }
  }

  // 2. Flip: i file referenziati ai path fissi, poi UN PUT del puntatore.
  const sitemaps = release.files.filter((f) => f.name.startsWith('sitemap-articles-'));
  for (const file of sitemaps) {
    if (!io.upload(file.local, `edge/${file.name}`, SITEMAP_CACHE_CONTROL)) return stop('flip', `sitemap non caricata: edge/${file.name}`, false);
  }
  let flipped = false;
  const pointerDir = fs.mkdtempSync(path.join(tmpDir, 'section-edge-'));
  try {
    const pointerFile = path.join(pointerDir, 'registry.json');
    fs.writeFileSync(pointerFile, JSON.stringify(release.pointer));
    flipped = io.upload(pointerFile, EDGE_SECTION_REGISTRY_FILE, REGISTRY_CACHE_CONTROL);
  } finally {
    fs.rmSync(pointerDir, { recursive: true, force: true });
  }
  if (!flipped) return stop('flip', `puntatore non caricato: ${EDGE_SECTION_REGISTRY_FILE}`, false);

  // 3. Dopo il flip: indice (ritentato; se non passa, si torna al puntatore di
  //    prima), sitemap delle sezioni non piu' live, purge dell'unione.
  const index = release.files.find((f) => f.name === SECTION_SITEMAP_INDEX_FILE);
  const indexKey = `edge/${SECTION_SITEMAP_INDEX_FILE}`;
  let indexOk = false;
  for (let attempt = 1; attempt <= INDEX_ATTEMPTS && !indexOk; attempt++) {
    indexOk = index ? io.upload(index.local, indexKey, SITEMAP_CACHE_CONTROL) : io.remove(indexKey);
  }
  const nextNames = sitemaps.map((f) => f.name);
  const removedNames = Object.keys(fixedArtifacts(previous.state === 'ok' ? previous.doc : null)).filter(
    (name) => name !== SECTION_SITEMAP_INDEX_FILE && !nextNames.includes(name),
  );
  const purgeUrls = [
    `${CDN}/${EDGE_SECTION_REGISTRY_FILE}`,
    ...[...nextNames, ...removedNames, SECTION_SITEMAP_INDEX_FILE].flatMap((name) => [`${APEX}/${name}`, `${CDN}/edge/${name}`]),
  ];
  if (!indexOk) {
    // Registro nuovo + indice vecchio = coppia incoerente: si ripristina il
    // puntatore precedente, cosi' registro e indice tornano la coppia di prima.
    const restored = restorePointer(previous, io, tmpDir);
    io.purge(purgeUrls);
    return stop(
      'dopo il flip',
      `indice ${index ? 'non caricato' : 'non cancellato'} dopo ${INDEX_ATTEMPTS} tentativi: ` +
        (restored
          ? 'puntatore precedente ripristinato'
          : `puntatore precedente NON ripristinato (stato precedente: ${previous.state}) — registro nuovo e indice vecchio, rilanciare publish-api`),
      !restored,
    );
  }
  const problems = [];
  for (const name of removedNames) {
    if (!io.remove(`edge/${name}`)) problems.push(`sitemap di una sezione non piu' live non cancellata: edge/${name}`);
  }
  if (!io.purge(purgeUrls)) problems.push('purge (il Worker rilegge il registro entro 60 s)');

  // 4. Pulizia della release precedente (best-effort, mai un fallimento).
  const old = previous.state === 'ok' ? previous.doc?.release : null;
  if (old?.prefix && old.prefix !== release.prefix && String(old.prefix).startsWith(`${RELEASES_PREFIX}/`)) {
    // Solo nomi di file semplici e distinti: il puntatore precedente e' un
    // dato letto dalla rete, non un elenco di chiavi da cancellare alla cieca.
    const names = [...new Set(Object.keys(isPlainObject(old.files) ? old.files : {}))].filter((name) => /^[a-z0-9][a-z0-9.-]*$/.test(name));
    for (const name of names) {
      if (!io.remove(`${old.prefix}/${name}`)) log(`::notice::[section-edge] release precedente non ripulita: ${old.prefix}/${name}`);
    }
  }

  if (problems.length) return stop('dopo il flip', problems.join('; '), true);
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
    log(JSON.stringify({ commit: release.commit, prefix: release.prefix, live: release.live, files: release.files.map((f) => f.releaseKey), pointer: release.pointer }, null, 2));
    return 0;
  }
  return (await publishRelease(release, { io, env, log, tmpDir: env.RUNNER_TEMP || os.tmpdir() })).code;
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

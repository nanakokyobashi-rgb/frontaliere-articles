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
 * 0. LETTURA E SALVATAGGIO. Si rilegge dal CDN la superficie che R2 serve
 *    adesso (`readServedSurface`): il puntatore della release precedente e i
 *    BYTE di ogni artefatto a path fisso che la release precedente o la nuova
 *    toccano (sitemap di sezione, indice). Lo stato precedente e' DIMOSTRATO
 *    solo se il puntatore rispetta il contratto del Worker e ogni artefatto
 *    che dichiara c'e' con lo sha256 dichiarato; altrimenti vale `unknown`.
 *    Il push e' OBBLIGATORIO se la release differisce da quella servita
 *    (`releaseDiffers`): nello stato delle sezioni (status, redirects, gone —
 *    in ogni direzione: accensione, spegnimento, ritiro), nei byte di un
 *    artefatto a path fisso, o se lo stato precedente e' `unknown` (anche per
 *    una release tutta `draft`, che potrebbe essere uno spegnimento). I byte
 *    letti qui sono anche il SALVATAGGIO per il ripristino: se uno non e'
 *    leggibile non si scrive niente.
 *
 * 1. STAGING (niente di visibile cambia). Ogni file della release sale su una
 *    chiave VERSIONATA per commit,
 *    `edge/sections/_releases/<commit>/{registry.json,sitemap-articles-<id>.xml,sitemap-cantons.xml}`,
 *    e viene riletto dal CDN: lo sha256 dei byte serviti deve essere quello dei
 *    byte locali. Il Worker non legge mai `_releases/` (non e' un prefisso di
 *    sezione). Un fallimento qui: exit, nessun cambio, niente da ripristinare.
 *
 * 2-3. TRANSAZIONE SUI PATH FISSI (quelli che il Worker legge; cambiarli nel
 *    Worker richiederebbe una modifica al sito, che qui non serve). In ordine:
 *    le sitemap delle sezioni live `edge/sitemap-articles-<id>.xml`; poi UN
 *    PUT del puntatore `edge/sections/registry.json` (il registro nel formato
 *    del Worker piu' `release`: commit, prefisso, sha256 dei file) — e' il
 *    passo che cambia lo STATO servito; poi l'indice `edge/sitemap-cantons.xml`,
 *    scritto o CANCELLATO se nessuna sezione e' live (un `<sitemapindex>` vuoto
 *    viola lo schema), con fino a 3 tentativi.
 *    Ogni chiave e' annotata prima di essere toccata. Se UN passo non e'
 *    confermato si RIPRISTINA tutto cio' che e' stato toccato, in ordine
 *    inverso, dai byte salvati alla fase 0 (o cancellando cio' che prima non
 *    c'era) — puntatore compreso — e si esce con errore: R2 torna alla
 *    superficie di prima, sitemap incluse. Solo se anche il ripristino non e'
 *    confermato la superficie puo' restare mista, e l'errore lo dice.
 *
 *    A transazione chiusa la release nuova e' servita e coerente. Restano due
 *    cose che non cambiano cio' che il Worker serve: cancellare le sitemap
 *    delle sezioni non piu' live (il Worker non le serve comunque) e il purge
 *    dell'UNIONE di cio' che le due release servono (puntatore, indice,
 *    sitemap nuove e rimosse, su apex e cdn). Se falliscono si esce con
 *    errore e il publish successivo riprova.
 *
 * 4. PULIZIA (best-effort). I file della release precedente, nominati dal
 *    puntatore precedente, vengono cancellati.
 *
 * ESITO. Un fallimento in un push OBBLIGATORIO esce 1: publish-api.yml si
 * ferma prima del deploy Pages, e R2 serve — per costruzione — la superficie
 * di prima (fasi 0-1, o transazione ripristinata) o quella nuova e coerente.
 * Se niente di servito cambiava, un problema di R2 e' un warning ed esce 0:
 * non ferma la pubblicazione degli articoli.
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

/** Il registro che R2 ha ADESSO (solo il puntatore; gli artefatti li verifica `readServedSurface`). */
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
 * La superficie che R2 serve ADESSO: il puntatore e, riletti uno per uno, i
 * byte di ogni artefatto a path fisso che la release precedente o la nuova
 * toccano. Serve a due cose:
 *   - DIMOSTRARE lo stato precedente: un puntatore valido non basta, ogni
 *     artefatto che dichiara deve esserci con lo sha256 dichiarato; se uno
 *     manca o e' diverso, lo stato precedente vale `unknown`;
 *   - SALVARE cio' che la pubblicazione sta per sovrascrivere, per poterlo
 *     ripristinare se un passo successivo fallisce.
 *
 * @returns {Promise<{ previous: object, saved: Map<string, { state: 'present', body: Buffer } | { state: 'absent' } | { state: 'unknown' }> }>}
 */
export async function readServedSurface(release, io) {
  let previous = await readPreviousRegistry(io);
  const declared = previous.state === 'ok' ? fixedArtifacts(previous.doc) : {};
  const names = new Set([...Object.keys(declared), ...Object.keys(fixedArtifacts(release.pointer))]);
  const saved = new Map();
  for (const name of names) {
    const res = await io.fetchBytes(`${CDN}/edge/${name}`);
    saved.set(name, res.status === 200 ? { state: 'present', body: res.body } : res.status === 404 ? { state: 'absent' } : { state: 'unknown' });
  }
  if (previous.state === 'ok') {
    const proven = Object.entries(declared).every(([name, hash]) => {
      const got = saved.get(name);
      return typeof hash === 'string' && got.state === 'present' && sha256(got.body) === hash;
    });
    if (!proven) previous = { ...previous, state: 'unknown' };
  }
  return { previous, saved };
}

/**
 * Esegue il protocollo dell'header su una release. Ritorna
 * `{ code, phase, flipped }`: `phase` e' dove si e' fermato (`done` se in fondo),
 * `flipped` se alla fine il Worker serve la release nuova.
 */
export async function publishRelease(release, { io, env = process.env, log = console.log, tmpDir = os.tmpdir() }) {
  const { previous, saved } = await readServedSurface(release, io);
  const mandatory = releaseDiffers(release, previous);
  log(
    `[section-edge] release ${release.commit.slice(0, 8)}: superficie su R2 ${previous.state}; push ` +
      (mandatory
        ? 'OBBLIGATORIO (stato o artefatti serviti cambiano, o non e\' dimostrabile che coincidano)'
        : 'facoltativo (stesso stato, stessi artefatti serviti)'),
  );
  const stop = (phase, what, flipped) => {
    const where = flipped ? 'il Worker serve la release nuova' : 'il Worker serve la superficie di prima';
    if (mandatory) log(`::error::[section-edge] ${phase}: ${what} — ${where}; il publish si ferma`);
    else log(`::warning::[section-edge] ${phase}: ${what} — ${where}; niente di servito cambiava, il publish prosegue`);
    return { code: mandatory ? 1 : 0, phase, flipped };
  };

  const missingCreds = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_S3_ENDPOINT', 'R2_BUCKET', 'CF_API_TOKEN'].filter((name) => !env[name]);
  if (missingCreds.length) return stop('credenziali', `assenti (${missingCreds.join(', ')}): niente caricato`, false);
  // Senza i byte di cio' che si sta per sovrascrivere non c'e' ripristino possibile.
  const unreadable = [...saved].filter(([, got]) => got.state === 'unknown').map(([name]) => `edge/${name}`);
  if (unreadable.length) return stop('lettura', `artefatti serviti non leggibili (${unreadable.join(', ')}): niente caricato`, false);

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

  // 2-3. La transazione sui path fissi. Ogni chiave toccata e' annotata PRIMA
  // di toccarla; al primo passo non confermato si ripristina tutto, nell'ordine
  // inverso, dai byte salvati — puntatore compreso.
  const scratch = fs.mkdtempSync(path.join(tmpDir, 'section-edge-'));
  try {
    const touched = [];
    let pointerWritten = false;
    const sitemaps = release.files.filter((f) => f.name.startsWith('sitemap-articles-'));
    const index = release.files.find((f) => f.name === SECTION_SITEMAP_INDEX_FILE);
    const nextNames = sitemaps.map((f) => f.name);
    const removedNames = [...saved.keys()].filter((name) => name !== SECTION_SITEMAP_INDEX_FILE && !nextNames.includes(name));
    const purgeUrls = [
      `${CDN}/${EDGE_SECTION_REGISTRY_FILE}`,
      ...[...new Set([...saved.keys(), SECTION_SITEMAP_INDEX_FILE])].flatMap((name) => [`${APEX}/${name}`, `${CDN}/edge/${name}`]),
    ];
    const putBytes = (key, bytes, cacheControl) => {
      const file = path.join(scratch, `${touched.length}-${path.basename(key)}`);
      fs.writeFileSync(file, bytes);
      return io.upload(file, key, cacheControl);
    };
    const rollback = () => {
      let ok = true;
      if (pointerWritten) {
        ok =
          (previous.raw !== undefined
            ? putBytes(EDGE_SECTION_REGISTRY_FILE, previous.raw, REGISTRY_CACHE_CONTROL)
            : io.remove(EDGE_SECTION_REGISTRY_FILE)) && ok;
      }
      for (const name of [...touched].reverse()) {
        const before = saved.get(name) ?? { state: 'absent' };
        ok = (before.state === 'present' ? putBytes(`edge/${name}`, before.body, SITEMAP_CACHE_CONTROL) : io.remove(`edge/${name}`)) && ok;
      }
      io.purge(purgeUrls);
      return ok;
    };
    const abort = (phase, what) => {
      const restored = rollback();
      return stop(
        phase,
        `${what}: ` +
          (restored
            ? 'path fissi e puntatore ripristinati ai byte di prima'
            : 'RIPRISTINO NON CONFERMATO — la superficie su R2 puo\' essere mista, rilanciare publish-api'),
        !restored && pointerWritten,
      );
    };

    // 2. Flip: le sitemap delle sezioni live ai path fissi, poi UN PUT del puntatore.
    for (const file of sitemaps) {
      touched.push(file.name);
      if (!io.upload(file.local, `edge/${file.name}`, SITEMAP_CACHE_CONTROL)) return abort('flip', `sitemap non caricata: edge/${file.name}`);
    }
    pointerWritten = true;
    if (!putBytes(EDGE_SECTION_REGISTRY_FILE, JSON.stringify(release.pointer), REGISTRY_CACHE_CONTROL)) {
      return abort('flip', `puntatore non caricato: ${EDGE_SECTION_REGISTRY_FILE}`);
    }

    // 3. Dopo il flip: l'indice (ritentato), parte della stessa transazione.
    const indexKey = `edge/${SECTION_SITEMAP_INDEX_FILE}`;
    touched.push(SECTION_SITEMAP_INDEX_FILE);
    let indexOk = false;
    for (let attempt = 1; attempt <= INDEX_ATTEMPTS && !indexOk; attempt++) {
      indexOk = index ? io.upload(index.local, indexKey, SITEMAP_CACHE_CONTROL) : io.remove(indexKey);
    }
    if (!indexOk) return abort('dopo il flip', `indice ${index ? 'non caricato' : 'non cancellato'} dopo ${INDEX_ATTEMPTS} tentativi`);

    // Da qui la release nuova e' servita e coerente (registro, sitemap, indice).
    // Cio' che resta non cambia cosa il Worker serve: le sitemap di sezioni non
    // piu' live (il Worker non le serve comunque) e il purge.
    const problems = [];
    for (const name of removedNames) {
      if (!io.remove(`edge/${name}`)) problems.push(`sitemap di una sezione non piu' live non cancellata: edge/${name}`);
    }
    if (!io.purge(purgeUrls)) problems.push('purge (il Worker rilegge il registro entro 60 s)');

    // 4. Pulizia della release precedente (best-effort, mai un fallimento).
    const old = previous.doc?.release;
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
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
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

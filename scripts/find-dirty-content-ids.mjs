#!/usr/bin/env node
// find-dirty-content-ids.mjs — trova gli articoli il cui corpus porta ancora
// un control character C0 illegale (vedi scripts/lib/sanitize-control-chars.mjs),
// per pilotare la RIPUBBLICAZIONE delle pagine gia' live (issue #67).
//
// PERCHE' QUESTO SCRIPT ESISTE. #65 sanifica l'output degli emitter: da quel
// merge in poi ogni nuova pubblicazione esce pulita qualunque cosa contenga il
// corpus. Ma l'HTML gia' emesso PRIMA di #65 e' byte su disco sugli shard, e
// resta sporco finche' qualcuno non lo ri-renderizza. #66 tiene la causa a
// monte (il generatore che scrive questi byte); finche' non e' chiusa, nuovi
// articoli possono continuare a nascere sporchi. Questo script e' quindi
// PERMANENTE, non un one-shot: ri-eseguibile ogni volta che serve un altro
// giro di ripubblicazione, e produce zero risultati una volta che #66 e'
// risolta e il backlog e' drenato.
//
// COSA CERCA, PASSO 1 — il pre-filtro sul corpus. Tre superfici dentro
// content/**, tutte lette come dati (non codice): i corpi articolo
// (`blog-body{,-ch}/<locale>/<id>.ts`, id dal nome file), i chunk meta
// (`blog-meta-<locale>.ts`, id dalla chiave `blog.article.<id>.<campo>`) e i
// chunk SEO (`seo/seo-blog*.ts`, id dalla chiave di record `'blog-<id>':` /
// `'swiss-<id>':` che precede i campi). La definizione di "control character
// illegale" e' importata da sanitize-control-chars.mjs — UNA sola sorgente con
// l'emitter che li rimuove in uscita (AGENTS.md #6).
//
// Verificato sul corpus reale (2026-08-09): 32 file, 592 occorrenze — gli
// stessi numeri del censimento in issue #66 — per 29 id distinti.
//
// COSA CERCA, PASSO 2 — il filtro sulla PAGINA LIVE, e perche' esiste
// (issue #73). Il passo 1 da solo NON CONVERGE. Ripubblicare una pagina non
// riscrive `content/` — il corpus lo scrive solo il generatore, e i 592 byte
// restano li' finche' #66 non e' chiusa — quindi la condizione di selezione
// non cambia MAI dopo una ripubblicazione riuscita. Misurato l'8 agosto 2026
// con tre run consecutive (31282100490 dry, 31282137870 reale con 10
// ripubblicazioni tutte verdi, 31282654212 dry): numeri ed elenco IDENTICI
// prima e dopo, e i 19 «in coda» mai serviti.
//
// La superficie che il workflow dichiara di riparare e' la PAGINA, non il
// corpus: e' la pagina che il crawler parsa, ed e' la pagina che la
// ripubblicazione ripulisce. Quindi il corpus resta il pre-filtro GRATUITO
// (da 3769 articoli a 29 candidati) e la decisione finale la prende un GET
// delle 4 URL locale di ogni candidato. Un id le cui pagine sono tutte pulite
// esce dalla selezione, il giro dopo serve i successivi, e il drenaggio
// converge.
//
// Misurato sulla superficie reale il 2026-08-09: 29 candidati dal corpus → 15
// con la pagina ancora sporca (17 pagine su 116, tutte 200). Escono i 10
// ripubblicati la sera prima e altri 4 gia' puliti da ripubblicazioni
// precedenti — verificati a mano uno per uno, perche' un filtro che scarta di
// piu' del previsto va falsificato prima di essere creduto.
//
// Lo scan della pagina e' `sanitizeHtmlDocument` — la STESSA funzione che
// l'emitter applica in uscita — usata come oracolo: se sanificare la pagina la
// cambia, la pagina e' sporca. Cosi' "sporco" qui e "sporco" per l'emitter
// sono la stessa definizione per costruzione, e copre entrambe le spelling con
// cui un C0 arriva alla pagina: il byte grezzo (`<title>`, `<h1>`, `alt`) e la
// forma escapata dentro gli inline `<script>` (la sequenza di sei caratteri
// backslash-u-0-0-1-7, oppure backslash-b, dentro il `headline` del ld+json),
// che un byte-scan puro NON vede.
//
// Le URL si verificano sugli HOST ORIGIN (origin-<shard>-<loc>.frontaliereticino.ch),
// non all'apex: all'apex c'e' il Worker Cloudflare, che tiene due varianti di
// cache (con e senza header `Origin`) e negative-cachea i 404 dell'origin per
// 2 ore — letture stantie proprio dove serve la verita' fresca. Gli host origin
// sono DNS-only (verificato: nessun header `cf-cache-status`, rispondono
// `server: GitHub.com` via il Fastly di GitHub, che GitHub stesso invalida al
// deploy di Pages), quindi quella variante li' non esiste. La finestra da
// `max-age=600` che resta sbaglia solo dal lato sicuro: una pagina appena
// ripulita che si leggesse ancora sporca costerebbe una ripubblicazione
// idempotente in piu', mai una pagina lasciata sporca.
//
// Le URL NON si costruiscono dall'id: l'id e'
// italiano e lo slug e' localizzato (`aggregazione-rischio-basso-mendrisiotto`
// → `/de/grenzgaenger-artikel/fusion-risiko-unteres-mendrisio/`), quindi si
// leggono da `slugs.json` della superficie pubblicata, con la stessa regola di
// path che usa il publisher (`expectedShardPath`, condivisa con
// reconcile-article-shards.mjs).
//
// «NIENTE npm» NON VUOL DIRE «NIENTE RETE». Il vincolo dichiarato nel workflow
// chiamante e' che la detection non dipenda da `npm ci`, per restare immune
// agli ETIMEDOUT del registro npm che hanno gia' causato incidenti (vedi
// l'intestazione di reconcile-article-shards.yml). `fetch` e' builtin di Node
// 22: nessuna installazione, nessun registro, quindi il vincolo resta
// soddisfatto anche ora che questo file fa rete. Costo misurato: ~116
// richieste (29 candidati × 4 locali), sotto il minuto con concorrenza 8.
// reconcile-article-shards.mjs, che il workflow gemello lancia allo stesso
// modo, fa rete per lo stesso motivo e con lo stesso vincolo.
//
// IN DUBBIO SI TIENE. Un fetch che fallisce (rete, timeout, 5xx) NON e'
// «pulita»: l'id resta candidato. Un falso positivo costa una ripubblicazione
// idempotente; un falso negativo lascia una pagina sporca per sempre, perche'
// nessun altro meccanismo la guarda.
//
// CLI:
//   node scripts/find-dirty-content-ids.mjs --out <reportJsonPath> [--cap N]
// Env:
//   DIRTY_API_BASE   base dell'API pubblicata da cui leggere slugs.json
//                    (default: la radice di GitHub Pages del corpus — l'API
//                    risponde alla radice, NON sotto /api/)
//   DIRTY_SKIP_LIVE  '1' salta il filtro live (solo per debug del pre-filtro;
//                    in questo modo lo script torna a NON convergere)
// Exit: 0 sempre (report vuoto = niente da fare, non e' un errore).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findControlChars, sanitizeHtmlDocument } from './lib/sanitize-control-chars.mjs';
// Riuso deliberato: la mappa sezione→shard, l'elenco dei locali e la regola di
// path della pagina sono gia' definite (e testate) li'. Duplicarle qui
// significherebbe due sorgenti di verita' per la stessa cosa, e la seconda
// sbaglierebbe in silenzio il giorno che uno slug di sezione cambia.
// L'import non esegue niente: quel modulo lancia `main()` solo se e' lui
// l'entry point di `process.argv[1]`.
import { LOCALES, SECTIONS, expectedShardPath } from './reconcile-article-shards.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export { LOCALES };

const API_BASE_DEFAULT = 'https://nanakokyobashi-rgb.github.io/frontaliere-articles';

/** Directory dei corpi articolo -> sezione (id = nome file, locale = sottocartella). */
export const BODY_DIR_SECTIONS = {
  'blog-body': 'frontaliere',
  'blog-body-ch': 'svizzera',
};

export function sectionForBodyDir(dirName) {
  return BODY_DIR_SECTIONS[dirName] ?? null;
}

// Chiave di un campo dentro un chunk meta o body: 'blog.article.<id>.<campo>': '...'
const META_KEY_RX = /'blog\.article\.([a-z0-9-]+)\.[a-zA-Z0-9]+'\s*:/;

/** Id nella chiave di una riga di chunk meta, o null se la riga non ne porta una. */
export function extractMetaArticleId(line) {
  const m = META_KEY_RX.exec(line);
  return m ? m[1] : null;
}

// Chiave di record di un chunk SEO: 'blog-<id>': { ... oppure 'swiss-<id>': { ...
const SEO_BLOCK_KEY_RX = /^\s*'(blog|swiss)-([a-z0-9-]+)':\s*\{/;

/** { section, id } dalla chiave di record che apre un blocco SEO, o null. */
export function extractSeoBlockKey(line) {
  const m = SEO_BLOCK_KEY_RX.exec(line);
  if (!m) return null;
  return { section: m[1] === 'blog' ? 'frontaliere' : 'svizzera', id: m[2] };
}

/**
 * Id sporchi in un chunk meta (content/blog-meta-<locale>.ts): ogni riga la
 * cui chiave nomina un articolo E porta un byte C0 illegale. I chunk meta
 * esistono solo per la sezione frontaliere.
 */
export function dirtyIdsInMetaText(text) {
  const ids = new Set();
  for (const line of text.split('\n')) {
    if (findControlChars(line).length === 0) continue;
    const id = extractMetaArticleId(line);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Coppie (sezione, id) sporche in un chunk SEO: la chiave di record che apre
 * un blocco precede i suoi campi, quindi lo stato va tenuto riga per riga.
 * Una riga sporca PRIMA di qualunque chiave di record (should not happen nel
 * formato reale) e' ignorata piuttosto che attribuita al blocco sbagliato.
 */
export function dirtyIdsInSeoText(text) {
  const found = [];
  let current = null;
  for (const line of text.split('\n')) {
    const key = extractSeoBlockKey(line);
    if (key) {
      current = key;
      continue;
    }
    if (current && findControlChars(line).length > 0) found.push(current);
  }
  return found;
}

/** Elenca ricorsivamente i file .ts sotto dir (assente = nessun file, non un errore). */
function listTsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Aggiunge (o marca) `${section}:${id}` nella mappa dei risultati. */
/**
 * Le stringhe che il marker lascia SULLA PAGINA una volta tolto il byte C0.
 *
 * Perche' serve un secondo criterio. `pageCarriesControlChars` chiede «sanificare
 * cambierebbe il documento?», e su una pagina emessa dopo #65 la risposta e' NO
 * anche quando il testo e' rotto: gli emitter il byte lo tolgono in uscita, e
 * cio' che resta e' la CIFRA dentro la parola. `compétences` diventa
 * `comp9tences` — nessun control character, e il criterio vecchio la dichiara
 * pulita. E' lo stesso criterio con cui #71 e' stata chiusa per sbaglio: misura
 * il marker, non il difetto.
 *
 * L'oracolo qui e' il CORPUS, non un pattern: si prende il token che contiene il
 * marker, si toglie il byte, e la stringa risultante e' esattamente quella che
 * la pagina mostrera'. Cercare quella — e non un `\w+\d\w+` generico — e' cio'
 * che rende il criterio senza falsi positivi: non e' «una parola con una cifra
 * dentro», e' «QUESTA parola, che sappiamo essere nata da un marker in QUESTO
 * articolo».
 *
 * Si scartano i residui che non mescolano lettere e cifre: quelli sono i casi
 * in cui il marker sostituiva un separatore puro (una lista di sole cifre, un
 * marcatore markdown isolato), dove togliere il byte non lascia una parola
 * visibilmente rotta e non c'e' niente da cercare.
 *
 * La cifra non deve stare per forza IN MEZZO a lettere: il marker sostituisce
 * anche il primo o l'ultimo carattere di una parola (una lettera accentata a
 * inizio parola, o l'ultima lettera prima della punteggiatura), e in quel caso
 * il residuo e' `3territorio` o `poroso3`, non `comp9tence`. Misurato sul
 * corpus reale: `content/blog-body/it/lavena-ponte-tresa-territorio-poroso.ts`
 * porta entrambe le forme sullo stesso articolo (`^H3territorio`, `poroso^H3`).
 */
export function residuesInText(text) {
  const out = new Set();
  if (typeof text !== 'string') return out;
  const C0 = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
  const TOKEN = /[A-Za-z\u00c0-\u024f\u0000-\u0008\u000b\u000c\u000e-\u001f0-9]+/g;
  const HAS_LETTER = /[A-Za-z\u00c0-\u024f]/;
  const HAS_DIGIT = /[0-9]/;
  for (const m of text.matchAll(TOKEN)) {
    const tok = m[0];
    if (!C0.test(tok)) continue;
    const stripped = tok.replace(new RegExp(C0.source, 'g'), '');
    // Deve restare un token che mescola lettere e cifre, in qualunque ordine e
    // posizione: e' la firma del residuo. Un token che dopo lo strip e' gia'
    // pulito (solo lettere) o resta puramente numerico (solo cifre) non lascia
    // una parola visibilmente rotta, e cercarlo darebbe falsi positivi ovunque.
    if (!HAS_LETTER.test(stripped) || !HAS_DIGIT.test(stripped)) continue;
    out.add(stripped);
  }
  return out;
}

function mark(map, section, id, source, residues) {
  const key = `${section}:${id}`;
  const entry = map.get(key) || { section, id, sources: [], residues: [] };
  entry.sources.push(source);
  if (residues) for (const r of residues) if (!entry.residues.includes(r)) entry.residues.push(r);
  map.set(key, entry);
}

/**
 * Scansiona l'intero content/ per id sporchi. Pura rispetto all'I/O tranne la
 * lettura file stessa: nessuna rete, nessun git.
 */
export function scanContentForDirtyIds(rootDir) {
  const found = new Map();
  let totalFiles = 0;
  let totalOccurrences = 0;

  for (const bodyDir of Object.keys(BODY_DIR_SECTIONS)) {
    const section = sectionForBodyDir(bodyDir);
    for (const file of listTsFiles(path.join(rootDir, 'content', bodyDir))) {
      const text = fs.readFileSync(file, 'utf8');
      const n = findControlChars(text).length;
      if (n === 0) continue;
      totalFiles += 1;
      totalOccurrences += n;
      const id = path.basename(file, '.ts');
      mark(found, section, id, path.relative(rootDir, file), residuesInText(text));
    }
  }

  const contentDir = path.join(rootDir, 'content');
  const metaFiles = fs.existsSync(contentDir)
    ? fs.readdirSync(contentDir).filter((n) => /^blog-meta-[a-z]+\.ts$/.test(n))
    : [];
  for (const name of metaFiles) {
    const file = path.join(contentDir, name);
    const text = fs.readFileSync(file, 'utf8');
    const n = findControlChars(text).length;
    if (n === 0) continue;
    totalFiles += 1;
    totalOccurrences += n;
    const metaResidues = residuesInText(text);
    for (const id of dirtyIdsInMetaText(text)) mark(found, 'frontaliere', id, path.relative(rootDir, file), metaResidues);
  }

  const seoDir = path.join(contentDir, 'seo');
  for (const file of listTsFiles(seoDir)) {
    const text = fs.readFileSync(file, 'utf8');
    const n = findControlChars(text).length;
    if (n === 0) continue;
    totalFiles += 1;
    totalOccurrences += n;
    const seoResidues = residuesInText(text);
    for (const { section, id } of dirtyIdsInSeoText(text)) mark(found, section, id, path.relative(rootDir, file), seoResidues);
  }

  const ids = [...found.values()].sort((a, b) => (a.section === b.section ? a.id.localeCompare(b.id) : a.section.localeCompare(b.section)));
  return { ids, totalFiles, totalOccurrences };
}

/** Ordine deterministico (sezione, poi id) + cap. Nessuna priorita' di data: sono un backlog storico, non un evento fresco. */
export function orderAndCap(ids, cap) {
  const n = Number(cap);
  const effectiveCap = Number.isInteger(n) && n >= 0 ? n : 10;
  const sorted = [...ids].sort((a, b) => (a.section === b.section ? a.id.localeCompare(b.id) : a.section.localeCompare(b.section)));
  return { selected: sorted.slice(0, effectiveCap), leftover: sorted.slice(effectiveCap) };
}

// ── Filtro sulla pagina live (issue #73) ────────────────────────────────────
//
// Da qui in giu' la superficie di verita' e' la PAGINA, non il corpus. Tutte le
// funzioni restano pure rispetto alla rete: quella entra come parametro
// `fetchImpl`, cosi' la logica e' testabile senza toccare niente di reale.

/** sezione → { shard, slugsKey }, derivata da SECTIONS di reconcile-article-shards. */
export const SECTION_BY_NAME = Object.fromEntries(SECTIONS.map((s) => [s.section, s]));

/**
 * Vero se la pagina porta ancora un control character C0 illegale.
 *
 * L'oracolo e' `sanitizeHtmlDocument`, la STESSA funzione che l'emitter applica
 * in uscita: se sanificare cambia il documento, il documento e' sporco. Due
 * conseguenze che valgono la scelta:
 *   - copre le DUE spelling con cui un C0 arriva alla pagina — il byte grezzo e
 *     la forma escapata dentro gli inline `<script>` — senza riscriverne la
 *     definizione (che e' esattamente il modo in cui le due sarebbero
 *     divergute);
 *   - eredita la confinazione che rende sicuro leggere backslash-b come
 *     backspace: solo dentro le stringhe quotate di uno script inline. Un
 *     backslash-b in un letterale regex (dove significa "confine di parola") non
 *     conta come sporco, e quindi non puo' rendere OGNI pagina eternamente
 *     sporca — che sarebbe la stessa non-convergenza di prima con un'altra
 *     causa.
 */
export function pageCarriesControlChars(html) {
  if (typeof html !== 'string') return false;
  return sanitizeHtmlDocument(html) !== html;
}

/**
 * Le URL locale della pagina di un candidato, sugli host ORIGIN.
 *
 * Gli slug arrivano da `slugs.json` (l'id e' italiano, lo slug e' localizzato:
 * costruire l'URL dall'id da' 404 su en/de/fr). Il path e' quello che il
 * publisher spinge sullo shard — `expectedShardPath` — senza `index.html`,
 * esattamente come fa il purge in fast-publish-article.yml.
 *
 * Ritorna [] se la sezione e' sconosciuta o se l'id non e' annunciato: in quel
 * caso non c'e' niente da verificare, e il chiamante tiene il candidato invece
 * di dedurne che sia pulito.
 */
export function liveUrlsForCandidate({ section, id, slugs, sectionShardSlugs }) {
  const meta = SECTION_BY_NAME[section];
  if (!meta) return [];
  const perId = (slugs && slugs[meta.slugsKey]) || {};
  const perLocale = perId[id];
  if (!perLocale) return [];
  const baseByLoc = sectionShardSlugs[meta.shard];
  if (!baseByLoc) throw new Error(`section-shard-slugs.json non ha la chiave "${meta.shard}"`);
  const urls = [];
  for (const loc of LOCALES) {
    const slug = perLocale[loc];
    if (!slug) continue; // locale mai annunciato: niente pagina da pretendere
    const rel = expectedShardPath(baseByLoc[loc], loc, slug).replace(/index\.html$/, '');
    urls.push({ locale: loc, url: `https://origin-${meta.shard}-${loc}.frontaliereticino.ch/${rel}` });
  }
  return urls;
}

/**
 * Verdetto di UNA pagina: 'dirty' | 'clean' | 'absent' | 'unknown'.
 *
 * `absent` (404 sull'origin, che e' GitHub Pages diretto — nessun Worker, nessuna
 * negative cache davanti) e' una risposta definitiva: una pagina che non c'e'
 * non porta control character, e riportarla in vita non e' il mestiere di questo
 * workflow ma di reconcile-article-shards. `unknown` copre tutto il resto —
 * 5xx, 429, timeout, DNS — e vale come "sporco" per il chiamante.
 */
export function classifyProbe({ status, body, error, residues }) {
  if (error) return 'unknown';
  if (status === 404 || status === 410) return 'absent';
  if (typeof status !== 'number' || status < 200 || status >= 300) return 'unknown';
  if (pageCarriesControlChars(body)) return 'dirty';
  // Secondo criterio: il RESIDUO. Una pagina emessa dopo #65 non porta piu' il
  // byte, ma porta la cifra che il byte si e' lasciato dietro dentro la parola.
  // Senza questo ramo il drenaggio riporta 0 su pagine visibilmente rotte —
  // misurato: `nestle-200-postes-de-travail-en-lombardie` rispondeva 200 con 23
  // parole rotte mentre il detector lo dichiarava pulito.
  if (Array.isArray(residues) && typeof body === 'string') {
    for (const r of residues) if (r && body.includes(r)) return 'dirty';
  }
  return 'clean';
}

/**
 * Verdetto di UN candidato dai verdetti delle sue pagine.
 *
 * L'asimmetria e' voluta (vedi "IN DUBBIO SI TIENE" in testa): basta UNA pagina
 * sporca per tenerlo, e basta UNA pagina non verificabile per tenerlo lo stesso.
 * Si scarta solo quando ogni locale ha risposto e nessuno era sporco.
 */
export function verdictForCandidate(probes) {
  if (!Array.isArray(probes) || probes.length === 0) {
    return { keep: true, reason: 'unannounced', dirtyLocales: [], unknownLocales: [] };
  }
  const dirtyLocales = probes.filter((p) => p.verdict === 'dirty').map((p) => p.locale);
  const unknownLocales = probes.filter((p) => p.verdict === 'unknown').map((p) => p.locale);
  if (dirtyLocales.length > 0) return { keep: true, reason: 'dirty', dirtyLocales, unknownLocales };
  if (unknownLocales.length > 0) return { keep: true, reason: 'unverified', dirtyLocales, unknownLocales };
  return { keep: false, reason: 'clean', dirtyLocales, unknownLocales };
}

/** Esegue `worker` su `items` con al piu' `limit` in volo. Ordine del risultato = ordine degli input. */
export async function mapWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * GET di una pagina con ritentativi. I ritentativi NON servono a essere gentili:
 * senza, un blip di rete diventa un `unknown`, cioe' un candidato tenuto a
 * vuoto — e il costo di sbagliare da quel lato e' una ripubblicazione inutile.
 */
export async function probePage(url, { fetchImpl = fetch, attempts = 3, timeoutMs = 20000, sleep, residues } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      const status = res.status;
      if (status === 404 || status === 410) return { status, verdict: 'absent' };
      if (status >= 200 && status < 300) {
        const body = await res.text();
        return { status, verdict: classifyProbe({ status, body, residues }) };
      }
      lastError = new Error(`HTTP ${status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < attempts) await wait(1000 * attempt);
  }
  return { status: null, verdict: 'unknown', error: String(lastError && lastError.message ? lastError.message : lastError) };
}

/**
 * Il filtro: dai candidati del corpus tiene solo quelli la cui pagina live e'
 * ancora sporca (o non verificabile). E' questa funzione a far convergere il
 * drenaggio — senza, la selezione non cambia mai dopo una ripubblicazione.
 */
export async function filterCandidatesByLivePage(
  candidates,
  { slugs, sectionShardSlugs, fetchImpl = fetch, concurrency = 8, attempts = 3, sleep, onProbe } = {},
) {
  const kept = [];
  const cleared = [];
  const jobs = [];
  for (const candidate of candidates) {
    jobs.push({ candidate, urls: liveUrlsForCandidate({ ...candidate, slugs, sectionShardSlugs }) });
  }
  const flat = [];
  for (const job of jobs) for (const u of job.urls) flat.push({ job, ...u });

  const results = await mapWithConcurrency(flat, concurrency, async (item) => {
    const r = await probePage(item.url, { fetchImpl, attempts, sleep, residues: item.job.candidate.residues });
    if (onProbe) onProbe({ ...item, ...r });
    return { job: item.job, locale: item.locale, url: item.url, ...r };
  });

  const byJob = new Map(jobs.map((j) => [j, []]));
  for (const r of results) byJob.get(r.job).push(r);

  for (const job of jobs) {
    const verdict = verdictForCandidate(byJob.get(job));
    const entry = {
      ...job.candidate,
      liveReason: verdict.reason,
      dirtyLocales: verdict.dirtyLocales,
      unverifiedLocales: verdict.unknownLocales,
    };
    if (verdict.keep) kept.push(entry);
    else cleared.push(entry);
  }
  return { kept, cleared, probes: results.length };
}

// ── Da qui in giu': solo I/O del CLI ────────────────────────────────────────

async function fetchJson(url, fetchImpl = fetch) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`fetch di ${url} fallito dopo 3 tentativi: ${lastErr}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--cap') out.cap = argv[++i];
    else if (argv[i] === '--skip-live') out.skipLive = true;
  }
  if (!out.out) {
    console.error('Uso: node scripts/find-dirty-content-ids.mjs --out <reportJsonPath> [--cap N] [--skip-live]');
    process.exit(1);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cap = args.cap ?? 10;
  const apiBase = (process.env.DIRTY_API_BASE || API_BASE_DEFAULT).replace(/\/+$/, '');
  const skipLive = args.skipLive || process.env.DIRTY_SKIP_LIVE === '1';

  const { ids: candidates, totalFiles, totalOccurrences } = scanContentForDirtyIds(ROOT_DIR);

  let ids = candidates;
  let liveFilter = 'skipped';
  let apiCommit = null;
  let cleared = [];
  let probes = 0;

  if (!skipLive && candidates.length > 0) {
    try {
      const manifest = await fetchJson(`${apiBase}/manifest.json`);
      const slugs = await fetchJson(`${apiBase}/slugs.json`);
      apiCommit = manifest.commit ?? null;
      const sectionShardSlugs = JSON.parse(
        fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'lib', 'section-shard-slugs.json'), 'utf8'),
      );
      const filtered = await filterCandidatesByLivePage(candidates, { slugs, sectionShardSlugs });
      ids = filtered.kept;
      cleared = filtered.cleared;
      probes = filtered.probes;
      liveFilter = 'applied';
    } catch (err) {
      // Fail-safe, come per le singole pagine: senza la superficie annunciata
      // non si puo' dimostrare che una pagina sia pulita, quindi si tengono
      // tutti i candidati. Il run non converge, ma non salta nemmeno un id —
      // ed e' rumoroso, non silenzioso.
      console.log(`::warning::[find-dirty-content-ids] filtro live non applicato (${err && err.message ? err.message : err}) — tengo tutti i candidati del corpus`);
      liveFilter = 'failed';
    }
  } else if (candidates.length === 0) {
    liveFilter = 'not-needed';
  }

  const { selected, leftover } = orderAndCap(ids, cap);

  const report = {
    schema: 2,
    generatedAt: new Date().toISOString(),
    totalFiles,
    totalOccurrences,
    apiBase,
    apiCommit,
    liveFilter,
    counts: {
      corpusCandidates: candidates.length,
      distinct: ids.length,
      liveClean: cleared.length,
      probes,
      selected: selected.length,
      leftover: leftover.length,
    },
    selected,
    leftover,
    cleared,
  };
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    `[find-dirty-content-ids] ${totalFiles} file, ${totalOccurrences} byte C0, ${candidates.length} candidati dal corpus → ${ids.length} con pagina live ancora sporca (filtro live: ${liveFilter}, ${probes} pagine viste, ${cleared.length} id gia' puliti; selezionati ${selected.length}, in coda ${leftover.length}, cap ${cap})`,
  );
  for (const { section, id, sources, liveReason, dirtyLocales } of selected) {
    const why = liveReason === 'dirty' ? `live sporco: ${dirtyLocales.join(',')}` : `live ${liveReason ?? 'non filtrato'}`;
    console.log(`  → ${section}/${id} (${why}; ${sources.length} sorgente/i: ${sources.join(', ')})`);
  }
  if (cleared.length > 0) {
    console.log(`  … gia' puliti sul live, esclusi: ${cleared.map((c) => c.id).join(', ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`::error::[find-dirty-content-ids] ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

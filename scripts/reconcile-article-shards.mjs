#!/usr/bin/env node
// reconcile-article-shards.mjs — riconciliazione «slug annunciati ↔ pagine
// reali sugli shard» per la classe «articolo fantasma».
//
// IL DIFETTO DI CLASSE (misurato il 2026-08-08, run 31245282583).
// Un push su main che tocca content/** lancia IN PARALLELO publish-api.yml
// (che ANNUNCIA l'articolo: slugs.json, sitemap, hub) e fast-publish-article.yml
// (che PUBBLICA le pagine HTML sugli 8 shard). I due esiti sono indipendenti:
// quella mattina publish-api è andato a buon fine e fast-publish è morto in 29s
// su `npm ci` (ETIMEDOUT). Risultato: `grigioni-frontalieri-calano` annunciato
// ovunque e 404 per 8,5 ore — e NESSUN meccanismo lo ritentava, perché i
// fast-publish successivi pubblicano solo il proprio articolo, e uno step di
// rimedio DENTRO il run fallito non gira mai (un run morto a `npm ci` non
// arriva ai propri step).
//
// Non era un caso isolato: alla prima esecuzione reale di questa scansione la
// diff ha trovato anche `un-anno-dallo-shock-dei-dazi-esportatori-incerti`
// (svizzera, 2026-08-07) assente su TUTTI e 4 i locali — confermato 404 sia
// sugli origin che all'apex, mentre uno sweep HEAD su tutte le 15.064 URL
// annunciate non ha trovato NESSUN altro 404.
//
// COSA FA QUESTO SCRIPT (solo DETECTION — non pubblica niente):
//   1. legge la superficie annunciata dall'API pubblicata (manifest.json per
//      primo: `commit` + `counts` permettono di rifiutare un set troncato
//      prima di usarlo; poi slugs.json e i registri per le date);
//   2. legge le pagine REALI di ogni shard via `git ls-tree` su un clone
//      `--filter=blob:none --no-checkout` (solo oggetti tree, zero blob:
//      ~0,5 MB a shard invece di migliaia di HEAD HTTP — e niente cache
//      negativa del Worker a falsare la lettura);
//   3. calcola la diff per (sezione, locale), esclude gli id svizzeri
//      «shadowed» da content/swiss-article-canonical-overrides.json (sono
//      de-listati apposta: la loro assenza non è un difetto);
//   4. ordina i mancanti dal più recente e applica un CAP per run, per non
//      creare tempeste di ripubblicazione;
//   5. scrive un JSON con `selected` (da ripubblicare ora) e `leftover`
//      (visibili ma oltre il cap) per il workflow chiamante
//      (.github/workflows/reconcile-article-shards.yml), che ripubblica
//      dispatchando fast-publish-article.yml — così render, push, purge
//      Cloudflare (apex + origin) e verify restano in UN posto solo.
//
// La logica di riconciliazione è esportata come funzioni pure (nessun accesso
// a rete/fs/git dentro di esse) e testata da
// generator/tests/reconcile-article-shards.test.mjs con `node --test`.
// Solo builtin Node (fetch globale di Node 22, child_process per git):
// il chiamante NON fa `npm ci`, quindi la detection è immune alla stessa
// classe di guasto (ETIMEDOUT su npm) che deve riparare.
//
// CLI:
//   node scripts/reconcile-article-shards.mjs --out <reportJsonPath> [--cap N]
// Env:
//   RECONCILE_API_BASE      base dell'API pubblicata (default: la radice di
//                           GitHub Pages del corpus — l'API risponde alla
//                           radice, NON sotto /api/)
//   RECONCILE_BACKFILL_CAP  cap di backfill per run (default 3; --cap vince)
//
// Exit: 0 = detection riuscita (anche con mancanti > 0: decide il workflow);
//       1 = superficie annunciata o shard illeggibili/troncati — meglio non
//           agire su dati parziali che ripubblicare in massa per errore.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const LOCALES = ['it', 'en', 'de', 'fr'];

// sezione → shard → chiave dentro slugs.json. Le due sezioni articolo sono
// quelle di scripts/lib/section-shard-slugs.json; `slugsKey` segue la forma
// che scripts/build-api.mjs pubblica ({ blog, swiss, ... }).
export const SECTIONS = [
  { section: 'frontaliere', shard: 'articolifrontaliere', slugsKey: 'blog' },
  { section: 'svizzera', shard: 'articolisvizzera', slugsKey: 'swiss' },
];

/**
 * Path della pagina articolo DENTRO il repo shard (e quindi sull'origin che
 * lo serve). Stessa regola dichiarata da section-shard-slugs.json: il locale
 * it sta alla radice, en/de/fr sotto il proprio prefisso. Verificata contro
 * il tree reale dello shard it (3409 pagine, diff = 0 al primo giro).
 */
export function expectedShardPath(baseSlug, locale, slug) {
  const prefix = locale === 'it' ? '' : `${locale}/`;
  return `${prefix}${baseSlug}/${slug}/index.html`;
}

/**
 * Rifiuta una superficie annunciata troncata PRIMA di usarla. Un fetch
 * parziale di slugs.json che perdesse metà delle chiavi non deve produrre
 * né falsi «tutto presente» né (peggio) una lista di mancanti sbagliata.
 * Ritorna la lista dei problemi; vuota = superficie coerente.
 */
export function validateAnnouncedSurface({ manifest, slugs, articles, swissArticles }) {
  const errors = [];
  const counts = manifest && manifest.counts;
  if (!counts || typeof counts.articles !== 'number' || typeof counts.swissArticles !== 'number') {
    errors.push('manifest.json senza counts.articles/counts.swissArticles');
    return errors;
  }
  // Stesso floor di publish-api.yml («refusing to publish» sotto 100).
  if (counts.articles < 100) errors.push(`manifest riporta solo ${counts.articles} articoli`);
  const blogKeys = slugs && slugs.blog ? Object.keys(slugs.blog).length : 0;
  const swissKeys = slugs && slugs.swiss ? Object.keys(slugs.swiss).length : 0;
  if (blogKeys !== counts.articles) {
    errors.push(`slugs.blog ha ${blogKeys} id ma il manifest ne annuncia ${counts.articles}`);
  }
  if (swissKeys !== counts.swissArticles) {
    errors.push(`slugs.swiss ha ${swissKeys} id ma il manifest ne annuncia ${counts.swissArticles}`);
  }
  if (!Array.isArray(articles) || articles.length !== counts.articles) {
    errors.push(`articles.json ha ${Array.isArray(articles) ? articles.length : '?'} voci, attese ${counts.articles}`);
  }
  if (!Array.isArray(swissArticles) || swissArticles.length !== counts.swissArticles) {
    errors.push(
      `swiss-articles.json ha ${Array.isArray(swissArticles) ? swissArticles.length : '?'} voci, attese ${counts.swissArticles}`,
    );
  }
  return errors;
}

/**
 * De-quoting dei path di `git ls-tree`. Col default `core.quotePath=true` git
 * QUOTA i path non-ASCII e ne escapa i byte in ottali C:
 *
 *   "de/grenzgaenger-artikel/duba\303\257-bis-ticino/index.html"
 *
 * mentre slugs.json annuncia la stringa UTF-8 raw (`dubaï-bis-ticino`). Alla
 * prima esecuzione reale questo ha prodotto 68 FALSI fantasmi — tutti e soli
 * gli slug de/fr/en con umlaut o accenti, tutti serviti 200 sia dall'origin
 * che dall'apex (misurato su 3 campioni + sweep completo delle 15.064 URL
 * annunciate). Il comando in readShardTree passa `-c core.quotePath=false`;
 * questa funzione è la cintura oltre alle bretelle: decodifica comunque una
 * riga quotata, così un config globale o un default diverso non possono
 * reintrodurre la classe in silenzio.
 *
 * Gli escape ottali sono BYTE, non code point: vanno accumulati e decodificati
 * come UTF-8 alla fine (\303\257 → 0xC3 0xAF → «ï»), mai char-per-char.
 */
export function unquoteGitPath(line) {
  if (typeof line !== 'string' || line.length < 2 || !line.startsWith('"') || !line.endsWith('"')) {
    return line;
  }
  const inner = line.slice(1, -1);
  const bytes = [];
  const simple = { '\\': 0x5c, '"': 0x22, a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b };
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') {
      bytes.push(inner.charCodeAt(i));
      continue;
    }
    const next = inner[i + 1];
    if (next >= '0' && next <= '7') {
      let oct = '';
      let j = i + 1;
      while (j < inner.length && oct.length < 3 && inner[j] >= '0' && inner[j] <= '7') {
        oct += inner[j];
        j++;
      }
      bytes.push(parseInt(oct, 8));
      i = j - 1;
    } else if (next !== undefined) {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i++;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Normalizza l'output riga-per-riga di ls-tree in path UTF-8 confrontabili. */
export function normalizeTreePaths(lines) {
  return lines.map(unquoteGitPath);
}

/**
 * Un tree di shard credibile: un clone fallito a metà o un repo azzerato non
 * devono far sembrare «mancante» l'intero corpus. 50 è largo: lo shard più
 * piccolo (articolisvizzera-*) ne ha ~1.400.
 */
export function treeLooksSane(paths) {
  if (!Array.isArray(paths) || paths.length < 50) return false;
  return paths.includes('CNAME') || paths.includes('404.html');
}

/**
 * La diff annunciati ↔ presenti. Pura: riceve slugs, gli id svizzeri shadowed
 * (Set), e `trees` = { '<shard>-<loc>': Set<string> dei path del repo }.
 * Ritorna [{ id, section, shard, locales: [...] }] nell'ordine di slugs.json,
 * un elemento per articolo con almeno un locale senza pagina.
 */
export function computeMissing({ slugs, shadowedSwissIds, sectionShardSlugs, trees }) {
  const shadowed = shadowedSwissIds instanceof Set ? shadowedSwissIds : new Set(shadowedSwissIds || []);
  const missing = [];
  for (const { section, shard, slugsKey } of SECTIONS) {
    const perId = slugs[slugsKey] || {};
    const baseByLoc = sectionShardSlugs[shard];
    if (!baseByLoc) throw new Error(`section-shard-slugs.json non ha la chiave "${shard}"`);
    for (const [id, perLocale] of Object.entries(perId)) {
      if (section === 'svizzera' && shadowed.has(id)) continue;
      const locales = [];
      for (const loc of LOCALES) {
        const slug = perLocale && perLocale[loc];
        if (!slug) continue; // locale mai annunciato: niente da pretendere
        const tree = trees[`${shard}-${loc}`];
        if (!tree) throw new Error(`tree mancante per ${shard}-${loc}`);
        if (!tree.has(expectedShardPath(baseByLoc[loc], loc, slug))) locales.push(loc);
      }
      if (locales.length > 0) missing.push({ id, section, shard, locales });
    }
  }
  return missing;
}

/**
 * Ordina dal più recente e applica il cap. `dateById` è una Map id → date
 * (ISO); un id senza data finisce in coda (è per costruzione roba vecchia:
 * i registri pubblicano la data di ogni articolo). Tie-break sull'id per
 * avere un ordine deterministico e testabile.
 */
export function orderAndCap(missing, dateById, cap) {
  const n = Number(cap);
  const effectiveCap = Number.isInteger(n) && n >= 0 ? n : 3;
  const dated = missing.map((m) => ({ ...m, date: dateById.get(m.id) || null }));
  dated.sort((a, b) => {
    const cmp = String(b.date || '').localeCompare(String(a.date || ''));
    return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
  });
  return { selected: dated.slice(0, effectiveCap), leftover: dated.slice(effectiveCap) };
}

// ── Da qui in giù: solo I/O del CLI (niente da testare in purezza) ──────────

const API_BASE_DEFAULT = 'https://nanakokyobashi-rgb.github.io/frontaliere-articles';

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`fetch di ${url} fallito dopo 3 tentativi: ${lastErr}`);
}

/**
 * Elenco path di uno shard con soli oggetti tree: clone --filter=blob:none
 * --no-checkout (nessun blob scaricato, ~0,5 MB) + ls-tree ricorsivo. Due
 * tentativi: un blip di rete sul clone non deve costare l'intero run.
 */
function readShardTree(owner, shard, loc, scratchRoot) {
  const url = `https://github.com/${owner}/frontaliere-${shard}-${loc}.git`;
  const dir = path.join(scratchRoot, `shard-${shard}-${loc}`);
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      execFileSync('git', ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', url, dir], {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 120000,
      });
      // core.quotePath=false: senza, git quota i path non-ASCII in ottali C e
      // ogni slug con umlaut/accento diventa un falso fantasma (68 al primo
      // giro reale — vedi unquoteGitPath, che resta come seconda difesa).
      const out = execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'HEAD'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60000,
      });
      fs.rmSync(dir, { recursive: true, force: true });
      return normalizeTreePaths(out.split('\n').filter(Boolean));
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`impossibile leggere il tree di ${url}: ${lastErr}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--cap') out.cap = argv[++i];
  }
  if (!out.out) {
    console.error('Uso: node scripts/reconcile-article-shards.mjs --out <reportJsonPath> [--cap N]');
    process.exit(1);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiBase = (process.env.RECONCILE_API_BASE || API_BASE_DEFAULT).replace(/\/+$/, '');
  const cap = args.cap ?? process.env.RECONCILE_BACKFILL_CAP ?? 3;

  // 1. Superficie annunciata. manifest.json per primo — commit + counts.
  const manifest = await fetchJson(`${apiBase}/manifest.json`);
  const slugs = await fetchJson(`${apiBase}/slugs.json`);
  const articles = await fetchJson(`${apiBase}/articles.json`);
  const swissArticles = await fetchJson(`${apiBase}/swiss-articles.json`);

  const surfaceErrors = validateAnnouncedSurface({ manifest, slugs, articles, swissArticles });
  if (surfaceErrors.length > 0) {
    for (const e of surfaceErrors) console.error(`::error::[reconcile] superficie annunciata incoerente: ${e}`);
    process.exit(1);
  }

  // 2. Esclusioni: gli id svizzeri shadowed viaggiano col corpus, non con
  // l'API. File OBBLIGATORIO nel checkout: senza, 12 articoli de-listati
  // apposta sembrerebbero fantasmi e verrebbero ripubblicati a vuoto.
  const overridesPath = path.join(ROOT_DIR, 'content', 'swiss-article-canonical-overrides.json');
  const shadowedSwissIds = new Set(
    Object.keys(JSON.parse(fs.readFileSync(overridesPath, 'utf8')).overrides ?? {}),
  );

  const sectionShardSlugs = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'lib', 'section-shard-slugs.json'), 'utf8'),
  );
  const owners = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'lib', 'section-shard-owners.json'), 'utf8'),
  );

  // 3. Pagine reali: gli 8 tree, con floor di sanità ciascuno.
  const scratchRoot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'reconcile-shards-'));
  const trees = {};
  const perShard = {};
  try {
    for (const { shard } of SECTIONS) {
      const owner = owners[shard] || 'valerielinc-ops';
      for (const loc of LOCALES) {
        const paths = readShardTree(owner, shard, loc, scratchRoot);
        if (!treeLooksSane(paths)) {
          console.error(
            `::error::[reconcile] il tree di ${shard}-${loc} non è credibile (${paths.length} path) — mi fermo invece di dichiarare fantasma mezzo corpus`,
          );
          process.exit(1);
        }
        trees[`${shard}-${loc}`] = new Set(paths);
        perShard[`${shard}-${loc}`] = { paths: paths.length };
      }
    }
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  // 4-5. Diff, ordinamento, cap, report.
  const missing = computeMissing({ slugs, shadowedSwissIds, sectionShardSlugs, trees });
  const dateById = new Map([...articles, ...swissArticles].map((a) => [a.id, a.date]));
  const { selected, leftover } = orderAndCap(missing, dateById, cap);

  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    apiBase,
    apiCommit: manifest.commit ?? null,
    counts: {
      announcedBlog: Object.keys(slugs.blog).length,
      announcedSwiss: Object.keys(slugs.swiss).length,
      shadowedSwiss: shadowedSwissIds.size,
      missing: missing.length,
      selected: selected.length,
      leftover: leftover.length,
    },
    perShard,
    selected,
    leftover,
  };
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    `[reconcile] corpus @${String(report.apiCommit).slice(0, 8)} — annunciati ${report.counts.announcedBlog}+${report.counts.announcedSwiss}, fantasmi ${missing.length} (selected ${selected.length}, leftover ${leftover.length}, cap ${cap})`,
  );
  for (const m of selected) console.log(`  → backfill ${m.section}/${m.id} (${m.date ?? 'senza data'}; locali: ${m.locales.join(',')})`);
  if (leftover.length > 0) {
    console.log(`  … oltre il cap: ${leftover.slice(0, 10).map((m) => m.id).join(', ')}${leftover.length > 10 ? ` (+${leftover.length - 10})` : ''}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`::error::[reconcile] ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

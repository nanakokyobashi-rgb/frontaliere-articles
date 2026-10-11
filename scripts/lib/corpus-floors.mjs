import '../../host/cantonSectionsBootstrap.mjs';

/**
 * corpus-floors.mjs — i pavimenti anti-troncamento, DERIVATI dal corpus.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `manifest.json` esiste per «rifiutare un set troncato *prima* di usarlo»
 * (AGENTS.md), e il gate `Verify artifact` di `publish-api.yml` e' il lato che
 * quel rifiuto lo esegue prima della pubblicazione. Ma il suo pavimento era una
 * costante scritta a mano: `counts.articles -lt 100`.
 *
 * Misurato il 2026-09-05 sul corpus reale: `counts.articles` = **3782**. Il
 * pavimento era al **2,6%** del valore atteso, cioe' una perdita del 97% del
 * corpus passava il gate e andava live — e il sito non ribuilda, quindi ci va
 * subito. `counts.swissArticles` (1850) non aveva pavimento affatto.
 *
 * La root cause non e' il numero 100: e' che il numero e' ASSOLUTO. Un
 * pavimento assoluto viene tarato una volta contro il corpus di quel giorno e
 * poi non si muove piu', mentre il corpus cresce di due ordini di grandezza. Il
 * gate non «si rompe»: si svuota, restando verde. Alzarlo a 3500 comprerebbe
 * qualche mese e ricreerebbe lo stesso difetto.
 *
 * Qui il pavimento e' RELATIVO a una verita' di terra che sta su disco accanto
 * all'artefatto — i file sorgente del corpus — quindi scala da solo per sempre
 * e non ha una taratura da rivedere.
 *
 * Solo builtin Node, per la regola di `scripts/ci/**`: eseguibile senza
 * `npm ci`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findAllSeoEntryMatches } from './seo-entry.mjs';
import { scanTopLevelArticleRecords } from './article-registry-reader.mjs';
import { selectRetiredDailyEditions } from '../../generator/scripts/lib/daily-brief-content.mjs';
import { parseArticleUrlSlugs } from '../../engine/shared/articleReaderSource.mjs';
import { ARTICLES_PAGE_SIZE } from '../../engine/shared/articleArchiveConfig.mjs';
import {
  API_SECTIONS,
  CORPUS_SECTIONS,
  KNOWN_SECTION_IDS,
  SECTION_LOCALES,
  sectionSourceSurfaces,
} from './corpus-sections.mjs';

/**
 * Quanta parte del corpus sorgente deve sopravvivere fino all'artefatto.
 *
 * MISURATO 2026-09-05, non scelto: `content/blog-body/it` tiene 3785 file e
 * `counts.articles` ne dichiara 3782 (99,92%); lato svizzera i due numeri
 * coincidono (1850/1850). Lo scarto reale e' dello 0,08%, quindi il 10% di
 * tolleranza e' ~125x il divario osservato — largo abbastanza da non fallire su
 * un orfano o una voce ritirata, stretto abbastanza da fermare qualunque
 * troncamento che meriti quel nome (un parse a meta', uno shard set letto
 * parzialmente, un filtro applicato per sbaglio all'intero registro).
 *
 * A differenza di un pavimento assoluto, questa non e' una taratura che scade:
 * e' una frazione, e il valore atteso viene ricontato a ogni run.
 */
export const FLOOR_RETENTION = 0.9;

/**
 * La soglia di PREALLARME: advisory, non un gate.
 *
 * PERCHE' ESISTE. `FLOOR_RETENTION` e' tarato sullo scarto osservato UNA volta
 * (99,92% frontaliere, 100% svizzera), ma i due lati del rapporto contano cose
 * diverse — i file di corpo da una parte, le voci dichiarate dall'artefatto
 * dall'altra. Oggi `scripts/retire-article.mjs` li tiene allineati cancellando
 * insieme corpo e voce, ma qualunque flusso che lasci un corpo senza voce
 * (orfani, ritiri a meta', import parziali) sposta il rapporto verso il basso
 * in modo MONOTONO. Nessuno misurava quel rapporto nel tempo: la prima notizia
 * del drift sarebbe stata la pubblicazione BLOCCATA, cioe' il gate che scatta
 * senza preavviso su un corpus sano.
 *
 * 0,97 da' ~7 punti percentuali di anticipo sul 0,90 — l'erosione si vede
 * mentre e' ancora innocua, e chi la vede ha il tempo di capirla invece di
 * scoprirla da una publish rossa.
 *
 * NON e' un gate e non ne sposta uno: `FLOOR_RETENTION` resta 0,9 e resta
 * bloccante (AGENTS.md #1). Questo livello sta SOPRA, e chi lo sfonda esce
 * comunque 0. L'invariante che lo rende raggiungibile — deve stare stretto fra
 * il gate e 1 — e' asserito in
 * `generator/tests/api-floors-derived-from-corpus.test.mjs`: invertirle
 * renderebbe il preallarme irraggiungibile in silenzio, cioe' ricreerebbe
 * esattamente la cecita' che chiude.
 */
export const FLOOR_WARN_RETENTION = 0.97;

/**
 * Il rapporto misurato/atteso, o `null` se non c'e' un riferimento.
 *
 * `null` e non 0 per la stessa ragione per cui `floorFrom(0)` merita un errore
 * nei chiamanti: «il riferimento non c'e'» non e' «il rapporto e' zero», ed e'
 * una condizione che va segnalata come assenza, non come erosione.
 */
export function retentionRatio(declared, source) {
  if (!Number.isFinite(declared) || !Number.isFinite(source) || source <= 0) return null;
  return declared / source;
}

/**
 * La riga di telemetria di un rapporto: cosa vale e quanto margine resta prima
 * del gate, in punti percentuali. Stampata a OGNI run, anche verde — e' il
 * punto: un rapporto che nessuno stampa e' un rapporto che nessuno vede
 * scendere.
 */
export function retentionLine(label, declared, source, retention = FLOOR_RETENTION) {
  const ratio = retentionRatio(declared, source);
  if (ratio === null) return `${label}: nessun riferimento (sorgente ${source})`;
  const margin = (ratio - retention) * 100;
  return (
    `${label}: ${declared}/${source} = ${(ratio * 100).toFixed(2)}% ` +
    `(margine ${margin.toFixed(1)} pp dal gate ${(retention * 100).toFixed(0)}%)`
  );
}

/**
 * Il preallarme di un rapporto, o `null` se non serve.
 *
 * Solo sopra il pavimento intero del gate e sotto il preallarme: sotto quel
 * pavimento non e' un preallarme ma una VIOLAZIONE, che il chiamante emette
 * gia' come errore — raddoppiarla in warning confonderebbe il verdetto invece
 * di anticiparlo. Sul bordo il rapporto grezzo puo' essere appena sotto
 * `retention` per effetto dell'arrotondamento, ma il confronto intero passa.
 */
export function retentionWarning(
  label,
  declared,
  source,
  retention = FLOOR_RETENTION,
  warn = FLOOR_WARN_RETENTION,
) {
  const ratio = retentionRatio(declared, source);
  if (ratio === null || ratio >= warn || declared < floorFrom(source, retention)) return null;
  const margin = Math.max(0, (ratio - retention) * 100);
  return (
    `${label}: rapporto ${(ratio * 100).toFixed(2)}% sotto il preallarme ` +
    `${(warn * 100).toFixed(0)}% — restano ${margin.toFixed(1)} pp ` +
    `prima del gate ${(retention * 100).toFixed(0)}%, che bloccherebbe la pubblicazione`
  );
}

/**
 * Il preallarme sulla popolazione che genera un feed, senza spostare il gate.
 *
 * Un feed emette al massimo `RSS_MAX_ITEMS`, quindi il suo rapporto rispetto
 * a quel cap non vede se i chunk SEO sono passati da migliaia a poche decine.
 * Questa riga confronta invece i chunk con la loro popolazione della run
 * precedente: e' solo diagnostica e resta visibile senza riusare il rapporto
 * fra chunk e corpi, che sono popolazioni scollegate.
 */
export function populationWarning(label, declared, source, warn = FLOOR_WARN_RETENTION) {
  const ratio = retentionRatio(declared, source);
  if (ratio === null || ratio >= warn) return null;
  return (
    `${label}: popolazione ${declared}/${source} = ${(ratio * 100).toFixed(2)}% ` +
    `sotto il preallarme ${(warn * 100).toFixed(0)}% — i chunk SEO sono scesi rispetto ` +
    `alla loro run precedente`
  );
}

/**
 * Il pavimento per un valore atteso. Un atteso positivo ha sempre almeno un
 * elemento; solo un riferimento davvero assente/non positivo produce 0.
 *
 * ATTENZIONE, ed e' il punto piu' delicato di questo modulo: `floorFrom(0)` e'
 * 0, e un pavimento a 0 non e' un pavimento — `x < 0` e' falso per qualunque
 * `x`, quindi il gate SPARISCE invece di scattare. Un pavimento derivato ha
 * questo modo di fallire che quello assoluto non aveva: la costante `100` era
 * sbagliata ma incondizionata, il derivato e' giusto solo finche' il suo
 * riferimento esiste. Ogni chiamante deve percio' distinguere «il corpus dice
 * zero» da «il corpus non c'e'», e trattare il secondo come un ERRORE — vedi
 * `missingCorpusMessage`, `sectionFloor` e `floorViolations`.
 */
export function floorFrom(expected, retention = FLOOR_RETENTION) {
  if (!Number.isFinite(expected) || expected <= 0) return 0;
  return Math.max(1, Math.floor(expected * retention));
}

/**
 * Il messaggio unico per «il riferimento del pavimento non c'e'».
 *
 * Vive qui e non nei due chiamanti perche' la REGOLA e' una sola: un corpus
 * sorgente assente o vuoto non e' un pavimento a zero, e' l'assenza del
 * riferimento contro cui il pavimento si misura. Un checkout parziale, un
 * symlink del corpus non risolto (la stessa condizione gia' vista in
 * `fast-publish-article.yml`, «the corpus symlinks were missing») azzera
 * insieme sorgente e artefatto, e senza questa regola il gate resterebbe verde
 * pubblicando il vuoto sopra il buono.
 */
export function missingCorpusMessage(what, rel) {
  return (
    `riferimento del pavimento assente: ${rel} e' assente o vuota, ` +
    `quindi il pavimento di ${what} sarebbe 0 — cioe' nessun gate. ` +
    "Un corpus sorgente vuoto non e' un pavimento a zero: e' l'assenza del riferimento."
  );
}

/**
 * Dove vive il corpo di un articolo, per sezione. E' un file per articolo, ed e'
 * l'artefatto sorgente piu' vicino alla cardinalita' che il manifest dichiara:
 * il registro TS che `build-api.mjs` legge e' UN file solo, quindi contarne le
 * voci significherebbe fidarsi dello stesso parse che il gate deve sorvegliare.
 *
 * ── Le sezioni vengono dal core ────────────────────────────────────────────
 *
 * Queste mappe erano scritte a mano per frontaliere e svizzera. Ora sono
 * derivate da `scripts/lib/corpus-sections.mjs`, cioe' dal core delle sezioni
 * (lista ATTIVA): una sezione accesa nel core ha il suo pavimento senza toccare
 * questo file. Le funzioni sotto accettano pero' QUALSIASI sezione nota al
 * core, attiva o no (`sourceOf`), cosi' la regola di una famiglia si prova sul
 * suo id vero prima che la famiglia venga accesa.
 *
 * `SECTION_COUNTERS` / `SECTION_SITEMAPS` restano le sole sezioni con una
 * superficie API PROPRIA (contatore e sitemap col loro nome nel manifest):
 * le sezioni cantonali pubblicano in superfici aggregate di famiglia, che non
 * esistono ancora (vedi `sectionApiSurfaces`).
 */
export const SECTION_BODY_DIRS = Object.freeze(Object.fromEntries(
  CORPUS_SECTIONS.map((s) => [s.section, path.join(s.bodyDir, 'it')]),
));

/** Le chiavi del manifest e i file della sitemap delle sezioni con superficie API propria. */
export const SECTION_COUNTERS = Object.freeze(Object.fromEntries(
  API_SECTIONS.map((s) => [s.section, s.api.counter]),
));

export const SECTION_SITEMAPS = Object.freeze(Object.fromEntries(
  API_SECTIONS.map((s) => [s.section, s.api.sitemap]),
));

export const ARCHIVE_SITEMAP = 'sitemap-articles-archive.xml';
export { ARTICLES_PAGE_SIZE as ARCHIVE_PAGE_SIZE };

/** Le superfici sorgente di una sezione nota al core (attiva o no). */
function sourceOf(section) {
  if (!KNOWN_SECTION_IDS.includes(section)) throw new Error(`unknown corpus section: ${section}`);
  return sectionSourceSurfaces(section);
}

/** Registro e metadati che definiscono l'atteso dei corpi, per sezione attiva. */
export const SECTION_REGISTRY_FILES = Object.freeze(Object.fromEntries(
  CORPUS_SECTIONS.map((s) => [s.section, s.registryFile]),
));

/** Prefisso dei file meta per sezione attiva (`blog-meta-ch-` → `blog-meta-ch-it.ts`). */
export const SECTION_META_PREFIXES = Object.freeze(Object.fromEntries(
  CORPUS_SECTIONS.map((s) => [s.section, `${path.basename(s.metaPrefix)}-`]),
));

/**
 * Una sezione con politica `family` (le cantonali) senza la coppia registry/slugs
 * e' una sezione NUOVA, non un corpus sparito: il suo pavimento proprio e' 0.
 * Anche la coppia vuota esplicita (`Article[] = []` + slug map `{}`) e' valida.
 * Una coppia parziale resta invece fail-closed; il corpus sparito lo vedono
 * comunque le sezioni storiche, che stanno sotto lo stesso `content/`.
 */
export function floorPolicyOf(section) {
  return sourceOf(section).floorPolicy;
}

/**
 * True per una sezione `family` che non ha ancora alcuna superficie sorgente:
 * una sezione appena accesa, con zero articoli. Un solo file presente non e'
 * «nuovo»: e' una coppia parziale e deve fallire chiuso.
 */
export function isNewFamilySection(root, section) {
  if (floorPolicyOf(section) !== 'family') return false;
  // Una superficie sola non è una sezione nuova vuota: è una coppia corrotta.
  // Fallire qui, prima di decidere se saltare la sezione, evita che i consumer
  // leggano o scrivano un registry senza la mappa slug (o viceversa).
  assertFamilySourcePair(root, section);
  const source = sourceOf(section);
  return (
    !fs.existsSync(path.join(root, source.registryFile)) &&
    !fs.existsSync(path.join(root, source.slugFile))
  );
}

const escapedLiteral = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function isEmptyRegistrySource(source, exportName) {
  return new RegExp(
    `\\bconst\\s+${escapedLiteral(exportName)}(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*\\[\\s*\\]\\s*;`,
    'm',
  ).test(source);
}

function isEmptySlugSource(source, exportName) {
  return new RegExp(
    `\\bconst\\s+${escapedLiteral(exportName)}(?:\\s*:\\s*[^=\\n]+)?\\s*=\\s*\\{\\s*\\}\\s*;`,
    'm',
  ).test(source);
}

/** La coppia vuota esplicita di una sezione cantonale e' uno stato valido. */
function isEmptyFamilySection(root, section) {
  if (floorPolicyOf(section) !== 'family') return false;
  assertFamilySourcePair(root, section);
  const source = sourceOf(section);
  const registryPath = path.join(root, source.registryFile);
  const slugPath = path.join(root, source.slugFile);
  if (!fs.existsSync(registryPath) || !fs.existsSync(slugPath)) return false;
  return (
    isEmptyRegistrySource(fs.readFileSync(registryPath, 'utf8'), source.registryExport) &&
    isEmptySlugSource(fs.readFileSync(slugPath, 'utf8'), source.slugExport)
  );
}

function assertFamilySourcePair(root, section) {
  if (floorPolicyOf(section) !== 'family') return;
  const source = sourceOf(section);
  const registry = fs.existsSync(path.join(root, source.registryFile));
  const slugs = fs.existsSync(path.join(root, source.slugFile));
  if (registry !== slugs) {
    throw new Error(`${section}: registry/slugs incompleti`);
  }
}

/**
 * Il verdetto di pavimento di una FAMIGLIA di sezioni (politica `family`).
 *
 * Due condizioni, entrambe necessarie:
 *   - nessuna sezione con articoli in sorgente puo' uscire a ZERO (`emptied`):
 *     la somma non deve poter nascondere una sezione svuotata dietro le
 *     altre, che e' il troncamento peggiore perche' tocca una sezione intera;
 *   - la famiglia nel suo insieme deve reggere il pavimento relativo
 *     (somma dei sorgenti contro somma degli emessi).
 * Una sezione nuova a 0 in sorgente non pesa su nessuna delle due.
 *
 * @param {Array<{section: string, source: number, emitted: number}>} rows
 */
export function familyFloorVerdict(rows, retention = FLOOR_RETENTION) {
  const source = rows.reduce((total, row) => total + row.source, 0);
  const emitted = rows.reduce((total, row) => total + row.emitted, 0);
  const floor = floorFrom(source, retention);
  const emptied = rows.filter((row) => row.source > 0 && row.emitted === 0).map((row) => row.section);
  return {
    sections: rows.map((row) => row.section),
    source,
    emitted,
    floor,
    emptied,
    truncated: emitted < floor || emptied.length > 0,
  };
}

/** Locali che build-api.mjs carica per ogni sezione. */
export const SECTION_META_LOCALES = SECTION_LOCALES;

const META_TITLE_KEY_RE = /['"]blog\.article\.([^'"]+)\.title['"]\s*:/g;
/** Quante immagini hero questo repo tiene davvero (sorgente di `images-manifest.json`). */
export const IMAGE_SOURCE_DIR = path.join('public', 'images', 'blog');
export const IMAGE_SOURCE_DIRS = Object.freeze([
  IMAGE_SOURCE_DIR,
  path.join('public', 'images', 'generated'),
]);

function countFiles(dir, ext) {
  const stat = fs.statSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return 0;
  const files = fs.readdirSync(dir);
  return files.filter((f) => f.endsWith(ext)).length;
}

function countCorpusFiles(root, rel, ext, what) {
  try {
    return countFiles(path.join(root, rel), ext);
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'EACCES') {
      const wrapped = new Error(missingCorpusMessage(what, path.join(root, rel)), { cause: error });
      wrapped.code = 'MISSING_CORPUS';
      throw wrapped;
    }
    throw error;
  }
}

function missingReference(what, rel, cause) {
  const error = new Error(missingCorpusMessage(what, rel), cause ? { cause } : undefined);
  error.code = 'MISSING_CORPUS';
  return error;
}

function readReference(root, rel, what) {
  try {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    if (!source.trim()) throw missingReference(what, rel);
    return source;
  } catch (error) {
    if (error?.code === 'MISSING_CORPUS') throw error;
    if (['EACCES', 'EISDIR', 'ELOOP', 'ENOENT'].includes(error?.code)) {
      throw missingReference(what, rel, error);
    }
    throw error;
  }
}

function registryDataFromSource(source, rel, what) {
  const entries = scanTopLevelArticleRecords(source);
  if (entries.length === 0) throw missingReference(what, rel);
  const entryIds = entries.map(({ id }) => id);
  return {
    count: entries.length,
    ids: new Set(entryIds),
    entryIds,
  };
}

function readRegistryData(root, section) {
  const rel = sourceOf(section).registryFile;
  const source = readReference(root, rel, `${section} registry`);
  if (isEmptyFamilySection(root, section)) {
    return { count: 0, ids: new Set(), entryIds: [], rel };
  }
  return { ...registryDataFromSource(source, rel, `${section} registry`), rel };
}

function readSlugMap(root, section) {
  const { slugFile: rel, slugExport: slugConst } = sourceOf(section);
  const source = readReference(root, rel, `${section} slug map`);
  if (isEmptyFamilySection(root, section)) return {};
  const slugs = parseArticleUrlSlugs(source, slugConst);
  if (Object.keys(slugs).length === 0) throw missingReference(`${section} slug map`, rel);
  return slugs;
}

function readCanonicalOverrideSlugs(root, section) {
  const rel = sourceOf(section).canonicalOverrides;
  // Una sezione senza file di override (le cantonali) non ombreggia niente.
  if (!rel) return new Set();
  let parsed;
  try {
    parsed = JSON.parse(readReference(root, rel, `${section} canonical overrides`));
  } catch (error) {
    if (error?.code === 'MISSING_CORPUS') throw error;
    throw new Error(`${rel}: canonical overrides non sono JSON leggibile`, { cause: error });
  }
  return new Set(Object.keys(parsed?.overrides ?? {}));
}

function readGit(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

function missingHistoryError(message) {
  const error = new Error(`storia del corpus non verificabile: ${message}`);
  error.code = 'MISSING_CORPUS_HISTORY';
  return error;
}

const ZERO_REVISION_RE = /^0+$/;

function normalizeConfiguredRevision(value) {
  const revision = String(value ?? '').trim();
  if (!revision || ZERO_REVISION_RE.test(revision)) return null;
  return revision;
}

/**
 * Sceglie la base storica in base all'evento che sta eseguendo il gate.
 *
 * Un push puo' contenere piu' commit: `HEAD^` sarebbe allora solo il commit
 * intermedio piu' recente, non lo stato pubblicato prima del push. Le PR
 * usano invece la base dichiarata dall'evento. `undefined` e' riservato a
 * workflow_dispatch e uso locale, dove il fallback a `HEAD^` resta esplicito;
 * `null` significa che un evento push/PR ha dichiarato una base assente e deve
 * quindi restare fail-closed.
 */
export function historyRevisionFromEnv(env = process.env) {
  const event = String(env.PREFLIGHT_EVENT_NAME ?? env.GITHUB_EVENT_NAME ?? '').trim();
  if (event === 'push') {
    return normalizeConfiguredRevision(
      env.PREFLIGHT_PUSH_BASE_REVISION ?? env.PREFLIGHT_BASE_REVISION ?? env.GITHUB_EVENT_BEFORE,
    );
  }
  if (event === 'pull_request') {
    return normalizeConfiguredRevision(
      env.PREFLIGHT_PR_BASE_REVISION ?? env.PREFLIGHT_BASE_REVISION ?? env.GITHUB_BASE_SHA,
    );
  }
  if (Object.prototype.hasOwnProperty.call(env, 'PREFLIGHT_BASE_REVISION')) {
    return normalizeConfiguredRevision(env.PREFLIGHT_BASE_REVISION);
  }
  return undefined;
}

function previousCorpusRevision(root, configuredRevision = historyRevisionFromEnv()) {
  if (readGit(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw missingHistoryError('la radice non e\' un checkout Git');
  }
  if (readGit(root, ['rev-parse', '--is-shallow-repository']) === 'true') {
    throw missingHistoryError(
      'il checkout Git e\' shallow, quindi il high-water precedente non e\' disponibile',
    );
  }
  if (configuredRevision !== undefined) {
    const configured = normalizeConfiguredRevision(configuredRevision);
    if (configured === null) {
      throw missingHistoryError('la revisione base dell\'evento non e\' disponibile');
    }
    const revision = readGit(root, ['rev-parse', '--verify', `${configured}^{commit}`]);
    if (!revision) {
      throw missingHistoryError(
        `la revisione base ${configured} non e\' disponibile nel checkout`,
      );
    }
    return revision;
  }
  const revision = readGit(root, ['rev-parse', 'HEAD^']);
  if (!revision) {
    throw missingHistoryError('la revisione Git precedente non e\' disponibile');
  }
  return revision;
}

function previousRegistryData(root, section, revision) {
  const rel = sourceOf(section).registryFile;
  // Presenza dal TREE, lettura dal BLOB, come `readGitFileAtRevision` di
  // `scripts/ci/verify-api-floors.mjs`. Il checkout di `tests.yml` e' un
  // partial clone (`filter: blob:none`): il blob storico arriva su richiesta,
  // e un fetch fallito fa uscire `git show` != 0 esattamente come un path
  // assente. Trattarli allo stesso modo azzererebbe l'high-water in silenzio,
  // cioe' spegnerebbe il rifiuto del registro troncato. Solo l'assenza
  // provata dal tree (che il partial clone ha sempre) vale "nessuna storia".
  let listing;
  try {
    listing = execFileSync('git', ['-C', root, 'ls-tree', '--name-only', revision, '--', rel], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    throw missingHistoryError(`impossibile elencare ${rel} alla revisione ${revision}`);
  }
  if (!listing.split('\n').some((entry) => entry === rel)) return null;
  let source;
  try {
    source = execFileSync('git', ['-C', root, 'show', `${revision}:${rel}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw missingHistoryError(`impossibile leggere ${rel} alla revisione ${revision}`);
  }
  if (!source.trim()) return null;
  return registryDataFromSource(source, rel, `${section} registry storico`);
}

function registryHighWater(
  root,
  section,
  current,
  { previousRegistryCount, previousRevision } = {},
) {
  if (previousRegistryCount !== undefined) {
    if (!Number.isSafeInteger(previousRegistryCount) || previousRegistryCount < 0) {
      const error = new Error(
        `${section}: previousRegistryCount non valido (${previousRegistryCount}); ` +
          'la storia iniettata deve essere un intero non negativo',
      );
      error.code = 'INVALID_CORPUS_HISTORY';
      throw error;
    }
    return Math.max(current.count, previousRegistryCount);
  }
  const revision = previousCorpusRevision(root, previousRevision);
  const previous = previousRegistryData(root, section, revision);
  return Math.max(current.count, previous?.count ?? 0);
}

function truncatedRegistryError(section, current, highWater) {
  const floor = floorFrom(highWater);
  const error = new Error(
    `${current.rel}: ${current.count} entry contro ${highWater} nella revisione Git precedente ` +
      `(pavimento ${floor}) — registro troncato, rifiuto il floor derivato dal solo registro corrente`,
  );
  error.code = 'TRUNCATED_CORPUS';
  return error;
}

/** Quanti file-meta locali sono presenti per la sezione. */
export function countPresentLocales(root, section) {
  const prefix = `${path.basename(sourceOf(section).metaPrefix)}-`;
  const rel = path.join('content', `${prefix}*.ts`);
  let names;
  try {
    names = fs.readdirSync(path.join(root, 'content'));
  } catch (error) {
    if (['EACCES', 'ELOOP', 'ENOENT'].includes(error?.code)) {
      throw missingReference(`${section} locale metadata`, rel, error);
    }
    throw error;
  }
  const missing = SECTION_META_LOCALES
    .map((locale) => `${prefix}${locale}.ts`)
    .filter((name) => !names.includes(name));
  if (missing.length) {
    throw missingReference(
      `${section} locale metadata (${missing.join(', ')})`,
      rel,
    );
  }
  return SECTION_META_LOCALES.length;
}

function metadataArticleIds(source) {
  return new Set([...source.matchAll(META_TITLE_KEY_RE)].map((match) => match[1]));
}

/** Ogni locale deve esporre tutti gli ID del registro, non solo un file. */
export function validateLocaleMetadata(root, section, registryIds) {
  const prefix = `${path.basename(sourceOf(section).metaPrefix)}-`;
  for (const locale of SECTION_META_LOCALES) {
    const rel = path.join('content', `${prefix}${locale}.ts`);
    const ids = metadataArticleIds(readReference(root, rel, `${section} locale metadata`));
    const missing = [...registryIds].filter((id) => !ids.has(id));
    if (missing.length) {
      const error = new Error(
        `${rel}: meta incompleta — ${ids.size} ID title, ${registryIds.size} richiesti; ` +
          `mancano ${missing.length}: ${missing.slice(0, 5).join(', ')}`,
      );
      error.code = 'INCOMPLETE_CORPUS';
      throw error;
    }
  }
}

/**
 * Atteso dei corpi: entry del registro × locali-meta presenti.
 *
 * Il riferimento non e' la directory che il gate deve scandire: e' la coppia
 * di registri e metadati che il sito usa per pubblicare gli articoli. Se uno
 * dei due riferimenti manca, o se la storia necessaria al high-water non e'
 * leggibile, lancia invece di trasformare l'assenza in un pavimento a zero.
 * I fake root possono fornire `previousRegistryCount` solo quando la storia
 * e' stata verificata dal test che li costruisce. `previousRevision` e' la
 * revisione base esplicita del push/PR; senza questa opzione la selezione
 * dell'evento usa l'ambiente e solo l'uso locale/dispatch ricade su `HEAD^`.
 */
export function expectedBodyFiles(
  root,
  section,
  { previousRegistryCount, previousRevision } = {},
) {
  if (isNewFamilySection(root, section) || isEmptyFamilySection(root, section)) return 0;
  const registry = readRegistryData(root, section);
  const highWater = registryHighWater(root, section, registry, {
    previousRegistryCount,
    previousRevision,
  });
  if (registry.count < floorFrom(highWater)) {
    throw truncatedRegistryError(section, registry, highWater);
  }
  const locales = countPresentLocales(root, section);
  validateLocaleMetadata(root, section, registry.ids);
  return highWater * locales;
}

/** Quante entry articolo dichiara il registro sorgente della sezione. */
export function countRegistryArticles(root, section) {
  return readRegistryData(root, section).count;
}

/**
 * Gli id articolo del registro sorgente di una sezione, nell'ordine del file.
 * Una sezione di famiglia senza la coppia registry/slugs, o con la coppia
 * esplicitamente vuota, e' una sezione nuova: nessun id. Ogni coppia parziale
 * resta un rifiuto fail-closed.
 */
export function sourceRegistryIds(root, section) {
  if (isNewFamilySection(root, section) || isEmptyFamilySection(root, section)) return [];
  return readRegistryData(root, section).entryIds;
}

/** Quanti articoli sorgente ha la sezione, contati sui file di corpo. */
export function countSourceArticles(root, section) {
  assertFamilySourcePair(root, section);
  const rel = path.join(sourceOf(section).bodyDir, 'it');
  return countCorpusFiles(root, rel, '.ts', section);
}

/**
 * Quante entry IT promette il corpus alla sitemap.
 *
 * Il denominatore parte dal registro, non dal predicato del writer: un nuovo
 * filtro o una mappa slug troncata deve far scattare il floor, non abbassarlo
 * insieme all'artefatto. Si sottraggono solo le esclusioni già dichiarate nei
 * dati di canonical override o nella retention delle daily edition, mappate
 * esplicitamente allo slug IT di una entry del registro.
 */
export function countSourceSitemapEntries(root, section) {
  if (isNewFamilySection(root, section) || isEmptyFamilySection(root, section)) return 0;
  const registry = readRegistryData(root, section);
  const slugMap = readSlugMap(root, section);
  const shadowed = readCanonicalOverrideSlugs(root, section);

  if (sourceOf(section).retiredDailyEditions) {
    for (const id of selectRetiredDailyEditions([...registry.ids])) {
      const slug = slugMap[id]?.it;
      if (slug) shadowed.add(slug);
    }
  }

  return registry.entryIds.filter((id) => !shadowed.has(slugMap[id]?.it)).length;
}

/**
 * Cardinalità attesa dell'archive sitemap, derivata dai due input che il
 * writer TS unisce: meta title-keys IT e chiavi della slug map. Il conteggio
 * resta indipendente dal documento XML scritto, così la verifica può
 * distinguere un corpus corto da una serializzazione corta.
 */
export function countSourceArchiveSitemapUrls(root, section) {
  const metaRel = sourceOf(section).metaFile('it');
  const metaIds = metadataArticleIds(readReference(root, metaRel, `${section} Italian metadata`));
  const slugMap = readSlugMap(root, section);
  const unionSize = new Set([...metaIds, ...Object.keys(slugMap)]).size;
  const pages = Math.max(1, Math.ceil(unionSize / ARTICLES_PAGE_SIZE));
  return pages * SECTION_META_LOCALES.length;
}

/** Quante immagini hero ci sono in sorgente. */
export function countSourceImages(root) {
  return IMAGE_SOURCE_DIRS.reduce(
    (total, rel) => total + countCorpusFiles(root, rel, '.webp', 'images-manifest.json'),
    0,
  );
}

/**
 * Il pavimento di una sezione, derivato dal corpus su disco.
 *
 * LANCIA se il corpus sorgente della sezione e' assente o vuoto, invece di
 * restituire 0: con `sectionFloor` a 0 il confronto `entries.length < 0` e'
 * sempre falso e chi lo usa pubblica un indice VUOTO sopra quello live, che e'
 * peggio della costante che questo modulo sostituisce (`MIN_ENTRIES = 50`
 * quel caso lo rifiutava incondizionatamente). Le due sorgenti — registro e
 * corpi — stanno entrambe sotto `content/`, quindi si azzerano INSIEME: e'
 * esattamente il caso in cui il pavimento serve.
 *
 * Eccezione per costruzione, non per tolleranza: una sezione con politica
 * `family` (le cantonali) parte legittimamente da zero articoli, quindi il suo
 * pavimento proprio vale 0 e il troncamento si giudica sulla famiglia
 * (`familyFloorVerdict`). Il «corpus non materializzato» resta rifiutato dalle
 * sezioni storiche, che vivono sotto lo stesso `content/`; i loro pavimenti
 * non cambiano.
 */
export function sectionFloor(root, section, retention = FLOOR_RETENTION) {
  const source = countSourceArticles(root, section);
  if (source === 0) {
    if (floorPolicyOf(section) === 'family') return 0;
    throw new Error(missingCorpusMessage(section, path.join(root, sourceOf(section).bodyDir, 'it')));
  }
  return floorFrom(source, retention);
}

/**
 * Il pavimento di un elenco derivato dal registro, come una sitemap articolo.
 *
 * Il registro è il riferimento corretto per il contenuto che la sitemap prova
 * a elencare; le voci `shadowed` sono escluse legittimamente perché puntano a
 * un canonical diverso. Il risultato resta relativo al numero corrente, così
 * non ricrea il vecchio pavimento assoluto che si è svuotato mentre il corpus
 * cresceva.
 *
 * Un registro assente o vuoto non vale come pavimento a zero: è l'assenza del
 * riferimento e va rifiutata dal writer.
 */
export function listedFloor(registryCount, shadowed = 0, retention = FLOOR_RETENTION) {
  if (!Number.isFinite(registryCount) || registryCount <= 0) {
    throw new Error(missingCorpusMessage('un elenco derivato dal registro', 'il registro degli articoli'));
  }
  const expected = Math.max(0, registryCount - Math.max(0, shadowed));
  return floorFrom(expected, retention);
}

/**
 * Dove vivono i chunk SEO in QUESTO repo. Il layout del sito e'
 * `services/seo`; `build-api.mjs` passa `seoDir: 'content/seo'` a
 * `buildAllRssFeeds`, ed e' quello il parametro che vale qui.
 */
export const SEO_CHUNK_DIR = path.join('content', 'seo');

/**
 * I metadati completi delle voci di un chunk SEO, aggiunti a `into`.
 *
 * PERCHE' UN CONTEGGIO A PARTE dai file di corpo. Gli `<item>` di un feed non
 * nascono dai corpi: `buildSectionFeeds` li costruisce da `parseSeoBlogs` sui
 * chunk elencati in `RSS_SECTIONS[].seoFiles`. Sono due popolazioni scollegate,
 * e la divergenza e' misurabile oggi (frontaliere: 4728 voci nei chunk contro
 * 3792 corpi). Un pavimento tarato sui corpi non e' «un po' impreciso»: nella
 * direzione peggiore non segnala un feed vecchio e BLOCCA la pubblicazione per
 * un feed legittimamente corto — e la lista dei chunk si e' gia' rivelata
 * capace di muoversi da sola (due su sette letti, feed fermo tre mesi).
 *
 * Il collector resta completo per i consumer che usano anche il testo SEO
 * opzionale, come la whitelist della sitemap news in `build-api.mjs`. Il
 * collector filtrato per RSS qui sotto ricalca invece `parseSeoBlogs`: la
 * scansione lessicale condivisa riconosce solo chiavi reali, gli stessi campi
 * obbligatori e il confine bilanciato della singola voce.
 *
 * Restano un parse in piu' — l'engine non esporta il suo — ma la LISTA dei
 * chunk no: quella si importa da `RSS_SECTIONS` (AGENTS.md #6), ed e' la parte
 * che e' gia' andata alla deriva una volta.
 */
/**
 * Decode the quoted value used by the TypeScript SEO literals.
 *
 * The source string is read before TypeScript evaluates it, so an escaped
 * quote and an escaped backslash must be decoded in the same order as the
 * producer. The placeholder keeps a literal pair of backslashes from being
 * mistaken for the beginning of another escape.
 */
export function unescapeQuoted(value, quote = "'") {
  if (value === undefined) return undefined;
  return String(value)
    .split('\\\\').join('\u0000')
    .split(`\\${quote}`).join(quote)
    .split('\\n').join('\n')
    .split('\u0000').join('\\');
}

function collectSeoEntryMetadataInternal(src, into, feedOnly) {
  const positions = findAllSeoEntryMatches(src).map(({ id, index, closeIdx }) => ({
    id,
    start: index,
    end: closeIdx + 1,
  }));

  for (let i = 0; i < positions.length; i += 1) {
    const { id, start, end } = positions[i];
    const block = src.slice(start, end);
    const keywordMatch = block.match(/keywords:\s*'((?:[^'\\]|\\.)*)'/);
    const metadata = {
      keywords: unescapeQuoted(keywordMatch?.[1]),
      headline: block.match(/"headline":\s*"((?:[^"\\]|\\.)*)"/)?.[1],
      datePublished: block.match(/"datePublished":\s*"([^"]+)"/)?.[1],
    };
    // Solo il percorso RSS applica la validita' del producer prima del dedupe;
    // il collector completo deve conservare anche i campi opzionali per la
    // sitemap news.
    if (feedOnly && (!metadata.headline || !metadata.datePublished)) continue;
    into.set(id, metadata);
  }
  return into;
}

export function collectSeoEntryMetadata(src, into = new Map()) {
  return collectSeoEntryMetadataInternal(src, into, false);
}

/** Metadati delle sole voci che `parseSeoBlogs` puo' emettere come `<item>`. */
export function collectSeoFeedEntryMetadata(src, into = new Map()) {
  return collectSeoEntryMetadataInternal(src, into, true);
}

export function collectSeoEntryIds(src, into = new Set()) {
  for (const id of collectSeoFeedEntryMetadata(src).keys()) {
    into.add(id);
  }
  return into;
}

/**
 * Quante voci datate tengono i chunk SEO di una sezione: la popolazione che
 * GENERA i suoi feed, e quindi il riferimento del loro pavimento.
 *
 * Un chunk assente viene saltato come lo salta `parseSeoBlogs` (`if
 * (!fs.existsSync(filePath)) continue`) — la lista e' condivisa col sito, che
 * puo' tenere chunk non mirrorati qui. Se pero' il totale della sezione e'
 * zero, quello NON e' un pavimento a zero: e' l'assenza del riferimento, e il
 * chiamante deve trattarlo come errore (vedi `missingCorpusMessage`).
 */
export function countSeoEntries(root, seoFiles, seoDir = SEO_CHUNK_DIR) {
  const ids = new Set();
  for (const file of seoFiles) {
    const filePath = path.join(root, seoDir, file);
    if (!fs.existsSync(filePath)) continue;
    collectSeoEntryIds(fs.readFileSync(filePath, 'utf-8'), ids);
  }
  return ids.size;
}

/**
 * Ultima pubblicazione valida nei chunk SEO che alimentano una sezione.
 *
 * Il valore viene misurato sugli stessi blocchi e con gli stessi campi che
 * `collectSeoEntryIds` consegna al produttore dei feed: il pavimento e la
 * guardia di freschezza non devono usare due popolazioni diverse. Qui la lista
 * dichiarata e' un riferimento canonico: se manca anche un solo chunk, il
 * corpus e' incompleto e la funzione fallisce prima che il gate possa derivare
 * un floor piu' basso. Eventuali eccezioni cross-repo vanno risolte dal
 * chiamante prima di passare la lista al producer.
 */
export function latestSeoPublication(root, seoFiles, seoDir = SEO_CHUNK_DIR) {
  const missing = seoFiles.filter((file) => !fs.existsSync(path.join(root, seoDir, file)));
  if (missing.length) {
    const error = new Error(
      missing
        .map((file) => missingCorpusMessage('la freschezza dei feed', path.join(root, seoDir, file)))
        .join('\n'),
    );
    error.code = 'MISSING_CORPUS';
    throw error;
  }

  // `parseSeoBlogs` usa una sola Map attraversando i chunk nell'ordine della
  // sezione: un id ripetuto viene quindi sostituito dall'ultima voce valida.
  // Replicare quella semantica prima di cercare il massimo evita che una data
  // rimasta in un chunk precedente descriva un articolo che il producer ha
  // gia' sovrascritto.
  const entries = new Map();
  for (const file of seoFiles) {
    const filePath = path.join(root, seoDir, file);
    for (const [articleId, metadata] of collectSeoFeedEntryMetadata(fs.readFileSync(filePath, 'utf-8'))) {
      // Il collector RSS filtra prima del Map.set: una voce non emettibile non
      // sostituisce quella valida precedente.
      entries.set(articleId, metadata);
    }
  }

  let latest = null;
  for (const [articleId, metadata] of entries) {
    const timestamp = Date.parse(metadata.datePublished);
    if (!Number.isFinite(timestamp)) continue;
    if (!latest || timestamp > latest.timestamp) {
      latest = { articleId, datePublished: metadata.datePublished, timestamp };
    }
  }
  return latest;
}

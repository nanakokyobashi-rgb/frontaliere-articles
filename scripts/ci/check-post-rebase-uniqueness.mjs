#!/usr/bin/env node
/**
 * check-post-rebase-uniqueness.mjs — dopo il rebase e PRIMA del push, ricontrolla
 * che l'articolo appena generato resti unico nel corpus su cui sta per atterrare
 * per id, fonte e contenuto.
 *
 * Uso (dalla radice del repo, a rebase concluso):
 *   node scripts/ci/check-post-rebase-uniqueness.mjs --produced <sha> [--against <rev>]
 *
 *   --produced  il commit prodotto da QUESTO run, preso PRIMA di ogni rebase;
 *               cio' che il run ha aggiunto e' il diff `<sha>^ → <sha>`.
 *   --against   lo stato su cui si sta per pushare (default `HEAD`, cioe' il
 *               commit rigiocato sopra upstream).
 *
 * Exit 0 = nessuna violazione. Exit 1 = violazione: NON pushare; ogni riga porta
 *          `POST_REBASE_UNIQUENESS_VIOLATION` per il grep della run.
 *          Exit 2 = il controllo non e' eseguibile (`POST_REBASE_UNIQUENESS_ERROR`):
 *          una garanzia che non si sa verificare non si da' per verificata.
 *
 * ── Perche' dopo il rebase (D18, rischio (e).2 di architecture.md) ──────────
 *
 * Il generatore garantisce due invarianti leggendo il working tree A INIZIO run:
 *
 *   1. un id e' unico in TUTTE le sezioni (`getAllArticleIds` in
 *      create-article.mjs): i namespace `blog-{id}` e `blog.article.{id}.*` sono
 *      condivisi, un id ripetuto in due sezioni sovrascrive canonical e dati
 *      strutturati della pagina sorella;
 *   2. una fonte produce un articolo in UNA sezione sola
 *      (`loadAllSectionSourceUrls` + `findCrossSectionSourceDuplicate`, #251):
 *      vince chi la registra per prima.
 *   3. il titolo e l'excerpt del nuovo articolo non duplicano un articolo che
 *      un altro writer ha pubblicato nel frattempo. Qui viene richiamato il
 *      detector multi-segnale di `create-article.mjs`, non una copia delle sue
 *      soglie.
 *
 * Tutte reggono solo in modo seriale. Con piu' scrittori paralleli (le
 * sezioni cantonali, una concurrency per sezione) due run partono dalla stessa
 * base, e il rebase li fonde senza sapere niente di ne' l'uno ne' l'altro:
 * `--merge-registry` unisce due record con lo stesso id se stanno in registri
 * DIVERSI, e il ledger URL→id e' bookkeeping (si prende upstream), quindi la
 * voce di questo run puo' sparire proprio mentre la stessa URL e' appena stata
 * registrata dall'altra sezione. Questo script rifa' le due domande sullo
 * stato post-rebase.
 *
 * ── Cosa considera «nuovo» ─────────────────────────────────────────────────
 *
 * Il diff del commit prodotto contro il SUO genitore, non contro upstream:
 * dopo il rebase la voce del ledger di questo run puo' non esserci piu' (presa
 * la copia upstream), e un diff contro HEAD non la vedrebbe. Ed e' solo cio'
 * che questo run ha aggiunto a essere controllato: i 5 duplicati cross-sezione
 * storici (`cross-section-duplicate-ratchet.test.mjs`) non fanno scattare
 * niente.
 *
 * Fuori da questo controllo, per costruzione: lo stesso id rigenerato nella
 * STESSA sezione (#281) e' risolto dal merge dei registri a favore del commit
 * rigiocato, e resta un record solo; il riuso di una fonte nella STESSA sezione
 * ha una finestra di scadenza voluta (`SOURCE_URL_TTL_DAYS`) e gli strati di
 * tema a valle. I contenuti gia' duplicati nella base non vengono riaperti:
 * viene controllato solo cio' che il commit prodotto ha aggiunto.
 *
 * ── Le sezioni vengono dal core ────────────────────────────────────────────
 *
 * Registro e mappa slug di ogni sezione si derivano dalla lista attiva fornita
 * dal bootstrap corpus (+ `corpusPath`), il ledger URL→id da `SECTIONS` di
 * `article-surfaces.mjs`.
 * Nessun elenco scritto qui: una sezione nuova nel core e' controllata da sola,
 * e una sezione nel core senza ledger dichiarato e' un ERRORE, non una sezione
 * saltata in silenzio.
 *
 * Solo builtin Node, come ogni script di `scripts/ci/`.
 */
import '../../host/cantonSectionsBootstrap.mjs';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { activeCorpusCoreEntries } from '../lib/corpus-sections.mjs';
import { corpusPath } from '../../generator/scripts/lib/corpus-paths.mjs';
import { findCrossSectionSourceDuplicate } from '../../generator/scripts/lib/cross-section-dedup.mjs';
import { findContentDuplicate } from '../../generator/scripts/lib/article-content-duplicate.mjs';
import { metaFieldRegex, unescapeTsValue } from '../../generator/scripts/lib/meta-field-regex.mjs';
import { itemIdentityOf, ledgerArticleIds, legacyNewsUrlKey, readLedgerEntry } from '../../generator/scripts/lib/source-url-ledger.mjs';
import { SECTIONS as SECTION_SURFACES } from '../lib/article-surfaces.mjs';

export const VIOLATION_MARKER = 'POST_REBASE_UNIQUENESS_VIOLATION';
export const ERROR_MARKER = 'POST_REBASE_UNIQUENESS_ERROR';
export const OK_MARKER = 'POST_REBASE_UNIQUENESS_OK';

/** Stessa forma di `getAllArticleIds` in create-article.mjs: la chiave della mappa slug. */
const SLUG_ID_RE = /^\s+(['"])([^'"]+)\1:\s*\{\s*it:/gm;
/** Il campo `id:` di un record del registro. */
const REGISTRY_ID_RE = /^\s+id:\s*(['"])([^'"]+)\1/gm;

/** Gli id della mappa slug, uno per riga. */
export function slugIdsOf(src) {
  return [...String(src ?? '').matchAll(SLUG_ID_RE)].map((m) => m[2]);
}

/** Gli id dei record del registro, CON i ripetuti: contarli e' il punto. */
export function registryIdsOf(src) {
  return [...String(src ?? '').matchAll(REGISTRY_ID_RE)].map((m) => m[2]);
}

/**
 * Le superfici da leggere per ogni sezione del core.
 *
 * @param {Array<{section: string, registryFile: string, slugDataFile: string}>} [coreList]
 * @param {Record<string, {metaFiles?: string[], sourceLedger?: string}>} [surfaces]
 * @returns {Array<{section: string, registryFile: string, slugDataFile: string, metaFile: string, sourceLedger: string}>}
 */
export function sectionSurfaces(coreList = activeCorpusCoreEntries(), surfaces = SECTION_SURFACES) {
  if (!Array.isArray(coreList) || coreList.length === 0) {
    throw new Error('il core delle sezioni e\' vuoto: non c\'e\' niente su cui verificare l\'unicita\'');
  }
  return coreList.map((core) => {
    const sourceLedger = surfaces?.[core.section]?.sourceLedger;
    if (typeof sourceLedger !== 'string' || !sourceLedger) {
      throw new Error(
        `la sezione '${core.section}' e' nel core ma non ha un ledger URL→id in article-surfaces.mjs (SECTIONS.${core.section}.sourceLedger): `
        + 'senza, il dedup della fonte fra sezioni non e\' verificabile',
      );
    }
    const metaFile = surfaces?.[core.section]?.metaFiles?.find((file) => file.endsWith('-it.ts'));
    if (typeof metaFile !== 'string' || !metaFile) {
      throw new Error(
        `la sezione '${core.section}' e' nel core ma non ha il meta IT in article-surfaces.mjs (SECTIONS.${core.section}.metaFiles): `
        + 'senza, il dedup del contenuto dopo il rebase non e\' verificabile',
      );
    }
    return {
      section: core.section,
      registryFile: corpusPath(core.registryFile),
      slugDataFile: corpusPath(core.slugDataFile),
      metaFile,
      sourceLedger,
    };
  });
}

function parseLedger(text, label) {
  if (text == null) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: JSON illeggibile (${e.message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label}: non e' una mappa URL→id`);
  }
  return parsed;
}

function parseArticleMeta(text, label) {
  if (text == null) return {};
  const titleMatches = [...text.matchAll(metaFieldRegex('title'))];
  const excerptMatches = [...text.matchAll(metaFieldRegex('excerpt'))];
  const excerpts = new Map(
    excerptMatches.map((match) => [match[1], unescapeTsValue(match[2])]),
  );
  const articles = {};
  for (const match of titleMatches) {
    const id = match[1];
    if (articles[id]) throw new Error(`${label}: id duplicato nel meta IT '${id}'`);
    articles[id] = {
      id,
      title: unescapeTsValue(match[2]),
      excerpt: excerpts.get(id) ?? '',
    };
  }
  return articles;
}

/**
 * Lo stato di tutte le sezioni a una revisione.
 *
 * @param {(path: string) => string|null} readAt lettore del file a quella revisione; null = assente.
 * @returns {Record<string, {slugIds: string[], registryIds: string[], articles: Record<string, {id: string, title: string, excerpt: string}>, ledger: Record<string, unknown>}>}
 */
export function snapshotSections(surfaces, readAt, label) {
  // `null` = il path non c'e' (sezione ancora vuota): legittimo. Un file che
  // c'e' ma e' vuoto non lo e': letto come «nessun id / nessuna voce» toglierebbe
  // quella sezione dal confronto proprio mentre dovrebbe fermare un duplicato.
  const read = (path) => {
    const text = readAt(path);
    if (text != null && text.trim() === '') {
      throw new Error(`${label}:${path} e' presente ma vuoto: non e' una sezione senza articoli, e' una superficie illeggibile`);
    }
    return text;
  };
  const out = {};
  for (const s of surfaces) {
    out[s.section] = {
      slugIds: slugIdsOf(read(s.slugDataFile)),
      registryIds: registryIdsOf(read(s.registryFile)),
      articles: parseArticleMeta(read(s.metaFile), `${label}:${s.metaFile}`),
      ledger: parseLedger(read(s.sourceLedger), `${label}:${s.sourceLedger}`),
    };
  }
  return out;
}

const idsOf = (snap) => new Set([...(snap?.slugIds ?? []), ...(snap?.registryIds ?? [])]);

/**
 * Le violazioni di unicita' introdotte dal commit prodotto, viste sullo stato post-rebase.
 *
 * @param {{producedBase: object, produced: object, against: object}} snapshots
 *        mappe sezione → {slugIds, registryIds, articles, ledger} da `snapshotSections`.
 * @returns {{violations: Array<object>, newIds: Array<{section: string, id: string}>, newSourceUrls: Array<{section: string, url: string, articleId: string}>, contentChecks: number}}
 */
export function findPostRebaseViolations({ producedBase, produced, against }) {
  const sections = Object.keys(produced);
  const violations = [];
  const newIds = [];
  const newSourceUrls = [];
  let contentChecks = 0;
  const againstArticles = sections.flatMap((section) => Object.values(against?.[section]?.articles ?? {}));

  // 1. Unicita' globale degli id.
  for (const section of sections) {
    const before = idsOf(producedBase?.[section]);
    for (const id of idsOf(produced[section])) {
      if (before.has(id)) continue;
      newIds.push({ section, id });

      const elsewhere = sections.filter((other) => other !== section && idsOf(against?.[other]).has(id));
      for (const other of elsewhere) {
        violations.push({ kind: 'duplicate-id-cross-section', section, id, other });
      }

      const occurrences = sections.reduce(
        (n, s) => n + (against?.[s]?.registryIds ?? []).filter((x) => x === id).length,
        0,
      );
      if (occurrences > 1) {
        violations.push({ kind: 'duplicate-id-registry', section, id, occurrences });
      }

      // The regular generator check ran against the checkout from the start
      // of the run. After a rebase, rerun its same multi-signal detector on
      // the article metadata in the tree that is about to be pushed. This is
      // the race that an ID/source-only check cannot see: two different ids
      // can carry the same news story.
      if (Object.prototype.hasOwnProperty.call(produced[section], 'articles')) {
        const candidate = produced[section].articles?.[id];
        if (!candidate || !candidate.title) {
          violations.push({ kind: 'article-meta-missing', section, id });
        } else {
          contentChecks += 1;
          const duplicate = findContentDuplicate({ id, content: { it: candidate } }, againstArticles);
          if (duplicate) {
            violations.push({
              kind: 'duplicate-content',
              section,
              id,
              otherId: duplicate.existing.id,
              signals: duplicate.signals.join('|'),
            });
          }
        }
      }
    }
  }

  // 2. Una fonte = una sezione (#251). Le viste sono PERMANENTI per tutte le
  //    sorelle, come in `isSourceUrlAlreadyUsed`: il ramo cross-sezione non
  //    scade mai.
  for (const section of sections) {
    const before = producedBase?.[section]?.ledger ?? {};
    const others = {};
    const othersLegacy = {};
    for (const other of sections) {
      if (other === section) continue;
      const ledger = against?.[other]?.ledger ?? {};
      others[other] = ledgerArticleIds(ledger);
      othersLegacy[other] = ledgerArticleIds(ledger, { keyForm: 1 });
    }

    for (const [url, value] of Object.entries(produced[section].ledger ?? {})) {
      const entry = readLedgerEntry(value);
      if (!entry) continue;
      const prev = Object.prototype.hasOwnProperty.call(before, url) ? readLedgerEntry(before[url]) : null;
      if (prev && prev.articleId === entry.articleId) continue;
      newSourceUrls.push({ section, url, articleId: entry.articleId });

      let hit = findCrossSectionSourceDuplicate(url, others, section);
      // Il ponte verso le voci di forma 1 (path nudo), come in create-article
      // — e come li' NON per una chiave che porta l'identita' di un item
      // (`#ft-item=…`): il suo path nudo e' un contenitore che la fonte riusa
      // per notizie diverse, e una voce storica su quel path non e' questa
      // notizia. Il ponte la segnalerebbe come duplicato cross-sezione e
      // fermerebbe il push dopo il rebase.
      const legacyKey = legacyNewsUrlKey(url);
      if (!hit.used && legacyKey !== url && itemIdentityOf(url) === null) hit = findCrossSectionSourceDuplicate(legacyKey, othersLegacy, section);
      if (hit.used) {
        violations.push({
          kind: 'source-url-cross-section',
          section,
          id: entry.articleId,
          url,
          other: hit.section,
          otherId: hit.articleId,
        });
      }
    }
  }

  return { violations, newIds, newSourceUrls, contentChecks };
}

export function formatViolation(v) {
  const parts = [`kind=${v.kind}`, `section=${v.section}`, `id=${v.id}`];
  if (v.other) parts.push(`other=${v.other}`);
  if (v.otherId) parts.push(`otherId=${v.otherId}`);
  if (v.occurrences) parts.push(`occurrences=${v.occurrences}`);
  if (v.url) parts.push(`url=${v.url}`);
  if (v.signals) parts.push(`signals=${v.signals.replace(/\s+/g, '_')}`);
  return `${VIOLATION_MARKER} ${parts.join(' ')}`;
}

/**
 * Il lettore di un file a una revisione. `null` SOLO se il path non c'e' in
 * quell'albero (una sezione ancora vuota, un ledger mai scritto): lo dice
 * `git ls-tree`, non un `git show` fallito. Un path che c'e' ma non si legge
 * (blob mancante in un clone parziale, oggetto corrotto, buffer superato) e'
 * un ERRORE: trattarlo da «assente» lascerebbe quella sezione fuori dal
 * confronto e farebbe uscire 0 proprio sul duplicato da fermare.
 */
export function gitReader(cwd, rev) {
  const run = (args) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const why = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0];
  return (path) => {
    let listed;
    try {
      listed = run(['ls-tree', '--name-only', rev, '--', path]).trim();
    } catch (e) {
      throw new Error(`git ls-tree ${rev} -- ${path} fallito: ${why(e)}`);
    }
    if (!listed) return null;
    try {
      return run(['show', `${rev}:${path}`]);
    } catch (e) {
      throw new Error(`${rev.slice(0, 12)}:${path} esiste ma non si legge: ${why(e)}`);
    }
  };
}

function resolveRev(cwd, rev) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = { produced: null, against: 'HEAD' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--produced') out.produced = argv[++i] ?? null;
    else if (a === '--against') out.against = argv[++i] ?? null;
    else throw new Error(`argomento sconosciuto: ${a}`);
  }
  if (!out.produced) throw new Error('manca --produced <sha>');
  if (!out.against) throw new Error('--against vuoto');
  return out;
}

export function main(argv, { cwd = process.cwd(), log = console.log, error = console.error } = {}) {
  try {
    const args = parseArgs(argv);
    const produced = resolveRev(cwd, args.produced);
    if (!produced) throw new Error(`--produced '${args.produced}' non e' un commit`);
    const against = resolveRev(cwd, args.against);
    if (!against) throw new Error(`--against '${args.against}' non e' un commit`);
    // Senza genitore (radice) niente esisteva prima: tutto e' «nuovo».
    const producedBase = resolveRev(cwd, `${produced}^1`);

    const surfaces = sectionSurfaces();
    const emptyReader = () => null;
    const snapshots = {
      producedBase: snapshotSections(surfaces, producedBase ? gitReader(cwd, producedBase) : emptyReader, 'base'),
      produced: snapshotSections(surfaces, gitReader(cwd, produced), 'produced'),
      against: snapshotSections(surfaces, gitReader(cwd, against), 'against'),
    };
    const { violations, newIds, newSourceUrls, contentChecks } = findPostRebaseViolations(snapshots);

    if (violations.length) {
      for (const v of violations) error(`::error::${formatViolation(v)}`);
      error(
        `::error::${VIOLATION_MARKER}: ${violations.length} violazione/i di unicita' dopo il rebase su ${against.slice(0, 12)} — `
        + 'il commit NON va pushato: un altro scrittore ha appena registrato lo stesso id, la stessa fonte o un contenuto duplicato.',
      );
      return 1;
    }
    log(
      `${OK_MARKER} sections=${surfaces.map((s) => s.section).join(',')} `
      + `new_ids=${newIds.map((n) => `${n.section}/${n.id}`).join(',') || '-'} `
      + `new_source_urls=${newSourceUrls.length} content_checks=${contentChecks} against=${against.slice(0, 12)}`,
    );
    return 0;
  } catch (e) {
    error(`::error::${ERROR_MARKER}: ${e.message}`);
    return 2;
  }
}

const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // Set the exit code after the logger has queued its marker. `process.exit()`
  // can truncate stdout/stderr when this CI script is launched through a
  // pipe, which would make a real violation invisible to the caller.
  process.exitCode = main(process.argv.slice(2));
}

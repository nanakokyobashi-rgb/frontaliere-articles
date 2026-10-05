/**
 * adapted-drift.mjs — quali gemelli `adapted` sono in drift, e il ratchet che
 * impedisce al loro numero di crescere (issue #339).
 *
 * ## Il debito che misura
 *
 * Al 2026-10-05, 77 dei 100 gemelli `adapted` del manifest sono in drift
 * (`site-ahead` o `both-moved`): il sito ha cambiato il file dopo la baseline e
 * qui nessuno ha portato la modifica. `transport-identical-twins.mjs` copia solo
 * gli `identical`; `realign-adapted-baseline.mjs` (FU-07) riattesta solo cio'
 * che una PR dichiara. Il pregresso non ha un trasporto: il proprietario ha
 * deciso (2026-10-05) di portare in automatico soltanto i merge a 3 vie puliti
 * e di tenere gli altri in un registro (`adapted-drift-register.mjs`).
 *
 * ## Il ratchet e' un ELENCO, non un numero
 *
 * `scripts/ci/adapted-drift-ratchet.json` registra i path in drift accettati
 * come debito. Il gate fallisce se compare un path in drift che NON e'
 * nell'elenco: e' il caso in cui il numero cresce, e l'elenco dice anche QUALE
 * file e' il nuovo (stessa scelta di `cross-section-duplicate-ratchet.test.mjs`).
 * L'elenco si accorcia soltanto:
 *   - il job `realign-adapted` toglie i path che ha riattestato
 *     (`pruneRatchetPaths`), cosi' una PR che riconcilia un file abbassa la
 *     soglia nel momento in cui la baseline si muove davvero, non prima;
 *   - `adapted-drift-register.mjs --write-ratchet` pota i path non piu' in drift;
 *   - in PR, `ratchetShrinkVerdict` rifiuta un elenco che AGGIUNGE path rispetto
 *     alla base: un drift nuovo si riconcilia, non si dichiara accettato.
 *
 * Puro: niente rete, niente git. L'I/O e' nei due script che lo usano.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Path del file di ratchet, relativo alla radice del repo. */
export const ADAPTED_DRIFT_RATCHET_PATH = 'scripts/ci/adapted-drift-ratchet.json';

/** Gli stati che contano come drift: il sito si e' mosso e qui non e' arrivato. */
export const ADAPTED_DRIFT_STATES = Object.freeze(['site-ahead', 'both-moved']);

/**
 * Lo stato a tre vie di un gemello dagli hash (sha256[:16]) dei due lati e
 * dalla baseline. Stessa regola di `classify()` in `loop-drift-check.mjs` per
 * il ramo dei confronti, ridotta a cio' che il ratchet deve sapere.
 * @param {{site: string|null, corpus: string|null, baseline: {site?: string|null, corpus?: string|null}|null}} a
 * @returns {'site-missing'|'missing-here'|'unknown'|'stable'|'site-ahead'|'corpus-ahead'|'both-moved'|'both-moved-converged'}
 */
export function adaptedTwinState({ site, corpus, baseline }) {
  if (!baseline || !baseline.site || !baseline.corpus) return 'unknown';
  if (!site) return 'site-missing';
  if (!corpus) return 'missing-here';
  const siteMoved = site !== baseline.site;
  const corpusMoved = corpus !== baseline.corpus;
  if (!siteMoved && !corpusMoved) return 'stable';
  if (siteMoved && !corpusMoved) return 'site-ahead';
  if (!siteMoved && corpusMoved) return 'corpus-ahead';
  return site === corpus ? 'both-moved-converged' : 'both-moved';
}

export function isAdaptedDrift(state) {
  return ADAPTED_DRIFT_STATES.includes(state);
}

/**
 * I gemelli `adapted` in drift letti dal report JSON di `loop-drift-check.mjs`
 * (`LOOP_DRIFT_REPORT_JSON` o `--json`). Lo stato e' ricalcolato dagli
 * `hashes` della riga, non letto da `state`: una riga `section-drift`,
 * `ghost-baseline` o `provenance-rate-limited` nasconde il verdetto sul file
 * intero, gli hash no.
 * @param {{results?: Array<{path: string, mode?: string, hashes?: object}>}} report
 * @returns {{drift: string[], unknown: string[], adapted: number}}
 */
export function driftFromReport(report) {
  const drift = new Set();
  const unknown = new Set();
  let adapted = 0;
  for (const row of Array.isArray(report?.results) ? report.results : []) {
    if (!row || row.mode !== 'adapted' || typeof row.path !== 'string') continue;
    adapted += 1;
    const h = row.hashes || {};
    const state = adaptedTwinState({ site: h.site ?? null, corpus: h.corpus ?? null, baseline: h.baseline ?? null });
    if (state === 'unknown') unknown.add(row.path);
    else if (isAdaptedDrift(state)) drift.add(row.path);
  }
  return { drift: [...drift].sort(), unknown: [...unknown].sort(), adapted };
}

/**
 * Il verdetto del ratchet.
 *   - `fresh`: path in drift che il ratchet non registra → il gate fallisce;
 *   - `stale`: path registrati che non sono piu' in drift → da potare (avviso,
 *     mai un rosso: la potatura e' del job di realign o di `--write-ratchet`).
 * Un path con hash illeggibili (`unknown`) non e' ne' l'uno ne' l'altro.
 */
export function ratchetVerdict({ drift, unknown = [], ratchetPaths }) {
  const recorded = new Set(ratchetPaths);
  const current = new Set(drift);
  const unread = new Set(unknown);
  const fresh = [...current].filter((p) => !recorded.has(p)).sort();
  const stale = [...recorded].filter((p) => !current.has(p) && !unread.has(p)).sort();
  return { ok: fresh.length === 0, fresh, stale, count: current.size, recorded: recorded.size };
}

/** In PR l'elenco puo' solo accorciarsi rispetto alla base. */
export function ratchetShrinkVerdict({ before, after }) {
  if (!before) return { ok: true, added: [] };
  const base = new Set(before);
  const added = [...new Set(after)].filter((p) => !base.has(p)).sort();
  return { ok: added.length === 0, added };
}

/** Valida e normalizza il contenuto del file di ratchet. */
export function parseRatchet(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.paths) || data.paths.some((p) => typeof p !== 'string' || !p)) {
    throw new Error(`${ADAPTED_DRIFT_RATCHET_PATH}: serve un oggetto con \`paths\`, elenco di path non vuoti`);
  }
  return { ...data, paths: [...new Set(data.paths)].sort() };
}

export function serializeRatchet(ratchet) {
  return `${JSON.stringify({ ...ratchet, paths: [...new Set(ratchet.paths)].sort() }, null, 2)}\n`;
}

/** Il ratchet senza i path indicati (mai con path in piu'). */
export function pruneRatchetPaths(ratchet, remove) {
  const drop = new Set(remove);
  return { ...ratchet, paths: ratchet.paths.filter((p) => !drop.has(p)) };
}

/** Legge il ratchet dal working tree; null se il file non esiste. */
export function readRatchetFile(root) {
  const abs = path.join(root, ADAPTED_DRIFT_RATCHET_PATH);
  if (!fs.existsSync(abs)) return null;
  return parseRatchet(fs.readFileSync(abs, 'utf8'));
}

/**
 * Toglie dal ratchet sul disco i path riconciliati. Ritorna i path tolti (vuoto
 * se il file manca o nessuno era registrato: in quel caso il file non si tocca).
 */
export function pruneRatchetFile(root, remove) {
  const ratchet = readRatchetFile(root);
  if (!ratchet) return [];
  const removed = ratchet.paths.filter((p) => remove.includes(p));
  if (!removed.length) return [];
  fs.writeFileSync(path.join(root, ADAPTED_DRIFT_RATCHET_PATH), serializeRatchet(pruneRatchetPaths(ratchet, removed)));
  return removed;
}

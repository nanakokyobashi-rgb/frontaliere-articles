/**
 * canton-high-cadence.mjs — la manopola `CANTON_HIGH_CADENCE_SECTIONS` e le
 * regole che ne discendono (F3.A del piano «cadenza 20 articoli per sezione»).
 *
 * Remote Config `CANTON_HIGH_CADENCE_SECTIONS` elenca le sezioni cantonali che
 * generano ad alta cadenza (stessa sintassi di `CANTON_ARTICLE_SECTIONS_ENABLED`:
 * id `canton-ti`, codici `TI`, `all`, separati da virgole o spazi). Assente o
 * vuoto = nessuna sezione = il comportamento di prima della manopola:
 *
 *   - budget giornaliero 4 (il `dailyBudget` del profilo);
 *   - 4 slot al giorno, uno ogni `BASE_CADENCE_HOURS` ore;
 *   - nessuna catena cantonale.
 *
 * Per una sezione in lista: budget `HIGH_CADENCE_DAILY_BUDGET`, tutti gli slot
 * orari del calendario, catena cantonale (vedi `generate-canton-article-workflows.mjs`).
 *
 * IL CALENDARIO E' ORARIO PER TUTTI (rete di ripartenza), la cadenza di base no:
 * `canton-generation-admit.mjs` salta con `admit-cadence` gli slot fuori dalla
 * cadenza di base per le sezioni FUORI lista, cosi' una lista vuota ammette
 * esattamente gli slot di oggi. Questo modulo e' l'unica sorgente di quella
 * cadenza: lo sfasamento di ogni cantone dentro le 6 ore e' lo stesso che il
 * generatore dei workflow calcolava quando `cadenceHours` valeva 6.
 *
 * Solo builtin Node e moduli puri del corpus: lo importa anche uno step shell
 * della catena (`node generator/scripts/lib/canton-high-cadence.mjs has <sezione>`).
 */
import '../../../host/cantonSectionsBootstrap.mjs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseEnabledCantonSections } from './canton-section-profile.mjs';

export const CANTON_HIGH_CADENCE_ENV = 'CANTON_HIGH_CADENCE_SECTIONS';

/** Budget giornaliero di una sezione in lista (20 + margine per la finestra mobile di 24 ore). */
export const HIGH_CADENCE_DAILY_BUDGET = 24;

/** Cadenza di base, in ore, delle sezioni fuori lista (4 slot al giorno). */
export const BASE_CADENCE_HOURS = 6;

/** Valore di `chain_scope` che arma la catena cantonale per le sole sezioni in lista. */
export const CHAIN_SCOPE_HIGH_CADENCE = 'canton-high-cadence';

/**
 * Le sezioni in lista.
 *
 * @param {string | undefined | null} raw valore di `CANTON_HIGH_CADENCE_SECTIONS`
 * @returns {{ sections: Set<string>, unknown: string[] }}
 */
export function parseHighCadenceSections(raw) {
  return parseEnabledCantonSections(raw);
}

/** `section` e' in lista nell'ambiente dato? */
export function isHighCadenceSection(section, env = process.env) {
  return parseHighCadenceSections(env?.[CANTON_HIGH_CADENCE_ENV]).sections.has(section);
}

/**
 * Le ore UTC dei 4 slot di base di ogni cantone: i cantoni, in ordine di
 * sezione, si distribuiscono in modo uniforme sulle `BASE_CADENCE_HOURS` ore.
 *
 * @param {string[]} sections tutte le sezioni cantonali del profilo
 * @returns {Map<string, number[]>}
 */
export function baseSlotHoursBySection(sections) {
  const sorted = [...sections].sort((a, b) => a.localeCompare(b));
  const out = new Map();
  sorted.forEach((section, i) => {
    const offset = Math.floor((i * BASE_CADENCE_HOURS) / sorted.length);
    const hours = [];
    for (let h = offset; h < 24; h += BASE_CADENCE_HOURS) hours.push(h);
    out.set(section, hours);
  });
  return out;
}

/** `hour` (UTC) e' uno slot della cadenza di base di `section`? */
export function isBaseCadenceSlot(section, hour, sections) {
  const hours = baseSlotHoursBySection(sections).get(section);
  if (!hours) throw new Error(`"${section}" non e' fra le sezioni cantonali date`);
  return hours.includes(hour);
}

/**
 * L'ora UTC (0-23) dello slot di uno `recovery_slot`
 * (`generate-article/<sezione>/YYYY-MM-DDTHH:MMZ`), oppure `null`.
 */
export function slotHourFromKey(slotKey) {
  const m = /^generate-article\/[a-z0-9-]+\/\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\dZ$/u.exec(String(slotKey ?? ''));
  return m ? Number(m[1]) : null;
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// CLI per lo step shell della catena: `has <sezione>` esce 0 se in lista, 1 altrimenti.
if (isMain()) {
  const [command, section] = process.argv.slice(2);
  if (command === 'has' && section) {
    process.exit(isHighCadenceSection(section) ? 0 : 1);
  }
  console.error('uso: canton-high-cadence.mjs has <sezione>');
  process.exit(2);
}

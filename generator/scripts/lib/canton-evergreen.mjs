/**
 * canton-evergreen.mjs — la manopola `CANTON_EVERGREEN_SECTIONS` (WP3.10b).
 *
 * Una sezione cantonale senza notizia utilizzabile non pubblicava niente
 * (`CANTON_EVERGREEN_POOL_DISABLED`): con fonti sterili o dietro challenge
 * l'intera sezione restava ferma per giorni. Remote Config
 * `CANTON_EVERGREEN_SECTIONS` elenca le sezioni cantonali (id `canton-ur`,
 * codici `UR`, `all`, separati da virgole o spazi: stessa sintassi di
 * `CANTON_HIGH_CADENCE_SECTIONS`) che, SOLO quando la ricerca news non produce
 * nulla, ripiegano su un pool evergreen del proprio cantone.
 *
 * Default sicuro: chiave assente o vuota = nessuna sezione = il comportamento
 * di prima. Qualita' e anti-duplicazione restano quelle del pool evergreen di
 * `svizzera` (pre-flight di copertura tematica e Jaccard, registro dei
 * rifiuti per sezione, fact-check contro il brief verificato del cantone e
 * gate finale canton-evergreen): questo modulo decide solo QUALI sezioni e
 * QUALI codici cantone alimentano il pool.
 *
 * Solo builtin Node e moduli puri del corpus.
 */
import '../../../host/cantonSectionsBootstrap.mjs';

import { parseEnabledCantonSections } from './canton-section-profile.mjs';

export const CANTON_EVERGREEN_ENV = 'CANTON_EVERGREEN_SECTIONS';

/**
 * Le sezioni in lista.
 *
 * @param {string | undefined | null} raw valore di `CANTON_EVERGREEN_SECTIONS`
 * @returns {{ sections: Set<string>, unknown: string[] }}
 */
export function parseCantonEvergreenSections(raw) {
  return parseEnabledCantonSections(raw);
}

/** `section` puo' ripiegare sul pool evergreen del proprio cantone nell'ambiente dato? */
export function isCantonEvergreenSection(section, env = process.env) {
  return parseCantonEvergreenSections(env?.[CANTON_EVERGREEN_ENV]).sections.has(section);
}

/**
 * I codici cantone che alimentano il pool di una sezione (il cantone stesso e,
 * per i gruppi come Appenzello o Basilea, i suoi membri), senza doppioni.
 *
 * @param {{ canton?: string, members?: string[] } | null | undefined} profile
 * @returns {string[]}
 */
export function cantonEvergreenCodes(profile) {
  const codes = [profile?.canton, ...(Array.isArray(profile?.members) ? profile.members : [])]
    .map((code) => String(code || '').trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(codes)];
}

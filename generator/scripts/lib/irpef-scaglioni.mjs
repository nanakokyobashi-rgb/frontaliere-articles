/**
 * irpef-scaglioni.mjs — UNA sorgente per gli scaglioni IRPEF citati dai prompt
 * del generatore (issue #1777).
 *
 * Perche' esiste. `create-article.mjs` scriveva gli scaglioni a mano in tre
 * punti (VERIFIED_DOMAIN_FACTS del fact-check, i due richiami «IRPEF
 * 23%/35%/43%» dei criteri 3 e 4 dello stesso prompt, EVERGREEN_FACTS_BRIEF
 * della generazione). Dal periodo d'imposta 2026 il secondo scaglione e' al
 * 33% (Legge 30 dicembre 2025, n. 199, art. 1 c. 3): con il 35% hard-coded il
 * fact-check marcava `critical` un articolo corretto al 33%, e il brief
 * spingeva il writer a scrivere l'aliquota superata. Tre copie significano tre
 * aggiornamenti al prossimo cambio: qui ce n'e' una.
 *
 * Gli anni restano distinti di proposito: nel 2026 si dichiarano ancora i
 * redditi 2025 (35%), quindi un articolo sulla dichiarazione dei redditi 2025
 * che cita il 35% e' CORRETTO e il fact-check non deve bloccarlo.
 *
 * Limiti degli scaglioni invariati fra i due regimi: 28'000 e 50'000 euro.
 */

/** Primo anno d'imposta in cui vale lo scaglione al 33%. */
export const IRPEF_ANNO_CORRENTE = 2026;

/** Riferimento normativo del regime corrente, da citare nei prompt. */
export const IRPEF_FONTE_CORRENTE = 'Legge 199/2025, art. 1 c. 3';

const scaglioni = (secondo) => Object.freeze([
  Object.freeze({ fino: 28000, aliquota: 23 }),
  Object.freeze({ fino: 50000, aliquota: secondo }),
  Object.freeze({ fino: null, aliquota: 43 }),
]);

/**
 * Regimi per anno d'imposta. La chiave e' il primo anno di vigenza;
 * `irpefScaglioniPer(anno)` risolve l'ultimo regime iniziato entro `anno`.
 */
export const IRPEF_REGIMI = Object.freeze([
  Object.freeze({ dal: 2024, al: 2025, scaglioni: scaglioni(35) }), // D.Lgs. 216/2023, L. 207/2024
  Object.freeze({ dal: 2026, al: null, scaglioni: scaglioni(33) }), // L. 199/2025 art. 1 c. 3
]);

export function irpefScaglioniPer(anno) {
  const regime = [...IRPEF_REGIMI].reverse().find((r) => anno >= r.dal);
  if (!regime) throw new RangeError(`irpef-scaglioni: nessun regime a tre scaglioni per l'anno ${anno}`);
  return regime.scaglioni;
}

const eur = (n) => `€${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "'")}`;

/** «23% fino €28'000, 33% €28'001–€50'000, 43% oltre €50'000» */
export function irpefScaglioniTesto(anno) {
  const [a, b, c] = irpefScaglioniPer(anno);
  return `${a.aliquota}% fino ${eur(a.fino)}, ${b.aliquota}% ${eur(a.fino + 1)}–${eur(b.fino)}, `
    + `${c.aliquota}% oltre ${eur(b.fino)}`;
}

/** «23%/33%/43%» */
export function irpefAliquoteBreve(anno) {
  return irpefScaglioniPer(anno).map((s) => `${s.aliquota}%`).join('/');
}

/** Regime precedente a quello corrente (2024-2025), per i richiami storici. */
export const IRPEF_ANNO_PRECEDENTE = IRPEF_ANNO_CORRENTE - 1;

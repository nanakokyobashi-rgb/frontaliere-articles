/**
 * Invarianti comuni ai test osservatori delle guide evergreen rilette contro
 * una scheda di fatti verificati (`evergreen-<slug>-refresh.test.mjs`).
 *
 * ## Il difetto che sorvegliano
 *
 * Lotto del 2026-10-07 (quattro guide sull'assicurazione malattia). La
 * correzione dell'italiano era conforme alla scheda; le traduzioni no, e in tre
 * modi che un test «il numero giusto c'è, il numero vecchio non c'è più» non
 * vede:
 *
 *   1. NOTE REDAZIONALI NEL TESTO. La scheda dice a chi corregge «dettaglio non
 *      verificato: lasciare» e «il link resta, senza il riferimento al modello
 *      medico di famiglia». In pagina sono finite le istruzioni: «remains an
 *      unverified detail», «without treating a family-doctor model as
 *      available», «this answer does not claim that the bills caused that
 *      increase».
 *   2. TRADUZIONI SVUOTATE. Per togliere una frase sbagliata il paragrafo è
 *      stato riscritto corto: nella guida sulle fatture mediche `body2` e
 *      `body3` di en/de/fr erano scesi al 20-44% dell'italiano (da 86-110%),
 *      mentre l'italiano cambiava dell'1%.
 *   3. RESIDUI DI TRADUZIONE AUTOMATICA nelle domande frequenti, sopravvissuti
 *      perché la correzione toccava solo le risposte: «der KVG für einen
 *      grenzüberschreitenden Pendler», «le CESEE», «Patienten-Cash-Prämien»,
 *      «pay only any ticket».
 *
 * Le liste qui sotto NON sono ipotesi: ogni voce è una stringa realmente
 * consegnata in quel lotto (o già pubblicata nelle stesse guide). Si allungano
 * quando un nuovo lotto ne mostra un'altra.
 *
 * ## Perché non è un gate su tutto il corpus
 *
 * Misurato su `main` il 2026-10-07 (16.808 file di `content/blog-body`): le
 * formule specifiche qui sotto hanno zero occorrenze fuori dalle guide rilette,
 * ma le forme generiche («non verificato», «unverified details») compaiono in
 * articoli di cronaca con il loro significato normale («informazioni non
 * verificate sui social»). Un divieto a tappeto fermerebbe `main` per una frase
 * legittima; applicato alle guide che un agente ha appena corretto con una
 * scheda in mano, sorveglia esattamente il punto in cui il difetto nasce.
 */

/** Istruzioni o cautele di chi corregge, scritte per il lettore. */
export const EDITORIAL_NOTE_PATTERNS = Object.freeze({
  it: [
    /dettaglio non verificato/i,
    /resta un dettaglio/i,
    /nesso causale[^.]{0,40}non è dimostrato/i,
    /questa risposta non (?:sostiene|afferma|pretende)/i,
    /non sono disponibili cifre verificate/i,
    /senza (?:il )?riferimento a(?:l| un) modello non disponibile/i,
  ],
  en: [
    /(?:remains|stays|is retained as) an unverified detail/i,
    /is not established here/i,
    /this answer does not claim/i,
    /without treating [^.]{0,80} as available/i,
    /no verified figures are available/i,
    /remains a possible general resource/i,
  ],
  de: [
    /nicht verifiziertes Detail/i,
    /wird hier nicht behauptet/i,
    /ohne ein nicht verfügbares/i,
    /verifizierte [A-Za-zäöüÄÖÜ]*zahlen liegen nicht vor/i,
    /bleibt eine allgemeine Möglichkeit/i,
  ],
  fr: [
    /détail non vérifié/i,
    /cette réponse ne prétend pas/i,
    /sans référence à un modèle non disponible/i,
    /aucun chiffre vérifié n[’']est disponible/i,
    /reste une ressource générale/i,
  ],
});

/** Residui di traduzione automatica e sigle della lingua sbagliata. */
export const MACHINE_TRANSLATION_RESIDUE = Object.freeze({
  it: [
    /\bEHIC\b/, // in italiano la tessera europea è la TEAM
    /\bintervisti\b/i,
  ],
  en: [
    /\bKVG\b/, // in inglese la sigla dell'articolo è LAMal
    /\bNHS\b/, // il Servizio sanitario italiano non è l'NHS
    /\bpay(?:s|ing)? only any\b/i,
    /only any (?:Italian )?ticket/i,
    /patient cash premiums/i,
    /challenge of an incorrect/i,
    /Order of Doctors/i,
  ],
  de: [
    /grenzüberschreitende[nr]? Pendler/i,
    /\bEHIC\b/, // auf Deutsch: EKVK
    /\bNHS\b/,
    /Patienten-Cash/i,
    /Mutterschaftsvertretung/i,
    /Orden(?:s)? der Ärzte/i,
    /Herausforderung einer (?:falschen|fehlerhaften) Rechnung/i,
    /allfällige[sn]? Ticket/i, // «Zuzahlung (Ticket)», nicht «ein allfälliges Ticket»
  ],
  fr: [
    /navetteurs? transfrontaliers?/i,
    /\bCESEE\b/, // en français : CEAM
    /\bNHS\b/,
    /\bKVG\b/, // en français la sigle est LAMal
    /primes en espèces/i,
    /au défi d[’']une facture/i,
  ],
});

function hits(patterns, text) {
  const found = [];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) found.push(`${pattern} → «${text.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40).replace(/\s+/g, ' ')}»`);
  }
  return found;
}

/** Note redazionali trovate nel testo di una lingua (vuoto = nessuna). */
export function editorialNotes(text, locale) {
  return hits(EDITORIAL_NOTE_PATTERNS[locale] ?? [], text);
}

/** Residui di traduzione automatica trovati nel testo di una lingua. */
export function translationResidue(text, locale) {
  return hits(MACHINE_TRANSLATION_RESIDUE[locale] ?? [], text);
}

/**
 * Sotto questa quota dell'italiano un campo tradotto ha perso contenuto.
 * Misura del 2026-10-07 sulle quattro guide del lotto, dopo la correzione:
 * minimo 51% (un `body1` inglese nato senza i riquadri iniziali), tutto il
 * resto fra 57% e 138%; i campi svuotati stavano fra 20% e 44%.
 */
export const TRANSLATED_FIELD_FLOOR = 0.45;

/**
 * Campi di una traduzione più corti di `floor` volte lo stesso campo italiano.
 * `italian` e `translated` sono oggetti `{ nomeCampo: testo }`.
 */
export function thinTranslatedFields(italian, translated, floor = TRANSLATED_FIELD_FLOOR) {
  const thin = [];
  for (const [field, source] of Object.entries(italian)) {
    const target = translated[field];
    if (typeof source !== 'string' || source.length === 0) continue;
    const ratio = (typeof target === 'string' ? target.length : 0) / source.length;
    if (ratio < floor) thin.push(`${field}: ${Math.round(ratio * 100)}% dell'italiano (minimo ${Math.round(floor * 100)}%)`);
  }
  return thin;
}

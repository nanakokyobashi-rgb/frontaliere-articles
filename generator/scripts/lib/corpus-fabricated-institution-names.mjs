/**
 * Names confirmed as fabricated by issue #2522.
 *
 * This corpus-side list is intentionally separate from the byte-identical
 * factuality gate: that mirror is owned by the site repository, while this
 * adapted generator and the published corpus need a local guard for names
 * already proven false here. One list serves generation and corpus scanning.
 */
const FABRICATED_INSTITUTION_NAME_PATTERNS = [
  {
    pattern: /\bUfficio federale per la politica estera(?:\s*\(UPEP\))?\b/i,
    label: 'Ufficio federale per la politica estera (UPEP)',
  },
  {
    pattern: /\bIstituto federale di statistica(?:\s*\(IFS\))?\b/i,
    label: 'Istituto federale di statistica (IFS)',
  },
  {
    pattern: /\bMinistero dell[’']agricoltura,\s*dell[’']ambiente e dello spazio\b/i,
    label: 'Ministero dell’agricoltura, dell’ambiente e dello spazio',
  },
  {
    pattern: /\bFederal Office for Foreign Policy(?:\s*\(UPEP\))?\b/i,
    label: 'Federal Office for Foreign Policy (UPEP)',
  },
  {
    pattern: /\b(?:Swiss )?Federal Statistical Office\s*\(IFS\)\b/i,
    label: 'Federal Statistical Office (IFS)',
  },
  {
    pattern: /\bBundesamt für Außenpolitik(?:\s*\(UPEP\))?\b/i,
    label: 'Bundesamt für Außenpolitik (UPEP)',
  },
  {
    pattern: /\bBundesamt für Statistik\s*\(IFS\)\b/i,
    label: 'Bundesamt für Statistik (IFS)',
  },
  {
    pattern: /\bOffice fédéral de la politique étrangère(?:\s*\(UPEP\))?\b/i,
    label: 'Office fédéral de la politique étrangère (UPEP)',
  },
  {
    pattern: /\bOffice fédéral de la statistique\s*\(IFS\)\b/i,
    label: 'Office fédéral de la statistique (IFS)',
  },
];

export function checkCorpusFabricatedInstitutionNames(text) {
  const value = String(text || '');
  return FABRICATED_INSTITUTION_NAME_PATTERNS
    .filter(({ pattern }) => pattern.test(value))
    .map(({ label }) => ({
      code: 'fabricated-institution',
      evidence: label,
    }));
}

export { FABRICATED_INSTITUTION_NAME_PATTERNS };

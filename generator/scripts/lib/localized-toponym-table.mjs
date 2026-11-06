import { readFileSync } from 'node:fs';

export const LOCALIZED_TOPONYM_ENTITY_TYPES = Object.freeze(['canton', 'capital']);

/** Check the JSON shape before consumers spread/map its nested fields.
 * Semantic checks (26 cantons, exonyms, normalized aliases) remain in
 * localized-toponyms.mjs; this reader can run even when the fixture is absent.
 */
export function readLocalizedToponymTable(file) {
  const table = JSON.parse(readFileSync(file, 'utf8'));
  if (!table || !Array.isArray(table.locales) || table.locales.length === 0
      || table.locales.some((locale) => typeof locale !== 'string' || !locale.trim())
      || !Array.isArray(table.entities) || table.entities.length === 0) {
    throw new Error('locales/entities mancanti o vuoti');
  }
  for (const entity of table.entities) {
    if (!entity || typeof entity.code !== 'string' || !entity.code.trim()) {
      throw new Error('codice cantonale mancante');
    }
    for (const type of LOCALIZED_TOPONYM_ENTITY_TYPES) {
      for (const locale of table.locales) {
        const forms = entity[type]?.[locale];
        if (!Array.isArray(forms) || forms.length === 0
            || forms.some((form) => typeof form !== 'string' || !form.trim())) {
          throw new Error(`${entity.code}.${type}.${locale}: forme mancanti o non testuali`);
        }
      }
    }
  }
  return table;
}

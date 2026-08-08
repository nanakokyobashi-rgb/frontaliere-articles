/**
 * PORTATO da valerielinc-ops/frontaliere-si-o-no `tests/blog-title-casing.test.ts`
 * (manifest: `adapted`) — l'incidente vivo: un titolo IT pubblicato TUTTO
 * MAIUSCOLO perché normalizeTitleCasing era cablato solo nel percorso
 * journalist-publish e il suo check per-parola era un no-op sull'input
 * interamente maiuscolo.
 *
 * ## ADATTAMENTI rispetto al sito
 *  - Il sito importa le due funzioni da create-article.mjs con vitest. Qui
 *    `import` diretto è impossibile senza node_modules: la closure di
 *    create-article.mjs tira dipendenze npm (sharp, undici, ...) che la CI
 *    di questo repo non installa di proposito. Le funzioni però sono PURE e
 *    autocontenute coi loro due Set: il test ESTRAE il blocco sorgente
 *    (TITLE_CASING_PROPER_NOUNS → fine di collapseShoutingTitle) e lo valuta
 *    in sandbox — la stessa tecnica che il test headline del sito documenta
 *    per validateHeadline. Se l'estrazione si rompe (funzioni spostate,
 *    delimitatori cambiati), il test fallisce rumorosamente: non può passare
 *    a vuoto.
 *  - `node:test` + expect-shim al posto di vitest.
 *  - AGGIUNTO (non esiste sul sito): lo scan anti-shouting su TUTTI i titoli
 *    e imageAlt pubblicati (8 file blog-meta*, 4 locali × 2 sezioni). È il
 *    gate sull'OUTPUT: le unit qui sopra pinnano la funzione, lo scan pinna
 *    che nessun campo pubblicato sia rimasto urlato qualunque percorso lo
 *    abbia scritto. Misurato al porting: 0 offender.
 *  - AGGIUNTO wiring guard: i due call-site che l'incidente ha scoperto
 *    mancanti (normalizeTitleCasing sul titolo IT generato,
 *    collapseShoutingTitle incondizionato su ogni imageAlt[locale]) devono
 *    esistere nel sorgente.
 */
import { describe, it } from 'node:test';
import { expect } from './lib/expect-shim.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_ARTICLE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');

// ── Estrazione in sandbox delle funzioni pure ──────────────────────────────

function extractTitleCasingBlock() {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');
  const start = src.indexOf('const TITLE_CASING_PROPER_NOUNS = new Set([');
  const fnStart = src.indexOf('function collapseShoutingTitle(rawTitle) {');
  if (start === -1 || fnStart === -1 || fnStart < start) {
    throw new Error('title-casing block not found in create-article.mjs — aggiornare i delimitatori di questo test');
  }
  // La funzione è chiusa dalla prima riga che è esattamente '}' a colonna 0.
  const endRel = src.slice(fnStart).search(/\n\}\n/);
  if (endRel === -1) throw new Error('collapseShoutingTitle closing brace not found');
  const block = src.slice(start, fnStart + endRel + 2);
  return new Function(`${block}\nreturn { normalizeTitleCasing, collapseShoutingTitle };`)();
}

const { normalizeTitleCasing, collapseShoutingTitle } = extractTitleCasingBlock();

// ── Unit — banco del sito, verbatim ────────────────────────────────────────

// Live incident: an article was published with a fully-uppercase IT title
// ("LA SOSPENSIONE DEI RISTORNI ALLA PROVA DELLA CONVENZIONE ITALIA-SVIZZERA:
// IL CASO DELLA \"TASSA SULLA SALUTE\"") because normalizeTitleCasing was only
// wired into the journalist-publish pipeline, never into create-article.mjs's
// own AI-generation path — and even wired in, its old per-word acronym check
// was a no-op on fully-uppercase input. Both gaps are fixed; this locks in the fix.
describe('normalizeTitleCasing — shouting (fully-uppercase) titles', () => {
  it('sentence-cases the reported live-incident title, preserving the compound proper noun', () => {
    const shouting = 'LA SOSPENSIONE DEI RISTORNI ALLA PROVA DELLA CONVENZIONE ITALIA-SVIZZERA: IL CASO DELLA "TASSA SULLA SALUTE"';
    expect(normalizeTitleCasing(shouting)).toBe(
      'La sospensione dei ristorni alla prova della convenzione Italia-Svizzera: il caso della "tassa sulla salute"',
    );
  });

  it('preserves known institutional acronyms and CHF in a shouting title', () => {
    expect(normalizeTitleCasing('NUOVO ACCORDO CON LA SVIZZERA E CHF 500')).toBe(
      'Nuovo accordo con la Svizzera e CHF 500',
    );
  });

  it('does not mistake short Italian function words for acronyms', () => {
    expect(normalizeTitleCasing('LA SOSPENSIONE DEI RISTORNI')).toBe('La sospensione dei ristorni');
  });

  it('leaves an already sentence-cased title untouched (no-op)', () => {
    expect(normalizeTitleCasing('AVS e LPP: cosa cambia nel 2026')).toBe('AVS e LPP: cosa cambia nel 2026');
  });

  it('still sentence-cases journalist Title Case input while preserving an inline acronym', () => {
    expect(normalizeTitleCasing('Nuove Regole AVS Per Il Ticino')).toBe('Nuove regole AVS per il Ticino');
  });

  it('still preserves canton/city/country proper nouns in Title Case input (issue #3174)', () => {
    expect(normalizeTitleCasing('Nuove Regole Per Il Ticino')).toBe('Nuove regole per il Ticino');
  });
});

describe('collapseShoutingTitle — locale-agnostic ALL-CAPS guard (EN/DE/FR)', () => {
  it('fixes a shouting translated title without imposing Italian sentence-case grammar', () => {
    expect(collapseShoutingTitle('THE SUSPENSION OF TAX REFUNDS UNDER THE ITALY-SWITZERLAND TREATY')).toBe(
      'The suspension of tax refunds under the italy-switzerland treaty',
    );
  });

  it('preserves known acronyms in a shouting translated title', () => {
    expect(collapseShoutingTitle('NEW AVS AND CHF 500 RULES')).toBe('New AVS and CHF 500 rules');
  });

  it('is a no-op on normally-cased titles', () => {
    expect(collapseShoutingTitle('The New Cross-Border Rules')).toBe('The New Cross-Border Rules');
  });
});

// Reviewer nit (PR #3350 del sito): imageAlt is a required LLM schema field —
// when the LLM returns it directly it bypassed normalization entirely, so the
// fix runs collapseShoutingTitle unconditionally on every imageAlt[locale].
describe('collapseShoutingTitle — applied unconditionally to imageAlt (create-article.mjs validate())', () => {
  it('fixes a fully-shouting imageAlt returned directly by the LLM', () => {
    expect(collapseShoutingTitle('IMMAGINE EDITORIALE RELATIVA ALLA SOSPENSIONE DEI RISTORNI')).toBe(
      'Immagine editoriale relativa alla sospensione dei ristorni',
    );
  });

  it('is a no-op on the mixed-case fallback template (already-normalized title embedded)', () => {
    const fallback = 'Immagine editoriale relativa a: La sospensione dei ristorni alla prova della convenzione Italia-Svizzera';
    expect(collapseShoutingTitle(fallback)).toBe(fallback);
  });
});

// ── Wiring guard — i due call-site che l'incidente ha trovato mancanti ─────

describe('wiring guard — le funzioni sono cablate nel percorso di generazione', () => {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');

  it('normalizeTitleCasing è applicato al titolo IT generato', () => {
    expect(src).toContain('normalizeTitleCasing(itContent.title)');
  });

  it('collapseShoutingTitle è applicato incondizionatamente a ogni imageAlt[locale]', () => {
    expect(src).toContain('data.imageAlt[locale] = collapseShoutingTitle(data.imageAlt[locale])');
  });

  it('collapseShoutingTitle è applicato ai titoli tradotti', () => {
    expect(src).toContain('collapseShoutingTitle(localeContent.title)');
  });
});

// ── Scan sull'output pubblicato: nessun titolo/imageAlt urlato ─────────────

describe('published meta fields — no shouting titles or imageAlt in any locale', () => {
  const metaFiles = fs.readdirSync(path.join(ROOT, 'content'))
    .filter((f) => /^blog-meta(-ch)?-(it|en|de|fr)\.ts$/.test(f));

  it('finds all 8 meta files (a sparse checkout must NOT pass vacuously)', () => {
    expect(metaFiles.length).toBe(8);
  });

  it('no fully-uppercase title/imageAlt anywhere', () => {
    const offenders = [];
    for (const metaFile of metaFiles) {
      const src = fs.readFileSync(path.join(ROOT, 'content', metaFile), 'utf-8');
      const re = /'blog\.article\.([^.']+)\.(title|imageAlt)'\s*:\s*'((?:\\'|[^'])+)'/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const value = m[3].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
        const letters = value.replace(/[^A-Za-zÀ-ÿ]/g, '');
        // Soglia 15 lettere: sotto, un campo corto di soli acronimi legittimi
        // ("AVS E LPP 2026") sarebbe un falso positivo.
        if (letters.length >= 15 && value === value.toUpperCase() && /[A-ZÀ-Þ]/.test(letters)) {
          offenders.push(`${metaFile} ${m[1]}.${m[2]}: "${value.slice(0, 60)}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

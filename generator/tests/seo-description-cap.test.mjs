/**
 * Meta-description budget, enforced on THIS side of the mirror.
 *
 * ## L'incidente
 *
 * L'edizione `bollettino-frontaliere-2026-08-09` ha registrato una description
 * di 265 caratteri. Il corpus di questo repo viene copiato dentro
 * `packages/articles/content/` del sito, dove `tests/seo-description-length.test.ts`
 * fallisce sopra i 170 — e fallisce su OGNI branch, non solo su quella aperta
 * quando l'edizione atterra. Il job `tests` del sito e' rimasto rosso ovunque,
 * bloccando a cascata ogni PR (valerielinc-ops#5420 fra le altre).
 *
 * Era gia' successo il 2026-08-08, con lo stesso identico testo. Quella volta
 * la correzione ha riscritto il DATO (e5126c26, `content/blog-meta-*.ts`) e ha
 * lasciato scritto nel messaggio che la causa a monte restava aperta. Il giorno
 * dopo il generatore l'ha riprodotta. Questo file e' il gate che mancava.
 *
 * ## Perche' il cap sta in `registerArticleFiles`
 *
 * Il cap esisteva gia' qui — `truncateAtWordBoundary(desc, 160)` — ma viveva
 * dentro lo step di arricchimento del flusso AI, quindi lo prendevano solo gli
 * articoli creati da `main()`. `generate-daily-brief-article.mjs` importa
 * `registerArticleFiles` direttamente e quello step non lo attraversa mai.
 * Il difetto non e' l'edizione: e' una regola imposta in UN produttore invece
 * che nel punto di scrittura che li accomuna. Porting della fix del sito
 * (valerielinc-ops#5360), che qui non arriva da nessuno dei due mirror:
 * `generator/scripts/create-article.mjs` e' un fork non nel loop-sync-manifest.
 *
 * ## ADATTAMENTI rispetto al sito
 *  - Il sito importa da create-article.mjs con vitest. Qui `import` diretto e'
 *    impossibile senza node_modules: la closure tira dipendenze npm (sharp,
 *    undici, ...) che la CI di questo repo non installa di proposito. Le due
 *    funzioni sono pure: il test ESTRAE i blocchi sorgente e li valuta in
 *    sandbox, come gia' fa `blog-title-casing.test.mjs`. Se l'estrazione si
 *    rompe il test fallisce rumorosamente — non puo' passare a vuoto.
 *  - AGGIUNTO (non esiste sul sito): lo scan sull'OUTPUT pubblicato. Le unit
 *    pinnano la funzione, lo scan pinna che nessuna description gia' scritta
 *    sfori, qualunque percorso l'abbia prodotta. E' il gate che avrebbe fermato
 *    il 2026-08-09 QUI, prima che diventasse rosso sul sito.
 */
import { describe, it } from 'node:test';
import { expect } from './lib/expect-shim.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_ARTICLE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');
const SEO_DIR = path.join(ROOT, 'content', 'seo');

/** Il tetto duro di `tests/seo-description-length.test.ts` sul sito. */
const SITE_HARD_MAX = 170;

// ── Estrazione in sandbox delle funzioni pure ──────────────────────────────

/** Slice from `header` to the first line that is exactly `}` at column 0. */
function sliceFn(src, header) {
  const start = src.indexOf(header);
  if (start === -1) {
    throw new Error(`"${header}" non trovato in create-article.mjs — aggiornare i delimitatori di questo test`);
  }
  const endRel = src.slice(start).search(/\n\}\n/);
  if (endRel === -1) throw new Error(`chiusura di "${header}" non trovata`);
  return src.slice(start, start + endRel + 2);
}

function extractCapBlock() {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');
  const max = src.match(/^const SEO_DESCRIPTION_MAX = (\d+);$/m);
  if (!max) throw new Error('SEO_DESCRIPTION_MAX non trovato in create-article.mjs');
  const block = [
    sliceFn(src, 'function truncateAtWordBoundary(text, maxLen) {'),
    `const SEO_DESCRIPTION_MAX = ${max[1]};`,
    sliceFn(src, 'function clampSeoDescriptions(data) {'),
  ].join('\n\n');
  return new Function(
    `${block}\nreturn { clampSeoDescriptions, truncateAtWordBoundary, SEO_DESCRIPTION_MAX };`,
  )();
}

const { clampSeoDescriptions, SEO_DESCRIPTION_MAX } = extractCapBlock();

/** Il testo esatto che ha rotto il sito, due giorni di fila. */
const OFFENDER =
  'I numeri di oggi, 9 agosto 2026, per chi attraversa il confine: attese ai valichi misurate ' +
  'stamattina, i comuni dove la benzina costa meno, il cambio franco–euro e i nuovi annunci di ' +
  'lavoro in Svizzera. Dati raccolti dal nostro monitoraggio, aggiornati ogni giorno.';

// ── Unit ───────────────────────────────────────────────────────────────────

describe('clampSeoDescriptions', () => {
  it('lascia margine sotto il tetto del sito', () => {
    expect(SEO_DESCRIPTION_MAX).toBeLessThan(SITE_HARD_MAX);
  });

  it("riporta l'offender del 2026-08-09 dentro il budget, su entrambi i campi", () => {
    expect(OFFENDER.length).toBeGreaterThan(SITE_HARD_MAX); // il test si autoverifica
    const data = { seo: { description: OFFENDER, ogDescription: OFFENDER } };
    clampSeoDescriptions(data);
    expect(data.seo.description.length).toBeLessThan(SEO_DESCRIPTION_MAX + 1);
    expect(data.seo.ogDescription.length).toBeLessThan(SEO_DESCRIPTION_MAX + 1);
  });

  it('taglia a confine di parola, mai a meta', () => {
    const data = { seo: { description: OFFENDER } };
    clampSeoDescriptions(data);
    const clamped = data.seo.description;
    // Il taglio toglie solo una CODA: quello che resta e' un prefisso esatto
    // (la punteggiatura finale viene strippata, che di un prefisso e' ancora
    // un prefisso).
    expect(OFFENDER.startsWith(clamped)).toBe(true);
    // E il carattere subito dopo il taglio non puo' essere una lettera: lo
    // sarebbe solo se avessimo spezzato una parola a meta.
    const next = OFFENDER.slice(clamped.length, clamped.length + 1);
    expect(/^[\p{L}\p{N}]$/u.test(next)).toBe(false);
  });

  it('e idempotente: riapplicarlo non taglia altro', () => {
    const data = { seo: { description: OFFENDER } };
    clampSeoDescriptions(data);
    const once = data.seo.description;
    clampSeoDescriptions(data);
    expect(data.seo.description).toBe(once);
  });

  it('lascia intatta una description gia dentro il budget', () => {
    const fine = 'I numeri di oggi, 9 agosto 2026, per i frontalieri: attese ai valichi, benzina piu economica, cambio franco-euro e nuovi annunci di lavoro in Svizzera.';
    expect(fine.length).toBeLessThan(SEO_DESCRIPTION_MAX + 1);
    const data = { seo: { description: fine } };
    clampSeoDescriptions(data);
    expect(data.seo.description).toBe(fine);
  });

  it('non esplode su seo assente, vuoto o non-stringa', () => {
    for (const data of [{}, { seo: null }, { seo: {} }, { seo: { description: '' } }, { seo: { description: 42 } }]) {
      clampSeoDescriptions(data); // non deve lanciare
    }
    expect(true).toBe(true);
  });
});

// ── Wiring guard ───────────────────────────────────────────────────────────

describe('wiring', () => {
  it('registerArticleFiles applica il cap PRIMA di scrivere il file SEO', () => {
    const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');
    const body = sliceFn(src, 'export async function registerArticleFiles(data, opts = {}) {');
    const clampAt = body.indexOf('clampSeoDescriptions(data);');
    const writeAt = body.indexOf('modifySeoService(data);');
    expect(clampAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(clampAt).toBeLessThan(writeAt);
  });
});

// ── Scan sull'output pubblicato ────────────────────────────────────────────

/** Legge la stringa JS quotata che segue `pos`, rispettando gli escape. */
function readQuoted(src, pos) {
  const quote = src[pos];
  if (quote !== "'" && quote !== '"') return null;
  let out = '';
  for (let i = pos + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { out += src[i + 1]; i++; continue; }
    if (ch === quote) return out;
    if (ch === '\n') return null; // stringa non terminata sulla riga: non e' un letterale semplice
    out += ch;
  }
  return null;
}

describe('corpus pubblicato', () => {
  it(`nessuna description in content/seo/ supera i ${SITE_HARD_MAX} caratteri`, () => {
    const files = fs.readdirSync(SEO_DIR).filter((f) => f.startsWith('seo-blog') && f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    const offenders = [];
    let measured = 0;
    for (const file of files) {
      const src = fs.readFileSync(path.join(SEO_DIR, file), 'utf-8');
      for (const field of ['description', 'ogDescription']) {
        const needle = `\n    ${field}: `;
        let at = src.indexOf(needle);
        while (at !== -1) {
          const value = readQuoted(src, at + needle.length);
          if (value !== null) {
            measured++;
            if (value.length > SITE_HARD_MAX) {
              // Risali alla chiave dell'entry per un messaggio azionabile.
              const keyAt = src.lastIndexOf("\n  '", at);
              const key = keyAt === -1 ? '?' : src.slice(keyAt + 4, src.indexOf("'", keyAt + 4));
              offenders.push(`${file} ${key}.${field}: ${value.length} chars`);
            }
          }
          at = src.indexOf(needle, at + needle.length);
        }
      }
    }

    // Se lo scanner smette di trovare entry, il test deve rompersi, non passare.
    expect(measured).toBeGreaterThan(1000);
    expect(offenders.join('\n')).toBe('');
  });
});

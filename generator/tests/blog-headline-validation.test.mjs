/**
 * PORTATO da valerielinc-ops/frontaliere-si-o-no `tests/blog-headline-validation.test.ts`
 * (manifest: `adapted`) — la conformità Google News (task A5) dei titoli:
 * lunghezza 10-110 char, 2-22 parole, niente pattern clickbait.
 *
 * ## ADATTAMENTI rispetto al sito
 *  - `node:test` + expect-shim al posto di vitest; path `content/` al posto
 *    di `services/locales/`.
 *  - Il drift guard legge `../scripts/create-article.mjs` di QUESTO repo (la
 *    copia che genera i titoli), stessi anchor testuali del sito.
 *  - L'integrazione copre ANCHE `blog-meta-ch-it.ts`: la sezione svizzera si
 *    genera qui e sul sito era scoperta.
 *  - Il sito tiene l'asserzione stretta in `it.skip` e si limita a loggare gli
 *    offender. Qui l'asserzione è ATTIVA e STRICT su tutti i titoli
 *    pubblicati: la baseline degli offender storici (issue #58,
 *    HEADLINE_BASELINE_2026_08_08) è stata svuotata dopo averli accorciati
 *    sotto i 110 char, e rimossa insieme al ramo di tolleranza.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Intestazione originale del sito (estratto):
 *
 * Two layers of coverage: UNIT — `validateHeadline` against a curated sample
 * bank; INTEGRATION — every published article title must pass validation.
 * The validator lives in `scripts/create-article.mjs`; the local copy below
 * MUST stay equivalent — the drift test asserts the source still carries the
 * same rules.
 */
import { describe, it } from 'node:test';
import { expect } from './lib/expect-shim.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ──────────────────────────────────────────────────────────────────────────
// Local copy of the validator — kept in sync with scripts/create-article.mjs
// (the drift test below catches divergence).
// ──────────────────────────────────────────────────────────────────────────

const CLICKBAIT_PATTERNS = [
  // Italian
  /non\s+crederai/i,
  /scioccante/i,
  /incredibile/i,
  /sconvolgente/i,
  /ti\s+lascer[àa]\s+senza\s+parole/i,
  /clamoroso/i,
  /pazzesco/i,
  /\bspoiler\b/i,
  /quello\s+che\s+(non\s+)?sai/i,
  /ecco\s+(perch[ée]|cosa)\s+non\s+(crederai|immagini)/i,
  // English
  /you\s+won['’]?t\s+believe/i,
  /shocking/i,
  /mind[-\s]?blowing/i,
  /this\s+one\s+(weird\s+)?trick/i,
  // Punctuation tells
  /\?\?\?$/,
  /!{2,}$/,
];

function validateHeadline(headline) {
  const errs = [];
  if (typeof headline !== 'string' || headline.length === 0) {
    return ['Headline mancante o non stringa'];
  }
  if (headline.length < 10) errs.push('Headline troppo corto (min 10 char)');
  if (headline.length > 110) errs.push('Headline troppo lungo (max 110 char)');
  const wc = headline.trim().split(/\s+/).filter(Boolean).length;
  if (wc < 2 || wc > 22) errs.push(`Headline ${wc} parole, range 2-22`);
  if (CLICKBAIT_PATTERNS.some((p) => p.test(headline))) {
    errs.push('Pattern clickbait rilevato');
  }
  return errs;
}

// ──────────────────────────────────────────────────────────────────────────
// Unit tests — validator behaviour (banco del sito, verbatim)
// ──────────────────────────────────────────────────────────────────────────

describe('validateHeadline — A5 Google News compliance unit tests', () => {
  describe('passes well-formed journalistic headlines', () => {
    const good = [
      'Stipendio netto frontaliere 2026: come calcolarlo',
      'LAMal vs CMI: quale assicurazione scegliere',
      'Primo giorno da frontaliere: checklist completa',
      'Costo della vita: Ticino vs Lombardia',
      'Pilastro 3a: conviene al frontaliere?',
      'Tassa sulla salute: tensioni in aumento tra Italia e Ticino',
      'Cambio CHF-EUR: il franco forte spinge gli stipendi reali',
      'Comprare casa in Italia: quando il Ticino è troppo caro',
    ];
    for (const headline of good) {
      it(`accepts: "${headline}"`, () => {
        expect(validateHeadline(headline)).toEqual([]);
      });
    }
  });

  describe('rejects headlines that are too short or too long', () => {
    it('flags a 5-character headline as too short', () => {
      expect(validateHeadline('Brevi')).toContain('Headline troppo corto (min 10 char)');
    });

    it('flags a 200-character headline as too long', () => {
      const long = 'A'.repeat(120) + ' frontaliere ticino svizzera italia tasse pensione lavoro';
      expect(validateHeadline(long)).toContain('Headline troppo lungo (max 110 char)');
    });

    it('flags a single-word headline as out of range', () => {
      const errs = validateHeadline('Stipendio_netto_frontaliere');
      expect(errs.some((e) => e.includes('parole, range 2-22'))).toBe(true);
    });

    it('flags a 25-word headline as out of range', () => {
      const headline = Array.from({ length: 25 }, (_, i) => `parola${i}`).join(' ');
      const errs = validateHeadline(headline);
      expect(errs.some((e) => e.includes('parole, range 2-22'))).toBe(true);
    });
  });

  describe('rejects clickbait patterns (italian)', () => {
    const cases = [
      'Non crederai a quanto può guadagnare un frontaliere',
      'Scioccante: i nuovi dati sulle tasse 2026',
      'Incredibile cambiamento per i frontalieri ticinesi',
      'Sconvolgente: ecco la verità sui permessi G',
      'Ecco perché non crederai mai a queste statistiche',
      'Pazzesco quello che succede ai frontalieri oggi',
      'Clamoroso annuncio sulle tasse 2026',
    ];
    for (const headline of cases) {
      it(`flags as clickbait: "${headline}"`, () => {
        expect(validateHeadline(headline)).toContain('Pattern clickbait rilevato');
      });
    }
  });

  describe('rejects clickbait patterns (english)', () => {
    const cases = [
      "You won't believe what happens to Swiss workers",
      'You won’t believe these tax numbers', // curly apostrophe
      'Shocking new data on cross-border workers',
      'Mind-blowing changes to the Swiss-Italian agreement',
      'This one weird trick saves frontalieri thousands',
    ];
    for (const headline of cases) {
      it(`flags as clickbait: "${headline}"`, () => {
        expect(validateHeadline(headline)).toContain('Pattern clickbait rilevato');
      });
    }
  });

  describe('rejects punctuation tells', () => {
    it('flags trailing "???"', () => {
      expect(validateHeadline('Stipendio frontaliere in calo nel 2026???')).toContain('Pattern clickbait rilevato');
    });

    it('flags trailing "!!"', () => {
      expect(validateHeadline('Tasse frontalieri al ribasso!!')).toContain('Pattern clickbait rilevato');
    });

    it('flags trailing "!!!"', () => {
      expect(validateHeadline('Tasse frontalieri al ribasso!!!')).toContain('Pattern clickbait rilevato');
    });
  });

  describe('handles edge cases', () => {
    it('returns a single error for empty string', () => {
      expect(validateHeadline('')).toEqual(['Headline mancante o non stringa']);
    });

    it('returns a single error for non-string input', () => {
      expect(validateHeadline(undefined)).toEqual(['Headline mancante o non stringa']);
      expect(validateHeadline(123)).toEqual(['Headline mancante o non stringa']);
    });

    it('accepts the exact 10-char boundary', () => {
      expect(validateHeadline('Tasse 2026')).toEqual([]);
    });

    it('accepts the exact 110-char boundary', () => {
      const headline = 'Stipendi e tasse dei frontalieri ticinesi nel 2026: guida pratica al nuovo accordo fiscale Italia-Svizzera';
      expect(headline.length).toBe(106);
      expect(validateHeadline(headline)).toEqual([]);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Drift guard — the validator copied above must stay equivalent to the one
// exported from scripts/create-article.mjs (THIS repo's generator copy).
// ──────────────────────────────────────────────────────────────────────────

describe('validateHeadline — drift guard', () => {
  it('the validateHeadline+A5_CLICKBAIT_PATTERNS source in ../scripts/create-article.mjs matches the local copy', () => {
    const src = fs.readFileSync(path.join(ROOT, 'generator', 'scripts', 'create-article.mjs'), 'utf-8');

    expect(src).toMatch(/export\s+const\s+A5_CLICKBAIT_PATTERNS\s*=/);
    expect(src).toMatch(/export\s+function\s+validateHeadline\s*\(\s*headline\s*\)/);

    // Spot-check a few characteristic regex patterns from the A5 list
    expect(src).toContain('/non\\s+crederai/i');
    expect(src).toContain('/scioccante/i');
    expect(src).toContain('/sconvolgente/i');
    expect(src).toContain('/!{2,}$/');

    // Spot-check the rule constants
    expect(src).toContain('Headline troppo corto (min 10 char)');
    expect(src).toContain('Headline troppo lungo (max 110 char)');
    expect(src).toContain('Pattern clickbait rilevato');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Integration — every published article title passes A5, salvo la baseline
// datata sopra. Copre ENTRAMBE le sezioni (frontaliere + svizzera).
// ──────────────────────────────────────────────────────────────────────────

function loadPublishedTitles(metaFile) {
  const src = fs.readFileSync(path.join(ROOT, 'content', metaFile), 'utf-8');
  const re = /'blog\.article\.([^.']+)\.title'\s*:\s*'((?:\\'|[^'])+)'/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ id: m[1], title: m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\') });
  }
  return out;
}

describe('blog article headlines — A5 integration (STRICT)', () => {
  const published = [
    ...loadPublishedTitles('blog-meta-it.ts'),
    ...loadPublishedTitles('blog-meta-ch-it.ts'),
  ];

  it('finds a full corpus of published titles (a sparse checkout must NOT pass vacuously)', () => {
    expect(published.length).toBeGreaterThan(3000);
  });

  it('every published title passes validateHeadline', () => {
    const failures = [];

    for (const { id, title } of published) {
      const errors = validateHeadline(title);
      if (errors.length > 0) {
        failures.push(`  - ${id}: "${title.slice(0, 80)}" → ${errors.join('; ')}`);
      }
    }

    if (failures.length > 0) {
      console.error(`Titoli fuori norma A5:\n${failures.join('\n')}`);
    }
    expect(failures, 'titoli fuori norma A5 (elenco sopra)').toEqual([]);
  });
});

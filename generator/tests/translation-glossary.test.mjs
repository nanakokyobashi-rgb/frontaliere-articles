/**
 * translation-glossary.test.mjs — la voce `frontalier` del glossario di
 * post-traduzione (`generator/scripts/lib/translation-glossary.mjs`) non
 * marca nessuna regola `TITLE_ONLY`: tutte le sue correzioni girano anche sui
 * body (FAQ, descrizioni annuncio), non solo sui titoli. Issue #723
 * (follow-up di #664).
 *
 * ## PERCHE' QUESTA VOCE E' DIVERSA DALLE ALTRE SENZA `TITLE_ONLY`
 *
 * `nachtwache`/`wachstation`/`taktmontage`/`apfelbaum`/`monteur` hanno regole
 * body-safe perche' il testo che producono ("orologio notturno", "mela
 * albero", "mostro di servizio") NON e' mai la traduzione corretta di
 * nient'altro: puo' solo essere l'artefatto della mistraduzione nota. La voce
 * `frontalier` e' diversa: le sue correzioni riscrivono "border guards" /
 * "Grenzwächter" / "gardes-frontières" — frasi che SONO traduzioni corrette
 * quando un annuncio parla davvero di guardie di confine — gated solo sul
 * fatto che il testo SORGENTE contenga "frontalier", che essendo il tema
 * dell'intero sito compare in quasi ogni annuncio. Il rischio concreto e' un
 * body che nomina sia i frontalieri sia una guardia di confine vera nello
 * stesso annuncio: verrebbe corretto anche il secondo, non voluto.
 *
 * ## PERCHE' FIXTURE SUL CORPUS REALE E NON SOLO SINTETICHE
 *
 * La review (#723) chiedeva di verificare la collisione contro il corpus
 * reale, non solo argomentarla. Misurato qui su tutti gli annunci raccolti
 * (`data/jobs/by-crawler` + `data/jobs/expired/by-crawler`, ~55k record):
 * 172 record fanno scattare il trigger `frontalier` (flatten ricorsivo su
 * `requirementsByLocale`, che e' un array per locale e non una stringa —
 * un filtro piatto lo scartava silenziosamente, vedi `jobSearchableText`),
 * e ZERO di questi nominano anche vocabolario reale di guardia di
 * confine/dogana nello stesso record. Il rischio segnalato dal reviewer
 * come "basso" e' quindi verificato
 * vero sul corpus attuale — questo test lo rende un invariante testato, non
 * un'assunzione in un commento: se un futuro crawl introduce quella
 * coesistenza, questo gate lo scopre prima che la correzione parta silenziosa
 * sul body sbagliato.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSLATION_GLOSSARY, applyGlossaryCorrections } from '../scripts/lib/translation-glossary.mjs';
import { ITALIAN_BORDER_GUARD_ANCHOR } from '../scripts/lib/article-locale-lexicon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

const frontalierEntry = TRANSLATION_GLOSSARY.find((entry) => entry.trigger.source.includes('frontalier'));

// Real border-guard/customs vocabulary in the languages a crawled source
// description can be written in (it/de/fr) — the concrete phrasing a
// legitimate mention of an actual border guard would use, as opposed to the
// glossary's mistranslation-output vocabulary (which is EN/DE/FR).
//
// Issue #735 (follow-up of #723/#731): the previous version of this regex was
// a hand-written literal list ("guardia di confine", "doganier", ...) that
// missed inflected forms — plain "guardia" never matches the plural "guardie"
// (a vowel change, not a suffix, so substring matching can't bridge it), and
// it had no path to "agente/funzionario doganale" or the CURRENT official
// customs/border authority acronyms (UDSC/AFD/BAZG). The Italian half is
// therefore delegated to `ITALIAN_BORDER_GUARD_ANCHOR`
// (article-locale-lexicon.mjs) instead of re-deriving a second copy of the
// same vocabulary: it already stems for singular/plural (`guardi\w*`,
// `dogan\w*`, `confinari\w*`) and already carries those acronyms, having been
// built and tuned against the same real corpus for the same false-friend
// class (AGENTS.md #6 — one source for a shared value).
//
// Kept as ONE regex per LANGUAGE, not merged into one: crawled records carry
// per-locale text (`titleByLocale`/`descriptionByLocale`/`requirementsByLocale`),
// and a merged pattern tested against the whole multi-language blob cross-
// contaminates languages — measured live here: the Italian anchor's
// `finanzier\w*` (guardia di finanza officer) also matches the unrelated
// German word "Finanzierung" (financing), which flagged 54 real records as
// false-positive collisions the first time this was tried unscoped. Each
// regex below is applied only to the text collected under its own locale key
// (see `collectLocaleTexts`), which is what actually eliminates the
// cross-language false positive instead of just special-casing this one word.
const REAL_BORDER_GUARD_VOCAB_BY_LOCALE = {
  it: new RegExp(`(?:${ITALIAN_BORDER_GUARD_ANCHOR.source})|\\bcgcf\\b`, 'i'),
  de: /grenzwache\b|grenzwacht\w*|grenzw(?:ä|ae)chter\w*|grenzsch(?:ü|ue)tz\w*|grenzbeamt\w*|\bgwk\b/i,
  fr: /garde-fronti[eè]re\w*|gardes-fronti[eè]res?|douanier\w*/i,
  en: /border\s+guards?|frontier\s+guards?|customs\s+officers?/i,
};
// Union of all locale patterns — for asserting vocabulary coverage in the
// abstract (below), independent of which language field it lives in.
const REAL_BORDER_GUARD_VOCAB_RE = new RegExp(
  Object.values(REAL_BORDER_GUARD_VOCAB_BY_LOCALE)
    .map((re) => `(?:${re.source})`)
    .join('|'),
  'i',
);

function jobDirs() {
  return ['data/jobs/by-crawler', 'data/jobs/expired/by-crawler']
    .map((rel) => path.join(REPO_ROOT, rel))
    .filter((dir) => fs.existsSync(dir));
}

// Only the text fields a description/title/requirement can realistically
// live in — not the whole record (company name, URLs, etc. are noise a
// human wouldn't call "the same sentence").
const TEXT_FIELDS = ['title', 'titleByLocale', 'description', 'descriptionByLocale', 'requirements', 'requirementsByLocale'];

function collectStrings(value, parts) {
  if (typeof value === 'string') parts.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, parts);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, parts);
}

function jobSearchableText(job) {
  const parts = [];
  for (const field of TEXT_FIELDS) collectStrings(job[field], parts);
  return parts.join('\n');
}

const KNOWN_VOCAB_LOCALES = Object.keys(REAL_BORDER_GUARD_VOCAB_BY_LOCALE);

// Buckets text by the language it is actually written in, so the collision
// check below can apply each locale's vocabulary only to its own text
// instead of a merged multi-language blob (see REAL_BORDER_GUARD_VOCAB_BY_LOCALE
// above for why that cross-contaminates). `title`/`description`/`requirements`
// are the flat, single-language originals — attributed to `job.sourceLang` —
// while the `*ByLocale` companions are already split by locale key. Text
// whose language can't be attributed (missing/unknown `sourceLang`, or a
// locale key outside it/en/de/fr) falls into `other`, which the corpus scan
// below checks against every language's vocabulary — the same conservative,
// false-negative-safe behaviour this test had before locale-scoping existed.
function collectLocaleTexts(job) {
  const byLocale = { it: [], en: [], de: [], fr: [] };
  const other = [];
  const src = String(job.sourceLang || '').toLowerCase();
  const targetForFlatField = KNOWN_VOCAB_LOCALES.includes(src) ? byLocale[src] : other;

  for (const field of ['title', 'description', 'requirements']) {
    collectStrings(job[field], targetForFlatField);
  }
  for (const field of ['titleByLocale', 'descriptionByLocale', 'requirementsByLocale']) {
    const value = job[field];
    if (!value || typeof value !== 'object') continue;
    for (const [locale, localeValue] of Object.entries(value)) {
      collectStrings(localeValue, KNOWN_VOCAB_LOCALES.includes(locale) ? byLocale[locale] : other);
    }
  }
  return { byLocale, other };
}

describe('translation-glossary: frontalier body-safety (issue #723)', () => {
  it('has no TITLE_ONLY guard on any of its rules (documents current shape)', () => {
    assert.ok(frontalierEntry, 'frontalier entry must exist in TRANSLATION_GLOSSARY');
    const allRules = Object.values(frontalierEntry.fixes).flat();
    assert.ok(allRules.length > 0);
    for (const [, , opts] of allRules) {
      assert.ok(!opts?.titleOnly, 'this test\'s corpus scan assumes these rules run on bodies too');
    }
  });

  it('rewrites the known mistranslation compound on a description body (fieldType=description)', () => {
    const out = applyGlossaryCorrections({
      sourceText: 'Cerchiamo frontalieri per il turno di notte.',
      translatedText: 'We are looking for border guards for the night shift.',
      targetLang: 'en',
      fieldType: 'description',
    });
    assert.equal(out, 'We are looking for cross-border commuters for the night shift.');
  });

  it('REAL_BORDER_GUARD_VOCAB_RE covers inflected/synonym forms a literal list missed (issue #735)', () => {
    const shouldMatch = [
      'guardie di confine',           // IT plural — "guardia" never matched "guardie"
      'Corpo delle Guardie di confine',
      'agente doganale',              // customs vocab not gated on "guardia"
      'funzionario doganale',
      'guardia di finanza',
      'polizia di frontiera',
      'guardie confinarie',           // adjective plural
      'UDSC',                         // current Swiss customs/border authority acronyms
      'AFD',
      'BAZG',
      'Grenzwächterin',
      'Grenzwachtkorps',
      'GWK',
      'gardes-frontières',
      'douaniers',
      'customs officers',
    ];
    for (const phrase of shouldMatch) {
      assert.ok(REAL_BORDER_GUARD_VOCAB_RE.test(phrase), `expected a match for "${phrase}"`);
    }
  });

  it('real crawled corpus: zero records mention frontalieri and a real border guard together', () => {
    const dirs = jobDirs();
    assert.ok(dirs.length > 0, 'expected at least one data/jobs crawler directory to exist');

    let recordsScanned = 0;
    let triggerHits = 0;
    const collisions = [];

    for (const dir of dirs) {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        let data;
        try {
          data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        } catch {
          continue; // not this test's concern — covered by JSON-validity gates elsewhere
        }
        const jobs = Array.isArray(data) ? data : (Array.isArray(data.jobs) ? data.jobs : []);
        for (const job of jobs) {
          recordsScanned++;
          if (!frontalierEntry.trigger.test(jobSearchableText(job))) continue;
          triggerHits++;
          const { byLocale, other } = collectLocaleTexts(job);
          const otherText = other.join('\n');
          const hasCollision = KNOWN_VOCAB_LOCALES.some((locale) =>
            REAL_BORDER_GUARD_VOCAB_BY_LOCALE[locale].test(`${byLocale[locale].join('\n')}\n${otherText}`),
          );
          if (hasCollision) {
            collisions.push({ file, id: job.id || job.slug });
          }
        }
      }
    }

    assert.ok(recordsScanned > 1000, `expected a substantial corpus, got ${recordsScanned} records`);
    assert.deepEqual(
      collisions,
      [],
      `found ${collisions.length} job record(s) mentioning both frontalieri and a real border guard — ` +
        'the frontalier glossary rules would corrupt a legitimate mention: ' + JSON.stringify(collisions),
    );
  });
});

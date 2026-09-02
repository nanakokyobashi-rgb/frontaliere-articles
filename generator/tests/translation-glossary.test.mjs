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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

const frontalierEntry = TRANSLATION_GLOSSARY.find((entry) => entry.trigger.source.includes('frontalier'));

// Real border-guard/customs vocabulary in the languages a crawled source
// description can be written in (it/de/fr) — the concrete phrasing a
// legitimate mention of an actual border guard would use, as opposed to the
// glossary's mistranslation-output vocabulary (which is EN/DE/FR).
const REAL_BORDER_GUARD_VOCAB_RE =
  /guardia di confine|guardia doganale|guardia di frontiera|guardia confinaria|corpo delle guardie di confine|\bcgcf\b|grenzwache\b|grenzwächter|grenzwaechter|grenzschütz|grenzschuetz|grenzbeamt|garde-fronti[eè]re|gardes-fronti[eè]re|douanier|doganier|border guard|frontier guard/i;

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
          const text = jobSearchableText(job);
          if (!frontalierEntry.trigger.test(text)) continue;
          triggerHits++;
          if (REAL_BORDER_GUARD_VOCAB_RE.test(text)) {
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

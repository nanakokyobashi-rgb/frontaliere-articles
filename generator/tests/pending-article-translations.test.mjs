import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_PENDING_TRANSLATION_ATTEMPTS,
  claimPendingTranslationDraft,
  clearPendingTranslationFields,
  listPendingTranslationDrafts,
  missingPendingTranslationFields,
  pendingTranslationFieldDescriptors,
  removePendingTranslationDraft,
  writePendingTranslationDraft,
} from '../scripts/lib/pending-article-translations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CREATE_ARTICLE = fs.readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf8');

function sampleArticle() {
  const italian = {
    title: 'Il permesso G in Ticino',
    excerpt: 'Una guida aggiornata al permesso per lavorare oltre confine.',
    body1: 'Il permesso G consente di lavorare in Svizzera e rientrare nel paese di residenza.',
    faq: [{ q: 'Che cos’è il permesso G?', a: 'È un permesso per le persone che lavorano oltre confine.' }],
  };
  return {
    id: 'permesso-g-ticino',
    content: {
      it: italian,
      en: {
        title: 'The G permit in Ticino',
        excerpt: 'An updated guide to the permit for cross-border work.',
        body1: 'The G permit lets people work in Switzerland and return to their country of residence.',
        faq: [{ q: 'What is the G permit?', a: 'It is a permit for people who work across the border.' }],
      },
      de: {
        title: italian.title,
        excerpt: 'Ein aktueller Leitfaden zur Bewilligung für die Arbeit über die Grenze.',
        body1: 'Die G-Bewilligung erlaubt die Arbeit in der Schweiz mit Rückkehr ins Wohnsitzland.',
        faq: [{ q: italian.faq[0].q, a: 'Es ist eine Bewilligung für Personen, die über die Grenze pendeln.' }],
      },
      fr: {
        title: 'Le permis G au Tessin',
        excerpt: 'Guide actualisé du permis pour travailler au-delà de la frontière.',
        faq: [{ q: 'Qu’est-ce que le permis G ?', a: 'C’est un permis pour les personnes qui travaillent de l’autre côté de la frontière.' }],
      },
    },
  };
}

function draftFor(data, overrides = {}) {
  const now = '2026-11-28T10:00:00.000Z';
  return {
    schema: 1,
    section: 'frontaliere',
    articleId: data.id,
    sourceUrl: 'https://example.test/permesso-g',
    sourceContext: { headline: 'Il permesso G in Ticino' },
    pageContent: 'Fonte verificata: il permesso G consente di lavorare oltre confine.',
    sourceDate: '2026-11-27T08:00:00.000Z',
    sourceTitle: 'Il permesso G in Ticino',
    data,
    attempts: 1,
    missingFields: missingPendingTranslationFields(data),
    createdAt: now,
    updatedAt: now,
    verifiedAt: now,
    ...overrides,
  };
}

test('the recovery inventory identifies only unusable or Italian-passthrough fields', () => {
  const article = sampleArticle();
  const missing = missingPendingTranslationFields(article);
  assert.deepEqual(missing, [
    'de.title',
    'de.faq[0].q',
    'fr.body1',
  ]);
  assert.equal(pendingTranslationFieldDescriptors(article).length, 15);

  clearPendingTranslationFields(article, missing);
  assert.deepEqual(missingPendingTranslationFields(article), missing);
  assert.equal(article.content.en.body1, 'The G permit lets people work in Switzerland and return to their country of residence.');
  assert.equal(article.content.de.body1, 'Die G-Bewilligung erlaubt die Arbeit in der Schweiz mit Rückkehr ins Wohnsitzland.');
  assert.equal(article.content.de.faq[0].a, 'Es ist eine Bewilligung für Personen, die über die Grenze pendeln.');
  assert.equal(article.content.de.title, undefined);
  assert.equal(article.content.de.faq[0].q, undefined);
  assert.equal(article.content.fr.body1, undefined);
});

test('claims consume a durable attempt before work and stop at the three-attempt limit', () => {
  assert.equal(MAX_PENDING_TRANSLATION_ATTEMPTS, 3);
  const article = sampleArticle();
  const first = draftFor(article);
  const second = claimPendingTranslationDraft(first, { now: '2026-11-29T10:00:00.000Z' });
  const third = claimPendingTranslationDraft(second, { now: '2026-11-30T10:00:00.000Z' });

  assert.equal(first.attempts, 1);
  assert.equal(second.attempts, 2);
  assert.equal(third.attempts, 3);
  assert.equal(third.updatedAt, '2026-11-30T10:00:00.000Z');
  assert.equal(claimPendingTranslationDraft(third), null);
});

test('drafts are atomic, section-scoped, resumable, and removable', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-article-translations-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const article = sampleArticle();
  const first = draftFor(article);

  assert.deepEqual(listPendingTranslationDrafts(directory, 'frontaliere'), []);
  assert.throws(
    () => writePendingTranslationDraft(directory, 'frontaliere', { ...first, articleId: 'different-id' }),
    /identity does not match/u,
  );
  assert.equal(writePendingTranslationDraft(directory, 'frontaliere', first).saved, true);
  const stored = listPendingTranslationDrafts(directory, 'frontaliere');
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0], first);
  assert.equal(fs.readdirSync(directory).length, 1);
  assert.match(fs.readdirSync(directory)[0], /^[a-f0-9]{64}\.json$/u);
  assert.throws(() => listPendingTranslationDrafts(directory, 'svizzera'), /section/u);

  const thirdAttempt = { ...first, attempts: 3, updatedAt: '2026-11-30T10:00:00.000Z' };
  assert.equal(writePendingTranslationDraft(directory, 'frontaliere', thirdAttempt).exhausted, true);
  assert.equal(listPendingTranslationDrafts(directory, 'frontaliere')[0].attempts, 3);
  assert.equal(removePendingTranslationDraft(directory, article.id), true);
  assert.deepEqual(listPendingTranslationDrafts(directory, 'frontaliere'), []);
  assert.equal(removePendingTranslationDraft(directory, article.id), false);
});

test('the CLI prioritizes stored drafts, skips full locale batches on resume, and gates publication', () => {
  assert.match(CREATE_ARTICLE, /TRANSLATION_RESUME section=\$\{SECTION_NAME\}/u);
  assert.match(CREATE_ARTICLE, /claimPendingTranslationDraft\(nextDraft\)/u);
  assert.match(CREATE_ARTICLE, /translateArticle\(data, \{ resumeOnlyMissing: Boolean\(pendingTranslationDraft\) \}\)/u);
  assert.match(CREATE_ARTICLE, /clearPendingTranslationFields\(data, pendingTranslationDraft\.missingFields\)/u);
  assert.match(CREATE_ARTICLE, /TRANSLATION_EXHAUSTED section=\$\{SECTION_NAME\}/u);
  assert.match(CREATE_ARTICLE, /pending translation recovery exhausted after \$\{MAX_PENDING_TRANSLATION_ATTEMPTS\}\/\$\{MAX_PENDING_TRANSLATION_ATTEMPTS\} attempts/u);
  const exhaustedStart = CREATE_ARTICLE.indexOf('const exhaustedDrafts = drafts.filter');
  const nextDraftStart = CREATE_ARTICLE.indexOf('const nextDraft = listPendingTranslationDrafts', exhaustedStart);
  assert.ok(exhaustedStart >= 0 && nextDraftStart > exhaustedStart, 'il budget esaurito deve essere gestito prima di un nuovo candidato');
  const exhaustedBlock = CREATE_ARTICLE.slice(exhaustedStart, nextDraftStart);
  assert.match(exhaustedBlock, /removePendingTranslationDraft\(PENDING_TRANSLATION_DIR, draft\.articleId\)/u);
  assert.match(exhaustedBlock, /finalizeRunReport\('deferred'/u);
  assert.match(exhaustedBlock, /exitAfterFlush\(EXIT_NO_ARTICLE_DECLARED\)/u);

  const finalCompleteness = CREATE_ARTICLE.indexOf('const missingBeforePublish = missingPendingTranslationFields(data);');
  const firstWriteLock = CREATE_ARTICLE.indexOf('beginRegisterLock(data.id);', finalCompleteness);
  const firstGitStage = CREATE_ARTICLE.indexOf('gitAddAll(data);', firstWriteLock);
  const successfulDraftRemoval = CREATE_ARTICLE.indexOf(
    'removePendingTranslationDraft(PENDING_TRANSLATION_DIR, data.id);',
    firstGitStage,
  );
  assert.ok(finalCompleteness >= 0, 'manca il controllo finale di completezza');
  assert.ok(firstWriteLock > finalCompleteness, 'il writer deve restare dopo il controllo di completezza');
  assert.ok(firstGitStage > firstWriteLock, 'lo staging deve seguire il writer e i controlli di qualità');
  assert.ok(successfulDraftRemoval > firstGitStage, 'il draft si rimuove solo dopo lo staging completo');
  assert.match(CREATE_ARTICLE, /if \(e\?\.pendingTranslationIncomplete\) throw e;/u);
});

#!/usr/bin/env node
/**
 * Warn when this repo lost the `journalist_articles` publish race (issue
 * #291, follow-up of #284).
 *
 * THE RACE
 *
 * This repo and the sibling site repo (valerielinc-ops/frontaliere-si-o-no)
 * both run their own copy of the journalist-publish pipeline against the
 * SAME Firestore `journalist_articles` queue, on independent schedules.
 * Whichever side processes a `status: 'queued'` doc first stamps it
 * `published` (with the winning side's registered `slugs`) — the loser's
 * query for `status == 'queued'` simply never sees that doc again, so its
 * local corpus never gets the article. Nothing about that failure is loud:
 * it only surfaces downstream, when the site's `pull-articles-corpus.mjs`
 * fails closed on a PR that happens to need the missing article.
 *
 * Fixing the race itself needs either a change in the sibling repo or a
 * decision to retire one of the two publishers — both out of this script's
 * reach (cross-repo / product decision, tracked as item 1 of #291). What IS
 * in reach from this side: noticing. This script queries Firestore for
 * recently-published docs and checks each one's registered id against this
 * repo's own corpus (`checkArticleIdExists`, the same registry lookup the
 * publish pipeline itself uses). A published doc this repo has no local
 * record of is exactly a race this repo lost.
 *
 * DELIBERATELY NON-BLOCKING. Failing the workflow here would feed
 * `workflow-failure-issues.yml`, which would open/reopen an issue every run
 * until item 1 is resolved — a recurring-burn loop the fixer has no way to
 * close (the fix isn't in this repo), exactly the pattern
 * `harvest-agent-lessons.mjs` flags as wasted spend. So this only emits
 * `::warning::` annotations plus a `lost_ids` GITHUB_OUTPUT for the calling
 * workflow's summary — visible to a human, invisible to the auto-issue loop.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> node generator/scripts/check-journalist-publish-race.mjs
 *   node generator/scripts/check-journalist-publish-race.mjs --help
 *
 * Bounded to docs published in the last LOOKBACK_DAYS days (default 14) —
 * old races are either already reconciled by hand or not actionable anymore,
 * and an unbounded query would grow strictly with the corpus's lifetime.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: node generator/scripts/check-journalist-publish-race.mjs\n' +
      '  Reports (non-blocking) journalist_articles docs Firestore says are\n' +
      '  published but this repo has no local record of — i.e. the sibling\n' +
      '  publisher won the race for them (issue #291).',
  );
  process.exit(0);
}

const LOOKBACK_DAYS = 14;

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * Pure comparison, unit-testable without Firestore: given the published docs
 * Firestore reports and the set of ids this repo's own corpus already has,
 * returns the ones this repo has no local record of.
 */
export function findLostRaceArticles(publishedDocs, hasLocalId) {
  const lost = [];
  for (const doc of publishedDocs) {
    const articleId = doc.slugs?.it || slugify(doc.id);
    if (!hasLocalId(articleId)) {
      lost.push({ docId: doc.id, articleId, publishedAt: doc.publishedAt ?? null });
    }
  }
  return lost;
}

async function main() {
  const { checkArticleIdExists } = await import('./create-article.mjs');

  let publishedDocs;
  try {
    const admin = (await import('firebase-admin')).default;
    if (!admin.apps?.length) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'frontaliere-ticino',
      });
    }
    const db = admin.firestore();

    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const snap = await db
      .collection('journalist_articles')
      .where('status', '==', 'published')
      .where('publishedAt', '>=', cutoff)
      .get();

    publishedDocs = snap.docs.map((docSnap) => {
      const data = docSnap.data();
      return {
        id: docSnap.id,
        slugs: data.slugs,
        publishedAt: data.publishedAt?.toDate?.().toISOString() ?? null,
      };
    });
  } catch (err) {
    // Observability-only: a Firestore hiccup here must not fail the calling
    // workflow over a check that is not the thing it exists to do (mirrors
    // refresh-border-wait-averages.mjs's "cosmetic overlay" reasoning).
    const message = err instanceof Error ? err.message : String(err);
    console.log(`::warning::[check-journalist-publish-race] could not query Firestore, skipping this run: ${message}`);
    return;
  }

  const lost = findLostRaceArticles(publishedDocs, checkArticleIdExists);

  console.log(
    `[check-journalist-publish-race] ${publishedDocs.length} published doc(s) checked, ${lost.length} missing locally.`,
  );

  for (const entry of lost) {
    console.log(
      `::warning::[check-journalist-publish-race] journalist_articles/${entry.docId} ` +
        `(id "${entry.articleId}", published ${entry.publishedAt ?? 'unknown'}) is published in Firestore ` +
        'but absent from this repo\'s corpus — the sibling publisher won this race (issue #291).',
    );
  }

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    fs.appendFileSync(githubOutput, `lost_ids=${JSON.stringify(lost.map((e) => e.articleId))}\n`);
  }
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[check-journalist-publish-race] FATAL:', err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
}

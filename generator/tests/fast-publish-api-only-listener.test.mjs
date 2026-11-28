import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  decideApiOnlyDispatch,
  matchesFastPublishPushPaths,
  matchesWorkflowPushPaths,
} from '../../scripts/ci/fast-publish-api-only-decision.mjs';

const workflowPath = new URL('../../.github/workflows/fast-publish-section.yml', import.meta.url);
const listenerWorkflowPath = new URL('../../.github/workflows/fast-publish-api-only-listener.yml', import.meta.url);
const fastWorkflow = readFileSync(workflowPath, 'utf8');
const listenerWorkflow = readFileSync(listenerWorkflowPath, 'utf8');
const publishApiWorkflow = readFileSync(new URL('../../.github/workflows/publish-api.yml', import.meta.url), 'utf8');

const liveTarget = (section) => ({ section, ids: [], bootstrap: true });

test('il filtro owner replica i paths del trigger push Fast Publish', () => {
  assert.equal(matchesFastPublishPushPaths({
    workflow: fastWorkflow,
    changedPaths: ['content/cantons/canton-ti/articles/example.json'],
  }), true);
  assert.equal(matchesFastPublishPushPaths({
    workflow: fastWorkflow,
    changedPaths: ['scripts/lib/article-render-pipeline.mjs'],
  }), true);
  assert.equal(matchesFastPublishPushPaths({
    workflow: fastWorkflow,
    changedPaths: ['content/blog-body/it/national.ts'],
  }), false, 'input nazionale non crea un Fast push owner cantonale');
  assert.equal(matchesFastPublishPushPaths({
    workflow: fastWorkflow,
    changedPaths: ['README.md'],
  }), false);
});

test('il push API owner segue il filtro publish-api e impedisce un dispatch API duplicato', () => {
  assert.equal(matchesWorkflowPushPaths({
    workflow: publishApiWorkflow,
    changedPaths: ['content/cantons/canton-ti/articles/example.json'],
  }), true);
  assert.equal(matchesWorkflowPushPaths({
    workflow: publishApiWorkflow,
    changedPaths: ['scripts/lib/article-render-pipeline.mjs'],
  }), true);
  assert.equal(matchesWorkflowPushPaths({
    workflow: publishApiWorkflow,
    changedPaths: ['public/images/unwatched-assets/icon.svg'],
  }), false);
});

test('marker API Fast e push coperti non creano dispatch Fast di follow-up', () => {
  const marker = decideApiOnlyDispatch({
    markedFastPublishRange: true,
    reconciliationTargets: [liveTarget('canton-ti')],
  });
  assert.deepEqual(marker, { skip: true, reason: 'direct-fast-publish-marker', targets: [] });

  const owner = decideApiOnlyDispatch({
    isPush: true,
    fastPushOwner: matchesFastPublishPushPaths({
      workflow: fastWorkflow,
      changedPaths: ['content/blog-body-canton-ti/it/example.ts'],
    }),
    apiLocalTargets: [liveTarget('canton-ti')],
    reconciliationTargets: [liveTarget('canton-ti')],
  });
  assert.deepEqual(owner, { skip: true, reason: 'direct-push-fast-publish-owner', targets: [] });
});

test('il listener dispatcha un run per target API-only e salta gli input senza sezione R2', () => {
  const apiOnly = decideApiOnlyDispatch({
    isPush: true,
    fastPushOwner: false,
    apiLocalTargets: [liveTarget('canton-gr')],
    reconciliationTargets: [liveTarget('canton-gr'), liveTarget('canton-ti')],
  });
  assert.equal(apiOnly.skip, false);
  assert.deepEqual(apiOnly.targets.map(({ section }) => section), ['canton-gr']);
  assert.equal(apiOnly.targets.length, 1, 'Fast dispatch count equals API-local target sections');

  const nationalOnly = decideApiOnlyDispatch({
    isPush: true,
    fastPushOwner: false,
    apiLocalTargets: [],
    reconciliationTargets: [liveTarget('canton-ti')],
  });
  assert.deepEqual(nationalOnly, { skip: true, reason: 'no-r2-api-targets', targets: [] });

  const apiCodeOnly = decideApiOnlyDispatch({
    isPush: true,
    fastPushOwner: false,
    apiLocalTargets: [],
    reconciliationTargets: [liveTarget('canton-ti')],
  });
  assert.deepEqual(apiCodeOnly, { skip: true, reason: 'no-r2-api-targets', targets: [] });
});

test('i cleanup-only del registry edge sopravvivono allo scope API-only', () => {
  const cleanup = {
    section: 'canton-zz',
    ids: [],
    bootstrap: false,
    removeStaleCantonRssFeeds: true,
    cleanupInactiveSurface: true,
  };
  const pushCleanup = decideApiOnlyDispatch({
    isPush: true,
    fastPushOwner: false,
    apiLocalTargets: [],
    reconciliationTargets: [cleanup],
  });
  assert.equal(pushCleanup.skip, false);
  assert.deepEqual(pushCleanup.targets, [cleanup]);

  const scheduledCleanup = decideApiOnlyDispatch({
    isPush: false,
    reconciliationTargets: [liveTarget('canton-ti'), cleanup],
  });
  assert.deepEqual(scheduledCleanup, { skip: true, reason: 'non-push-api-event', targets: [] });
});

test('il listener non fan-outa publish-api manuali o schedule non marcati', () => {
  for (const event of ['schedule', 'workflow_dispatch']) {
    const decision = decideApiOnlyDispatch({
      isPush: false,
      markedFastPublishRange: false,
      reconciliationTargets: [liveTarget('canton-ti'), liveTarget('canton-gr')],
    });
    assert.deepEqual(decision, { skip: true, reason: 'non-push-api-event', targets: [] }, event);
  }
  assert.deepEqual(decideApiOnlyDispatch({
    isPush: false,
    markedFastPublishRange: true,
    reconciliationTargets: [liveTarget('canton-ti')],
  }), { skip: true, reason: 'direct-fast-publish-marker', targets: [] });
});

test('solo il listener non-Fast ascolta il completamento publish-api', () => {
  assert.doesNotMatch(fastWorkflow, /^  workflow_run:/mu);
  assert.match(listenerWorkflow, /workflows: \['Publish article data API'\]/u);
  assert.match(listenerWorkflow, /github\.event\.workflow_run\.conclusion == 'success'/u);
  assert.match(listenerWorkflow, /scripts\/ci\/fast-publish-api-only-listener\.sh/u);
  assert.match(listenerWorkflow, /github\.event\.workflow_run\.event == 'push'/u, 'solo push API-only possono creare dispatch Fast');
  const source = readFileSync(new URL('../../scripts/ci/fast-publish-api-only-listener.sh', import.meta.url), 'utf8');
  assert.match(source, /--fast-push-trigger "\$before" "\$after" \.github\/workflows\/fast-publish-section\.yml/u);
  assert.match(source, /gh workflow run fast-publish-section\.yml/u);
  assert.match(source, /api_release_commit=\$WORKFLOW_RUN_HEAD_SHA/u);
  assert.match(source, /WORKFLOW_RUN_EVENT" != 'push'[\s\S]*?dispatch_count=0[\s\S]*?exit 0/u);
  assert.doesNotMatch(source, /gh run list|actions\/runs.*poll/u);
  assert.match(source, /done < <\(jq -c '\.\[\]' <<<"\$targets"\)/u);
});

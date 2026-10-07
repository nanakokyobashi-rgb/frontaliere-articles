import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acknowledgeImageRegenerationOutbox } from '../../scripts/ci/ack-image-regeneration-outbox.mjs';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cover-publisher-ack-'));
}

function writeOutbox(root, items) {
  const file = path.join(root, 'data/image-regeneration-publish-outbox.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ schema: 1, items }, null, 2)}\n`);
}

test('il publisher chiude solo gli id della propria sezione e richiesta', () => {
  const root = tempRoot();
  try {
    writeOutbox(root, [
      { articleId: 'front-a', section: 'frontaliere' },
      { articleId: 'front-b', section: 'frontaliere' },
      { articleId: 'canton-a', section: 'canton-ti' },
      { articleId: 'front-a', section: 'frontaliere' },
    ]);

    const acknowledged = acknowledgeImageRegenerationOutbox({
      root,
      section: 'frontaliere',
      articleIds: ['front-a'],
      requestId: 'queued-covers-test-frontaliere',
    });

    assert.equal(acknowledged, 2);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, 'data/image-regeneration-publish-outbox.json'), 'utf8')).items,
      [
        { articleId: 'front-b', section: 'frontaliere' },
        { articleId: 'canton-a', section: 'canton-ti' },
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('il wiring ackera dopo il publisher e non dal drain', () => {
  const root = path.resolve(new URL('../..', import.meta.url).pathname);
  const drain = fs.readFileSync(path.join(root, '.github/workflows/regenerate-queued-covers.yml'), 'utf8');
  const article = fs.readFileSync(path.join(root, '.github/workflows/fast-publish-article.yml'), 'utf8');
  const section = fs.readFileSync(path.join(root, '.github/workflows/fast-publish-section.yml'), 'utf8');
  const helper = fs.readFileSync(path.join(root, 'scripts/ci/ack-image-regeneration-outbox.sh'), 'utf8');

  assert.match(drain, /--field drain_ack_request="\$request_id"/);
  assert.doesNotMatch(drain, /name: Acknowledge cover publisher outbox/);
  assert.match(article, /drain_ack_request:/);
  assert.match(section, /drain_ack_request:/);
  assert.match(article, /success\(\).*drain_ack_request/);
  assert.match(section, /success\(\).*drain_ack_request/);
  assert.ok(article.indexOf('name: Acknowledge queued cover outbox') > article.indexOf('name: Re-purge the edge cache after the verification'));
  assert.ok(section.indexOf('name: Acknowledge queued cover outbox') > section.indexOf('name: Render, validate and publish the section pages'));
  assert.match(helper, /git reset --hard origin\/main/);
  assert.doesNotMatch(helper, /push\s+--force/);
});

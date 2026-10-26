import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  CDN,
  hasExpectedStagingBody,
  publishRelease,
  releaseBase,
} from '../../scripts/publish-section-edge.mjs';
import { EDGE_SECTION_REGISTRY_FILE } from '../../scripts/lib/section-registry.mjs';

const bytes = Buffer.from('staging-fixture');
const file = {
  name: 'sitemap-cantons.xml',
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};

test('la verifica staging rifiuta un 200 senza body senza lanciare', () => {
  assert.equal(hasExpectedStagingBody({ status: 200 }, file), false);
  assert.equal(hasExpectedStagingBody({ status: 200, body: bytes }, file), true);
});

test('publishRelease resta fail-closed quando un adapter CDN restituisce 200 senza body', async () => {
  const commit = 'a'.repeat(40);
  const base = releaseBase(commit);
  const key = `${base}${file.name}`;
  const release = {
    commit,
    base,
    registry: { schema: 1, commit, sections: {} },
    live: [],
    files: [{ ...file, local: '/tmp/staging-fixture', key }],
    pointer: {
      schema: 1,
      commit,
      sections: {},
      release: {
        commit,
        base,
        files: { [file.name]: { sha256: file.sha256, bytes: file.bytes } },
        previous: null,
      },
    },
  };
  const removed = [];
  const requests = [];
  const result = await publishRelease(release, {
    env: {
      R2_ACCESS_KEY_ID: 'test',
      R2_SECRET_ACCESS_KEY: 'test',
      R2_S3_ENDPOINT: 'test',
      R2_BUCKET: 'test',
      CF_API_TOKEN: 'test',
    },
    io: {
      fetchBytes: async (url) => {
        requests.push(url);
        if (url === `${CDN}/${EDGE_SECTION_REGISTRY_FILE}`) return { status: 404 };
        return { status: 200 };
      },
      upload: () => true,
      remove: (stagedKey) => {
        removed.push(stagedKey);
        return true;
      },
      acquireBootstrapLock: async () => 'acquired',
      releaseBootstrapLock: async () => true,
      purge: () => true,
      putRegistry: () => true,
    },
    stagingVerifyAttempts: 1,
    log: () => {},
  });

  assert.deepEqual(result, { code: 1, phase: 'staging', flipped: false });
  assert.deepEqual(removed, [key]);
  assert.equal(requests.length, 2);
});

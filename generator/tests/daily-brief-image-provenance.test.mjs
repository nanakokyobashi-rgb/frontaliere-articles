import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appendGeneratedImageRecord,
  buildPublishedBlogImageRegistry,
  imageRecordForPath,
  sha256File,
} from '../scripts/lib/blog-image-registry.mjs';
import { buildDailyBriefImageRecord } from '../scripts/lib/daily-brief-image.mjs';
import { DETERMINISTIC_CARD_KIND } from '../scripts/lib/deterministic-card-provenance.mjs';
import { validateGeneratedImageRecord } from '../../engine/shared/generatedImageRegistry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-brief-image-provenance-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/generated-image-registry.json'), '{"schema":1,"assetCount":0,"assets":[]}\n');
  return root;
}

test('the daily card uses the existing site-owned schema without provider or vision fields', () => {
  const root = tempRoot();
  try {
    const id = 'bollettino-frontaliere-2026-10-07';
    const image = path.join(root, 'public/images/blog', `${id}.webp`);
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.writeFileSync(image, Buffer.from('deterministic daily brief hero'));

    const record = buildDailyBriefImageRecord({
      id,
      sha256: sha256File(image),
      bytes: fs.statSync(image).size,
    });

    assert.equal(validateGeneratedImageRecord(record).valid, true);
    assert.equal(record.source, 'deterministic-card');
    assert.equal(record.provider, 'site-owned');
    assert.equal(record.license, 'private-grant');
    for (const field of ['model', 'executorModel', 'promptVersion', 'promptHash', 'licenseUrl', 'generatedAt', 'verifiedAt', 'restrictions', 'vision']) {
      assert.equal(record[field], undefined, `${field} must not be present on a deterministic card`);
    }

    appendGeneratedImageRecord(root, record);
    const provenance = imageRecordForPath(root, record.imageUrl, { strict: true });
    assert.equal(provenance.kind, DETERMINISTIC_CARD_KIND);
    assert.equal(provenance.record.sha256, record.sha256);
    assert.equal(buildPublishedBlogImageRegistry(root).generated[record.imageUrl].source, 'deterministic-card');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('all tracked daily brief heroes have a byte-matching deterministic record', () => {
  const covers = fs.readdirSync(path.join(ROOT, 'public/images/blog'))
    .filter((name) => /^bollettino-frontaliere-\d{4}-\d{2}-\d{2}\.webp$/.test(name))
    .sort();
  assert.equal(covers.length, 57);

  for (const name of covers) {
    const imageUrl = `/images/blog/${name}`;
    const provenance = imageRecordForPath(ROOT, imageUrl, { strict: true });
    assert.equal(provenance?.kind, DETERMINISTIC_CARD_KIND, `${name} has no deterministic-card provenance`);
    assert.equal(provenance.record.bytes, fs.statSync(path.join(ROOT, 'public', imageUrl.slice(1))).size, `${name} byte count drifted`);
    assert.equal(provenance.record.sha256, sha256File(path.join(ROOT, 'public', imageUrl.slice(1))), `${name} hash drifted`);
  }
});

test('the daily writer appends the rendered hero record before article registration', () => {
  const source = fs.readFileSync(path.join(ROOT, 'generator/scripts/generate-daily-brief-article.mjs'), 'utf8');
  assert.match(source, /sha256File\(hero\)/);
  assert.match(source, /buildDailyBriefImageRecord\(/);
  assert.match(source, /appendGeneratedImageRecord\(REPO_ROOT, imageRecord\)/);
});

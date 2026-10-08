/**
 * Ogni copertina dedicata `public/images/blog/article-*.webp` toccata dalla
 * PR deve avere una provenienza governata che ne prova record, hash, byte e
 * dimensioni reali.
 *
 * Il perimetro viene dal diff contro la base della PR, non dal disco: una
 * cover nuova senza record non può svuotare il test con uno sparse-checkout,
 * mentre una cover storica lasciata senza record resta riparabile in una PR
 * indipendente.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { imageRecordForPath } from '../scripts/lib/blog-image-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BERNA_COVER = '/images/blog/article-contributi-formazione-berna-requisiti.webp';
const BERNA_SHA256 = 'a06ebb2026a70ff9d90e0919094c3ac1e5b3f29d5aedde2a8f23d43223918960';

function gitText(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function pullRequestBase() {
  const explicitBase = process.env.GITHUB_BASE_SHA;
  if (/^[0-9a-f]{40}$/iu.test(explicitBase || '')) return explicitBase;
  const base = gitText(['merge-base', 'HEAD', 'origin/main']);
  assert.match(base, /^[0-9a-f]{40}$/iu, 'base della PR illeggibile: il gate non può calcolare il perimetro');
  return base;
}

function registryRecordsAt(revision) {
  const raw = revision === 'WORKTREE'
    ? fs.readFileSync(path.join(ROOT, 'data/generated-image-registry.json'), 'utf8')
    : gitText(['show', `${revision}:data/generated-image-registry.json`]);
  const registry = JSON.parse(raw);
  return new Map((registry.assets || [])
    .filter((record) => typeof record?.assetId === 'string'
      && typeof record?.imageUrl === 'string'
      && /^\/images\/blog\/article-[^/]+\.webp$/u.test(record.imageUrl))
    .map((record) => [record.assetId, record]));
}

function relevantDedicatedCovers(base) {
  const changedFiles = gitText(['diff', '--name-only', '--diff-filter=AMR', `${base}...HEAD`])
    .split('\n')
    .filter((file) => /^public\/images\/blog\/article-[^/]+\.webp$/u.test(file))
    .map((file) => file.replace(/^public/u, ''));
  const before = registryRecordsAt(base);
  const after = registryRecordsAt('WORKTREE');
  const changedRecords = [...after.values()]
    .filter((record) => JSON.stringify(before.get(record.assetId)) !== JSON.stringify(record))
    .map((record) => record.imageUrl);
  return [...new Set([...changedFiles, ...changedRecords])].sort();
}

function webpDimensions(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', `${file}: missing RIFF header`);
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP', `${file}: missing WEBP signature`);

  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    assert.ok(payload + size <= bytes.length, `${file}: truncated ${type} chunk`);

    if (type === 'VP8X') {
      assert.ok(size >= 10, `${file}: truncated VP8X dimensions`);
      return {
        width: bytes.readUIntLE(payload + 4, 3) + 1,
        height: bytes.readUIntLE(payload + 7, 3) + 1,
      };
    }
    if (type === 'VP8 ') {
      assert.ok(size >= 10, `${file}: truncated VP8 dimensions`);
      assert.deepEqual(
        [...bytes.subarray(payload + 3, payload + 6)],
        [0x9d, 0x01, 0x2a],
        `${file}: invalid VP8 start code`,
      );
      return {
        width: bytes.readUInt16LE(payload + 6) & 0x3fff,
        height: bytes.readUInt16LE(payload + 8) & 0x3fff,
      };
    }
    if (type === 'VP8L') {
      assert.ok(size >= 5, `${file}: truncated VP8L dimensions`);
      assert.equal(bytes[payload], 0x2f, `${file}: invalid VP8L signature`);
      const packed = bytes.readUInt32LE(payload + 1);
      return {
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1,
      };
    }

    offset = payload + size + (size % 2);
  }

  assert.fail(`${file}: no WebP image chunk found`);
}

function auditCover(imagePath) {
  const provenance = imageRecordForPath(ROOT, imagePath, { strict: true });
  if (!provenance) return 'record assente o non corrispondente ai byte';

  const file = path.join(ROOT, 'public', imagePath.slice(1));
  const asset = fs.readFileSync(file);
  const actualSha256 = crypto.createHash('sha256').update(asset).digest('hex');
  const dimensions = webpDimensions(file);
  const record = provenance.record;
  const problems = [];
  if (record.sha256 !== actualSha256) problems.push('SHA-256 registry diverso dal file');
  if (record.bytes !== asset.length) problems.push('byte count registry diverso dal file');
  if (record.width !== dimensions.width || record.height !== dimensions.height) {
    problems.push(`dimensioni registry ${record.width}x${record.height} diverse dal WebP ${dimensions.width}x${dimensions.height}`);
  }
  return problems.length > 0 ? problems.join('; ') : null;
}

test('ogni copertina dedicata toccata dalla PR ha una provenienza strict', (t) => {
  const covers = relevantDedicatedCovers(pullRequestBase());
  if (covers.length === 0) {
    t.skip('la PR non tocca una copertina dedicata né il suo record');
    return;
  }

  const ungoverned = covers
    .map((imagePath) => [imagePath, auditCover(imagePath)])
    .filter(([, problem]) => problem)
    .map(([imagePath, problem]) => `${imagePath}: ${problem}`);
  assert.deepEqual(
    ungoverned,
    [],
    `${ungoverned.length} copertine dedicate toccate dalla PR su ${covers.length} senza provenienza verificabile:\n  ${ungoverned.join('\n  ')}`,
  );
});

test('la cover Bern usa il record private-grant e non dichiara metadati di generazione non provati', () => {
  const provenance = imageRecordForPath(ROOT, BERNA_COVER, { strict: true });
  assert.ok(provenance, 'record Bern mancante');
  const record = provenance.record;
  const asset = fs.readFileSync(path.join(ROOT, 'public', BERNA_COVER.slice(1)));

  assert.equal(record.assetId, 'article-contributi-formazione-berna-requisiti');
  assert.equal(record.provider, 'site-owned');
  assert.equal(record.license, 'private-grant');
  assert.equal(record.sha256, BERNA_SHA256);
  assert.equal(record.bytes, 39928);
  assert.equal(record.width, 1200);
  assert.equal(record.height, 675);
  assert.equal(asset.length, 39928);
  assert.equal(crypto.createHash('sha256').update(asset).digest('hex'), BERNA_SHA256);
  assert.deepEqual(webpDimensions(path.join(ROOT, 'public', BERNA_COVER.slice(1))), { width: 1200, height: 675 });

  for (const field of ['model', 'executorModel', 'promptVersion', 'promptHash', 'generatedAt', 'verifiedAt', 'restrictions', 'vision']) {
    assert.equal(record[field], undefined, `${field} deve restare non applicabile nel private-grant`);
  }
});

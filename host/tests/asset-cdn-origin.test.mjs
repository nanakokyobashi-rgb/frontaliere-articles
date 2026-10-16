import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CDN_BASE } from '../../scripts/lib/declared-image-fetch.mjs';

test('asset CDN origin normalizes source-backed hosts, ports, paths, and fallback values', async () => {
  const previousAssetCdn = process.env.ASSET_CDN;
  const sourceUrl = new URL(CDN_BASE);
  const sourceOrigin = sourceUrl.origin;
  const portOrigin = `${sourceUrl.protocol}//${sourceUrl.hostname}:8443`;

  try {
    process.env.ASSET_CDN = `${CDN_BASE}/assets/chunks///`;
    const { normalizeAssetCdnOrigin, resolveAssetCdnOrigin } = await import('../constants.ts');

    assert.equal(resolveAssetCdnOrigin(), sourceOrigin);
    assert.equal(normalizeAssetCdnOrigin(`  ${CDN_BASE}/nested/path///  `), sourceOrigin);
    assert.equal(
      normalizeAssetCdnOrigin(`${portOrigin}/assets/chunks///?v=1#bundle`),
      portOrigin,
      'normalization must strip path/query/fragment and trailing slashes but preserve an explicit port',
    );

    // The module was imported above. Changing ASSET_CDN afterwards must still
    // change the resolver result rather than leave an import-time snapshot.
    process.env.ASSET_CDN = `${portOrigin}/edge/assets///`;
    assert.equal(resolveAssetCdnOrigin(), portOrigin);

    delete process.env.ASSET_CDN;
    assert.equal(resolveAssetCdnOrigin(), '');

    process.env.ASSET_CDN = 'not a URL';
    assert.equal(resolveAssetCdnOrigin(), '');
    process.env.ASSET_CDN = `ftp://${sourceUrl.hostname}/assets/`;
    assert.equal(resolveAssetCdnOrigin(), '', 'non-HTTP(S) origins must not produce a preconnect');
  } finally {
    if (previousAssetCdn === undefined) delete process.env.ASSET_CDN;
    else process.env.ASSET_CDN = previousAssetCdn;
  }
});

test('the host bootstrap resolves ASSET_CDN whether it is set before or after bootstrap import', async () => {
  const previousAssetCdn = process.env.ASSET_CDN;
  const sourceOrigin = new URL(CDN_BASE).origin;
  const sourceUrl = new URL(CDN_BASE);
  const portOrigin = `${sourceUrl.protocol}//${sourceUrl.hostname}:8443`;
  const hintFor = (origin) => `<link rel="preconnect" href="${origin}" crossorigin>`;

  try {
    process.env.ASSET_CDN = `${CDN_BASE}/assets/chunks///`;
    const { contract } = await import('../siteShellBootstrap.ts');
    const { getSiteShell } = await import('../../engine/siteShell.ts');
    assert.equal(contract.cdnPreconnectHint, hintFor(sourceOrigin));
    assert.equal(getSiteShell().cdnPreconnectHint, hintFor(sourceOrigin));

    // Change the environment after the bootstrap import. The contract getter
    // must resolve the new origin when the engine reads the field.
    process.env.ASSET_CDN = `${portOrigin}/edge/assets///`;
    assert.equal(contract.cdnPreconnectHint, hintFor(portOrigin));
    assert.equal(getSiteShell().cdnPreconnectHint, hintFor(portOrigin));

    delete process.env.ASSET_CDN;
    assert.equal(contract.cdnPreconnectHint, '', 'missing configuration must keep the safe no-preconnect fallback');
    assert.equal(getSiteShell().cdnPreconnectHint, '');
  } finally {
    if (previousAssetCdn === undefined) delete process.env.ASSET_CDN;
    else process.env.ASSET_CDN = previousAssetCdn;
  }
});

test('fast article publishing supplies the source-backed CDN before its host bootstrap', () => {
  const pipeline = readFileSync(new URL('../../scripts/lib/article-render-pipeline.mjs', import.meta.url), 'utf8');
  const assignmentAt = pipeline.indexOf('process.env.ASSET_CDN = CDN_BASE;');
  const bootstrapAt = pipeline.indexOf("await import('../../host/siteShellBootstrap.ts');");
  const engineAt = pipeline.indexOf("await import('../../engine/ogPagesPlugin.ts');");

  assert.ok(assignmentAt >= 0, 'fast publishing must use the same CDN_BASE as image offload');
  assert.ok(bootstrapAt > assignmentAt, 'fast publishing should configure the host after selecting its CDN');
  assert.ok(engineAt > bootstrapAt, 'fast publishing must configure the host before the engine reads its contract');
});

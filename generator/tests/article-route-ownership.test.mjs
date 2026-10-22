import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLiteralRedirectMap } from '../../engine/shared/articleRouteOwnership.mjs';

test('parseLiteralRedirectMap accepts single- and double-quoted route literals', () => {
  const result = parseLiteralRedirectMap([
    "  '/articoli-ticino/vecchio': '/articoli-ticino/nuovo',",
    '  "/articoli-ticino/vecchio-2": "/articoli-ticino/nuovo-2/",',
  ].join('\n'));

  assert.deepEqual(result.entries, {
    '/articoli-ticino/vecchio/': '/articoli-ticino/nuovo/',
    '/articoli-ticino/vecchio-2/': '/articoli-ticino/nuovo-2/',
  });
  assert.equal(result.literalCount, 2);
  assert.equal(result.dynamicCount, 0);
  assert.deepEqual(result.unsupported, []);
});

test('parseLiteralRedirectMap reports dynamic and unsupported targets without guessing', () => {
  const result = parseLiteralRedirectMap([
    "  '/articoli-ticino/dynamic': targetPath,",
    "  '/articoli-ticino/template': `'/articoli-ticino/${slug}'`,",
  ].join('\n'));

  assert.deepEqual(result.entries, {});
  assert.equal(result.literalCount, 0);
  assert.equal(result.dynamicCount, 1);
  assert.deepEqual(result.unsupported, ['/articoli-ticino/dynamic']);
});

test('parseLiteralRedirectMap skips nested members in an unsupported expression', () => {
  const result = parseLiteralRedirectMap(
    "const redirects = { '/dynamic': condition ? { '/fake': '/target-fake' } : targetPath, '/valid': '/target-valid' }",
  );

  assert.deepEqual(result.entries, {
    '/valid/': '/target-valid/',
  });
  assert.equal(result.literalCount, 1);
  assert.equal(result.dynamicCount, 0);
  assert.deepEqual(result.unsupported, ['/dynamic']);
});

test('parseLiteralRedirectMap conserva le divisioni dopo gli operatori postfix dinamici', () => {
  for (const operator of ['++', '--']) {
    const result = parseLiteralRedirectMap(
      `const redirects = { '/dynamic': counter${operator} / divisor, '/valid': '/target-valid' }`,
    );

    assert.deepEqual(result.entries, {
      '/valid/': '/target-valid/',
    }, operator);
    assert.deepEqual(result.unsupported, ['/dynamic'], operator);
  }
});

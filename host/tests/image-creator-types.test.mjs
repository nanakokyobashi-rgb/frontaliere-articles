import assert from 'node:assert/strict';
import test from 'node:test';
import { imageObjectLd, SITE_ORGANIZATION_ID } from '../seo/imageObjectLd.ts';

for (const type of ['NewsMediaOrganization', ['NewsMediaOrganization', 'Organization'], ['Organization', 'NewsMediaOrganization']]) {
  test(`creator type ${JSON.stringify(type)} preserves external attribution`, () => {
    const creator = Object.freeze({ '@type': type, '@id': 'https://example.com/#newsroom', name: 'External newsroom', url: 'https://example.com/' });
    const image = imageObjectLd({ contentUrl: 'https://example.com/image.jpg', creator });
    assert.deepEqual(image.creator, { ...creator, '@type': 'Organization' });
    assert.deepEqual(creator['@type'], type);
  });
}

test('a site creator with array types retains the canonical organization identity', () => {
  const creator = Object.freeze({ '@type': Object.freeze(['NewsMediaOrganization', 'Organization']), name: 'Frontaliere Ticino', url: 'https://frontaliereticino.ch/' });
  assert.deepEqual(imageObjectLd({ contentUrl: 'https://example.com/image.jpg', creator }).creator, {
    ...creator, '@type': 'Organization', '@id': SITE_ORGANIZATION_ID,
  });
  assert.deepEqual(creator['@type'], ['NewsMediaOrganization', 'Organization']);
});

for (const type of ['Organization', 'NewsMediaOrganization', ['NewsMediaOrganization', 'Organization']]) {
  test(`a site creator with type ${JSON.stringify(type)} replaces an external id`, () => {
    const creator = Object.freeze({
      '@type': type,
      '@id': 'https://example.com/#stale-site-id',
      name: 'Frontaliere Ticino',
      url: 'https://frontaliereticino.ch/',
    });
    assert.deepEqual(imageObjectLd({ contentUrl: 'https://example.com/image.jpg', creator }).creator, {
      ...creator, '@type': 'Organization', '@id': SITE_ORGANIZATION_ID,
    });
    assert.equal(creator['@id'], 'https://example.com/#stale-site-id');
  });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isStaticAdSlotKey, staticAdSlotHtml } = await import('../staticAdSlotHtml.ts');

test('canton hub ad placements keep the reserved formats and slots', () => {
  const top = staticAdSlotHtml('canton-hub-top');
  const inlineOne = staticAdSlotHtml('canton-hub-inline-1');
  const inlineTwo = staticAdSlotHtml('canton-hub-inline-2');
  const end = staticAdSlotHtml('canton-hub-end');
  const articleAtf = staticAdSlotHtml('article-atf', {
    collapseWhenUnfilled: true,
    experimentId: 'article-detail-atf-ad-v1',
    experimentVariant: 'atf',
  });

  assert.match(top, /<ins class="adsbygoogle" style="display:block;min-height:100px"/);
  assert.match(top, /data-ad-slot="3205029282"/);
  assert.match(top, /data-ad-format="horizontal"/);
  assert.match(top, /data-full-width-responsive="true"/);
  assert.doesNotMatch(top, /data-ad-placement/);

  for (const inline of [inlineOne, inlineTwo]) {
    assert.match(inline, /<ins class="adsbygoogle" style="display:block;min-height:220px"/);
    assert.match(inline, /data-ad-format="fluid"/);
    assert.match(inline, /data-ad-layout="in-article"/);
    assert.doesNotMatch(inline, /data-full-width-responsive/);
  }
  assert.match(inlineOne, /data-ad-slot="1982411173"/);
  assert.match(inlineTwo, /data-ad-slot="6483829128"/);

  assert.match(end, /<ins class="adsbygoogle" style="display:block;min-height:400px"/);
  assert.match(end, /data-ad-slot="5196931137"/);
  assert.match(end, /data-ad-format="autorelaxed"/);
  assert.match(end, /data-ad-placement="ssg_end_multiplex"/);
  assert.doesNotMatch(end, /data-full-width-responsive/);
  assert.match(articleAtf, /data-ad-slot="1982411173"/);
  assert.match(articleAtf, /data-ad-layout="in-article"/);
  assert.match(articleAtf, /data-ad-placement="article-atf"/);
  assert.match(articleAtf, /data-ft-static-ad="true"/);
  assert.match(articleAtf, /data-ad-experiment="article-detail-atf-ad-v1"/);
  assert.match(articleAtf, /data-ad-variant="atf"/);
});

test('runtime ad slot values outside the TypeScript union fail closed', () => {
  assert.equal(isStaticAdSlotKey('canton-hub-top'), true);
  assert.equal(isStaticAdSlotKey('article-atf'), true);
  assert.equal(isStaticAdSlotKey('unknown-runtime-slot'), false);
  assert.equal(isStaticAdSlotKey('toString'), false);
  assert.equal(isStaticAdSlotKey(null), false);
  assert.equal(staticAdSlotHtml('unknown-runtime-slot'), '');
  assert.equal(staticAdSlotHtml(null), '');
});

test('malformed runtime ad slot values are rejected before registry access', () => {
  const hostileSlot = {
    [Symbol.toPrimitive]() {
      throw new Error('runtime slot must not be coerced');
    },
  };
  const malformedSlots = [
    undefined,
    null,
    false,
    0,
    Symbol('runtime-slot'),
    Object.create(null),
    '',
    '__proto__',
    hostileSlot,
  ];

  for (const slot of malformedSlots) {
    assert.equal(isStaticAdSlotKey(slot), false);
    assert.doesNotThrow(() => {
      assert.equal(staticAdSlotHtml(slot), '');
    });
  }
});

test('runtime ad slot validation works when the target lacks Object.hasOwn', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Object, 'hasOwn');
  assert.ok(descriptor, 'the test runtime must expose Object.hasOwn to simulate its absence');

  let validSlot;
  let inheritedSlot;
  let invalidMarkup;
  try {
    Object.defineProperty(Object, 'hasOwn', { ...descriptor, value: undefined });
    validSlot = isStaticAdSlotKey('canton-hub-top');
    inheritedSlot = isStaticAdSlotKey('toString');
    invalidMarkup = staticAdSlotHtml('unknown-runtime-slot');
  } finally {
    Object.defineProperty(Object, 'hasOwn', descriptor);
  }

  assert.equal(validSlot, true);
  assert.equal(inheritedSlot, false);
  assert.equal(invalidMarkup, '');
});

test('runtime ad slot guard rejects names inherited from a registry prototype', () => {
  const inheritedSlot = Object.create({ 'canton-hub-top': true });

  assert.equal(isStaticAdSlotKey(inheritedSlot), false);
  assert.equal(staticAdSlotHtml(inheritedSlot), '');
});

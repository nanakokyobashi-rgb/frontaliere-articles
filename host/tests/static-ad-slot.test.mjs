import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isStaticAdSlotKey, staticAdSlotHtml } = await import('../staticAdSlotHtml.ts');

test('canton hub ad placements keep the reserved formats and slots', () => {
  const top = staticAdSlotHtml('canton-hub-top');
  const inlineOne = staticAdSlotHtml('canton-hub-inline-1');
  const inlineTwo = staticAdSlotHtml('canton-hub-inline-2');
  const end = staticAdSlotHtml('canton-hub-end');

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
});

test('runtime ad slot values outside the TypeScript union fail closed', () => {
  assert.equal(isStaticAdSlotKey('canton-hub-top'), true);
  assert.equal(isStaticAdSlotKey('unknown-runtime-slot'), false);
  assert.equal(isStaticAdSlotKey('toString'), false);
  assert.equal(isStaticAdSlotKey(null), false);
  assert.equal(staticAdSlotHtml('unknown-runtime-slot'), '');
  assert.equal(staticAdSlotHtml(null), '');
});

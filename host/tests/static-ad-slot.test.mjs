import { test } from 'node:test';
import assert from 'node:assert/strict';

const { staticAdSlotHtml } = await import('../staticAdSlotHtml.ts');

test('canton hub ad placements keep the reserved formats and slots', () => {
  const top = staticAdSlotHtml('canton-hub-top');
  const end = staticAdSlotHtml('canton-hub-end');

  assert.match(top, /<ins class="adsbygoogle" style="display:block;min-height:100px"/);
  assert.match(top, /data-ad-slot="3205029282"/);
  assert.match(top, /data-ad-format="horizontal"/);
  assert.match(top, /data-full-width-responsive="true"/);
  assert.doesNotMatch(top, /data-ad-placement/);

  assert.match(end, /<ins class="adsbygoogle" style="display:block;min-height:400px"/);
  assert.match(end, /data-ad-slot="5196931137"/);
  assert.match(end, /data-ad-format="autorelaxed"/);
  assert.match(end, /data-ad-placement="ssg_end_multiplex"/);
  assert.doesNotMatch(end, /data-full-width-responsive/);
});
